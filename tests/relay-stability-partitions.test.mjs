import test from 'node:test';
import assert from 'node:assert/strict';
import {Router} from '../src/router.mjs';
import {collectChat,normalizeChat} from '../src/openai.mjs';
import {validateRelay,relayDefaults} from '../src/model-relay.mjs';
import {AppError} from '../src/util.mjs';
import {startServer} from '../src/server.mjs';

const model='glm-5.3';
function fixture({idle=1000}={}){
  const accounts=['wa','wb','ca','cb'].map((id,i)=>({id,platform:i<2?'workbuddy':'codebuddy'}));
  const config={value:{accounts,server:{requestTimeoutMs:10000},modelRelay:{...relayDefaults,enabled:true},upstreams:accounts.map(a=>({id:a.id,accountId:a.id,kind:a.platform})),routes:accounts.map(a=>({id:a.id+'/'+model,targets:[{upstreamId:a.id,model}]}))}};
  const metadata=Object.fromEntries(accounts.map(a=>[a.id,{id:model,callable:true,tools:true,multimodal:true,contextWindow:1000000,maxTokens:64000}]));
  const calls=[],rows=[],state=new Map();
  const platforms={models:async id=>[metadata[id]],chat:async(target,request)=>{calls.push({target,request});return {response:Response.json({choices:[{message:{content:'STABLE'},finish_reason:'stop'}]})};}};
  const ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
  return {config,metadata,calls,rows,state,platforms,router:new Router(config,platforms,{ledger,relayAttemptTimeoutMs:idle})};
}
const request=id=>({model:id+'/'+model,messages:[{role:'system',content:'UNTRIMMED_SYSTEM'},{role:'user',content:'UNTRIMMED_USER'}],max_completion_tokens:48000,tools:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}],stream:true});

test('WB relay only chooses other WB accounts, even if non-WB has a higher balance',async()=>{
 const f=fixture();f.router.relay.balanceSource=()=>new Map(f.config.value.accounts.map(a=>[a.id,{value:a.id==='wa'?0:a.id==='wb'?20:700,unit:'积分',checkedAt:new Date().toISOString()}]));
 const out=await collectChat(f.router.chat(request('wa')));
 assert.equal(out.choices[0].message.content,'STABLE');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['wb']);assert.deepEqual(f.calls[0].request.messages,request('wa').messages);assert.equal(f.calls[0].request.max_completion_tokens,48000);
});
test('non-WB relay never falls into a WB supplier, even if WB appears first in config',async()=>{
 const f=fixture(),normal=f.platforms.chat;f.platforms.chat=async(t,r)=>{if(t.upstreamId==='ca'){f.calls.push({target:t,request:r});throw new AppError('credits exhausted',402,'credits_exhausted');}return normal(t,r);};
 await collectChat(f.router.chat(request('ca')));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['ca','cb']);
});
test('partitions have independently effective switches and preserve legacy enabled migration',()=>{
 const f=fixture();assert.equal(f.router.relay.active(f.config.value.routes[0]),true);assert.equal(f.router.relay.active(f.config.value.routes[2]),true);
 f.config.value.modelRelay.partitions={workbuddy:false,other:true};assert.equal(f.router.relay.active(f.config.value.routes[0]),false);assert.equal(f.router.relay.active(f.config.value.routes[2]),true);
 f.config.value.modelRelay.partitions={workbuddy:true,other:false};assert.equal(f.router.relay.active(f.config.value.routes[0]),true);assert.equal(f.router.relay.active(f.config.value.routes[2]),false);
 f.config.value.modelRelay.enabled=false;assert.equal(f.router.relay.active(f.config.value.routes[0]),false);
});
test('HTTP partition settings persist independently and reject untrusted flag shapes',async t=>{
 const f=fixture();f.config.value.server={host:'127.0.0.1',port:0};f.config.save=async value=>{f.config.value=value;};
 const server=await startServer({config:f.config,router:f.router,keys:{apiKey:'fixture-api',adminKey:'fixture-admin'}},{port:0});t.after(()=>server.close());
 const post=body=>fetch(server.baseUrl+'/admin/model-relay',{method:'POST',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json'},body:JSON.stringify(body)});
 const response=await post({enabled:true,partitions:{workbuddy:true,other:false}});assert.equal(response.status,200);assert.equal((await response.json()).groups.find(g=>g.partition==='other').enabled,false);assert.deepEqual(f.config.value.modelRelay.partitions,{workbuddy:true,other:false});
 assert.equal((await post({partitions:{workbuddy:'yes',other:true}})).status,400);assert.deepEqual(f.config.value.modelRelay.partitions,{workbuddy:true,other:false});
});
test('legacy HTTP enabled toggle does not accidentally freeze absent partitions as disabled',async t=>{
 const f=fixture();f.config.value.server={host:'127.0.0.1',port:0};f.config.value.modelRelay.enabled=false;f.config.save=async value=>{f.config.value=value;};
 const server=await startServer({config:f.config,router:f.router,keys:{apiKey:'fixture-api',adminKey:'fixture-admin'}},{port:0});t.after(()=>server.close());
 const response=await fetch(server.baseUrl+'/admin/model-relay',{method:'POST',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json'},body:JSON.stringify({enabled:true})});assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.partitions,{workbuddy:true,other:true});assert.ok(body.groups.every(g=>g.enabled));
});
test('status exposes only the route partition and rejects malformed partition flags',()=>{
 const f=fixture(),status=f.router.relay.status();assert.equal(status.partitioned,true);assert.deepEqual(status.partitions,{workbuddy:true,other:true});
 for(const group of status.groups){assert.equal(group.partition,group.routeId.startsWith('w')?'workbuddy':'other');assert.ok(group.targets.every(t=>(t.platform==='workbuddy')===(group.partition==='workbuddy')));}
 for(const partitions of [[],null,{workbuddy:'yes'},{other:1},{unknown:true}])assert.throws(()=>validateRelay({...relayDefaults,partitions}),e=>e.code==='invalid_model_relay');
});
test('manual mixed target lists stay partitioned even with automatic relay disabled',async()=>{
 const f=fixture();f.config.value.modelRelay.enabled=false;f.config.value.routes[0].targets.push({upstreamId:'ca',model});f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw new AppError('down',503,'unavailable');};
 await assert.rejects(collectChat(f.router.chat(request('wa'))));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['wa']);
});
test('one-million-token primary keeps its actual capacity instead of a 32K standby default',async()=>{
 const f=fixture();delete f.metadata.cb.contextWindow;f.metadata.cb.maxTokens=1024;
 const row=await f.router.routeInfo(f.config.value.routes[2]);assert.equal(row.contextWindow,1000000);assert.equal(row.maxTokens,64000);assert.equal(row.modelRelay.partition,'other');assert.equal(row.modelRelay.targetCount,2);assert.equal(row.modelRelay.fullWindowCompatibleCount,1);
});
test('a standby below the actual requested output envelope is skipped without trimming',async()=>{
 const f=fixture();f.metadata.cb.contextWindow=32768;f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw new AppError('down',503,'unavailable');};
 const raw=request('ca'),before=JSON.stringify(raw);await assert.rejects(collectChat(f.router.chat(raw)),e=>e.code==='same_model_unavailable'&&e.status===503);
 assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['ca']);assert.equal(JSON.stringify(raw),before);assert.equal(f.router.relay.cooldown({upstreamId:'cb',model}),null);assert.equal(f.rows[1].error.code,'relay_context_incompatible');
});
test('unknown standby capacity delegates unchanged payload to the authoritative upstream',async()=>{
 const f=fixture();delete f.metadata.cb.contextWindow;f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw new AppError('credits exhausted',402,'credits_exhausted');};
 await assert.rejects(collectChat(f.router.chat(request('ca'))),e=>e.status===402);assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['ca','cb']);assert.ok(f.calls.every(c=>JSON.stringify(c.request.messages)===JSON.stringify(request('ca').messages)));
});
test('context length error remains a request capability failure, not wallet depletion or supplier cooldown',async()=>{
 const f=fixture();f.config.value.routes=f.config.value.routes.filter(r=>r.id.startsWith('ca/'));
 f.platforms.chat=async()=>{throw new AppError('context window quota exceeded by input',400,'context_length_exceeded');};
 await assert.rejects(collectChat(f.router.chat(request('ca'))),e=>e.code==='context_length_exceeded');assert.equal(f.router.relay.cooldown({upstreamId:'ca',model}),null);assert.ok(![...f.state.keys()].some(k=>k.includes('cooldown')));
});
test('upstream SSE context codes retain a structured context error rather than generic502',async()=>{
 const response=new Response('event: error\ndata: '+JSON.stringify({error:{message:'prompt is too long',code:'context_length_exceeded'}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 await assert.rejects(collectChat(normalizeChat(response,{model})),e=>e.status===400&&e.code==='context_length_exceeded');
});
test('upstream JSON context codes retain structured context classification',async()=>{
 await assert.rejects(collectChat(normalizeChat(Response.json({error:{code:'context_window_exceeded',message:'input exceeds the maximum context length'}}),{model})),e=>e.status===400&&e.code==='context_length_exceeded');
});
test('SSE mislabeled as JSON is parsed by body framing with no dropped first token',async()=>{
 const wire='data: '+JSON.stringify({choices:[{delta:{content:'FIRST_TOKEN_INTACT'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
 assert.equal((await collectChat(normalizeChat(new Response(wire,{headers:{'content-type':'application/json'}}),{model}))).choices[0].message.content,'FIRST_TOKEN_INTACT');
});
test('framing split across network chunks is replayed byte-exactly',async()=>{
 const parts=['d','at','a: '+JSON.stringify({choices:[{delta:{content:'中🙂'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'],encoder=new TextEncoder();let i=0;
 const body=new ReadableStream({pull(c){if(i===parts.length)c.close();else c.enqueue(encoder.encode(parts[i++]));}});
 assert.equal((await collectChat(normalizeChat(new Response(body,{headers:{'content-type':'application/json'}}),{model}))).choices[0].message.content,'中🙂');
});
test('complete JSON mislabeled as SSE preserves answer and usage',async()=>{
 const out=await collectChat(normalizeChat(new Response(JSON.stringify({choices:[{message:{content:'JSON_INTACT'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:2}}),{headers:{'content-type':'text/event-stream'}}),{model}));
 assert.equal(out.choices[0].message.content,'JSON_INTACT');assert.equal(out.usage.prompt_tokens,100);
});
test('context mismatch cannot suppress the next small request on a healthy wallet',async()=>{
 const f=fixture();f.config.value.routes=f.config.value.routes.filter(r=>r.id.startsWith('ca/'));let n=0;const normal=f.platforms.chat;
 f.platforms.chat=async(t,r)=>{if(!n++)throw new AppError('prompt is too long',400,'context_length_exceeded');return normal(t,r);};
 await assert.rejects(collectChat(f.router.chat(request('ca'))));assert.equal((await collectChat(f.router.chat(request('ca')))).choices[0].message.content,'STABLE');
});
test('supplier rate limit followed by incompatible tools still reports supplier unavailability',async()=>{
 const f=fixture();f.metadata.cb.tools=false;f.platforms.chat=async()=>{throw new AppError('rate limit',429,'rate_limit');};
 await assert.rejects(collectChat(f.router.chat(request('ca'))),e=>e.status===429&&e.code==='same_model_rate_limited');assert.equal(f.router.relay.cooldown({upstreamId:'cb',model}),null);
});
test('default no-progress supplier wait is 30 seconds rather than fixed90 complete-result timeout',async()=>{
 const f=fixture(),router=new Router(f.config,f.platforms);assert.equal(router.relayAttemptTimeoutMs,30000);const row=await router.routeInfo(f.config.value.routes[2]);assert.equal(row.modelRelay.attemptTimeoutMode,'prefill_then_progress_idle');assert.equal(row.modelRelay.prefillTimeoutMs,90000);
});
test('continuous stream progress can exceed the initial idle budget without being killed and replayed',async()=>{
 const f=fixture({idle:70}),normal=f.platforms.chat;f.platforms.chat=async(t,r,signal)=>{if(t.upstreamId!=='ca')return normal(t,r);f.calls.push({target:t,request:r});let n=0,timer;const body=new ReadableStream({start(controller){timer=setInterval(()=>{n++;const done=n===5;controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'S'+n},finish_reason:done?'stop':null}]})+'\n\n'));if(done){clearInterval(timer);controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();}},25);signal.addEventListener('abort',()=>{clearInterval(timer);controller.error(new Error('aborted'));},{once:true});},cancel(){clearInterval(timer);}});return {response:new Response(body,{headers:{'content-type':'text/event-stream'}})};};
 const out=await collectChat(f.router.chat(request('ca')));assert.equal(out.choices[0].message.content,'S1S2S3S4S5');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['ca']);assert.equal(f.rows[0].status,'completed');
});
