import {AppError,errorView} from './util.mjs';
import {normalizeBalance} from './balances.mjs';
import {isCreditExhausted} from './workbuddy-pool.mjs';
import {isContextWindowError} from './openai.mjs';
export const isRelayTransportFailure=error=>['provider_network_error','provider_timeout','relay_target_timeout'].includes(error?.code);
const rateLimitKinds=new Set(['transient','long_window','usage_limit','unknown']);
const rateLimitRetrySources=new Set(['official_header','official_body','local_default']);
const transientRateCodes=new Set([6001,6002,6005,6006,14003]);
const knownRateCodes=new Set([6000,...transientRateCodes,6003,6004,6007,6008,14001,14002,14012,14013,14014,14015,14016,14017,14018,14019,10105,15001,11115]);
const rateErrorCodes=new Set(['provider_chat_rejected','provider_http_error','provider_rate_limited','rate_limited','nvidia_rate_limited','upstream_error','upstream_sse_error']);
// Persistent circuits contain only a typed diagnosis, never an upstream body,
// message, URL or credential. A legacy rate-limit row remains unknown, not a
// transport outage or evidence that an automatic paid retry is appropriate.
export function relayRateLimitMetadata(error={}){
 const upstreamCode=knownRateCodes.has(error.upstreamCode)?error.upstreamCode:undefined;
 const rateLimitKind=rateLimitKinds.has(error.rateLimitKind)?error.rateLimitKind:'unknown';
 const supplied=typeof error.retryAfterSeconds==='number'&&Number.isFinite(error.retryAfterSeconds)&&error.retryAfterSeconds>=0&&error.retryAfterSeconds<=86400;
 const retryAfterSource=supplied&&rateLimitRetrySources.has(error.retryAfterSource)?error.retryAfterSource:'local_default';
 const retryAfterSeconds=supplied&&retryAfterSource!=='local_default'?error.retryAfterSeconds:30;
 const rateLimitRetryable=rateLimitKind==='transient'&&transientRateCodes.has(upstreamCode)&&error.rateLimitRetryable===true;
 return {upstreamStatus:429,...(upstreamCode!==undefined?{upstreamCode}:{}),rateLimitKind,rateLimitRetryable,retryAfterSeconds,retryAfterSource};
}
export const relayDefaults={enabled:false,reservePercent:10,reserveCredits:100,balanceMaxAgeSeconds:60};
export function modelFamily(id){return String(id??'').toLowerCase().replace(/^(?:deepseek-ai|deepseek|z-ai|moonshotai|qwen|meta-llama|nvidia)\//,'').replace(/:free$/,'').replaceAll('_','-');}
// An opaque native key is an alias only while its signed, live catalogue says
// the exact model/version. UI route labels and hand-written names are not proof.
export function catalogModelFamily(id,model){
 if(id==='gmodel'&&model?.id===id&&model.callable!==false&&model.source==='qoder-official-signed-catalog'&&/^GLM-\d+(?:\.\d+)+(?:-(?:Flash|FlashX))?$/i.test(model.name??''))return modelFamily(model.name);
 return modelFamily(id);
}
export function relayPartition(config,target){return config.upstreams?.find(u=>u.id===target?.upstreamId)?.kind==='workbuddy'?'workbuddy':'other';}
export function relayPolicy(config){return {...relayDefaults,...config.modelRelay};}
export function validateRelay(policy){if(!policy||typeof policy.enabled!=='boolean'||!Number.isFinite(policy.reservePercent)||policy.reservePercent<0||policy.reservePercent>50||!Number.isFinite(policy.reserveCredits)||policy.reserveCredits<0||policy.reserveCredits>100000||!Number.isInteger(policy.balanceMaxAgeSeconds)||policy.balanceMaxAgeSeconds<5||policy.balanceMaxAgeSeconds>600||policy.partitions!==undefined&&(!policy.partitions||typeof policy.partitions!=='object'||Array.isArray(policy.partitions)||Object.entries(policy.partitions).some(([key,value])=>!['workbuddy','other'].includes(key)||typeof value!=='boolean')))throw new AppError('Invalid same-model relay policy',400,'invalid_model_relay');return policy;}
export class ModelRelay{
 constructor(config,platforms,ledger){Object.assign(this,{config,platforms,ledger});this.memory=new Map();this.balances=new Map();this.flights=new Map();}
 get(key){return this.ledger?.get?.(key)??this.memory.get(key);}
 set(key,row){if(this.ledger?.set)this.ledger.set(key,row);else this.memory.set(key,row);}
 partition(route){return relayPartition(this.config.value,route.targets[0]);}
 active(route,source='api'){const p=relayPolicy(this.config.value);return source!=='audit'&&p.enabled===true&&p.partitions?.[this.partition(route)]!==false&&route.relay!==false&&route.targets.every(t=>modelFamily(t.model)===modelFamily(route.targets[0].model));}
 enabled(target){const u=this.config.value.upstreams.find(u=>u.id===target.upstreamId),a=this.config.value.accounts?.find(a=>a.id===u?.accountId);return !!u&&u.enabled!==false&&a?.enabled!==false&&(u.kind!=='workbuddy'||a?.inferenceEnabled!==false);}
 cooldown(target){
  const u=this.config.value.upstreams.find(u=>u.id===target.upstreamId),rows=[this.get('relay-cooldown:'+target.upstreamId+'\0'+target.model)];
  if(u?.kind==='workbuddy'&&u.accountId)rows.push((this.pool??this).get('wb-pool-cooldown:'+u.accountId));
  // A tools/image/output/effort mismatch belongs to one request. Older releases
  // persisted these as supplier outages: ignore only those obsolete rows, not
  // actual credit, authentication, rate-limit or transport cooldowns.
  return rows.filter(r=>r&&r.reasonCode!=='capability_unavailable'&&Number.isFinite(r.until)&&r.until>Date.now()).sort((a,b)=>b.until-a.until)[0]??null;
 }
 candidates(route,base,{ignoreCooldown=false,source='api'}={}){
  base=base.filter(t=>relayPartition(this.config.value,t)===this.partition(route)&&(relayPartition(this.config.value,t)!=='workbuddy'||this.enabled(t)));
  if(!this.active(route,source))return base;
  const value=this.config.value,family=modelFamily(route.targets[0].model),partition=this.partition(route),targets=[...base];
  for(const r of value.routes)if(r.enabled!==false&&modelFamily(r.targets[0]?.model)===family)for(const t of r.targets)if(modelFamily(t.model)===family)targets.push(t);
  const seen=new Set();return targets.filter(t=>{const key=t.upstreamId+'\0'+t.model;if(!this.enabled(t)||relayPartition(value,t)!==partition||seen.has(key))return false;seen.add(key);return ignoreCooldown||!this.cooldown(t);});
 }
 async discover(route,base,signal,{source='api',ignoreCooldown=false}={}){
  base=base.filter(t=>relayPartition(this.config.value,t)===this.partition(route)&&(relayPartition(this.config.value,t)!=='workbuddy'||this.enabled(t)));
  if(!this.active(route,source))return {targets:base,catalogs:new Map(),family:modelFamily(route.targets[0].model),partition:this.partition(route)};
  const partition=this.partition(route),all=[...base,...this.config.value.routes.filter(r=>r.enabled!==false).flatMap(r=>r.targets)].filter(t=>relayPartition(this.config.value,t)===partition),catalogs=new Map();
  const rawFamily=modelFamily(route.targets[0].model),mayUseOpaqueAlias=rawFamily==='gmodel'||/^glm-\d+(?:\.\d+)+(?:-flashx?)?$/i.test(rawFamily);
  const qoderIds=mayUseOpaqueAlias?[...new Set(all.filter(t=>this.enabled(t)&&t.model==='gmodel'&&this.config.value.upstreams.find(u=>u.id===t.upstreamId)?.kind==='qoder').map(t=>t.upstreamId))]:[];
  const read=this.catalogRead??this.platforms.models.bind(this.platforms);
  await Promise.all(qoderIds.map(async id=>{try{catalogs.set(id,await read(id,{signal}));}catch{if(signal?.aborted)throw new AppError('Request cancelled',499,'request_cancelled');catalogs.set(id,[]);}}));
  const familyOf=t=>catalogModelFamily(t.model,catalogs.get(t.upstreamId)?.find(m=>m.id===t.model)),family=familyOf(route.targets[0]),seen=new Set();
  const targets=all.filter(t=>{const key=t.upstreamId+'\0'+t.model;if(!this.enabled(t)||seen.has(key)||familyOf(t)!==family)return false;seen.add(key);return ignoreCooldown||!this.cooldown(t);});
  return {targets,catalogs,family,partition};
 }
 async balance(target,signal){
  const u=this.config.value.upstreams.find(u=>u.id===target.upstreamId);if(!u?.accountId)return null;
  const policy=relayPolicy(this.config.value),fresh=r=>{const age=Date.now()-Date.parse(r?.checkedAt);return r&&!r.stale&&!r.error&&Number.isFinite(age)&&age>=0&&age<policy.balanceMaxAgeSeconds*1000;};
  const supplied=this.balanceSource?.()?.get(u.accountId);if(fresh(supplied))return supplied;
  if(typeof this.platforms.health!=='function')return null;
  const key=u.accountId+'\0'+JSON.stringify(this.config.value.accounts?.find(a=>a.id===u.accountId)?.credentials);const cached=this.balances.get(key);if(cached&&Date.now()-cached.at>=0&&Date.now()-cached.at<policy.balanceMaxAgeSeconds*1000)return cached.row;
  if(this.flights.has(key))return this.flights.get(key);
  const operation=(async()=>{let timer;try{const timeout=AbortSignal.timeout(3000),combined=signal?AbortSignal.any([signal,timeout]):timeout;const health=await Promise.race([this.platforms.health(u.accountId,{signal:combined}),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),3000);})]);if(!health)return null;const row={...normalizeBalance(u.kind,health),checkedAt:new Date().toISOString(),stale:false,...(u.kind==='trae'?{totalValue:health.snapshot?.summary?.totalAmount}:{})};this.balances.set(key,{at:Date.now(),row});return row;}catch{return null;}finally{clearTimeout(timer);}})();this.flights.set(key,operation);try{return await operation;}finally{this.flights.delete(key);}
 }
 lowReason(row){
  if(!row||row.stale||row.error)return null;const p=relayPolicy(this.config.value),q=row.quota;
  const quotaAge=Date.now()-Date.parse(q?.observedAt),liveWindow=q&&(!q.resetAt||Date.parse(q.resetAt)>Date.now())&&(!q.observedAt||Number.isFinite(quotaAge)&&quotaAge>=0&&quotaAge<p.balanceMaxAgeSeconds*1000);
  if(liveWindow&&typeof q.requestRemaining==='number'&&typeof q.requestLimit==='number'&&q.requestLimit>0&&q.requestRemaining/q.requestLimit*100<=p.reservePercent)return 'request_window_low';
  if(liveWindow&&typeof q.tokenRemaining==='number'&&typeof q.tokenLimit==='number'&&q.tokenLimit>0&&q.tokenRemaining/q.tokenLimit*100<=p.reservePercent)return 'token_window_low';
  if(typeof row.value==='number'&&/^(积分|credit|credits|CREDIT|Credits)$/i.test(row.unit??'')){if(row.value<=p.reserveCredits)return 'credits_low';if(typeof row.totalValue==='number'&&row.totalValue>0&&row.value/row.totalValue*100<=p.reservePercent)return 'credits_percent_low';}
  return null;
 }
 exhaustedBalance(row){return !!row&&!row.stale&&!row.error&&typeof row.value==='number'&&row.value<=0&&/^(积分|credit|credits|CREDIT|Credits)$/i.test(row.unit??'');}
 blockedTarget(target,row=this.cooldown(target)){
  if(!row)return null;const common={target:{...target},until:row.until,reasonCode:row.reasonCode??row.reason};
  if(common.reasonCode==='rate_limited')return {...common,...relayRateLimitMetadata(row),status:429,errorCode:rateErrorCodes.has(row.errorCode)?row.errorCode:'provider_rate_limited',retryAfterSeconds:Math.max(0,Math.ceil((row.until-Date.now())/1000))};
  return {...common,...(Number.isInteger(row.status)&&row.status>=400&&row.status<=599?{status:row.status}:{}),...(isRelayTransportFailure({code:row.errorCode})?{errorCode:row.errorCode}:{})};
 }
 rateLimitError(blocked,{capability=false}={}){
  const rows=blocked.filter(r=>r?.reasonCode==='rate_limited').sort((a,b)=>a.until-b.until);if(!rows.length)return null;
  const row=rows[0],metadata=relayRateLimitMetadata(row),label={transient:'短时限流',long_window:'长窗口限制',usage_limit:'用量或许可限制',unknown:'限流原因待确认'}[metadata.rateLimitKind];
  const error=new AppError(`同型号供应返回 HTTP 429（${label}）；${capability?'其余候选未确认可完整承接当前请求；':''}${metadata.retryAfterSource==='local_default'?'本地冷却不代表官方恢复时间；':''}模型、历史、工具和输出预算均已保留`,429,'same_model_rate_limited');
  Object.assign(error,metadata,{gatewayManagedRetry:true,retryAfterSeconds:Math.max(0,Math.ceil((row.until-Date.now())/1000))});return error;
 }
 clearRateLimit(target,expectedUntil){
  const key='relay-cooldown:'+target.upstreamId+'\0'+target.model,row=this.get(key);
  if(row?.reasonCode==='rate_limited'&&(expectedUntil===undefined?row.until<=Date.now():row.until===expectedUntil))this.set(key,{until:0,reasonCode:'rate_limit_recovered'});
 }
 async prepare(route,base,signal,{source='api'}={}){
  const discovered=await this.discover(route,base,signal,{source,ignoreCooldown:true});if(!this.active(route,source))return {...discovered,reasons:new Map()};
  const all=discovered.targets,targets=all.filter(t=>!this.cooldown(t));
  const reasons=new Map(),observed=await Promise.all(targets.map(async t=>{const balance=await this.balance(t,signal);return {target:t,low:this.lowReason(balance),exhausted:this.exhaustedBalance(balance)}})),rows=observed.filter(r=>!r.exhausted),preferred=this.get('relay-preferred:'+route.id);
  rows.sort((a,b)=>Number(!!a.low)-Number(!!b.low)||Number(b.target.upstreamId===preferred?.upstreamId&&b.target.model===preferred?.model)-Number(a.target.upstreamId===preferred?.upstreamId&&a.target.model===preferred?.model));
  for(const row of observed)if(row.low)reasons.set(row.target.upstreamId+'\0'+row.target.model,row.exhausted?'credits_exhausted':row.low);
  const blocked=all.map(t=>this.blockedTarget(t)).filter(Boolean),retryAfterSeconds=!rows.length&&blocked.length?Math.max(1,Math.ceil((Math.min(...blocked.map(r=>r.until))-Date.now())/1000)):undefined;
  return {...discovered,targets:rows.map(r=>r.target),blocked,reasons,enabledTargetCount:all.length,exhaustedTargetCount:observed.filter(r=>r.exhausted).length,...(retryAfterSeconds?{retryAfterSeconds}:{})};
 }
 success(route,target,{requestId,trigger,from}={}){
  if(!this.active(route))return;this.clearRateLimit(target);const old=this.get('relay-preferred:'+route.id),previous=from??old??route.targets[0];this.set('relay-preferred:'+route.id,{upstreamId:target.upstreamId,model:target.model,updatedAt:new Date().toISOString()});
  if(previous.upstreamId!==target.upstreamId){const value=this.config.value,row={day:new Date().toISOString().slice(0,10),platform:value.upstreams.find(u=>u.id===target.upstreamId)?.kind??'',accountId:value.upstreams.find(u=>u.id===target.upstreamId)?.accountId??'',task:'model-relay',status:'switched',routeId:route.id,modelFamily:modelFamily(target.model),requestId,fromPlatform:value.upstreams.find(u=>u.id===previous.upstreamId)?.kind??'',toPlatform:value.upstreams.find(u=>u.id===target.upstreamId)?.kind??'',reasonCode:trigger??'available_same_model'};this.ledger?.record?.(row);}
 }
 failure(route,target,error,{source='api'}={}){
  if(error.code==='wb_inference_disabled')return null; // A local user switch is not a supplier outage.
  if(!this.active(route,source))return null;const v=errorView(error),status=Number(error.status??v.status),context=isContextWindowError(error),depleted=!context&&isCreditExhausted(error);let reason=context||['relay_capacity_incompatible','relay_context_incompatible','tools_not_supported','images_not_supported','reasoning_effort_not_supported','reasoning_parameter_not_supported'].includes(error.code)?'capability_unavailable':depleted?'credits_exhausted':[401,403].includes(status)?'authentication_unavailable':status===404?'model_unavailable':status===429?'rate_limited':[408,500,502,503,504].includes(status)?'upstream_unavailable':null;
  if(reason&&reason!=='capability_unavailable'){const rate=reason==='rate_limited'?relayRateLimitMetadata(error):null,seconds=rate?rate.retryAfterSeconds:depleted?300:isRelayTransportFailure(error)?5:60;this.set('relay-cooldown:'+target.upstreamId+'\0'+target.model,{until:Date.now()+seconds*1000,reasonCode:reason,status,...(rate?{...rate,errorCode:rateErrorCodes.has(error.code)?error.code:'provider_rate_limited'}:isRelayTransportFailure(error)?{errorCode:error.code}:{})});}
  return reason;
 }
 status(){const p=relayPolicy(this.config.value);return {...p,partitions:{workbuddy:p.enabled,other:p.enabled,...p.partitions},strictSameModel:true,partitioned:true,historyPreserved:true,groups:this.config.value.routes.filter(r=>r.enabled!==false).map(r=>({routeId:r.id,modelFamily:modelFamily(r.targets[0].model),partition:this.partition(r),enabled:this.active(r),selectedUpstreamId:this.get('relay-preferred:'+r.id)?.upstreamId??r.targets[0].upstreamId,targets:this.candidates(r,r.targets,{ignoreCooldown:true}).map(t=>{const u=this.config.value.upstreams.find(u=>u.id===t.upstreamId),cooldown=this.cooldown(t);return {...t,platform:u?.kind,accountId:u?.accountId,state:cooldown?'cooldown':'eligible',reasonCode:cooldown?.reasonCode??cooldown?.reason??null,...(cooldown?{retryAfterSeconds:Math.max(1,Math.ceil((cooldown.until-Date.now())/1000))}:{})};})}))};}
}
