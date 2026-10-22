// Official growth task list/accept/claim protocol reviewed against MIT
// workbuddy2api-panel 6b31db6d045e985042620c819c3a938002e7b0b1.
// A task is complete only when a fresh official query confirms it. This module
// never fabricates automation/canvas/chat/expert usage or completion telemetry.
import {AppError,errorView,rememberSecret,hash,redact} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {workBuddyFailure,workBuddyUpstreamError,isWorkBuddyBlocked} from './workbuddy-status.mjs';
import {setTimeout as sleep} from 'node:timers/promises';

const locks=new WeakMap();
const snapshotVersions=new WeakMap();
function snapshotVersion(service,accountId,advance=false){let versions=snapshotVersions.get(service);if(!versions){versions=new Map();snapshotVersions.set(service,versions);}const version=(versions.get(accountId)??0)+(advance?1:0);if(advance)versions.set(accountId,version);return version;}
function reportProgress(service,accountId,onProgress,progress){const view={accountId,phase:progress.phase,taskCode:progress.taskCode??null,completed:progress.completed??0,total:progress.total??0,checkedAt:new Date().toISOString()};if(typeof progress.status==='string')view.status=progress.status;if(typeof progress.reason==='string')view.reason=redact(progress.reason).slice(0,200);Object.freeze(view);try{service.ledger?.set('wb-management-task-progress:'+accountId,view);}catch{/* Progress is advisory, including while the ledger is closing. */}try{onProgress?.(view);}catch{/* A UI observer must not fail or replay official actions. */}return view;}
// Only reads may be detached after cancellation. Writes/executors remain awaited
// under the account lock until settled, even if an injected transport ignores
// AbortSignal; an uncertain side effect must never become eligible for replay.
function abortableRead(operation,signal){signal?.throwIfAborted();if(!signal)return operation();return new Promise((resolve,reject)=>{const aborted=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',aborted,{once:true});Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>{signal.removeEventListener('abort',aborted);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(signal.aborted?signal.reason:error);});});}
export function normalizeWorkBuddyTask(raw) {
  const code=redact(String(raw.task_code??raw.code??'')),current=Number(raw.progress?.current??raw.current??0),target=Number(raw.progress?.target??raw.target??0),claimed=raw.accept_status==='claimed'||raw.claimed===true;
  const rewardCredit=Number(raw.reward_credit??raw.credit??0)||0,rewardEnergy=Number(raw.reward_energy??raw.energy??0)||0;
  const qualified=target>0&&current>=target;
  return {taskCode:code,title:String(raw.title??code),name:String(raw.title??code),description:String(raw.description??raw.task_desc??''),taskDesc:String(raw.task_desc??''),current:Number.isFinite(current)?current:0,progress:Number.isFinite(current)?current:0,target:Number.isFinite(target)?target:0,rewardCredit,rewardEnergy,rewardBuddy:raw.reward_buddy===true,hasReward:raw.has_reward??(rewardCredit>0||rewardEnergy>0||raw.reward_buddy===true),reward:rewardCredit+' 积分'+(rewardEnergy?' + '+rewardEnergy+' 能量':'')+(raw.reward_buddy?' + Buddy':''),taskType:String(raw.task_type??''),tag:String(raw.tag??''),acceptStatus:String(raw.accept_status??''),accepted:!['','not_accepted'].includes(String(raw.accept_status??'')),qualified,serverStatus:String(raw.status??''),status:claimed?'claimed':raw.locked?'locked':String(raw.accept_status??raw.status??'not_accepted'),claimed,locked:raw.locked===true,claimable:!claimed&&raw.locked!==true&&qualified,jumpUrl:typeof raw.jump_url==='string'?raw.jump_url:null,automaticExecution:false,executionStrategy:'manual_action_required',lastReceipt:null};
}
export class WorkBuddyTaskClient {
  constructor(credential,{fetchImpl=fetch,signal,timeoutMs=20000}={}){this.credential=credential;this.fetchImpl=fetchImpl;this.signal=signal;this.timeoutMs=Number.isFinite(timeoutMs)?Math.max(1,Math.min(20000,timeoutMs)):20000;}
  async request(path,{body,web=false}={}) {
    const c=this.credential;if(workBuddyEdition(c)!=='cn')throw new AppError('当前 WB 档位未声明积分成长任务',409,'wb_growth_not_available');
    rememberSecret(c.accessToken);const base=web?'https://www.workbuddy.cn':'https://copilot.tencent.com';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new AppError('WB 任务请求超时，服务端状态待确认',504,'wb_task_request_timeout')),this.timeoutMs),signal=this.signal?AbortSignal.any([this.signal,controller.signal]):controller.signal;
    const perform=async()=>{signal.throwIfAborted();const response=await this.fetchImpl(base+path,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+c.accessToken,'X-Domain':c.domain??'www.workbuddy.cn','X-User-Id':String(c.uid??c.principal),...(web?{'X-Client-Platform':'web',Origin:'https://www.workbuddy.cn',Referer:'https://www.workbuddy.cn/profile/growth-center'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal});signal.throwIfAborted();
      let data;try{data=await response.json();signal.throwIfAborted();}catch(error){
        signal.throwIfAborted();
        const auth=[401,403].includes(response.status),limited=response.status===429;
        const message=response.ok?`WB 任务响应结构待确认（HTTP ${response.status}，JSON 解析失败）`:`WB 任务接口返回 HTTP ${response.status}${auth?response.status===401?'，当前登录态被拒绝':'，当前访问被拒绝':limited?'，暂时限流':''}；上游返回非 JSON 响应`;
        const failure=new AppError(message,response.ok?502:response.status,response.ok?'wb_task_response_invalid':auth?'wb_task_http_auth_rejected':limited?'wb_task_http_rate_limited':'wb_task_http_rejected');
        failure.httpStatus=response.status;
        const media=String(response.headers?.get?.('content-type')??'').split(';',1)[0].trim().toLowerCase();
        failure.contentType=media.length<=100&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(media)?media:null;
        failure.banned=false;
        if(limited)failure.retryable=true;
        throw failure;
      }
      if(!response.ok||data.code!==undefined&&![0,200,'0','200'].includes(data.code)){const e=workBuddyUpstreamError(response,data,'WB 任务请求被服务端拒绝');e.code='wb_task_request_rejected';throw e;}return data.data??data;};
    try{return await (body===undefined?abortableRead(perform,signal):perform());}finally{clearTimeout(timer);}
  }
  async query(){const data=await this.request('/v2/activity/growth/tasks');if(!Array.isArray(data.tasks))throw new AppError('WB 服务端任务列表结构待确认',502,'wb_task_schema_invalid');return data.tasks.map(normalizeWorkBuddyTask).filter(t=>t.taskCode);}
  async accept(codes){return this.request('/v2/activity/growth/tasks/accept',{body:{task_codes:codes}});}
  async claim(code){return this.request('/activity/growth/tasks/'+encodeURIComponent(code)+'/claim',{body:{},web:true});}
}
async function client(service,accountId,signal){signal?.throwIfAborted();const a=service.config.value.accounts.find(a=>a.id===accountId&&a.platform==='workbuddy'&&a.enabled!==false);if(!a)throw new AppError('WB 帐号不存在或已停用',404,'account_not_found');const credential=await service.credentials.resolve(accountId);signal?.throwIfAborted();return new WorkBuddyTaskClient(credential,{fetchImpl:service.workbuddyRuntime?.fetchImpl??fetch,signal,timeoutMs:service.workbuddyRuntime?.taskRequestTimeoutMs});}
const executionStatuses=new Set(['completed','pending','deferred','unsupported']);
function executionView(execution){
  if(!execution||typeof execution!=='object'||!executionStatuses.has(execution.status))return null;
  const view={status:execution.status};
  for(const key of ['reason','operationId','feature','kind','checkedAt'])if(typeof execution[key]==='string')view[key]=redact(execution[key]).slice(0,1000);
  for(const key of ['completedActions','totalActions'])if(typeof execution[key]==='number'&&Number.isFinite(execution[key])&&execution[key]>=0)view[key]=execution[key];
  return view;
}
export function workBuddyReceiptView(receipt){if(!receipt||typeof receipt!=='object')return null;const view={};for(const key of ['accountId','action','taskCode','status','phase','checkedAt','serverConfirmed','credit','energy','current','target','reason','description','alreadyClaimed','prerequisiteTaskCode'])if(['string','boolean','number'].includes(typeof receipt[key])&&(typeof receipt[key]!=='number'||Number.isFinite(receipt[key])))view[key]=typeof receipt[key]==='string'?redact(receipt[key]).slice(0,1000):receipt[key];if(receipt.error)view.error=workBuddyFailure(receipt.error);const execution=executionView(receipt.execution);if(execution)view.execution=execution;return view;}
function acceptanceFailure(ack,code){
  if(!Array.isArray(ack?.results))return null;
  const row=ack.results.find(r=>(r?.task_code??r?.taskCode??r?.code)===code);
  if(!row)return {status:'accept_unconfirmed',reason:'official_accept_result_missing'};
  if(row.success!==false&&!['error','failed','failure','rejected','denied'].includes(String(row.status??'').toLowerCase()))return null;
  const reason=redact(String(row.message??row.reason??row.error?.message??row.error??'official_accept_rejected')).slice(0,1000),waiting=/prerequisite|前置|先完成|依赖/i.test(reason);
  if(/^task does not require acceptance[.!。]?$/i.test(reason.trim()))return {status:'accept_not_required',reason};
  return {status:waiting?'waiting_prerequisite':'accept_rejected',reason,...(waiting&&/\bfirst_buddy\b/.test(reason)?{prerequisiteTaskCode:'first_buddy'}:{})};
}
function taskWithCapability(service,task,receipts){
  const executor=service.workbuddyTaskExecutors?.get?.(task.taskCode),registered=typeof executor==='function',capability={registered,status:registered?'registered':'not_registered'};
  if(registered&&executor.capability&&typeof executor.capability==='object'){
    for(const key of ['kind','feature'])if(typeof executor.capability[key]==='string')capability[key]=redact(executor.capability[key]).slice(0,500);
    for(const key of ['needsDesktop','requiresWindow'])if(typeof executor.capability[key]==='boolean')capability[key]=executor.capability[key];
  }
  const lastReceipt=[...receipts].reverse().find(r=>r?.taskCode===task.taskCode)??null;
  const executionStrategy=task.claimed?'already_claimed':task.locked?'locked':task.claimable?'claim_server_confirmed_reward':lastReceipt?.status==='task_accounting_pending'?'wait_for_official_task_accounting':lastReceipt?.status==='waiting_prerequisite'?'wait_for_official_prerequisite':registered?'registered_executor_then_verify':'manual_action_required';
  return {...task,automaticExecution:registered,executionCapability:capability,executionStrategy,lastReceipt};
}
export function workBuddyTaskSnapshot(service,accountId){const row=service.ledger?.get('wb-management-tasks:'+accountId)??{accountId,tasks:[],checkedAt:null,lastSuccessAt:null,lastFailureAt:null,stale:false,error:null,receipts:service.ledger?.get('wb-management-task-receipts:'+accountId)??[]};const receipts=(row.receipts??[]).map(workBuddyReceiptView).filter(Boolean);return {...row,tasks:(row.tasks??[]).map(t=>taskWithCapability(service,t,receipts)),receipts,progress:service.ledger?.get('wb-management-task-progress:'+accountId)??null};}
function saveTaskSnapshot(service,accountId,tasks,receipts){
  snapshotVersion(service,accountId,true);
  const checkedAt=new Date().toISOString();receipts=(receipts??service.ledger?.get('wb-management-task-receipts:'+accountId)??[]).map(workBuddyReceiptView).filter(Boolean);
  tasks=tasks.map(t=>taskWithCapability(service,t,receipts));
  const row={accountId,tasks,checkedAt,lastSuccessAt:checkedAt,lastFailureAt:null,stale:false,error:null,source:'official_growth_tasks',automaticScope:tasks.some(t=>t.automaticExecution)?'registered_actions_and_server_confirmed_rewards':'accept_and_server_confirmed_rewards',receipts};service.ledger?.set('wb-management-tasks:'+accountId,row);return row;
}
function saveTaskFailure(service,accountId,error){const old=workBuddyTaskSnapshot(service,accountId),row={...old,lastFailureAt:new Date().toISOString(),stale:!!old.lastSuccessAt,error:workBuddyFailure(error)};service.ledger?.set('wb-management-tasks:'+accountId,row);if(row.error.banned)service.ledger?.set('wb-management-official-status:'+accountId,{status:'banned',reason:row.error.message,source:'official_response',checkedAt:row.lastFailureAt,httpStatus:row.error.httpStatus,upstreamCode:row.error.upstreamCode});return row;}
export async function queryWorkBuddyTasks(service,{accountId,signal,onProgress}={}) {
  const version=snapshotVersion(service,accountId,true),progress=(phase,completed=0,status)=>reportProgress(service,accountId,onProgress,{phase,completed,total:1,status});progress('init');
  try{
    signal?.throwIfAborted();let api=await client(service,accountId,signal);signal?.throwIfAborted();progress('query');
    let tasks;
    try{tasks=await api.query();}
    catch(error){
      signal?.throwIfAborted();
      // This recovery belongs only to the UI's read-only task refresh. Never
      // replay acceptance/reward requests or renew for 403, 429 or bad JSON 200.
      if(Number(error.httpStatus??error.status)!==401)throw error;
      const old=api.credential;
      const fresh=await service.credentials.resolve(accountId,{force:true,renew:true,rejectedAccessToken:old.accessToken});
      signal?.throwIfAborted();
      const identity=value=>(typeof value==='string'&&value.trim())||(typeof value==='number'&&Number.isFinite(value)?String(value):null);
      let compared=false;
      for(const field of ['principalHash','uid']){
        const before=identity(old[field]);if(before===null)continue;
        if(identity(fresh?.[field])!==before)throw new AppError('WB 任务查询续期身份与已绑定帐号不符',409,'principal_changed');
        compared=true;
      }
      if(!compared)throw new AppError('WB 任务查询缺少稳定帐号身份，续期结果待核验',409,'wb_task_refresh_identity_unverified');
      if(typeof fresh?.accessToken!=='string'||!fresh.accessToken||fresh.accessToken===old.accessToken&&(fresh.domain??'')===(old.domain??''))throw error;
      api=new WorkBuddyTaskClient(fresh,{fetchImpl:service.workbuddyRuntime?.fetchImpl??fetch,signal,timeoutMs:service.workbuddyRuntime?.taskRequestTimeoutMs});
      signal?.throwIfAborted();tasks=await api.query();
    }
    signal?.throwIfAborted();const result=snapshotVersion(service,accountId)===version?saveTaskSnapshot(service,accountId,tasks):workBuddyTaskSnapshot(service,accountId);if(snapshotVersion(service,accountId)===version+1)progress('finished',1,'completed');return result;
  }catch(e){if(!signal?.aborted&&snapshotVersion(service,accountId)===version){saveTaskFailure(service,accountId,e);progress('finished',0,'failed');}else if(signal?.aborted&&snapshotVersion(service,accountId)===version)progress('finished',0,'cancelled');throw e;}
}
export function runWorkBuddyTasks(service,options={}) {
  const shutdown=service.workbuddyExecutorController?.signal,signal=shutdown?options.signal&&options.signal!==shutdown?AbortSignal.any([options.signal,shutdown]):shutdown:options.signal;
  const flights=service.workbuddyTaskFlights??=new Set();
  let flight;flight=runWorkBuddyTaskOperation(service,{...options,signal}).finally(()=>flights.delete(flight));flights.add(flight);return flight;
}
async function runWorkBuddyTaskOperation(service,{accountId,action='run',taskCodes,taskCode,automatic=false,signal,onProgress}={}) {
  const check=()=>{signal?.throwIfAborted();if(automatic&&service.config.value.workbuddy?.autoTasks!==true)throw new AppError('WB 自动任务已暂停',499,'wb_tasks_cancelled');};
  const rethrowCancellation=error=>{check();if(error?.name==='AbortError'||error?.code==='wb_tasks_cancelled')throw error;};
  if(accountId===undefined||accountId===null){
    if(!['run','query','accept','claim'].includes(action))throw new AppError('WB 任务操作格式错误',400,'wb_task_action_invalid');
    const results=[];for(const a of service.config.value.accounts.filter(a=>a.platform==='workbuddy'&&a.enabled!==false&&!isWorkBuddyBlocked(service,a.id))){check();try{results.push(await runWorkBuddyTasks(service,{accountId:a.id,action,taskCodes,taskCode,automatic,signal,onProgress}));}catch(e){rethrowCancellation(e);results.push({accountId:a.id,status:'error',error:errorView(e),tasks:[],receipts:[{accountId:a.id,action,status:'error',error:errorView(e)}]});}}
    return {action,results,tasks:results.flatMap(r=>(r.tasks??[]).map(t=>({...t,accountId:r.accountId}))),receipts:results.flatMap(r=>r.receipts??[])};
  }
  if(!['run','query','accept','claim'].includes(action))throw new AppError('WB 任务操作格式错误',400,'wb_task_action_invalid');if(action==='query'){check();return queryWorkBuddyTasks(service,{accountId,signal,onProgress});}
  if(taskCode!==undefined)taskCodes=[taskCode];if(taskCodes!==undefined&&(!Array.isArray(taskCodes)||taskCodes.some(t=>typeof t!=='string'||!t||t.length>256)))throw new AppError('WB 任务标识格式错误',400,'wb_task_code_invalid');
  let active=locks.get(service);if(!active){active=new Set();locks.set(service,active);}if(active.has(accountId))throw new AppError('该 WB 帐号的积分任务正在执行',409,'wb_tasks_busy');active.add(accountId);
  let tasks,operationError,completed=0,total=0,currentPhase='init',currentCode=null;const progress=(phase=currentPhase,taskCode=currentCode,status)=>{currentPhase=phase;currentCode=taskCode;return reportProgress(service,accountId,onProgress,{phase,taskCode,completed,total,status});};progress('init',null);
  const cancelling=()=>progress(currentPhase,currentCode,'cancelling');signal?.addEventListener('abort',cancelling,{once:true});
  const receipts=[],record=receipt=>{check();const full=workBuddyReceiptView({accountId,action,checkedAt:new Date().toISOString(),...receipt});receipts.push(full);const recent=[...(service.ledger?.get('wb-management-task-receipts:'+accountId)??receipts.slice(0,-1)),full].map(workBuddyReceiptView).filter(Boolean).slice(-200);service.ledger?.set('wb-management-task-receipts:'+accountId,recent);if(tasks)saveTaskSnapshot(service,accountId,tasks,recent);return full;};
  try{
    check();if(isWorkBuddyBlocked(service,accountId))throw new AppError('WB 帐号已标记封禁，请先核验或删除该帐号',409,'wb_account_banned');const api=await client(service,accountId,signal);check();progress('query',null);tasks=await api.query();check();saveTaskSnapshot(service,accountId,tasks);if(taskCodes?.some(code=>!tasks.some(t=>t.taskCode===code)))throw new AppError('所选任务不在当前官方任务列表',404,'wb_task_not_found');const selectedCodes=tasks.filter(t=>!taskCodes||taskCodes.includes(t.taskCode)).map(t=>t.taskCode);if(action==='run'){const priority=code=>{if(taskCodes)return code==='first_buddy'?0:1;const task=tasks.find(t=>t.taskCode===code);return task.claimable?0:task.claimed||task.locked?1:code==='first_buddy'?2:typeof service.workbuddyTaskExecutors?.get?.(code)==='function'?3:4;};selectedCodes.sort((a,b)=>priority(a)-priority(b));}total=selectedCodes.length;progress('query',null);
    if(action==='run'&&!taskCodes){try{check();progress('claim','daily-checkin');const receipt=await service.claims.run(accountId,'daily-checkin');check();record({taskCode:'daily-checkin',status:receipt.status,reason:receipt.reason,serverConfirmed:receipt.serverConfirmed===true||receipt.reason==='server_already_claimed'});}catch(e){rethrowCancellation(e);record({taskCode:'daily-checkin',status:'task_error',phase:'daily_checkin',error:errorView(e),serverConfirmed:false});}}
    const requestedDelays=service.workbuddyRuntime?.taskPollDelays;
    const pollDelays=Array.isArray(requestedDelays)&&requestedDelays.length?requestedDelays.slice(0,5).map(d=>Number.isFinite(d)&&d>=0?Math.min(d,10000):0):[0,1000,2000];
    const pollTask=async(code,confirmed,delays=pollDelays)=>{let after;for(const delay of delays){check();progress('progress_poll',code);if(delay)await sleep(delay,undefined,{signal});check();tasks=await api.query();check();saveTaskSnapshot(service,accountId,tasks);after=tasks.find(t=>t.taskCode===code);if(confirmed(after))break;}return after;};
    const pollProgress=code=>pollTask(code,t=>t?.claimed||t?.claimable||t?.locked);
    for(const code of selectedCodes){
      let phase='query',activeExecution;
      try{
        check();progress('query',code);let task=tasks.find(t=>t.taskCode===code);if(!task){record({taskCode:code,status:'task_unavailable',reason:'official_task_missing',serverConfirmed:false});continue;}
        if(task.claimed){record({taskCode:code,status:'already_claimed',serverConfirmed:true});continue;}if(task.locked){record({taskCode:code,status:'locked',serverConfirmed:true});continue;}
        const availableExecutor=service.workbuddyTaskExecutors?.get?.(code);
        // The bulk "run automatic tasks" action must not spend several queries
        // accepting each manual-only task. Explicit accept/selected-task actions
        // retain their original semantics and may deliberately accept a task.
        if(action==='run'&&!taskCodes&&!task.claimable&&(typeof availableExecutor!=='function'||availableExecutor.capability?.feature==='external_wait')){record({taskCode:code,status:'action_required',current:task.current,target:task.target,description:task.description,serverConfirmed:true});continue;}
        if(['accept','run'].includes(action)&&['','not_accepted'].includes(task.acceptStatus)){
          phase='accept';check();progress(phase,code);const ack=await api.accept([code]);check();const failure=acceptanceFailure(ack,code);if(failure){record({taskCode:code,...failure,serverConfirmed:failure.status==='accept_not_required'});if(failure.status!=='accept_not_required')continue;}
          else{const isAccepted=t=>!!t&&!['','not_accepted','error','failed','rejected'].includes(t.acceptStatus);task=await pollTask(code,isAccepted,pollDelays.slice(0,3));const accepted=isAccepted(task);record({taskCode:code,status:accepted?'accepted':'accept_unconfirmed',serverConfirmed:accepted});if(!accepted)continue;}
        }
        if(action==='accept')continue;
        if(task.claimed){record({taskCode:code,status:'already_claimed',serverConfirmed:true});continue;}if(task.locked){record({taskCode:code,status:'locked',serverConfirmed:true});continue;}
        const key='wb-management-task-claim:'+hash(accountId+'\0'+code),pending=service.ledger?.get(key);
        if(pending?.status==='submitted'){record({taskCode:code,status:'claim_unconfirmed',reason:'previous_submission_not_confirmed',serverConfirmed:false});continue;}
        const executor=availableExecutor;
        if(!task.claimable&&action==='run'&&typeof executor==='function'){
          phase='execution';check();progress(phase,code);record({taskCode:code,status:'execution_started',serverConfirmed:false});check();const execution=executionView(await executor({service,accountId,task,signal,check}))??{status:'unsupported',reason:'executor_result_invalid'};check();record({taskCode:code,status:'execution_'+execution.status,reason:execution.reason,execution,serverConfirmed:false});
          if(['deferred','unsupported'].includes(execution.status))continue;
          activeExecution=execution;phase='progress_poll';task=await pollProgress(code);
          if(task?.claimed){record({taskCode:code,status:'already_claimed',execution,serverConfirmed:true});continue;}
          if(task?.locked){record({taskCode:code,status:'locked',execution,serverConfirmed:true});continue;}
          if(!task?.claimable){record({taskCode:code,status:'task_accounting_pending',reason:task?'official_progress_not_confirmed':'official_task_missing',current:task?.current,target:task?.target,execution,serverConfirmed:false});continue;}
        }
        if(!task.claimable){record({taskCode:code,status:'action_required',current:task.current,target:task.target,description:task.description,serverConfirmed:true});continue;}
        phase='claim';check();progress(phase,code);service.ledger?.set(key,{status:'submitted',submittedAt:new Date().toISOString()});
        try{
          const claim=await api.claim(code);check();progress('query',code);tasks=await api.query();check();const after=tasks.find(t=>t.taskCode===code),confirmed=after?.claimed===true;
          if(confirmed)service.ledger?.set(key,{status:'confirmed',confirmedAt:new Date().toISOString()});
          record({taskCode:code,status:confirmed?'claimed':'claim_unconfirmed',serverConfirmed:confirmed,credit:confirmed?Number(claim.credit??0)||0:null,energy:confirmed?Number(claim.energy??0)||0:null,alreadyClaimed:claim.already_claimed===true});
        }catch(e){rethrowCancellation(e);record({taskCode:code,status:'claim_unconfirmed',phase,error:errorView(e),serverConfirmed:false});}
      }catch(e){rethrowCancellation(e);record({taskCode:code,status:'task_error',phase,error:errorView(e),serverConfirmed:false});if(phase==='progress_poll'&&activeExecution)record({taskCode:code,status:'task_accounting_pending',reason:'official_progress_query_failed',execution:activeExecution,error:errorView(e),serverConfirmed:false});}finally{completed++;progress(currentPhase,code,signal?.aborted?'cancelled':'item_finished');}
    }
    return {accountId,tasks,receipts};
  }catch(e){operationError=e;throw e;}finally{signal?.removeEventListener('abort',cancelling);active.delete(accountId);if(tasks&&!signal?.aborted)saveTaskSnapshot(service,accountId,tasks);if(operationError&&!signal?.aborted)saveTaskFailure(service,accountId,operationError);progress('finished',null,signal?.aborted?'cancelled':operationError?'failed':'completed');}
}
