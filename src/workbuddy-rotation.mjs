import {randomUUID} from 'node:crypto';
import {AppError} from './util.mjs';
import {workBuddySummary} from './workbuddy-management.mjs';
import {withConfigMutation} from './model-directory.mjs';
import {workBuddyRotationSettings,validateWorkBuddyRotation,chooseWorkBuddyRotation} from './workbuddy-rotation-policy.mjs';
import {workBuddyCliBusy,prepareWorkBuddyCliRotation} from './workbuddy-cli-rotation.mjs';
const key='wb-rotation-state',flights=new WeakMap();
const stateOf=service=>service.ledger?.get(key)??{};
const closed=service=>service.workbuddyExecutorController?.signal.aborted===true;
function eligibleRows(rows,settings,now){const eligible=[],excluded=[];
  for(const row of rows){let reason;const checked=Date.parse(row.balance?.checkedAt??row.checkedAt),expiry=Date.parse(row.credential?.accessExpiresAt??'');
    if(row.enabled===false)reason='account_disabled';else if(row.inferenceEnabled===false)reason='inference_disabled';else if(row.edition!==settings.edition)reason='edition_mismatch';else if(row.ban?.status==='banned')reason='account_banned';else if(row.credentialStatus!=='authenticated'||row.credential?.hasAccessToken!==true)reason='login_not_verified';else if(row.stale||row.balance?.error||row.error||!Number.isFinite(checked)||now-checked>Math.max(300000,settings.intervalMinutes*120000))reason='balance_stale_or_unknown';else if(Number.isFinite(expiry)&&expiry<=now)reason='login_expired';else if(typeof row.remaining!=='number'||!Number.isFinite(row.remaining))reason='balance_unknown';else if(row.remaining<=settings.minRemainingCredits)reason='insufficient_remaining';else if(row.cooldown?.until>now)reason='account_cooldown';
    const positive=(row.balance?.packages??[]).filter(p=>typeof p.remaining==='number'&&p.remaining>0),knownDates=positive.map(p=>p.expiresAtMs??Date.parse(p.expiresAt??'')),dates=knownDates.filter(t=>Number.isFinite(t)&&t>now);
    if(!reason&&knownDates.length&&knownDates.every(t=>Number.isFinite(t)&&t<=now))reason='account_packages_expired';
    const candidate={accountId:row.accountId,label:row.label,remaining:row.remaining,nearestExpiryMs:dates.length?Math.min(...dates):null};
    if(reason)excluded.push({accountId:row.accountId,label:row.label,reason});else eligible.push(candidate);
  }return {eligible,excluded};
}
export function workBuddyRotationBusy(service,now=Date.now()) {
  if(service.workbuddyRuntime?.rotationBusy)return service.workbuddyRuntime.rotationBusy();
  try{
    if(service.ledger?.db?.prepare("SELECT COUNT(*) AS n FROM usage_calls WHERE status='running' AND started_at>=?").get(new Date(now-1800000).toISOString()).n>0)return true;
    const leases=service.ledger?.db?.prepare("SELECT value FROM meta WHERE key LIKE 'workbuddy.executor.lease:%'").all()??[];
    return leases.some(row=>{try{return JSON.parse(row.value)?.expiresAt>now}catch{return true}});
  }catch{return true;}
}
export async function workBuddyRotationStatus(service,{now=Date.now(),reload=true}={}) {
  if(reload&&typeof service.config.load==='function')await service.config.load();
  const settings=workBuddyRotationSettings(service),state=stateOf(service),summary=await workBuddySummary(service,{includeTasks:false}),{eligible,excluded}=eligibleRows(summary.accounts,settings,now),gateway=[];
  if(['gateway','both'].includes(settings.target))for(const route of service.config.value.routes){if(route.enabled===false||route.accountPool?.enabled!==true)continue;
    const allowed=service.router.pool.candidates(route,{ignoreCooldown:false}),candidates=route.accountPool.accountIds.map(id=>eligible.find(a=>a.accountId===id&&allowed.some(t=>t.accountId===id))).filter(Boolean);if(!candidates.length)continue;
    const current=service.router.pool.get('wb-pool-route:'+route.id)?.preferredAccountId??allowed[0]?.accountId;
    gateway.push({routeId:route.id,currentAccountId:current,...chooseWorkBuddyRotation(candidates,current,settings,{now,lastRotatedAt:state.gateway?.lastRotatedAt??0})});
  }
  let cli;
  if(['codebuddy-cli','both'].includes(settings.target)){
    const busy=await workBuddyCliBusy(service,now);cli=busy.busy?{status:'skipped',reason:busy.reason}:chooseWorkBuddyRotation(eligible,state.cli?.accountId,settings,{now,lastRotatedAt:state.cli?.lastRotatedAt??0});
  }
  return {settings,state,preview:{enabled:settings.enabled,gateway,cli:cli??null,eligibleAccounts:eligible,excludedAccounts:excluded,gatewayBusy:!!workBuddyRotationBusy(service,now)},generationRequests:0,desktopLoginChanged:false};
}
export async function saveWorkBuddyRotation(service,body) {
  validateWorkBuddyRotation(body,{partial:true});if(typeof service.config.load==='function')await service.config.load();
  const value=structuredClone(service.config.value),settings=validateWorkBuddyRotation({...workBuddyRotationSettings(service),...body});value.workbuddy={...value.workbuddy,rotation:settings};await service.config.save(value);
  return {saved:true,settings,automaticCheckinUnchanged:true,automaticTasksUnchanged:true,desktopLoginChanged:false};
}
function acquire(service,now){const db=service.ledger?.db;if(!db)return {valid:()=>true,release(){}};const id=randomUUID(),leaseKey='wb-rotation-lease';
  db.exec('BEGIN IMMEDIATE');try{const old=service.ledger.get(leaseKey);if(old?.expiresAt>now){db.exec('COMMIT');return null;}service.ledger.set(leaseKey,{owner:id,expiresAt:now+120000});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  let lost=false;const valid=()=>{try{const lease=service.ledger.get(leaseKey);return !lost&&lease?.owner===id&&lease.expiresAt>Date.now();}catch{return false;}};
  const timer=setInterval(()=>{try{db.exec('BEGIN IMMEDIATE');const lease=service.ledger.get(leaseKey);if(!lost&&lease?.owner===id&&lease.expiresAt>Date.now())service.ledger.set(leaseKey,{owner:id,expiresAt:Date.now()+120000});else lost=true;db.exec('COMMIT');}catch{lost=true;try{db.exec('ROLLBACK');}catch{}}},30000);timer.unref();
  return {valid,release(){clearInterval(timer);db.exec('BEGIN IMMEDIATE');try{if(service.ledger.get(leaseKey)?.owner===id)service.ledger.set(leaseKey,{owner:id,expiresAt:0});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}};
}
export async function evaluateWorkBuddyRotation(service,body={dryRun:true},{scheduled=false,now=Date.now()}={}) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='dryRun')||body.dryRun!==undefined&&typeof body.dryRun!=='boolean')throw new AppError('轮换评估需要 dryRun 布尔值',400,'invalid_wb_rotation_evaluate');
  if(body.dryRun!==false){const preview=await workBuddyRotationStatus(service,{now});return {status:'planned',dryRun:true,...preview};}
  if(flights.has(service))return {status:'skipped',reason:'rotation_running',generationRequests:0,desktopLoginChanged:false};
  const flight=(async()=>{
    if(typeof service.config.load==='function')await service.config.load();const settings=workBuddyRotationSettings(service),state=stateOf(service);
    const skip=reason=>({status:'skipped',reason,results:[],generationRequests:0,desktopLoginChanged:false});
    if(!settings.enabled)return skip('disabled');if(closed(service))return skip('service_stopping');if(scheduled&&now-(state.lastCheckedAt??0)<settings.intervalMinutes*60000)return skip('interval');if(workBuddyRotationBusy(service,now))return skip('gateway_request_running');
    const lease=acquire(service,now);if(!lease)return skip('rotation_running');
    try{
      if(scheduled)await workBuddySummary(service,{refresh:true,includeTasks:false});
      const preview=await workBuddyRotationStatus(service,{now}),results=[];let prepared,targetAccount;
      if(preview.preview.cli?.status==='planned'){
        targetAccount=service.config.value.accounts.find(a=>a.id===preview.preview.cli.accountId);
        try{const credential=await service.credentials.resolve(targetAccount.id,{force:true});prepared=await prepareWorkBuddyCliRotation(service,targetAccount,credential,{now,canCommit:async()=>{
          if(!lease.valid()||closed(service)||workBuddyRotationBusy(service,Date.now()))return false;
          if(typeof service.config.load==='function')await service.config.load();const current=workBuddyRotationSettings(service),a=service.config.value.accounts.find(a=>a.id===targetAccount.id);
          return JSON.stringify(current)===JSON.stringify(settings)&&a?.enabled!==false&&a?.inferenceEnabled!==false&&a?.platform==='workbuddy';
        }});}catch(e){results.push({target:'codebuddy-cli',status:'skipped',reason:e.code??'cli_prepare_failed'});}
      }else if(preview.preview.cli)results.push({target:'codebuddy-cli',...preview.preview.cli});
      return await withConfigMutation(service,async()=>{
        if(typeof service.config.load==='function')await service.config.load();if(!lease.valid())return skip('rotation_lease_lost');if(closed(service)||!workBuddyRotationSettings(service).enabled)return skip('service_or_settings_changed');if(JSON.stringify(workBuddyRotationSettings(service))!==JSON.stringify(settings))return skip('rotation_settings_changed');if(workBuddyRotationBusy(service,Date.now()))return skip('gateway_request_running');
        const latest=await workBuddyRotationStatus(service,{now:Date.now(),reload:false}),prior=stateOf(service),next={...prior,lastCheckedAt:now};
        if(prepared){if(latest.preview.cli?.status==='planned'&&latest.preview.cli.accountId===targetAccount.id){try{const receipt=await prepared.commit();next.cli={accountId:targetAccount.id,lastRotatedAt:now};results.push({target:'codebuddy-cli',status:'rotated',...receipt});}catch(e){results.push({target:'codebuddy-cli',status:'skipped',reason:e.code??'cli_write_failed'});}}else results.push({target:'codebuddy-cli',status:'skipped',reason:'cli_target_changed'});}
        let changed=0;const originals=[];
        try{for(const plan of latest.preview.gateway){if(plan.status!=='planned'){results.push({target:'gateway',...plan});continue;}const route=service.config.value.routes.find(r=>r.id===plan.routeId);originals.push([route.id,service.router.pool.get('wb-pool-route:'+route.id)]);const receipt=service.router.pool.select(route,plan.accountId);changed++;results.push({target:'gateway',status:'rotated',...receipt,effective:'next_request'});}
        }catch(e){for(const[id,value]of originals)service.router.pool.set('wb-pool-route:'+id,value??null);for(let i=results.length-1;i>=0;i--)if(results[i].target==='gateway'&&results[i].status==='rotated')results.splice(i,1);changed=0;results.push({target:'gateway',status:'skipped',reason:e.code??'gateway_preference_failed'});}
        if(changed)next.gateway={lastRotatedAt:now,routesChanged:changed};const didRotate=results.some(r=>r.status==='rotated');next.status=didRotate?'rotated':'skipped';next.results=results;next.history=[...(prior.history??[]),{at:now,status:next.status,results}].slice(-30);service.ledger?.set(key,next);
        return {status:next.status,results,generationRequests:0,desktopLoginChanged:false};
      });
    }finally{lease.release();}
  })();flights.set(service,flight);try{return await flight;}finally{if(flights.get(service)===flight)flights.delete(service);}
}
export function workBuddyRotationFlight(service){return flights.get(service);}
