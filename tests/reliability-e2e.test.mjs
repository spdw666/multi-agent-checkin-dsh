import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Identical HTTP-level correct expectations run against baseline, stage and
// independent rollback copies. No real provider, credentials or database.
const root=process.env.GATEWAY_RELIABILITY_ROOT??process.env.GATEWAY_TEST_ROOT;
const moduleUrl=name=>root?pathToFileURL(resolve(root,'src',name)).href:new URL('../src/'+name,import.meta.url).href;
const {startServer}=await import(moduleUrl('server.mjs'));
const {Router}=await import(moduleUrl('router.mjs'));
const {AppError}=await import(moduleUrl('util.mjs'));
const {relayDefaults}=await import(moduleUrl('model-relay.mjs'));
const {buildActivityContext}=await import(moduleUrl('activity-context.mjs'));
const model='deepseek-v4.1-flash',routeId='SAMPLE/'+model;
const jsonAnswer=(content='SAMPLE_FINAL')=>({response:Response.json({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]})});
const sse=events=>({response:new Response(events.map(e=>`data: ${typeof e==='string'?e:JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})});
const request=(stream=false)=>({model:routeId,stream,max_tokens:4096,
 messages:[{role:'system',content:'Preserve every original tool call and result.'},{role:'user',content:'SAMPLE_UTF8_'+'中🙂'.repeat(20000)},
  {role:'assistant',content:null,tool_calls:[{id:'call_SAMPLE_original',type:'function',function:{name:'sample_read',arguments:'{"path":"SAMPLE"}'}}]},
  {role:'tool',tool_call_id:'call_SAMPLE_original',content:'SAMPLE_TOOL_COMPLETE_'+'结果'.repeat(3000)},
  {role:'user',content:'Continue after this exact tool result.'}],
 tools:[{type:'function',function:{name:'sample_read',description:'SAMPLE complete schema',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}],tool_choice:'auto',parallel_tool_calls:false});
async function fixture(t,{ids=['primary','standby'],privateDsh=false,requestTimeoutMs=5000,attemptTimeoutMs=1000}={}){
 const rows=[],events=[],state=new Map(),calls=[],catalogCalls=[];
 const config={value:{server:{host:'127.0.0.1',port:0,requestTimeoutMs},modelRelay:{...relayDefaults,enabled:true},
  accounts:ids.map(id=>({id,platform:'SAMPLE'})),upstreams:ids.map(id=>({id,accountId:id,kind:id==='primary'?'loomy':'freeapi'})),
  routes:ids.map((id,i)=>({id:i===0?routeId:'SAMPLE_'+id+'/'+model,targets:[{upstreamId:id,model}]}))}};
 const metadata=Object.fromEntries(ids.map(id=>[id,{id:model,callable:true,tools:true,multimodal:true,contextWindow:1000000,maxTokens:64000}]));
 const ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v),record:e=>events.push(structuredClone(e)),records:()=>events,
  usage:()=>({records:rows.map((r,i)=>({id:i+1,...r})),total:rows.length}),
  beginUsage:r=>(rows.push(structuredClone(r)),rows.length-1),finishUsage:(id,r)=>{rows[id]=structuredClone(r);}};
 const platforms={models:async id=>(catalogCalls.push(id),[metadata[id]]),chat:async(target,raw,signal)=>{
  calls.push({id:target.upstreamId,request:structuredClone(raw),signal});return jsonAnswer();}};
 const router=new Router(config,platforms,{ledger,relayAttemptTimeoutMs:attemptTimeoutMs,relayPrefillTimeoutMs:attemptTimeoutMs,relayNetworkRetryDelayMs:0});
 const server=await startServer({config,router,ledger,keys:{apiKey:'SAMPLE_KEY',adminKey:'SAMPLE_ADMIN'}},{port:0,admin:!privateDsh});
 t.after(()=>server.close());
 const post=(body,{source='hermes',signal,headers={}}={})=>fetch(server.baseUrl+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer SAMPLE_KEY','content-type':'application/json','x-ai-credit-source':source,...headers},body:JSON.stringify(body),signal});
 const originalChat=platforms.chat;
 return {config,metadata,ledger,rows,events,state,calls,catalogCalls,platforms,router,server,post,originalChat};
}
for(const [source,privateDsh] of [['dsh',true],['hermes',false]]){
 test(`HTTP ${source}: nonstream long tool history remains exact through a supplier handoff`,async t=>{
  const f=await fixture(t,{privateDsh}),body=request(),before=structuredClone(body);
  f.platforms.chat=async(target,raw,signal)=>{if(target.upstreamId==='primary'){f.calls.push({id:'primary',request:structuredClone(raw),signal});throw new AppError('SAMPLE unavailable',503,'provider_unavailable');}return f.originalChat(target,raw,signal);};
  const response=await f.post(body,{source}),result=await response.json();
  assert.equal(response.status,200);assert.equal(result.choices[0].message.content,'SAMPLE_FINAL');assert.equal(result.model,routeId);
  assert.deepEqual(f.calls.map(c=>c.id),['primary','standby']);for(const c of f.calls)assert.deepEqual(c.request,before);
  assert.deepEqual(body,before);assert.ok(f.rows.every(r=>r.source===source));assert.equal(f.rows.at(-1).status,'completed');
 });
 test(`HTTP ${source}: stream exposes only a verified complete tool call, then accepts its exact result`,async t=>{
  const f=await fixture(t,{privateDsh}),body=request(true);
  f.platforms.chat=async(target,raw,signal)=>{f.calls.push({id:target.upstreamId,request:structuredClone(raw),signal});return sse([
   {choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_SAMPLE_next',type:'function',function:{name:'sample_read',arguments:'{"path":'}}]},finish_reason:null}]},
   {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"SAMPLE_NEXT"}'}}]},finish_reason:'tool_calls'}]},'[DONE]']);};
  const response=await f.post(body,{source}),text=await response.text();assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');
  const chunks=text.split('\n\n').filter(v=>v.startsWith('data: ')&&!v.includes('[DONE]')).map(v=>JSON.parse(v.slice(6)));
  assert.ok(text.includes('call_SAMPLE_next'));assert.ok(text.endsWith('data: [DONE]\n\n'));assert.ok(chunks.every(c=>c.model===routeId));assert.deepEqual(f.calls[0].request,body);
  const second=structuredClone(body);second.messages.push({role:'assistant',content:null,tool_calls:[{id:'call_SAMPLE_next',type:'function',function:{name:'sample_read',arguments:'{"path":"SAMPLE_NEXT"}'}}]},{role:'tool',tool_call_id:'call_SAMPLE_next',content:'SAMPLE_SECOND_RESULT'});second.stream=false;
  f.platforms.chat=async(target,raw,signal)=>{f.calls.push({id:target.upstreamId,request:structuredClone(raw),signal});return jsonAnswer('SAMPLE_TOOL_ROUND_FINISHED');};
  assert.equal((await(await f.post(second,{source})).json()).choices[0].message.content,'SAMPLE_TOOL_ROUND_FINISHED');assert.deepEqual(f.calls.at(-1).request,second);
 });
}
test('HTTP capability plan: skipped candidates are not supplier failures and only one dispatch occurs',async t=>{
 const f=await fixture(t);f.metadata.primary.maxTokens=1024;const response=await f.post(request()),result=await response.json();
 assert.equal(response.status,200);assert.equal(result.choices[0].message.content,'SAMPLE_FINAL');assert.deepEqual(f.calls.map(c=>c.id),['standby']);
 const skip=f.rows.find(r=>r.upstreamId==='primary');assert.equal(skip?.status,'skipped');assert.equal(f.rows.filter(r=>r.status==='failed').length,0);
 assert.deepEqual(f.rows.at(-1).requestOutcome,{schema:1,state:'completed',candidateCount:2,skippedCount:1,attemptCount:1,dispatchCount:1});
});
test('HTTP capability plan: a discovered catalog snapshot is not fetched again for every selected target',async t=>{
 const f=await fixture(t);f.metadata.primary.maxTokens=1024;assert.equal((await f.post(request())).status,200);
 assert.equal(f.catalogCalls.filter(id=>id==='primary').length,1);assert.equal(f.catalogCalls.filter(id=>id==='standby').length,1);
});
test('HTTP capability plan: no compatible output capacity preserves the full budget without a last-target clamp',async t=>{
 const f=await fixture(t);f.metadata.primary.maxTokens=1024;f.metadata.standby.maxTokens=2048;const body=request(),before=structuredClone(body);
 const response=await f.post(body),result=await response.json();assert.equal(response.status,503);assert.equal(f.calls.length,0);assert.deepEqual(body,before);
 assert.equal(result.error.gatewayManagedRetry,true);assert.equal(result.error.retryable,false);assert.equal(f.rows.filter(r=>r.status==='failed').length,0);assert.equal(f.rows.filter(r=>r.status==='skipped').length,2);
});
test('HTTP terminal root: a primary authentication rejection is not replaced by an incompatible standby',async t=>{
 const f=await fixture(t);f.metadata.standby.tools=false;
 f.platforms.chat=async(target,raw,signal)=>{f.calls.push({id:target.upstreamId,request:structuredClone(raw),signal});throw new AppError('SAMPLE primary auth expired',401,'provider_auth_rejected');};
 const response=await f.post(request()),result=await response.json();assert.equal(response.status,401);
 assert.deepEqual(result.error.relayFailure.root,{code:'provider_auth_rejected',status:401,platform:'loomy'});assert.equal(result.error.relayFailure.skippedCount,1);assert.equal(result.error.relayFailure.attemptCount,1);
 assert.equal(result.error.gatewayManagedRetry,true);assert.equal(result.error.retryable,false);assert.deepEqual(f.calls.map(c=>c.id),['primary']);
});
test('HTTP terminal root: a primary timeout survives a last candidate tools mismatch without outer retry permission',async t=>{
 const f=await fixture(t);f.metadata.standby.tools=false;
 f.platforms.chat=async(target,raw,signal)=>{f.calls.push({id:target.upstreamId,request:structuredClone(raw),signal});throw new AppError('SAMPLE header deadline',504,'relay_target_timeout');};
 const response=await f.post(request()),result=await response.json();assert.equal(response.status,504);assert.equal(result.error.relayFailure.root.code,'relay_target_timeout');assert.equal(result.error.relayFailure.root.status,504);
 assert.equal(result.error.gatewayManagedRetry,true);assert.equal(result.error.retryable,false);assert.equal(f.calls.length,1);
});
test('HTTP verified buffering: failed partial text and proposed tools never leak into a recovered stream',async t=>{
 const f=await fixture(t);f.platforms.chat=async(target,raw,signal)=>{f.calls.push({id:target.upstreamId,request:structuredClone(raw),signal});return target.upstreamId==='primary'?sse([
  {choices:[{index:0,delta:{content:'SAMPLE_MUST_NOT_LEAK',tool_calls:[{index:0,id:'call_SAMPLE_unexecuted',type:'function',function:{name:'sample_write',arguments:'{"content":"SAMPLE"}'}}]},finish_reason:null}]},
  {error:{message:'SAMPLE interrupted',code:'SAMPLE_STREAM_ERROR'}}]):jsonAnswer('SAMPLE_RECOVERED_ONLY');};
 const response=await f.post(request(true)),text=await response.text();assert.equal(response.status,200);assert.ok(text.includes('SAMPLE_RECOVERED_ONLY'));assert.ok(!text.includes('SAMPLE_MUST_NOT_LEAK'));assert.ok(!text.includes('call_SAMPLE_unexecuted'));assert.equal(f.calls.length,2);
});
test('HTTP cancellation: client abort cancels the dispatched supplier and never starts a standby',async t=>{
 const f=await fixture(t),controller=new AbortController();let aborted=false,started;
 const dispatched=new Promise(resolve=>{started=resolve;});
 f.platforms.chat=async(target,raw,signal)=>{f.calls.push({id:target.upstreamId,request:structuredClone(raw),signal});started();return new Promise((resolve,reject)=>{const end=()=>{aborted=true;reject(new AppError('SAMPLE cancelled',499,'request_cancelled'));};if(signal.aborted)end();else signal.addEventListener('abort',end,{once:true});});};
 const pending=f.post(request(),{signal:controller.signal});await dispatched;controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');
 for(let i=0;i<40&&!aborted;i++)await new Promise(r=>setTimeout(r,5));assert.equal(aborted,true);assert.deepEqual(f.calls.map(c=>c.id),['primary']);
});
test('HTTP managed terminal: a long-window rate limit is dispatched only once and not advertised as client retryable',async t=>{
 const f=await fixture(t,{ids:['primary']});f.platforms.chat=async(target,raw,signal)=>{f.calls.push({id:target.upstreamId,request:structuredClone(raw),signal});const error=new AppError('SAMPLE long window',429,'provider_rate_limited');Object.assign(error,{upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,retryAfterSeconds:30,retryAfterSource:'local_default'});throw error;};
 const response=await f.post(request()),result=await response.json();assert.equal(response.status,429);assert.equal(result.error.upstreamCode,6004);assert.equal(result.error.gatewayManagedRetry,true);assert.equal(result.error.rateLimitRetryable,false);assert.equal(result.error.retryable,false);assert.equal(f.calls.length,1);
});
test('HTTP correlation: server-generated ID unifies response and attempts without trusting a caller-provided ID',async t=>{
 const f=await fixture(t);const response=await f.post(request(),{headers:{'x-request-id':'SAMPLE_CLIENT_UNTRUSTED','x-ai-credit-request-id':'SAMPLE_CLIENT_UNTRUSTED'}});await response.text();
 const id=response.headers.get('x-ai-credit-request-id');assert.match(id,/^aigw-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 assert.equal(response.headers.get('x-request-id'),id);assert.equal(response.headers.get('x-ai-credit-source'),'hermes');assert.equal(response.headers.get('x-ai-credit-request-timeout-ms'),'5000');assert.ok(f.rows.every(r=>r.requestId===id));
});
test('HTTP terminal metadata: managed ownership blocks SDK retries and never exposes untrusted nested fields',async t=>{
 const f=await fixture(t);f.router.chat=async function*(){const e=new AppError('SAMPLE typed failure',401,'provider_auth_rejected');
  e.relayFailure={root:{code:'provider_auth_rejected',status:401,platform:'loomy',body:'SAMPLE_PRIVATE_BODY'},last:{code:'tools_not_supported',status:400,headers:'SAMPLE_PRIVATE_HEADERS'},attemptCount:1,skippedCount:2,request:'SAMPLE_PRIVATE_REQUEST'};throw e;};
 const response=await f.post(request()),result=await response.json();assert.equal(response.status,401);assert.equal(response.headers.get('x-ai-credit-retry-owner'),'gateway');assert.equal(response.headers.get('x-should-retry'),'false');
 assert.deepEqual(result.error.relayFailure,{root:{code:'provider_auth_rejected',status:401,platform:'loomy'},last:{code:'tools_not_supported',status:400},attemptCount:1,skippedCount:2});
 assert.ok(!JSON.stringify(result).includes('SAMPLE_PRIVATE'));assert.equal(result.error.gatewayRequestId,response.headers.get('x-ai-credit-request-id'));
});
test('HTTP zero candidates: one final failed request is counted without inventing an upstream attempt or charge',async t=>{
 const f=await fixture(t);for(const id of ['primary','standby'])f.state.set('relay-cooldown:'+id+'\0'+model,{until:Date.now()+60000,reasonCode:'authentication_unavailable',status:401});
 const response=await f.post(request()),result=await response.json();assert.ok([401,503].includes(response.status));assert.equal(result.error.gatewayManagedRetry,true);
 assert.equal(f.calls.length,0);assert.equal(f.rows.length,1);const row=f.rows[0];assert.equal(row.rowType,'request_outcome');assert.equal(row.attempt,0);assert.equal(row.dispatched,false);assert.equal(row.dispatchCount,0);
 assert.equal(row.upstreamId,'');assert.equal(row.accountId,'');assert.equal(row.credits,null);assert.equal(row.cost,null);
 assert.deepEqual(row.requestOutcome,{schema:1,state:'failed',candidateCount:0,skippedCount:0,attemptCount:0,dispatchCount:0});
 const activity=buildActivityContext({config:f.config,ledger:f.ledger},{range:'24h'});assert.equal(activity.kpis.requests,1);assert.equal(activity.kpis.failed,1);assert.equal(activity.kpis.attempts,0);assert.equal(activity.kpis.dispatches,0);assert.equal(activity.kpis.unknownTokenAttempts,0);
});
