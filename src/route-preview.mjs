// A preview is a pure projection over the current in-memory config, catalogue
// cache and saved evidence. Do not call models(), health(), resolve(), prepare(),
// discover(), chat(), config.load()/save() or any pool/relay mutation here.
import {AppError} from './util.mjs';
import {RequestPlan,outputCapacity} from './request-plan.mjs';
import {WorkBuddyPool} from './workbuddy-pool.mjs';
import {ModelRelay,catalogModelFamily,relayPartition} from './model-relay.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {diagnosticAccountRef,diagnosticText,diagnosticCode} from './request-diagnostics.mjs';

const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=v=>Number.isSafeInteger(v)&&v>0?v:null;
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const code=v=>typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(v)&&!/(?:bearer|secret|token|sk-)/i.test(v)?v:null;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const invalid=()=>{throw new AppError('Invalid route preview input',400,'invalid_route_preview');};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const META_KEYS=['routeId','inputChars','outputBudget','requiresTools','hasImages','hasToolHistory','messageCount','toolCount','stream','multiRole','explicitParameters'];

function previewInput(body){
  if(!record(body))invalid();
  if(Object.hasOwn(body,'routeId')){
    if(Object.keys(body).some(k=>!META_KEYS.includes(k))||typeof body.routeId!=='string'||!body.routeId||body.routeId.length>160)invalid();
    for(const [key,min,max]of [['inputChars',0,100000000],['outputBudget',0,100000000],['messageCount',1,10000],['toolCount',0,4096]])if(body[key]!==undefined&&!integer(body[key],min,max))invalid();
    for(const key of ['requiresTools','hasImages','hasToolHistory','stream','multiRole'])if(body[key]!==undefined&&typeof body[key]!=='boolean')invalid();
    if(body.explicitParameters!==undefined&&(!Array.isArray(body.explicitParameters)||body.explicitParameters.length>100||body.explicitParameters.some(v=>typeof v!=='string'||!code(v))))invalid();
    const messageCount=body.messageCount??1,toolCount=body.toolCount??(body.requiresTools?1:0),outputBudget=body.outputBudget??0;
    const request={model:body.routeId,messages:[{role:'user',content:''}],...(body.stream!==undefined?{stream:body.stream}:{})};
    const contract={schema:1,clientModelId:body.routeId,messageCount,toolCount,requiresTools:body.requiresTools===true||toolCount>0,hasImages:body.hasImages===true,hasToolHistory:body.hasToolHistory===true,serializedBytes:null,outputBudget,maxTokens:outputBudget||null,maxCompletionTokens:null,inputChars:body.inputChars??null,contextEstimate:{method:'supplied_characters_utf8_upper_bound_plus_overhead',tokenCount:null,upperBound:body.inputChars===undefined?null:body.inputChars*4+4096+128*messageCount+512*toolCount+outputBudget},evidence:'user_supplied_metadata_only'};
    return {mode:'metadata',request,contract,hasMultiRole:body.multiRole===true||messageCount!==1,explicitParameters:[...new Set([...(body.explicitParameters??[]),...(outputBudget>0?['max_tokens']:[])])],complete:false};
  }
  const request=Object.hasOwn(body,'request')?body.request:body;
  if(Object.hasOwn(body,'request')&&Object.keys(body).some(k=>k!=='request')||!record(request))invalid();
  if(typeof request.model!=='string'||!request.model||request.model.length>160||!Array.isArray(request.messages)||!integer(request.messages.length,1,10000))invalid();
  for(const message of request.messages){
    if(!record(message)||!['system','developer','user','assistant','tool'].includes(message.role))invalid();
    if(message.content!==undefined&&message.content!==null&&typeof message.content!=='string'&&!Array.isArray(message.content))invalid();
    if(Array.isArray(message.content)&&message.content.some(part=>!record(part)||typeof part.type!=='string'))invalid();
    if(message.tool_calls!==undefined&&(!Array.isArray(message.tool_calls)||message.tool_calls.some(call=>!record(call))))invalid();
  }
  for(const key of ['max_tokens','max_completion_tokens'])if(request[key]!==undefined&&!integer(request[key],1,100000000))invalid();
  for(const [key,min,max]of [['temperature',0,2],['top_p',0,1],['presence_penalty',-2,2],['frequency_penalty',-2,2]])if(request[key]!==undefined&&(typeof request[key]!=='number'||!Number.isFinite(request[key])||request[key]<min||request[key]>max))invalid();
  if(request.stream!==undefined&&typeof request.stream!=='boolean'||request.n!==undefined&&request.n!==1||request.seed!==undefined&&!Number.isSafeInteger(request.seed))invalid();
  if(request.tools!==undefined&&(!Array.isArray(request.tools)||request.tools.length>4096||request.tools.some(t=>!record(t)||t.type!=='function'||typeof t.function?.name!=='string')))invalid();
  if(request.functions!==undefined&&(!Array.isArray(request.functions)||request.functions.length>4096||request.functions.some(t=>!record(t)||typeof t.name!=='string')))invalid();
  for(const key of ['tool_choice','function_call'])if(request[key]!==undefined&&typeof request[key]!=='string'&&!record(request[key]))invalid();
  for(const key of ['response_format','extra_body'])if(request[key]!==undefined&&!record(request[key]))invalid();
  let serialized;try{serialized=JSON.stringify(request);}catch{invalid();}
  if(Buffer.byteLength(serialized)>20971520)throw new AppError('Route preview request exceeds 20 MiB',413,'route_preview_too_large');
  const contract=new RequestPlan(request,{}).contract;
  contract.requiresTools||=!!request.functions?.length&&request.function_call!=='none'||request.tool_choice!==undefined&&request.tool_choice!=='none'||request.function_call!==undefined&&request.function_call!=='none';
  contract.hasImages||=request.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='input_image'));
  contract.hasToolHistory||=request.messages.some(m=>!!m.function_call);
  return {mode:'request',request,contract,hasMultiRole:request.messages.length!==1||request.messages[0].role!=='user'||typeof request.messages[0].content!=='string'||Object.keys(request.messages[0]).some(k=>!['role','content'].includes(k)),explicitParameters:Object.keys(request).filter(k=>!['model','messages','stream','tools','tool_choice','functions','function_call'].includes(k)&&request[k]!==undefined),complete:true};
}

function auditEvidence(row,config){
  if(!record(row))return {source:'not_recorded',checkedAt:null,status:'unknown',tests:[]};
  return {source:'saved_model_audit',checkedAt:time(row.finishedAt),status:['passed','failed','partial','uncertain','unavailable','running'].includes(row.status)?row.status:'unknown',tests:(Array.isArray(row.tests)?row.tests:[]).filter(t=>['ordinary','stream','tools','roundtrip'].includes(t.stage)).map(t=>({stage:t.stage,ok:typeof t.ok==='boolean'?t.ok:null,status:['unsupported','skipped'].includes(t.status)?t.status:null,elapsedMs:number(t.elapsedMs),errorCode:diagnosticCode(t.error?.code,config)})),note:'历史体检结果独立展示，不代表当前目录新鲜度或本次完整请求已验收'};
}

export function previewRoute(service,body,{now=Date.now()}={}){
  if(!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))invalid();
  const input=previewInput(body),value={...(service.config?.value??{}),__diagnosticSecrets:service.keys},config={value},route=value.routes?.find(r=>r.id===input.request.model),safeCode=v=>diagnosticCode(v,value);
  if(!route)throw new AppError('Unknown route',404,'model_not_found');
  const read=key=>service.ledger?.get?.(key),pool=new WorkBuddyPool(config,{get:read}),relay=new ModelRelay(config,null,{get:read});relay.pool=pool;
  const relayActive=relay.active(route),catalogs=service.platforms?.catalogs;
  const catalog=id=>{const rows=catalogs?.get?.(id);return Array.isArray(rows)?rows:null;};
  const modelFor=t=>catalog(t?.upstreamId)?.find(m=>m.id===t?.model);
  const sourceModel=modelFor(route.targets?.[0]),family=catalogModelFamily(route.targets?.[0]?.model,sourceModel);
  const initial=pool.candidates(route,{ignoreCooldown:true,includeBlocked:true});
  const all=relayActive?[...initial,...(value.routes??[]).filter(r=>r.enabled!==false).flatMap(r=>r.targets??[])]:initial;
  // Keep excluded configured entries visible with a reason; no excluded entry
  // becomes eligible merely because it is included in this preview table.
  all.push(...(route.targets??[]));
  if(route.accountPool?.enabled)for(const id of route.accountPool.accountIds??[]){const u=value.upstreams?.find(u=>u.kind==='workbuddy'&&u.accountId===id);if(u)all.push({upstreamId:u.id,model:route.targets?.[0]?.model});}
  const seen=new Set(),partition=relayPartition(value,route.targets?.[0]);
  const targets=all.filter(t=>{const key=t.upstreamId+'\0'+t.model;if(seen.has(key))return false;seen.add(key);return relayPartition(value,t)===partition&&(!relayActive||catalogModelFamily(t.model,modelFor(t))===family&&relay.relayStandby(t,route));});
  const audit=read('model-audit'),plan=new RequestPlan(input.request,value);plan.contract=input.contract;
  const primary=value.upstreams?.find(u=>u.id===route.targets?.[0]?.upstreamId),primaryAccount=value.accounts?.find(a=>a.id===primary?.accountId);
  const candidates=targets.map((target,index)=>{
    const u=value.upstreams?.find(u=>u.id===target.upstreamId),a=value.accounts?.find(a=>a.id===u?.accountId),model=modelFor(target),inspected=plan.inspect(model??{},sourceModel,{relay:relayActive});
    let status=inspected.metadata.state,reasonCode=inspected.metadata.reasonCode??null;
    if(!model){status='unknown';reasonCode='catalog_not_cached_or_model_not_listed';}
    else if(inspected.error&&(input.contract.requiresTools&&model.tools===undefined||input.contract.hasImages&&model.multimodal===undefined)){status='unknown';reasonCode='capability_not_declared';}
    const contextWindow=positive(model?.contextWindow),maxOutput=model?outputCapacity(model):null,upper=input.contract.contextEstimate.upperBound;
    const contextFit=upper===null||contextWindow===null?'unknown':upper<=contextWindow?'sufficient':'not_proven';
    const outputFit=!input.contract.outputBudget||maxOutput===null?'unknown':input.contract.outputBudget<=maxOutput?'sufficient':'insufficient';
    const skip=reason=>{status='skipped';reasonCode=reason;};
    if(status!=='skipped'&&(contextFit!=='sufficient'||outputFit==='unknown'||!model)){status='unknown';reasonCode??=contextFit==='not_proven'?'context_fit_not_proven':'capability_evidence_incomplete';}
    if(model?.callable===false)skip('catalog_model_not_callable');
    if(outputFit==='insufficient')skip('relay_capacity_incompatible');
    if(input.contract.hasToolHistory&&model?.tools===false)skip('tools_not_supported');
    if(u?.kind==='opencode'){
      if(input.hasMultiRole)skip('relay_context_incompatible');
      if(input.explicitParameters.length)skip('relay_capacity_incompatible');
      if(input.contract.hasImages)skip('images_not_supported');
      if(input.contract.requiresTools||input.contract.hasToolHistory||input.request.tools?.length||input.request.functions?.length)skip('tools_not_supported');
    }
    const cooldowns=[read('relay-cooldown:'+target.upstreamId+'\0'+target.model),...(u?.kind==='workbuddy'&&u.accountId?[read('wb-pool-cooldown:'+u.accountId)]:[])].filter(r=>r&&r.reasonCode!=='capability_unavailable'&&number(r.until)!==null&&r.until>now&&r.until<=8640000000000000).sort((a,b)=>b.until-a.until);
    const cooldown=cooldowns[0]??null;
    if(cooldown)skip(safeCode(cooldown.reasonCode??cooldown.reason)??'supplier_cooldown');
    if(u?.kind==='workbuddy'&&(read('wb-management-manual-status:'+u.accountId)?.status==='banned'||read('wb-management-official-status:'+u.accountId)?.status==='banned'))skip('account_banned');
    if(u?.kind==='workbuddy'&&route.accountPool?.enabled&&workBuddyEdition(a)!==workBuddyEdition(primaryAccount))skip('edition_mismatch');
    if(u?.kind==='workbuddy'&&a?.inferenceEnabled===false)skip('wb_inference_disabled');
    if(a?.enabled===false)skip('account_disabled');
    if(!u||u.enabled===false)skip('upstream_disabled_or_missing');
    if(route.enabled===false)skip('route_disabled');
    return {position:index+1,platform:safeCode(u?.kind)??'unknown',model:diagnosticText(target.model,value),accountRef:diagnosticAccountRef(u?.accountId),state:status,reasonCode:safeCode(reasonCode),capabilities:{tools:typeof model?.tools==='boolean'?model.tools:null,multimodal:typeof model?.multimodal==='boolean'?model.multimodal:null,contextWindow,outputCapacity:maxOutput},contextFit,outputFit,catalog:{source:model?'memory_catalog':'not_cached_or_model_not_listed',checkedAt:null,freshness:'unknown',completeness:'unknown',callableDeclared:typeof model?.callable==='boolean'?model.callable:null},audit:auditEvidence(audit?.results?.find(r=>r.upstreamId===target.upstreamId&&r.model===target.model),value),cooldown:cooldown?{reasonCode:safeCode(cooldown.reasonCode??cooldown.reason),until:new Date(cooldown.until).toISOString(),retryAfterSeconds:Math.ceil((cooldown.until-now)/1000)}:null,notes:['目录缓存新鲜度未知；未刷新认证、余额或上游模型目录','上下文仅为保守充分适配估计，不是分词结果或生成成功保证',...(u?.kind==='opencode'?['OpenCode 当前文本桥仅保留单条 user 纯文本；不接受显式生成参数、图像或外部工具协议']:[])]};
  });
  const preferred=relayActive?read('relay-preferred:'+route.id):null;
  if(preferred)candidates.sort((a,b)=>{const ap=targets[a.position-1],bp=targets[b.position-1];return Number(bp?.upstreamId===preferred.upstreamId&&bp?.model===preferred.model)-Number(ap?.upstreamId===preferred.upstreamId&&ap?.model===preferred.model);});
  candidates.forEach((row,index)=>{row.position=index+1;});
  const counts={eligible:candidates.filter(c=>c.state==='eligible').length,unknown:candidates.filter(c=>c.state==='unknown').length,skipped:candidates.filter(c=>c.state==='skipped').length};
  const contract={...input.contract,clientModelId:diagnosticText(input.contract.clientModelId,value)};
  return {schema:1,generatedAt:new Date(now).toISOString(),routeId:diagnosticText(route.id,value),mode:input.mode,contractCompleteness:input.complete?'full_request':'partial_metadata',relayActive,contract,candidates,counts,summary:{...counts,total:candidates.length,generationVerified:false,selection:'advisory_snapshot_not_dispatch_reservation'},sideEffects:{generationRequests:0,configWrites:0,stateWrites:0},note:'本次预演不发送生成请求、不刷新目录或认证，不改变账号偏好、冷却、租约或配置；原始请求未裁剪。'};
}
