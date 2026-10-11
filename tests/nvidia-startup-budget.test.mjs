import test from 'node:test';
import assert from 'node:assert/strict';
import {nvidiaRequestTimeout,nvidiaModels,nvidiaChat,nvidiaFetch} from '../src/nvidia.mjs';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {auditStageTimeout} from '../src/model-audit.mjs';
const credential={apiKey:'nvapi-fixture-startup-budget-no-real-key'};
test('slow hosted Kimi startup budget is bounded and model-specific',()=>{
 assert.equal(nvidiaRequestTimeout('moonshotai/kimi-k3'),600000);
 assert.equal(nvidiaRequestTimeout('deepseek-ai/deepseek-v4.1-flash'),600000);
 assert.equal(nvidiaRequestTimeout('unknown'),180000);
 assert.equal(auditStageTimeout({kind:'nvidia'},{id:'deepseek-ai/deepseek-v4.1-flash'}),600000);
 assert.equal(auditStageTimeout({kind:'nvidia'},{id:'moonshotai/kimi-k3'}),600000);
 assert.equal(auditStageTimeout({kind:'nvidia'},{id:'other'}),120000);
 assert.equal(auditStageTimeout({kind:'workbuddy'},{id:'moonshotai/kimi-k3'}),45000);
});
test('deadline expiration is 504, not a user cancellation',async()=>{
 const signal=AbortSignal.abort(new DOMException('deadline','TimeoutError'));
 await assert.rejects(nvidiaModels(credential,{signal,fetchImpl:async()=>{throw Error('must not request')}}),e=>e.code==='nvidia_timeout'&&e.status===504);
});
test('user abort remains immediate 499 even for the slow model',async()=>{
 const signal=AbortSignal.abort();let calls=0;
 await assert.rejects(nvidiaChat({},credential,{model:'moonshotai/kimi-k3',messages:[{role:'user',content:'hi'}]},signal,{fetchImpl:async()=>{calls++;throw Error('not called')}}),e=>e.code==='request_cancelled'&&e.status===499);
 assert.equal(calls,0);
});
test('pending proxy CONNECT cancellation settles before a delayed socket error',async t=>{
 const req=new EventEmitter();let destroyed=false;req.end=()=>{};req.destroy=()=>{destroyed=true};
 t.mock.method(https,'request',()=>req);
 const ac=new AbortController(),pending=nvidiaFetch('https://integrate.api.nvidia.com/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'moonshotai/kimi-k3'}),signal:ac.signal});
 ac.abort();let timer;
 try {await assert.rejects(Promise.race([pending,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('late settlement')),250))]),e=>e.name==='AbortError');assert.equal(destroyed,true);}
 finally {clearTimeout(timer)}
});
