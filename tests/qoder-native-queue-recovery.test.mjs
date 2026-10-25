import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import https from 'node:https';
import http from 'node:http';

// Baseline Platforms has no options forwarding. Fail closed here instead of
// allowing a missing injection seam to turn a counterfactual into real I/O.
const offline=()=>{throw new Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')};
https.request=offline;http.request=offline;globalThis.fetch=offline;

// One unchanged fixture can exercise baseline, candidate, and independent restore.
const root=process.env.QODER_QUEUE_ROOT?pathToFileURL(process.env.QODER_QUEUE_ROOT.replace(/[\\/]?$/,'/')):new URL('../',import.meta.url);
const {qoderChat}=await import(new URL('src/provider-qoder.mjs',root));
const {Router}=await import(new URL('src/router.mjs',root));
const {Platforms}=await import(new URL('src/platforms.mjs',root));
const {AppError}=await import(new URL('src/util.mjs',root));
const {collectChat}=await import(new URL('src/openai.mjs',root));
const {relayDefaults}=await import(new URL('src/model-relay.mjs',root));
const encoder=new TextEncoder(),model='qmodel_38max',routeId='qoder-primary/'+model;
let serial=0;
const rawModel=()=>({key:model,display_name:'Sample exact model',max_input_tokens:180000,is_vl:true,is_reasoning:false});
const queueInfo={isQueued:true,serviceAvailable:false,queueCount:0,retryAfterSeconds:30,waitTime:30,queueType:'p3'};
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
const packet=(code='10605',queue=queueInfo)=>({statusCodeValue:403,body:JSON.stringify({code:'403',message:JSON.stringify({code,message:JSON.stringify(queue)})})});
const reply=()=>new Response(frame({statusCodeValue:200,body:JSON.stringify({choices:[{index:0,delta:{content:'ONE_REPLY'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}})})+'data: [DONE]\n\n');
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject}};
async function settle(){for(let i=0;i<80;i++)await Promise.resolve()}
async function until(predicate){for(let i=0;i<500&&!predicate();i++)await Promise.resolve();assert.ok(predicate(),'offline operation reached the expected state')}
function decode(encoded){const std='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$',n=Math.floor(encoded.length/3),b=encoded.slice(encoded.length-n)+encoded.slice(n,encoded.length-n)+encoded.slice(0,n);return JSON.parse(Buffer.from([...b].map(c=>std[custom.indexOf(c)]).join(''),'base64').toString('utf8'))}
const input=()=>({model,messages:[{role:'user',content:[{type:'text',text:'SAMPLE'},{type:'image_url',image_url:{url:'data:image/png;base64,U0FNUExF'}}]},{role:'assistant',content:null,tool_calls:[{id:'call-original',type:'function',function:{name:'read',arguments:'{"path":"SAMPLE"}'}}]},{role:'tool',tool_call_id:'call-original',content:'SAMPLE result'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],tool_choice:'auto',max_tokens:800,temperature:0});
function fixture(t,settings={}){
 let now=1000,result;const posts=[],gets=[],states=[],waits=[],sources=[],credential={edition:'cn',accessToken:'SAMPLE',uid:'queue-offline-'+serial++,principal:'SAMPLE',machineId:'SAMPLE',identity:{machineToken:'SAMPLE',machineCode:'SAMPLE',machineType:'SAMPLE'}};
 const options={requestDeadlineAt:121000,queueNow:()=>now,queueDelayImpl:async ms=>{waits.push(ms);now+=ms},onQueueState:value=>states.push(value),beforeQueueReplay:()=>{},...settings.options};
 options.fetchImpl=async(url,init)=>{
  if(url.includes('/model/list'))return Response.json({chat:[{...rawModel(),key:settings.model??model}]});
  if(init.method==='GET'){gets.push({url,init});return settings.poll?settings.poll(gets.length,url,init):Response.json({data:{isQueued:false,retryAfterSeconds:0}})}
  posts.push({url,init});const response=posts.length===1?(settings.first?.()??new Response(frame(packet()))):(settings.replay?.(posts.length)??reply());sources.push(response.body);return response;
 };
 t.after(()=>result?.finalizeQoderQueue?.('cancelled'));
 return{credential,options,posts,gets,states,waits,sources,setNow:value=>now=value,async start(signal,request={...input(),model:settings.model??model}){result=await qoderChat({},credential,request,signal,options);return result},get result(){return result}};
}
const consume=async f=>{const r=await f.start();return r.response.text()};

test('Qoder queue: genuine nested10605 polls immediately, waits native hint, and replays identical signed request once',async t=>{
 let checks=0;const f=fixture(t,{poll:n=>Response.json({data:n===1?{...queueInfo,retryAfterSeconds:30}:{isQueued:false,retryAfterSeconds:0}}),options:{beforeQueueReplay:()=>checks++}});
 const request=input(),before=structuredClone(request),text=await(await f.start(undefined,request)).response.text();
 assert.equal(f.posts.length,2);assert.equal(f.gets.length,2);assert.equal(checks,1);assert.deepEqual(f.states,[true,false]);assert.deepEqual(f.waits,[30000]);assert.equal((text.match(/ONE_REPLY/g)??[]).length,1);assert.equal((text.match(/prompt_tokens/g)??[]).length,1);assert.equal((text.match(/\[DONE\]/g)??[]).length,1);
 assert.equal(f.posts[0].init.body,f.posts[1].init.body);assert.deepEqual(f.posts[0].init.headers,f.posts[1].init.headers);assert.equal(f.posts[0].url,f.posts[1].url);
 const body=decode(f.posts[0].init.body);assert.equal(body.model,model);assert.equal(body.model_config.key,model);assert.equal(body.max_tokens,800);assert.equal(body.parameters.max_tokens,800);assert.deepEqual(body.tools,request.tools);assert.deepEqual(body.messages[0],request.messages[0]);assert.equal(body.messages[1].tool_calls[0].id,'call-original');assert.equal(body.messages[2].tool_call_id,'call-original');assert.deepEqual(request,before);
 for(const get of f.gets){const url=new URL(get.url);assert.equal(url.pathname,'/algo/api/v2/service/ask/queue/status');assert.equal(url.searchParams.get('requestSetId'),body.request_set_id);assert.equal(url.searchParams.get('modelKey'),model);assert.equal(url.searchParams.get('queueType'),'p3');assert.equal(get.init.headers['X-Request-ID'],body.request_id);assert.equal(get.init.headers['X-Session-ID'],body.session_id);assert.match(get.init.headers.Authorization,/^Bearer COSY\./);}
 assert.deepEqual(f.result.qoderQueueTelemetry,{inferencePosts:2,replayPosts:1,queueStatusGets:2,queueWaitMs:30000,state:'finished',outcome:'completed'});assert.ok(Object.isFrozen(f.result.qoderQueueTelemetry));for(const source of f.sources)assert.equal(source.locked,false);
});
test('Qoder queue: ready positive native hint waits before replay without changing signed IDs',async t=>{
 const f=fixture(t,{poll:()=>Response.json({result:JSON.stringify({isQueued:false,retryAfterSeconds:1})})});await consume(f);assert.deepEqual(f.waits,[1000]);assert.equal(f.posts.length,2);
});
test('Qoder queue: auto polls the private server queue key, while replay body keeps original auto',async t=>{
 const privateKey='SAMPLE-SERVER-QUEUE-KEY',f=fixture(t,{model:'auto',first:()=>new Response(frame(packet('10605',{...queueInfo,modelKey:privateKey}))),poll:n=>Response.json(n===1?{isQueued:true,modelKey:'SAMPLE-NEXT-QUEUE-KEY',retryAfterSeconds:0}:{isQueued:false})});await consume(f);assert.equal(new URL(f.gets[0].url).searchParams.get('modelKey'),privateKey);assert.equal(new URL(f.gets[1].url).searchParams.get('modelKey'),'SAMPLE-NEXT-QUEUE-KEY');assert.equal(decode(f.posts[0].init.body).model_config.key,'auto');assert.equal(f.posts[0].init.body,f.posts[1].init.body);assert.doesNotMatch(JSON.stringify(f.result.qoderQueueTelemetry),/SAMPLE-(SERVER|NEXT)-QUEUE-KEY/);
});
test('Qoder queue: auto without a verified server queue key is terminal, never polls its alias',async t=>{
 const f=fixture(t,{model:'auto'});await assert.rejects(consume(f),e=>e.qoderQueueRecoveryReason==='queue_model_key_unverified');assert.equal(f.gets.length,0);assert.equal(f.posts.length,1);
});
test('Qoder queue: private model key never becomes an enumerable public error diagnostic',async t=>{
 const f=fixture(t,{first:()=>new Response(frame(packet('10605',{...queueInfo,modelKey:'SAMPLE-PRIVATE-KEY'}))),poll:()=>new Response('',{status:403})});await assert.rejects(consume(f),e=>{assert.doesNotMatch(e.message+JSON.stringify(e),/SAMPLE-PRIVATE-KEY/);assert.equal(e.qoderQueueRecoveryReason,'status_http_403');return true});
});
test('Qoder queue: polling and replay retain the original credential snapshot during queue wait',async t=>{
 let uid;const f=fixture(t,{poll:n=>Response.json(n===1?{isQueued:true,retryAfterSeconds:1}:{isQueued:false}),options:{queueDelayImpl:async()=>{f.credential.uid='SAMPLE-CHANGED';f.credential.accessToken='SAMPLE-CHANGED'}}});uid=f.credential.uid;await consume(f);assert.equal(f.gets[1].init.headers['Cosy-User'],uid);assert.equal(f.posts[1].init.headers['Cosy-User'],uid);assert.deepEqual(f.posts[0].init.headers,f.posts[1].init.headers);
});
test('Qoder queue: native serviceAvailable=false without isQueued remains queued, not ready',async t=>{
 const f=fixture(t,{poll:n=>Response.json(n===1?{serviceAvailable:false,retryAfterSeconds:1}:{isQueued:false})});await consume(f);assert.deepEqual(f.waits,[1000]);assert.equal(f.posts.length,2);
});
for(const body of [{data:[],result:{message:JSON.stringify({isQueued:false})}},{data:null,result:{body:{isQueued:false}}},{data:'not-json',result:{isQueued:false}}])test('Qoder queue: bounded native status wrapper traversal validates each record '+JSON.stringify(body),async t=>{
 const f=fixture(t,{poll:()=>Response.json(body)});await consume(f);assert.equal(f.posts.length,2);
});
for(const body of [{data:[{isQueued:false}]},{data:{result:{message:{body:{data:{isQueued:false}}}}}},{isQueued:false,modelKey:'SAMPLE\nPRIVATE'},{isQueued:false,queueType:[]},{serviceAvailable:true}])test('Qoder queue: invalid status wrapper or identity cannot release inference '+JSON.stringify(body),async t=>{
 const f=fixture(t,{poll:()=>Response.json(body)});await assert.rejects(consume(f),e=>e.qoderQueueRecoveryTerminal===true);assert.equal(f.posts.length,1);assert.equal(f.gets.length,1);
});
for(const [hint,expected]of[[0,500],[1,1000],[100,30000]])test('Qoder queue: queued hint '+hint+' uses native clamp '+expected,async t=>{
 const f=fixture(t,{poll:n=>Response.json(n===1?{isQueued:true,retryAfterSeconds:hint}:{isQueued:false})});await consume(f);assert.deepEqual(f.waits,[expected]);assert.equal(f.gets.length,2);
});
test('Qoder queue: each queued status owns its hint; absent hint returns to native30s default',async t=>{
 const f=fixture(t,{poll:n=>Response.json(n===1?{isQueued:true,retryAfterSeconds:1}:n===2?{isQueued:true}:{isQueued:false})});await consume(f);assert.deepEqual(f.waits,[1000,30000]);assert.equal(f.gets.length,3);assert.equal(f.posts.length,2);
});
test('Qoder queue: repeated10605 after the one replay ends terminally, never a third inference',async t=>{
 const f=fixture(t,{replay:()=>new Response(frame(packet()))});await assert.rejects(consume(f),e=>e.qoderQueueRecoveryTerminal===true&&e.qoderQueueRecoveryReason==='replay_exhausted'&&e.innerBusinessCode==='10605');assert.equal(f.posts.length,2);assert.equal(f.gets.length,1);assert.ok(Object.isFrozen(f.result.qoderQueueTelemetry));assert.equal(f.result.qoderQueueTelemetry.outcome,'failed');
});
for(const code of ['112','105','403','106050'])test('Qoder queue: ordinary business '+code+' preserves original typed error and no poll',async t=>{
 const f=fixture(t,{first:()=>new Response(frame(packet(code)))});await assert.rejects(consume(f),e=>e.code==='provider_stream_error'&&e.innerBusinessCode===code&&e.qoderQueueRecoveryTerminal===undefined);assert.equal(f.posts.length,1);assert.equal(f.gets.length,0);
});
test('Qoder queue: arbitrary10605 text and absent queue structure never activate recovery',async t=>{
 for(const p of [{statusCodeValue:403,body:JSON.stringify({code:403,message:'SAMPLE 10605 isQueued true'})},packet('10605',{raw:'isQueued true'})]){const f=fixture(t,{first:()=>new Response(frame(p))});await assert.rejects(consume(f),e=>e.code==='provider_stream_error'&&e.qoderQueueRecoveryTerminal===undefined);assert.equal(f.gets.length,0);}
});
for(const options of [{requestDeadlineAt:undefined},{beforeQueueReplay:undefined}])test('Qoder queue: admitted deadline and fence are both required '+Object.keys(options)[0],async t=>{
 const f=fixture(t,{options});await assert.rejects(consume(f),e=>e.qoderQueueRecoveryReason==='admitted_deadline_or_fence_missing');assert.equal(f.gets.length,0);assert.equal(f.posts.length,1);
});
for(const prior of [{choices:[{index:0,delta:{content:'ALREADY_DELIVERED'}}]},{choices:[],usage:{prompt_tokens:1}},{choices:[{delta:{role:'assistant'}}]}])test('Qoder queue: any previously emitted normalized payload forbids recovery '+JSON.stringify(prior),async t=>{
 const gate=deferred(),source=new ReadableStream({start(ctrl){ctrl.enqueue(encoder.encode(frame(prior)));gate.promise.then(()=>{ctrl.enqueue(encoder.encode(frame(packet())));ctrl.close()})}}),f=fixture(t,{first:()=>new Response(source)}),r=await f.start(),reader=r.response.body.getReader();const first=await reader.read();assert.ok(first.value.byteLength>0);gate.resolve();await assert.rejects(reader.read(),e=>e.qoderQueueRecoveryReason==='payload_already_delivered');reader.releaseLock();assert.equal(f.gets.length,0);assert.equal(f.posts.length,1);
});
for(const status of [401,403,429,500])test('Qoder queue: status HTTP'+status+' is bounded terminal, without credential refresh or inference replay',async t=>{
 const f=fixture(t,{poll:()=>new Response('SAMPLE_PRIVATE_UPSTREAM',{status})});await assert.rejects(consume(f),e=>e.qoderQueueRecoveryReason==='status_http_'+status&&!e.message.includes('SAMPLE_PRIVATE'));assert.equal(f.posts.length,1);assert.equal(f.gets.length,1);assert.deepEqual(f.states,[true,false]);
});
for(const [name,value,reason]of[['invalid-json','SAMPLE_PRIVATE','status_invalid_json'],['null','null','status_invalid_shape'],['array','[]','status_invalid_shape'],['missing-boolean','{"isQueued":"false"}','status_invalid_shape'],['too-large',' '.repeat(65537),'status_body_limit']])test('Qoder queue: status '+name+' rejects bounded body',async t=>{
 const f=fixture(t,{poll:()=>new Response(value)});await assert.rejects(consume(f),e=>e.qoderQueueRecoveryReason===reason&&!e.message.includes('SAMPLE_PRIVATE'));assert.equal(f.posts.length,1);
});
test('Qoder queue: foreign transport exception is not reflected as raw queue error text',async t=>{
 const f=fixture(t,{poll:()=>{throw new Error('SAMPLE_PRIVATE token=secret')}});await assert.rejects(consume(f),e=>e.code==='qoder_queue_recovery_failed'&&!e.message.includes('SAMPLE_PRIVATE')&&e.qoderQueueRecoveryTerminal===true);assert.equal(f.posts.length,1);
});
test('Qoder queue: a ready target fence failure prevents any replay',async t=>{
 const f=fixture(t,{options:{beforeQueueReplay:()=>{throw new AppError('Target changed',503,'control_target_ineligible')}}});await assert.rejects(consume(f),e=>e.code==='control_target_ineligible'&&e.qoderQueueRecoveryTerminal===true);assert.equal(f.posts.length,1);assert.deepEqual(f.states,[true,false]);
});
test('Qoder queue: retry hint exceeding original remaining total budget ends without replay',async t=>{
 const f=fixture(t,{poll:()=>Response.json({...queueInfo,retryAfterSeconds:30}),options:{requestDeadlineAt:2000}});await assert.rejects(consume(f),e=>e.code==='request_timeout'&&e.qoderQueueRecoveryTerminal===true);assert.equal(f.posts.length,1);assert.deepEqual(f.waits,[]);
});
test('Qoder queue: elapsed total budget during status fetch cannot be renewed by ready',async t=>{
 const f=fixture(t,{poll:()=>{f.setNow(121000);return Response.json({isQueued:false})}});await assert.rejects(consume(f),e=>e.code==='request_timeout');assert.equal(f.posts.length,1);
});
for(const phase of ['status-header','status-body','delay'])test('Qoder queue: cancellation during '+phase+' closes readers and freezes terminal counts',async t=>{
 const hold=deferred(),controller=new AbortController();let cancelled=0,source;const f=fixture(t,{poll:()=>phase==='status-header'?hold.promise:phase==='status-body'?new Response(source=new ReadableStream({cancel(){cancelled++}})):Response.json({...queueInfo,retryAfterSeconds:1}),options:phase==='delay'?{queueDelayImpl:()=>hold.promise}:{}}),r=await f.start(controller.signal),read=r.response.text().then(value=>({value}),error=>({error}));
 await until(()=>f.gets.length===1);await settle();controller.abort();const terminal=await read;assert.equal(terminal.error?.code,'request_cancelled');assert.equal(f.posts.length,1);assert.deepEqual(f.states,[true,false]);assert.equal(f.result.qoderQueueTelemetry.outcome,'cancelled');const frozen=JSON.stringify(f.result.qoderQueueTelemetry);assert.ok(Object.isFrozen(f.result.qoderQueueTelemetry));
 if(phase==='status-header')hold.resolve(new Response(new ReadableStream({cancel(){cancelled++}})));else hold.resolve();await settle();assert.equal(JSON.stringify(f.result.qoderQueueTelemetry),frozen);if(phase!=='delay')assert.equal(cancelled,1);if(source)assert.equal(source.locked,false);
});
test('Qoder queue: consumer cancel during pending status cancels late body and ends counts once',async t=>{
 const hold=deferred();let cancelled=0;const f=fixture(t,{poll:()=>hold.promise}),r=await f.start(),reader=r.response.body.getReader();const pending=reader.read();await until(()=>f.gets.length===1);await reader.cancel();await pending;reader.releaseLock();assert.equal(f.result.qoderQueueTelemetry.outcome,'cancelled');hold.resolve(new Response(new ReadableStream({cancel(){cancelled++}})));await settle();assert.equal(cancelled,1);assert.equal(f.posts.length,1);assert.ok(Object.isFrozen(f.result.qoderQueueTelemetry));
});
test('Qoder queue: status has a30s ceiling even when fetch ignores abort',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const hold=deferred(),f=fixture(t,{poll:()=>hold.promise,options:{requestDeadlineAt:1100000,queueNow:()=>Date.now()}}),r=await f.start(),read=r.response.text().then(()=>null,e=>e);await until(()=>f.gets.length===1);t.mock.timers.tick(30000);await settle();const e=await read;assert.equal(e.qoderQueueRecoveryReason,'status_timeout');assert.equal(f.posts.length,1);assert.ok(Object.isFrozen(f.result.qoderQueueTelemetry));hold.resolve(Response.json({isQueued:false}));await settle();assert.equal(f.posts.length,1);
});
test('Qoder queue: status body has the same30s deadline and releases its lock',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});let source;const f=fixture(t,{poll:()=>new Response(source=new ReadableStream({})),options:{requestDeadlineAt:1100000,queueNow:()=>Date.now()}}),r=await f.start(),read=r.response.text().then(()=>null,e=>e);await until(()=>source?.locked);t.mock.timers.tick(30000);const e=await read;assert.equal(e.qoderQueueRecoveryReason,'status_timeout');assert.equal(source.locked,false);assert.equal(f.posts.length,1);
});
test('Qoder queue: exactly64KiB JSON status is accepted without enlarging the bound',async t=>{
 const json=JSON.stringify({isQueued:false}),f=fixture(t,{poll:()=>new Response(json+' '.repeat(65536-Buffer.byteLength(json)))});await consume(f);assert.equal(f.posts.length,2);
});
test('Qoder queue: absent status body fails without retry or replay',async t=>{
 const f=fixture(t,{poll:()=>new Response(null,{status:204})});await assert.rejects(consume(f),e=>e.qoderQueueRecoveryReason==='status_empty_body');assert.equal(f.posts.length,1);
});
for(const phase of ['replay-header','replay-body'])test('Qoder queue: cancellation during '+phase+' never leaves late inference body live',async t=>{
 const hold=deferred(),controller=new AbortController();let cancelled=0,source;const f=fixture(t,{replay:()=>phase==='replay-header'?hold.promise:new Response(source=new ReadableStream({cancel(){cancelled++}}))}),r=await f.start(controller.signal),read=r.response.text().then(()=>null,e=>e);await until(()=>f.posts.length===2);await settle();controller.abort();const e=await read;assert.equal(e.code,'request_cancelled');assert.equal(f.result.qoderQueueTelemetry.outcome,'cancelled');if(phase==='replay-header')hold.resolve(new Response(new ReadableStream({cancel(){cancelled++}})));await settle();assert.equal(cancelled,1);assert.equal(f.posts.length,2);if(source)assert.equal(source.locked,false);
});
test('Qoder queue: Platforms forwards admitted options and resolves credential once for two inference posts',async t=>{
 const f=fixture(t),calls=[],config={value:{upstreams:[{id:'primary',kind:'qoder',accountId:'a'}]}},platforms=new Platforms(config,{resolve:async(...args)=>(calls.push(args),f.credential)});let result;
 t.after(()=>result?.finalizeQoderQueue?.('cancelled'));result=await platforms.chat({upstreamId:'primary',model},input(),undefined,f.options);const text=await result.response.text();assert.match(text,/ONE_REPLY/);assert.equal(f.posts.length,2);assert.equal(f.gets.length,1);assert.equal(calls.length,1);
});

function routing(t,{relay=true,standby=false,poll,replay,control=false}={}){
 const f=fixture(t,{poll,replay}),ids=standby?['primary','standby']:['primary'],config={value:{server:{requestTimeoutMs:10000},modelRelay:{...relayDefaults,enabled:relay},accounts:ids.map(id=>({id,platform:'qoder'})),upstreams:ids.map(id=>({id,accountId:id,kind:'qoder'})),routes:ids.map((id,i)=>({id:i?'qoder-standby/'+model:routeId,targets:[{upstreamId:id,model}]}))}},usages=[],calls=[],state=new Map();
 const ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v),record:()=>{},beginUsage:row=>(usages.push(row),usages.length-1),finishUsage:(i,row)=>usages[i]=row};
 const platforms={models:async()=>[{id:model,callable:true,tools:true,multimodal:true,maxTokens:1024,contextWindow:180000}],chat:async(target,request,signal,options)=>{calls.push({target,options,signal});return qoderChat({},f.credential,{...request,model},signal,{fetchImpl:f.options.fetchImpl,...options})}};
 const router=new Router(config,platforms,{ledger,relayAttemptTimeoutMs:1000,relayPrefillTimeoutMs:1000,relayNetworkRetryDelayMs:0});let checkCount=0,version='v1';
 if(control)router.controls={enabled:()=>true,targetVersion:()=>version,orderTargets:(_route,targets)=>targets,success:()=>{}};
 const lease={checkTarget(){checkCount++},observe(){}};
 return{...f,config,router,usages,calls,lease,setVersion:v=>version=v,get checkCount(){return checkCount},async start(signal){return collectChat(router.chat({...input(),model:routeId},signal,{controlLease:lease}))}};
}
test('Qoder queue: Router owns queue idle suspension, retains total deadline, and records one dispatch vs two inference posts',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const hold=deferred(),f=routing(t,{poll:()=>hold.promise,control:true}),pending=f.start().then(value=>({value}),error=>({error}));await until(()=>f.gets.length===1);assert.equal(f.calls[0].options.requestDeadlineAt,1009000);t.mock.timers.tick(2000);await settle();assert.equal(f.calls[0].signal.aborted,false);hold.resolve(Response.json({isQueued:false}));const result=await pending;assert.equal(result.error,undefined);assert.equal(result.value.choices[0].message.content,'ONE_REPLY');assert.equal(f.calls.length,1);assert.equal(f.posts.length,2);assert.equal(f.checkCount,2);assert.equal(f.usages.length,1);assert.equal(f.usages[0].dispatchCount,1);assert.equal(f.usages[0].status,'completed');assert.equal(f.usages[0].qoderQueueTelemetry.inferencePosts,2);assert.ok(Object.isFrozen(f.usages[0].qoderQueueTelemetry));
});
test('Qoder queue: Router original total deadline terminates queue without account rotation, late ready cannot mutate ledger',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const hold=deferred(),f=routing(t,{poll:()=>hold.promise,standby:true}),pending=f.start().then(value=>({value}),error=>({error}));await until(()=>f.gets.length===1);t.mock.timers.tick(9000);await settle();const result=await pending;assert.equal(result.error?.code,'request_timeout');assert.equal(f.calls.length,1);assert.equal(f.posts.length,1);assert.equal(f.usages[0].status,'failed');assert.ok(Object.isFrozen(f.usages[0].qoderQueueTelemetry));const snapshot=JSON.stringify(f.usages);hold.resolve(Response.json({isQueued:false}));await settle();assert.equal(JSON.stringify(f.usages),snapshot);assert.equal(f.posts.length,1);
});
for(const field of ['account','upstream','route','control-version','lease'])test('Qoder queue: actual Router '+field+' fence is rechecked before replay',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const hold=deferred(),f=routing(t,{poll:()=>hold.promise,control:true}),pending=f.start().then(value=>({value}),error=>({error}));await until(()=>f.gets.length===1);
 if(field==='account')f.config.value.accounts[0].credentialRevision=2;
 if(field==='upstream')f.config.value.upstreams[0].enabled=false;
 if(field==='route')f.config.value.routes[0].revision=2;
 if(field==='control-version')f.setVersion('v2');
 if(field==='lease')f.lease.checkTarget=()=>{throw new AppError('Lease changed',503,'control_target_ineligible')};
 hold.resolve(Response.json({isQueued:false}));const result=await pending;assert.equal(result.error?.code,'control_target_ineligible');assert.equal(f.posts.length,1);assert.equal(f.calls.length,1);assert.equal(f.usages[0].status,'failed');assert.ok(Object.isFrozen(f.usages[0].qoderQueueTelemetry));
});
test('Qoder queue: Router abort preserves cancelled terminal snapshot and never rotates',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const hold=deferred(),controller=new AbortController(),f=routing(t,{poll:()=>hold.promise,standby:true}),pending=f.start(controller.signal).then(value=>({value}),error=>({error}));await until(()=>f.gets.length===1);controller.abort();const result=await pending;assert.equal(result.error?.code,'request_cancelled');assert.equal(f.calls.length,1);assert.equal(f.usages[0].status,'cancelled');assert.equal(f.usages[0].qoderQueueTelemetry.outcome,'cancelled');assert.ok(Object.isFrozen(f.usages[0].qoderQueueTelemetry));const snapshot=JSON.stringify(f.usages);hold.resolve(Response.json({isQueued:false}));await settle();assert.equal(JSON.stringify(f.usages),snapshot);
});
test('Qoder queue: Router restores ordinary supplier idle deadline after ready before replay body',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});let source;const f=routing(t,{poll:()=>Response.json({isQueued:false}),replay:()=>new Response(source=new ReadableStream({}))}),pending=f.start().then(value=>({value}),error=>({error}));await until(()=>f.posts.length===2);t.mock.timers.tick(1000);await settle();const result=await pending;assert.equal(result.error?.code,'relay_target_timeout');assert.equal(f.posts.length,2);await settle();assert.equal(source.locked,false);assert.ok(Object.isFrozen(f.usages[0].qoderQueueTelemetry));
});
test('Qoder queue: non-relay Router still supplies total deadline and target fence for admitted recovery',async t=>{
 const f=routing(t,{relay:false,poll:()=>Response.json({isQueued:false})}),out=await f.start();assert.equal(out.choices[0].message.content,'ONE_REPLY');assert.equal(f.posts.length,2);assert.equal(f.checkCount,2);assert.equal(f.usages[0].dispatchCount,1);assert.equal(f.usages[0].status,'completed');
});
test('Qoder queue: queue completion is not an empty answer success and ledger freezes failed outcome',async t=>{
 const f=routing(t,{poll:()=>Response.json({isQueued:false}),replay:()=>new Response(frame({choices:[],usage:{prompt_tokens:5}})+'data: [DONE]\n\n')});await assert.rejects(f.start(),e=>e.code==='empty_stream');assert.equal(f.posts.length,2);assert.equal(f.usages[0].status,'failed');assert.equal(f.usages[0].qoderQueueTelemetry.outcome,'failed');assert.ok(Object.isFrozen(f.usages[0].qoderQueueTelemetry));
});
