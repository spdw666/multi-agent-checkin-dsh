// Management requests acknowledge immediately. Existing task receipts and
// execution leases remain authoritative; disconnecting a viewer never replays
// or silently cancels a possibly submitted action.
import {randomUUID} from 'node:crypto';
import {AppError,errorView,redact} from './util.mjs';
import {runWorkBuddyTasks,workBuddyTaskSnapshot} from './workbuddy-tasks.mjs';

const services=new WeakMap();
const phases=new Set(['queued','init','query','accept','execution','progress_poll','claim','finished','cancelling']);
const terminal=new Set(['completed','cancelled','timed_out','failed']);
const stateFor=service=>{let s=services.get(service);if(!s){s={jobs:new Map(),active:new Map()};services.set(service,s);}return s;};
const integer=v=>Number.isInteger(v)&&v>=0?Math.min(v,100000):0;
const boundedString=v=>typeof v==='string'?redact(v).slice(0,256):undefined;
const scope=accountId=>accountId??'*';
function snapshot(service,accountId){
 if(accountId)return workBuddyTaskSnapshot(service,accountId);
 const results=(service.config.value.accounts??[]).filter(a=>a.platform==='workbuddy'&&a.enabled!==false).map(a=>workBuddyTaskSnapshot(service,a.id));
 const times=results.map(r=>r.checkedAt).filter(Boolean).sort();
 return {tasks:results.flatMap(r=>(r.tasks??[]).map(t=>({...t,accountId:r.accountId}))),receipts:results.flatMap(r=>r.receipts??[]),results,checkedAt:times.at(-1)??null};
}
function view(service,job){
 const elapsedMs=Math.max(0,(job.finishedAt?Date.parse(job.finishedAt):Date.now())-Date.parse(job.startedAt));
 let snapshotError;
 try{job.lastSnapshot=snapshot(service,job.accountId);}catch{snapshotError={code:'wb_task_snapshot_temporarily_unavailable',message:'进度读取暂未完成，保留已有任务列表；后台动作状态另行核验'};}
 const result={jobId:job.id,accountId:job.accountId??null,action:job.action,status:job.status,startedAt:job.startedAt,updatedAt:job.updatedAt,finishedAt:job.finishedAt??null,deadlineAt:job.deadlineAt,progress:{...job.progress,elapsedMs},snapshot:structuredClone(job.lastSnapshot)};
 if(snapshotError)result.snapshotError=snapshotError;
 if(job.error)result.error=job.error;
 if(job.status==='completed')result.result=structuredClone(job.finalSnapshot??result.snapshot);
 if(job.cancelReason)result.cancelReason=job.cancelReason;
 return result;
}
function prune(state){
 const completed=[...state.jobs.values()].filter(j=>terminal.has(j.status));
 const expire=Date.now()-30*60000;
 for(const job of completed)if(Date.parse(job.finishedAt)<expire||state.jobs.size>100)state.jobs.delete(job.id);
}
function validate(service,body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['accountId','action','taskCode','taskCodes'].includes(k)))throw new AppError('WB 后台任务参数格式错误',400,'wb_task_job_invalid');
 const {accountId,action='run',taskCode,taskCodes}=body;
 if(!['run','accept','claim','query'].includes(action))throw new AppError('WB 任务操作格式错误',400,'wb_task_action_invalid');
 if(accountId!==undefined&&(typeof accountId!=='string'||!service.config.value.accounts.some(a=>a.id===accountId&&a.platform==='workbuddy'&&a.enabled!==false)))throw new AppError('WB 帐号不存在或已停用',404,'account_not_found');
 const codes=taskCode!==undefined?[taskCode]:taskCodes;
 if(codes!==undefined&&(!Array.isArray(codes)||codes.length>256||codes.some(c=>typeof c!=='string'||!c||c.length>256)))throw new AppError('WB 任务标识格式错误',400,'wb_task_code_invalid');
 return {accountId,action,...(codes!==undefined?{taskCodes:[...new Set(codes)]}:{} )};
}
export function startWorkBuddyTaskJob(service,body){
 if(service.workbuddyTaskJobsClosing)throw new AppError('WB 后台正在正常退出，现有任务回执保留',503,'wb_task_service_stopping');
 const options=validate(service,body),state=stateFor(service);prune(state);
 const key=scope(options.accountId),signature=JSON.stringify([options.action,options.taskCodes??null]);
 const old=state.active.get(key);
 if(old){if(old.signature===signature)return view(service,old);throw new AppError('该 WB 帐号已有后台任务，请查看进度或停止后再操作',409,'wb_tasks_busy');}
 if(key!=='*'&&state.active.has('*')||key==='*'&&state.active.size)throw new AppError('WB 全号任务与单号任务正在执行，请先查看已有进度',409,'wb_tasks_busy');
 if(state.active.size>=32)throw new AppError('WB 后台任务数已满，请等待当前任务结束',409,'wb_tasks_busy');
 const controller=new AbortController(),startedAt=new Date().toISOString();
 const milliseconds=options.action==='query'?(service.workbuddyTaskQueryJobTimeoutMs??30000):(service.workbuddyTaskJobTimeoutMs??180000);
 const budget=Number.isFinite(milliseconds)&&milliseconds>0?milliseconds:180000;
 const initialSnapshot=snapshot(service,options.accountId);
 const job={id:randomUUID(),...options,signature,controller,status:'running',startedAt,updatedAt:startedAt,deadlineAt:new Date(Date.now()+budget).toISOString(),progress:{phase:'queued',completed:0,total:0},lastSnapshot:initialSnapshot,timer:null,flight:null};
 state.jobs.set(job.id,job);state.active.set(key,job);
 const cancel=reason=>{
  if(terminal.has(job.status)||controller.signal.aborted)return;
  job.status='cancelling';job.cancelReason=reason;job.updatedAt=new Date().toISOString();
  controller.abort(new AppError(reason==='deadline'?'WB 本轮时间预算已到，停止安排后续任务；已提交动作保留待确认':'已请求停止后续任务；当前已提交动作仍须等待确认',reason==='deadline'?504:499,reason==='deadline'?'wb_task_job_timeout':'wb_tasks_cancelled'));
 };
 job.cancel=cancel;
 job.timer=setTimeout(()=>cancel('deadline'),budget);job.timer.unref?.();
 const shutdown=()=>cancel('shutdown');service.workbuddyExecutorController?.signal.addEventListener('abort',shutdown,{once:true});
 const onProgress=p=>{
  if(terminal.has(job.status)||!p||typeof p!=='object')return;
  const phase=phases.has(p.phase)?p.phase:job.progress.phase;
  job.progress={phase,completed:integer(p.completed),total:integer(p.total),...(boundedString(p.taskCode)?{taskCode:boundedString(p.taskCode)}:{}),...(boundedString(p.accountId)?{accountId:boundedString(p.accountId)}:{})};
  job.updatedAt=new Date().toISOString();
 };
 const flights=service.workbuddyTaskJobFlights??=new Set();
 job.flight=Promise.resolve().then(async()=>{
  if(service.workbuddyExecutorController?.signal.aborted)shutdown();
  controller.signal.throwIfAborted();
  const run=service.workbuddyTaskJobRunner??runWorkBuddyTasks;
  return run(service,{...options,signal:controller.signal,onProgress});
 }).then(()=>{job.status=controller.signal.aborted?(job.cancelReason==='deadline'?'timed_out':'cancelled'):'completed';},error=>{
  job.status=controller.signal.aborted?(job.cancelReason==='deadline'?'timed_out':'cancelled'):'failed';
  job.error=errorView(controller.signal.aborted?controller.signal.reason:error);
 }).finally(()=>{
  clearTimeout(job.timer);service.workbuddyExecutorController?.signal.removeEventListener('abort',shutdown);
  try{job.lastSnapshot=snapshot(service,job.accountId);}catch{/* Keep the last successful local snapshot; shutdown still settles. */}
  job.finalSnapshot=structuredClone(job.lastSnapshot);
  job.finishedAt=job.updatedAt=new Date().toISOString();
  if(state.active.get(key)===job)state.active.delete(key);
  flights.delete(job.flight);
  prune(state);
 });
 flights.add(job.flight);
 return view(service,job);
}
export function workBuddyTaskJob(service,id){
 const state=stateFor(service);prune(state);const job=state.jobs.get(id);
 if(!job)throw new AppError('后台任务记录已结束或已重新启动；保留现有列表，通过重新查询核验已提交动作',404,'wb_task_job_not_found');
 return view(service,job);
}
export function activeWorkBuddyTaskJob(service,accountId){
 const state=stateFor(service),job=state.active.get(scope(accountId))??(accountId?state.active.get('*'):undefined);
 return {job:job?view(service,job):null};
}
export function cancelWorkBuddyTaskJob(service,id){
 const state=stateFor(service),job=state.jobs.get(id);
 if(!job)throw new AppError('WB 后台任务不存在或已结束',404,'wb_task_job_not_found');
 job.cancel('user');return view(service,job);
}
