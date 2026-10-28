import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const testRoot=process.env.WORKBUDDY_CHANNEL_TEST_ROOT??process.env.GATEWAY_TEST_ROOT;
const root=testRoot?pathToFileURL(testRoot.replace(/[\\/]?$/,'/')):new URL('../',import.meta.url);
const {gatewayFailureContract,relayFailureMetadata}=await import(new URL('src/client-contract.mjs',root));
const {parseGatewayRetryMetadata,enrichGatewayFailure,gatewayRetryRecovery,wrapGatewayRetryMetadata}=await import(new URL('bundle/retry-metadata.mjs',root));
const {diagnoseRequestRows}=await import(new URL('src/request-diagnostics.mjs',root));
const {startServer}=await import(new URL('src/server.mjs',root));
const ID='aigw-12345678-1234-4234-8234-123456789abc';
const channel='workbuddy_channel_rejected';
const hint='WorkBuddy 渠道校验未通过（11128）';
const relayFailure={root:{platform:'workbuddy',code:channel,status:400,message:'SAMPLE_PRIVATE_SYSTEM'},last:{code:'relay_context_incompatible',status:400,body:'SAMPLE_PRIVATE_BODY'},attemptCount:1,skippedCount:2,request:'SAMPLE_PRIVATE_BODY'};
const safeRelay={root:{platform:'workbuddy',code:channel,status:400},last:{code:'relay_context_incompatible',status:400},attemptCount:1,skippedCount:2};
const owned=(extra={})=>({code:channel,type:channel,upstreamCode:11128,gatewayManagedRetry:true,gatewayRetryOwner:'gateway',gatewayRequestId:ID,message:'SAMPLE_PRIVATE_SYSTEM',...extra});
const wire=(body,status=400)=>status+': '+JSON.stringify({error:body});
function fixture(chat){return {config:{value:{server:{host:'127.0.0.1',port:0,requestTimeoutMs:1000},routes:[]}},keys:{apiKey:'SAMPLE_API',adminKey:'SAMPLE_ADMIN'},router:{chat}};}
async function runtime(t,chat){const service=fixture(chat),rt=await startServer(service);t.after(()=>rt.close());return rt;}
const post=(rt,stream=false)=>fetch(rt.baseUrl+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer SAMPLE_API','content-type':'application/json'},body:JSON.stringify({model:'SAMPLE_ROUTE',messages:[{role:'user',content:'SAMPLE'}],stream})});

test('11128 typed relay root survives the public enum whitelist without private fields',()=>{assert.deepEqual(relayFailureMetadata(relayFailure),safeRelay);});
for(const [label,error] of [['direct',{code:channel,status:400,upstreamCode:11128}],['relay root',{code:'same_model_unavailable',status:503,relayFailure}]])test('11128 public contract carries only fixed channel business code: '+label,()=>{
 const c=gatewayFailureContract({...error,body:'SAMPLE_PRIVATE_BODY',system:'SAMPLE_PRIVATE_SYSTEM'},{requestId:ID});
 assert.equal(c.upstreamCode,11128);assert.equal(c.gatewayManagedRetry,true);assert.equal(c.retryable,false);assert.doesNotMatch(JSON.stringify(c),/SAMPLE_PRIVATE/);
});
for(const code of ['provider_chat_rejected','upstream_error','SAMPLE_OTHER'])test('ordinary provider numeric11128 is not promoted to channel metadata: '+code,()=>{assert.equal(gatewayFailureContract({code,upstreamCode:11128},{requestId:ID}).upstreamCode,undefined);});
for(const upstreamCode of [111280,'11128',true,null,11127])test('untyped/unowned invalid business code is not recognized: '+upstreamCode,()=>{const m=parseGatewayRetryMetadata(wire({code:'provider_chat_rejected',type:'provider_chat_rejected',upstreamCode}));assert.equal(m?.upstreamCode,undefined);});

test('DSH direct typed channel message is explicit and keeps harness code without generic terminal label',()=>{
 const f=enrichGatewayFailure({code:'INVALID_REQUEST',message:wire(owned())});assert.equal(f.gatewayCode,channel);assert.equal(f.code,'INVALID_REQUEST');assert.equal(f.upstreamCode,11128);assert.ok(f.message.includes(hint));assert.doesNotMatch(f.message,/gateway_terminal_error|SAMPLE_PRIVATE/);
});
test('DSH relay aggregate retains explicit WorkBuddy channel root even if final candidate is incompatible',()=>{
 const f=enrichGatewayFailure({code:'SERVER',message:wire(owned({code:'same_model_unavailable',type:'same_model_unavailable',relayFailure}),503)});assert.equal(f.gatewayCode,'same_model_unavailable');assert.deepEqual(f.relayFailure,safeRelay);assert.ok(f.message.includes(hint));assert.match(f.message,/workbuddy\/workbuddy_channel_rejected HTTP 400/);assert.match(f.message,/已发出 1 次；跳过 2/);assert.doesNotMatch(f.message,/SAMPLE_PRIVATE/);
});
test('11128 alone and a forged unowned channel body do not acquire new gateway retry authority',async()=>{
 for(const message of ['11128',wire({code:channel,type:channel,upstreamCode:11128,message:'SAMPLE_PUBLIC'}),wire(owned({gatewayRequestId:'SAMPLE_FORGED'}))]){const input={code:'INVALID_REQUEST',message},f=enrichGatewayFailure(input);assert.equal(f,input);let n=0;await gatewayRetryRecovery({provider:'ai-credit',failure:f},()=>{n++});assert.equal(n,1);}
});
test('JSON-detached DSH terminal11128 never replays another whole gateway pool',async()=>{
 const f=JSON.parse(JSON.stringify(enrichGatewayFailure({code:'INVALID_REQUEST',message:wire(owned())})));let n=0;await gatewayRetryRecovery({provider:'ai-credit',failure:f},()=>{n++});assert.equal(n,0);await gatewayRetryRecovery({provider:'OTHER',failure:f},()=>{n++});assert.equal(n,1);
});
for(const partialType of ['text-delta','reasoning-delta','tool-call-delta'])test('post-output11128 '+partialType+' stays terminal once without outer replay',async()=>{
 let calls=0;const a={async *streamWithSnapshot(){calls++;yield {type:partialType,text:'SAMPLE_OUTPUT'};yield {type:'finish',reason:{kind:'error',failure:{code:'INVALID_REQUEST',message:wire(owned())}}};}};
 wrapGatewayRetryMetadata(a,{models:()=>[],ownedGateway:true});const chunks=[];for await(const c of a.streamWithSnapshot({model:'SAMPLE',signal:new AbortController().signal},{}))chunks.push(c);assert.equal(calls,1);assert.equal(chunks.length,2);const f=JSON.parse(JSON.stringify(chunks.at(-1).reason.failure));assert.ok(f.message.includes(hint));let n=0;await gatewayRetryRecovery({provider:'ai-credit',failure:f},()=>{n++});assert.equal(n,0);
});

test('HTTP11128 carries typed business code, safe relay root and gateway ownership into DSH',async t=>{
 let calls=0;const rt=await runtime(t,async function*(){calls++;throw Object.assign(Error(hint),{status:400,code:channel,upstreamCode:11128,relayFailure});});const r=await post(rt),b=await r.json();assert.equal(r.status,400);assert.equal(b.error.code,channel);assert.equal(b.error.upstreamCode,11128);assert.deepEqual(b.error.relayFailure,safeRelay);assert.equal(r.headers.get('x-should-retry'),'false');const f=enrichGatewayFailure({code:'INVALID_REQUEST',message:wire(b.error)});assert.ok(f.message.includes(hint));assert.doesNotMatch(JSON.stringify(b),/SAMPLE_PRIVATE/);assert.equal(calls,1);
});
test('SSE after tool output has one typed11128 terminal error and no success DONE or second call',async t=>{
 let calls=0;const rt=await runtime(t,async function*(){calls++;yield {id:'SAMPLE',model:'SAMPLE_ROUTE',choices:[{index:0,delta:{tool_calls:[{index:0,id:'SAMPLE_TOOL',type:'function',function:{name:'SAMPLE_READ',arguments:'{}'}}]},finish_reason:null}]};throw Object.assign(Error(hint),{status:400,code:channel,upstreamCode:11128});});const r=await post(rt,true),s=await r.text();assert.equal(r.status,200);assert.match(s,/SAMPLE_TOOL/);assert.equal((s.match(/event: error/g)??[]).length,1);assert.match(s,/"upstreamCode":11128/);assert.match(s,/workbuddy_channel_rejected/);assert.doesNotMatch(s,/data: \[DONE\]/);assert.equal(calls,1);const body=JSON.parse(s.split('event: error\ndata: ')[1].trim());assert.ok(enrichGatewayFailure({code:'INVALID_REQUEST',message:wire(body.error)}).message.includes(hint));
});
test('request diagnostics retains bounded11128 cause, accounting and no raw prompts or account identity',()=>{
 const row={id:1,requestId:ID,startedAt:'2026-10-28T02:53:43.000Z',finishedAt:'2026-10-28T02:53:44.000Z',attempt:1,platform:'workbuddy',accountId:'SAMPLE_PRIVATE_ACCOUNT',model:'SAMPLE_MODEL',status:'failed',dispatched:true,dispatchCount:1,error:{code:channel,status:400,upstreamCode:11128,message:'SAMPLE_PRIVATE_SYSTEM'},relayFailure};
 const d=diagnoseRequestRows([row]);assert.equal(d.firstReason.code,channel);assert.equal(d.firstReason.upstreamCode,11128);assert.equal(d.attemptCount,1);assert.equal(d.dispatchCount,1);assert.doesNotMatch(JSON.stringify(d),/SAMPLE_PRIVATE/);
});

test('all-channel-rejected result retains root11128 and request-local undispatched last skip',()=>{
 const failed={root:{platform:'workbuddy',code:channel,status:400},last:{code:'workbuddy_channel_skipped',status:400,body:'SAMPLE_PRIVATE_BODY'},attemptCount:1,skippedCount:1};
 const expected={root:{platform:'workbuddy',code:channel,status:400},last:{code:'workbuddy_channel_skipped',status:400},attemptCount:1,skippedCount:1};
 assert.deepEqual(relayFailureMetadata(failed),expected);
 const f=enrichGatewayFailure({code:'INVALID_REQUEST',message:wire(owned({relayFailure:failed}))});
 assert.deepEqual(f.relayFailure,expected);assert.ok(f.message.includes(hint));assert.match(f.message,/已发出 1 次；跳过 1/);assert.doesNotMatch(f.message,/SAMPLE_PRIVATE/);
 const rows=[{id:1,requestId:ID,attempt:1,platform:'workbuddy',accountId:'SAMPLE_PRIVATE_ACCOUNT',model:'SAMPLE_MODEL',status:'failed',dispatched:true,dispatchCount:1,error:{code:channel,status:400}},
 {id:2,requestId:ID,attempt:2,platform:'workbuddy',accountId:'SAMPLE_PRIVATE_OTHER',model:'SAMPLE_MODEL',status:'skipped',dispatched:false,dispatchCount:0,error:{code:'workbuddy_channel_skipped',status:400},candidatePlan:{state:'skipped',reasonCode:'workbuddy_channel_skipped'},relayFailure:failed}];
 const d=diagnoseRequestRows(rows);assert.equal(d.firstReason.code,channel);assert.equal(d.firstReason.upstreamCode,11128);assert.equal(d.lastReason.code,'workbuddy_channel_skipped');assert.equal(d.lastReason.upstreamCode,undefined);assert.equal(d.attemptCount,1);assert.equal(d.dispatchCount,1);assert.equal(d.skippedCount,1);assert.equal(d.candidates[1].dispatched,false);assert.equal(d.candidates[1].dispatchCount,0);assert.equal(d.candidates[1].reasonCode,'workbuddy_channel_skipped');assert.doesNotMatch(JSON.stringify(d),/SAMPLE_PRIVATE/);
});
