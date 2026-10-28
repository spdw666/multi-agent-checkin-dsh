import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const at=path=>process.env.WORKBUDDY_CHANNEL_TEST_ROOT?pathToFileURL(resolve(process.env.WORKBUDDY_CHANNEL_TEST_ROOT,path)).href:new URL('../'+path,import.meta.url).href;
const {Router}=await import(at('src/router.mjs'));
const {collectChat,normalizeChat}=await import(at('src/openai.mjs'));
const {AppError}=await import(at('src/util.mjs'));

const model='deepseek-v4.1-flash',routeId='SAMPLE_ROUTE';
const rejected=(channel='ai')=>Object.assign(new AppError('SAMPLE channel rejected',400,'workbuddy_channel_rejected'),{upstreamCode:11128,upstreamStatus:400,workBuddyChannel:channel});
const reply=()=>({response:new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'SAMPLE_OK'},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}})});
const raw=()=>({model:routeId,messages:[{role:'system',content:'SAMPLE_SYSTEM'},{role:'user',content:'SAMPLE_USER'},{role:'assistant',content:null,tool_calls:[{id:'SAMPLE_CALL',type:'function',function:{name:'SAMPLE_TOOL',arguments:'{"value":"SAMPLE_ARG"}'}}]},{role:'tool',tool_call_id:'SAMPLE_CALL',content:'SAMPLE_RESULT'}],tools:[{type:'function',function:{name:'SAMPLE_TOOL',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}}],max_tokens:2048,temperature:0.3});
function fixture(channels=['ai','ai','cn'],{relay=true}={}){
  const ids=channels.map((_,i)=>'supplier'+i),calls=[],rows=[],values=new Map(),events=[];
  const config={value:{server:{requestTimeoutMs:90000},modelRelay:{enabled:relay},accounts:ids.map((id,i)=>({id,platform:'workbuddy',edition:channels[i],enabled:true})),upstreams:ids.map(id=>({id,accountId:id,kind:'workbuddy',enabled:true})),routes:ids.map((id,i)=>({id:i?'SAMPLE_STANDBY_'+i:routeId,targets:[{upstreamId:id,model}],enabled:true}))}};
  const metadata=Object.fromEntries(ids.map(id=>[id,{id:model,callable:true,tools:true,multimodal:true,contextWindow:200000,maxTokens:8192}]));
  const platforms={models:async id=>[metadata[id]],workBuddyChannel:async t=>channels[ids.indexOf(t.upstreamId)],chat:async(t,q)=>{calls.push({target:structuredClone(t),request:structuredClone(q)});if(t.upstreamId===ids[0])throw rejected(channels[0]);return reply();}};
  const ledger={get:k=>values.get(k),set:(k,v)=>values.set(k,v),record:r=>events.push(r),beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
  const router=new Router(config,platforms,{ledger,relayAttemptTimeoutMs:1000,relayNetworkRetryDelayMs:0});
  return {ids,channels,config,metadata,platforms,router,calls,rows,values,events};
}
test('11128 skips same actual channel, reaches another allowed same-model channel and keeps input intact',async()=>{
  const f=fixture(),q=raw(),before=structuredClone(q),result=await collectChat(f.router.chat(q));
  assert.equal(result.choices[0].message.content,'SAMPLE_OK');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['supplier0','supplier2']);
  assert.deepEqual(f.calls[0].request,q);assert.deepEqual(f.calls[1].request,q);assert.deepEqual(q,before);
  assert.deepEqual(f.rows.map(r=>r.status),['failed','skipped','completed']);
  assert.equal(f.rows[1].candidatePlan.reasonCode,'workbuddy_channel_skipped');assert.equal(f.rows[1].dispatched,false);assert.equal(f.rows[1].dispatchCount,0);
  assert.deepEqual(f.rows.at(-1).requestOutcome,{schema:1,state:'completed',candidateCount:3,skippedCount:1,attemptCount:2,dispatchCount:2});
  assert.equal([...f.values.keys()].some(k=>/cooldown/.test(k)),false);assert.equal(f.events.at(-1).reasonCode,'channel_unavailable');
});
test('only same rejected channel remains: return original11128 and truthful skip counters',async()=>{
  const f=fixture(['ai','ai','ai']);
  await assert.rejects(collectChat(f.router.chat(raw())),e=>{
    assert.equal(e.code,'workbuddy_channel_rejected');assert.equal(e.upstreamCode,11128);assert.equal(e.status,400);
    assert.deepEqual(e.relayFailure,{root:{code:'workbuddy_channel_rejected',status:400,platform:'workbuddy'},last:{code:'workbuddy_channel_skipped',status:400},skippedCount:2,attemptCount:1});return true;
  });
  assert.equal(f.calls.length,1);assert.deepEqual(f.rows.map(r=>r.status),['failed','skipped','skipped']);assert.equal(f.rows.at(-1).requestOutcome.dispatchCount,1);
});
test('a rejected WorkBuddy global brand does not skip the independent CodeBuddy global brand',async()=>{
  const f=fixture(['ai','codebuddy-ai','cn']);await collectChat(f.router.chat(raw()));
  assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['supplier0','supplier1']);assert.deepEqual(f.rows.map(r=>r.status),['failed','completed']);
});
test('request-scoped rejection does not ban accounts or alter the next request',async()=>{
  const f=fixture();await collectChat(f.router.chat(raw()));f.values.clear();let first=true;
  f.platforms.chat=async(t,q)=>{f.calls.push({target:t,request:q});if(first){first=false;assert.equal(t.upstreamId,'supplier0');}return reply();};
  await collectChat(f.router.chat(raw()));assert.equal(f.calls.length,3);
});
test('ordinary400 is not reclassified or replayed',async()=>{
  const f=fixture();f.platforms.chat=async(t,q)=>{f.calls.push({target:t,request:q});throw new AppError('SAMPLE invalid parameter11128',400,'client');};
  await assert.rejects(collectChat(f.router.chat(raw())),e=>e.code==='client');assert.equal(f.calls.length,1);
});
test('disabled relay leaves11128 terminal and never tries other channels',async()=>{
  const f=fixture(['ai','cn'],{relay:false});f.config.value.routes[0].targets.push({upstreamId:'supplier1',model});f.config.value.routes[0].fallbackStatuses=[400];
  await assert.rejects(collectChat(f.router.chat(raw())),e=>e.code==='workbuddy_channel_rejected');assert.equal(f.calls.length,1);
});
test('a capability-incompatible remaining channel preserves11128 instead of blaming caller tools',async()=>{
  const f=fixture(['ai','ai','cn']);f.metadata.supplier2.tools=false;
  await assert.rejects(collectChat(f.router.chat(raw())),e=>e.code==='workbuddy_channel_rejected'&&e.upstreamCode===11128&&e.relayFailure.skippedCount===2);
  assert.equal(f.calls.length,1);
});
test('partition, disabled target and model identity policies are not widened for11128',async()=>{
  const f=fixture(['ai','cn','cn']);f.config.value.upstreams[1].kind='codebuddy';f.config.value.upstreams[2].enabled=false;
  f.config.value.routes.push({id:'SAMPLE_OTHER_MODEL',targets:[{upstreamId:'supplier0',model:'another-model'}]});
  await assert.rejects(collectChat(f.router.chat(raw())),e=>e.code==='workbuddy_channel_rejected');assert.equal(f.calls.length,1);
});
test('cancellation takes precedence over11128 and stops standby dispatch',async()=>{
  const f=fixture(),c=new AbortController();f.platforms.chat=async(t,q)=>{f.calls.push({target:t,request:q});c.abort();throw rejected();};
  await assert.rejects(collectChat(f.router.chat(raw(),c.signal)),e=>e.code==='request_cancelled');assert.equal(f.calls.length,1);
});
test('the original request deadline takes precedence over11128 without a new standby clock',async()=>{
  const f=fixture();f.platforms.chat=async(t,q)=>{f.calls.push({target:t,request:q});await new Promise(resolve=>setTimeout(resolve,25));throw rejected();};
  await assert.rejects(collectChat(f.router.chat(raw(),AbortSignal.timeout(5))),e=>e.code==='request_timeout');assert.equal(f.calls.length,1);
});
test('actual credential channel is checked again before send and local skip retracts dispatch',async()=>{
  const f=fixture();f.platforms.workBuddyChannel=async t=>t.upstreamId==='supplier1'?'cn':f.channels[f.ids.indexOf(t.upstreamId)];
  f.platforms.chat=async(t,q,_s,options)=>{if(t.upstreamId==='supplier1'){assert.deepEqual(options.workBuddyRejectedChannels,['ai']);throw Object.assign(new AppError('SAMPLE locally skipped',400,'workbuddy_channel_skipped'),{upstreamRequestSent:false});}f.calls.push({target:t,request:q});if(t.upstreamId==='supplier0')throw rejected();return reply();};
  await collectChat(f.router.chat(raw()));assert.equal(f.rows[1].dispatched,false);assert.equal(f.rows.at(-1).requestOutcome.dispatchCount,2);
});
test('a local channel skip on transport retry retracts only the unsent retry, not the earlier real attempt',async()=>{
  const f=fixture(['ai','cn','cn']);let second=0;
  f.platforms.chat=async(t,q)=>{
    if(t.upstreamId==='supplier1'){
      if(second++===0){f.calls.push({target:t,request:q});throw new AppError('SAMPLE reset',502,'provider_network_error');}
      throw Object.assign(new AppError('SAMPLE credential changed channel',400,'workbuddy_channel_skipped'),{upstreamRequestSent:false});
    }
    f.calls.push({target:t,request:q});if(t.upstreamId==='supplier0')throw rejected();return reply();
  };
  await collectChat(f.router.chat(raw()));
  assert.equal(f.rows[1].dispatched,true);assert.equal(f.rows[1].dispatchCount,1);assert.equal(f.rows[1].status,'failed');
  assert.equal(f.rows.at(-1).requestOutcome.attemptCount,3);assert.equal(f.rows.at(-1).requestOutcome.dispatchCount,3);assert.equal(f.calls.length,3);
});
function channelSse(delta){const parts=[];if(delta)parts.push('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n');parts.push('data: '+JSON.stringify({code:11128,msg:'SAMPLE_PRIVATE_CHANNEL_BODY'})+'\n\n');return new Response(parts.join(''),{headers:{'Content-Type':'text/event-stream'}});}
test('HTTP200 SSE structured11128 before semantic output uses the same channel relay boundary',async()=>{
  const f=fixture();f.platforms.chat=async(t,q)=>{f.calls.push({target:t,request:q});return t.upstreamId==='supplier0'?{response:channelSse(),workBuddyChannel:'ai'}:reply();};
  await collectChat(f.router.chat(raw()));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['supplier0','supplier2']);
});
for(const [name,delta]of [['text',{content:'SAMPLE_PARTIAL'}],['reasoning',{reasoning_content:'SAMPLE_REASON'}],['tool',{tool_calls:[{index:0,id:'SAMPLE_NEW_CALL',type:'function',function:{name:'SAMPLE_TOOL',arguments:'{}'}}]}]])test('SSE11128 after '+name+' progress does not replay even before verified buffer is yielded',async()=>{
  const f=fixture();f.platforms.chat=async(t,q)=>{f.calls.push({target:t,request:q});return {response:channelSse(delta),workBuddyChannel:'ai'};};
  let yielded=0;await assert.rejects((async()=>{for await(const _ of f.router.chat(raw()))yielded++;})(),e=>e.code==='workbuddy_channel_rejected'&&e.upstreamCode===11128&&e.upstreamStatus===200);
  assert.equal(f.calls.length,1);assert.equal(yielded,0);
});
test('the same SSE numeric error from another provider is not WorkBuddy-classified',async()=>{
  await assert.rejects(collectChat(normalizeChat(channelSse(),{model,provider:'codebuddy'})),e=>e.code==='upstream_stream_error'&&e.upstreamCode!==11128);
});
test('HTTP200 JSON11128 is classified only under the WorkBuddy provider option',async()=>{
  const response=()=>new Response(JSON.stringify({code:11128,msg:'SAMPLE_PRIVATE_JSON_BODY'}),{headers:{'Content-Type':'application/json'}});
  await assert.rejects(collectChat(normalizeChat(response(),{model,provider:'workbuddy'})),e=>e.code==='workbuddy_channel_rejected'&&e.upstreamCode===11128&&e.upstreamStatus===200&&!e.message.includes('SAMPLE_PRIVATE'));
  await assert.rejects(collectChat(normalizeChat(response(),{model,provider:'codebuddy'})),e=>e.code==='upstream_business_error'&&e.upstreamCode!==11128);
});
