// Genuine official feature operations. No growth-task completion/report endpoint
// is used here; task accounting and reward confirmation belong to the engine.
// Protocol sources: installed official SchedulerService and official Library
// RecordService/loadChunkPage. See the source audit in outputs/wb-executors.
import {AppError,rememberSecret,hash} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';

const scheduler='/v2/as/scheduler/tasks',spaces='/space/api/view/query/spaces',pagechunk='/space/api/view/query/pagechunk';
const allowedDomains=new Set(['www.workbuddy.cn','workbuddy.cn','www.codebuddy.cn','codebuddy.cn','copilot.tencent.com']);
const id=value=>(typeof value==='string'||typeof value==='number')&&String(value).length>0&&String(value).length<=256?String(value):null;
const cancellation=(error,signal,check)=>{check();signal?.throwIfAborted();if(error?.name==='AbortError')throw error;};
class FeatureClient {
  constructor(credential,{fetchImpl=fetch,signal,check=()=>{}}={}){this.credential=credential;this.fetchImpl=fetchImpl;this.signal=signal;this.check=check;}
  async request(host,path,{method='GET',body,envelope='library'}={}){
    this.check();this.signal?.throwIfAborted();const c=this.credential,timeout=AbortSignal.timeout(20000),signal=this.signal?AbortSignal.any([this.signal,timeout]):timeout;
    const response=await this.fetchImpl(host+path,{method,headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+c.accessToken,'X-Domain':c.domain??'www.workbuddy.cn','X-User-Id':String(c.uid??c.principal)},...(body===undefined?{}:{body:JSON.stringify(body)}),signal,redirect:'error'});
    this.check();this.signal?.throwIfAborted();let data;try{data=await response.json();}catch{throw new AppError('官方业务响应待确认',502,'wb_feature_response_invalid');}
    this.check();this.signal?.throwIfAborted();
    const code=data?.code??data?.retcode;
    if(!response.ok||data?.success===false||code!==undefined&&![0,200,'0','200'].includes(code))throw new AppError('官方业务请求未获确认',response.ok?502:response.status,'wb_feature_request_rejected');
    if(envelope==='scheduler'){if(data?.success!==true||!data.data||typeof data.data!=='object')throw new AppError('官方自动化响应结构待确认',502,'wb_feature_response_invalid');return data.data;}
    if(!data||typeof data!=='object')throw new AppError('官方资料响应结构待确认',502,'wb_feature_response_invalid');
    return code!==undefined||data.success===true?data.data??data.result??data:data;
  }
  async scheduler(path='',options={}){return this.request('https://www.workbuddy.cn',scheduler+path,{...options,envelope:'scheduler'});}
  async library(path,options={}){return this.request('https://www.workbuddy.cn',path,options);}
}
function outcome(status,reason,operationId,evidence={},completedActions=0){return {status,reason,operationId,completedActions,evidence};}
function automationInput(action,operationId){
  const supplied=action.createInput;if(!supplied||typeof supplied!=='object')return null;
  const input={};for(const key of ['agentType','ownerType','frequencyType','cronExpr','timezone','effectiveStart','effectiveEnd','projectId'])if(typeof supplied[key]==='string')input[key]=supplied[key];
  if(!input.agentType||!input.ownerType||!input.frequencyType||!input.timezone||typeof supplied.agentConfig?.prompt!=='string'||!supplied.agentConfig.prompt.trim())return null;
  input.name='AI积分网关-'+hash(operationId).slice(0,24);
  input.agentConfig={};for(const key of ['prompt','model','agentType','conversationId','cloud_agent_id','runtime_id'])if(typeof supplied.agentConfig[key]==='string')input.agentConfig[key]=supplied.agentConfig[key];
  if(input.agentType==='personal_agent'&&!/^\d+$/.test(input.agentConfig.cloud_agent_id??''))return null;
  // A growth-task automation is real but need not emit messages to any contact.
  input.deliveryConfig={enabled:false,channels:[]};
  return input;
}
async function executeAutomation(api,{operationId,action,markSubmitted,signal,check}){
  const name='AI积分网关-'+hash(operationId).slice(0,24),evidence={feature:'automation',resourceVerified:false};let resourceId=id(action.resourceId??action.id),mutationStarted=false;
  const verify=async()=>{const item=await api.scheduler('/'+encodeURIComponent(resourceId));if(id(item.id)!==resourceId||item.name!==name)return outcome('pending','automation_entity_not_confirmed',operationId,{...evidence,resourceId});return outcome('completed','official_automation_entity_verified',operationId,{...evidence,resourceId,resourceVerified:true},1);};
  try{
    if(resourceId)return await verify();
    // Recover only an exact operation-owned entity; an arbitrary user's existing
    // automation is not credited as an action performed by this operation.
    let lookupComplete=false;
    for(let page=1;page<=3;page++){
      const list=await api.scheduler('?ownerType=all&keyword='+encodeURIComponent(name)+'&page='+page+'&pageSize=100');if(!Array.isArray(list.tasks))return outcome('deferred','automation_list_schema_unconfirmed',operationId,evidence);
      const existing=list.tasks.find(item=>item?.name===name&&id(item.id));if(existing){resourceId=id(existing.id);return await verify();}
      if(list.tasks.length<100||Number.isFinite(list.total)&&page*100>=list.total){lookupComplete=true;break;}
    }
    if(action.submitted===true)return outcome('pending','previous_automation_submission_unconfirmed',operationId,evidence);
    if(!lookupComplete)return outcome('deferred','automation_lookup_incomplete',operationId,evidence);
    const input=automationInput(action,operationId);if(!input)return outcome('unsupported','official_automation_input_required',operationId,evidence);
    if(typeof markSubmitted!=='function')return outcome('deferred','submission_persistence_required',operationId,evidence);
    check();signal?.throwIfAborted();await markSubmitted({feature:'automation',operationId,resourceName:name});check();signal?.throwIfAborted();mutationStarted=true;
    const created=await api.scheduler('',{method:'POST',body:input});resourceId=id(created.id);
    if(!resourceId)return outcome('pending','automation_creation_unconfirmed',operationId,evidence);
    return await verify();
  }catch(error){cancellation(error,signal,check);return outcome(mutationStarted||resourceId||action.submitted===true?'pending':'deferred',mutationStarted?'automation_submission_or_verification_unconfirmed':'official_automation_read_unconfirmed',operationId,{...evidence,...(resourceId?{resourceId}:{})});}
}
function libraryCandidates(data,action){
  if(id(action.pageId)&&id(action.spaceId))return [{pageId:id(action.pageId),spaceId:id(action.spaceId)}];
  const result=[],spaceEntries=Object.values(data.spaces??{}).filter(e=>e?.value&&id(e.value.id)&&e.role!=='invalid'),tops={...(data.topPages?.block??{}),...(data.myTopNodes?.block??{})};
  for(const envelope of spaceEntries){const space=envelope.value;for(const pageId of Array.isArray(space.nodes)?space.nodes:[]){const node=tops[pageId]?.value;if(node&&(node.enabled===false||node.props?.kind&&node.props.kind!=='doc'||tops[pageId].role==='invalid'))continue;if(id(pageId))result.push({pageId:id(pageId),spaceId:id(space.id)});}}
  for(const [pageId,envelope]of Object.entries(tops)){const node=envelope?.value;if(!node||envelope.role==='invalid'||node.enabled===false||node.props?.kind&&node.props.kind!=='doc'||!id(node.spaceId))continue;if(id(pageId)&&!result.some(r=>r.pageId===id(pageId)))result.push({pageId:id(pageId),spaceId:id(node.spaceId)});}
  return result.slice(0,5);
}
function textLength(value,depth=0){
  if(depth>12)return 0;if(typeof value==='string')return value.length;if(Array.isArray(value))return value.reduce((n,item)=>n+textLength(item,depth+1),0);if(!value||typeof value!=='object')return 0;
  return ['text','content','richText','rich_text','insert'].reduce((n,key)=>n+textLength(value[key],depth+1),0);
}
function documentChars(records,pageId,spaceId){
  let chars=0,blocks=0;const entries=records?.block,root=entries?.[pageId],node=root?.value;
  if(!entries||typeof entries!=='object'||!node||id(node.id)!==pageId||id(node.spaceId)!==spaceId||root.role==='invalid'||node.enabled===false||node.type!=='node'||node.props?.kind&&node.props.kind!=='doc'||node.props?.taskInfo?.isConversation===true)return {chars,blocks};
  const queue=[...(Array.isArray(node.children)?node.children:[])],seen=new Set([pageId]);
  for(let at=0;at<queue.length&&at<2000;at++){
    const blockId=id(queue[at]);if(!blockId||seen.has(blockId))continue;seen.add(blockId);const envelope=entries[blockId],value=envelope?.value;
    if(!value||envelope.role==='invalid'||value.enabled===false||value.type==='node'||id(value.spaceId)!==spaceId)continue;
    // Official pagechunk observations: non-node text/header body blocks carry
    // rich text in props.title = [[text, optional formatting], ...]. Page node
    // metadata was excluded above; count text only, never style/link payloads.
    const title=value.props?.title,richBody=/^(?:text|header[1-6]|bulleted_list|numbered_list|quote|to_do|code)$/.test(value.type??'')&&Array.isArray(title)&&title.every(part=>Array.isArray(part)&&typeof part[0]==='string'&&part.length<=2)?title.reduce((n,part)=>n+part[0].length,0):0;
    const n=textLength(value.props??{})+richBody;if(n>0){chars+=n;blocks++;}if(Array.isArray(value.children))queue.push(...value.children);
  }
  return {chars,blocks,bodyShapeUnconfirmed:chars===0&&Array.isArray(node.children)&&node.children.length>0};
}
async function executeLibrary(api,{operationId,action,signal,check}){
  const evidence={feature:'library_read',resourceVerified:false};let bodyShapeUnconfirmed=false;
  try{
    const listing=await api.library(spaces+'?includeIM=1');if(!listing.spaces||typeof listing.spaces!=='object')return outcome('deferred','library_spaces_schema_unconfirmed',operationId,evidence);
    for(const candidate of libraryCandidates(listing,action)){
      let cursor,pages=0;const seen=new Set(),records={block:{}};
      do{
        check();signal?.throwIfAborted();const result=await api.library(pagechunk,{method:'POST',body:{...candidate,limit:300,isUserSpace:false,chunkNumber:0,chunked:1,...(cursor?{cursor}:{})}});pages++;
        if(!result.records||typeof result.records!=='object')break;
        if(result.records.block&&typeof result.records.block==='object')Object.assign(records.block,result.records.block);cursor=result.cursor;
        if(cursor!==undefined&&cursor!==null&&cursor!==''&&seen.has(JSON.stringify(cursor)))break;
        if(cursor!==undefined&&cursor!==null&&cursor!=='')seen.add(JSON.stringify(cursor));
      }while(cursor!==undefined&&cursor!==null&&cursor!==''&&pages<5);
      const count=documentChars(records,candidate.pageId,candidate.spaceId),{chars,blocks}=count;bodyShapeUnconfirmed||=count.bodyShapeUnconfirmed===true;
      if(chars>0)return outcome('completed','official_library_document_read',operationId,{...evidence,resourceVerified:true,resourceId:candidate.pageId,spaceId:candidate.spaceId,contentChars:chars,contentBlocks:blocks,pagesRead:pages,complete:cursor===undefined||cursor===null||cursor===''},1);
    }
    return outcome('deferred',bodyShapeUnconfirmed?'library_document_body_shape_unconfirmed':'readable_library_document_unavailable',operationId,evidence);
  }catch(error){cancellation(error,signal,check);return outcome('deferred','official_library_read_unconfirmed',operationId,evidence);}
}
export async function executeWorkBuddyApiFeature({service,accountId,task,signal,check=()=>{},operationId,action={},markSubmitted}={}){
  check();signal?.throwIfAborted();action=typeof action==='string'?{kind:action}:action??{};
  const kind=action.kind??task?.taskCode,automation=['automation','automation_1','cloudscheduler'].includes(kind),library=['library_read','Library_read'].includes(kind);
  if(!automation&&!library)return outcome('unsupported','official_api_feature_unavailable',operationId);
  if(typeof operationId!=='string'||!operationId)return outcome('unsupported','operation_identity_required',operationId);
  const account=service.config.value.accounts.find(a=>a.id===accountId&&a.platform==='workbuddy'&&a.enabled!==false);if(!account)return outcome('deferred','workbuddy_account_unavailable',operationId);
  const credential=await service.credentials.resolve(accountId);check();signal?.throwIfAborted();
  if(workBuddyEdition(credential)!=='cn')return outcome('unsupported','official_cn_feature_unavailable',operationId);
  if(!credential.accessToken||!allowedDomains.has(credential.domain??'www.workbuddy.cn'))return outcome('deferred','official_credential_domain_unconfirmed',operationId);
  rememberSecret(credential.accessToken);const api=new FeatureClient(credential,{fetchImpl:service.workbuddyRuntime?.fetchImpl??fetch,signal,check});
  return automation?executeAutomation(api,{operationId,action,markSubmitted,signal,check}):executeLibrary(api,{operationId,action,signal,check});
}
