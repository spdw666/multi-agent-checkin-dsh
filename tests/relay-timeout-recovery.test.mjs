import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {collectChat} from '../src/openai.mjs';
import {AppError,errorView} from '../src/util.mjs';

// The same behavioral assertions run against the immutable original with this
// override; no real provider, account, usage event or paid generation is used.
const {Router}=await import(process.env.RELAY_TIMEOUT_ROUTER_MODULE
  ?pathToFileURL(process.env.RELAY_TIMEOUT_ROUTER_MODULE).href
  :new URL('../src/router.mjs',import.meta.url).href);
const model='deepseek-v4.1-flash',publicId='fixture/'+model;
function fixture({single=false,idle=40,prefill=140,small=false}={}) {
  const ids=single?['primary']:['primary','standby'],rows=[],calls=[],values=new Map();
  const config={value:{server:{requestTimeoutMs:10000},accounts:ids.map(id=>({id,platform:'codebuddy'})),
    upstreams:ids.map(id=>({id,accountId:id,kind:'codebuddy'})),modelRelay:{enabled:true},
    routes:ids.map((id,i)=>({id:i?('standby/'+model):publicId,targets:[{upstreamId:id,model}]}))}};
  const metadata=Object.fromEntries(ids.map(id=>[id,{id:model,callable:true,tools:true,multimodal:true,contextWindow:id==='standby'&&small?200000:1000000,maxTokens:64000}]));
  const platforms={models:async id=>[metadata[id]],chat:async(target,request,signal)=>{
    calls.push({target:structuredClone(target),request:structuredClone(request),signal});
    return {response:Response.json({choices:[{message:{content:'PREFILL_RECOVERY_OK'},finish_reason:'stop'}]})};
  }};
  const ledger={get:k=>values.get(k),set:(k,v)=>values.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
  const router=new Router(config,platforms,{ledger,relayAttemptTimeoutMs:idle,relayPrefillTimeoutMs:prefill,relayNetworkRetryDelayMs:0});
  return {router,config,platforms,metadata,rows,calls,values};
}
function request({large=true}={}) {return {model:publicId,stream:true,max_completion_tokens:4096,
  messages:[{role:'system',content:'Preserve the original messages and tools.'},{role:'user',content:large?'上下文'.repeat(35000):'Continue SAMPLE.'},
    {role:'assistant',content:null,tool_calls:[{id:'original-call',type:'function',function:{name:'read_sample',arguments:'{"path":"SAMPLE"}'}}]},
    {role:'tool',tool_call_id:'original-call',content:'COMPLETE_ORIGINAL_TOOL_RESULT'}],
  tools:[{type:'function',function:{name:'read_sample',parameters:{type:'object',properties:{path:{type:'string'}}}}}],tool_choice:'auto'};}
const networkTimeout=()=>new AppError('The upstream response deadline expired',504,'provider_timeout');
function logCall(f,target,raw,signal){f.calls.push({target:structuredClone(target),request:structuredClone(raw),signal});}
function waiting(signal){return new Promise((_,reject)=>{
  const fail=()=>reject(new DOMException('Fixture aborted','AbortError'));
  if(signal?.aborted)fail();else signal?.addEventListener('abort',fail,{once:true});
});}
function delayedResponse(ms,signal) {return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve({response:Response.json({choices:[{message:{content:'PREFILL_RECOVERY_OK'},finish_reason:'stop'}]})});},ms);
  const abort=()=>{clearTimeout(timer);reject(new DOMException('Fixture aborted','AbortError'));};
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
});}
function streamResponse(signal,{events=[],heartbeat=0}={}) {
  const timers=new Set();let interval,closed=false,controller;
  const cleanup=()=>{for(const timer of timers)clearTimeout(timer);clearInterval(interval);};
  const frame=delta=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n';
  const body=new ReadableStream({start(c){controller=c;
    for(const [at,delta]of events)timers.add(setTimeout(()=>{if(!closed)c.enqueue(new TextEncoder().encode(frame(delta)));},at));
    if(heartbeat)interval=setInterval(()=>{if(!closed)c.enqueue(new TextEncoder().encode(': ping\n\n'));},heartbeat);
  },cancel(){closed=true;cleanup();}});
  const abort=()=>{if(closed)return;closed=true;cleanup();controller.error(new DOMException('Fixture aborted','AbortError'));};
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  return {response:new Response(body,{headers:{'content-type':'text/event-stream'}})};
}
function preserveAll(f,raw) {
  assert.ok(f.calls.every(c=>JSON.stringify(c.request)===JSON.stringify(raw)),'all retries must retain model ID, complete history, original tool call/result and output budget');
}

test('prefill: large unchanged history may wait beyond idle budget for first supplier response',async()=>{
  const f=fixture(),raw=request(),before=JSON.stringify(raw),normal=f.platforms.chat;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);return delayedResponse(75,s);};
  const out=await collectChat(f.router.chat(raw));
  assert.equal(out.choices[0].message.content,'PREFILL_RECOVERY_OK');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);
  assert.equal(out.model,publicId);assert.equal(JSON.stringify(raw),before);preserveAll(f,raw);assert.equal(f.rows[0].status,'completed');
});

test('prefill: first SSE role event does not end the prefill allowance before actual content',async()=>{
  const f=fixture(),raw=request(),normal=f.platforms.chat;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);
    const encoder=new TextEncoder(),timers=[];let finished=false,c;
    const body=new ReadableStream({start(controller){c=controller;const send=x=>{if(!finished)c.enqueue(encoder.encode('data: '+JSON.stringify(x)+'\n\n'));};
      timers.push(setTimeout(()=>send({choices:[{delta:{role:'assistant'},finish_reason:null}]}),5));
      timers.push(setTimeout(()=>{send({choices:[{delta:{content:'PREFILL_RECOVERY_OK'},finish_reason:'stop'}]});finished=true;c.close();},75));
    },cancel(){finished=true;timers.forEach(clearTimeout);}});
    s.addEventListener('abort',()=>{if(!finished){finished=true;timers.forEach(clearTimeout);c.error(new DOMException('aborted','AbortError'));}},{once:true});
    return {response:new Response(body,{headers:{'content-type':'text/event-stream'}})};
  };
  const out=await collectChat(f.router.chat(raw));assert.equal(out.choices[0].message.content,'PREFILL_RECOVERY_OK');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);preserveAll(f,raw);
});

test('prefill: short requests retain the existing idle budget instead of a gratuitous long wait',async()=>{
  const f=fixture({prefill:400}),raw=request({large:false}),normal=f.platforms.chat;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);return delayedResponse(80,s);};
  const out=await collectChat(f.router.chat(raw));assert.equal(out.choices[0].message.content,'PREFILL_RECOVERY_OK');
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','standby']);assert.equal(f.calls[0].signal.aborted,true);preserveAll(f,raw);
});

test('prefill: silence is bounded, provider signal is aborted and same-model standby completes',async()=>{
  const f=fixture({prefill:85}),raw=request(),normal=f.platforms.chat,started=Date.now();
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);return waiting(s);};
  const out=await collectChat(f.router.chat(raw));assert.equal(out.choices[0].message.content,'PREFILL_RECOVERY_OK');
  assert.ok(Date.now()-started<1500);assert.equal(f.calls.at(-1).target.upstreamId,'standby');
  assert.ok(f.calls.filter(c=>c.target.upstreamId==='primary').every(c=>c.signal.aborted));assert.equal(f.rows[0].error.code,'relay_target_timeout');preserveAll(f,raw);
});

test('prefill: heartbeat bytes never extend the finite first semantic-progress window',async()=>{
  const f=fixture({prefill:85}),raw=request(),normal=f.platforms.chat,started=Date.now();
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);return streamResponse(s,{heartbeat:5});};
  const out=await collectChat(f.router.chat(raw,AbortSignal.timeout(1500)));assert.equal(out.choices[0].message.content,'PREFILL_RECOVERY_OK');
  assert.ok(Date.now()-started<1000);assert.equal(f.rows[0].error.code,'relay_target_timeout');assert.equal(f.calls.at(-1).target.upstreamId,'standby');
});

for(const [label,delta]of [
  ['content',{content:'discarded partial answer'}],
  ['reasoning',{reasoning_content:'private intermediate thought'}],
  ['tool call',{tool_calls:[{index:0,id:'partial-never-exposed',type:'function',function:{name:'read_sample',arguments:'{'}}]}]
])test(`idle: ${label} starts the shorter idle deadline; later heartbeat is not progress`,async()=>{
  const f=fixture({prefill:400}),raw=request(),normal=f.platforms.chat,started=Date.now();
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);return streamResponse(s,{events:[[5,delta]],heartbeat:5});};
  const out=await collectChat(f.router.chat(raw,AbortSignal.timeout(1500)));assert.equal(out.choices[0].message.content,'PREFILL_RECOVERY_OK');assert.equal(out.choices[0].message.tool_calls,undefined);
  assert.ok(Date.now()-started<350,'once semantic progress arrives the larger prefill allowance must stop applying');
  assert.equal(f.rows[0].error.code,'relay_target_timeout');assert.equal(f.calls.at(-1).target.upstreamId,'standby');preserveAll(f,raw);
});

test('timeout retry: one provider timeout retries the exact source once and then succeeds',async()=>{
  const f=fixture(),normal=f.platforms.chat,raw=request();let failures=0;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId==='primary'&&failures++===0){logCall(f,t,r,s);throw networkTimeout();}return normal(t,r,s);};
  await collectChat(f.router.chat(raw));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','primary']);
  assert.equal(f.rows.length,1);assert.equal(f.rows[0].status,'completed');assert.equal(f.router.relay.cooldown({upstreamId:'primary',model}),null);preserveAll(f,raw);
});

test('timeout retry: two provider timeouts are bounded, then standby receives unchanged input',async()=>{
  const f=fixture(),normal=f.platforms.chat,raw=request();
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId==='primary'){logCall(f,t,r,s);throw networkTimeout();}return normal(t,r,s);};
  await collectChat(f.router.chat(raw));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','primary','standby']);
  const cooldown=f.router.relay.cooldown({upstreamId:'primary',model});assert.ok(cooldown&&cooldown.until<=Date.now()+5100);assert.equal(cooldown.errorCode,'provider_timeout');preserveAll(f,raw);
});

test('timeout recovery: long request waits only a short timeout circuit then recovers original supplier',async()=>{
  const f=fixture({small:true}),raw=request();
  f.values.set('relay-cooldown:primary\0'+model,{until:Date.now()+20,reasonCode:'upstream_unavailable',errorCode:'provider_timeout'});
  const out=await collectChat(f.router.chat(raw));assert.equal(out.choices[0].message.content,'PREFILL_RECOVERY_OK');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);preserveAll(f,raw);
});

test('timeout terminal: too-small final standby must not hide the primary timeout as a context error',async()=>{
  const f=fixture({small:true}),raw=request(),originalFailure=f.router.relay.failure.bind(f.router.relay);
  // Preserve the production classification, reduce only fixture wall time.
  f.router.relay.failure=(...args)=>{const reason=originalFailure(...args);const key='relay-cooldown:primary\0'+model,row=f.values.get(key);if(row?.errorCode==='provider_timeout')f.values.set(key,{...row,until:Date.now()+10});return reason;};
  f.platforms.chat=async(t,r,s)=>{logCall(f,t,r,s);throw networkTimeout();};
  await assert.rejects(collectChat(f.router.chat(raw,AbortSignal.timeout(1500))),e=>e.status===504&&e.code==='provider_timeout');
  assert.ok(f.calls.length<=4,'initial source and one recovered-source cycle are bounded');assert.ok(f.calls.every(c=>c.target.upstreamId==='primary'));preserveAll(f,raw);
});

test('timeout terminal: a blocked timed-out primary exposes the root timeout, not its last standby mismatch',async()=>{
  const f=fixture({small:true}),raw=request();
  f.values.set('relay-cooldown:primary\0'+model,{until:Date.now()+60000,reasonCode:'upstream_unavailable',errorCode:'provider_timeout'});
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===504&&e.code==='same_model_timeout'&&e.retryAfterSeconds>0);assert.equal(f.calls.length,0);
});

test('cancellation: after first provider timeout neither retry nor standby may begin',async()=>{
  const f=fixture(),controller=new AbortController(),raw=request();
  f.platforms.chat=async(t,r,s)=>{logCall(f,t,r,s);controller.abort();throw networkTimeout();};
  await assert.rejects(collectChat(f.router.chat(raw,controller.signal)),e=>e.code==='request_cancelled'&&e.status===499);
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);assert.equal(f.rows[0].status,'cancelled');assert.equal(f.router.relay.cooldown({upstreamId:'primary',model}),null);
});

test('whole deadline: retry and prefill do not reset an already expiring caller deadline',async()=>{
  const f=fixture({idle:400,prefill:900}),raw=request(),controller=new AbortController(),started=Date.now();
  f.platforms.chat=async(t,r,s)=>{logCall(f,t,r,s);return waiting(s);};
  const timer=setTimeout(()=>controller.abort(new DOMException('Whole request deadline expired','TimeoutError')),30);
  try{await assert.rejects(collectChat(f.router.chat(raw,controller.signal)),e=>e.code==='request_timeout'&&e.status===504);}finally{clearTimeout(timer);}
  assert.equal(f.calls.length,1);assert.equal(f.rows[0].status,'failed');assert.ok(Date.now()-started<350);assert.equal(f.router.relay.cooldown({upstreamId:'primary',model}),null);
});

for(const [status,code]of [[401,'unauthorized'],[403,'forbidden'],[429,'rate_limited']])test(`retry exclusions: HTTP ${status} does not repeat the same source as a transport timeout`,async()=>{
  const f=fixture(),raw=request(),normal=f.platforms.chat;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId==='primary'){logCall(f,t,r,s);throw new AppError('Fixture business failure',status,code);}return normal(t,r,s);};
  await collectChat(f.router.chat(raw));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','standby']);preserveAll(f,raw);
});

test('retry exclusions: an official HTTP504 response is not relabeled as a local transport deadline',async()=>{
  const f=fixture(),normal=f.platforms.chat,raw=request();
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId==='primary'){logCall(f,t,r,s);throw new AppError('Official HTTP 504 upstream response',504,'upstream_http_error');}return normal(t,r,s);};
  await collectChat(f.router.chat(raw));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','standby']);
  const row=f.router.relay.cooldown({upstreamId:'primary',model});assert.ok(row.until>Date.now()+50000);assert.equal(row.errorCode,undefined);
});

test('zero balance: exhausted primary is never retried or revived by timeout recovery',async()=>{
  const f=fixture({small:true}),raw=request();
  f.router.relay.balanceSource=()=>new Map([['primary',{value:0,unit:'积分',checkedAt:new Date().toISOString()}],['standby',{value:700,unit:'积分',checkedAt:new Date().toISOString()}]]);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.code==='relay_context_incompatible'||e.code==='same_model_unavailable');assert.equal(f.calls.length,0);
});

test('zero balance: short timeout recovery rechecks balance before reviving an exhausted primary',async()=>{
  const f=fixture({small:true}),raw=request();
  f.values.set('relay-cooldown:primary\0'+model,{until:Date.now()+20,reasonCode:'upstream_unavailable',errorCode:'provider_timeout'});
  f.router.relay.balanceSource=()=>new Map([['primary',{value:0,unit:'积分',checkedAt:new Date().toISOString()}],['standby',{value:700,unit:'积分',checkedAt:new Date().toISOString()}]]);
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.code==='same_model_timeout'&&e.status===504);assert.equal(f.calls.length,0);
});

test('cooldown: relay idle timeout is short and preserves the classified transport cause',()=>{
  const f=fixture(),started=Date.now(),route=f.config.value.routes[0],target=route.targets[0];
  f.router.relay.failure(route,target,new AppError('Idle progress deadline','504','relay_target_timeout'));
  const row=f.router.relay.cooldown(target);assert.ok(row&&row.until>=started+4900&&row.until<=Date.now()+5100);assert.equal(row.errorCode,'relay_target_timeout');
});

test('timeout metadata: prefill and progress-idle policy is bounded and immutable',async()=>{
  const f=fixture(),before=JSON.stringify(f.config.value),info=await f.router.routeInfo(f.config.value.routes[0]);
  assert.equal(info.modelRelay.prefillTimeoutMs,140);assert.equal(info.modelRelay.attemptTimeoutMs,40);assert.equal(info.modelRelay.attemptTimeoutMode,'prefill_then_progress_idle');assert.equal(info.modelRelay.requestTimeoutMs,10000);assert.equal(JSON.stringify(f.config.value),before);
  for(const bad of [null,'140',0,-1,1.5,Infinity,600001])assert.throws(()=>fixture({prefill:bad}),TypeError);
});

test('error view retains only public code/message/status, not raw nested transport diagnostics',()=>{
  const error=networkTimeout();error.cause={code:'UND_ERR_HEADERS_TIMEOUT',address:'PRIVATE_HOST',token:'PRIVATE_TOKEN'};error.transportFailure={code:'UND_ERR_HEADERS_TIMEOUT',phase:'headers',address:'PRIVATE_HOST'};
  assert.deepEqual(Object.keys(errorView(error)).sort(),['code','message','status']);assert.ok(!JSON.stringify(errorView(error)).includes('PRIVATE_'));
});

test('usage diagnostics: known failure phase/code/origin survive without raw error or nested cause data',async()=>{
  const f=fixture(),normal=f.platforms.chat;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);const e=networkTimeout();
    Object.assign(e,{networkPhase:'response_header',transportCode:'ETIMEDOUT',timeoutOrigin:'header_deadline',cause:{token:'PRIVATE_TOKEN',host:'PRIVATE_HOST'},raw:'PRIVATE_RAW'});throw e;};
  await collectChat(f.router.chat(request()));assert.deepEqual(f.rows[0].transportFailure,{phase:'response_header',code:'ETIMEDOUT',timeoutOrigin:'header_deadline'});
  assert.ok(!JSON.stringify(f.rows).includes('PRIVATE_'));assert.deepEqual(Object.keys(f.rows[0].error).sort(),['code','message','status']);
});

test('usage diagnostics: invalid transport fields are replaced by null, never copied wholesale',async()=>{
  const f=fixture(),normal=f.platforms.chat;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId!=='primary')return normal(t,r,s);logCall(f,t,r,s);const e=networkTimeout();
    Object.assign(e,{networkPhase:'response_body',transportCode:'PRIVATE_HOST:443',timeoutOrigin:'Bearer PRIVATE_TOKEN',transportFailure:{password:'PRIVATE_PASSWORD'}});throw e;};
  await collectChat(f.router.chat(request()));assert.deepEqual(f.rows[0].transportFailure,{phase:'response_body',code:null,timeoutOrigin:null});assert.ok(!JSON.stringify(f.rows).includes('PRIVATE_'));
});
