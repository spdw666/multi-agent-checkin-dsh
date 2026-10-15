import test from 'node:test';import assert from 'node:assert/strict';
import {Router} from '../src/router.mjs';import {collectChat} from '../src/openai.mjs';import {AppError} from '../src/util.mjs';import {gatewayRequestPolicy} from '../bundle/request-policy.mjs';
const id='deepseek-v4.1-flash',publicId='client/'+id;
function fixture(ms=40){const calls=[],rows=[],values=new Map(),config={value:{server:{requestTimeoutMs:10000},accounts:[{id:'p',platform:'codebuddy'},{id:'s',platform:'qoder'}],upstreams:[{id:'p',kind:'codebuddy',accountId:'p'},{id:'s',kind:'qoder',accountId:'s'}],routes:[{id:publicId,targets:[{upstreamId:'p',model:id}]},{id:'standby',targets:[{upstreamId:'s',model:id}]}],modelRelay:{enabled:true}}};const platforms={models:async()=>[{id,callable:true,tools:true,maxTokens:8192,reasoningEfforts:{low:'low',max:'max'}}],chat:async(t,r)=>{calls.push({t,r});return{response:new Response(JSON.stringify({choices:[{message:{content:'TIMEOUT_HANDOFF_OK'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})}}},ledger={get:k=>values.get(k),set:(k,v)=>values.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};return {router:new Router(config,platforms,{ledger,relayAttemptTimeoutMs:ms}),config,platforms,calls,rows,values};}
const request={model:publicId,messages:[{role:'system',content:'SAME_PROJECT_CONTEXT'},{role:'user',content:'Continue with original file tool'}],max_completion_tokens:4096,reasoning_effort:'max',tools:[{type:'function',function:{name:'read_sample',parameters:{type:'object'}}}],stream:true};
test('formal attempt deadline switches a never-resolving first fetch before whole request dies',async()=>{
 const f=fixture(),normal=f.platforms.chat;let firstSignal;
 f.platforms.chat=async(t,r,signal)=>{if(t.upstreamId!=='p')return normal(t,r,signal);f.calls.push({t,r});firstSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));};
 const out=await collectChat(f.router.chat(request));assert.equal(out.choices[0].message.content,'TIMEOUT_HANDOFF_OK');assert.equal(out.model,publicId);assert.deepEqual(f.calls.map(c=>c.t.upstreamId),['p','s']);assert.equal(firstSignal.aborted,true);assert.deepEqual(f.rows.map(r=>r.status),['failed','completed']);assert.equal(f.rows[0].error.code,'relay_target_timeout');assert.equal(f.rows[0].error.status,504);assert.deepEqual(f.calls[1].r.messages,request.messages);assert.deepEqual(f.calls[1].r.tools,request.tools);assert.equal(f.calls[1].r.max_completion_tokens,4096);
});
test('a stalled partial buffered tool is discarded, never leaked or replayed',async()=>{
 const f=fixture(),normal=f.platforms.chat;let aborted=false;
 f.platforms.chat=async(t,r,signal)=>{if(t.upstreamId!=='p')return normal(t,r,signal);f.calls.push({t,r});let ctrl;const body=new ReadableStream({start(c){ctrl=c;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'POISON',type:'function',function:{name:'read_sample',arguments:'{}'}}]},finish_reason:null}]})+'\n\n'));}});signal.addEventListener('abort',()=>{aborted=true;ctrl.error(new DOMException('aborted','AbortError'));},{once:true});return{response:new Response(body,{headers:{'content-type':'text/event-stream'}})}};
 const out=await collectChat(f.router.chat(request));assert.equal(out.choices[0].message.content,'TIMEOUT_HANDOFF_OK');assert.equal(out.choices[0].message.tool_calls,undefined);assert.equal(aborted,true);assert.equal(f.rows[0].error.code,'relay_target_timeout');assert.equal(f.calls.length,2);
});
test('actual caller cancellation still stops immediately with no fallback or supplier cooldown',async()=>{
 const f=fixture(200),controller=new AbortController();f.platforms.chat=async(t,r,signal)=>{f.calls.push({t,r});return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));};const timer=setTimeout(()=>controller.abort(),20);
 try{await assert.rejects(collectChat(f.router.chat(request,controller.signal)),e=>e.code==='request_cancelled'&&e.status===499);}finally{clearTimeout(timer)}assert.equal(f.calls.length,1);assert.equal(f.rows[0].status,'cancelled');assert.equal(f.values.get('relay-cooldown:p\0'+id),undefined);
});
test('whole-request deadline is504 failure rather than a voluntary caller cancellation',async()=>{
 const f=fixture(200),controller=new AbortController();f.platforms.chat=async(t,r,signal)=>{f.calls.push({t,r});return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));};const timer=setTimeout(()=>controller.abort(new DOMException('deadline','TimeoutError')),20);
 try{await assert.rejects(collectChat(f.router.chat(request,controller.signal)),e=>e.code==='request_timeout'&&e.status===504);}finally{clearTimeout(timer)}assert.equal(f.calls.length,1);assert.equal(f.rows[0].status,'failed');assert.equal(f.values.get('relay-cooldown:p\0'+id),undefined);
});
test('a success clears its attempt timer; later followup is not spuriously cancelled',async()=>{
 const f=fixture(20);let firstSignal;const normal=f.platforms.chat;f.platforms.chat=(t,r,s)=>{firstSignal=s;return normal(t,r,s);};await collectChat(f.router.chat(request));await new Promise(r=>setTimeout(r,35));assert.equal(firstSignal.aborted,false);assert.equal(f.rows[0].status,'completed');
});
test('relay disabled and audit paths retain original provider signal and behavior',async()=>{
 const f=fixture(),controller=new AbortController();f.config.value.modelRelay.enabled=false;let captured;const normal=f.platforms.chat;f.platforms.chat=(t,r,s)=>{captured=s;return normal(t,r,s);};await collectChat(f.router.chat(request,controller.signal));assert.equal(captured,controller.signal);
});
test('router metadata declares exact live whole budget and attempt budget without changing config',async()=>{
 const f=fixture(80),before=JSON.stringify(f.config.value);const model=await f.router.routeInfo(f.config.value.routes[0]);assert.equal(model.modelRelay.requestTimeoutMs,10000);assert.equal(model.modelRelay.attemptTimeoutMs,80);assert.equal(model.modelRelay.deliveryMode,'verified_request_buffer');assert.equal(JSON.stringify(f.config.value),before);
});
test('DSH verified buffer idle window includes complete server budget plus delivery margin',()=>{
 for(const [budget,expected] of [[180000,190000],[600000,610000],[1200000,1210000]])assert.equal(gatewayRequestPolicy({},[{id:publicId,modelRelay:{deliveryMode:'verified_request_buffer',requestTimeoutMs:budget}}]).streamIdleTimeoutMs,expected);
});
test('untrusted invalid or wrong-mode relay timeout metadata never extends idle window',()=>{
 for(const value of [null,undefined,'600000',NaN,Infinity,-1,0,1200001])assert.equal(gatewayRequestPolicy({},[{id:publicId,modelRelay:{deliveryMode:'verified_request_buffer',requestTimeoutMs:value}}]).streamIdleTimeoutMs,180000);assert.equal(gatewayRequestPolicy({},[{id:publicId,modelRelay:{deliveryMode:'streaming',requestTimeoutMs:600000}}]).streamIdleTimeoutMs,180000);
});
test('formal constructor attempt budget is bounded and not a request parameter',()=>{
 for(const value of [null,'80',-1,0,Infinity,600001,1.5])assert.throws(()=>fixture(value),TypeError);assert.equal(request.relayAttemptTimeoutMs,undefined);
});
