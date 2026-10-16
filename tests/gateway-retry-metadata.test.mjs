import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {startServer} from '../src/server.mjs';
import {Router} from '../src/router.mjs';
import {AppError} from '../src/util.mjs';
import {parseGatewayRetryMetadata,enrichGatewayFailure,gatewayRetryRecovery,registerGatewayRetryRecovery,wrapGatewayRetryMetadata} from '../bundle/retry-metadata.mjs';

const rate=(extra={})=>({message:'SAMPLE_UPSTREAM_SECRET must not enter client history',type:'provider_chat_rejected',code:'provider_chat_rejected',upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,...extra});
const message=(body,status=429)=>`${status}: ${JSON.stringify({error:body})}`;
const relay={id:'fixture',name:'Fixture',capabilities:{multimodal:false},contextWindow:1000000,maxTokens:128000,modelRelay:{deliveryMode:'verified_request_buffer',requestTimeoutMs:180000}};
const request=(signal)=>({provider:'ai-credit',model:'fixture',messages:[{role:'user',content:[{type:'text',text:'SAMPLE'}]}],signal});

test('gateway retry metadata parses bounded SDK/OpenAI error nesting, not arbitrary prose',()=>{
  const body=rate({rateLimitKind:'transient',rateLimitRetryable:true,retryAfterSeconds:17,retryAfterSource:'official_header'});
  for(const text of [message(body),JSON.stringify({error:JSON.stringify({error:body})}),JSON.stringify({message:message(body)})]){
    const m=parseGatewayRetryMetadata(text);assert.equal(m.gatewayCode,'provider_chat_rejected');assert.equal(m.retryAfterSeconds,17);assert.equal(m.retryAfterSource,'official_header');
  }
  for(const text of ['ordinary 429',`prose ${message(body)}`,'429: not JSON',message({...body,code:'arbitrary_provider_code'}),message({...body,type:'unrelated'}),'x'.repeat(32769)])assert.equal(parseGatewayRetryMetadata(text),undefined);
});

test('failure keeps harness code and restores HTTP status and official seconds without leaking body',()=>{
  const original={code:'SERVER',message:message(rate({gatewayManagedRetry:true,retryAfterSeconds:17,retryAfterSource:'official_header'}),503)};
  const f=enrichGatewayFailure(original);assert.equal(f.code,'SERVER');assert.equal(f.status,503);assert.equal(f.providerRetryAfterMs,17000);assert.equal(f.upstreamCode,6004);assert.equal(f.gatewayManagedRetry,true);assert.doesNotMatch(JSON.stringify(f),/SAMPLE_UPSTREAM_SECRET/);assert.equal(original.status,undefined);
});

test('zero/date-expired remains zero metadata, never fabricates positive provider wait',()=>{
  const f=enrichGatewayFailure({code:'RATE_LIMIT',message:message(rate({retryAfterSeconds:0,retryAfterSource:'official_header'}))});
  assert.equal(f.retryAfterSeconds,0);assert.equal(f.providerRetryAfterMs,undefined);assert.equal(f.status,429);
});

test('only validated official metadata becomes providerRetryAfterMs; local/invalid delays never do',()=>{
  for(const retryAfterSeconds of [-1,NaN,Infinity,86401,'17',null]){
    const m=parseGatewayRetryMetadata(message(rate({retryAfterSeconds,retryAfterSource:'official_header'})));assert.equal(m.retryAfterSeconds,undefined);
  }
  const f=enrichGatewayFailure({code:'SERVER',message:message(rate({retryAfterSeconds:30,retryAfterSource:'local_default'}),503)});
  assert.equal(f.retryAfterSeconds,30);assert.equal(f.providerRetryAfterMs,undefined);
});

async function peers(t){
  try{
    // Resolve optional peers before starting import promises: a synchronous
    // missing-package throw must not strand earlier imports as unhandled rejections.
    const retryUrl=new URL('../../dsh-llm-retry/lib/index.js',import.meta.resolve('@deepseek-ai/dsh-llm')).href;
    const [{createGatewayAdapter},llm,{Context},retry]=await Promise.all([import('../bundle/index.mjs'),import('@deepseek-ai/dsh-llm'),import('@deepseek-ai/cordis'),import(retryUrl)]);
    return {createGatewayAdapter,...llm,Context,retry};
  }catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'){t.skip('Optional installed DSH peers absent');return}throw e;}
}

async function mockGateway(t,handler){
  let hits=0,aborted=0;const server=http.createServer((req,res)=>{hits++;req.on('aborted',()=>aborted++);req.resume();req.on('end',()=>handler(req,res,hits));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,hits:()=>hits,aborted:()=>aborted};
}

async function collect(gateway,p,signal,{prepared=false}={}){
  const chunks=[];const options=request(signal),call=prepared?await gateway.adapter.prepareCall('ai-credit','fixture',signal):null;
  for await(const c of call?call.stream(options):gateway.adapter.stream(options))chunks.push(c);
  const accumulator=new p.AssistantStreamAccumulator(),assembler=new p.BlockAssembler();for(const c of chunks){const timed=accumulator.push({time:Date.now(),chunk:c});assembler.push(timed.chunk);}
  const finish=chunks.findLast(c=>c.type==='finish');return {chunks,failure:finish?.reason?.failure,finish:finish?.reason,accumulator,assembler};
}

function recoveryHarness(t,p,{guard=true,onAppend}={}){
  const ctx=new p.Context(),events=[],state={},projection={};
  const shim={on:ctx.on.bind(ctx),effect:ctx.effect.bind(ctx),logger:{warn(){}},sessionProjections:{register(spec){projection.spec=spec},stateOf(){return state}}};
  p.retry.apply(shim,{}, {random:()=>0.5});
  const disposeGuard=guard?registerGatewayRetryRecovery(shim):null;
  const agent={session:{append(type,data){const event={type,data};events.push(event);if(projection.spec)Object.assign(state,projection.spec.apply(state,event));onAppend?.(event);return {seq:events.length}}}};
  t.after(()=>ctx.fiber.dispose());
  return {events,disposeGuard,async run(failure,policy,signal,provider='ai-credit'){
    return ctx.waterfall('agent/request-error',{agent,turn:1,step:1,provider,failure,retryPolicy:policy,signal},()=>Promise.resolve(undefined));
  }};
}

for(const scenario of [
  {name:'429 official 17s transient already managed by gateway',status:429,body:rate({rateLimitKind:'transient',rateLimitRetryable:true,retryAfterSeconds:17,retryAfterSource:'official_header',gatewayManagedRetry:true}),wait:17000},
  {name:'429 expired HTTP-date maps to 0',status:429,body:rate({rateLimitKind:'unknown',retryAfterSeconds:0,retryAfterSource:'official_header'}),header:new Date(0).toUTCString(),wait:undefined},
  {name:'429 metadata absent remains unclassified',status:429,body:{message:'SAMPLE_UPSTREAM_SECRET',code:'provider_chat_rejected',type:'provider_chat_rejected'},wait:undefined},
  {name:'429 long-window business6004',status:429,body:rate(),wait:undefined},
  {name:'429 unknown6000 even official17 is not retryable',status:429,body:rate({upstreamCode:6000,rateLimitKind:'unknown',retryAfterSeconds:17,retryAfterSource:'official_header'}),wait:17000},
  {name:'503 final local cooldown does not invent official30',status:503,body:{message:'SAMPLE_UPSTREAM_SECRET',code:'same_model_cooldown',type:'same_model_cooldown',retryAfterSeconds:30,retryAfterSource:'local_default',gatewayManagedRetry:true},wait:undefined},
  {name:'503 relay context incompatibility is not another whole-pool attempt',status:503,body:{message:'SAMPLE_UPSTREAM_SECRET',code:'relay_context_incompatible',type:'relay_context_incompatible',retryAfterSeconds:30},wait:undefined}
  ,{name:'504 real same_model_timeout retains timeout status',status:504,body:{message:'SAMPLE_UPSTREAM_SECRET',code:'same_model_timeout',type:'same_model_timeout'},wait:undefined}
])test(`real adapter → mock HTTP → Cordis/DSH recovery: ${scenario.name}`,async t=>{
  const p=await peers(t);if(!p)return;
  const server=await mockGateway(t,(_req,res)=>{res.writeHead(scenario.status,{'content-type':'application/json','retry-after':scenario.header??'17'});res.end(JSON.stringify({error:scenario.body}));});
  const gateway=p.createGatewayAdapter({runtime:{baseUrl:server.baseUrl,key:'SAMPLE_LOCAL_GATEWAY_KEY'},models:[relay]}),signal=new AbortController().signal;
  const {failure,finish,assembler}=await collect(gateway,p,signal,{prepared:true});
  assert.equal(finish.kind,'error');assert.equal(failure.status,scenario.status);assert.equal(failure.code,scenario.status===429?'RATE_LIMIT':'SERVER');assert.equal(failure.providerRetryAfterMs,scenario.wait);assert.doesNotMatch(JSON.stringify(failure),/SAMPLE_UPSTREAM_SECRET|SAMPLE_LOCAL_GATEWAY_KEY/);
  assert.notStrictEqual(assembler.finish.failure,failure,'real official accumulator detaches the failure');assert.equal(assembler.finish.failure.gatewayFailureId,failure.gatewayFailureId);
  const harness=recoveryHarness(t,p);assert.equal(await harness.run(assembler.finish.failure,gateway.adapter.providerRetryPolicy('ai-credit'),signal),undefined);
  assert.equal(harness.events.length,0,'no 500ms durable retry is scheduled');assert.equal(server.hits(),1,'no SDK or outer-loop multiplication');
});

test('guard only owns its real failure references, preserves unrelated providers and disposes prepend hook',async t=>{
  const p=await peers(t);if(!p)return;const owned=enrichGatewayFailure({code:'SERVER',message:message(rate(),503)},{ownedRelay:true});
  const ctx=new p.Context(),order=[];ctx.on('agent/request-error',(_payload,next)=>{order.push('downstream');return next()});const dispose=registerGatewayRetryRecovery(ctx);
  await ctx.waterfall('agent/request-error',{provider:'ai-credit',failure:owned},()=>{order.push('terminal')});assert.deepEqual(order,[],'prepend blocks downstream');
  await ctx.waterfall('agent/request-error',{provider:'OTHER',failure:owned},()=>{order.push('terminal')});assert.deepEqual(order,['downstream','terminal']);order.length=0;
  await ctx.waterfall('agent/request-error',{provider:'ai-credit',failure:{...owned,gatewayFailureId:'aigw-forged'}},()=>{order.push('terminal')});assert.deepEqual(order,['downstream','terminal'],'unminted arbitrary failures are not globally parsed');order.length=0;
  await ctx.waterfall('agent/request-error',{provider:'ai-credit',failure:{...owned,message:'altered text'}},()=>{order.push('terminal')});assert.deepEqual(order,['downstream','terminal'],'a copied label cannot mark an unrelated altered failure');order.length=0;
  await dispose();await ctx.waterfall('agent/request-error',{provider:'ai-credit',failure:owned},()=>{order.push('terminal')});assert.deepEqual(order,['downstream','terminal']);await ctx.fiber.dispose();
});

test('nonrelay ordinary 500 retains official retry scheduling, but explicit false/unknown never repeats',async t=>{
  const p=await peers(t);if(!p)return;
  for(const body of [{message:'sample ordinary server failure'},rate({rateLimitKind:'unknown',rateLimitRetryable:false})]){
    const status=body.code?429:500,server=await mockGateway(t,(_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:body}));});
    const plain={...relay};delete plain.modelRelay;const gateway=p.createGatewayAdapter({runtime:{baseUrl:server.baseUrl,key:'SAMPLE'},models:[plain]}),controller=new AbortController();const {failure}=await collect(gateway,p,controller.signal);
    const harness=recoveryHarness(t,p,{onAppend:e=>{if(e.type==='llm/retry')controller.abort()}});await harness.run(failure,gateway.adapter.providerRetryPolicy('ai-credit'),controller.signal);
    if(body.code)assert.equal(harness.events.length,0);else {assert.equal(harness.events[0].type,'llm/retry');assert.equal(harness.events[0].data.delayMs,500);assert.equal(gateway.adapter.providerRetryPolicy('ai-credit').maxRetries,5);}
    assert.equal(server.hits(),1);
  }
});

test('model refresh retains wrapper and exact-model ownership instead of some-model heuristic',async t=>{
  const p=await peers(t);if(!p)return;const server=await mockGateway(t,(_req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'same_model_cooldown',type:'same_model_cooldown',message:'SAMPLE'}}));});
  const plain={...relay};delete plain.modelRelay;const gateway=p.createGatewayAdapter({runtime:{baseUrl:server.baseUrl,key:'SAMPLE'},models:[plain,{...relay,id:'another'}]});
  let result=await collect(gateway,p,new AbortController().signal),calls=0;await gatewayRetryRecovery({provider:'ai-credit',failure:result.failure},()=>{calls++;return Promise.resolve()});assert.equal(calls,1,'another relay model does not claim this plain request');
  assert.equal(gateway.update([relay]),true);result=await collect(gateway,p,new AbortController().signal);await gatewayRetryRecovery({provider:'ai-credit',failure:result.failure},()=>{calls++;return Promise.resolve()});assert.equal(calls,1,'refreshed exact relay request is tagged');assert.equal(gateway.update([relay]),false);
});

test('wrapper does not replace caller signal/deadline or replay partial content',async()=>{
  const signal=new AbortController().signal,seen=[];const source={async*streamWithSnapshot(options){seen.push(options.signal);yield {type:'text-delta',index:0,text:'SAMPLE_PARTIAL'};yield {type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT',message:'stream ended before finish'}}}}};
  const adapter=wrapGatewayRetryMetadata(source,{models:()=>[relay]}),chunks=[];for await(const c of adapter.streamWithSnapshot(request(signal),{}))chunks.push(c);assert.strictEqual(seen[0],signal);assert.equal(seen.length,1);assert.equal(chunks[0].text,'SAMPLE_PARTIAL');let downstream=0;await gatewayRetryRecovery({provider:'ai-credit',failure:chunks[1].reason.failure},()=>{downstream++;return Promise.resolve()});assert.equal(downstream,0);
});

test('actual HTTP cancellation keeps ABORTED, single request, no recovery scheduling',async t=>{
  const p=await peers(t);if(!p)return;const controller=new AbortController();let seenRequest;const arrived=new Promise(resolve=>{seenRequest=resolve});const server=await mockGateway(t,()=>seenRequest());
  const gateway=p.createGatewayAdapter({runtime:{baseUrl:server.baseUrl,key:'SAMPLE'},models:[relay]});const pending=collect(gateway,p,controller.signal);await arrived;controller.abort();const result=await pending;assert.equal(result.finish.kind,'aborted');assert.equal(result.failure.code,'ABORTED');const harness=recoveryHarness(t,p);await harness.run(result.failure,gateway.adapter.providerRetryPolicy('ai-credit'),controller.signal);assert.equal(harness.events.length,0);assert.equal(server.hits(),1);
});

test('actual Router → startServer same_model_rate_limited429 → LlmRuntime/PiAiAdapter → accumulator → DSH guard',async t=>{
  const p=await peers(t);if(!p)return;
  const state=new Map();let upstreamCalls=0;
  const config={value:{server:{host:'127.0.0.1',port:0,requestTimeoutMs:5000},modelRelay:{enabled:true},accounts:[{id:'SAMPLE_ACCOUNT',platform:'workbuddyai'}],upstreams:[{id:'SAMPLE_UPSTREAM',kind:'workbuddyai',accountId:'SAMPLE_ACCOUNT'}],routes:[{id:'fixture',targets:[{upstreamId:'SAMPLE_UPSTREAM',model:'deepseek-v4.1-flash'}]}]}};
  const ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v),record(){},beginUsage(){return 1},finishUsage(){}};
  const platforms={models:async()=>[{id:'deepseek-v4.1-flash',callable:true,tools:true,contextWindow:1000000,maxTokens:128000}],chat:async()=>{upstreamCalls++;throw Object.assign(new AppError('SAMPLE_UPSTREAM_SECRET',429,'provider_chat_rejected'),{upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,retryAfterSeconds:17,retryAfterSource:'official_header'});}};
  const router=new Router(config,platforms,{ledger});const server=await startServer({config,router,keys:{apiKey:'SAMPLE_KEY',adminKey:'SAMPLE_ADMIN'}},{port:0});t.after(()=>server.close());
  const gateway=p.createGatewayAdapter({runtime:{baseUrl:server.baseUrl,key:'SAMPLE_KEY'},models:[relay]}),ctx=new p.Context(),runtime=new p.LlmRuntime(ctx);runtime.registerAdapter(['ai-credit'],gateway.adapter);t.after(()=>ctx.fiber.dispose());
  for(let attempt=0;attempt<2;attempt++){
    const signal=new AbortController().signal,call=await runtime.prepareCall({provider:'ai-credit',model:'fixture'},signal),assembler=new p.BlockAssembler(),accumulator=new p.AssistantStreamAccumulator();
    for await(const chunk of call.stream({...request(signal),...call.config})){const timed=accumulator.push({time:Date.now(),chunk});assembler.push(timed.chunk);}
    const f=assembler.finish.failure;assert.equal(f.gatewayCode,'same_model_rate_limited');assert.equal(f.status,429);assert.equal(f.code,'RATE_LIMIT');assert.equal(f.upstreamCode,6004);assert.equal(f.rateLimitRetryable,false);assert.equal(f.gatewayManagedRetry,true);assert.ok(f.providerRetryAfterMs>=16000&&f.providerRetryAfterMs<=17000);assert.doesNotMatch(JSON.stringify(f),/SAMPLE_UPSTREAM_SECRET/);
    const harness=recoveryHarness(t,p);await harness.run(f,call.retryPolicy,signal);assert.equal(harness.events.length,0);
  }
  assert.equal(upstreamCalls,1,'the next cooldown request retains exact429 without another upstream generation');
});

test('server SSE partial content never restarts a gateway-owned request',async t=>{
  const p=await peers(t);if(!p)return;let calls=0;
  const config={value:{server:{host:'127.0.0.1',port:0,requestTimeoutMs:5000},routes:[]}},router={async*chat(){calls++;yield {id:'SAMPLE',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'SAMPLE_PARTIAL'},finish_reason:null}]};throw Object.assign(new AppError('SAMPLE rate rejection',429,'same_model_rate_limited'),{upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,gatewayManagedRetry:true});}};
  const server=await startServer({config,router,keys:{apiKey:'SAMPLE_KEY',adminKey:'SAMPLE_ADMIN'}},{port:0});t.after(()=>server.close());
  const gateway=p.createGatewayAdapter({runtime:{baseUrl:server.baseUrl,key:'SAMPLE_KEY'},models:[relay]}),signal=new AbortController().signal,result=await collect(gateway,p,signal);assert.ok(result.chunks.some(c=>c.type==='text-delta'&&c.text==='SAMPLE_PARTIAL'));assert.equal(result.finish.kind,'error');
  const harness=recoveryHarness(t,p);await harness.run(result.assembler.finish.failure,gateway.adapter.providerRetryPolicy('ai-credit'),signal);assert.equal(harness.events.length,0);assert.equal(calls,1);
});
