import {mkdir,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';
import {AppError,hash,redact,errorView} from './util.mjs';
import {withWorkBuddyExecutorLease} from './workbuddy-executor-lease.mjs';
import {runWorkBuddyOfficialCli} from './workbuddy-executor-cli.mjs';
import {runWorkBuddyOfficialAcp,executeWorkBuddyAcpFeature} from './workbuddy-executor-acp.mjs';
import {prepareWorkBuddyMarketSkill} from './workbuddy-executor-skill.mjs';
import {prepareWorkBuddyDesign} from './workbuddy-executor-design.mjs';
import {executeWorkBuddyApiFeature} from './workbuddy-executor-api.mjs';
import {executeWorkBuddyCliSchedule} from './workbuddy-executor-schedule.mjs';
import {executeWorkBuddyAccountFeature} from './workbuddy-executor-account-features.mjs';
import {normalizeBalance,boundedBalanceRead} from './balances.mjs';
import {prepareWorkBuddyExpert} from './workbuddy-executor-expert.mjs';

const known={chat_5:'chat',RichMeow_Chat:'chat',first_buddy:'chat','Model_chat_GLM5.2':'glm_chat',black_cat:'night_chat',skill_1:'skill',create_canvas:'design',automation_1:'automation',Library_read:'library_read',playbook_prompt:'playbook',template_5:'template',expert_5:'expert',Expert_team_use_3:'expert_team',Expert_lighthouse:'expert_lighthouse',Hp_Appearance:'appearance',Buddy_App:'buddy_app',Buddy_App_QQ:'buddy_app_qq',wb_wechat_oa_subscribe_task:'external_wait'};
const active=new WeakMap(),now=()=>new Date().toISOString(),emptyResult=(status,feature,reason,other={})=>({status,feature,reason,kind:'official_workbuddy_feature',checkedAt:now(),...other});
function planCount(task){const expected={chat_5:5,expert_5:5,Expert_team_use_3:3,template_5:5,black_cat:3}[task.taskCode]??1;const target=task.target>0?task.target:expected;return Math.min(10,Math.max(0,target-(Number(task.current)||0)));}
async function executeCliFeature(ctx,feature,index,onBeforeSpawn){
 const {service,accountId,task,signal,check,operationId}=ctx,runner=['expert','expert_team','expert_lighthouse'].includes(feature)?service.workbuddyRuntime?.runOfficialAcp??service.workbuddyRuntime?.runOfficialCli??runWorkBuddyOfficialAcp:service.workbuddyRuntime?.runOfficialCli??runWorkBuddyOfficialCli;
 if(feature==='template')return (service.workbuddyRuntime?.executeAcpFeature??executeWorkBuddyAcpFeature)({...ctx,operationId:operationId+':'+index,index,markSubmitted:onBeforeSpawn,action:{kind:'template',...ctx.action}});
 let prompt='请用中文提供一条具体可执行的文件整理技巧，30字以内。不要访问用户其他文件，不要创建外部服务或发消息。',model=feature==='glm_chat'||feature==='night_chat'?'glm-5.2':'fast-model',prepare,requireTool,requireArtifact=false,verifyResult,allowedTools='Read,Write';
 if(feature==='skill'){
  prepare=opts=>prepareWorkBuddyMarketSkill({...ctx,...opts});requireTool=/^Skill$/;allowedTools='Skill,Read,Bash';
 }else if(feature==='design'){
  prepare=opts=>prepareWorkBuddyDesign({...ctx,...opts});requireTool=/create_design/;requireArtifact=true;allowedTools='Read,Write,mcp__ardot__create_design,mcp__ardot__fetch_file_info,mcp__ardot__batch_read,mcp__ardot__batch_design';
  prompt='请真正调用 Ardot create_design 新建一个名为「自动任务体验-文件整理流程」的设计画布，用可用设计工具绘制三个节点：收集→分类→归档。创建后必须调用 fetch_file_info 或 batch_read 读回同一个 fileId，并确认画布内容存在。不要伪造fileId或仅描述。不要修改已有画布。';
  verifyResult=async result=>result.artifacts.some(a=>a.kind==='design'&&result.designReadbacks?.some(r=>r.id===a.id&&r.contentPresent===true));
 }else if(feature==='playbook'||feature==='template'){
  const fetchImpl=service.workbuddyRuntime?.fetchImpl??fetch;check();const r=await fetchImpl('https://static.workbuddy.cn/workbuddy/playbook/registry.json',{signal,redirect:'error'});if(!r.ok)throw new AppError('官方灵感目录暂未就绪',502,'wb_playbook_catalog_unavailable');const registry=await r.json(),cases=Array.isArray(registry.cases)?registry.cases:[];const selected=cases.filter(c=>/工作|整理|计划|复盘|清单/.test(String(c.title??'')))[index%Math.max(1,cases.length)]??cases[index%Math.max(1,cases.length)];if(!selected||!/^[a-zA-Z0-9_-]+$/.test(selected.id))return emptyResult('deferred',feature,'official_playbook_not_available');
  const detailResponse=await fetchImpl('https://static.workbuddy.cn/workbuddy/playbook/cases/'+selected.id+'/case.json',{signal,redirect:'error'});if(!detailResponse.ok)throw new AppError('官方灵感内容暂未就绪',502,'wb_playbook_case_unavailable');const detail=await detailResponse.json(),original=detail.prompt??detail.user_prompt??detail.content?.prompt??detail.prompts?.[0]?.text;
  if(typeof original!=='string'||!original.trim())return emptyResult('deferred',feature,'official_playbook_prompt_missing');
  prompt='请实际体验以下官方灵感案例，按案例要求完成一个小型样例。仅使用虚构示例数据，不连接或修改用户外部账号，不发布或购买服务；产物写在当前目录。若案例依赖未授权外部服务，请明确返回依赖待就绪，不要虚构完成。案例：'+String(selected.title)+'\n'+original.slice(0,18000);allowedTools='Read,Write,Skill,Bash';
 }else if(['expert','expert_team','expert_lighthouse'].includes(feature)){
  prepare=opts=>prepareWorkBuddyExpert({...ctx,...opts,index});allowedTools='Agent,Read,Write';prompt='请运用当前专家的真实专业背景，给出3条入门建议，不进行外部操作。';if(feature==='expert_team')verifyResult=async result=>Array.isArray(result.feature?.memberNames)&&result.feature.memberNames.length>0&&result.feature.memberNames.every(name=>result.completedTools.some(t=>t.name==='Agent'&&t.subagentType===name));
 }else if(['appearance','buddy_app','buddy_app_qq'].includes(feature)){
  return (service.workbuddyRuntime?.executeAccountFeature??executeWorkBuddyAccountFeature)({...ctx,index,markSubmitted:onBeforeSpawn,action:{kind:feature,...ctx.action}});
 }
 if(service.platforms?.health){check();signal?.throwIfAborted();let balance;try{balance=normalizeBalance('workbuddy',await boundedBalanceRead(()=>service.platforms.health(accountId),20000));}catch{check();signal?.throwIfAborted();return emptyResult('deferred',feature,'official_balance_unconfirmed');}check();signal?.throwIfAborted();if(typeof balance.value!=='number'||balance.value<=0)return emptyResult('deferred',feature,balance.value===0?'official_credits_exhausted':'official_balance_unknown');}
 const account=service.config.value.accounts.find(a=>a.id===accountId);if(account?.enabled===false)return emptyResult('deferred',feature,'account_disabled');
 const r=await runner({service,accountId,operationId:operationId+':'+index,prompt,model,prepare,requireTool,requireArtifact,verifyResult,allowedTools,signal,check,onBeforeSpawn});
 return {...emptyResult(r.valid?'completed':r.errorBeforeSideEffect?'deferred':'pending',feature,r.valid?null:r.reason),evidence:{exitCode:r.exitCode,normalTerminal:r.normalTerminal,completedTools:r.completedTools?.map(t=>t.name)??[],artifacts:r.artifacts??[],contentChars:r.contentChars??0,terminalState:r.terminalState??null},performed:r.valid===true};
}
export async function executeRegisteredWorkBuddyTask({service,accountId,task,signal,check=()=>{}}){
 const feature=known[task.taskCode];if(!feature)return emptyResult('unsupported','unknown','unknown_official_task');
 check();signal?.throwIfAborted();if(feature==='external_wait')return emptyResult('deferred',feature,'official_subscription_24h_or_external_prerequisite');
 if(feature==='night_chat'){const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date());if(Number(time)>=8&&Number(time)<23)return emptyResult('deferred',feature,'outside_official_activity_window');}
 const credential=await service.credentials.resolve(accountId),principal=hash(String(credential.uid??credential.principal)),period=/daily|每日/.test(task.taskType??'')?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()):'',key='wb-real-execution:'+hash(accountId+'\0'+principal+'\0'+task.taskCode+'\0'+period);
 let flights=active.get(service);if(!flights){flights=new Map();active.set(service,flights);}if(flights.has(key))return flights.get(key);
 const run=withWorkBuddyExecutorLease(service,key,async assertOwned=>{
  const originalCheck=check;check=()=>{originalCheck();assertOwned();};
  const prior=service.ledger?.get(key),plan=prior??{operationId:hash(key).slice(0,24),taskCode:task.taskCode,feature,totalActions:planCount(task),steps:[],createdAt:now()};
  if(plan.totalActions===0)return emptyResult('completed',feature,null,{operationId:plan.operationId,completedActions:0,totalActions:0});
  const persist=()=>{assertOwned();service.ledger?.set(key,plan);};persist();
  for(let i=0;i<plan.totalActions;i++){
   check();signal?.throwIfAborted();const old=plan.steps[i];if(old?.status==='completed')continue;if(old?.status==='deferred'&&old.reason==='tool_permission_denied')return emptyResult('deferred',feature,'tool_permission_denied',{operationId:plan.operationId,completedActions:plan.steps.filter(s=>s?.status==='completed').length,totalActions:plan.totalActions});
   if((old?.status==='submitted'||old?.status==='pending')&&!['automation','library_read'].includes(feature)){
    // Unknown side effects are queried by the task engine; never repeat paid
    // generation or create a second resource after a transport/worker failure.
    return emptyResult('pending',feature,'previous_real_action_awaiting_confirmation',{operationId:plan.operationId,completedActions:plan.steps.filter(s=>s?.status==='completed').length,totalActions:plan.totalActions});
   }
   const markSubmitted=async data=>{plan.steps[i]={...plan.steps[i],status:'submitted',submittedAt:now(),...(data?.resourceId?{resourceId:data.resourceId}:{}),...(data?.phase?{phase:data.phase}:{})};persist();};
   const context={service,accountId,task,signal,check,operationId:plan.operationId,action:{kind:feature,...old,submitted:['submitted','pending'].includes(old?.status)},markSubmitted};
   let result;try{
    if(feature==='automation')result=await (service.workbuddyRuntime?.executeSchedule??executeWorkBuddyCliSchedule)(context);
    else if(feature==='library_read')result=await (service.workbuddyRuntime?.executeApiFeature??executeWorkBuddyApiFeature)(context);
    else result=await executeCliFeature(context,feature,i,markSubmitted);
   }catch(error){if(signal?.aborted)throw error;if(error.beforeSubmission===true){plan.steps[i]={status:'deferred',reason:errorView(error).code??'executor_not_started',beforeSubmission:true,checkedAt:now()};persist();return emptyResult('deferred',feature,plan.steps[i].reason,{operationId:plan.operationId,completedActions:plan.steps.filter(s=>s?.status==='completed').length,totalActions:plan.totalActions});}if(plan.steps[i]?.status==='submitted'){plan.steps[i]={...plan.steps[i],status:'pending',reason:errorView(error).code??'real_action_unconfirmed',checkedAt:now()};persist();return emptyResult('pending',feature,plan.steps[i].reason,{operationId:plan.operationId,completedActions:plan.steps.filter(s=>s?.status==='completed').length,totalActions:plan.totalActions});}throw error;}
   if(!['completed','pending','deferred','unsupported'].includes(result?.status))throw new AppError('真实执行器结果结构错误',502,'wb_executor_result_invalid');
   plan.steps[i]={...plan.steps[i],status:result.status,checkedAt:now(),reason:result.reason??null,evidence:result.evidence??null,...(result.evidence?.resourceId?{resourceId:result.evidence.resourceId}:{})};persist();
   if(result.status!=='completed')return {...result,operationId:plan.operationId,completedActions:plan.steps.filter(s=>s?.status==='completed').length,totalActions:plan.totalActions};
  }
  return emptyResult('completed',feature,null,{operationId:plan.operationId,completedActions:plan.steps.filter(s=>s?.status==='completed').length,totalActions:plan.totalActions});
 });flights.set(key,run);try{return await run;}finally{if(flights.get(key)===run)flights.delete(key);}
}
export function registerWorkBuddyTaskExecutors(service){const map=new Map();for(const [code,feature]of Object.entries(known)){const execute=context=>executeRegisteredWorkBuddyTask({...context,service});execute.capability={kind:['automation','library_read'].includes(feature)?'official_api':'official_cli',feature,needsDesktop:!['automation','library_read','external_wait'].includes(feature),requiresWindow:false};map.set(code,execute);}service.workbuddyTaskExecutors=map;return map;}
