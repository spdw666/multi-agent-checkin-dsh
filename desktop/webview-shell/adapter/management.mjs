import {readFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loopbackBase,clean} from './snapshot.mjs';

const contract=JSON.parse((await readFile(new URL('./management-contract.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
const hash=b=>createHash('sha256').update(b).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const plain=v=>object(v)?v:{};
const list=v=>Array.isArray(v)?v:[];
const id=v=>typeof v==='string'&&v.length>0&&v.length<=160&&!/[\x00-\x20\x7f/\\?#]/.test(v);
const topFields=new Set(['method','section','view','accountId','limit','query','jobId','requestId','action','confirmed','revision','values','items','accountIds','routeIds','content','token']);
export class ManagementError extends Error {constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const invalid=()=>{throw new ManagementError('invalid_management_request');};
const validList=(a,fn,max=1000)=>Array.isArray(a)&&a.length<=max&&a.every(fn);
function shape(v,fields,required=[]){if(!object(v)||Object.keys(v).some(k=>!Object.hasOwn(fields,k))||required.some(k=>!Object.hasOwn(v,k)))invalid();for(const [k,value]of Object.entries(v))check(value,fields[k]);}
function check(value,description){
  const type=description.replace(/^required /,'').replace(/ optional$/,'');
  if(description.startsWith('required ')&&typeof value==='string'&&!value.trim())invalid();
  if(type==='bool'){if(typeof value!=='boolean')invalid();return;}
  if(type==='id'||type==='WB id'||type==='configured WB id'||type==='existing route id'){if(!id(value))invalid();return;}
  if(type==='UUID'){if(typeof value!=='string'||! /^[a-f0-9-]{36}$/i.test(value))invalid();return;}
  if(type==='hex24'){if(typeof value!=='string'||! /^[a-f0-9]{24}$/i.test(value))invalid();return;}
  if(type==='platform'){if(typeof value!=='string'||! /^[a-z0-9-]{1,50}$/i.test(value))invalid();return;}
  if(type==='localhost|loopback|0.0.0.0'){if(typeof value!=='string'||! /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1)$/.test(value))invalid();return;}
  let m=type.match(/^text(\d+)$/);if(m){if(typeof value!=='string'||value.length>Number(m[1])||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))invalid();return;}
  m=type.match(/^(int|number)(\d+)\.\.(\d+)$/);if(m){if(typeof value!=='number'||!Number.isFinite(value)||value<Number(m[2])||value>Number(m[3])||m[1]==='int'&&!Number.isInteger(value))invalid();return;}
  if(type==='array<{id,enabled}>'){if(!validList(value,v=>{shape(v,{id:'id',enabled:'bool'},['id','enabled']);return true;}))invalid();return;}
  if(type==='array<{upstreamId,model}>'){if(!validList(value,v=>{shape(v,{upstreamId:'id',model:'text256'},['upstreamId','model']);return !!v.model;}))invalid();return;}
  if(type==='{workbuddy?:bool,other?:bool}'){shape(value,{workbuddy:'bool',other:'bool'});return;}
  m=type.match(/^array<(.+)>$/);if(m){if(!validList(value,v=>{check(v,m[1]);return true;}))invalid();return;}
  if(type.includes('|')){if(!type.split('|').includes(value))invalid();return;}
  invalid();
}
function modelItems(items){
  if(!Array.isArray(items)||!items.length||items.length>5000)invalid();
  for(const item of items){shape(item,{upstreamId:'id',model:'text256',enabled:'bool',importedRouteIds:'array<id>'},['upstreamId','model']);if(!item.model)invalid();}
}
export function validateManagementRequest(input){
  if(!object(input)||Object.keys(input).some(k=>!topFields.has(k))||!['read','action'].includes(input.method))invalid();
  if(input.accountId!==undefined&&!id(input.accountId)||input.jobId!==undefined&&(typeof input.jobId!=='string'||! /^[a-f0-9-]{36}$/i.test(input.jobId))||input.requestId!==undefined&&(typeof input.requestId!=='string'||input.requestId.length>120)||input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>1000)||input.query!==undefined&&(typeof input.query!=='string'||input.query.length>200)||input.revision!==undefined&&(typeof input.revision!=='string'||! /^[a-f0-9]{64}$/.test(input.revision)))invalid();
  if(input.method==='read'){
    const section=contract.reads[input.section];if(!section||input.action!==undefined||input.values!==undefined||input.items!==undefined||input.content!==undefined||input.token!==undefined)invalid();
    if(input.view!==undefined&&!section.views.includes(input.view))invalid();
    return {...input,view:input.view??section.views[0],limit:input.limit??100};
  }
  const action=contract.actions[input.action];if(!action||input.section!==undefined||input.view!==undefined)invalid();
  if(input.confirmed!==true)return {...input,cancelled:true};
  if(action.accountId==='required'&&!id(input.accountId)||action.jobId?.startsWith('required')&&!input.jobId)invalid();
  const fields=action.values??{},values=input.values??{};
  shape(values,fields,Object.entries(fields).filter(([,v])=>v.startsWith('required ')).map(([k])=>k));
  if(action.revisionRequired&&!input.revision)throw new ManagementError('configuration_revision_required',409);
  if(action.accountIds?.startsWith('required')&&(!Array.isArray(input.accountIds)||!input.accountIds.length)||input.accountIds!==undefined&&(!validList(input.accountIds,id,128)||new Set(input.accountIds).size!==input.accountIds.length))invalid();
  if(action.routeIds?.startsWith('required')&&(!Array.isArray(input.routeIds)||!input.routeIds.length)||input.routeIds!==undefined&&(!validList(input.routeIds,id,500)||new Set(input.routeIds).size!==input.routeIds.length))invalid();
  if(action.items){modelItems(input.items);}else if(input.items!==undefined)invalid();
  if(input.action==='models.test'&&values.items!==undefined)modelItems(values.items);
  if(input.action.startsWith('wb.import')){if(typeof input.content!=='string'||!input.content.length||Buffer.byteLength(input.content)>6*1024*1024)invalid();}
  else if(input.content!==undefined||input.token!==undefined)invalid();
  return {...input,values};
}

const allowedKeys=new Set(('accounts account accountId id label name nickname notes platform edition region enabled inferenceEnabled current active status usageStatus credentialStatus credentialConfigured remaining total consumed checkedAt lastSuccessAt lastFailureAt stale balance packages packageCount packageName value unit expiresAt expiresAtMs validUntil startsAt complete queryScope tasks items taskCode taskCodes code title description progress credits reward rewards claimable accepted claimed completed dailyCheckin todayCheckedIn known day streakDays todayCredit nextClaimAt reason error message kind source refreshed currentAccountId totals settings autoMigrateSessions autoTasks sessionCapabilities available supported target sourceAccountIds targetAccountId models model modelId providers providerId freeProviderId upstreams upstreamId targets accountIds routeIds routes routeId imported importedRouteIds importable callable unavailableReason partitions workbuddy other reservePercent reserveCredits balanceMaxAgeSeconds eligible excluded matches inferred fallbackStatuses accountPool cooldownSeconds cooldown cooldownUntil until scheduler startup timezone hour minute jitterSeconds retryMinutes server host port clientUpdates intervalHours timeoutMs scope startedAt updatedAt finishedAt results tests test result success latencyMs durationMs ttftMs firstTokenMs inFlight requests tokens inputTokens outputTokens requestCount tokenCount totalTokens used knownCredits dailyRequestLimit dailyTokenLimit dailyKnownCreditLimit maxConcurrency createdAt revokedAt prefix allowedModels notificationsEnabled strategy affinityEnabled affinityTtlMinutes notifications notice notificationId level severity read readAt clients keys sessions sessionSummary bindings sessionRef clientId health healthWindow windowHours sampleLimit routingDecisions decisions expiry calendar unknownAccounts entries count index valid invalid existing errors warnings preview imported skipped replaced deleted saved selected disabled alreadyDisabled disabledRouteIds removedRouteIds removedUpstreamIds credentialFilesPreserved historyPreserved automaticCheckinUnchanged automaticTasksUnchanged automaticOperationConfirmed automaticRewardConfirmed benefitOutcome operationAttempted submitted newClaimSubmitted serverConfirmed task time trigger triggerSource automatic manual rawStatus refreshedAt plan generationRequests desktopLoginChanged clientSwitched selectedIndexes duplicatePolicy format exported loginId pollAfterMs verificationCode userCode reusedExisting scheduledAt nextRunAt nextCheckAt lastCheckedAt intervalMinutes cooldownMinutes minUrgencyHours minRemainingCredits minGapHours target dryRun state gateway cli gatewayBusy eligibleAccounts excludedAccounts nearestExpiryMs action job jobId phase done cancelled cancelling acceptedTaskCodes completedTaskCodes execution queryStatus claimStatus receipts snapshot summary newReward noReward operation sourceType refreshed failedOnly targetIds latest installed currentVersion latestVersion updateAvailable comparison evidence downloadUrl releaseUrl commandPath executable version checkSource checkedBy capabilities unsupported disabledReasons candidates selectedTarget selection resolution warningsFound range window from to requestId sourceName reasonCode decision accountRef parameter explicitParameters messageCount toolCount requiresTools hasImages hasToolHistory serializedBytes outputBudget maxTokens maxCompletionTokens inputChars contextEstimate method tokenCount upperBound resolved transport runtimeVersion clientActivation loaded activeInstance originalWindow activation evidenceType sourceVersion installedVersion backendVersion workerVersion dsh statusCode httpStatus upstreamStatus upstreamCode modelFamily family capabilities route importedRoutes sampleLimit totalCount nextBeforeId change previousValue previousAt cacheStatus verified fields fieldsMissing membership validFrom usablePower availableBalance sourceCount sourceId enabledCount configured keyless accountIds missingCredential credentialStatus website docsUrl websiteUrl mapping timeout estimatedBytes responseBytes controlMode liveRuntime runtime healthSummary modelsSummary accountCount unknownAccounts allAccounts bannedAccounts disabledAccounts inferenceEnabledAccounts inferenceDisabledAccounts inferenceRemaining inferenceTotal knownRemaining knownTotal knownAccounts balanceScope startTime endTime completedAt jobPhase step nextStep accepts tools streams json schema modes release channel local required supportedMethods requestContract operator configuredBy parameters partition effective cutoff outputCapacity inputCapacity maxOutputTokens maxContextTokens limits selectPolicy members routeName modelName alias titleText targetStatus reasonSource policy eligibility authStatus suspension manualStatus officialStatus permanent retriable retryAfterSeconds retryAfterSource rateLimitKind rateLimitRetryable checked field valueLimit amount delta confirmed observed taskId data meta note nested validRecords importedCount duplicateCount invalidCount duplicate tokenReturned limits jsonBytes inputBytes files progressPercent ready failed warningsCount cache ageMs lastRun runAt nextAt scheduled duration checkedCount successes errorsCount running completeCount observedCount').split(/\s+/));
for(const key of ['baseUrl','client','records','accountLabel','rows','events','groups','sources','counts','stats','modelRelay','relay','components','processes','installed','resident','disk','source','service','runtime','expected','actual','checks','findings','evidenceSummary','verification','availability','remainingRequests','remainingTokens','dataSource','accountSummary','routeSummary','totalRecords','recent','cached','loaded','versionMatch','pathsMatch','bundleVersion','nativeVersion','pluginVersion','healthStatus','filename','bytes','validRecords','selectedCount','duplicateCount','invalidCount'])allowedKeys.add(key);
const denied=/(?:^|_)(?:uid|email|principal|password|secret|token|cookie|authorization|credentials|authraw|profileraw|raw|prompt|messages|content|headers|body|keyhash)(?:$|_)/i;
function rememberSensitive(value,secrets,depth=0){
  if(depth>10||!value||typeof value!=='object')return;
  for(const [key,item]of Object.entries(value)){
    if(typeof item==='string'&&item.length>=6&&/^(?:uid|email|principal|access[_-]?token|refresh[_-]?token|api[_-]?key|adminKey|authorization|cookie|password|secret|key|keyHash|prompt|body|content)$/i.test(key))secrets.push(item);
    else if(item&&typeof item==='object')rememberSensitive(item,secrets,depth+1);
  }
}
export function safeDisplay(value,{secrets=[],depth=0}={}){
  if(depth>10)return null;
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value==='string'){
    let text=value;for(const secret of secrets)if(typeof secret==='string'&&secret.length>=6)text=text.split(secret).join('[已隐藏]');
    return clean(text,800).replace(/\bgwv_[A-Za-z0-9_-]{20,}\b/g,'[已隐藏凭据]').replace(/\b(?:uid|principal)\s*[:=]\s*\S+/gi,'[已隐藏身份]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[已隐藏邮箱]');
  }
  if(Array.isArray(value))return value.slice(0,1000).map(v=>safeDisplay(v,{secrets,depth:depth+1}));
  if(!object(value))return null;
  const result={};for(const [key,item]of Object.entries(value)){
    if(key==='__proto__'||key==='constructor'||key==='prototype'||denied.test(key)||!allowedKeys.has(key))continue;
    result[key]=safeDisplay(item,{secrets,depth:depth+1});
  }return result;
}
function publicAccount(a){return {id:a.id,label:a.label??a.name??a.id,platform:a.platform,edition:a.edition??'cn',enabled:a.enabled!==false,inferenceEnabled:a.inferenceEnabled!==false,notes:a.notes??'',tasks:list(a.tasks).map(t=>({id:t.id,enabled:t.enabled!==false})),credentialConfigured:!!(a.credentials?.file||a.credentials?.kind&&a.credentials.kind!=='none')};}
function publicUpstream(u){let baseUrl;try{const url=new URL(u.baseUrl);url.username='';url.password='';url.search='';url.hash='';baseUrl=url.href;}catch{}return {id:u.id,kind:u.kind,accountId:u.accountId,enabled:u.enabled!==false,...(baseUrl?{baseUrl}:{})};}
function publicRoute(r){return {id:r.id,name:r.name??r.id,enabled:r.enabled!==false,targets:list(r.targets).map(t=>({upstreamId:t.upstreamId,model:t.model})),...(r.accountPool?{accountPool:{enabled:r.accountPool.enabled!==false,accountIds:r.accountPool.accountIds??[],cooldownSeconds:r.accountPool.cooldownSeconds}}:{}),...(r.fallbackStatuses?{fallbackStatuses:r.fallbackStatuses}:{})};}
function publicWorkBuddy(summary,secrets){
  rememberSensitive(summary,secrets);
  const safe=safeDisplay(summary,{secrets});
  if(Array.isArray(summary.accounts))safe.accounts=summary.accounts.map(a=>({...safeDisplay(a,{secrets}),id:a.accountId??a.id,accountId:a.accountId??a.id,label:safeDisplay(a.label??a.id,{secrets}),edition:a.edition??a.region??'cn'}));
  if(object(summary.account))safe.account={...safeDisplay(summary.account,{secrets}),id:summary.account.accountId??summary.account.id};
  return safe;
}
const friendly={invalid_management_request:'管理参数无效，请重新读取页面后重试。',configuration_changed:'配置已由其他操作更新，本次未提交，请重新读取后编辑。',configuration_revision_required:'请先读取当前配置，再保存这次修改。',unknown_account:'账号配置已变化，请重新读取。',unknown_route:'路由配置已变化，请重新读取。',unknown_upstream:'上游配置已变化，请重新读取。',gateway_identity:'当前本机端口不是积分网关服务。',gateway_credentials:'后台管理连接信息未就绪。',gateway_http_failed:'后台未接受这次操作，请查看诊断记录。',invalid_response:'后台响应暂未完成，请重新核对当前状态。',response_too_large:'响应数据较多，请缩小筛选范围。',export_invalid:'后台导出内容未通过完整性检查。'};
const op=(kind,status,message)=>({kind,status,message});
async function parseResponse(response){
  const reader=response.body?.getReader();if(!reader)throw new ManagementError('invalid_response',502);
  const chunks=[];let n=0;try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>8*1024*1024)throw new ManagementError('response_too_large',502);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ManagementError('invalid_response',502);}
  if(!response.ok){const code=data?.error?.code;const error=new ManagementError(code==='configuration_changed'?'configuration_changed':'gateway_http_failed',response.status);error.httpStatus=response.status;throw error;}
  return plain(data);
}

export async function performManagement(configFile,raw,{fetchImpl=globalThis.fetch}={}){
  let request,attempted=false;
  try{
    request=validateManagementRequest(raw);
    if(request.cancelled)return {operation:op(request.action,'cancelled','已取消，未向后台发送操作。')};
    const file=resolve(configFile),before=await readFile(file),config=JSON.parse(before.toString('utf8').replace(/^\uFEFF/,'')),revision=hash(before);
    if(request.revision&&request.revision!==revision)throw new ManagementError('configuration_changed',409);
    const values=request.values??{},section=request.section;
    const account=request.accountId?(config.accounts??[]).find(a=>a.id===request.accountId):null;
    if(request.accountId&&!account)throw new ManagementError('unknown_account',404);
    const dataDir=resolve(dirname(file),config.dataDir??'./data');
    const runtime=JSON.parse(await readFile(join(dataDir,'runtime.json'),'utf8')),base=loopbackBase(runtime.baseUrl);
    const keys=JSON.parse(await readFile(join(dataDir,'api-keys.json'),'utf8'));
    if(typeof keys.adminKey!=='string'||!keys.adminKey)throw new ManagementError('gateway_credentials');
    const secrets=[keys.adminKey,...[request.content,values.apiKey,request.token].filter(v=>typeof v==='string')];
    rememberSensitive(config,secrets);rememberSensitive(values,secrets);
    if(request.content&&values.format!=='zip')try{rememberSensitive(JSON.parse(request.content),secrets);}catch{}
    const ensureUnchanged=async()=>{if(hash(await readFile(file))!==revision)throw new ManagementError('configuration_changed',409);};
    const call=async(method,path,body)=>{
      if(!/^admin\/[a-z0-9/?=&_%.-]+$/i.test(path)&&path!=='health')invalid();
      if(method!=='GET')attempted=true;
      return parseResponse(await fetchImpl(new URL(path,base),{method,redirect:'error',signal:AbortSignal.timeout(method==='GET'?30000:155000),headers:{...(path==='health'?{}:{Authorization:'Bearer '+keys.adminKey}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    };
    const health=await call('GET','health');if(health.service!=='ai-credit-gateway')throw new ManagementError('gateway_identity');
    await ensureUnchanged();
    if(request.method==='read'){
      let data;
      switch(section){
        case 'accounts':data={accounts:list(config.accounts).map(publicAccount),upstreams:list(config.upstreams).map(publicUpstream)};break;
        case 'preferences':data={scheduler:config.scheduler??{},server:{host:config.server?.host,port:config.server?.port},modelRelay:config.modelRelay??{},workbuddy:{autoMigrateSessions:config.workbuddy?.autoMigrateSessions??false,autoTasks:config.workbuddy?.autoTasks??false},clientUpdates:config.clientUpdates??{},accounts:list(config.accounts).map(publicAccount)};break;
        case 'routes':
          if(request.view==='directory')data=await call('GET','admin/model-directory');
          else if(request.view==='audit')data=await call('GET','admin/model-tests');
          else if(request.view==='relay')data=await call('GET','admin/model-relay');
          else if(request.view==='freeProviders')data=await call('GET','admin/free-providers');
          else data={routes:list(config.routes).map(publicRoute),upstreams:list(config.upstreams).map(publicUpstream),relay:config.modelRelay??{}};
          break;
        case 'records':{
          data=await call('GET','admin/'+(request.view==='usage'?'usage':'records')+'?limit='+request.limit+(request.accountId?'&accountId='+encodeURIComponent(request.accountId):''));
          data.records=list(data.records).map(row=>{const accountId=row.accountId??row.account_id,a=list(config.accounts).find(a=>a.id===accountId);return {...row,accountId,accountLabel:a?.label??a?.name??accountId??'未匹配账号'};});break;
        }
        case 'diagnostics':{const routes={context:'activity-context',requests:'request-diagnostics',activation:'client-activation',audit:'model-tests'};data=await call('GET','admin/'+routes[request.view]+'?limit='+Math.min(request.limit,200)+(request.query?'&search='+encodeURIComponent(request.query):'')+(request.requestId?'&requestId='+encodeURIComponent(request.requestId):''));break;}
        case 'workbuddy':{
          if(account&&account.platform!=='workbuddy')throw new ManagementError('unknown_account');
          const paths={summary:'workbuddy/summary',details:'workbuddy/accounts/'+encodeURIComponent(request.accountId??'')+'/details',rotation:'workbuddy/rotation',tasks:'workbuddy/task-jobs',taskJob:'workbuddy/task-jobs/'+encodeURIComponent(request.jobId??''),pools:'workbuddy/pools'};
          if(request.view==='details'&&!account||request.view==='taskJob'&&!request.jobId)invalid();
          data=publicWorkBuddy(await call('GET','admin/'+paths[request.view]+(request.accountId&&request.view!=='details'?'?accountId='+encodeURIComponent(request.accountId):'')),secrets);break;
        }
        case 'updates':data=await call('GET','admin/client-updates');break;
        case 'operations':data=await call('GET',request.view==='keys'?'admin/application-keys':'admin/operations');break;
        default:invalid();
      }
      rememberSensitive(data,secrets);await ensureUnchanged();return {section,data:safeDisplay(data,{secrets}),revision};
    }

    const action=request.action;
    if(action.startsWith('wb.')&&account&&account.platform!=='workbuddy')throw new ManagementError('unknown_account');
    if(request.accountIds){for(const a of request.accountIds)if(!list(config.accounts).some(row=>row.id===a&&row.platform==='workbuddy'))throw new ManagementError('unknown_account');}
    if(request.routeIds){for(const id of request.routeIds)if(!list(config.routes).some(r=>r.id===id))throw new ManagementError('unknown_route');}
    const configWrite=contract.actions[action].revisionRequired===true;
    let result;
    if(configWrite){
      const full=await call('GET','admin/config');await ensureUnchanged();const next=structuredClone(full);
      const setAccount=()=>{const a=list(next.accounts).find(a=>a.id===request.accountId);if(!a)throw new ManagementError('unknown_account');return a;};
      switch(action){
        case 'account.add':{
          if(list(next.accounts).some(a=>a.id===values.id))throw new ManagementError('invalid_management_request');
          const a={id:values.id,label:values.label,platform:values.platform,enabled:values.enabled??false,tasks:values.tasks??[],...(values.edition?{edition:values.edition}:{}),...(values.notes?{notes:values.notes}:{})};
          if(values.inferenceEnabled!==undefined)a.inferenceEnabled=values.inferenceEnabled;
          a.credentials={kind:values.credentialSource??(values.credentialFile?'file':'desktop'),file:values.credentialFile||'auto'};
          next.accounts=[...list(next.accounts),a];break;
        }
        case 'account.update':{const a=setAccount();for(const key of ['label','notes','edition'])if(Object.hasOwn(values,key))a[key]=values[key];if(values.credentialFile)a.credentials={...a.credentials,kind:values.credentialSource??'file',file:values.credentialFile};break;}
        case 'account.enable':setAccount().enabled=values.enabled;break;
        case 'account.tasks':setAccount().tasks=values.tasks;break;
        case 'route.save':{let route=list(next.routes).find(r=>r.id===values.id);if(!route){if(!values.targets?.length)invalid();route={id:values.id};next.routes=[...list(next.routes),route];}for(const key of ['name','enabled','targets','fallbackStatuses'])if(Object.hasOwn(values,key))route[key]=values[key];for(const t of route.targets??[])if(!list(next.upstreams).some(u=>u.id===t.upstreamId))throw new ManagementError('unknown_upstream');break;}
        case 'route.enable':{const r=list(next.routes).find(r=>r.id===values.id);if(!r)throw new ManagementError('unknown_route');r.enabled=values.enabled;break;}
        case 'route.delete':if(!list(next.routes).some(r=>r.id===values.id))throw new ManagementError('unknown_route');next.routes=next.routes.filter(r=>r.id!==values.id);break;
        case 'scheduler.save':next.scheduler={...next.scheduler,...values};break;
        case 'server.save':next.server={...next.server,...values};break;
        case 'updates.settings':next.clientUpdates={...next.clientUpdates,...values};break;
        case 'upstream.save':{let u=list(next.upstreams).find(u=>u.id===values.id);if(!u){if(!values.kind)invalid();u={id:values.id};next.upstreams=[...list(next.upstreams),u];}for(const k of ['kind','accountId','enabled','baseUrl','timeoutMs','maxOutputTokens'])if(Object.hasOwn(values,k))u[k]=values[k];if(values.accountId&&!list(next.accounts).some(a=>a.id===values.accountId))throw new ManagementError('unknown_account');if(values.credentialFile)u.credentials={...u.credentials,kind:'file',file:values.credentialFile};break;}
        case 'upstream.delete':if(!list(next.upstreams).some(u=>u.id===values.id))throw new ManagementError('unknown_upstream',404);if(list(next.routes).some(r=>list(r.targets).some(t=>t.upstreamId===values.id)))throw new ManagementError('upstream_still_referenced',409);next.upstreams=list(next.upstreams).filter(u=>u.id!==values.id);break;
        default:invalid();
      }
      await ensureUnchanged();result=await call('PUT','admin/config',next);
    }else{
      const aid=encodeURIComponent(request.accountId??'');
      let path,method='POST',body={...values};
      switch(action){
        case 'account.delete':path='accounts/'+aid;method='DELETE';body={confirm:true};break;
        case 'route.reorder':path='routes/'+encodeURIComponent(values.routeId)+'/targets-order';body={expectedTargets:values.expectedTargets,targets:values.targets};break;
        case 'relay.save':path='model-relay';break;
        case 'models.directory':path='model-directory?refresh=1';method='GET';body=undefined;break;
        case 'models.test':path='model-tests';break;
        case 'models.import':path='model-import';body={items:request.items,enabled:values.enabled!==false};break;
        case 'models.export':path='model-export';body={routeIds:request.routeIds};break;
        case 'freeProvider.add':path='free-provider-add';break;
        case 'diagnostics.doctor':path='doctor';break;
        case 'diagnostics.health':path='health';body={accountId:request.accountId};break;
        case 'diagnostics.rebind':path='rebind';body={accountId:request.accountId};break;
        case 'diagnostics.routePreview':path='route-preview';break;
        case 'diagnostics.restartDsh':path='restart-dsh';break;
        case 'wb.settings':path='workbuddy/settings';break;
        case 'wb.profile':path='workbuddy/accounts/'+aid+'/profile';break;
        case 'wb.inference':path='workbuddy/accounts/'+aid+'/inference';break;
        case 'wb.refresh':path='workbuddy/summary?refresh=1'+(aid?'&accountId='+aid:'');method='GET';body=undefined;break;
        case 'wb.switch':path='workbuddy/accounts/'+aid+'/switch';break;
        case 'wb.markStatus':path='workbuddy/accounts/'+aid+'/mark-status';body={...values,confirm:true};break;
        case 'wb.tasks':path='workbuddy/task-jobs';body={...values,...(request.accountId?{accountId:request.accountId}:{})};break;
        case 'wb.tasksCancel':path='workbuddy/task-jobs/'+encodeURIComponent(request.jobId)+'/cancel';body={};break;
        case 'wb.rotation':path='workbuddy/rotation';break;
        case 'wb.rotationEvaluate':path='workbuddy/rotation/evaluate';break;
        case 'wb.importPreview':case 'wb.importCommit':path='workbuddy/accounts/import/'+(action==='wb.importPreview'?'preview':'commit');body={...values,content:request.content};break;
        case 'wb.export':path='workbuddy/accounts/export';body={...values,accountIds:request.accountIds};break;
        case 'wb.capture':path='workbuddy/capture';break;
        case 'wb.loginStart':path='workbuddy/login/start';break;
        case 'wb.loginPoll':path='workbuddy/login/poll';break;
        case 'wb.loginCancel':path='workbuddy/login/cancel';break;
        case 'wb.merge':path='workbuddy/sessions/merge';body={targetAccountId:values.targetAccountId,sourceAccountIds:request.accountIds};break;
        case 'wb.pool':path='workbuddy/pool';body={...values,accountIds:request.accountIds};break;
        case 'wb.poolSelect':path='workbuddy/switch';body={routeId:values.routeId,accountId:request.accountId};break;
        case 'updates.check':path='client-updates/check';break;
        case 'operations.settings':path='operations/settings';break;
        case 'operations.keyCreate':path='application-keys';break;
        case 'operations.keyRevoke':path='application-keys/'+encodeURIComponent(values.id)+'/revoke';body={};break;
        case 'operations.notificationRead':path='notifications/'+encodeURIComponent(values.id)+'/read';body={};break;
        default:invalid();
      }
      await ensureUnchanged();result=await call(method,'admin/'+path,body);
    }
    rememberSensitive(result,secrets);
    const output={operation:op(action,'completed','后台已返回操作结果，请核对页面状态与任务回执。'),data:safeDisplay(result,{secrets})};
    if(action==='wb.refresh')output.data=publicWorkBuddy(result,secrets);
    if(action==='wb.export'){
      if(result.encoding!=='base64'||typeof result.content!=='string'||result.content.length>8*1024*1024||Buffer.from(result.content,'base64').toString('base64')!==result.content||typeof result.filename!=='string')throw new ManagementError('export_invalid');
      output.export={suggestedName:result.filename.replace(/[^a-zA-Z0-9_.-]/g,'_'),content:result.content,encoding:'base64'};
      output.data={exported:true,count:result.count??0};
    }
    if(action==='operations.keyCreate'){
      if(typeof result.key!=='string'||! /^gwv_[A-Za-z0-9_-]{43}$/.test(result.key))throw new ManagementError('export_invalid');
      output.export={suggestedName:'gateway-client-key.txt',content:result.key+'\n',encoding:'utf8'};output.data=safeDisplay({client:result.client},{secrets:[...secrets,result.key]});
    }
    if(action==='wb.loginStart'){
      const url=new URL(result.authorizationUrl??result.verificationUri??'');
      if(url.protocol!=='https:'||url.username||url.password||! /(^|\.)(codebuddy\.(cn|ai)|workbuddy\.(cn|ai)|tencent\.com|qq\.com)$/.test(url.hostname))throw new ManagementError('invalid_response');
      output.external={kind:'workbuddy-login',url:url.href};
      output.data=safeDisplay({loginId:result.loginId,expiresAt:result.expiresAt,pollAfterMs:result.pollAfterMs},{secrets});
    }
    output.data=safeDisplay(output.data,{secrets});
    return output;
  }catch(error){
    const code=error instanceof ManagementError?error.code:'management_connection_failed';
    const uncertain=attempted&&!(error instanceof ManagementError&&error.httpStatus>=400&&error.httpStatus<500);
    return {operation:op(request?.action??(raw?.method==='read'?'management.read':'management.action'),uncertain?'uncertain':'failed',friendly[code]??(uncertain?'提交后结果尚未确认；本窗口不自动重试，请先核对后台记录。':'管理操作尚未完成，请重新读取连接与页面状态。')),error:{code}};
  }
}

async function cli(){
  const args=process.argv.slice(2),at=args.indexOf('--config');if(at<0||!args[at+1])invalid();
  let text;
  if(args.includes('--request-stdin')){let bytes=0;const chunks=[];for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>7*1024*1024)invalid();chunks.push(chunk);}text=Buffer.concat(chunks).toString('utf8');}
  else{const i=args.indexOf('--request');if(i<0||!args[i+1])invalid();text=args[i+1];}
  if(!text||Buffer.byteLength(text)>7*1024*1024)invalid();
  const result=await performManagement(args[at+1],JSON.parse(text));process.stdout.write(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli().catch(()=>{process.stderr.write('management_request_failed\n');process.exitCode=1;});
