// Independent implementation; protocols reviewed against MIT workbuddy-switch
// 22b318c1f44b335c2222e444abcc2d0f74e160f7 and workbuddy2api-panel
// 6b31db6d045e985042620c819c3a938002e7b0b1. See workbuddy-reference-license.mjs.
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError,atomicJson,errorView} from './util.mjs';
import {boundedBalanceRead,normalizeBalance} from './balances.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {mergeWorkBuddySessions,workBuddySessionCapabilities} from './workbuddy-sessions.mjs';
import {runWorkBuddyTasks,queryWorkBuddyTasks,workBuddyTaskSnapshot,workBuddyReceiptView} from './workbuddy-tasks.mjs';
import {prepareWorkBuddyClientSwitch} from './workbuddy-client.mjs';
import {readWorkBuddyIdentity,workBuddyBan,workBuddyFailure,isWorkBuddyBlocked} from './workbuddy-status.mjs';
import {normalizeWorkBuddyPackage} from './workbuddy-resources.mjs';
import {workBuddyParticipation} from './workbuddy-pool.mjs';

const defaults={autoMigrateSessions:false,autoTasks:false};
export const workBuddySettings=service=>({...defaults,...service.config.value.workbuddy});
export function currentWorkBuddyAccount(service){
  const saved=service.ledger?.get('wb-management-current')?.accountId;if(saved&&service.config.value.accounts.some(a=>a.id===saved&&a.platform==='workbuddy'&&a.enabled!==false)&&!isWorkBuddyBlocked(service,saved))return saved;
  for(const route of service.config.value.routes){if(route.enabled===false)continue;const up=service.config.value.upstreams.find(u=>u.id===route.targets[0]?.upstreamId&&u.kind==='workbuddy'&&u.enabled!==false);if(!up)continue;const chosen=service.router.pool?.candidates(route,{ignoreCooldown:true})?.[0]?.accountId??up.accountId;if(!isWorkBuddyBlocked(service,chosen))return chosen;}return null;
}
const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
export function syncWorkBuddyPools(value,{routeIds}={}) {
  const selected=routeIds?new Set(routeIds):null;
  for(const route of value.routes){if(route.enabled===false||selected&&!selected.has(route.id))continue;const primary=value.upstreams.find(u=>u.id===route.targets[0]?.upstreamId);if(primary?.kind!=='workbuddy')continue;
    // Explicit off always wins: a switched-off pool is a deliberate stop, not a
    // stale default. Everything else follows additions automatically, or the
    // user re-adds every new account to every model by hand.
    if(route.accountPool?.enabled===false)continue;
    // The primary remains the edition/model anchor while disabled. Enabled
    // standbys still serve this route; do not freeze additions to their pool
    // or change the primary/account enable switches to make it participate.
    const primaryAccount=(value.accounts??[]).find(a=>a.id===primary.accountId);if(!primaryAccount)continue;const edition=workBuddyEdition(primaryAccount);
    const ids=(value.accounts??[]).filter(a=>a.platform==='workbuddy'&&a.enabled!==false&&workBuddyEdition(a)===edition&&value.upstreams.some(u=>u.kind==='workbuddy'&&u.accountId===a.id&&u.enabled!==false)).map(a=>a.id);
    if(!ids.length)continue;
    // Append newcomers after the existing members so a hand-picked priority
    // order survives. Ineligible leftovers stay listed; candidates() filters
    // them, and a re-enabled account must not silently lose its place.
    const prior=route.accountPool?.accountIds??[],merged=[...new Set([...prior,...ids])];
    route.accountPool={...route.accountPool,enabled:true,autoManaged:true,accountIds:merged,cooldownSeconds:route.accountPool?.cooldownSeconds??3600};
  }return value;
}
export function workBuddyModelGroups(service) {
  const groups=new Map();for(const route of service.config.value.routes){if(route.enabled===false)continue;const u=service.config.value.upstreams.find(u=>u.id===route.targets[0]?.upstreamId);if(u?.kind!=='workbuddy')continue;
    const edition=workBuddyEdition(service.config.value.accounts.find(a=>a.id===u.accountId)),exactModel=route.targets[0].model,key=edition+'\0'+exactModel;
    if(!groups.has(key))groups.set(key,{edition,exactModel,model:exactModel,name:route.name??exactModel,routeId:route.id,routeIds:[],accountIds:[],configuredAccountIds:[],routeParticipation:[],poolEnabled:false,availabilityBasis:'runtime_pool_candidates',generationVerified:false,candidateMeaning:'参与账号表示当前路由候选；实际调用仍逐号核对官方目录与请求能力，不代表已完成生成验证'});
    const group=groups.get(key),participation=workBuddyParticipation(service,route);group.routeIds.push(route.id);group.routeParticipation.push(participation);group.poolEnabled||=route.accountPool?.enabled===true;
    for(const id of participation.accountIds)if(!group.accountIds.includes(id))group.accountIds.push(id);
    for(const id of participation.configuredAccountIds)if(!group.configuredAccountIds.includes(id))group.configuredAccountIds.push(id);
  }return [...groups.values()].map(group=>({...group,availableCount:group.accountIds.length,configuredCount:group.configuredAccountIds.length,excludedAccounts:group.routeParticipation.flatMap(r=>r.excludedAccounts).filter((r,i,list)=>!group.accountIds.includes(r.accountId)&&list.findIndex(x=>x.accountId===r.accountId&&x.reason===r.reason)===i)}));
}
async function refreshBalance(service,account) {
  service.balanceCache??=new Map();try{const health=await boundedBalanceRead(()=>service.platforms.health(account.id),service.balanceTimeoutMs??25000),normalized=normalizeBalance('workbuddy',health);
    const packages=(health.credits?.packages??[]).map((p,i)=>normalizeWorkBuddyPackage(p,i)),active=packages.filter(p=>p.status!=='expired'),complete=health.credits?.complete!==false,total=complete&&active.every(p=>number(p.total)!==null)?active.reduce((n,p)=>n+p.total,0):null,checkedAt=new Date().toISOString();
    const row={accountId:account.id,platform:'workbuddy',edition:account.edition,label:account.label??account.id,enabled:account.enabled!==false,...normalized,value:complete?normalized.value:null,total,packages,complete,queryScope:health.credits?.queryScope??null,packageCount:packages.length,consumed:total!==null&&normalized.value!==null?Math.max(0,total-normalized.value):null,dailyCheckin:{...health.checkin,status:health.checkinError?'check_failed':health.checkin?.todayCheckedIn===true?'claimed':health.checkin?.todayCheckedIn===false?'not_claimed':'unknown',checkedAt,...(health.checkinError?{error:health.checkinError}:{})},checkedAt,lastSuccessAt:checkedAt,lastFailureAt:null,stale:false,error:null};
    service.balanceCache.set(account.id,row);service.ledger?.set('wb-management-balance:'+account.id,row);service.ledger?.set('wb-management-official-status:'+account.id,{status:'clear',source:'official_response',reason:null,checkedAt,httpStatus:200,upstreamCode:0});if(row.value>0&&!isWorkBuddyBlocked(service,account.id))service.router.pool?.revive(account.id);return row;
  }catch(e){const old=service.balanceCache.get(account.id)??service.ledger?.get('wb-management-balance:'+account.id),error=workBuddyFailure(e),checkedAt=new Date().toISOString(),row={...old,stale:!!old,error,lastFailureAt:checkedAt};service.balanceCache.set(account.id,row);service.ledger?.set('wb-management-balance:'+account.id,row);if(error.banned)service.ledger?.set('wb-management-official-status:'+account.id,{status:'banned',source:'official_response',reason:error.message,checkedAt,httpStatus:error.httpStatus,upstreamCode:error.upstreamCode});return row;}
}
const detailFlights=new WeakMap();
async function refreshWorkBuddyDetails(service,account,{includeTasks=false}={}){let flights=detailFlights.get(service);if(!flights){flights=new Map();detailFlights.set(service,flights);}const key=account.id+':'+includeTasks;if(flights.has(key))return flights.get(key);const flight=(async()=>{const timeout=service.workbuddyDetailsTimeoutMs??service.balanceTimeoutMs??25000,signal=AbortSignal.timeout(timeout);await Promise.allSettled([refreshBalance(service,account),...(includeTasks?[boundedBalanceRead(()=>queryWorkBuddyTasks(service,{accountId:account.id,signal}),timeout)]:[])]);})();flights.set(key,flight);try{await flight;}finally{if(flights.get(key)===flight)flights.delete(key);}}
async function mapBounded(list,work,limit=3){let next=0;const result=new Array(list.length);await Promise.all(Array.from({length:Math.min(limit,list.length)},async()=>{for(;;){const i=next++;if(i>=list.length)return;result[i]=await work(list[i],i);}}));return result;}
export async function workBuddySummary(service,{refresh=false,accountId,includeTasks=false}={}) {
  const list=service.config.value.accounts.filter(a=>a.platform==='workbuddy'),selected=currentWorkBuddyAccount(service);
  // A cache read only opens saved JSON metadata. No credential resolution,
  // token rotation, balance request, task accept or reward claim occurs here.
  let metadata=await mapBounded(list,a=>readWorkBuddyIdentity(service,a));
  if(refresh)await mapBounded(list.filter(a=>(!accountId||accountId===a.id)&&a.enabled!==false),a=>service.workbuddyExecutorController?.signal.aborted?undefined:refreshWorkBuddyDetails(service,a,{includeTasks}));
  if(refresh)metadata=await mapBounded(list,a=>readWorkBuddyIdentity(service,a));
  const rows=list.map((account,i)=>{const balance=service.balanceCache?.get(account.id)??service.ledger?.get('wb-management-balance:'+account.id)??{},taskCache=workBuddyTaskSnapshot(service,account.id),cooldown=service.router.pool?.get('wb-pool-cooldown:'+account.id)??{},remaining=number(balance.value),total=number(balance.total),ban=workBuddyBan(service,account.id,balance),credentialStatus=ban.status==='banned'?'banned':balance.error?balance.error.authRejected||[401,403].includes(balance.error.httpStatus??balance.error.status)?'auth_rejected':'check_failed':balance.lastSuccessAt||balance.checkedAt?'authenticated':metadata[i].credential.status==='missing'?'missing':'not_checked';
    const packages=balance.packages??(balance.parts??[]).map((p,j)=>normalizeWorkBuddyPackage({...p,remain:p.value,size:p.total},j)),consumed=number(balance.consumed)??(remaining!==null&&total!==null?Math.max(0,total-remaining):null),tasks={...taskCache,items:taskCache.tasks??[],receipts:(service.ledger?.get('wb-management-task-receipts:'+account.id)??taskCache.receipts??[]).map(workBuddyReceiptView)};
    return {accountId:account.id,id:account.id,label:account.label??account.id,notes:account.notes??'',...metadata[i],uid:metadata[i].identity.uid,nickname:metadata[i].identity.nickname,email:metadata[i].identity.email,region:metadata[i].edition,edition:workBuddyEdition(account),enabled:account.enabled!==false,inferenceEnabled:account.inferenceEnabled!==false,current:selected===account.id&&ban.status!=='banned',remaining,total,consumed,checkedAt:balance.checkedAt??null,lastSuccessAt:balance.lastSuccessAt??balance.checkedAt??null,lastFailureAt:balance.lastFailureAt??null,stale:balance.stale===true,usageStatus:ban.status==='banned'?'banned':account.inferenceEnabled===false?'inference_disabled':balance.error?'error':remaining===null?'unknown':remaining===0?'exhausted':'available',credentialStatus,credential:{...metadata[i].credential,status:credentialStatus,checkedAt:balance.lastFailureAt??balance.checkedAt??null},ban,balance:{remaining,total,consumed,packages,complete:balance.complete??null,queryScope:balance.queryScope??null,packageCount:packages.length,checkedAt:balance.checkedAt??null,lastSuccessAt:balance.lastSuccessAt??balance.checkedAt??null,lastFailureAt:balance.lastFailureAt??null,error:balance.error??null,stale:balance.stale===true},tasks,dailyCheckin:balance.dailyCheckin??{status:'unknown',checkedAt:null,todayCheckedIn:null},cooldown:cooldown.until>Date.now()?{until:cooldown.until,reason:cooldown.reason}:null,...(balance.error?{error:balance.error}:{})};
  });
  const enabled=rows.filter(a=>a.enabled&&a.ban.status!=='banned'),inference=enabled.filter(a=>a.inferenceEnabled),inferenceSum=field=>inference.length?inference.every(a=>a[field]!==null)?inference.reduce((n,a)=>n+a[field],0):null:0,sum=field=>enabled.length&&enabled.every(a=>a[field]!==null)?enabled.reduce((n,a)=>n+a[field],0):null,knownSum=field=>enabled.filter(a=>a[field]!==null).reduce((n,a)=>n+a[field],0);
  return {accounts:rows,currentAccountId:rows.find(a=>a.current)?.accountId??null,totals:{balanceScope:'enabled_non_banned_accounts_including_inference_disabled',inferenceEnabledAccounts:inference.length,inferenceDisabledAccounts:rows.filter(a=>!a.inferenceEnabled).length,inferenceRemaining:inferenceSum('remaining'),inferenceTotal:inferenceSum('total'),remaining:sum('remaining'),total:sum('total'),consumed:sum('consumed'),knownRemaining:knownSum('remaining'),knownTotal:knownSum('total'),knownAccounts:enabled.filter(a=>a.remaining!==null).length,accountCount:enabled.length,allAccounts:rows.length,bannedAccounts:rows.filter(a=>a.ban.status==='banned').length,disabledAccounts:rows.filter(a=>!a.enabled).length,unknownAccounts:enabled.filter(a=>a.remaining===null).length},models:workBuddyModelGroups(service),settings:workBuddySettings(service),sessionCapabilities:await workBuddySessionCapabilities(service),refreshed:refresh};
}
export async function workBuddyAccountDetails(service,accountId,{refresh=false}={}){if(!service.config.value.accounts.some(a=>a.platform==='workbuddy'&&a.id===accountId))throw new AppError('WB 帐号不存在',404,'account_not_found');const summary=await workBuddySummary(service,{refresh,accountId,includeTasks:true});return {account:summary.accounts.find(a=>a.accountId===accountId),refreshed:refresh};}
// The HTTP handler owns withConfigMutation. Read the latest queued value here;
// never normalize pools or mutate the general account/task enable switches.
export async function setWorkBuddyInference(service,accountId,body) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.enabled!=='boolean')throw new AppError('WB 积分调用开关需要 enabled=true/false',400,'invalid_workbuddy_inference');
  if(typeof service.config.load==='function')await service.config.load();
  const value=structuredClone(service.config.value),account=value.accounts.find(a=>a.id===accountId&&a.platform==='workbuddy');
  if(!account)throw new AppError('WB 帐号不存在',404,'account_not_found');
  account.inferenceEnabled=body.enabled;await service.config.save(value);
  return {saved:true,accountId,inferenceEnabled:account.inferenceEnabled,automaticCheckinUnchanged:true,automaticTasksUnchanged:true};
}
export async function saveWorkBuddySettings(service,body) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['autoMigrateSessions','autoTasks'].includes(k))||Object.values(body).some(v=>typeof v!=='boolean'))throw new AppError('WorkBuddy 设置需要布尔开关',400,'invalid_workbuddy_settings');
  const value=structuredClone(service.config.value);value.workbuddy={...workBuddySettings(service),...body};syncWorkBuddyPools(value);await service.config.save(value);if(value.workbuddy.autoTasks===false)service.workbuddyAutomaticTaskController?.abort(new AppError('WB 自动任务已暂停',499,'wb_tasks_cancelled'));return {saved:true,settings:workBuddySettings(service)};
}
export async function switchWorkBuddyAccount(service,accountId,{migrate,switchClient=false}={}) {
  if(typeof switchClient!=='boolean'||migrate!==undefined&&typeof migrate!=='boolean')throw new AppError('WB 切号参数需要布尔开关',400,'invalid_workbuddy_switch');
  const account=service.config.value.accounts.find(a=>a.id===accountId&&a.platform==='workbuddy'&&a.enabled!==false);if(!account)throw new AppError('WorkBuddy 帐号不存在或已停用',404,'account_not_found');
  if(account.inferenceEnabled===false)throw new AppError('该 WB 帐号已停用积分调用；签到和自动任务保持不变',409,'wb_inference_disabled');
  if(isWorkBuddyBlocked(service,accountId))throw new AppError('WB 帐号已标记封禁，请先核验或删除该帐号',409,'wb_account_banned');
  // Verify this saved login, never overwrite an official client login file.
  const credential=await service.credentials.resolve(accountId,{force:true});
  const routes=service.config.value.routes.filter(r=>r.enabled!==false&&r.accountPool?.enabled&&r.accountPool.accountIds.includes(accountId));
  if(!routes.length)throw new AppError('该帐号尚未加入启用的 WB 模型池，请先保存帐号池设置',409,'pool_disabled');
  for(const route of routes){if(!service.router.pool.candidates(route,{ignoreCooldown:true}).some(t=>t.accountId===accountId))throw new AppError('该帐号尚未加入启用的 WB 模型池',409,'pool_disabled');if((service.router.pool.get('wb-pool-cooldown:'+accountId)?.until??0)>Date.now())throw new AppError('该帐号额度处于冷却，刷新积分后再切换',409,'account_credit_cooldown');}
  const current=currentWorkBuddyAccount(service),clientSwitch=switchClient?await prepareWorkBuddyClientSwitch(service,account,credential):null;let sessions;
  if((migrate??workBuddySettings(service).autoMigrateSessions)&&current&&current!==accountId)sessions=await mergeWorkBuddySessions(service,{targetAccountId:accountId,sourceAccountIds:[current]});
  const prior=routes.map(r=>[r.id,service.router.pool.get('wb-pool-route:'+r.id)]),previousCurrent=service.ledger?.get('wb-management-current')??null;let clientReceipt;
  try{if(clientSwitch)clientReceipt=await clientSwitch.commit();const selections=routes.map(r=>service.router.pool.select(r,accountId));service.ledger?.set('wb-management-current',{accountId,updatedAt:new Date().toISOString()});
    return {selected:true,accountId,effective:switchClient?'desktop_on_next_launch_and_gateway_next_request':'gateway_next_request',desktopLoginChanged:switchClient,clientSwitched:switchClient,cloudSyncConfirmed:false,selections,...clientReceipt,...(sessions?{sessions}:{})};
  }catch(e){
    const rollbackErrors=[];
    try{for(const [id,state]of prior)try{service.router.pool.set('wb-pool-route:'+id,state??null);}catch(restore){rollbackErrors.push(restore.code??'pool_restore_failed');}}
    finally{
      // A full/busy gateway ledger must never bypass the independent official
      // auth-file rollback, even when restoring preferred pools also fails.
      try{await clientSwitch?.rollback();}catch(restore){rollbackErrors.push(restore.code??'client_restore_failed');}
      try{service.ledger?.set('wb-management-current',previousCurrent);}catch(restore){rollbackErrors.push(restore.code??'current_restore_failed');}
    }
    if(rollbackErrors.length){const failure=new AppError(errorView(e).message+'；部分切号状态还原待复核（'+rollbackErrors.join(',')+'）',500,'wb_switch_rollback_incomplete');failure.rollbackErrors=rollbackErrors;throw failure;}throw e;
  }
}
export async function deleteGatewayAccount(service,accountId,{confirm}={}) {
  if(confirm!==true)throw new AppError('删除帐号需要显式确认 confirm=true',400,'account_delete_confirmation_required');
  const prior=service.config.value.accounts.find(a=>a.id===accountId);if(!prior)throw new AppError('帐号不存在',404,'account_not_found');
  const value=structuredClone(service.config.value),upstreamIds=new Set(value.upstreams.filter(u=>u.accountId===accountId).map(u=>u.id)),removedRouteIds=[];
  for(const r of value.routes){if(r.accountPool){r.accountPool.accountIds=r.accountPool.accountIds.filter(id=>id!==accountId);if(!r.accountPool.accountIds.length)delete r.accountPool;}
    if(upstreamIds.has(r.targets[0]?.upstreamId)&&r.accountPool?.accountIds.length){
      const anchor=value.upstreams.find(u=>u.id===r.targets[0].upstreamId),edition=workBuddyEdition(value.accounts.find(a=>a.id===anchor?.accountId));
      // Ineligible retained members preserve priority for later re-enabling,
      // but must not hide a viable successor farther down the saved order.
      const successor=r.accountPool.accountIds.map(id=>{
        const account=value.accounts.find(a=>a.id===id&&a.platform==='workbuddy'&&a.enabled!==false&&a.inferenceEnabled!==false&&workBuddyEdition(a)===edition);
        return account&&!isWorkBuddyBlocked(service,id)?value.upstreams.find(u=>u.kind==='workbuddy'&&u.enabled!==false&&u.accountId===id):undefined;
      }).find(Boolean);
      if(successor)r.targets[0]={...r.targets[0],upstreamId:successor.id};
    }
    r.targets=r.targets.filter(t=>!upstreamIds.has(t.upstreamId));if(!r.targets.length)removedRouteIds.push(r.id);
  }
  value.accounts=value.accounts.filter(a=>a.id!==accountId);value.upstreams=value.upstreams.filter(u=>!upstreamIds.has(u.id));value.routes=value.routes.filter(r=>r.targets.length);
  const backupFile=join(service.config.dataDir,'account-deletion-backups',Date.now()+'-'+randomUUID()+'.json');await atomicJson(backupFile,{schemaVersion:1,accountId,config:service.config.value,createdAt:new Date().toISOString()});
  await service.config.save(value);service.credentials.cache?.delete(accountId);service.balanceCache?.delete(accountId);service.balanceCacheKeys?.delete(accountId);
  for(const id of upstreamIds)service.platforms.catalogs?.delete(id);if(service.ledger?.get('wb-management-current')?.accountId===accountId)service.ledger.set('wb-management-current',null);
  return {deleted:true,accountId,removedRouteIds,removedUpstreamIds:[...upstreamIds],backupFile,credentialFilesPreserved:true,historyPreserved:true};
}
export async function runAutomaticWorkBuddyTasks(service) {
  if(!workBuddySettings(service).autoTasks)return {enabled:false,receipts:[]};
  if(service.workbuddyAutomaticTaskFlight)return service.workbuddyAutomaticTaskFlight;
  const controller=new AbortController();service.workbuddyAutomaticTaskController=controller;
  const flight=(async()=>{const receipts=[];for(const a of service.config.value.accounts.filter(a=>a.platform==='workbuddy'&&a.enabled!==false&&!isWorkBuddyBlocked(service,a.id))){if(!workBuddySettings(service).autoTasks||controller.signal.aborted)break;try{receipts.push(await runWorkBuddyTasks(service,{accountId:a.id,action:'run',automatic:true,signal:controller.signal}));}catch(e){receipts.push({accountId:a.id,status:controller.signal.aborted?'cancelled':'error',error:errorView(e)});}}return {enabled:workBuddySettings(service).autoTasks,receipts};})();
  service.workbuddyAutomaticTaskFlight=flight;try{return await flight;}finally{if(service.workbuddyAutomaticTaskFlight===flight){service.workbuddyAutomaticTaskFlight=null;service.workbuddyAutomaticTaskController=null;}}
}
