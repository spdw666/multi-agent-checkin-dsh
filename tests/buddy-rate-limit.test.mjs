import test from 'node:test';
import assert from 'node:assert/strict';
import {buddyChat} from '../src/provider-buddy.mjs';

const credential={accessToken:'SAMPLE-PRIVATE-BUDDY-TOKEN',uid:'SAMPLE',principal:'SAMPLE',domain:'www.workbuddy.ai'};
const input={model:'deepseek-v4.1-flash',messages:[{role:'user',content:'SAMPLE complete history'}],tools:[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}],max_completion_tokens:128000,reasoning_effort:'max',stream:false};
const response=(body,headers={},status=429)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers});
async function rejection(value,options={},signal){
  let seen;
  try{await buddyChat({},credential,input,signal,{...options,fetchImpl:async()=>value})}catch(error){seen=error}
  assert.ok(seen,'buddyChat must reject');
  assert.equal(seen.code,'provider_chat_rejected');
  assert.equal(seen.status,value.status);
  assert.doesNotMatch(JSON.stringify(seen)+seen.stack,/SAMPLE-PRIVATE|secret\.invalid|ORIGINAL-SECRET/);
  return seen;
}
const cases=[
  [6000,'unknown',false],
  ...[6001,6002,6005,6006,14003].map(code=>[code,'transient',true]),
  ...[6003,6004,6007,6008].map(code=>[code,'long_window',false]),
  ...[14001,14012,14013,14014,14015,14016,14017,14018,14019].map(code=>[code,'usage_limit',false]),
];
for(const [code,kind,retryable] of cases)test(`Buddy HTTP429 official business ${code} => ${kind}`,async()=>{
  const error=await rejection(response({code,message:'ORIGINAL-SECRET',url:'https://secret.invalid/'}));
  assert.equal(error.upstreamCode,code);
  assert.equal(error.rateLimitKind,kind);
  assert.equal(error.rateLimitRetryable,retryable);
  assert.equal(error.retryAfterSeconds,undefined);
  assert.equal(error.retryAfterSource,undefined);
});
for(const [label,body] of [
  ['top',{code:'6002'}],['error',{error:{code:6002}}],
  ['error data',{code:429,error:{code:429,data:{code:'6002'}}}],
  ['data',{code:0,data:{code:6002}}],['data error',{data:{error:{code:6002}}}],
])test(`Buddy bounded official numeric code nesting: ${label}`,async()=>{
  const error=await rejection(response(body));assert.equal(error.upstreamCode,6002);assert.equal(error.rateLimitRetryable,true);
});
test('Buddy official error.data code takes precedence over wrapper codes',async()=>{
  const error=await rejection(response({code:6002,error:{code:6001,data:{code:6004}}}));
  assert.equal(error.upstreamCode,6004);assert.equal(error.rateLimitKind,'long_window');assert.equal(error.rateLimitRetryable,false);
});
for(const [label,body] of [
  ['unknown number',{code:987654}],['message-only',{message:'6002 ORIGINAL-SECRET'}],
  ['array', [{code:6002}]],['fraction',{code:6002.5}],['boolean',{code:true}],
  ['partial numeric',{code:'6002 ORIGINAL-SECRET'}],['arbitrary nested',{untrusted:{code:6002}}],
  ['invented policy',{retry_policy:{retry:true,after:17},retryAfter:17,message:'ORIGINAL-SECRET'}],
])test(`Buddy unknown429 does not infer business cause or policy: ${label}`,async()=>{
  const error=await rejection(response(body));assert.equal(error.upstreamCode,undefined);assert.equal(error.rateLimitKind,'unknown');assert.equal(error.rateLimitRetryable,false);assert.equal(error.retryAfterSeconds,undefined);
});
for(const seconds of [0,17])test(`Buddy preserves official Retry-After seconds ${seconds}`,async()=>{
  const error=await rejection(response({code:6002},{'Retry-After':String(seconds)}));assert.equal(error.retryAfterSeconds,seconds);assert.equal(error.retryAfterSource,'official_header');
});
test('Buddy parses official Retry-After HTTP-date against receipt time',async()=>{
  const date=new Date(Date.now()+17000).toUTCString();const error=await rejection(response({code:6002},{'Retry-After':date}));
  assert.ok(error.retryAfterSeconds>=15&&error.retryAfterSeconds<=17);assert.equal(error.retryAfterSource,'official_header');
});
test('Buddy past official HTTP-date is retained as zero',async()=>{
  const error=await rejection(response({code:6004},{'Retry-After':'Wed, 01 Jan 2020 00:00:00 GMT'}));assert.equal(error.retryAfterSeconds,0);assert.equal(error.rateLimitRetryable,false);
});
for(const header of ['invalid','-17','1.5','1e3','99999999999999999999999','86401','Wed, 01 Jan 2100 00:00:00 GMT'])test(`Buddy rejects invalid or excessive Retry-After ${header}`,async()=>{
  const error=await rejection(response({code:6002},{'Retry-After':header}));assert.equal(error.retryAfterSeconds,undefined);assert.equal(error.retryAfterSource,undefined);
});
test('Buddy unknown429 Retry-After remains unknown and not blindly retryable',async()=>{
  const error=await rejection(response({message:'ORIGINAL-SECRET'},{'Retry-After':'17'}));assert.equal(error.retryAfterSeconds,17);assert.equal(error.rateLimitKind,'unknown');assert.equal(error.rateLimitRetryable,false);
});
test('Buddy long-window and usage body cannot turn retryable through arbitrary policy',async()=>{
  for(const code of [6004,14018]){const error=await rejection(response({code,retry_policy:{retry:true},retryAfter:1},{'Retry-After':'17'}));assert.equal(error.rateLimitRetryable,false);assert.equal(error.retryAfterSeconds,17)}
});
test('Buddy HTML rejection is secret-free unknown429',async()=>{
  const error=await rejection(response('<html>ORIGINAL-SECRET Bearer SAMPLE-PRIVATE-BUDDY-TOKEN https://secret.invalid</html>'));assert.equal(error.rateLimitKind,'unknown');assert.equal(error.upstreamCode,undefined);
});
function fakeBody({chunks=[],readError,hang=false,cancelHang=false}={}){
  const state={reads:0,cancels:0,releases:0};let offset=0;
  return {state,body:{getReader(){return {read(){state.reads++;if(readError)return Promise.reject(new Error(readError));if(offset<chunks.length)return Promise.resolve({value:chunks[offset++],done:false});return hang?new Promise(()=>{}):Promise.resolve({done:true})},cancel(){state.cancels++;return cancelHang?new Promise(()=>{}):Promise.resolve()},releaseLock(){state.releases++}}}}};
}
test('Buddy error-body byte cap cancels without parsing truncated prefix',async()=>{
  const fixture=fakeBody({chunks:[Buffer.from('{"code":6002,"padding":"'),Buffer.alloc(20000,120)],hang:true});
  const error=await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body});assert.equal(error.upstreamCode,undefined);assert.equal(fixture.state.cancels,1);assert.equal(fixture.state.releases,1);assert.equal(fixture.state.reads,2);
});
test('Buddy byte cap counts UTF8 bytes rather than characters',async()=>{
  const fixture=fakeBody({chunks:[Buffer.from(JSON.stringify({code:6002,padding:'汉'.repeat(6000)}))]});
  const error=await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body});assert.equal(error.upstreamCode,undefined);assert.equal(fixture.state.cancels,1);assert.equal(fixture.state.releases,1);
});
test('Buddy slow error-body and hanging cancellation stay time-bounded',async()=>{
  const fixture=fakeBody({hang:true,cancelHang:true});const started=Date.now();
  const error=await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body},{errorBodyTimeoutMs:25});assert.ok(Date.now()-started<350);assert.equal(error.rateLimitKind,'unknown');assert.equal(fixture.state.cancels,1);assert.equal(fixture.state.releases,1);
});
test('Buddy abort interrupts pending error read and removes its signal listener',async()=>{
  const controller=new AbortController(),fixture=fakeBody({hang:true});let active=0;
  const signal=controller.signal,add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
  signal.addEventListener=(...args)=>{if(args[0]==='abort')active++;return add(...args)};signal.removeEventListener=(...args)=>{if(args[0]==='abort')active--;return remove(...args)};
  const timer=setTimeout(()=>controller.abort(new Error('ORIGINAL-SECRET')),15);
  try{const error=await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body},{errorBodyTimeoutMs:200},signal);assert.equal(error.rateLimitKind,'unknown');assert.equal(fixture.state.cancels,1);assert.equal(fixture.state.releases,1);assert.equal(active,0)}finally{clearTimeout(timer)}
});
test('Buddy pre-aborted error read does not consume body',async()=>{
  const fixture=fakeBody({chunks:[Buffer.from('{"code":6002}')]}),controller=new AbortController();controller.abort();
  const error=await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body},{},controller.signal);assert.equal(error.upstreamCode,undefined);assert.equal(fixture.state.reads,0);assert.equal(fixture.state.cancels,1);assert.equal(fixture.state.releases,1);
});
test('Buddy stream read error details never leak and reader is cleaned',async()=>{
  const fixture=fakeBody({readError:'ORIGINAL-SECRET https://secret.invalid'});const error=await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body});assert.equal(error.upstreamCode,undefined);assert.equal(fixture.state.cancels,1);assert.equal(fixture.state.releases,1);
});
test('Buddy empty body preserves official status without raw response APIs',async()=>{
  const error=await rejection({ok:false,status:503,headers:new Headers(),body:null,text(){throw new Error('must not call')},json(){throw new Error('must not call')}});assert.equal(error.rateLimitRetryable,false);
});
test('Buddy non429 status is not made transient merely by body code',async()=>{
  const error=await rejection(response({code:6002},{},403));assert.equal(error.status,403);assert.equal(error.upstreamCode,6002);assert.equal(error.rateLimitRetryable,false);
});
test('Buddy caller complete input/tools/budget remain unchanged on rejection',async()=>{
  const before=structuredClone(input);let sent;
  try{await buddyChat({},credential,input,undefined,{fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return response({code:6004})}})}catch{}
  assert.deepEqual(input,before);assert.equal(sent.model,input.model);assert.deepEqual(sent.messages.slice(-input.messages.length),input.messages);assert.deepEqual(sent.tools,input.tools);assert.equal(sent.max_tokens,128000);assert.equal(sent.reasoning_effort,'max');assert.equal(sent.stream,true);
});
test('Buddy successful response is left unread and existing recovery survives',async()=>{
  const value=new Response('data: [DONE]\n\n');const result=await buddyChat({},credential,input,undefined,{fetchImpl:async()=>value});assert.equal(result.response,value);assert.equal(value.bodyUsed,false);assert.ok(result.recovery);
});
test('Buddy fragmented JSON is parsed only after its bounded complete body',async()=>{
  const fixture=fakeBody({chunks:[Buffer.from('{"error":{"data":'),Buffer.from('{"code":6002}}}')]});
  const error=await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body});assert.equal(error.upstreamCode,6002);assert.equal(fixture.state.reads,3);assert.equal(fixture.state.releases,1);
});
test('Buddy actual Web ReadableStream oversize cancellation releases its lock',async()=>{
  let cancelled=0;const stream=new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(20000,120))},cancel(){cancelled++}});
  const value=new Response(stream,{status:429});value.text=()=>{throw new Error('unbounded text API forbidden')};value.json=()=>{throw new Error('unbounded JSON API forbidden')};
  const error=await rejection(value);assert.equal(error.rateLimitKind,'unknown');assert.equal(cancelled,1);assert.equal(stream.locked,false);
});
test('Buddy actual Web ReadableStream timeout cancels without waiting for upstream close',async()=>{
  let cancelled=0;const stream=new ReadableStream({cancel(){cancelled++}});
  const error=await rejection(new Response(stream,{status:429}),{errorBodyTimeoutMs:15});assert.equal(error.rateLimitKind,'unknown');assert.equal(cancelled,1);assert.equal(stream.locked,false);
});
test('Buddy complete error read clears its timeout and external abort listener',async()=>{
  const controller=new AbortController(),signal=controller.signal;let active=0;
  const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
  signal.addEventListener=(...args)=>{if(args[0]==='abort')active++;return add(...args)};signal.removeEventListener=(...args)=>{if(args[0]==='abort')active--;return remove(...args)};
  const error=await rejection(response({code:6002}),{},signal);assert.equal(error.upstreamCode,6002);assert.equal(active,0);
});
test('Buddy caller read limits can shrink but never enlarge the fixed byte ceiling',async()=>{
  const first=await rejection(response({code:6002,padding:'x'.repeat(200)}),{errorBodyMaxBytes:64});assert.equal(first.upstreamCode,undefined);
  const second=await rejection(response({code:6002,padding:'x'.repeat(20000)}),{errorBodyMaxBytes:1000000});assert.equal(second.upstreamCode,undefined);
});
test('Buddy caller timeout cannot enlarge fixed 500ms deadline',async()=>{
  const fixture=fakeBody({hang:true,cancelHang:true}),started=Date.now();await rejection({ok:false,status:429,headers:new Headers(),body:fixture.body},{errorBodyTimeoutMs:1000000});assert.ok(Date.now()-started<1200);assert.equal(fixture.state.cancels,1);assert.equal(fixture.state.releases,1);
});
test('Buddy unknown inner official code does not fall back to misleading wrapper cause',async()=>{
  const error=await rejection(response({code:6002,error:{data:{code:987654}}}));assert.equal(error.upstreamCode,undefined);assert.equal(error.rateLimitKind,'unknown');assert.equal(error.rateLimitRetryable,false);
});
test('Buddy error object contains only sanitized standard flat metadata',async()=>{
  const error=await rejection(response({code:6002,error:{message:'ORIGINAL-SECRET'},cause:'ORIGINAL-SECRET',url:'https://secret.invalid'},{'Retry-After':'17'}));
  assert.deepEqual(Object.keys(error).sort(),['code','rateLimitKind','rateLimitRetryable','retryAfterSeconds','retryAfterSource','status','upstreamCode'].sort());
});
