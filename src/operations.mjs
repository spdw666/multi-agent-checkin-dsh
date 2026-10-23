import {createHash} from 'node:crypto';
import {AppError,redact} from './util.mjs';
import {cachedAccountBalance} from './balances.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {isWorkBuddyBlocked} from './workbuddy-status.mjs';

const SETTINGS='operations-settings',NOTICES='operations-notifications';
const defaults=Object.freeze({notificationsEnabled:false});
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const stamp=n=>Number.isFinite(n)?new Date(n).toISOString():null;
const clean=s=>redact(String(s??'')).slice(0,180);
export function operationsSettings(service){return {...defaults,...service.ledger?.get(SETTINGS)};}
export function saveOperationsSettings(service,body){return service.controls.atomic(()=>saveSettingsAtomic(service,body));}
function saveSettingsAtomic(service,body){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError('设置需要对象',400,'invalid_operations_settings');
  const {notificationsEnabled,...control}=body;
  if(notificationsEnabled!==undefined&&typeof notificationsEnabled!=='boolean')throw new AppError('通知开关需要布尔值',400,'invalid_operations_settings');
  // Validate controls first: invalid combined forms cannot partially save notification settings.
  if(Object.keys(control).length)service.controls.saveSettings(control);
  if(notificationsEnabled!==undefined)service.ledger.set(SETTINGS,{notificationsEnabled});
  return {saved:true,settings:{...service.controls.settings(),...operationsSettings(service)}};
}

// Only already-observed official package metadata. No login/refresh/claim/model calls.
export function expiryCalendar(service,{now=Date.now(),maxAgeMs=3600000}={}){
  const items=[],unknownAccounts=[];
  for(const account of service.config.value.accounts??[]){
    if(account.platform!=='workbuddy')continue;
    const label=clean(account.label??account.id),balance=cachedAccountBalance(service,account),checked=Date.parse(balance?.checkedAt??'');
    if(!balance){unknownAccounts.push({accountId:account.id,label,reason:'balance_not_observed'});continue;}
    const stale=balance.stale===true||!!balance.error||!Number.isFinite(checked)||now-checked>maxAgeMs||checked>now+60000;
    const blocked=isWorkBuddyBlocked(service,account.id);
    const cooldown=service.ledger?.get('wb-pool-cooldown:'+account.id)?.until??0;
    const enabled=account.enabled!==false&&account.inferenceEnabled!==false;
    const eligible=enabled&&!blocked&&cooldown<=now&&!stale&&balance.complete!==false;
    let unknown=false;
    for(const [index,p] of (balance.packages??[]).entries()){
      const remaining=p.remaining??p.remain??p.value,expiry=p.expiresAtMs??Date.parse(p.expiresAt??'');
      if(!finite(remaining)){unknown=true;continue;}if(remaining<=0)continue;
      if(!Number.isFinite(expiry)){unknown=true;continue;}if(expiry<=now)continue;
      items.push({accountId:account.id,label,edition:workBuddyEdition(account),packageId:p.id??String(index),packageName:clean(p.packageName??p.name??'积分包'),remaining,expiresAt:stamp(expiry),stale:stale||balance.complete===false,checkedAt:stamp(checked),eligible,reason:balance.complete===false?'package_list_incomplete':stale?'balance_stale':!enabled?'account_disabled':blocked?'account_banned':cooldown>now?'account_cooldown':'observed_package'});
    }
    if(unknown||stale||balance.complete===false)unknownAccounts.push({accountId:account.id,label,reason:stale?'balance_stale':balance.complete===false?'package_list_incomplete':'package_expiry_or_balance_unknown'});
  }
  items.sort((a,b)=>a.expiresAt.localeCompare(b.expiresAt)||a.accountId.localeCompare(b.accountId));
  const windows=[1,3,7].map(days=>{const rows=items.filter(r=>!r.stale&&Date.parse(r.expiresAt)<=now+days*86400000);return {days,credits:rows.reduce((n,r)=>n+r.remaining,0),packages:rows.length,accounts:new Set(rows.map(r=>r.accountId)).size};});
  const first=items.find(r=>r.eligible),recommendation=first?{accountId:first.accountId,label:first.label,edition:first.edition,remaining:items.filter(r=>r.accountId===first.accountId&&r.eligible).reduce((n,r)=>n+r.remaining,0),expiresAt:first.expiresAt,reason:'优先使用最近到期的已核验积分；实际调用仍复核路由能力与资格'}:null;
  return {scope:'workbuddy_observed_packages',checkedAt:stamp(now),freshnessMinutes:maxAgeMs/60000,windows,items,unknownAccounts,recommendation,generationRequests:0};
}

export function syncOperationsAlerts(service,options={}){return service.controls?.atomic?service.controls.atomic(()=>collectAlerts(service,options)):collectAlerts(service,options);}
function collectAlerts(service,{now=Date.now(),expiry=expiryCalendar(service,{now}),health}={}){
  if(!service.ledger)return [];
  const active=new Map(),add=(key,category,title,message,fingerprint,severity='warning',href='operations')=>active.set(key,{category,title:clean(title),message:clean(message),fingerprint:String(fingerprint),severity,href});
  const updates=service.ledger.get('client-updates');
  for(const row of updates?.targets??[])if(row.status==='error')add('update:'+row.id,'software_update',row.name+' 更新检查失败',row.errorLabel??'更新源读取失败，请重试失败项',[row.checkedAt,row.errorCode??'error'].join(':'),'warning','updates');
  const receipt=service.ledger.get('schedule-last');
  for(const row of receipt?.tasks??[])if(['failed','error','rejected','action_required','not_available'].includes(row.status)){
    const a=service.config.value.accounts.find(a=>a.id===row.accountId);if(!a)continue;
    add('claim:'+row.accountId+':'+row.task,'checkin',clean(a.label??a.id)+' 自动任务需要处理',clean(row.task)+' · '+clean(row.reason??row.status),[receipt.at,row.attempt,row.status].join(':'),'warning','records');
  }
  for(const a of service.config.value.accounts??[]){const b=cachedAccountBalance(service,a);if(b?.error)add('balance:'+a.id,'account',clean(a.label??a.id)+' 余额核验异常',b.error.authRejected?'登录状态被官方拒绝，请重新读取登录态':'余额读取失败，历史值仅供参考',[b.lastFailureAt??b.checkedAt,b.error.code].join(':'),'warning','accounts');}
  for(const row of health??[]){if((row.samples??0)>=3&&row.successRate<0.25)add('route:'+row.upstreamId+':'+row.model,'routing','模型路由连续异常',clean(row.model)+' · 最近成功率低于25%',String(row.status)+':'+String(Math.floor((row.samples??0)/5)),'warning','routes');}
  for(const item of expiry.items.filter(r=>r.eligible&&Date.parse(r.expiresAt)<=now+86400000))add('expiry:'+item.accountId+':'+item.packageId,'expiry',item.label+' 积分即将到期',item.packageName+' · '+item.remaining+' 积分 · '+item.expiresAt,item.expiresAt+':'+item.remaining,'warning','wb');
  const previous=service.ledger.get(NOTICES)??[],rows=previous.map(r=>({...r}));let changed=false;
  // Stable overflow selection: omitted incidents must not regenerate on every poll.
  const selected=new Set([...active.keys()].sort().slice(0,200));
  for(const [key,event]of active){if(!selected.has(key))continue;let old=rows.find(r=>r.eventKey===key);if(!old){old={id:createHash('sha256').update(key+':'+now).digest('hex').slice(0,24),eventKey:key,createdAt:stamp(now),count:0,read:false};rows.unshift(old);changed=true;}
    if(old.fingerprint!==event.fingerprint||old.recovered){Object.assign(old,event,{lastSeenAt:stamp(now),count:old.count+1,read:false,recovered:false});changed=true;}
  }
  for(const row of rows)if(!active.has(row.eventKey)&&!row.recovered){row.recovered=true;row.recoveredAt=stamp(now);row.read=true;changed=true;}
  const selectedRows=rows.filter(r=>selected.has(r.eventKey)),history=rows.filter(r=>!active.has(r.eventKey));
  const bounded=[...selectedRows,...history].slice(0,200);if(changed||bounded.length!==rows.length)service.ledger.set(NOTICES,bounded);
  return bounded.map(({eventKey,fingerprint,...row})=>row);
}
export function readNotification(service,id){return service.controls?.atomic?service.controls.atomic(()=>markRead(service,id)):markRead(service,id);}
function markRead(service,id){
  const rows=service.ledger.get(NOTICES)??[],row=rows.find(r=>r.id===id);
  if(!row)throw new AppError('通知不存在',404,'notification_not_found');
  row.read=true;service.ledger.set(NOTICES,rows);return {read:true,id};
}
export function operationsReport(service,{now=Date.now()}={}){
  const report=service.controls?.report()??{},health=(report.health?.rows??[]).map(row=>{const a=service.config.value.accounts.find(a=>a.id===row.accountId),u=service.config.value.upstreams.find(u=>u.id===row.upstreamId),decision=report.decisions?.find(d=>d.upstreamId===row.upstreamId&&d.model===row.model),reasons={session_affinity:'同会话复用上次成功候选',lowest_observed_ttft:'最近观测首字更快',highest_observed_success:'最近观测成功率更高',earliest_known_expiry:'已核验权益更早到期',configured_order_no_better_evidence:'沿用配置顺序，尚无更优证据'};return {...row,label:clean(a?.label??a?.id??row.upstreamId),platform:a?.platform??u?.kind??'unknown',firstTokenMs:row.ttftMs??null,active:row.inFlight??row.active??0,reason:reasons[decision?.reasonCode]??row.reason??(row.samples?'最近实际调用':'尚无调用样本')};});
  const expiry=expiryCalendar(service,{now}),notifications=syncOperationsAlerts(service,{now,expiry,health});
  return {checkedAt:stamp(now),settings:{...service.controls?.settings(),...operationsSettings(service)},health,healthWindow:report.health?{windowHours:report.health.windowHours,sampleLimit:report.health.sampleLimit}:null,routingDecisions:report.decisions??[],expiry,notifications,keys:service.controls?.keys()??[],sessions:report.sessions?.bindings??[],sessionSummary:report.sessions??{},routes:(service.config.value.routes??[]).filter(r=>r.enabled!==false).map(r=>({id:r.id,name:r.name??r.id})),generationRequests:0};
}
