// Official growth task list/accept/claim protocol reviewed against MIT
// workbuddy2api-panel 6b31db6d045e985042620c819c3a938002e7b0b1.
// A task is complete only when a fresh official query confirms it. This module
// never fabricates automation/canvas/chat/expert usage or completion telemetry.
import {AppError,errorView,rememberSecret,hash,redact} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {workBuddyFailure,workBuddyUpstreamError,isWorkBuddyBlocked} from './workbuddy-status.mjs';

const locks=new WeakMap();
export function normalizeWorkBuddyTask(raw) {
  const code=redact(String(raw.task_code??raw.code??'')),current=Number(raw.progress?.current??raw.current??0),target=Number(raw.progress?.target??raw.target??0),claimed=raw.accept_status==='claimed'||raw.claimed===true;
  const rewardCredit=Number(raw.reward_credit??raw.credit??0)||0,rewardEnergy=Number(raw.reward_energy??raw.energy??0)||0;
  const qualified=target>0&&current>=target;
  return {taskCode:code,title:String(raw.title??code),name:String(raw.title??code),description:String(raw.description??raw.task_desc??''),taskDesc:String(raw.task_desc??''),current:Number.isFinite(current)?current:0,progress:Number.isFinite(current)?current:0,target:Number.isFinite(target)?target:0,rewardCredit,rewardEnergy,rewardBuddy:raw.reward_buddy===true,hasReward:raw.has_reward??(rewardCredit>0||rewardEnergy>0||raw.reward_buddy===true),reward:rewardCredit+' 积分'+(rewardEnergy?' + '+rewardEnergy+' 能量':'')+(raw.reward_buddy?' + Buddy':''),taskType:String(raw.task_type??''),tag:String(raw.tag??''),acceptStatus:String(raw.accept_status??''),accepted:!['','not_accepted'].includes(String(raw.accept_status??'')),qualified,serverStatus:String(raw.status??''),status:claimed?'claimed':raw.locked?'locked':String(raw.accept_status??raw.status??'not_accepted'),claimed,locked:raw.locked===true,claimable:!claimed&&raw.locked!==true&&qualified,jumpUrl:typeof raw.jump_url==='string'?raw.jump_url:null,automaticExecution:false,executionStrategy:'manual_action_required',lastReceipt:null};
}
export class WorkBuddyTaskClient {
  constructor(credential,{fetchImpl=fetch,signal}={}){this.credential=credential;this.fetchImpl=fetchImpl;this.signal=signal;}
  async request(path,{body,web=false}={}) {
    const c=this.credential;if(workBuddyEdition(c)!=='cn')throw new AppError('当前 WB 档位未声明积分成长任务',409,'wb_growth_not_available');
    rememberSecret(c.accessToken);const base=web?'https://www.workbuddy.cn':'https://copilot.tencent.com';
    const timeout=AbortSignal.timeout(20000),signal=this.signal?AbortSignal.any([this.signal,timeout]):timeout;
    const response=await this.fetchImpl(base+path,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+c.accessToken,'X-Domain':c.domain??'www.workbuddy.cn','X-User-Id':String(c.uid??c.principal),...(web?{'X-Client-Platform':'web',Origin:'https://www.workbuddy.cn',Referer:'https://www.workbuddy.cn/profile/growth-center'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal});
    let data;try{data=await response.json();}catch{throw new AppError('WB 任务响应待确认',response.ok?502:response.status,'wb_task_response_invalid');}
    if(!response.ok||data.code!==undefined&&![0,200,'0','200'].includes(data.code)){const e=workBuddyUpstreamError(response,data,'WB 任务请求被服务端拒绝');e.code='wb_task_request_rejected';throw e;}return data.data??data;
  }
  async query(){const data=await this.request('/v2/activity/growth/tasks');if(!Array.isArray(data.tasks))throw new AppError('WB 服务端任务列表结构待确认',502,'wb_task_schema_invalid');return data.tasks.map(normalizeWorkBuddyTask).filter(t=>t.taskCode);}
  async accept(codes){return this.request('/v2/activity/growth/tasks/accept',{body:{task_codes:codes}});}
  async claim(code){return this.request('/activity/growth/tasks/'+encodeURIComponent(code)+'/claim',{body:{},web:true});}
}
async function client(service,accountId,signal){const a=service.config.value.accounts.find(a=>a.id===accountId&&a.platform==='workbuddy'&&a.enabled!==false);if(!a)throw new AppError('WB 帐号不存在或已停用',404,'account_not_found');return new WorkBuddyTaskClient(await service.credentials.resolve(accountId),{fetchImpl:service.workbuddyRuntime?.fetchImpl??fetch,signal});}
export function workBuddyReceiptView(receipt){if(!receipt||typeof receipt!=='object')return null;const view={};for(const key of ['accountId','action','taskCode','status','checkedAt','serverConfirmed','credit','energy','current','target','reason','description','alreadyClaimed'])if(['string','boolean','number'].includes(typeof receipt[key]))view[key]=typeof receipt[key]==='string'?redact(receipt[key]).slice(0,1000):receipt[key];if(receipt.error)view.error=workBuddyFailure(receipt.error);return view;}
export function workBuddyTaskSnapshot(service,accountId){const row=service.ledger?.get('wb-management-tasks:'+accountId)??{accountId,tasks:[],checkedAt:null,lastSuccessAt:null,lastFailureAt:null,stale:false,error:null,receipts:service.ledger?.get('wb-management-task-receipts:'+accountId)??[]};return {...row,receipts:(row.receipts??[]).map(workBuddyReceiptView)};}
function saveTaskSnapshot(service,accountId,tasks,receipts){
  const checkedAt=new Date().toISOString();receipts=(receipts??service.ledger?.get('wb-management-task-receipts:'+accountId)??[]).map(workBuddyReceiptView);
  for(const task of tasks){task.automaticExecution=service.workbuddyTaskExecutors?.has(task.taskCode)===true;task.executionStrategy=task.claimed?'already_claimed':task.locked?'locked':task.claimable?'claim_server_confirmed_reward':task.automaticExecution?'registered_executor_then_verify':'manual_action_required';task.lastReceipt=[...receipts].reverse().find(r=>r.taskCode===task.taskCode)??null;}
  const row={accountId,tasks,checkedAt,lastSuccessAt:checkedAt,lastFailureAt:null,stale:false,error:null,source:'official_growth_tasks',automaticScope:'accept_and_server_confirmed_rewards',receipts};service.ledger?.set('wb-management-tasks:'+accountId,row);return row;
}
function saveTaskFailure(service,accountId,error){const old=workBuddyTaskSnapshot(service,accountId),row={...old,lastFailureAt:new Date().toISOString(),stale:!!old.lastSuccessAt,error:workBuddyFailure(error)};service.ledger?.set('wb-management-tasks:'+accountId,row);if(row.error.banned)service.ledger?.set('wb-management-official-status:'+accountId,{status:'banned',reason:row.error.message,source:'official_response',checkedAt:row.lastFailureAt,httpStatus:row.error.httpStatus,upstreamCode:row.error.upstreamCode});return row;}
export async function queryWorkBuddyTasks(service,{accountId,signal}={}) {
  try{return saveTaskSnapshot(service,accountId,await(await client(service,accountId,signal)).query());}catch(e){saveTaskFailure(service,accountId,e);throw e;}
}
export async function runWorkBuddyTasks(service,{accountId,action='run',taskCodes,taskCode,automatic=false,signal}={}) {
  if(accountId===undefined||accountId===null){
    if(!['run','query','accept','claim'].includes(action))throw new AppError('WB 任务操作格式错误',400,'wb_task_action_invalid');
    const results=[];for(const a of service.config.value.accounts.filter(a=>a.platform==='workbuddy'&&a.enabled!==false&&!isWorkBuddyBlocked(service,a.id))){signal?.throwIfAborted();try{results.push(await runWorkBuddyTasks(service,{accountId:a.id,action,taskCodes,taskCode,automatic,signal}));}catch(e){results.push({accountId:a.id,status:'error',error:errorView(e),tasks:[],receipts:[{accountId:a.id,action,status:'error',error:errorView(e)}]});}}
    return {action,results,tasks:results.flatMap(r=>(r.tasks??[]).map(t=>({...t,accountId:r.accountId}))),receipts:results.flatMap(r=>r.receipts??[])};
  }
  if(!['run','query','accept','claim'].includes(action))throw new AppError('WB 任务操作格式错误',400,'wb_task_action_invalid');if(action==='query')return queryWorkBuddyTasks(service,{accountId});
  if(taskCode!==undefined)taskCodes=[taskCode];if(taskCodes!==undefined&&(!Array.isArray(taskCodes)||taskCodes.some(t=>typeof t!=='string'||!t||t.length>256)))throw new AppError('WB 任务标识格式错误',400,'wb_task_code_invalid');
  let active=locks.get(service);if(!active){active=new Set();locks.set(service,active);}if(active.has(accountId))throw new AppError('该 WB 帐号的积分任务正在执行',409,'wb_tasks_busy');active.add(accountId);
  let tasks,operationError;const receipts=[],record=receipt=>{const full={accountId,action,checkedAt:new Date().toISOString(),...receipt};receipts.push(full);return full;};
  const check=()=>{signal?.throwIfAborted();if(automatic&&service.config.value.workbuddy?.autoTasks!==true)throw new AppError('WB 自动任务已暂停',499,'wb_tasks_cancelled');};
  try{
    check();if(isWorkBuddyBlocked(service,accountId))throw new AppError('WB 帐号已标记封禁，请先核验或删除该帐号',409,'wb_account_banned');const api=await client(service,accountId,signal);tasks=await api.query();check();if(taskCodes?.some(code=>!tasks.some(t=>t.taskCode===code)))throw new AppError('所选任务不在当前官方任务列表',404,'wb_task_not_found');const selected=()=>tasks.filter(t=>!taskCodes||taskCodes.includes(t.taskCode));
    if(action==='run'&&!taskCodes){const receipt=await service.claims.run(accountId,'daily-checkin');record({taskCode:'daily-checkin',status:receipt.status,receipt,serverConfirmed:receipt.serverConfirmed===true||receipt.reason==='server_already_claimed'});}
    if(['accept','run'].includes(action)){
      const codes=selected().filter(t=>!t.claimed&&!t.locked&&['','not_accepted'].includes(t.acceptStatus)).map(t=>t.taskCode);
      if(codes.length){check();await api.accept(codes);tasks=await api.query();for(const code of codes){const after=tasks.find(t=>t.taskCode===code);record({taskCode:code,status:after&&!['','not_accepted'].includes(after.acceptStatus)?'accepted':'accept_unconfirmed',serverConfirmed:!!after&&!['','not_accepted'].includes(after.acceptStatus)});}}
      if(action==='accept')return {accountId,tasks,receipts};
    }
    for(const task of selected()){
      check();
      if(task.claimed){record({taskCode:task.taskCode,status:'already_claimed',serverConfirmed:true});continue;}if(task.locked){record({taskCode:task.taskCode,status:'locked',serverConfirmed:true});continue;}
      if(!task.claimable&&action==='run'&&service.workbuddyTaskExecutors?.has(task.taskCode)){
        const execution=await service.workbuddyTaskExecutors.get(task.taskCode)({service,accountId,task});record({taskCode:task.taskCode,status:'action_executed',execution});tasks=await api.query();Object.assign(task,tasks.find(t=>t.taskCode===task.taskCode));
      }
      if(!task.claimable){record({taskCode:task.taskCode,status:'action_required',current:task.current,target:task.target,description:task.description,serverConfirmed:true});continue;}
      const key='wb-management-task-claim:'+hash(accountId+'\0'+task.taskCode),pending=service.ledger?.get(key);
      if(pending?.status==='submitted'){record({taskCode:task.taskCode,status:'claim_unconfirmed',reason:'previous_submission_not_confirmed',serverConfirmed:false});continue;}
      service.ledger?.set(key,{status:'submitted',submittedAt:new Date().toISOString()});let claim;
      try{claim=await api.claim(task.taskCode);}catch(e){record({taskCode:task.taskCode,status:'claim_unconfirmed',error:errorView(e),serverConfirmed:false});continue;}
      tasks=await api.query();const after=tasks.find(t=>t.taskCode===task.taskCode),confirmed=after?.claimed===true;
      if(confirmed)service.ledger?.set(key,{status:'confirmed',confirmedAt:new Date().toISOString()});
      record({taskCode:task.taskCode,status:confirmed?'claimed':'claim_unconfirmed',serverConfirmed:confirmed,credit:confirmed?Number(claim.credit??0)||0:null,energy:confirmed?Number(claim.energy??0)||0:null,alreadyClaimed:claim.already_claimed===true});
    }
    return {accountId,tasks,receipts};
  }catch(e){operationError=e;throw e;}finally{active.delete(accountId);service.ledger?.set('wb-management-task-receipts:'+accountId,receipts.slice(-200));if(tasks)saveTaskSnapshot(service,accountId,tasks,receipts.slice(-200));if(operationError)saveTaskFailure(service,accountId,operationError);}
}
