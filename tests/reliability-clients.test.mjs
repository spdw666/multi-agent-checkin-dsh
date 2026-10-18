import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.env.GATEWAY_TEST_ROOT?pathToFileURL(process.env.GATEWAY_TEST_ROOT.replace(/[\\/]?$/,'/')):new URL('../',import.meta.url);
const {startServer}=await import(new URL('src/server.mjs',root));
const retry=await import(new URL('bundle/retry-metadata.mjs',root));
const {gatewayRequestPolicy}=await import(new URL('bundle/request-policy.mjs',root));
const contract=await import(new URL('src/client-contract.mjs',root)).catch(()=>({}));
const requestId='aigw-12345678-1234-4234-8234-123456789abc';
const relayFailure={root:{code:'loomy_session_expired',status:401,platform:'loomy',message:'SAMPLE_CREDENTIAL'},last:{code:'relay_context_incompatible',status:400,body:'SAMPLE_SECRET'},attemptCount:1,skippedCount:14,authorization:'SAMPLE_SECRET'};
const safeRelay={root:{code:'loomy_session_expired',status:401,platform:'loomy'},last:{code:'relay_context_incompatible',status:400},attemptCount:1,skippedCount:14};
const basic={model:'SAMPLE_ROUTE',messages:[{role:'user',content:'SAMPLE'}]};
function fixture(chat){return {config:{value:{server:{host:'127.0.0.1',port:0,requestTimeoutMs:1000},routes:[]}},keys:{apiKey:'SAMPLE_API',adminKey:'SAMPLE_ADMIN'},router:{chat}};}
async function runtime(t,chat,options){const service=fixture(chat),rt=await startServer(service,options);t.after(()=>rt.close());return {...rt,service};}
const post=(rt,body=basic,headers={})=>fetch(rt.baseUrl+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer SAMPLE_API','content-type':'application/json',...headers},body:JSON.stringify(body)});
async function* answer(){yield {id:'SAMPLE',model:'SAMPLE_ROUTE',choices:[{index:0,delta:{role:'assistant',content:'SAMPLE_OK'},finish_reason:'stop'}]};}
test('gateway mints trace ID, associates source, and passes exact trace to router without trusting caller ID',async t=>{
  let seen;const rt=await runtime(t,async function*(body,signal,context){seen=context;yield*answer();});const r=await post(rt,basic,{'x-ai-credit-source':'hermes','x-request-id':'SAMPLE_CALLER_ID'});assert.equal(r.status,200);assert.match(r.headers.get('x-ai-credit-request-id'),/^aigw-[0-9a-f-]{36}$/);assert.equal(r.headers.get('x-request-id'),seen.requestId);assert.equal(r.headers.get('x-ai-credit-request-id'),seen.requestId);assert.notEqual(seen.requestId,'SAMPLE_CALLER_ID');assert.equal(seen.source,'hermes');assert.equal(r.headers.get('x-ai-credit-request-timeout-ms'),'1000');
});
test('source is an exact whitelist label; forged source/owner never grants admin access',async t=>{
  let seen;const rt=await runtime(t,async function*(_b,_s,c){seen=c;yield*answer();});await post(rt,basic,{'x-ai-credit-source':'ADMIN','x-ai-credit-retry-owner':'gateway'});assert.equal(seen.source,'api');const r=await fetch(rt.baseUrl+'/admin/config',{headers:{authorization:'Bearer SAMPLE_API','x-ai-credit-source':'dsh'}});assert.equal(r.status,401);
});
test('private DSH shim source cannot be changed to Hermes by caller header',async t=>{
  let seen;const rt=await runtime(t,async function*(_b,_s,c){seen=c;yield*answer();},{admin:false});await post(rt,basic,{'x-ai-credit-source':'hermes'});assert.equal(seen.source,'dsh');
});
for(const status of [400,502,503,504])test(`HTTP ${status} terminal owner and safe root cause survive without public body/credential fields`,async t=>{
  const rt=await runtime(t,async function*(){throw Object.assign(Error('SAMPLE_PUBLIC_DIAGNOSTIC'),{status,code:status===400?'reasoning_effort_not_supported':'same_model_unavailable',relayFailure});});const r=await post(rt),b=await r.json();assert.equal(r.status,status);assert.equal(b.error.gatewayManagedRetry,true);assert.equal(b.error.gatewayRetryOwner,'gateway');assert.equal(r.headers.get('x-should-retry'),'false');assert.equal(r.headers.get('x-ai-credit-retry-owner'),'gateway');assert.equal(b.error.gatewayRequestId,r.headers.get('x-request-id'));assert.deepEqual(b.error.relayFailure,safeRelay);assert.doesNotMatch(JSON.stringify(b),/SAMPLE_CREDENTIAL|SAMPLE_SECRET|authorization/);
});
test('relay diagnostic rejects unbounded numbers, non-enum fields and arbitrary object payload',()=>{
  assert.equal(typeof contract.relayFailureMetadata,'function');assert.deepEqual(contract.relayFailureMetadata({root:{code:'SAMPLE_SECRET',status:200,platform:'SAMPLE_ACCOUNT'},last:{code:'request_timeout',status:504,message:'SAMPLE'},attemptCount:Infinity,skippedCount:-1,url:'SAMPLE'}),{last:{code:'request_timeout',status:504}});
});
test('typed gateway contract preserves true main cause in DSH and blocks outer recovery on plain routes',async()=>{
  const body={code:'same_model_unavailable',type:'same_model_unavailable',message:'SAMPLE_RAW_UPSTREAM_SECRET',gatewayManagedRetry:true,gatewayRetryOwner:'gateway',gatewayRequestId:requestId,relayFailure};const failure=retry.enrichGatewayFailure({code:'SERVER',message:'503: '+JSON.stringify({error:body})});assert.equal(failure.gatewayRequestId,requestId);assert.deepEqual(failure.relayFailure,safeRelay);assert.match(failure.message,/loomy\/loomy_session_expired HTTP 401/);assert.match(failure.message,/跳过 14/);assert.doesNotMatch(failure.message,/SAMPLE_RAW_UPSTREAM_SECRET|SAMPLE_CREDENTIAL/);let replay=0;await retry.gatewayRetryRecovery({provider:'ai-credit',failure},()=>{replay++;return Promise.resolve();});assert.equal(replay,0);await retry.gatewayRetryRecovery({provider:'OTHER',failure},()=>{replay++;return Promise.resolve();});assert.equal(replay,1);
});
test('new deterministic validation code keeps only gateway terminal label rather than arbitrary raw error text',()=>{
  const body={code:'SAMPLE_UNRECOGNIZED',type:'SAMPLE_UNRECOGNIZED',gatewayManagedRetry:true,gatewayRetryOwner:'gateway',gatewayRequestId:requestId,message:'SAMPLE_CREDENTIAL'};const f=retry.enrichGatewayFailure({code:'INVALID_REQUEST',message:'400: '+JSON.stringify({error:body})});assert.equal(f.gatewayCode,'gateway_terminal_error');assert.equal(f.gatewayRequestId,requestId);assert.doesNotMatch(f.message,/SAMPLE_CREDENTIAL|SAMPLE_UNRECOGNIZED/);
});
test('long context and tool history including IDs/output budget pass intact through client boundary',async t=>{
  const body={...basic,max_tokens:4096,tools:[{type:'function',function:{name:'SAMPLE_READ',parameters:{type:'object',properties:{path:{type:'string'}}}}}],tool_choice:'auto',messages:[{role:'system',content:'SAMPLE_SYSTEM'},{role:'user',content:'长上下文 SAMPLE '.repeat(30000)},{role:'assistant',content:null,tool_calls:[{id:'SAMPLE_TOOL_ID',type:'function',function:{name:'SAMPLE_READ',arguments:'{"path":"SAMPLE"}'}}]},{role:'tool',tool_call_id:'SAMPLE_TOOL_ID',content:'SAMPLE_RESULT'},{role:'user',content:'SAMPLE_FINAL'}]};const original=structuredClone(body);let seen;const rt=await runtime(t,async function*(b){seen=b;yield*answer();});assert.equal((await post(rt,body)).status,200);assert.deepEqual(seen.messages,original.messages);assert.deepEqual(seen.tools,original.tools);assert.equal(seen.max_tokens,4096);assert.equal(seen.tool_choice,'auto');assert.deepEqual(body,original);
});
test('SSE tool frames and post-start typed error are delivered once, never converted into success',async t=>{
  let calls=0;const rt=await runtime(t,async function*(){calls++;yield {id:'SAMPLE',model:'SAMPLE_ROUTE',choices:[{index:0,delta:{tool_calls:[{index:0,id:'SAMPLE_TOOL',type:'function',function:{name:'SAMPLE_READ',arguments:'{"path":'}}]},finish_reason:null}]};throw Object.assign(Error('SAMPLE_PUBLIC'),{status:502,code:'invalid_upstream_response',relayFailure});});const r=await post(rt,{...basic,stream:true}),text=await r.text();assert.equal(r.status,200);assert.match(text,/SAMPLE_TOOL/);assert.match(text,/event: error/);assert.match(text,/"gatewayManagedRetry":true/);assert.match(text,/"gatewayRequestId":"aigw-/);assert.doesNotMatch(text,/data: \[DONE\]/);assert.equal(calls,1);
});
test('deadline is one whole request budget, returns typed 504 and never silently retries',async t=>{
  let calls=0;const rt=await runtime(t,async function*(_b,signal){calls++;await new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});});});rt.service.config.value.server.requestTimeoutMs=35;const start=Date.now(),r=await post(rt),b=await r.json();assert.equal(r.status,504);assert.equal(b.error.code,'request_timeout');assert.equal(b.error.gatewayManagedRetry,true);assert.equal(calls,1);assert.ok(Date.now()-start<1000);
});
test('HTTP cancellation reaches the single router operation and closes request ownership',async t=>{
  let abort,arrived,calls=0;const seen=new Promise(r=>arrived=r),done=new Promise(r=>abort=r);const rt=await runtime(t,async function*(_b,signal){calls++;arrived();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{abort();reject(signal.reason??Error('SAMPLE_CANCELLED'));},{once:true}));});const c=new AbortController(),p=fetch(rt.baseUrl+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer SAMPLE_API','content-type':'application/json'},body:JSON.stringify(basic),signal:c.signal});await seen;c.abort();await assert.rejects(p,/abort/i);await done;assert.equal(calls,1);
});
test('DSH idle envelope covers route/relay whole budget plus delivery margin without changing token defaults',()=>{
  for(const budget of [180000,600000,900000,1200000])assert.equal(gatewayRequestPolicy({},[{id:'SAMPLE',requestTimeoutMs:budget}]).streamIdleTimeoutMs,budget+10000);assert.equal(gatewayRequestPolicy({},[{id:'SAMPLE',modelRelay:{deliveryMode:'verified_request_buffer',requestTimeoutMs:1200000}}]).streamIdleTimeoutMs,1210000);assert.equal(gatewayRequestPolicy({},[{id:'SAMPLE'}]).configuredMaxTokens.size,0);
});
test('installed DSH adapter consumes HTTP typed root/ID and source header without any outer replay',async t=>{
  let createGatewayAdapter;try{({createGatewayAdapter}=await import(new URL('bundle/index.mjs',root)));}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'){t.skip('Optional installed DSH peer packages absent');return;}throw e;}
  let seen,calls=0;const rt=await runtime(t,async function*(_body,_signal,context){calls++;seen=context;throw Object.assign(Error('SAMPLE_RAW_SECRET'),{status:503,code:'same_model_unavailable',relayFailure});});
  const model={id:'SAMPLE_ROUTE',name:'SAMPLE',contextWindow:1000000,maxTokens:8192,capabilities:{multimodal:false},requestTimeoutMs:180000};
  const gateway=createGatewayAdapter({runtime:{baseUrl:rt.baseUrl,key:'SAMPLE_API'},models:[model]});
  const chunks=[];for await(const chunk of gateway.adapter.stream({provider:'ai-credit',model:'SAMPLE_ROUTE',messages:[{role:'user',content:[{type:'text',text:'SAMPLE'}]}],signal:new AbortController().signal}))chunks.push(chunk);
  const failure=chunks.findLast(c=>c.type==='finish').reason.failure;assert.deepEqual(failure.relayFailure,safeRelay);assert.equal(failure.gatewayRequestId,seen.requestId);assert.equal(seen.source,'dsh');assert.match(failure.message,/loomy_session_expired HTTP 401/);assert.doesNotMatch(failure.message,/SAMPLE_RAW_SECRET|SAMPLE_CREDENTIAL/);assert.equal(gateway.adapter.config.profiles().get('ai-credit').streamIdleTimeoutMs,190000);let replay=0;await retry.gatewayRetryRecovery({provider:'ai-credit',failure},()=>{replay++;return Promise.resolve()});assert.equal(replay,0);assert.equal(calls,1);
});
