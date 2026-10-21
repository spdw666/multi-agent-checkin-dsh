import {randomInt} from 'node:crypto';
import {dayIn} from './util.mjs';
import {runAutomaticWorkBuddyTasks} from './workbuddy-management.mjs';
import {evaluateWorkBuddyRotation} from './workbuddy-rotation.mjs';
import {clientUpdateDue,runClientUpdateCheck,cancelClientUpdateCheck} from './client-updates.mjs';
export function dailyPlan(now,schedule,jitter=0) {
  // Search local wall-clock minutes. This also handles DST folds/gaps on a future VPS timezone.
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const start=Math.floor(now.getTime()/60000)*60000;
  for(let minute=0;minute<3000;minute++){const at=new Date(start+minute*60000);const parts=Object.fromEntries(fmt.formatToParts(at).map(p=>[p.type,p.value]));
    if(Number(parts.hour)===schedule.hour&&Number(parts.minute)===schedule.minute){const target=at.getTime()+jitter*1000;if(target>now.getTime())return target;}
  }
  throw new Error('Schedule has no next daily time');
}
const settledStatuses=new Set(['success','already','observed']);
const slowStatuses=new Set(['not_available','device_occupied','rejected','action_required','skipped']);
const taskKey=row=>JSON.stringify([row.accountId??null,row.task??null]);
const timestamp=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'?Date.parse(value):NaN;
const operationFields=['operationAttempted','automaticOperationConfirmed','automaticRewardConfirmed','trigger','triggerSource'];
const validVersion=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const sourceWakeAllowed=row=>row.loginRequired===true&&!settledStatuses.has(row.status)&&row.status!=='rate_limited'&&!/(?:rate.?limit|too_many|refresh_deferred)/i.test(row.reason??'');
function retryTime(result,attempt,now,schedule) {
  // An official Retry-After is a lower bound, not a delay to shorten to our cap.
  const explicit=timestamp(result.retryAt);
  if(explicit>now)return explicit;
  if(Number.isFinite(result.retryAfterMs)&&result.retryAfterMs>0)return now+Math.max(30000,result.retryAfterMs);
  const cap=(schedule.retryMinutes??60)*60000;
  const delay=slowStatuses.has(result.status)||result.loginRequired===true?cap:Math.min(cap,[1,5,15,60][Math.min(attempt-1,3)]*60000);
  return now+delay;
}
export class Scheduler {
  constructor(config,claims,ledger){Object.assign(this,{config,claims,ledger});this.timer=null;this.running=false;this.ticking=false;this.stopped=true;this.jobs=new Set();this.sourceChecks=new Map();}
  track(promise){this.jobs.add(promise);void promise.finally(()=>this.jobs.delete(promise)).catch(()=>{});return promise;}
  activeTasks(){return (this.config.value.accounts??[]).filter(a=>a.enabled!==false).flatMap(a=>(a.tasks??[]).filter(t=>t.enabled).map(t=>({accountId:a.id,task:t.id})));}
  context() {
    const s=this.config.value.scheduler,day=dayIn(new Date(),s.timezone);
    // Inference-only switches do not alter the daily check-in plan.
    const signature=JSON.stringify([s.timezone,s.hour,s.minute,s.jitterSeconds,(this.config.value.accounts??[]).map(a=>[a.id,a.enabled,a.tasks])]);
    let plan=this.ledger.get('schedule-plan');
    if(!plan||plan.day!==day||plan.signature!==signature){const jitter=randomInt(0,s.jitterSeconds+1),now=new Date();
      const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:s.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
      let target;const start=Math.floor(now.getTime()/60000)*60000-26*3600000;
      for(let i=0;i<52*60;i++){const at=new Date(start+i*60000);if(dayIn(at,s.timezone)!==day)continue;const parts=Object.fromEntries(fmt.formatToParts(at).map(p=>[p.type,p.value]));if(Number(parts.hour)===s.hour&&Number(parts.minute)===s.minute){target=at.getTime()+jitter*1000;break}}
      target??=dailyPlan(now,s,jitter);plan={day,signature,at:target,jitterSeconds:jitter};this.ledger.set('schedule-plan',plan);
    }
    return {s,day,signature,plan};
  }
  states(last,s) {
    const active=this.activeTasks(),keys=new Set(active.map(taskKey));
    return (last?.tasks??last?.results??[]).filter(row=>keys.has(taskKey(row))||row.accountId==null&&row.task==null).map(row=>{
      const state={...row,day:row.day??last.day,signature:row.signature??last.signature,attempt:row.attempt??(settledStatuses.has(row.status)?0:1)};
      if(!settledStatuses.has(state.status)&&!Number.isFinite(state.retryDue))state.retryDue=(last.at??0)+(s.retryMinutes??60)*60000;
      return state;
    });
  }
  async sourceVersions(tasks) {
    const credentials=typeof this.claims.credentials?.sourceVersion==='function'?this.claims.credentials:this.service?.credentials,versions=new Map();
    if(typeof credentials?.sourceVersion!=='function')return versions;
    await Promise.all([...new Set(tasks.map(task=>task.accountId).filter(id=>id!=null))].map(async id=>{
      try {const version=await credentials.sourceVersion(id);if(validVersion(version))versions.set(id,version);}catch{}
    }));
    return versions;
  }
  async credentialChanges(states,last,now) {
    const candidates=states.filter(row=>sourceWakeAllowed(row)&&row.accountId!=null&&row.task!=null&&
      !(timestamp(row.credentialSourceWakeAfter)>now)&&now-(row.checkedAt??last?.at??0)>=30000&&
      now-(this.sourceChecks.get(taskKey(row))??0)>=30000);
    for(const row of candidates)this.sourceChecks.set(taskKey(row),now);
    const versions=await this.sourceVersions(candidates);
    return candidates.filter(row=>validVersion(versions.get(row.accountId))&&
      (!validVersion(row.credentialSourceVersion)||row.credentialSourceVersion!==versions.get(row.accountId)));
  }
  save(context,previous,states,results,{source,daily=false,requested=[],sourceVersions=new Map()}={}) {
    const {s,day,signature}=context,now=Date.now(),active=this.activeTasks(),activeKeys=new Set(active.map(taskKey)),merged=new Map(states.filter(row=>activeKeys.has(taskKey(row))||row.accountId==null&&row.task==null).map(row=>[taskKey(row),row])),received=new Set();
    for(const raw of results){
      // Production receipts name both fields. Accommodate legacy single-task
      // adapters without conflating different tasks of the same account.
      const matching=active.filter(t=>t.accountId===raw.accountId);
      const result={...raw,...(raw.task==null&&matching.length===1?{task:matching[0].task}:{})},key=taskKey(result),prior=merged.get(key);
      if(result.accountId!=null&&result.task!=null&&!activeKeys.has(key))continue;
      const verifiedDay=typeof result.day==='string'?result.day:day;
      const attempt=settledStatuses.has(result.status)?0:(prior?.day===verifiedDay?prior.attempt??0:0)+1;
      const nextClaimAt=timestamp(result.nextClaimAt)>now?result.nextClaimAt:null;
      const row={accountId:result.accountId,task:result.task,status:result.status??'error',day:verifiedDay,signature,attempt,retryDue:settledStatuses.has(result.status)?null:retryTime(result,attempt,now,s),nextClaimAt,checkedAt:now};
      if(typeof result.reason==='string')row.reason=result.reason;
      if(result.loginRequired===true){
        row.loginRequired=true;
        const version=sourceVersions.get(result.accountId)??prior?.credentialSourceVersion;
        if(validVersion(version))row.credentialSourceVersion=version;
        const upstreamDelay=timestamp(result.retryAt)>now?timestamp(result.retryAt):Number.isFinite(result.retryAfterMs)&&result.retryAfterMs>0?now+result.retryAfterMs:null;
        if(upstreamDelay)row.credentialSourceWakeAfter=upstreamDelay;
      }
      for(const field of operationFields)if(typeof result[field]===(field==='trigger'||field==='triggerSource'?'string':'boolean'))row[field]=result[field];
      merged.set(key,row);received.add(key);
    }
    // A partial/incomplete batch must not silently mark its omitted work done.
    for(const task of requested)if(activeKeys.has(taskKey(task))&&!received.has(taskKey(task))){const key=taskKey(task),prior=merged.get(key),attempt=(prior?.day===day?prior.attempt??0:0)+1;merged.set(key,{...task,status:'error',day,signature,attempt,retryDue:retryTime({status:'error'},attempt,now,s),nextClaimAt:null,checkedAt:now,reason:'checkin_batch_missing_result'});}
    const tasks=[...merged.values()],windows=tasks.map(r=>timestamp(r.nextClaimAt)).filter(t=>Number.isFinite(t)&&t>now),retries=tasks.map(r=>r.retryDue).filter(Number.isFinite);
    this.ledger.set('schedule-last',{schemaVersion:2,day,signature,at:now,source,dailyDay:daily?day:previous?.dailyDay??previous?.day,dailySignature:daily?signature:previous?.dailySignature??previous?.signature,nextClaimAt:windows.length?Math.min(...windows):null,retryDue:retries.length?Math.min(...retries):null,complete:tasks.every(r=>settledStatuses.has(r.status)),tasks,results:tasks.map(row=>{const {accountId,task,status,nextClaimAt,retryDue,attempt}=row,result={accountId,task,status,nextClaimAt,retryDue,attempt};for(const field of operationFields)if(row[field]!==undefined)result[field]=row[field];return result;})});
  }
  async runBatch(context,last,states,{source,daily=false,tasks,full=false}={}) {
    this.running=true;
    try {
      // Capture BEFORE an attempt: a native renewal during that attempt must
      // remain observable on the next tick rather than becoming the baseline.
      const sourceVersions=await this.sourceVersions(full?this.activeTasks():tasks??[]);
      let results;
      try {results=await this.claims.all(full?undefined:{tasks},{trigger:'automatic',source});if(!Array.isArray(results))throw new Error('Invalid check-in batch result');}
      catch(error){const targets=tasks?.length?tasks:this.activeTasks();results=(targets.length?targets:[{}]).map(task=>({...task,status:'error',reason:error.code??'checkin_batch_error'}));}
      this.save(context,last,states,results,{source,daily,requested:tasks??(full?this.activeTasks():[]),sourceVersions});
    }finally{this.running=false;}
  }
  async tick() {
    if(this.stopped||this.running||this.ticking)return;
    this.ticking=true;
    try {return await this.tickOnce();}
    finally {this.ticking=false;}
  }
  async tickOnce() {
    if(this.stopped||this.running)return;
    if(this.service&&clientUpdateDue(this.service)){
      this.track(runClientUpdateCheck(this.service).catch(error=>{this.ledger.set('client-updates',{status:'error',error:error.message,checkedAt:new Date().toISOString()});}));
    }
    // WB automatic tasks are a separate user toggle from the daily check-in
    // schedule. Reuse this scheduler's lifecycle and tracked shutdown jobs.
    if(this.service?.config?.value?.workbuddy?.autoTasks===true&&Date.now()-(this.automaticWorkBuddyTasksAt??0)>=1800000){
      this.automaticWorkBuddyTasksAt=Date.now();
      this.track(runAutomaticWorkBuddyTasks(this.service).then(result=>{if(result.enabled)this.ledger.set('wb-automatic-tasks-last',{at:Date.now(),...result});}).catch(error=>{this.ledger.set('wb-automatic-tasks-last',{at:Date.now(),status:'error',code:error.code??'wb_auto_tasks_error'});}));
    }
    if(this.service?.config?.value?.workbuddy?.rotation?.enabled===true){this.track(evaluateWorkBuddyRotation(this.service,{dryRun:false},{scheduled:true}).catch(error=>{this.ledger.set('wb-rotation-last-error',{at:Date.now(),code:error.code??'wb_rotation_error'});}));}
    const s=this.config.value.scheduler;if(!s.enabled)return;
    const context=this.context(),{day,signature,plan}=context,last=this.ledger.get('schedule-last'),states=this.states(last,s),now=Date.now();
    const daily=now>=plan.at&&((last?.dailyDay??last?.day)!==day||(last?.dailySignature??last?.signature)!==signature);
    const isDue=row=>Number.isFinite(row.retryDue)&&row.retryDue<=now||timestamp(row.nextClaimAt)<=now;
    const selected=new Map(states.filter(isDue).filter(row=>row.accountId!=null&&row.task!=null).map(row=>[taskKey(row),{accountId:row.accountId,task:row.task}]));
    const credentialChanges=await this.credentialChanges(states,last,now);
    if(this.stopped)return;
    for(const row of credentialChanges)selected.set(taskKey(row),{accountId:row.accountId,task:row.task});
    if(daily){const known=new Map(states.map(row=>[taskKey(row),row]));for(const task of this.activeTasks()){const row=known.get(taskKey(task));if(row?.retryDue>now||settledStatuses.has(row?.status)&&timestamp(row.nextClaimAt)>now)continue;if(!row||row.day!==day||row.signature!==signature||isDue(row))selected.set(taskKey(task),task);}}
    // Preserve provider windows from old receipts. New receipts retain the
    // window per task, so only the due provider is probed after sleep/restart.
    const legacyWindow=Number.isFinite(last?.nextClaimAt)&&last.nextClaimAt<=now&&!states.some(row=>timestamp(row.nextClaimAt)<=now);
    const anonymousDue=states.some(row=>row.accountId==null&&row.task==null&&isDue(row));
    if(!selected.size&&!legacyWindow&&!anonymousDue){if(daily&&last)this.save(context,last,states,[],{source:'scheduled',daily:true});else if(daily&&!last)await this.runBatch(context,last,states,{source:'scheduled',daily:true,full:true});return;}
    await this.runBatch(context,last,states,{source:credentialChanges.length?'credential-change':daily?'scheduled':'recovery',daily,tasks:[...selected.values()],full:legacyWindow||anonymousDue||!last});
  }
  start(){if(!this.stopped)return;this.stopped=false;const tick=()=>this.track(this.tick()).catch(()=>{});this.timer=setInterval(tick,30000);this.timer.unref();void this.track((async()=>{if(this.config.value.scheduler.startup){const context=this.context(),last=this.ledger.get('schedule-last');await this.runBatch(context,last,this.states(last,context.s),{source:'startup',daily:true,full:true});}await this.tick()})()).catch(()=>{});}
  stop(){this.stopped=true;clearInterval(this.timer);const monitor=this.service&&cancelClientUpdateCheck(this.service);return Promise.allSettled([...this.jobs,...(monitor?[monitor]:[])]);}
}
