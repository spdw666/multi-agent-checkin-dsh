import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=resolve(process.env.WORKBUDDY_TRANSPORT_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const at=p=>pathToFileURL(resolve(root,p)).href;
const {Platforms}=await import(at('src/platforms.mjs'));
const {WorkBuddyUpstreamClient}=await import(at('vendor/workbuddy-core.mjs'));
const {UsageAttempt}=await import(at('src/usage.mjs'));
const {diagnoseRequestRows}=await import(at('src/request-diagnostics.mjs'));
const {gatewayFailureContract}=await import(at('src/client-contract.mjs'));
const {supplierTerminal}=await import(at('src/request-plan.mjs'));
const {Router}=await import(at('src/router.mjs'));
const {collectChat}=await import(at('src/openai.mjs'));
const {enrichGatewayFailure}=await import(at('bundle/retry-metadata.mjs'));
let helper;try{helper=await import(at('src/transport-failure.mjs'));}catch{}
const requireHelper=()=>{assert.ok(helper,'structured transport helper exists');return helper;};
const requestId='aigw-00000000-0000-4000-8000-000000000000';
const config={accounts:[{id:'SAMPLE_ACCOUNT',platform:'workbuddy',enabled:true}],upstreams:[{id:'SAMPLE_UPSTREAM',kind:'workbuddy',accountId:'SAMPLE_ACCOUNT',enabled:true}]};
const target={upstreamId:'SAMPLE_UPSTREAM',model:'deepseek-v4.1-flash'},input={model:'SAMPLE_ROUTE',messages:[{role:'user',content:'SAMPLE_INPUT'}],max_tokens:128000};
function fixture(result){let sends=0,resolves=0;const p=new Platforms({value:config},{resolve:async()=>{resolves++;return{accessToken:'SAMPLE_TOKEN',edition:'cn',domain:'www.codebuddy.cn',principal:'SAMPLE_PRINCIPAL'};}});p.wb.chatStream=async()=>{sends++;return result;};return{p,counts:()=>({sends,resolves})};}
for(const [native,phase,origin]of [['UND_ERR_CONNECT_TIMEOUT','connect','connect_deadline'],['UND_ERR_HEADERS_TIMEOUT','response_header','header_deadline'],['UND_ERR_SOCKET',null,null],['ECONNRESET',null,null],['EAI_AGAIN','connect',null],['CERT_HAS_EXPIRED','tls_handshake',null]])test('fetch cause retained without message leakage '+native,async t=>{
  const err=new TypeError('fetch failed LEAK_URL LEAK_TOKEN');err.cause={code:native,address:'LEAK_ADDRESS',hostname:'LEAK_HOST',message:'LEAK_CAUSE'};
  let sends=0;t.mock.method(globalThis,'fetch',async()=>{sends++;throw err;});
  const out=await new WorkBuddyUpstreamClient().chatStream({accessToken:'SAMPLE_TOKEN',domain:'www.codebuddy.cn'},JSON.stringify(input));
  assert.equal(out.ok,false);assert.equal(out.status,0);assert.deepEqual(out.transportFailure,{phase,code:native,timeoutOrigin:origin});assert.equal(sends,1);assert.doesNotMatch(JSON.stringify(out),/LEAK_/);
});
for(const native of ['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT'])test('typed timeout instead of fabricated HTTP502 '+native,async()=>{
  const f=fixture({ok:false,status:0,kind:'server',message:'LEAK_MESSAGE',transportFailure:{code:native}});
  await assert.rejects(f.p.chat(target,structuredClone(input)),e=>e.code==='provider_timeout'&&e.status===504&&e.transportCode===native&&e.upstreamResponseReceived===(native==='UND_ERR_BODY_TIMEOUT')&&!e.message.includes('LEAK_'));
  assert.deepEqual(f.counts(),{sends:1,resolves:1});
});
test('unknown fetch error is provider_network_error not an official HTTP response',async()=>{
  const f=fixture({ok:false,status:0,kind:'server',message:'LEAK_PRIVATE'});
  await assert.rejects(f.p.chat(target,structuredClone(input)),e=>e.code==='provider_network_error'&&e.status===503&&e.upstreamResponseReceived===false&&e.transportCode==null&&!e.message.includes('LEAK_'));assert.equal(f.counts().sends,1);
});
test('caller cancellation remains request_cancelled and is not replayed',async()=>{
  const controller=new AbortController();controller.abort(new Error('LEAK_ABORT_REASON'));
  const f=fixture({ok:false,status:0,kind:'server',message:'LEAK_PRIVATE',transportFailure:{code:'UND_ERR_CONNECT_TIMEOUT'}});
  await assert.rejects(f.p.chat(target,structuredClone(input),controller.signal),e=>e.code==='request_cancelled'&&e.status===499);assert.equal(f.counts().sends,1);
});
test('request deadline remains distinct from a provider connection timeout',async()=>{
  const controller=new AbortController();controller.abort(new DOMException('SAMPLE','TimeoutError'));
  const f=fixture({ok:false,status:0,kind:'server',transportFailure:{code:'UND_ERR_CONNECT_TIMEOUT'}});
  await assert.rejects(f.p.chat(target,structuredClone(input),controller.signal),e=>e.code==='request_timeout'&&e.status===504&&e.timeoutOrigin==='request_deadline');
});
test('actual HTTP502 stays an HTTP response and keeps existing classification',async()=>{
  const f=fixture({ok:false,status:502,kind:'server',message:'SAMPLE_UPSTREAM_BODY'});
  await assert.rejects(f.p.chat(target,structuredClone(input)),e=>e.status===502&&e.code==='server'&&e.upstreamResponseReceived===undefined);
});
test('original caller messages tools budget and history stay unchanged',async()=>{
  const q=structuredClone(input);q.tools=[{type:'function',function:{name:'SAMPLE_TOOL',parameters:{type:'object',properties:{x:{type:'string'}}}}}];q.messages.push({role:'assistant',tool_calls:[{id:'SAMPLE_CALL',type:'function',function:{name:'SAMPLE_TOOL',arguments:'{}'}}]},{role:'tool',tool_call_id:'SAMPLE_CALL',content:'SAMPLE_RESULT'});const before=structuredClone(q);
  const f=fixture({ok:false,status:0,kind:'server',transportFailure:{code:'UND_ERR_SOCKET'}});await assert.rejects(f.p.chat(target,q));assert.deepEqual(q,before);assert.equal(f.counts().sends,1);
});
test('nested aggregate cause extraction is bounded and does not export arbitrary fields',()=>{
  const inner={code:'ECONNREFUSED',path:'LEAK_PATH',url:'LEAK_URL'},aggregate=new AggregateError([inner]);aggregate.cause=aggregate;
  const out=requireHelper().captureFetchTransportFailure(Object.assign(new TypeError('LEAK_MESSAGE'),{cause:aggregate}));assert.equal(out.code,'ECONNREFUSED');assert.doesNotMatch(JSON.stringify(out),/LEAK_/);
});
test('unknown native values are rejected instead of passed into metadata',()=>{
  assert.equal(requireHelper().transportFailureMetadata({code:'Bearer LEAK_TOKEN',phase:'LEAK_PATH',timeoutOrigin:'LEAK'}),undefined);
});
for(const code of ['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','EPIPE'])test('usage ledger and admin diagnostics retain safe native code '+code,()=>{
  let saved;const ledger={beginUsage:()=>1,finishUsage:(_,r)=>{saved=r}};const u=new UsageAttempt(ledger,config,input,target,{requestId,source:'dsh'});u.dispatched();u.finish('failed',Object.assign(new Error('SAMPLE'),{code:'provider_network_error',status:503,transportCode:code,upstreamResponseReceived:false}));assert.equal(saved.transportFailure?.code,code);
  const d=diagnoseRequestRows([{...saved,id:1}]);assert.equal(d.candidates[0].transportFailure.code,code);
});
test('supplier terminal preserves transport code through bounded same-model failure',()=>{
  const e=supplierTerminal({code:'provider_network_error',status:503,transportCode:'UND_ERR_SOCKET',networkPhase:null,upstreamResponseReceived:false});assert.equal(e.transportCode,'UND_ERR_SOCKET');assert.equal(e.upstreamResponseReceived,false);
});
test('owned failure envelope carries safe transport metadata only',()=>{
  const e={code:'provider_network_error',status:503,transportCode:'UND_ERR_SOCKET',upstreamResponseReceived:false,cause:{code:'UND_ERR_SOCKET',address:'LEAK_ADDRESS'},url:'LEAK_URL'};const meta=gatewayFailureContract(e,{requestId});assert.equal(meta.upstreamResponseReceived,false);assert.equal(meta.transportFailure?.code,'UND_ERR_SOCKET');assert.doesNotMatch(JSON.stringify(meta),/LEAK_/);
});
test('DSH displays transport cause without claiming an official HTTP response',()=>{
  const error={code:'provider_network_error',type:'provider_network_error',gatewayManagedRetry:true,gatewayRetryOwner:'gateway',gatewayRequestId:requestId,upstreamResponseReceived:false,transportFailure:{code:'UND_ERR_SOCKET',phase:null,timeoutOrigin:null},relayFailure:{root:{platform:'workbuddy',code:'provider_network_error',status:503},last:{code:'provider_network_error',status:503},attemptCount:1,skippedCount:0}};
  const out=enrichGatewayFailure({code:'SERVER',message:'503: '+JSON.stringify({error})});assert.equal(out.gatewayCode,'provider_network_error');assert.equal(out.transportFailure?.code,'UND_ERR_SOCKET');assert.match(out.message,/传输/);assert.match(out.message,/UND_ERR_SOCKET/);assert.doesNotMatch(out.message,/主因[^；]*HTTP 503/);
});
test('unowned provider prose does not inject a transport diagnostic into DSH',()=>{
  const out=enrichGatewayFailure({code:'SERVER',message:'503: '+JSON.stringify({error:{code:'provider_network_error',type:'provider_network_error',upstreamResponseReceived:false,transportFailure:{code:'UND_ERR_SOCKET'}}})});assert.equal(out.transportFailure,undefined);
});
test('body timeout remains a response-stage failure across terminal wire ledger and DSH',async()=>{
  const f=fixture({ok:false,status:0,kind:'server',transportFailure:{phase:'response_body',code:'UND_ERR_BODY_TIMEOUT',timeoutOrigin:'body_idle'}});let error;
  try{await f.p.chat(target,structuredClone(input));}catch(e){error=e;}
  assert.equal(error.upstreamResponseReceived,true);assert.match(error.message,/响应流/);assert.doesNotMatch(error.message,/尚未取得/);assert.equal(error.transportRetryable,false);
  const terminal=supplierTerminal(error);assert.equal(terminal.upstreamResponseReceived,true);assert.match(terminal.message,/网关状态/);assert.doesNotMatch(terminal.message,/HTTP 504/);const meta=gatewayFailureContract(terminal,{requestId});assert.equal(meta.upstreamResponseReceived,true);
  const out=enrichGatewayFailure({code:'SERVER',message:'504: '+JSON.stringify({error:{code:terminal.code,type:terminal.code,...meta}})});assert.equal(out.upstreamResponseReceived,true);assert.match(out.message,/响应流/);assert.doesNotMatch(out.message,/尚未取得/);
  let saved;const usage=new UsageAttempt({beginUsage:()=>1,finishUsage:(_,v)=>saved=v},config,input,target,{requestId});usage.finish('failed',error);assert.equal(saved.upstreamResponseReceived,true);assert.equal(diagnoseRequestRows([{...saved,id:1}]).candidates[0].upstreamResponseReceived,true);
});
test('body cancellation keeps response-observed state without replay permission',()=>{
  const controller=new AbortController();controller.abort();const out=requireHelper().fetchTransportErrorView({phase:'response_body',code:'UND_ERR_BODY_TIMEOUT'},controller.signal);assert.equal(out.code,'request_cancelled');assert.equal(out.upstreamResponseReceived,true);assert.equal(out.transportRetryable,false);
});
for(const guarded of [true,false])test(guarded?'typed ambiguous fetch failure does not introduce a new same-account resend':'unrelated providers keep their existing bounded transport retry',async()=>{
  const ids=['primary','standby'],values=new Map(),rows=[],calls=[];
  const conf={value:{server:{requestTimeoutMs:10000},accounts:ids.map(id=>({id,platform:'codebuddy'})),upstreams:ids.map(id=>({id,accountId:id,kind:'codebuddy'})),modelRelay:{enabled:true},routes:ids.map(id=>({id:id+'/deepseek-v4.1-flash',targets:[{upstreamId:id,model:'deepseek-v4.1-flash'}]}))}};
  const platforms={models:async()=>[{id:'deepseek-v4.1-flash',callable:true,tools:true,multimodal:true,contextWindow:1000000,maxTokens:128000}],chat:async target=>{calls.push(target.upstreamId);if(target.upstreamId==='primary')throw Object.assign(new Error('SAMPLE'),{code:'provider_network_error',status:503,...(guarded?{transportRetryable:false,upstreamResponseReceived:false}:{} )});return {response:Response.json({choices:[{message:{content:'SAMPLE_RECOVERY'},finish_reason:'stop'}]})};}};
  const ledger={get:k=>values.get(k),set:(k,v)=>values.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
  const router=new Router(conf,platforms,{ledger,relayNetworkRetryDelayMs:0});await collectChat(router.chat({model:'primary/deepseek-v4.1-flash',messages:[{role:'user',content:'SAMPLE'}],max_tokens:4096,stream:true}));
  assert.deepEqual(calls,guarded?['primary','standby']:['primary','primary','standby']);
});
