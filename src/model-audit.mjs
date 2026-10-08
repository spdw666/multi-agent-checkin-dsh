import {Router} from './router.mjs';
import {collectChat} from './openai.mjs';
import {errorView,atomicJson} from './util.mjs';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
export const memoryRoot=process.env.AI_CREDIT_MEMORY??join(process.cwd(),'data','audit');
const names={passed:'全部通过',failed:'未通过',partial:'仅聊天 / 工具未通过',uncertain:'待复测',unavailable:'当前通道未提供',running:'检测中'};
export function auditLabel(row){return row?names[row.status]??row.status:'未测试';}
export async function saveAudit(service,report){
 service.ledger.set('model-audit',report);
 const dir=join(memoryRoot,'测试记录');await mkdir(dir,{recursive:true});await atomicJson(join(dir,'模型全量体检.json'),report);
 const esc=s=>String(s??'').replaceAll('|','/').replaceAll('\n',' ');
 await writeFile(join(dir,'模型全量体检.md'),'# 模型全量体检\n\n更新：'+report.updatedAt+'；进度 '+report.completed+'/'+report.total+'；状态 '+report.status+'。\n\n四项：普通回复、流式、工具调用、工具结果回传。超时/断连标记待复测，不当成永久不可用；未提供调用通道的条目单列。\n\n|平台|模型|普通|流式|工具|回传|结果|原因|\n|---|---|---|---|---|---|---|---|\n'+report.results.map(r=>'|'+[r.upstreamId,r.model,...['ordinary','stream','tools','roundtrip'].map(k=>{const t=r.tests?.find(t=>t.stage===k);return t?t.ok?'通过':t.status==='unsupported'?'未声明':'失败':'—'}),auditLabel(r),r.reason].map(esc).join('|')+'|').join('\n')+'\n','utf8');
}
export async function testModel(service,u,m,{timeoutMs=45000}={}){
 const result={upstreamId:u.id,platform:u.kind,model:m.id,name:m.name,startedAt:new Date().toISOString(),tests:[]};
 if(m.callable===false)return {...result,status:'unavailable',reason:m.unavailableReason};
 const routeId='audit/model',config={value:{...service.config.value,routes:[{id:routeId,targets:[{upstreamId:u.id,model:m.id}]}]}},router=new Router(config,service.platforms);
 const user={role:'user',content:'Reply with only AUDIT_OK.'},tool={type:'function',function:{name:'audit_add',description:'Adds two numbers locally',parameters:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}}};
 let toolMessage;
 for(const stage of ['ordinary','stream','tools','roundtrip']){
  if((stage==='tools'||stage==='roundtrip')&&m.tools!==true){result.tests.push({stage,ok:false,status:'unsupported',reason:'上游未声明结构化工具调用'});continue;}
  if(stage==='roundtrip'&&!toolMessage){result.tests.push({stage,ok:false,status:'skipped',reason:'前一步未产生有效工具调用'});continue;}
  const request={model:routeId,messages:[user],max_tokens:4096};
  if(stage==='tools'){request.messages=[{role:'user',content:'Use audit_add to add 2 and 3. You must call the tool, not calculate it yourself.'}];request.tools=[tool];request.tool_choice={type:'function',function:{name:'audit_add'}};}
  if(stage==='roundtrip'){request.messages=[{role:'user',content:'Use audit_add to add 2 and 3.'},toolMessage,{role:'tool',tool_call_id:toolMessage.tool_calls[0].id,content:'5'},{role:'user',content:'The local tool returned 5. Reply with only 5; do not call another tool.'}];request.tools=[tool];request.tool_choice='none';}
  const start=Date.now();try{
   let message;if(stage==='stream'){let text='',finished=false,chunks=0;for await(const c of router.chat({...request,stream:true},AbortSignal.timeout(timeoutMs))){text+=c.choices?.map(c=>c.delta?.content??'').join('')??'';finished||=c.choices?.some(c=>c.finish_reason!=null);chunks++;}if(!text.trim()||!finished)throw Error('流式没有完整文本或结束事件');message={content:text};result.tests.push({stage,ok:true,elapsedMs:Date.now()-start,chunks,text:text.slice(0,160)});continue;}
   const response=await collectChat(router.chat(request,AbortSignal.timeout(timeoutMs)));message=response.choices?.[0]?.message;
   if(stage==='tools'){const call=message?.tool_calls?.[0];if(call?.function?.name!=='audit_add')throw Error('模型未返回约定的结构化工具调用');const args=JSON.parse(call.function.arguments);if(args.a!==2||args.b!==3)throw Error('工具参数与输入不一致');toolMessage=message;}
   else if(!message?.content?.trim())throw Error('模型返回空文本');
   if(stage==='roundtrip'&&!/5/.test(message.content))throw Error('回传结果未得到确认');
   result.tests.push({stage,ok:true,elapsedMs:Date.now()-start,...(stage==='tools'?{tool:'audit_add',args:{a:2,b:3}}:{text:message.content.slice(0,160)})});
  }catch(e){const v=errorView(e);result.tests.push({stage,ok:false,elapsedMs:Date.now()-start,error:v});}
 }
 const bad=result.tests.filter(t=>!t.ok),hard=bad.find(t=>t.error?.status>=400&&t.error.status<500&&![408,429,499].includes(t.error.status));
 result.status=!bad.length?'passed':hard?'failed':result.tests.slice(0,2).every(t=>t.ok)?'partial':'uncertain';result.reason=bad.map(t=>t.stage+': '+(t.reason??t.error?.message??'未通过')).join('; ');result.finishedAt=new Date().toISOString();return result;
}
export function startModelAudit(service){
 if(service.auditPromise)return service.ledger.get('model-audit');
 const report={startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'running',total:0,completed:0,results:[]};service.ledger.set('model-audit',report);
 service.auditPromise=(async()=>{
  const jobs=[];for(const u of service.config.value.upstreams.filter(u=>u.enabled!==false)){try{for(const m of await service.platforms.models(u.id))jobs.push([u,m]);}catch(e){report.results.push({upstreamId:u.id,model:'catalog',status:'uncertain',reason:errorView(e).message,tests:[]});}}
  report.total=jobs.length+report.results.length;report.completed=report.results.length;await saveAudit(service,report);
  let index=0,saving=Promise.resolve();const persist=()=>{const snapshot=structuredClone(report);saving=saving.then(()=>saveAudit(service,snapshot));return saving;};
  const worker=async()=>{for(;;){const i=index++;if(i>=jobs.length)return;const [u,m]=jobs[i],r=await testModel(service,u,m);report.results.push(r);report.completed++;report.updatedAt=new Date().toISOString();await persist();await appendFile(join(memoryRoot,'测试记录','体检事件.jsonl'),JSON.stringify(r)+'\n','utf8');}};
  await Promise.all([worker(),worker()]);report.status='completed';report.updatedAt=new Date().toISOString();report.summary=Object.fromEntries(Object.keys(names).map(k=>[k,report.results.filter(r=>r.status===k).length]));await persist();return report;
 })().catch(async e=>{report.status='error';report.error=errorView(e);await saveAudit(service,report);return report;}).finally(()=>{service.auditPromise=undefined;});
 return report;
}
