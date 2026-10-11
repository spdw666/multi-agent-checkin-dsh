import {Router} from './router.mjs';
import {collectChat} from './openai.mjs';
import {errorView,atomicJson,AppError} from './util.mjs';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
export const memoryRoot=process.env.AI_CREDIT_MEMORY??'D:/AI Memory/AI积分网关-多平台签到与DSH反代';
const names={passed:'全部通过',failed:'未通过',partial:'仅聊天 / 工具未通过',uncertain:'待复测',unavailable:'当前通道未提供',running:'检测中'};
export function auditLabel(row){return row?.capabilityStatus==='chat_only'?'聊天通过 / 工具未声明':row?names[row.status]??row.status:'未测试';}
export async function saveAudit(service,report){
 service.ledger.set('model-audit',report);
 const dir=join(memoryRoot,'测试记录');await mkdir(dir,{recursive:true});await atomicJson(join(dir,'模型全量体检.json'),report);
 const esc=s=>String(s??'').replaceAll('|','/').replaceAll('\n',' ');
 await writeFile(join(dir,'模型全量体检.md'),'# 模型全量体检\n\n更新：'+report.updatedAt+'；进度 '+report.completed+'/'+report.total+'；状态 '+report.status+'。\n\n四项：普通回复、流式、工具调用、工具结果回传。超时/断连标记待复测，不当成永久不可用；未提供调用通道的条目单列。\n\n|平台|模型|普通|流式|工具|回传|结果|原因|\n|---|---|---|---|---|---|---|---|\n'+report.results.map(r=>'|'+[r.upstreamId,r.model,...['ordinary','stream','tools','roundtrip'].map(k=>{const t=r.tests?.find(t=>t.stage===k);return t?t.ok?'通过':t.status==='unsupported'?'未声明':'失败':'—'}),auditLabel(r),r.reason].map(esc).join('|')+'|').join('\n')+'\n','utf8');
}
export function auditStageTimeout(upstream,model){return upstream.kind==='nvidia'?(['moonshotai/kimi-k3','deepseek-ai/deepseek-v4.1-flash'].includes(model?.id)?600000:120000):45000;}
export function auditRoundtripMatches(text){const value=String(text??'').trim();return /^(?:5|`5`|\*\*5\*\*|\*5\*|__5__|_5_)$/.test(value)||/^```(?:text|plaintext|json)?[ \t]*\r?\n[ \t]*5[ \t]*\r?\n```$/i.test(value);}
export async function testModel(service,u,m,{timeoutMs=auditStageTimeout(u,m)}={}){
 const result={upstreamId:u.id,platform:u.kind,model:m.id,name:m.name,timeoutMs,...(m.auditReasoningEffort?{auditReasoningEffort:m.auditReasoningEffort}:{}),...(m.auditToolChoice?{auditToolChoice:m.auditToolChoice}:{}),startedAt:new Date().toISOString(),tests:[]};
 if(m.callable===false)return {...result,status:'unavailable',reason:m.unavailableReason};
 const routeId='audit/model',config={value:{...service.config.value,routes:[{id:routeId,targets:[{upstreamId:u.id,model:m.id}]}]}},router=new Router(config,service.platforms,{ledger:service.ledger});
 const user={role:'user',content:'Reply with only AUDIT_OK.'},tool={type:'function',function:{name:'audit_add',description:'Adds two numbers locally',parameters:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}}};
 let toolMessage;
 for(const stage of ['ordinary','stream','tools','roundtrip']){
  if((stage==='tools'||stage==='roundtrip')&&m.tools!==true){result.tests.push({stage,ok:false,status:'unsupported',reason:'上游未声明结构化工具调用'});continue;}
  if(stage==='roundtrip'&&!toolMessage){result.tests.push({stage,ok:false,status:'skipped',reason:'前一步未产生有效工具调用'});continue;}
  const request={model:routeId,messages:[user],max_tokens:Math.min(4096,m.maxTokens??4096)};
  if(m.auditReasoningEffort)request.reasoning_effort=m.auditReasoningEffort;
  if(stage==='tools'){request.messages=[{role:'user',content:'Use audit_add to add 2 and 3. You must call the tool, not calculate it yourself.'}];request.tools=[tool];request.tool_choice=m.auditToolChoice==='auto'?'auto':{type:'function',function:{name:'audit_add'}};}
  if(stage==='roundtrip'){request.messages=[{role:'user',content:'Use audit_add to add 2 and 3.'},toolMessage,{role:'tool',tool_call_id:toolMessage.tool_calls[0].id,content:'5'},{role:'user',content:'The local tool returned 5. Reply with only 5; do not call another tool.'}];request.tools=[tool];request.tool_choice='none';}
  const start=Date.now();try{
   let message;if(stage==='stream'){let text='',finished=false,chunks=0;for await(const c of router.chat({...request,stream:true},AbortSignal.timeout(timeoutMs),{source:"audit"})){text+=c.choices?.map(c=>c.delta?.content??'').join('')??'';finished||=c.choices?.some(c=>c.finish_reason!=null);chunks++;}if(!text.trim()||!finished)throw Error('流式没有完整文本或结束事件');message={content:text};result.tests.push({stage,ok:true,elapsedMs:Date.now()-start,chunks,text:text.slice(0,160)});continue;}
   const response=await collectChat(router.chat(request,AbortSignal.timeout(timeoutMs),{source:"audit"}));message=response.choices?.[0]?.message;
   if(stage==='tools'){const call=message?.tool_calls?.[0];if(call?.function?.name!=='audit_add')throw Error('模型未返回约定的结构化工具调用');const args=JSON.parse(call.function.arguments);if(args.a!==2||args.b!==3)throw Error('工具参数与输入不一致');toolMessage=message;}
   else if(!message?.content?.trim())throw Error('模型返回空文本');
   if(stage==='roundtrip'&&!auditRoundtripMatches(message.content))throw Error('回传结果未得到确认');
   result.tests.push({stage,ok:true,elapsedMs:Date.now()-start,...(stage==='tools'?{tool:'audit_add',args:{a:2,b:3}}:{text:message.content.slice(0,160)})});
  }catch(e){const v=errorView(e);result.tests.push({stage,ok:false,elapsedMs:Date.now()-start,error:v});}
 }
 const unsupported=result.tests.filter(t=>t.status==='unsupported'),bad=result.tests.filter(t=>!t.ok&&t.status!=='unsupported'),hard=bad.find(t=>t.error?.status>=400&&t.error.status<500&&![408,429,499].includes(t.error.status)&&!(t.error.status===400&&t.error.code==='codearts_chat_transient'));
 result.capabilityStatus=unsupported.length?(result.tests.slice(0,2).every(t=>t.ok)?'chat_only':'tools_undeclared'):'full';result.status=!bad.length?(unsupported.length?'partial':'passed'):hard?'failed':result.tests.slice(0,2).every(t=>t.ok)?'partial':'uncertain';result.reason=[...bad,...unsupported].map(t=>t.stage+': '+(t.reason??t.error?.message??'未通过')).join('; ');result.finishedAt=new Date().toISOString();return result;
}
const jobKey=r=>r.upstreamId+'\0'+r.model;
export function importedTargets(service,routeIds=null){
 const targets=new Map();
 for(const route of service.config.value.routes.filter(r=>r.enabled!==false&&(!routeIds||routeIds.includes(r.id)))){
  const rows=service.router?.pool?service.router.pool.candidates(route,{ignoreCooldown:true}):route.targets;
  for(const t of rows){const key=jobKey(t),prior=targets.get(key);if(prior)prior.routeIds.push(route.id);else targets.set(key,{...t,routeIds:[route.id]});}
 }
 return [...targets.values()];
}
export function selectedTargets(service,routeIds){
 if(!Array.isArray(routeIds)||!routeIds.length||routeIds.some(id=>typeof id!=='string'||!id.trim()))throw new AppError('Select at least one enabled route',400,'invalid_audit_selection');
 const unique=[...new Set(routeIds)];
 for(const id of unique){const route=service.config.value.routes.find(r=>r.id===id);if(!route||route.enabled===false)throw new AppError('Selected route is absent or disabled: '+id,400,'invalid_audit_selection');}
 const targets=importedTargets(service,unique);if(!targets.length)throw new AppError('Selected routes have no active targets',400,'invalid_audit_selection');return targets;
}
// A queued model gets its stage deadline only after its NVIDIA account lane is free.
export async function runAuditJobs(jobs,run,{concurrency=2}={}){
 const pending=[...jobs],active=new Set(),inflight=new Set();
 const lane=job=>job[0].kind==='nvidia'?'nvidia:'+String(job[0].accountId??job[0].id):null;
 while(pending.length||inflight.size){
  while(inflight.size<concurrency){const index=pending.findIndex(job=>!active.has(lane(job)));if(index<0)break;
   const job=pending.splice(index,1)[0],key=lane(job);if(key)active.add(key);
   let task;task=Promise.resolve().then(()=>run(job)).finally(()=>{if(key)active.delete(key);inflight.delete(task);});inflight.add(task);
  }
  if(inflight.size)await Promise.race(inflight);
 }
}
export function retryTargets(service,previous=service.ledger.get('model-audit')){
 const selected=new Map();
 for(const row of previous?.results??[]){
  if(!['failed','partial','uncertain','unavailable'].includes(row.status))continue;
  const u=service.config.value.upstreams.find(u=>u.id===row.upstreamId);
  if(!u||u.enabled===false||service.config.value.accounts?.find(a=>a.id===u.accountId)?.enabled===false)continue;
  selected.set(jobKey(row),{upstreamId:row.upstreamId,model:row.model,routeIds:row.routeIds??[]});
 }
 return [...selected.values()];
}
function preserveAttempt(row,previous){
 if(!previous||previous.status==='running')return row;
 const {previousAttempts,...last}=previous;
 return {...row,previousAttempts:[...(previousAttempts??[]),last].slice(-5)};
}
export function startModelAudit(service,options={}){
 if(!options||typeof options!=='object'||Array.isArray(options))throw new AppError('Audit body must be an object',400,'invalid_audit_scope');
 const {scope='all',routeIds}=options;
 if(!['all','imported','retry','selected'].includes(scope))throw new AppError('scope must be all, imported, retry or selected',400,'invalid_audit_scope');
 const selection=scope==='selected'?selectedTargets(service,routeIds):null;
 if(service.auditPromise){
  if(scope==='selected')throw new AppError('Model audit already running',409,'audit_in_progress');
  const active=service.auditReport??service.ledger.get('model-audit');
  if(active.scope!==scope){service.auditQueued=scope;active.queuedScope=scope;service.ledger.set('model-audit',active);}
  return active;
 }
 const previous=service.ledger.get('model-audit');
 const oldRows=new Map((previous?.results??[]).map(r=>[jobKey(r),r]));
 const report={scope,...(selection?{routeIds:[...new Set(routeIds)]}:{}),startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'running',total:0,completed:0,results:structuredClone(previous?.results??[]),jobKeys:[]};
 if(scope!=='all'){
  const pending=(selection??(scope==='imported'?importedTargets(service):retryTargets(service,previous))).map(t=>({...t,status:'running',reason:'刷新目录并准备本轮体检',tests:[]}));
  report.jobKeys=pending.map(jobKey);report.total=pending.length;const keys=new Set(report.jobKeys);
  report.results=report.results.filter(r=>!keys.has(jobKey(r))).concat(pending);
 }
 service.auditReport=report;service.ledger.set('model-audit',report);
 service.auditPromise=(async()=>{
  const jobs=[],fresh=[],resolvedCatalogKeys=new Set(),selected=selection??(scope==='imported'?importedTargets(service):scope==='retry'?retryTargets(service,previous):null),c=service.config.value;
  const upstreams=selected?[...new Set(selected.map(t=>t.upstreamId))].map(id=>c.upstreams.find(u=>u.id===id)??{id,kind:'unknown',enabled:false}):c.upstreams.filter(u=>u.enabled!==false);
  for(const u of upstreams){
   const wanted=selected?.filter(t=>t.upstreamId===u.id);
   try{
    if(u.enabled===false||c.accounts?.find(a=>a.id===u.accountId)?.enabled===false)throw new AppError('Route account/upstream is disabled',409,'upstream_disabled');
    const catalog=await service.platforms.models(u.id,{refresh:true,signal:AbortSignal.timeout(45000)});
    resolvedCatalogKeys.add(jobKey({upstreamId:u.id,model:'catalog'}));
    if(wanted){for(const t of wanted){if(t.model==='catalog'){for(const m of catalog)jobs.push([u,m,t.routeIds]);continue;}const m=catalog.find(m=>m.id===t.model)??{id:t.model,callable:false,unavailableReason:'Model absent from refreshed live catalog'};jobs.push([u,m,t.routeIds]);}}
    else for(const m of catalog)jobs.push([u,m,[]]);
   }catch(e){for(const t of wanted??[{model:'catalog',routeIds:[]}]){const row={upstreamId:u.id,platform:u.kind,model:t.model,routeIds:t.routeIds,status:e.code==='zcode_no_active_entitlement'?'unavailable':'uncertain',reason:errorView(e).message,error:errorView(e),tests:[],finishedAt:new Date().toISOString()};fresh.push(preserveAttempt(row,oldRows.get(jobKey(row))));}}
  }
  const uniqueJobs=new Map();for(const job of jobs){const key=jobKey({upstreamId:job[0].id,model:job[1].id}),prior=uniqueJobs.get(key);if(prior)prior[2]=[...new Set([...prior[2],...job[2]])];else uniqueJobs.set(key,job);}jobs.splice(0,jobs.length,...uniqueJobs.values());
  const running=jobs.map(([u,m,routeIds])=>({upstreamId:u.id,platform:u.kind,model:m.id,name:m.name,routeIds,status:'running',reason:'本轮体检排队中',tests:[]}));
  report.jobKeys=[...running,...fresh].map(jobKey);const replace=new Set(report.jobKeys);
  // Unrelated models retain their timestamped history; selected models lose stale green badges immediately.
  report.results=report.results.filter(r=>!replace.has(jobKey(r))&&(scope==='selected'||!resolvedCatalogKeys.has(jobKey(r)))).concat(running,fresh);
  report.total=report.jobKeys.length;report.completed=fresh.length;await saveAudit(service,report);
  let saving=Promise.resolve();const persist=()=>{const snapshot=structuredClone(report);saving=saving.then(()=>saveAudit(service,snapshot));return saving;};
  const worker=async([u,m,routeIds])=>{const row={...await testModel(service,u,m),routeIds},r=preserveAttempt(row,oldRows.get(jobKey(row)));report.results[report.results.findIndex(old=>jobKey(old)===jobKey(r))]=r;report.completed++;report.updatedAt=new Date().toISOString();await persist();await appendFile(join(memoryRoot,'测试记录','体检事件.jsonl'),JSON.stringify(r)+'\n','utf8');};
  await runAuditJobs(jobs,worker);report.status='completed';report.updatedAt=new Date().toISOString();report.summary=Object.fromEntries(Object.keys(names).map(k=>[k,report.results.filter(r=>replace.has(jobKey(r))&&r.status===k).length]));await persist();return report;
 })().catch(async e=>{report.status='error';report.error=errorView(e);await saveAudit(service,report);return report;}).finally(()=>{service.auditPromise=undefined;service.auditReport=undefined;const queued=service.auditQueued;service.auditQueued=undefined;if(queued)startModelAudit(service,{scope:queued});});
 return report;
}
