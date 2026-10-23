// Local virtual-key admission and opt-in routing controls. This module stores
// hashes, counters and target identifiers only: never request/session contents.
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {AppError,rememberSecret} from './util.mjs';
import {modelFamily} from './model-relay.mjs';
import {cachedAccountBalance} from './balances.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';

const SETTINGS='gateway-controls:settings:v1',KEYS='gateway-controls:keys:v1';
const defaults={strategy:'configured',affinityEnabled:false,affinityTtlMinutes:60};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const targetId=target=>target.upstreamId+'\0'+target.model;
const tokenError=(message,code,status=429)=>new AppError(message,status,code);
const dayAt=now=>new Date(now+8*3600000).toISOString().slice(0,10);
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
function limit(value,name,max=1e12){if(value===undefined||value===null||value===0)return null;if(!Number.isSafeInteger(value)||value<1||value>max)throw new AppError(name+' must be a positive bounded integer or zero',400,'invalid_client_limit');return value;}
function keyView(row,usage){const {keyHash,...publicRow}=row;return {...publicRow,usage};}
function policy(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!Object.hasOwn(defaults,key)))throw new AppError('Settings must contain known policy fields only',400,'invalid_control_settings');const value={...defaults,...input};if(!['configured','stable','fast','expiry'].includes(value.strategy)||typeof value.affinityEnabled!=='boolean'||!Number.isSafeInteger(value.affinityTtlMinutes)||value.affinityTtlMinutes<1||value.affinityTtlMinutes>1440)throw new AppError('Invalid routing policy or affinity duration',400,'invalid_control_settings');return {strategy:value.strategy,affinityEnabled:value.affinityEnabled,affinityTtlMinutes:value.affinityTtlMinutes};}

export class GatewayControls {
  constructor(service,{now=()=>Date.now()}={}){this.service=service;this.ledger=service.ledger;this.now=now;this.memory=new Map();this.sessions=new Map();this.decisions=new Map();this.healthCache=null;}
  get(key){return this.ledger?.get?.(key)??this.memory.get(key);}
  set(key,value){if(this.ledger?.set)this.ledger.set(key,value);else this.memory.set(key,clone(value));}
  atomic(work){const db=this.ledger?.db;if(!db||this.transactionDepth)return work();db.exec('BEGIN IMMEDIATE');this.transactionDepth=1;try{const result=work();db.exec('COMMIT');return result;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{this.transactionDepth=0;}}
  settings(){return policy(this.get(SETTINGS)??defaults);}
  saveSettings(input){return this.atomic(()=>{policy(input);const value=policy({...this.settings(),...input});this.set(SETTINGS,value);if(!value.affinityEnabled)this.sessions.clear();return value;});}
  keyRows(){return this.get(KEYS)??[];}
  dailyKey(id,now=this.now()){return 'gateway-controls:usage:'+dayAt(now)+':'+id;}
  daily(id,now=this.now()){return this.atomic(()=>this.dailyUnlocked(id,now));}
  dailyUnlocked(id,now=this.now()){
    const value=this.get(this.dailyKey(id,now))??{day:dayAt(now),requests:0,tokens:0,knownCredits:0,knownCreditsByPlatform:{},unknownTokenRequests:0,unknownCreditRequests:0,pending:[]};
    // Expired/abandoned reservations continue consuming their reserved budget;
    // dropping them on process restart would allow a budget reset. Concurrency
    // is bounded by the two-hour maximum lease, well beyond request deadlines.
    const expired=value.pending.filter(row=>row.expiresAt<=now);if(expired.length){value.pending=value.pending.filter(row=>row.expiresAt>now);value.tokens+=expired.reduce((n,row)=>n+row.tokens,0);value.unknownTokenRequests+=expired.length;value.unknownCreditRequests+=expired.length;this.set(this.dailyKey(id,now),value);}
    return value;
  }
  usageView(row){const value=this.daily(row.id),reservedTokens=value.pending.reduce((n,p)=>n+p.tokens,0),previousPending=(this.get(this.dailyKey(row.id,this.now()-86400000))?.pending??[]).filter(p=>p.expiresAt>this.now()).length;return {day:value.day,timeZone:'Asia/Shanghai',requests:value.requests,tokens:value.tokens,reservedTokens,knownCredits:value.knownCredits,wbCredits:value.knownCredits,knownCreditsByPlatform:value.knownCreditsByPlatform??{},creditUnit:'provider_native_units',creditLimitScope:'workbuddy_reported_credits',unknownTokenRequests:value.unknownTokenRequests,unknownCreditRequests:value.unknownCreditRequests,inFlight:value.pending.length+previousPending,knownCreditsOnly:true};}
  keys(){return this.keyRows().map(row=>keyView(row,this.usageView(row)));}
  createKey(input={}){return this.atomic(()=>this.createKeyUnlocked(input));}
  createKeyUnlocked(input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\x00-\x1f\x7f]/.test(input.name))throw new AppError('Name must be 1–80 visible characters',400,'invalid_client_name');
    const rows=this.keyRows();if(rows.filter(row=>!row.revokedAt).length>=100)throw new AppError('At most 100 active application keys',409,'client_key_limit');
    const allowedModels=input.allowedModels??[];if(!Array.isArray(allowedModels)||allowedModels.length>1000||allowedModels.some(id=>typeof id!=='string'||id.length<1||id.length>256)||new Set(allowedModels).size!==allowedModels.length)throw new AppError('Use distinct model route IDs',400,'invalid_client_models');
    const known=new Set((this.service.config?.value?.routes??[]).map(row=>row.id));if(allowedModels.some(id=>!known.has(id)))throw new AppError('Allowed model must refer to an existing gateway route',400,'invalid_client_models');
    const key='gwv_'+randomBytes(32).toString('base64url'),row={id:'app_'+randomUUID().replaceAll('-',''),name:input.name.trim(),createdAt:new Date(this.now()).toISOString(),revokedAt:null,allowedModels:[...allowedModels],dailyRequestLimit:limit(input.dailyRequestLimit,'dailyRequestLimit'),dailyTokenLimit:limit(input.dailyTokenLimit,'dailyTokenLimit'),dailyKnownCreditLimit:limit(input.dailyKnownCreditLimit,'dailyKnownCreditLimit'),maxConcurrency:limit(input.maxConcurrency,'maxConcurrency',1000),keyHash:digest(key)};
    this.set(KEYS,[...rows,row]);rememberSecret(key);return {key,client:keyView(row,this.usageView(row))};
  }
  revokeKey(id){return this.atomic(()=>{const rows=this.keyRows(),row=rows.find(row=>row.id===id);if(!row)throw new AppError('Unknown application key',404,'client_key_not_found');row.revokedAt??=new Date(this.now()).toISOString();this.set(KEYS,rows);for(const [key,value] of this.sessions)if(value.clientId===id)this.sessions.delete(key);return keyView(row,this.usageView(row));});}
  authenticate(token){if(typeof token!=='string'||!/^gwv_[A-Za-z0-9_-]{43}$/.test(token))return null;const incoming=Buffer.from(digest(token),'hex');const row=this.keyRows().find(row=>typeof row.keyHash==='string'&&row.keyHash.length===64&&timingSafeEqual(incoming,Buffer.from(row.keyHash,'hex')));if(!row||row.revokedAt)return null;rememberSecret(token);return keyView(row,this.usageView(row));}
  acquire(client,request){return this.atomic(()=>this.acquireUnlocked(client,request));}
  acquireUnlocked(client,request){
    const current=this.keyRows().find(row=>row.id===client?.id&&!row.revokedAt);if(!current)throw tokenError('Application key is revoked or missing','invalid_api_key',401);
    if(current.allowedModels.length&&!current.allowedModels.includes(request?.model))throw tokenError('Application key does not allow this model route','client_model_denied',403);
    const now=this.now(),dailyKey=this.dailyKey(current.id,now),daily=this.daily(current.id,now),reserved=daily.pending.reduce((n,row)=>n+row.tokens,0);
    // UTF-8 serialized request bytes are a conservative reservation, not a
    // tokenizer claim. Unknown final usage remains reserved and is labelled.
    const output=request?.max_tokens??request?.max_completion_tokens??4096,estimatedTokens=Buffer.byteLength(JSON.stringify(request??{}),'utf8')+(Number.isSafeInteger(output)&&output>0?output:4096);
    const previousPending=(this.get(this.dailyKey(current.id,now-86400000))?.pending??[]).filter(row=>row.expiresAt>now).length;
    if(current.maxConcurrency&&daily.pending.length+previousPending>=current.maxConcurrency)throw tokenError('Application concurrency limit reached','client_concurrency_exceeded');
    if(current.dailyRequestLimit&&daily.requests>=current.dailyRequestLimit)throw tokenError('Application daily request limit reached','client_request_budget_exceeded');
    if(current.dailyTokenLimit&&daily.tokens+reserved+estimatedTokens>current.dailyTokenLimit)throw tokenError('Application daily token budget cannot admit this request reservation','client_token_budget_exceeded');
    const primary=this.service.config.value.routes?.find(route=>route.id===request?.model)?.targets?.[0],isWorkBuddy=target=>this.service.config.value.upstreams?.some(upstream=>upstream.id===target?.upstreamId&&upstream.kind==='workbuddy'),creditGuard=target=>{if(isWorkBuddy(target)&&current.dailyKnownCreditLimit&&(this.get(dailyKey)?.knownCredits??0)>=current.dailyKnownCreditLimit)throw tokenError('Application daily reported WorkBuddy credit limit reached; other native units are separate','client_credit_budget_exceeded');};
    creditGuard(primary);
    const reservation={id:randomUUID(),tokens:estimatedTokens,expiresAt:now+2*3600000};daily.requests++;daily.pending.push(reservation);this.set(dailyKey,daily);
    let finished=false;const observations=new Map();
    return {clientId:current.id,source:'app:'+current.id,checkTarget:target=>this.atomic(()=>creditGuard(target)),observe(row){if(finished||!row||!row.dispatched)return;observations.set(String(row.requestId??'')+'\0'+String(row.attempt??''),{tokens:finite(row.totalTokens)?row.totalTokens:null,credits:finite(row.credits)?row.credits:null,platform:typeof row.platform==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(row.platform)?row.platform:'unknown'});},finish:({usage,success}={})=>this.atomic(()=>{
      if(finished)return;const stored=this.get(dailyKey);if(!stored)throw new AppError('Application budget state missing',500,'client_budget_storage_error');
      const pending=stored.pending.find(row=>row.id===reservation.id);if(!pending){finished=true;return;}
      const rows=[...observations.values()],tokens=usage?usage.totalTokens:rows.length?rows.every(row=>row.tokens!==null)?rows.reduce((n,row)=>n+row.tokens,0):null:0,credits=usage?usage.credits:rows.length?rows.every(row=>row.credits!==null)?rows.reduce((n,row)=>n+row.credits,0):null:0;
      const charges=usage?[{platform:typeof usage.platform==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(usage.platform)?usage.platform:'unknown',credits:finite(usage.credits)?usage.credits:null}]:rows;
      stored.knownCreditsByPlatform??={};for(const charge of charges)if(finite(charge.credits)){stored.knownCreditsByPlatform[charge.platform]=(stored.knownCreditsByPlatform[charge.platform]??0)+charge.credits;if(charge.platform==='workbuddy')stored.knownCredits+=charge.credits;}
      stored.pending=stored.pending.filter(row=>row.id!==reservation.id);stored.tokens+=finite(tokens)?tokens:Math.max(pending.tokens,rows.reduce((n,row)=>n+(row.tokens??0),0));stored.unknownTokenRequests+=finite(tokens)?0:1;stored.unknownCreditRequests+=finite(credits)?0:1;
      this.set(dailyKey,stored);finished=true;
    })};
  }
  health({fresh=false}={}){
    const now=this.now();if(!fresh&&this.healthCache&&now-this.healthCache.at<2000)return clone(this.healthCache.value);
    const groups=new Map(),from=new Date(now-86400000).toISOString();let cursor=0,scanned=0,truncated=false;
    const groupFor=target=>{const key=targetId(target);if(!groups.has(key))groups.set(key,{upstreamId:target.upstreamId,model:target.model,accountId:target.accountId??this.service.config.value.upstreams?.find(u=>u.id===target.upstreamId)?.accountId??'',samples:0,completed:0,inFlight:0,ttft:[],durations:[]});return groups.get(key);};
    for(const route of this.service.config.value.routes??[])if(route.enabled!==false)for(const target of route.targets??[])groupFor(target);
    if(typeof this.ledger?.usage==='function')for(let i=0;i<10;i++){
      const page=this.ledger.usage({from,limit:500,beforeId:cursor,includeTotal:false});for(const row of page.records??[]){scanned++;if((!row.dispatched&&row.status!=='running')||row.rowType==='request_outcome'||!row.upstreamId||!row.model||!['running','completed','failed','cancelled'].includes(row.status))continue;const group=groupFor(row);if(row.status==='running'){group.inFlight++;continue;}group.samples++;group.completed+=Number(row.status==='completed');if(finite(row.firstTokenMs))group.ttft.push(row.firstTokenMs);if(finite(row.durationMs))group.durations.push(row.durationMs);}
      if(!page.nextBeforeId)break;cursor=page.nextBeforeId;if(i===9)truncated=true;
    }
    const quantile=(values,p)=>{values.sort((a,b)=>a-b);return values.length?values[Math.max(0,Math.ceil(values.length*p)-1)]:null;};
    const rows=[...groups.values()].map(group=>{const cooldown=this.service.router?.relay?.cooldown?.(group);return {upstreamId:group.upstreamId,model:group.model,accountId:group.accountId,samples:group.samples,inFlight:group.inFlight,successRate:group.samples?group.completed/group.samples:null,ttftMs:quantile(group.ttft,.5),p95Ms:quantile(group.durations,.95),cooldownUntil:cooldown?.until??null,status:cooldown?'cooldown':!group.samples?'unknown':group.completed===group.samples?'healthy':'degraded'};});
    const value={windowHours:24,sampleLimit:5000,scanned,truncated,observedAt:new Date(now).toISOString(),rows,note:'Observed gateway calls only; no active generation probes; missing samples are unknown.'};this.healthCache={at:now,value};return clone(value);
  }
  enabled(){const settings=this.settings();return settings.strategy!=='configured'||settings.affinityEnabled;}
  scope(route,target){const value=this.service.config.value,u=value.upstreams?.find(row=>row.id===target?.upstreamId),a=value.accounts?.find(row=>row.id===u?.accountId);return u?.kind==='workbuddy'?'workbuddy:'+workBuddyEdition(a):'other';}
  sessionKey(route,clientId,sessionId){return safeId(clientId)&&safeId(sessionId)?digest(clientId+'\0'+route.id+'\0'+this.scope(route,route.targets?.[0])+'\0'+route.targets?.[0]?.model+'\0'+sessionId):null;}
  targetVersion(target){const config=this.service.config.value,u=config.upstreams?.find(row=>row.id===target.upstreamId),account=config.accounts?.find(row=>row.id===u?.accountId);return digest(JSON.stringify([u,account]));}
  pruneSessions(){const now=this.now(),config=this.service.config.value,clients=this.keyRows();for(const [key,value] of this.sessions){const target={upstreamId:value.upstreamId,model:value.model},upstream=config.upstreams?.find(row=>row.id===target.upstreamId),account=config.accounts?.find(row=>row.id===upstream?.accountId);if(value.until<=now||!config.routes?.some(row=>row.id===value.routeId&&row.enabled!==false)||!upstream||upstream.enabled===false||account?.enabled===false||account?.inferenceEnabled===false||value.version!==this.targetVersion(target)||value.clientId.startsWith('app_')&&!clients.some(row=>row.id===value.clientId&&!row.revokedAt))this.sessions.delete(key);}while(this.sessions.size>10000)this.sessions.delete(this.sessions.keys().next().value);}
  orderTargets(route,targets,{clientId,sessionId,eligible=()=>true,sameModel=false}={}){
    const settings=this.settings();if(!this.enabled())return targets;
    this.pruneSessions();const key=this.sessionKey(route,clientId,sessionId),binding=key&&settings.affinityEnabled?this.sessions.get(key):null;
    const primaryFamily=modelFamily(route.targets?.[0]?.model),rankable=target=>this.scope(route,target)===this.scope(route,route.targets?.[0])&&(sameModel||modelFamily(target.model)===primaryFamily);
    const valid=target=>{const config=this.service.config.value,u=config.upstreams?.find(row=>row.id===target.upstreamId),a=config.accounts?.find(row=>row.id===u?.accountId);return !!u&&u.enabled!==false&&a?.enabled!==false&&(u.kind!=='workbuddy'||a?.inferenceEnabled!==false)&&!this.service.router?.relay?.cooldown?.(target)&&eligible(target);};
    const affinity=binding&&targets.find(target=>targetId(target)===binding.targetId&&binding.version===this.targetVersion(target)&&rankable(target)&&valid(target));if(binding&&!affinity)this.sessions.delete(key);
    const health=settings.strategy==='fast'||settings.strategy==='stable'?new Map(this.health().rows.map(row=>[targetId(row),row])):new Map();
    const score=target=>{const row=health.get(targetId(target));if(settings.strategy==='fast')return row&&row.samples>=2&&row.successRate>=.5&&finite(row.ttftMs)?row.ttftMs:Infinity;if(settings.strategy==='stable')return row&&row.samples>=2?1-row.successRate:Infinity;if(settings.strategy==='expiry'){const u=this.service.config.value.upstreams?.find(row=>row.id===target.upstreamId),account=this.service.config.value.accounts?.find(a=>a.id===u?.accountId),balance=account?cachedAccountBalance(this.service,account):undefined,age=this.now()-Date.parse(balance?.checkedAt);if(!balance||balance.error||balance.stale||balance.complete===false||!Number.isFinite(age)||age<0||age>300000)return Infinity;const dates=[balance,...(balance.parts?.length?balance.parts:balance.packages??[])].filter(part=>(part.value??part.remaining??part.remain)>0).map(part=>Number.isFinite(part.expiresAtMs)?part.expiresAtMs:Date.parse(part.expiresAt)).filter(date=>Number.isFinite(date)&&date>this.now());return dates.length?Math.min(...dates):Infinity;}return 0;};
    const candidates=targets.map((target,index)=>({target,index,score:score(target)})).filter(row=>rankable(row.target)&&valid(row.target));candidates.sort((a,b)=>Number(b.target===affinity)-Number(a.target===affinity)||(a.score===b.score?0:a.score-b.score)||a.index-b.index);
    let i=0;const ids=new Set(candidates.map(row=>targetId(row.target))),ordered=targets.map(target=>ids.has(targetId(target))?candidates[i++].target:target),first=ordered[0],top=candidates[0];
    this.decisions.set(route.id,{routeId:route.id,strategy:settings.strategy,upstreamId:first?.upstreamId??null,model:first?.model??null,reasonCode:affinity&&first===affinity?'session_affinity':top?.target===first&&Number.isFinite(top.score)&&settings.strategy!=='configured'?{fast:'lowest_observed_ttft',stable:'highest_observed_success',expiry:'earliest_known_expiry'}[settings.strategy]:'configured_order_no_better_evidence',considered:candidates.length,observedAt:new Date(this.now()).toISOString()});while(this.decisions.size>100)this.decisions.delete(this.decisions.keys().next().value);return ordered;
  }
  success(route,target,{clientId,sessionId}={}){const settings=this.settings(),key=this.sessionKey(route,clientId,sessionId);if(!settings.affinityEnabled||!key||this.scope(route,target)!==this.scope(route,route.targets?.[0]))return;this.pruneSessions();this.sessions.set(key,{clientId,routeId:route.id,upstreamId:target.upstreamId,model:target.model,targetId:targetId(target),version:this.targetVersion(target),until:this.now()+settings.affinityTtlMinutes*60000});}
  report(){this.pruneSessions();const health=this.health();return {settings:this.settings(),health:{...health,active:health.rows.reduce((n,row)=>n+row.inFlight,0),cooling:health.rows.filter(row=>row.status==='cooldown').length},sessions:{active:this.sessions.size,ttlMinutes:this.settings().affinityTtlMinutes,bindings:[...this.sessions.entries()].map(([key,{clientId,routeId,upstreamId,model,until}])=>({sessionRef:key.slice(0,12),clientId,routeId,upstreamId,model,expiresAt:new Date(until).toISOString(),reason:'completed_request'}))},decisions:[...this.decisions.values()],clients:this.keys()};}
}
