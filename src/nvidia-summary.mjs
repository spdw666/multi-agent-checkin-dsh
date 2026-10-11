import {nvidiaPolicySnapshot} from './nvidia-policy.mjs';
// Account-owned gateway telemetry is not a provider balance or remaining allowance.
const policy={creditsApplicable:false,sourceUrl:'https://forums.developer.nvidia.com/t/unable-to-view-my-account-credit/328471',sourceLabel:'NVIDIA 官方：Build 已取消积分制'};
const later=(a,b)=>!a?b:!b?a:Date.parse(a)>Date.parse(b)?a:b;
export function nvidiaUsage(ledger,accountId,{now=Date.now()}={}){
 const date=new Date(now+8*3600000).toISOString().slice(0,10),from=new Date(date+'T00:00:00+08:00').toISOString(),to=new Date(Date.parse(from)+86400000).toISOString();
 if(!ledger?.db)return {available:false,date,timeZone:'Asia/Shanghai',source:'gateway_ledger',note:'本网关用量读取未就绪；不是官方剩余额度',models:[]};
 try{
  const aggregate=ledger.db.prepare(`SELECT COUNT(*) requests,SUM(status='completed') success,SUM(status='failed') failed,SUM(status='cancelled') cancelled,SUM(status='running') running,
   SUM(json_extract(detail,'$.promptTokens')) inputTokens,SUM(json_extract(detail,'$.completionTokens')) outputTokens,SUM(json_extract(detail,'$.totalTokens')) totalTokens,
   SUM(json_extract(detail,'$.totalTokens') IS NULL) unknownTokenRequests FROM usage_calls WHERE account_id=? AND started_at>=? AND started_at<?`).get(accountId,from,to);
  const stats=Object.fromEntries(Object.entries(aggregate).map(([k,v])=>[k,["inputTokens","outputTokens","totalTokens"].includes(k)?v:v??0]));
  const models=ledger.db.prepare(`SELECT model,COUNT(*) requests,MAX(CASE WHEN status='completed' THEN started_at END) lastSuccessAt,MAX(CASE WHEN status='failed' THEN started_at END) lastFailureAt FROM usage_calls WHERE account_id=? GROUP BY model`).all(accountId);
  const latestFailure=ledger.db.prepare("SELECT detail FROM usage_calls WHERE account_id=? AND status='failed' ORDER BY id DESC LIMIT 1").get(accountId),failure=latestFailure?JSON.parse(latestFailure.detail):null;
  const lastSuccessAt=models.reduce((t,m)=>later(t,m.lastSuccessAt),null),lastFailureAt=failure?.finishedAt??failure?.startedAt??null;
  const authRow=ledger.db.prepare("SELECT detail FROM usage_calls WHERE account_id=? AND status='failed' AND json_extract(detail,'$.error.code')='nvidia_auth_failed' ORDER BY id DESC LIMIT 1").get(accountId),authFailure=authRow?JSON.parse(authRow.detail):null;
  const recent=ledger.db.prepare('SELECT COUNT(*) n FROM usage_calls WHERE account_id=? AND started_at>=? AND started_at<=?').get(accountId,new Date(now-60000).toISOString(),new Date(now).toISOString()).n;
  return {available:true,...stats,date,timeZone:'Asia/Shanghai',source:'gateway_ledger',lastMinuteRequests:recent,lastSuccessAt,lastFailureAt,lastAuthFailureAt:authFailure?.finishedAt??authFailure?.startedAt??null,lastFailureCode:failure?.error?.code??null,lastFailureMessage:failure?.error?.message??null,models,note:'仅统计经本网关的调用尝试，含 DSH/Hermes；Token 为上游已返回值，不含绕过网关的调用，不是官方剩余额度'};
 }catch{return {available:false,date,timeZone:'Asia/Shanghai',source:'gateway_ledger',note:'本网关用量读取失败；未用零替代未知值',models:[]};}
}
export function nvidiaSummary(service,account,health={},options={}){
 const q={...(health.quota??{}),...(health.authRecord??{})},usage=nvidiaUsage(service.ledger,account.id,options),lastSuccessAt=later(q.lastAuthenticatedAt,health.authRecord?null:usage.lastSuccessAt)??null;
 const lastFailureAt=later(q.lastAuthErrorAt,usage.lastFailureAt)??null;
 const authFailureAt=later(q.lastAuthErrorAt,health.authRecord?null:usage.lastAuthFailureAt),rejected=(q.credentialStatus==='rejected'||authFailureAt)&&(!lastSuccessAt||!authFailureAt||Date.parse(authFailureAt)>=Date.parse(lastSuccessAt));
 const missing=q.credentialStatus==='missing';
 const authentication={everAuthenticated:!!lastSuccessAt||q.credentialStatus==='authenticated',currentStatus:missing?'missing':rejected?'rejected':lastSuccessAt?'authenticated':q.credentialStatus??'unverified',lastSuccessAt,lastFailureAt,lastFailureCode:usage.lastFailureCode??(rejected?'nvidia_auth_failed':null),lastFailureMessage:usage.lastFailureMessage??null,lastDirectoryAt:q.lastDirectoryAt??null};
 const audit=service.ledger?.get?.('model-audit'),upstreams=(service.config.value.upstreams??[]).filter(u=>u.kind==='nvidia'&&u.accountId===account.id),ids=new Set(upstreams.map(u=>u.id));
 const items=(health.models??[]).filter(m=>m.freeEndpoint===true).map(m=>{const a=audit?.results?.find(r=>ids.has(r.upstreamId)&&r.model===m.id),u=usage.models.find(r=>r.model===m.id);return {id:m.id,name:m.name??m.id,category:m.category??'other',chat:m.chat===true,importable:m.importable===true,imported:(service.config.value.routes??[]).some(r=>r.enabled!==false&&r.targets.some(t=>ids.has(t.upstreamId)&&t.model===m.id)),status:a?.status??(u?.lastSuccessAt?'chat_verified':'unverified'),reason:a?.reason??m.unavailableReason??'',lastSuccessAt:u?.lastSuccessAt??null,lastFailureAt:u?.lastFailureAt??null,tools:m.tools===true,contextWindow:m.contextWindow??null,maxTokens:m.maxTokens??null,maxTokensSource:m.maxTokensSource??null,officialMaxTokens:m.officialMaxTokens??null};});
 const chat=items.filter(m=>m.chat),cooldownUntil=q.cooldownUntil??null;
 const {models:usageModels,...usageToday}=usage;
 const settings={maxConcurrent:upstreams[0]?.localLimits?.maxConcurrent??1,minIntervalMs:upstreams[0]?.localLimits?.minIntervalMs??1500,scope:'gateway_process',note:'本网关进程本地保护设置，不是 NVIDIA 官方限额'};
 return {policy:{...policy,...nvidiaPolicySnapshot,...health.policy},authentication,models:{freeTotal:items.length,freeChatCount:chat.length,importableCount:chat.filter(m=>m.importable).length,verifiedCount:chat.filter(m=>m.status==='passed').length,pendingCount:chat.filter(m=>!['passed','failed','unavailable'].includes(m.status)).length,otherTypesCount:items.length-chat.length,items},usageToday,settings,rateLimit:{cooldownUntil,retryAfterSeconds:q.retryAfterSeconds??null,observedAt:q.observedAt??null,last429At:q.last429At??null,scope:q.rateLimitScope??'upstream_unspecified'},officialQuota:{...q,balanceApplicability:'not_applicable'},note:'积分余额不适用（官方已取消积分制）；按模型状态、官方速率观测及本网关用量安排调用'};
}
