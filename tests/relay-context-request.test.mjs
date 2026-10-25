import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {collectChat} from '../src/openai.mjs';
import {relayDefaults} from '../src/model-relay.mjs';
import {AppError} from '../src/util.mjs';

// Optional baseline import lets release evidence run the identical public
// Router contract against an immutable pre-change source tree.
const {Router}=await import(process.env.RELAY_CONTEXT_ROUTER_MODULE
  ?pathToFileURL(process.env.RELAY_CONTEXT_ROUTER_MODULE).href
  :new URL('../src/router.mjs',import.meta.url).href);
const model='deepseek-v4.1-flash',routeId='wb-primary/'+model;
function fixture({single=false}={}) {
  const ids=single?['primary']:['primary','standby'];
  const config={value:{accounts:ids.map(id=>({id,platform:'workbuddy'})),
    server:{requestTimeoutMs:10000},modelRelay:{...relayDefaults,enabled:true},
    upstreams:ids.map(id=>({id,accountId:id,kind:'workbuddy'})),
    routes:ids.map((id,i)=>({id:i===0?routeId:'wb-standby/'+model,targets:[{upstreamId:id,model}]}))}};
  const metadata=Object.fromEntries(ids.map(id=>[id,{id:model,callable:true,tools:true,multimodal:true,
    contextWindow:id==='primary'?1000000:200000,maxTokens:64000}]));
  const calls=[],usages=[],events=[],state=new Map();
  const platforms={models:async id=>[metadata[id]],chat:async(target,request)=>{
    calls.push({target:structuredClone(target),request:structuredClone(request)});
    return {response:Response.json({choices:[{message:{content:'FULL_REQUEST_PRESERVED'},finish_reason:'stop'}]})};
  }};
  const ledger={get:key=>state.get(key),set:(key,value)=>state.set(key,value),record:event=>events.push(event),
    beginUsage:row=>(usages.push(row),usages.length-1),finishUsage:(index,row)=>usages[index]=row};
  const router=new Router(config,platforms,{ledger,relayNetworkRetryDelayMs:0});
  return {config,metadata,calls,usages,events,state,platforms,router};
}
const request=()=>({model:routeId,stream:true,max_tokens:4096,
  messages:[{role:'system',content:'Preserve every message, original tool ID and result.'},
    {role:'user',content:'Read SAMPLE and continue.'},
    {role:'assistant',content:null,tool_calls:[{id:'call-original-001',type:'function',function:{name:'read_file',arguments:'{"path":"SAMPLE"}'}}]},
    {role:'tool',tool_call_id:'call-original-001',content:'SAMPLE 完整结果 🙂'},
    {role:'user',content:'Continue from the unchanged tool result.'}],
  tools:[{type:'function',function:{name:'read_file',description:'Read a complete file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}],
  tool_choice:'auto',parallel_tool_calls:false});
function preferOnlyStandby(f) {
  f.router.relay.balanceSource=()=>new Map([
    ['primary',{value:0,unit:'积分',checkedAt:new Date().toISOString()}],
    ['standby',{value:700,unit:'积分',checkedAt:new Date().toISOString()}]
  ]);
}
const networkError=()=>new AppError('Fixture transient connection reset',502,'provider_network_error');

test('request-aware context: a short full request relays from a 1M route to a 200K standby',async()=>{
  const f=fixture();preferOnlyStandby(f);const raw=request(),before=structuredClone(raw);
  const out=await collectChat(f.router.chat(raw));
  assert.equal(out.choices[0].message.content,'FULL_REQUEST_PRESERVED');
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['standby']);
  assert.deepEqual(f.calls[0].request,before);assert.deepEqual(raw,before);
  assert.equal(out.model,routeId);assert.equal(f.calls[0].target.model,model);
});

test('request-aware context: unknown standby context preserves the payload for authoritative upstream validation',async()=>{
  const f=fixture();preferOnlyStandby(f);delete f.metadata.standby.contextWindow;
  const raw=request();await collectChat(f.router.chat(raw));
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['standby']);
  assert.deepEqual(f.calls[0].request,raw);
  assert.equal(f.router.relay.cooldown({upstreamId:'standby',model}),null);
});

test('request-aware context: an unknown-window upstream context rejection remains an authoritative 400',async()=>{
  const f=fixture();preferOnlyStandby(f);delete f.metadata.standby.contextWindow;
  f.platforms.chat=async(target,raw)=>{f.calls.push({target,request:structuredClone(raw)});throw new AppError('prompt is too long',400,'context_length_exceeded');};
  const raw=request(),before=JSON.stringify(raw);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===400&&e.code==='context_length_exceeded');
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['standby']);assert.equal(JSON.stringify(raw),before);
  assert.equal(f.router.relay.cooldown({upstreamId:'standby',model}),null);
});

test('request-aware context: a long UTF-8 history is not trimmed and yields 503 rather than caller-invalid 400',async()=>{
  const f=fixture();preferOnlyStandby(f);const raw=request();raw.messages[1].content='中'.repeat(100000);
  const before=JSON.stringify(raw);assert.ok(Buffer.byteLength(before,'utf8')>200000);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===503&&['relay_context_incompatible','same_model_unavailable'].includes(e.code));
  assert.equal(f.calls.length,0,'a proven-insufficient standby must not receive a truncated or over-capacity request');
  assert.equal(JSON.stringify(raw),before);assert.equal(raw.messages[1].content.length,100000);
  assert.equal(f.router.relay.cooldown({upstreamId:'standby',model}),null);
});

test('request-aware context: serialized tool definitions count toward capacity, not just message content',async()=>{
  const f=fixture();preferOnlyStandby(f);const raw=request();raw.tools[0].function.description='tool-schema-body-'.repeat(14000);
  const before=JSON.stringify(raw);assert.ok(Buffer.byteLength(before,'utf8')>200000);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===503);
  assert.equal(f.calls.length,0);assert.equal(JSON.stringify(raw),before);
});

test('request-aware context: requested output budget is reserved in the standby context bound',async()=>{
  const f=fixture();preferOnlyStandby(f);f.metadata.standby.contextWindow=10000;
  const raw=request();raw.max_tokens=9000;raw.messages[1].content='A'.repeat(2000);
  const before=JSON.stringify(raw);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===503);
  assert.equal(f.calls.length,0);assert.equal(JSON.stringify(raw),before);assert.equal(raw.max_tokens,9000);
});

test('request-aware context: a short image URL does not prove that an image fits a smaller context window',async()=>{
  const f=fixture();preferOnlyStandby(f);const raw=request();
  raw.messages[1].content=[{type:'text',text:'Describe this image.'},{type:'image_url',image_url:{url:'https://fixture.invalid/image.png'}}];
  const before=JSON.stringify(raw);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===503);
  assert.equal(f.calls.length,0);assert.equal(JSON.stringify(raw),before);
});

test('request-aware context: upstream calls preserve all messages, tool IDs, tool results and max_completion_tokens',async()=>{
  const f=fixture();preferOnlyStandby(f);const raw=request();delete raw.max_tokens;raw.max_completion_tokens=12000;
  const out=await collectChat(f.router.chat(raw));const sent=f.calls[0].request;
  assert.deepEqual(sent,raw);assert.equal(sent.messages[2].tool_calls[0].id,'call-original-001');
  assert.equal(sent.messages[3].tool_call_id,'call-original-001');assert.equal(sent.messages[3].content,'SAMPLE 完整结果 🙂');
  assert.equal(sent.max_completion_tokens,12000);assert.equal(sent.model,routeId);assert.equal(out.model,routeId);
});

test('request-aware context: a declared insufficient output-token limit skips without changing the submitted budget',async()=>{
  const f=fixture();preferOnlyStandby(f);f.metadata.standby.maxTokens=1024;
  const raw=request(),before=JSON.stringify(raw);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===503&&e.code==='same_model_unavailable'&&e.relayFailure.skippedCount===1&&e.relayFailure.attemptCount===0);
  assert.equal(f.calls.length,0);assert.equal(JSON.stringify(raw),before);assert.equal(raw.max_tokens,4096);
  assert.equal(f.usages[0].status,'skipped');assert.equal(f.usages[0].dispatched,false);assert.equal(f.usages[0].dispatchCount,0);
  assert.equal(f.usages[0].requestContract.outputBudget,4096);assert.equal(f.usages[0].outputClamped,undefined);
});

test('transient network retry: the same supplier succeeds on exactly one retry without switching',async()=>{
  const f=fixture(),normal=f.platforms.chat;let n=0;
  f.platforms.chat=async(target,raw,signal)=>{if(n++===0){f.calls.push({target,request:structuredClone(raw)});throw networkError();}return normal(target,raw,signal);};
  const raw=request(),before=structuredClone(raw),out=await collectChat(f.router.chat(raw));
  assert.equal(out.choices[0].message.content,'FULL_REQUEST_PRESERVED');
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','primary']);
  assert.ok(f.calls.every(c=>JSON.stringify(c.request)===JSON.stringify(before)));
  assert.equal(f.router.relay.cooldown({upstreamId:'primary',model}),null);
  assert.equal(f.events.filter(e=>e.status==='switched').length,0);
});

test('transient network retry: two failures are bounded, then relay to the standby with only a short cooldown',async()=>{
  const f=fixture(),normal=f.platforms.chat;const started=Date.now();
  f.platforms.chat=async(target,raw,signal)=>{if(target.upstreamId==='primary'){f.calls.push({target,request:structuredClone(raw)});throw networkError();}return normal(target,raw,signal);};
  const raw=request(),out=await collectChat(f.router.chat(raw));
  assert.equal(out.choices[0].message.content,'FULL_REQUEST_PRESERVED');
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','primary','standby']);
  assert.ok(f.calls.every(c=>JSON.stringify(c.request)===JSON.stringify(raw)));
  const cooldown=f.router.relay.cooldown({upstreamId:'primary',model});
  assert.ok(cooldown&&cooldown.until>Date.now());
  assert.ok(cooldown.until<=Date.now()+5100,'transient transport failure must not keep the old 60-second cooldown');
  assert.ok(Date.now()-started<8000,'bounded retry must not reproduce the multi-minute wait');
});

test('transient network retry: a single unavailable supplier is attempted twice, not indefinitely',async()=>{
  const f=fixture({single:true});f.platforms.chat=async(target,raw)=>{f.calls.push({target,request:structuredClone(raw)});throw networkError();};
  await assert.rejects(collectChat(f.router.chat(request())),e=>[502,503].includes(e.status));
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','primary']);
  const cooldown=f.router.relay.cooldown({upstreamId:'primary',model});assert.ok(cooldown&&cooldown.until<=Date.now()+5100);
});

test('transient network retry: cancellation after the first transport failure prevents both retry and handoff',async()=>{
  const f=fixture(),controller=new AbortController();
  f.platforms.chat=async(target,raw)=>{f.calls.push({target,request:structuredClone(raw)});controller.abort();throw networkError();};
  await assert.rejects(collectChat(f.router.chat(request(),controller.signal)),e=>e.code==='request_cancelled'&&e.status===499);
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);
});

test('transient network recovery: a large request waits for the short primary cooldown rather than leaking a standby 400',async t=>{
  const {syncBuiltinESMExports}=await import('node:module');
  // Keep catalogue/planning work inside the circuit's lifetime even on a busy
  // runner. Sync the router's named timers/promises import to the fake clock.
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  syncBuiltinESMExports();
  t.after(()=>{t.mock.timers.reset();syncBuiltinESMExports();});
  const f=fixture(),raw=request();raw.messages[1].content='中'.repeat(100000);
  f.state.set('relay-cooldown:primary\0'+model,{until:Date.now()+10,reasonCode:'upstream_unavailable',errorCode:'provider_network_error'});
  const before=JSON.stringify(raw),pending=collectChat(f.router.chat(raw));
  await new Promise(setImmediate);
  assert.equal(f.calls.length,0,'no supplier dispatches while the primary is cooling and the standby is too small');
  t.mock.timers.tick(34);await new Promise(setImmediate);
  assert.equal(f.calls.length,0,'the original 10ms circuit plus 25ms recovery guard must finish before dispatch');
  t.mock.timers.tick(1);const out=await pending;
  assert.equal(out.choices[0].message.content,'FULL_REQUEST_PRESERVED');
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);
  assert.equal(JSON.stringify(f.calls[0].request),before);assert.equal(JSON.stringify(raw),before);
});

test('transient network recovery: a non-transport outage does not enter the bounded transport recovery loop',async()=>{
  const f=fixture(),raw=request();raw.messages[1].content='中'.repeat(100000);
  f.state.set('relay-cooldown:primary\0'+model,{until:Date.now()+60000,reasonCode:'upstream_unavailable',errorCode:'upstream_business_error'});
  const started=Date.now(),before=JSON.stringify(raw);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===503);
  assert.equal(f.calls.length,0);assert.equal(JSON.stringify(raw),before);
  assert.ok(Date.now()-started<1000,'a long non-transport cooldown must return promptly');
});

test('transient network retry: authentication failures hand off without an extra same-source request',async()=>{
  const f=fixture(),normal=f.platforms.chat;
  f.platforms.chat=async(target,raw,signal)=>{if(target.upstreamId==='primary'){f.calls.push({target,request:structuredClone(raw)});throw new AppError('authentication expired',401,'unauthorized');}return normal(target,raw,signal);};
  await collectChat(f.router.chat(request()));
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','standby']);
});
