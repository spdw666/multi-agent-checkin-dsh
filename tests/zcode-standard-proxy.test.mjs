import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {ensureZcodeProxy,zcodeStandardProxy,zcodeStandardStream} from '../src/zcode-standard-proxy.mjs';

// Every transport and process operation below is injected: no real endpoint,
// credential file, private runtime JSON, or child process is used.
const localKey='SAMPLE_LOCAL_KEY_012345678901234567890123456789';
const credential={accessToken:'SAMPLE_NATIVE_TOKEN',identity:{deviceId:'SAMPLE_DEVICE'}};
let port=20000;
const runtime=extra=>({enabled:true,baseUrl:`http://127.0.0.1:${port++}/v1/chat/completions`,localKey,...extra});
const launch={command:resolve('SAMPLE_RUNTIME'),script:resolve('SAMPLE_BRIDGE')};
const health=ready=>Response.json({ready});
const unexpected=()=>{throw new Error('UNEXPECTED_EXTERNAL_OPERATION');};
const matches=(code,status)=>error=>error.code===code&&error.status===status;
function fakeChild(){const child=new EventEmitter();child.unrefCount=0;child.unref=()=>{child.unrefCount++;};return child;}
function request(model){return {model,stream:true,reasoning_effort:'max',max_completion_tokens:128000,messages:[
  {role:'system',content:'SAMPLE_SYSTEM'},{role:'user',content:'SAMPLE_USER'},
  {role:'assistant',content:null,tool_calls:[{id:'SAMPLE_CALL',type:'function',function:{name:'sample_0',arguments:'{"value":"SAMPLE"}'}}]},
  {role:'tool',tool_call_id:'SAMPLE_CALL',content:'SAMPLE_RESULT'},
],tools:Array.from({length:331},(_,i)=>({type:'function',function:{name:`sample_${i}`,parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}})),parallel_tool_calls:false,tool_choice:'auto'};}
const inject=(config,fetchImpl=unexpected)=>({readRuntime:async()=>JSON.stringify(config),fetchImpl});

for(const model of ['glm-5.3','glm-5.3-flash','SAMPLE_FUTURE_OPAQUE_MODEL'])test(`${model} uses configured route without changing model,331 schemas,Max,128000 or tool history`,async()=>{
  const config=runtime(),input=request(model),before=JSON.stringify(input),signal=new AbortController().signal;let sends=0;
  const response=new Response('SAMPLE_RESPONSE',{headers:{'x-gateway-upstream-status':'200','x-gateway-upstream-code':'0'}});
  const result=await zcodeStandardProxy(credential,input,signal,inject(config,async(url,options)=>{
    sends++;assert.equal(url,config.baseUrl);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.signal,signal);
    assert.equal(options.headers.authorization,`Bearer ${localKey}`);assert.equal(options.headers['x-gateway-upstream-token'],credential.accessToken);assert.equal(options.headers['x-gateway-device-id'],credential.identity.deviceId);
    assert.equal(options.body,before);const body=JSON.parse(options.body);assert.equal(body.tools.length,331);assert.equal(body.reasoning_effort,'max');assert.equal(body.max_completion_tokens,128000);assert.deepEqual(body.tools,input.tools);return response;
  }));
  assert.equal(sends,1);assert.equal(result.response,response);assert.equal(result.upstreamStatus,200);assert.equal(result.upstreamCode,null);assert.equal(JSON.stringify(input),before);
});

test('missing runtime returns null without dispatch',async()=>{const error=Object.assign(new Error('SAMPLE_MISSING'),{code:'ENOENT'});assert.equal(await zcodeStandardProxy(credential,request('SAMPLE'),undefined,{readRuntime:async()=>{throw error;},fetchImpl:unexpected}),null);});
for(const enabled of [false,undefined,'true',1])test(`non-enabled runtime ${String(enabled)} returns null without dispatch`,async()=>{assert.equal(await zcodeStandardProxy(credential,request('SAMPLE'),undefined,inject(runtime({enabled}))),null);});
test('malformed runtime JSON has typed configuration error and no dispatch',async()=>{await assert.rejects(zcodeStandardProxy(credential,request('SAMPLE'),undefined,{readRuntime:async()=>'{SAMPLE_INVALID',fetchImpl:unexpected}),matches('zcode_proxy_config',503));});
test('runtime read failure is not silently treated as missing configuration',async()=>{await assert.rejects(zcodeStandardProxy(credential,request('SAMPLE'),undefined,{readRuntime:async()=>{throw Object.assign(new Error('SAMPLE_DENIED'),{code:'EACCES'});},fetchImpl:unexpected}),matches('zcode_proxy_config',503));});

for(const baseUrl of [
  'https://127.0.0.1:20000/v1/chat/completions',
  'http://example.invalid/v1/chat/completions',
  'http://localhost:20000/v1/chat/completions',
  'http://127.0.0.2:20000/v1/chat/completions',
  'http://SAMPLE_USER:SAMPLE_PASSWORD@127.0.0.1:20000/v1/chat/completions',
  'http://127.0.0.1:20000/v1/chat/completions?SAMPLE_QUERY=1',
  'http://127.0.0.1:20000/v1/chat/completions#SAMPLE_FRAGMENT',
  'http://127.0.0.1:20000/v1/other',
])test(`rejects unexpected proxy endpoint ${baseUrl}`,async()=>{await assert.rejects(zcodeStandardProxy(credential,request('SAMPLE'),undefined,inject(runtime({baseUrl}))),matches('zcode_proxy_config',503));});
for(const key of ['',null,'SAMPLE_SHORT',123])test(`rejects invalid local authentication key ${String(key)}`,async()=>{await assert.rejects(zcodeStandardProxy(credential,request('SAMPLE'),undefined,inject(runtime({localKey:key}))),matches('zcode_proxy_config',503));});
for(const c of [{},{accessToken:'SAMPLE_TOKEN'},{identity:{deviceId:'SAMPLE_DEVICE'}},{accessToken:'SAMPLE_TOKEN',identity:{}},{accessToken:'',identity:{deviceId:'SAMPLE_DEVICE'}}])test(`missing native token or device does not dispatch: ${JSON.stringify(c)}`,async()=>{await assert.rejects(zcodeStandardProxy(c,request('SAMPLE'),undefined,inject(runtime())),matches('zcode_proxy_auth',401));});
test('already-aborted caller signal never dispatches model request',async()=>{const controller=new AbortController(),reason=new Error('SAMPLE_CALLER_ABORT');controller.abort(reason);await assert.rejects(zcodeStandardProxy(credential,request('SAMPLE'),controller.signal,inject(runtime())),error=>error===reason);});
test('original upstream HTTP and3012 headers remain structured',async()=>{const result=await zcodeStandardProxy(credential,request('SAMPLE'),undefined,inject(runtime(),async()=>new Response('SAMPLE_ERROR',{status:502,headers:{'x-gateway-upstream-status':'405','x-gateway-upstream-code':'3012'}})));assert.equal(result.response.status,502);assert.equal(result.upstreamStatus,405);assert.equal(result.upstreamCode,3012);});
test('ordinary response status is the fallback when upstream header is absent',async()=>{const result=await zcodeStandardProxy(credential,request('SAMPLE'),undefined,inject(runtime(),async()=>new Response(null,{status:503})));assert.equal(result.upstreamStatus,503);assert.equal(result.upstreamCode,null);});

test('ordinary SSE event names,JSON payloads,tool deltas andDONE survive fragmentedCRLF input',async()=>{
  const payloads=[{event:'message',data:JSON.stringify({choices:[{delta:{content:'SAMPLE_TEXT'}}]})},{event:'',data:JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'SAMPLE_CALL',function:{arguments:'{"value":"SAMPLE"}'}}]}}]})},{event:'',data:'[DONE]'}];
  const text=payloads.map(x=>(x.event?`event: ${x.event}\r\n`:'')+`data: ${x.data}\r\n\r\n`).join(''),bytes=new TextEncoder().encode(text);let offset=0;
  const response=new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}const end=Math.min(offset+7,bytes.length);c.enqueue(bytes.slice(offset,end));offset=end;}}),{headers:{'content-type':'text/event-stream'}});
  const actual=await zcodeStandardStream(response,unexpected).text();assert.equal(actual,payloads.map(x=>(x.event?`event: ${x.event}\n`:'')+`data: ${x.data}\n\n`).join(''));
});
for(const data of [{upstreamCode:3012,upstreamStatus:405},{error:{code:'zcode_upstream_blocked',upstreamCode:3012,upstreamStatus:200}},{code:'3012'}])test(`typed3012 SSE invokes caller error mapper ${JSON.stringify(data)}`,async()=>{
  const mapped=Object.assign(new Error('SAMPLE_TYPED_BLOCK'),{code:'zcode_upstream_blocked'}),observed=[];
  const result=zcodeStandardStream(new Response(`data: ${JSON.stringify(data)}\n\n`,{headers:{'content-type':'text/event-stream'}}),(code,http)=>{observed.push([code,http]);return mapped;});
  await assert.rejects(result.text(),error=>error===mapped);assert.deepEqual(observed,[[3012,data.upstreamStatus??data.error?.upstreamStatus??200]]);
});
test('untyped SSE errors remain typed local stream errors',async()=>{await assert.rejects(zcodeStandardStream(new Response('data: {"error":{"message":"SAMPLE_ERROR"}}\n\n'),unexpected).text(),matches('zcode_proxy_stream_error',502));});
test('stream cancellation cancels the upstream reader',async()=>{let cancelled=false;const data=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"SAMPLE"}}]}\n\n');const input=new Response(new ReadableStream({start(c){c.enqueue(data);},cancel(){cancelled=true;}}));const reader=zcodeStandardStream(input,unexpected).body.getReader();await reader.read();await reader.cancel('SAMPLE_CANCEL');assert.equal(cancelled,true);});

test('no launch configuration performs no health or spawn operations',async()=>{await ensureZcodeProxy(runtime(),{fetchImpl:unexpected,spawnImpl:unexpected,sleep:unexpected});});
test('healthy authenticated owner is reused without spawning',async()=>{const config=runtime({launch});let hits=0;await ensureZcodeProxy(config,{fetchImpl:async(url,options)=>{hits++;assert.equal(String(url),new URL('/health',config.baseUrl).href);assert.equal(options.headers.authorization,`Bearer ${localKey}`);assert.equal(options.redirect,'error');return health(true);},spawnImpl:unexpected,sleep:unexpected});assert.equal(hits,1);});
test('concurrent callers singleflight one hidden detached launch',async()=>{
  const config=runtime({launch});let ready=false,spawns=0,hits=0;const child=fakeChild();
  const options={fetchImpl:async()=>{hits++;return health(ready);},spawnImpl:(command,args,spawnOptions)=>{spawns++;assert.equal(command,launch.command);assert.deepEqual(args,[launch.script]);assert.deepEqual(spawnOptions,{detached:true,windowsHide:true,stdio:'ignore'});ready=true;return child;},sleep:unexpected};
  await Promise.all(Array.from({length:8},()=>ensureZcodeProxy(config,options)));assert.equal(spawns,1);assert.equal(hits,2);assert.equal(child.unrefCount,1);
});
test('completed singleflight is removed so a later stopped owner can relaunch',async()=>{
  const config=runtime({launch});let ready=false,spawns=0;const options={fetchImpl:async()=>health(ready),spawnImpl:()=>{spawns++;ready=true;return fakeChild();},sleep:unexpected};
  await ensureZcodeProxy(config,options);ready=false;await ensureZcodeProxy(config,options);assert.equal(spawns,2);
});
for(const invalid of [{command:'SAMPLE_RELATIVE',script:launch.script},{command:launch.command,script:'SAMPLE_RELATIVE'},{script:launch.script},{command:launch.command}])test(`relative or absent launch path is rejected ${JSON.stringify(Object.keys(invalid))}`,async()=>{await assert.rejects(ensureZcodeProxy(runtime({launch:invalid}),{fetchImpl:async()=>health(false),spawnImpl:unexpected,sleep:unexpected}),matches('zcode_proxy_config',503));});
test('spawn error is bounded and failed singleflight is cleared for recovery',async()=>{
  const config=runtime({launch});let spawns=0;
  await assert.rejects(ensureZcodeProxy(config,{fetchImpl:async()=>health(false),spawnImpl:()=>{spawns++;const child=fakeChild();queueMicrotask(()=>child.emit('error',new Error('SAMPLE_SPAWN_ERROR')));return child;},sleep:unexpected}),matches('zcode_proxy_start_failed',503));
  let ready=false;await ensureZcodeProxy(config,{fetchImpl:async()=>health(ready),spawnImpl:()=>{spawns++;ready=true;return fakeChild();},sleep:unexpected});assert.equal(spawns,2);
});
test('unready owner times out after bounded health polls without real sleeping',async()=>{let hits=0,spawns=0,sleeps=0;await assert.rejects(ensureZcodeProxy(runtime({launch}),{fetchImpl:async()=>{hits++;return health(false);},spawnImpl:()=>{spawns++;return fakeChild();},sleep:async ms=>{assert.equal(ms,250);sleeps++;}}),matches('zcode_proxy_start_failed',503));assert.equal(hits,41);assert.equal(spawns,1);assert.equal(sleeps,40);});
test('malformed or unsuccessful health reply never counts as a ready owner',async()=>{let hits=0,spawned=false;await ensureZcodeProxy(runtime({launch}),{fetchImpl:async()=>{hits++;if(!spawned)return new Response('SAMPLE_INVALID_JSON');return hits===2?new Response(null,{status:401}):health(true);},spawnImpl:()=>{spawned=true;return fakeChild();},sleep:async()=>{}});assert.equal(hits,3);assert.equal(spawned,true);});
