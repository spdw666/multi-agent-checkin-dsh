import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {Router} from '../src/router.mjs';
import {ModelRelay} from '../src/model-relay.mjs';
import {adaptRelayReasoning} from '../src/relay-reasoning.mjs';
import {collectChat} from '../src/openai.mjs';
import {requestContract} from '../src/request-plan.mjs';

const request={model:'SAMPLE-route',messages:[{role:'user',content:'SAMPLE unchanged history'}],max_completion_tokens:64};
function routing(capacities=[128,512],contexts=capacities.map(()=>100000)){
 const calls=[],rows=[],state=new Map();
 const config={value:{accounts:capacities.map((_,i)=>({id:'a'+i,platform:'bigmodel'})),upstreams:capacities.map((_,i)=>({id:'u'+i,kind:'bigmodel',accountId:'a'+i})),routes:capacities.map((_,i)=>({id:i?'SAMPLE-standby'+i:request.model,targets:[{upstreamId:'u'+i,model:'SAMPLE-model'}]})),modelRelay:{enabled:true}}};
 const platforms={models:async id=>[{id:'SAMPLE-model',callable:true,tools:true,multimodal:false,maxTokens:capacities[+id.slice(1)],contextWindow:contexts[+id.slice(1)]}],chat:async(target,body)=>{calls.push({target,body});return {response:new Response(JSON.stringify({choices:[{message:{content:'SAMPLE answer'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})}}};
 const ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
 return {router:new Router(config,platforms,{ledger}),calls,rows,config};
}
test('optimization: final floor budget is checked against candidate output capacity before dispatch',async()=>{
 const f=routing(),before=structuredClone(request);await collectChat(f.router.chat(request));
 assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['u1']);assert.equal(f.calls[0].body.max_completion_tokens,256);assert.deepEqual(request,before);
 assert.equal(f.rows[0].status,'skipped');assert.equal(f.rows[0].error.code,'relay_capacity_incompatible');assert.equal(f.rows[1].requestContract.outputBudget,64);
});
test('optimization: all capacities below retained floor produce zero upstream requests',async()=>{
 const f=routing([16,128]);await assert.rejects(collectChat(f.router.chat(request)),e=>e.code==='same_model_unavailable'&&e.relayFailure.capacityGap.requested===256);
 assert.equal(f.calls.length,0);
});
test('optimization: capacity exactly at retained floor remains eligible',async()=>{
 const f=routing([256]);await collectChat(f.router.chat(request));assert.equal(f.calls[0].body.max_completion_tokens,256);
});
test('optimization: final floor context increase excludes a previously fitting smaller standby',async()=>{
 const original=requestContract(request).contextEstimate.upperBound,f=routing([128,512,512],[100000,original+100,100000]);
 await collectChat(f.router.chat(request));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['u2']);assert.equal(f.rows[1].error.code,'relay_context_incompatible');
});
for(const [left,right] of [[64,1024],[1024,64],[64,128],[256,512]])test(`optimization: mixed output fields ${left}/${right} never decrease or mutate caller`,()=>{
 const input={...request,max_tokens:left,max_completion_tokens:right},before=structuredClone(input),out=adaptRelayReasoning(input,{});
 assert.equal(out.request.max_tokens,Math.max(left,256));assert.equal(out.request.max_completion_tokens,Math.max(right,256));assert.deepEqual(input,before);
 if(Math.min(left,right)<256)assert.equal(out.metadata.changed,true);
});
test('optimization: untiered floor reports changed metadata and keeps messages by reference',()=>{
 const out=adaptRelayReasoning(request,{});assert.equal(out.metadata.changed,true);assert.equal(out.metadata.mode,'budget_floor');assert.equal(out.request.messages,request.messages);
});
test('optimization: nonrelay budget and caller body stay untouched',async()=>{
 const f=routing([128]);f.config.value.modelRelay.enabled=false;await collectChat(f.router.chat(request));assert.deepEqual(f.calls[0].body,request);
});

function balanceFixture(){
 let calls=0,release,upstreamSignal;
 const config={value:{accounts:[{id:'a',platform:'bigmodel'}],upstreams:[{id:'u',kind:'bigmodel',accountId:'a'}]}},target={upstreamId:'u'};
 const platform={health:(_,{signal})=>{calls++;upstreamSignal=signal;return new Promise((resolve,reject)=>{release=()=>resolve({cash:{availableBalance:23},packages:[]});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}};
 return {relay:new ModelRelay(config,platform),target,platform,get calls(){return calls},get upstreamSignal(){return upstreamSignal},release(){release()}};
}
test('optimization: canceling owner leaves shared balance query alive for another consumer',async()=>{
 const f=balanceFixture(),c=new AbortController(),a=f.relay.balance(f.target,c.signal),b=f.relay.balance(f.target);await Promise.resolve();
 c.abort();await assert.rejects(a,e=>e.status===499&&e.code==='request_cancelled');assert.equal(f.upstreamSignal.aborted,false);f.release();assert.equal((await b).value,23);assert.equal(f.calls,1);assert.equal(f.relay.flights.size,0);assert.equal(getEventListeners(c.signal,'abort').length,0);
});
test('optimization: canceling joining consumer promptly rejects without dropping shared query',async()=>{
 const f=balanceFixture(),c=new AbortController(),a=f.relay.balance(f.target),b=f.relay.balance(f.target,c.signal);await Promise.resolve();c.abort();
 let timer;try{await Promise.race([assert.rejects(b,e=>e.code==='request_cancelled'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cancel consumer still waiting')),500)})]);}
 finally{clearTimeout(timer);f.release();await a;}
 assert.equal(f.calls,1);assert.equal(getEventListeners(c.signal,'abort').length,0);
});
test('optimization: already canceled caller starts no balance query even with a fresh cache',async()=>{
 const f=balanceFixture(),c=new AbortController();c.abort();await assert.rejects(f.relay.balance(f.target,c.signal),e=>e.code==='request_cancelled');assert.equal(f.calls,0);
 const a=f.relay.balance(f.target);await Promise.resolve();f.release();await a;await assert.rejects(f.relay.balance(f.target,c.signal),e=>e.code==='request_cancelled');assert.equal(f.calls,1);
});
test('optimization: deadline consumer receives 504 while shared balance caller can finish',async()=>{
 const f=balanceFixture(),c=new AbortController(),a=f.relay.balance(f.target),b=f.relay.balance(f.target,c.signal);await Promise.resolve();c.abort(new DOMException('fixture deadline','TimeoutError'));
 await assert.rejects(b,e=>e.status===504&&e.code==='request_timeout');f.release();assert.equal((await a).value,23);
});
test('optimization: successful consumer detaches abort listeners and retains fresh cache',async()=>{
 const f=balanceFixture(),c=new AbortController(),a=f.relay.balance(f.target,c.signal);await Promise.resolve();f.release();const result=await a;
 assert.equal(getEventListeners(c.signal,'abort').length,0);assert.equal(await f.relay.balance(f.target),result);assert.equal(f.calls,1);assert.equal(f.relay.flights.size,0);
});
test('optimization: health failure releases flight and remains null without a permanent negative cache',async()=>{
 const f=balanceFixture();f.platform.health=async()=>{throw Error('fixture unavailable')};assert.equal(await f.relay.balance(f.target),null);assert.equal(f.relay.flights.size,0);
 f.platform.health=async()=>({cash:{availableBalance:23},packages:[]});assert.equal((await f.relay.balance(f.target)).value,23);
});
test('optimization: hanging health has bounded timeout, aborts upstream, releases flight and avoids stale cache',async()=>{
 const f=balanceFixture();let signal;f.platform.health=async(_,{signal:s})=>{signal=s;return new Promise(()=>{})};
 assert.equal(await f.relay.balance(f.target),null);assert.equal(signal.aborted,true);assert.equal(f.relay.flights.size,0);assert.equal(f.relay.balances.size,0);
});
