import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=process.env.GATEWAY_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {Router}=await import(pathToFileURL(join(root,'src/router.mjs')));
const {collectChat}=await import(pathToFileURL(join(root,'src/openai.mjs')));
const {AppError}=await import(pathToFileURL(join(root,'src/util.mjs')));
const model='deepseek-v4.1-flash',routeId='SAMPLE/'+model;
const ok=()=>({response:Response.json({choices:[{message:{content:'SAMPLE_COMPLETE'},finish_reason:'stop'}]})});
const raw=()=>({model:routeId,stream:true,max_tokens:4096,max_completion_tokens:4096,
  messages:[{role:'system',content:'PRIVATE_PROMPT_SENTINEL'},{role:'user',content:'PRIVATE_USER_SENTINEL'},
    {role:'assistant',content:null,tool_calls:[{id:'PRIVATE_TOOL_ID_SENTINEL',type:'function',function:{name:'sample_read',arguments:'{"path":"PRIVATE_ARGUMENT_SENTINEL"}'}}]},
    {role:'tool',tool_call_id:'PRIVATE_TOOL_ID_SENTINEL',content:'PRIVATE_RESULT_SENTINEL'}],
  tools:[{type:'function',function:{name:'sample_read',parameters:{type:'object',properties:{path:{type:'string'}}}}}],tool_choice:'auto'});
function fixture(n=2,{relay=true}={}){
  const ids=Array.from({length:n},(_,i)=>'supplier'+i),calls=[],catalogCalls=[],events=[],values=new Map(),rows=[];
  const config={value:{server:{requestTimeoutMs:90000},modelRelay:{enabled:relay},
    accounts:ids.map(id=>({id,platform:'codebuddy'})),upstreams:ids.map(id=>({id,accountId:id,kind:'codebuddy'})),
    routes:ids.map((id,i)=>({id:i?'SAMPLE_STANDBY_'+i+'/'+model:routeId,targets:[{upstreamId:id,model}]}))}};
  const metadata=Object.fromEntries(ids.map(id=>[id,{id:model,callable:true,tools:true,multimodal:true,contextWindow:200000,maxTokens:8192}]));
  const platforms={models:async id=>{catalogCalls.push(id);events.push('catalog:'+id);return[metadata[id]];},
    chat:async(t,r)=>{calls.push({target:structuredClone(t),request:structuredClone(r)});events.push('chat:'+t.upstreamId);return ok();}};
  const ledger={get:k=>values.get(k),set:(k,v)=>values.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
  const router=new Router(config,platforms,{ledger,relayAttemptTimeoutMs:1000,relayNetworkRetryDelayMs:0,relayRateLimitDelay:async()=>{throw new Error('SAMPLE unexpected paid replay');}});
  return {ids,config,metadata,platforms,ledger,router,calls,catalogCalls,events,values,rows};
}

test('fourteen output-incompatible accounts are skipped, one upstream attempt succeeds, original contract stays intact',async()=>{
  const f=fixture(15),request=raw(),original=structuredClone(request);
  for(const id of f.ids.slice(0,14))f.metadata[id].maxTokens=1024;
  const out=await collectChat(f.router.chat(request));
  assert.equal(out.choices[0].message.content,'SAMPLE_COMPLETE');assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].request,original);assert.deepEqual(request,original);
  assert.deepEqual(f.rows.map(r=>r.status),[...Array(14).fill('skipped'),'completed']);
  assert.ok(f.rows.slice(0,14).every(r=>r.dispatched===false&&r.dispatchCount===0&&r.candidatePlan.reasonCode==='relay_capacity_incompatible'));
  assert.deepEqual(f.rows.at(-1).requestOutcome,{schema:1,state:'completed',candidateCount:15,skippedCount:14,attemptCount:1,dispatchCount:1});
  assert.ok(f.ids.every(id=>f.catalogCalls.filter(x=>x===id).length===1),'one per-request model lookup, including primary source metadata');
  assert.equal([...f.values].filter(([k])=>k.startsWith('relay-cooldown:')).length,0);
});

test('prepared catalog snapshots are consumed without another model lookup',async()=>{
  const f=fixture(),prepare=f.router.relay.prepare.bind(f.router.relay);
  f.router.relay.prepare=async(...args)=>{const p=await prepare(...args);for(const id of f.ids)p.catalogs.set(id,[f.metadata[id]]);return p;};
  await collectChat(f.router.chat(raw()));assert.equal(f.catalogCalls.length,0);assert.equal(f.calls.length,1);
});

test('candidate planning never adds an eager full-pool catalogue read ahead of the active dispatch',async()=>{
  const f=fixture(3),chat=f.platforms.chat;
  f.platforms.chat=async(t,r,s)=>{if(t.upstreamId===f.ids[0]){f.calls.push({target:t,request:r});f.events.push('chat:'+t.upstreamId);throw new AppError('SAMPLE rejected',503,'provider_chat_rejected');}return chat(t,r,s);};
  await collectChat(f.router.chat(raw()));
  assert.equal(f.events.includes('catalog:'+f.ids[2]),false);
  assert.ok(f.events.indexOf('chat:'+f.ids[0])<f.events.indexOf('catalog:'+f.ids[1]));
  assert.equal(f.catalogCalls.filter(x=>x===f.ids[0]).length,1);
});

test('terminal capability skip retains first real supplier timeout and final candidate diagnosis separately',async()=>{
  const f=fixture();f.metadata[f.ids[1]].tools=false;
  f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw new AppError('SAMPLE private upstream body',504,'provider_timeout');};
  await assert.rejects(collectChat(f.router.chat(raw())),e=>{
    assert.equal(e.status,504);assert.equal(e.code,'provider_timeout');
    assert.deepEqual(e.relayFailure,{root:{code:'provider_timeout',status:504,platform:'codebuddy'},last:{code:'tools_not_supported',status:400},skippedCount:1,attemptCount:1});
    assert.equal(JSON.stringify(e.relayFailure).includes('private'),false);return true;
  });
  assert.deepEqual(f.rows.map(r=>r.status),['failed','skipped']);
  assert.equal(f.rows.at(-1).requestOutcome.state,'failed');assert.equal(f.rows.at(-1).requestOutcome.dispatchCount,2);
  assert.equal(f.router.relay.cooldown({upstreamId:f.ids[1],model}),null);
});

test('official long-window 6004 remains rate limited after locally skipped candidates and never waits',async()=>{
  const f=fixture(4);for(const id of f.ids.slice(1))f.metadata[id].tools=false;
  f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw Object.assign(new AppError('SAMPLE 6004',429,'provider_chat_rejected'),{upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,retryAfterSeconds:3,retryAfterSource:'official_header'});};
  await assert.rejects(collectChat(f.router.chat(raw())),e=>{
    assert.equal(e.code,'same_model_rate_limited');assert.equal(e.status,429);assert.equal(e.upstreamCode,6004);
    assert.equal(e.relayFailure.root.code,'provider_chat_rejected');assert.equal(e.relayFailure.root.status,429);
    assert.equal(e.relayFailure.skippedCount,3);assert.equal(e.relayFailure.attemptCount,1);return true;
  });
  assert.equal(f.calls.length,1);assert.equal(f.rows.filter(r=>r.status==='failed').length,1);assert.equal(f.rows.filter(r=>r.status==='skipped').length,3);
});

test('a capability-only rejection has zero upstream attempts and no false provider outage records',async()=>{
  const f=fixture();for(const id of f.ids)f.metadata[id].tools=false;
  await assert.rejects(collectChat(f.router.chat(raw())),e=>{
    assert.equal(e.code,'same_model_unavailable');assert.equal(e.status,503);assert.equal(e.relayFailure.attemptCount,0);assert.equal(e.relayFailure.skippedCount,2);return true;
  });
  assert.equal(f.calls.length,0);assert.ok(f.rows.every(r=>r.status==='skipped'&&r.candidatePlan.state==='skipped'));
  assert.equal(f.rows.at(-1).requestOutcome.state,'failed');assert.equal(f.values.size,0);
});

test('unverified smaller context skips without truncating history, tool schemas, IDs or results',async()=>{
  const f=fixture();f.metadata[f.ids[0]].contextWindow=1000000;f.metadata[f.ids[1]].contextWindow=10000;
  f.router.relay.balanceSource=()=>new Map([[f.ids[0],{value:0,unit:'积分',checkedAt:new Date().toISOString()}]]);
  const request=raw();request.messages[1].content='中'.repeat(12000);const before=structuredClone(request);
  await assert.rejects(collectChat(f.router.chat(request)),e=>e.status===503&&e.relayFailure.attemptCount===0&&e.relayFailure.skippedCount===1);
  assert.equal(f.calls.length,0);assert.deepEqual(request,before);assert.equal(f.rows[0].status,'skipped');
  assert.equal(f.rows[0].candidatePlan.reasonCode,'relay_context_incompatible');
});

test('unknown context and output capacity remain unknown rather than becoming invented limits',async()=>{
  const f=fixture(1);delete f.metadata[f.ids[0]].contextWindow;delete f.metadata[f.ids[0]].maxTokens;
  const request=raw();await collectChat(f.router.chat(request));
  assert.deepEqual(f.calls[0].request,request);assert.equal(f.rows[0].candidatePlan.state,'unknown');
  assert.equal(f.rows[0].candidatePlan.capabilities.contextWindow,null);assert.equal(f.rows[0].candidatePlan.capabilities.outputCapacity,null);
});

test('relay unknown tools stay unknown, while the existing nonrelay strict gate remains intact',async()=>{
  const f=fixture(1);delete f.metadata[f.ids[0]].tools;
  await collectChat(f.router.chat(raw()));assert.equal(f.rows[0].candidatePlan.capabilities.tools,null);assert.equal(f.rows[0].candidatePlan.state,'unknown');
  const strict=fixture(1,{relay:false});delete strict.metadata[strict.ids[0]].tools;
  await assert.rejects(collectChat(strict.router.chat(raw())),e=>e.code==='tools_not_supported');assert.equal(strict.calls.length,0);
});

test('retry dispatches and supplier attempts are counted separately',async()=>{
  const f=fixture(1),chat=f.platforms.chat;let n=0;
  f.platforms.chat=async(t,r,s)=>{if(n++===0){f.calls.push({target:t,request:r});throw new AppError('SAMPLE reset',502,'provider_network_error');}return chat(t,r,s);};
  await collectChat(f.router.chat(raw()));
  assert.equal(f.rows[0].dispatched,true);assert.equal(f.rows[0].dispatchCount,2);
  assert.deepEqual(f.rows[0].requestOutcome,{schema:1,state:'completed',candidateCount:1,skippedCount:0,attemptCount:1,dispatchCount:2});
});

test('even the last target is skipped rather than silently shrinking the submitted output budget',async()=>{
  const f=fixture(1);f.metadata[f.ids[0]].maxTokens=1024;
  const request=raw(),before=structuredClone(request);
  await assert.rejects(collectChat(f.router.chat(request)),e=>e.status===503&&e.code==='same_model_unavailable'&&e.relayFailure.attemptCount===0);
  assert.deepEqual(request,before);assert.equal(f.calls.length,0);
  assert.equal(f.rows[0].outputClamped,undefined);assert.equal(f.rows[0].candidatePlan.state,'skipped');
  assert.equal(f.rows[0].requestContract.outputBudget,4096);assert.equal(f.rows[0].requestContract.maxTokens,4096);
});

test('request diagnostics persist no prompt text, tool arguments, IDs, results, URLs or upstream raw body',async()=>{
  const f=fixture();f.metadata[f.ids[0]].tools=false;await collectChat(f.router.chat(raw()));
  const json=JSON.stringify(f.rows);for(const v of ['PRIVATE_PROMPT_SENTINEL','PRIVATE_USER_SENTINEL','PRIVATE_TOOL_ID_SENTINEL','PRIVATE_ARGUMENT_SENTINEL','PRIVATE_RESULT_SENTINEL'])assert.equal(json.includes(v),false,v);
  const c=f.rows.at(-1).requestContract;assert.equal(c.messageCount,4);assert.equal(c.toolCount,1);assert.equal(c.hasToolHistory,true);assert.equal(c.contextEstimate.tokenCount,null);
});

test('an externally validated request ID follows the request through skip and successful dispatch',async()=>{
  const f=fixture();f.metadata[f.ids[0]].tools=false;await collectChat(f.router.chat(raw(),undefined,{source:'hermes',requestId:'SAMPLE_REQUEST_TRACE'}));
  assert.ok(f.rows.every(r=>r.requestId==='SAMPLE_REQUEST_TRACE'&&r.source==='hermes'));
});

test('empty eligible pool exposes typed cooldown root without inventing upstream dispatch',async()=>{
  const f=fixture(1);f.values.set('relay-cooldown:'+f.ids[0]+'\0'+model,{until:Date.now()+30000,reasonCode:'rate_limited',status:429,errorCode:'provider_rate_limited',upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,retryAfterSeconds:30,retryAfterSource:'official_body'});
  await assert.rejects(collectChat(f.router.chat(raw())),e=>{
    assert.equal(e.status,429);assert.deepEqual(e.relayFailure,{root:{code:'provider_rate_limited',status:429,platform:'codebuddy'},last:{code:'same_model_rate_limited',status:429},skippedCount:0,attemptCount:0});return true;
  });assert.equal(f.calls.length,0);
});

test('route metadata uses the selected primary official ceiling, never the smaller standby minimum',async()=>{
  const f=fixture();f.metadata[f.ids[0]].maxTokens=65536;f.metadata[f.ids[0]].maxTokensSource='configured_default';f.metadata[f.ids[0]].officialMaxTokens=8192;
  f.metadata[f.ids[1]].maxTokens=1024;
  const info=await f.router.routeInfo(f.config.value.routes[0]);assert.equal(info.maxTokens,8192);
  f.metadata[f.ids[0]].maxTokensSource='official_catalog';delete f.metadata[f.ids[0]].officialMaxTokens;
  assert.equal((await f.router.routeInfo(f.config.value.routes[0])).maxTokens,65536);
});

test('failed per-request catalog lookup is not silently repeated as another model lookup',async()=>{
  const f=fixture(1);let reads=0;f.platforms.models=async()=>{reads++;throw new AppError('SAMPLE catalog failure',502,'model_catalog_failed');};
  await assert.rejects(collectChat(f.router.chat(raw())),e=>e.relayFailure.root.code==='model_catalog_failed');
  assert.equal(reads,1);assert.equal(f.calls.length,0);assert.equal(f.rows[0].requestOutcome.attemptCount,0);
});

test('a newer 6004 written while cached catalog awaits still blocks the recovery dispatch',async()=>{
  const f=fixture(1),target={upstreamId:f.ids[0],model};let afterWait=false,checks=0,inserted;
  const rate=()=>Object.assign(new AppError('SAMPLE limit',429,'provider_chat_rejected'),{upstreamCode:6001,rateLimitKind:'transient',rateLimitRetryable:true,retryAfterSeconds:0,retryAfterSource:'official_header'});
  f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw rate();};
  f.router.relayRateLimitDelay=async()=>{afterWait=true;};
  const cooldown=f.router.relay.cooldown.bind(f.router.relay);
  f.router.relay.cooldown=t=>{const current=cooldown(t);if(afterWait&&++checks===2)queueMicrotask(()=>{f.router.relay.failure(f.config.value.routes[0],target,Object.assign(rate(),{upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,retryAfterSeconds:3600}));inserted=structuredClone(cooldown(target));});return current;};
  await assert.rejects(collectChat(f.router.chat(raw())),e=>e.status===429&&e.upstreamCode===6004&&e.rateLimitKind==='long_window');
  assert.equal(f.calls.length,1);assert.equal(f.catalogCalls.length,1);assert.deepEqual(cooldown(target),inserted);
});

test('a manually disabled target or zero balance observed just before queued dispatch never replays',async()=>{
  for(const change of ['disabled','balance']){
    const f=fixture(1);let afterWait=false,checks=0;
    f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw Object.assign(new AppError('SAMPLE short limit',429,'provider_chat_rejected'),{upstreamCode:6001,rateLimitKind:'transient',rateLimitRetryable:true,retryAfterSeconds:0,retryAfterSource:'official_header'});};
    f.router.relayRateLimitDelay=async()=>{afterWait=true;};
    const cooldown=f.router.relay.cooldown.bind(f.router.relay);
    f.router.relay.cooldown=t=>{const current=cooldown(t);if(afterWait&&++checks===2)queueMicrotask(()=>{if(change==='disabled')f.config.value.accounts[0].enabled=false;else f.router.relay.balanceSource=()=>new Map([[f.ids[0],{value:0,unit:'积分',checkedAt:new Date().toISOString()}]]);});return current;};
    await assert.rejects(collectChat(f.router.chat(raw())),e=>['same_model_unavailable','same_model_credits_exhausted'].includes(e.code));
    assert.equal(f.calls.length,1,change);assert.equal(f.rows.at(-1).requestOutcome.attemptCount,1);assert.equal(f.rows.at(-1).requestOutcome.dispatchCount,1);
  }
});

test('no-candidate terminal requests have one metadata-only outcome row and zero supplier attempts',async()=>{
  for(const mode of ['disabled','credits','cooldown','invalid_route','invalid_request','preabort']){
    const f=fixture(1),request=raw(),controller=new AbortController();
    if(mode==='disabled')f.config.value.accounts[0].enabled=false;
    if(mode==='credits')f.router.relay.balanceSource=()=>new Map([[f.ids[0],{value:0,unit:'积分',checkedAt:new Date().toISOString()}]]);
    if(mode==='cooldown')f.values.set('relay-cooldown:'+f.ids[0]+'\0'+model,{until:Date.now()+60000,reasonCode:'authentication_unavailable',status:401});
    if(mode==='invalid_route')request.model='SAMPLE_MISSING_ROUTE';
    if(mode==='invalid_request')request.messages=[];
    if(mode==='preabort')controller.abort();
    await assert.rejects(collectChat(f.router.chat(request,controller.signal)));
    assert.equal(f.calls.length,0,mode);assert.equal(f.rows.length,1,mode);
    const row=f.rows[0];assert.equal(row.rowType,'request_outcome');assert.equal(row.attempt,0);assert.equal(row.dispatched,false);assert.equal(row.dispatchCount,0);
    assert.equal(row.upstreamId,'');assert.equal(row.accountId,'');assert.equal(row.credits,null);assert.equal(row.cost,null);
    assert.deepEqual(row.requestOutcome,{schema:1,state:mode==='preabort'?'cancelled':'failed',candidateCount:0,skippedCount:0,attemptCount:0,dispatchCount:0});
    assert.equal(JSON.stringify(row).includes('PRIVATE_'),false);
  }
});
