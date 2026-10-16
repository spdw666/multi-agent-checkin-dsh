import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter,getEventListeners} from 'node:events';
import {PassThrough} from 'node:stream';
const {providerFetch,closeProviderConnections}=await import(process.env.PROVIDER_HTTP_MODULE??'../src/provider-http.mjs');
import {buddyChat,buddyModels} from '../src/provider-buddy.mjs';

function transport(t,{reused=false}={}){
  const state={};
  t.mock.method(https,'request',(_url,options,onResponse)=>{
    const req=new EventEmitter();req.reusedSocket=reused;req.end=()=>{};
    req.destroy=()=>{state.requestDestroyed=true;};
    state.req=req;state.options=options;state.respond=res=>onResponse(res);
    return req;
  });
  t.after(closeProviderConnections);
  return state;
}
function socket(state,{encrypted=true}={}){
  const value=new EventEmitter();value.encrypted=encrypted;value.destroy=()=>{state.socketDestroyed=true;};
  state.req.emit('socket',value);return value;
}
function incoming(state,status=200){
  const res=new PassThrough();res.statusCode=status;res.headers={'content-type':'text/plain'};
  res.setTimeout=(ms,callback)=>{state.bodyTimeoutMs=ms;if(callback)state.bodyTimeout=callback;return res;};
  return res;
}
const url='https://www.workbuddy.ai/v2/chat/completions';
const options=signal=>({method:'POST',body:'{"model":"fixture"}',headersTimeoutMs:90000,requestTimeoutMs:180000,signal});

test('Chat TLS handshake remains bounded at 20s despite a 90s prefill allowance',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const state=transport(t),controller=new AbortController();
  const promise=providerFetch(url,options(controller.signal));socket(state);
  t.mock.timers.tick(20000);
  await assert.rejects(promise,e=>e.status===504&&e.code==='provider_timeout'&&e.networkPhase==='tls_handshake'&&e.timeoutOrigin==='connect_deadline');
  assert.equal(state.requestDestroyed,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('A healthy TLS connection can return its first chat header after the old 20s cutoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const state=transport(t),controller=new AbortController();
  const promise=providerFetch(url,options(controller.signal)),connection=socket(state);
  t.mock.timers.tick(5000);connection.emit('secureConnect');t.mock.timers.tick(21000);
  assert.notEqual(state.requestDestroyed,true);
  const res=incoming(state);state.respond(res);const response=await promise;
  res.end('actual-delayed-response');assert.equal(await response.text(),'actual-delayed-response');
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  assert.equal(connection.listenerCount('secureConnect'),0);assert.equal(connection.listenerCount('connect'),0);
});

test('Chat header deadline starts at TLS completion and remains bounded',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const state=transport(t),controller=new AbortController();
  const promise=providerFetch(url,options(controller.signal)),connection=socket(state);
  t.mock.timers.tick(10000);connection.emit('secureConnect');t.mock.timers.tick(89999);
  assert.notEqual(state.requestDestroyed,true);t.mock.timers.tick(1);
  await assert.rejects(promise,e=>e.code==='provider_timeout'&&e.networkPhase==='response_header'&&e.timeoutOrigin==='header_deadline');
});

test('Ordinary GET header budget stays 20s instead of inheriting chat prefill',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const state=transport(t),controller=new AbortController();
  const promise=providerFetch('https://www.workbuddy.ai/v3/config',{signal:controller.signal}),connection=socket(state);
  connection.emit('secureConnect');t.mock.timers.tick(20000);
  await assert.rejects(promise,e=>e.code==='provider_timeout'&&e.timeoutOrigin==='header_deadline'&&e.networkPhase==='response_header');
});

test('Reused TLS sockets immediately receive the header budget without a second secureConnect',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const state=transport(t,{reused:true}),controller=new AbortController();
  const promise=providerFetch(url,options(controller.signal));socket(state);t.mock.timers.tick(25000);
  assert.notEqual(state.requestDestroyed,true);const res=incoming(state);state.respond(res);const response=await promise;
  res.end('reused-tls');assert.equal(await response.text(),'reused-tls');
});

test('A silent reused TLS socket still expires at the header deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const state=transport(t,{reused:true}),controller=new AbortController();
  const promise=providerFetch(url,options(controller.signal));socket(state);t.mock.timers.tick(90000);
  await assert.rejects(promise,e=>e.code==='provider_timeout'&&e.timeoutOrigin==='header_deadline'&&e.networkPhase==='response_header');
});

test('Whole request cancellation interrupts a pending chat header immediately',async t=>{
  const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  const connection=socket(state);connection.emit('secureConnect');controller.abort();
  await assert.rejects(promise,e=>e.code==='request_cancelled'&&e.status===499&&e.networkPhase==='response_header'&&!e.timeoutOrigin);
  assert.equal(state.requestDestroyed,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('Whole deadline interrupts the response body and preserves its distinct origin',async t=>{
  const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  const connection=socket(state);connection.emit('secureConnect');const res=incoming(state);state.respond(res);
  const response=await promise,reading=response.text();controller.abort(new DOMException('PRIVATE DEADLINE DETAIL','TimeoutError'));
  await assert.rejects(reading,e=>e.code==='provider_timeout'&&e.status===504&&e.networkPhase==='response_body'&&e.timeoutOrigin==='request_deadline'&&!JSON.stringify(e).includes('PRIVATE'));
  assert.equal(res.destroyed,true);assert.equal(state.requestDestroyed,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('User cancellation after response headers destroys the body without changing to timeout',async t=>{
  const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  const res=incoming(state);state.respond(res);const response=await promise,reading=response.text();controller.abort();
  await assert.rejects(reading,e=>e.code==='request_cancelled'&&e.status===499&&e.networkPhase==='response_body'&&!e.timeoutOrigin);
  assert.equal(res.destroyed,true);assert.equal(state.requestDestroyed,true);
});

test('Body idle uses its own bounded timeout and destroys both streams',async t=>{
  const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  const res=incoming(state);state.respond(res);const response=await promise,reading=response.text();
  assert.equal(state.bodyTimeoutMs,120000);state.bodyTimeout();
  await assert.rejects(reading,e=>e.code==='provider_timeout'&&e.timeoutOrigin==='body_idle'&&e.networkPhase==='response_body'&&e.transportCode==='ETIMEDOUT');
  assert.equal(res.destroyed,true);assert.equal(state.requestDestroyed,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('Body network reset maps to sanitized transport metadata, not a timeout',async t=>{
  const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  const res=incoming(state);state.respond(res);const response=await promise,reading=response.text();
  res.emit('error',Object.assign(new Error('SENTINEL TOKEN BYTES'),{code:'ECONNRESET'}));
  await assert.rejects(reading,e=>e.code==='provider_network_error'&&e.status===503&&e.networkPhase==='response_body'&&e.transportCode==='ECONNRESET'&&!e.timeoutOrigin&&!JSON.stringify(e).includes('SENTINEL'));
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('Consumer body cancellation closes the official request and removes abort listeners',async t=>{
  const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  const res=incoming(state);state.respond(res);const response=await promise;
  await response.body.cancel();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(res.destroyed,true);assert.equal(state.requestDestroyed,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('Late socket and headers after a deadline are destroyed rather than leaked',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  t.mock.timers.tick(20000);await assert.rejects(promise,{code:'provider_timeout'});
  socket(state);const res=incoming(state);state.respond(res);assert.equal(state.socketDestroyed,true);assert.equal(res.destroyed,true);
});

test('Invalid response status cleans up its response and pending deadline',async t=>{
  const state=transport(t),controller=new AbortController(),promise=providerFetch(url,options(controller.signal));
  const res=incoming(state,101);state.respond(res);await assert.rejects(promise,{code:'provider_invalid_response'});
  assert.equal(res.destroyed,true);assert.equal(state.requestDestroyed,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('Timeout options reject non-integer and unbounded values before opening a connection',()=>{
  for(const value of [0,-1,1.5,NaN,Infinity,1200001])for(const field of ['headersTimeoutMs','requestTimeoutMs'])assert.throws(()=>providerFetch(url,{[field]:value}),{code:'provider_timeout_invalid'});
});

test('Buddy chat declares 90s first headers and a 180s fallback while preserving caller signal and payload',async()=>{
  const controller=new AbortController(),input={model:'fixture',messages:[{role:'user',content:'unchanged-history'}],max_tokens:12345};
  const credential={accessToken:'SENTINEL-PRIVATE',uid:'fixture',domain:'www.workbuddy.ai'};
  await buddyChat({},credential,input,controller.signal,{fetchImpl:async(_url,o)=>{
    assert.equal(o.headersTimeoutMs,90000);assert.equal(o.requestTimeoutMs,180000);assert.equal(o.signal,controller.signal);
    const wire=JSON.parse(o.body);assert.equal(wire.messages.find(m=>m.role==='user').content,'unchanged-history');assert.equal(wire.max_tokens,12345);
    return new Response('data: [DONE]\n\n');
  }});
});

test('Buddy ordinary catalog does not request the chat-only extended header budget',async()=>{
  await buddyModels({accessToken:'SENTINEL',uid:'fixture',domain:'www.workbuddy.ai'},{fetchImpl:async(_url,o)=>{
    assert.equal(o.headersTimeoutMs,undefined);assert.equal(o.requestTimeoutMs,undefined);
    return new Response(JSON.stringify({code:0,data:{models:[{id:'fixture',name:'Fixture',maxInputTokens:100000,maxOutputTokens:5000}],agents:[]}}));
  }});
});
