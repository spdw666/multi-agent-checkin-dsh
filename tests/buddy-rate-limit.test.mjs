import test from 'node:test';
import assert from 'node:assert/strict';
import {buddyChat} from '../src/provider-buddy.mjs';
import {applyRateLimitEvidence,parseResetDeadline,businessRateLimitKind} from '../src/provider-rate-limit.mjs';

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
// CodeBuddy 客户端面板显示的那句「将在 … UTC+8 重置」就是从 429 响应体里来的。
// buddyChatRejection 原先只读 Retry-After 头，body 里的时刻从来没被读出来。
// 用一个相对当前时间生成的时刻，避免测试随时间推移失效。
function utc8Stamp(ms){
  const d=new Date(ms+8*3600*1000);
  const pad=n=>String(n).padStart(2,'0');
  return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+':'+pad(d.getUTCSeconds());
}

test('Buddy 429 body text deadline becomes official_body when no Retry-After header',async()=>{
  const deadline=utc8Stamp(Date.now()+1800*1000);
  const error=await rejection(response({code:6004,msg:'您的使用量已超出频率限制，将在 '+deadline+' UTC+8 重置，您也可以切换其他模型继续使用。'}));
  assert.equal(error.rateLimitKind,'long_window');
  assert.equal(error.retryAfterSource,'official_body');
  assert.ok(error.retryAfterSeconds>1780&&error.retryAfterSeconds<=1801,
    'deadline should resolve to roughly 30 minutes, got '+error.retryAfterSeconds);
});

test('a Retry-After header outranks the body deadline',async()=>{
  const deadline=utc8Stamp(Date.now()+1800*1000);
  const error=await rejection(response({code:6004,msg:'将在 '+deadline+' UTC+8 重置'},{'retry-after':'120'}));
  assert.equal(error.retryAfterSource,'official_header');
  assert.equal(error.retryAfterSeconds,120);
});

test('a body without a parsable deadline leaves the cooldown local instead of guessing',async()=>{
  const error=await rejection(response({code:6004,msg:'请求过于频繁，请稍后再试'}));
  assert.equal(error.rateLimitKind,'long_window');
  assert.equal(error.retryAfterSeconds,undefined);
  assert.equal(error.retryAfterSource,undefined);
});
// WorkBuddy 平台（vendor/workbuddy-core.mjs 的 chatStream）不走 buddyChatRejection：
// 它把 vendor 的 kind 字符串直接当错误码抛出，于是 6004 对外一直是 unknown、
// 也拿不到恢复时刻。applyRateLimitEvidence 就是给它补这一段的地方。
// 真实报文（usage_calls 43525）：
const WB_RESET='您的使用量已超出频率限制，将在 2026-11-18 14:35:43 UTC+8 重置，您也可以切换其他模型继续使用。';
const WB_NOW=Date.parse('2026-11-18T13:50:00+08:00');

test('WorkBuddy 429 gains the official business code and its reset clock from displayMsg',()=>{
  const error=new Error('workbuddy upstream soft_rate (http 429): '+WB_RESET);
  applyRateLimitEvidence(error,{status:429,detail:{upstreamCode:6004,displayMsg:WB_RESET},now:WB_NOW});
  assert.equal(error.upstreamCode,6004);
  assert.equal(error.rateLimitKind,'long_window');
  assert.equal(error.rateLimitRetryable,false);
  // 13:50:00 -> 14:35:43 = 2743 秒
  assert.equal(error.retryAfterSeconds,2743);
  assert.equal(error.retryAfterSource,'official_body');
});

test('WorkBuddy 429 without a parsable deadline yields no official evidence instead of guessing',()=>{
  const error=new Error('workbuddy upstream soft_rate (http 429): 请求过于频繁');
  applyRateLimitEvidence(error,{status:429,detail:{upstreamCode:6004,displayMsg:'请求过于频繁，请稍后再试'},now:WB_NOW});
  // 类别仍然由官方业务码决定，但恢复时刻不许编。
  assert.equal(error.rateLimitKind,'long_window');
  assert.equal(error.retryAfterSeconds,undefined);
  assert.equal(error.retryAfterSource,undefined);
});

test('non-429 responses never gain rate-limit evidence',()=>{
  const error=new Error('workbuddy upstream client (http 400): bad request');
  applyRateLimitEvidence(error,{status:400,detail:{upstreamCode:6004,displayMsg:WB_RESET},now:WB_NOW});
  assert.equal(error.upstreamCode,undefined);
  assert.equal(error.retryAfterSeconds,undefined);
});

test('an unknown official code stays uncategorised rather than defaulting to a kind',()=>{
  const error=new Error('workbuddy upstream soft_rate (http 429): x');
  applyRateLimitEvidence(error,{status:429,detail:{upstreamCode:999999,displayMsg:WB_RESET},now:WB_NOW});
  assert.equal(error.upstreamCode,undefined);
  assert.equal(error.rateLimitKind,undefined);
  // 时间仍然可用：它来自报文本身，不依赖业务码是否认识。
  assert.equal(error.retryAfterSeconds,2743);
});

test('reset deadline parsing is strict about the clock it accepts',()=>{
  assert.deepEqual(parseResetDeadline(WB_RESET,WB_NOW),{seconds:2743,at:Date.UTC(2026,10,18,6,35,43)});
  assert.equal(parseResetDeadline('14:35:43 重置',WB_NOW),undefined);
  assert.equal(parseResetDeadline('2026-11-18T14:35:43+08:00',WB_NOW),undefined);
  assert.equal(parseResetDeadline('2026-11-18 14:35:43 UTC+9',WB_NOW),undefined);
});

test('business code classification is shared, not duplicated per platform',()=>{
  assert.equal(businessRateLimitKind(6004),'long_window');
  assert.equal(businessRateLimitKind(6001),'transient');
  assert.equal(businessRateLimitKind(14015),'usage_limit');
  assert.equal(businessRateLimitKind(6000),'unknown');
  assert.equal(businessRateLimitKind(999999),undefined);
});
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
