import test from 'node:test';
import assert from 'node:assert/strict';
import {Router} from '../src/router.mjs';
import {catalogModelFamily,relayDefaults} from '../src/model-relay.mjs';
import {collectChat} from '../src/openai.mjs';
import {AppError} from '../src/util.mjs';
const glm='glm-5.3',routeId='qoder-cn/gmodel';
const native={id:'gmodel',name:'GLM-5.3',source:'qoder-official-signed-catalog',callable:true,tools:true,contextWindow:180000,maxTokens:1024,maxTokensSource:'configured_default',officialMaxTokens:null,reasoning:null};
const tiered={id:glm,name:'GLM-5.3',callable:true,tools:true,maxTokens:65536,contextWindow:180000,reasoningEfforts:{low:'low',high:'high',max:'max'}};
function fixture(){
 const config={value:{accounts:[{id:'q',platform:'qoder'},{id:'w',platform:'bigmodel'},{id:'t',platform:'trae'}],upstreams:[{id:'q',kind:'qoder',accountId:'q'},{id:'w',kind:'bigmodel',accountId:'w'},{id:'t',kind:'trae',accountId:'t'}],routes:[{id:routeId,targets:[{upstreamId:'q',model:'gmodel'}]},{id:'wb/glm',targets:[{upstreamId:'w',model:glm}]},{id:'trae/old',targets:[{upstreamId:'t',model:'glm-5.2'}]}],modelRelay:{...relayDefaults,enabled:true}}},catalogs={q:[structuredClone(native)],w:[structuredClone(tiered)],t:[{...tiered,id:'glm-5.2'}]},calls=[];
 const platforms={models:async u=>catalogs[u]??[],chat:async(t,r)=>{calls.push({target:t,request:r});return {response:new Response(JSON.stringify({choices:[{message:{content:'OK'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})}}};
 const router=new Router(config,platforms);
 return {config,catalogs,calls,platforms,router};
}
const request=()=>({model:routeId,messages:[{role:'system',content:'Preserve this exact system context'},{role:'user',content:'Continue the original task'}],max_tokens:32768,tools:[{type:'function',function:{name:'read_sample',parameters:{type:'object',properties:{path:{type:'string'}}}}}]});
test('live signed Qoder opaque alias resolves exact GLM version and no other labels',()=>{
 assert.equal(catalogModelFamily('gmodel',native),glm);
 for(const row of [{...native,source:'configured'},{...native,callable:false},{...native,id:'other'},{...native,name:'Qoder · GLM-5.3'},{...native,name:'GLM-5.3-thinking'},{...native,name:'Auto'}])assert.equal(catalogModelFamily('gmodel',row),'gmodel');
 assert.equal(catalogModelFamily('gmodel',{...native,name:'GLM-5.2'}),'glm-5.2');
});
test('configured default 1024 is not a hard Qoder limit; consecutive 32768 requests work',async()=>{
 const f=fixture(),r=request();const first=await collectChat(f.router.chat(r)),second=await collectChat(f.router.chat(r));
 assert.equal(first.model,routeId);assert.equal(second.choices[0].message.content,'OK');assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.target.upstreamId==='q'&&c.request.max_tokens===32768));assert.deepEqual(f.calls[0].request.messages,r.messages);
});
test('Qoder402 falls to official same-model BigModel and no-tier to tier is real maximum',async()=>{
 const f=fixture(),r={...request(),reasoning_effort:'low',extra_body:{reasoning_effort:null,thinking_config:{thinking_budget:2},vendor_keep:9}};f.platforms.chat=async(t,body)=>{f.calls.push({target:t,request:body});if(t.upstreamId==='q')throw new AppError('credits exhausted',402,'credits_exhausted');return {response:new Response(JSON.stringify({choices:[{message:{content:'SAME_MODEL'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})}};
 const result=await collectChat(f.router.chat(r));assert.equal(result.model,routeId);assert.equal(result.choices[0].message.content,'SAME_MODEL');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['q','w']);assert.equal(f.calls[0].request.reasoning_effort,undefined);assert.equal(f.calls[1].request.reasoning_effort,'max');assert.equal(f.calls[1].request.extra_body.thinking_config,undefined);assert.equal(f.calls[1].request.extra_body.vendor_keep,9);assert.deepEqual(f.calls[1].request.messages,r.messages);assert.deepEqual(f.calls[1].request.tools,r.tools);assert.equal(f.calls[1].request.max_tokens,32768);assert.equal(f.config.value.routes[0].targets[0].upstreamId,'q');
});
test('official hard output cap still rejects without shrinking requested budget',async()=>{
 const f=fixture();f.catalogs.q[0].maxTokensSource='official_catalog';f.catalogs.q[0].maxTokens=1024;f.config.value.routes[1].enabled=false;
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.code==='relay_capacity_incompatible'&&e.status===400);assert.equal(f.calls.length,0);assert.equal(f.router.relay.cooldown({upstreamId:'q',model:'gmodel'}),null);
});
test('a capacity rejection on one request never cools a viable smaller request',async()=>{
 const f=fixture();f.catalogs.q[0].maxTokensSource='official_catalog';f.config.value.routes[1].enabled=false;
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.code==='relay_capacity_incompatible');
 const result=await collectChat(f.router.chat({...request(),max_tokens:512}));assert.equal(result.choices[0].message.content,'OK');assert.equal(f.calls.length,1);
});
test('legacy capability cooldown is ignored but true429 credit and auth cooldowns stay',async()=>{
 const f=fixture(),t={upstreamId:'q',model:'gmodel'},key='relay-cooldown:q\0gmodel';f.router.relay.set(key,{until:Date.now()+60000,reasonCode:'capability_unavailable'});
 assert.equal(f.router.relay.cooldown(t),null);assert.equal((await collectChat(f.router.chat(request()))).choices[0].message.content,'OK');
 for(const reasonCode of ['rate_limited','credits_exhausted','authentication_unavailable','upstream_unavailable']){f.router.relay.set(key,{until:Date.now()+60000,reasonCode});assert.equal(f.router.relay.cooldown(t).reasonCode,reasonCode);}
});
test('tools incompatibility does not cool plain requests for the same supplier',async()=>{
 const f=fixture();f.catalogs.q[0].tools=false;f.config.value.routes[1].enabled=false;
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.code==='tools_not_supported');
 const r=request();delete r.tools;assert.equal((await collectChat(f.router.chat(r))).choices[0].message.content,'OK');
});
test('all actual cooldowns give truthful503 and nearest finite retry deadline',async()=>{
 const f=fixture();for(const [u,m,seconds] of [['q','gmodel',18],['w',glm,41]])f.router.relay.set('relay-cooldown:'+u+'\0'+m,{until:Date.now()+seconds*1000,reasonCode:'rate_limited'});
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===429&&e.code==='same_model_rate_limited'&&e.retryAfterSeconds>=17&&e.retryAfterSeconds<=18&&!e.message.includes('WorkBuddy'));
 assert.equal(f.calls.length,0);
});
test('all disabled targets give truthful no-enabled503, no invented retry',async()=>{
 const f=fixture();f.config.value.upstreams.forEach(u=>u.enabled=false);
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===503&&e.code==='same_model_unavailable'&&e.retryAfterSeconds===undefined&&!e.message.includes('WorkBuddy'));
 assert.equal(f.calls.length,0);
});
test('expired cooldown re-enters without clearing real other account cooldown',async()=>{
 const f=fixture();f.router.relay.set('relay-cooldown:q\0gmodel',{until:Date.now()-1,reasonCode:'rate_limited'});f.router.relay.set('relay-cooldown:w\0'+glm,{until:Date.now()+60000,reasonCode:'credits_exhausted'});
 assert.equal((await collectChat(f.router.chat(request()))).choices[0].message.content,'OK');assert.equal(f.calls[0].target.upstreamId,'q');assert.ok(f.router.relay.cooldown({upstreamId:'w',model:glm}));
});
test('disabled same-model route cannot become standby through catalogue alias',async()=>{
 const f=fixture();f.config.value.routes[1].enabled=false;f.platforms.chat=async()=>{throw new AppError('credits exhausted',402)};
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===402);assert.equal(f.router.relay.get('relay-preferred:'+routeId),undefined);
});
test('opaque alias is re-resolved each preparation, never sticky across official version changes',async()=>{
 const f=fixture();let prepared=await f.router.relay.prepare(f.config.value.routes[0],f.config.value.routes[0].targets);assert.equal(prepared.family,glm);assert.deepEqual(prepared.targets.map(t=>t.upstreamId),['q','w']);
 f.catalogs.q[0].name='GLM-5.2';prepared=await f.router.relay.prepare(f.config.value.routes[0],f.config.value.routes[0].targets);assert.equal(prepared.family,'glm-5.2');assert.deepEqual(prepared.targets.map(t=>t.upstreamId),['q','t']);
});
test('missing signed opaque catalogue never guesses GLM alias from UI route name',async()=>{
 const f=fixture();f.catalogs.q=[];f.config.value.routes[0].name='Qoder · GLM-5.3';const p=await f.router.relay.prepare(f.config.value.routes[0],f.config.value.routes[0].targets);assert.deepEqual(p.targets.map(t=>t.upstreamId),['q']);assert.equal(p.family,'gmodel');
});
test('audit path does not import aliases or use standby when source402',async()=>{
 const f=fixture();f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw new AppError('credits exhausted',402)};await assert.rejects(collectChat(f.router.chat(request(),undefined,{source:'audit'})),e=>e.status===402);assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['q']);
});
test('route metadata includes live signed alias standby, without changing public ID',async()=>{
 const f=fixture();const row=await f.router.routeInfo(f.config.value.routes[0]);assert.equal(row.id,routeId);assert.equal(row.modelRelay.targetCount,2);assert.equal(row.modelRelay.modelFamily,glm);assert.equal(row.reasoningEfforts,null);
});
test('credit-depleted WB account pool cannot be resurrected or cross into Trae',async()=>{
 const f=fixture();f.config.value.accounts[1].platform='workbuddy';f.config.value.upstreams[1].kind='workbuddy';f.config.value.routes[1].accountPool={enabled:true,accountIds:['w']};f.config.value.routes[2].targets[0].model=glm;f.catalogs.t[0].id=glm;f.config.value.routes[0].enabled=false;
 const wbRoute=f.config.value.routes[1];f.router.pool.set('wb-pool-cooldown:w',{until:Date.now()+60000,reason:'credits_exhausted'});const p=await f.router.relay.prepare(wbRoute,f.router.pool.candidates(wbRoute));assert.deepEqual(p.targets,[]);
 await assert.rejects(collectChat(f.router.chat({...request(),model:wbRoute.id})),e=>e.code==='same_model_cooldown');assert.equal(f.calls.length,0);assert.ok(f.router.pool.get('wb-pool-cooldown:w').until>Date.now());assert.equal(f.router.pool.get('wb-pool-route:'+wbRoute.id),undefined);
});
test('fresh official zero-credit primary is skipped without a generation and same-model standby succeeds',async()=>{
 const f=fixture();f.router.relay.balanceSource=()=>new Map([['q',{value:0,unit:'积分',checkedAt:new Date().toISOString()}],['w',{value:642,unit:'积分',checkedAt:new Date().toISOString()}]]);
 const result=await collectChat(f.router.chat(request()));assert.equal(result.choices[0].message.content,'OK');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['w']);assert.equal(f.calls[0].request.reasoning_effort,'max');
});
test('all fresh official credit balances zero gives402 without provider burns or invented expiry',async()=>{
 const f=fixture();f.router.relay.balanceSource=()=>new Map([['q',{value:0,unit:'积分',checkedAt:new Date().toISOString()}],['w',{value:0,unit:'积分',checkedAt:new Date().toISOString()}]]);
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.code==='same_model_credits_exhausted'&&e.status===402&&e.retryAfterSeconds===undefined);assert.equal(f.calls.length,0);
});
test('zero cash and unknown or stale credit balances are not considered generation credit exhaustion',()=>{
 const f=fixture();for(const row of [{value:0,unit:'元'},{value:0,unit:'积分',stale:true},{value:0,unit:'积分',error:{}},{value:null,unit:'积分'},null])assert.equal(f.router.relay.exhaustedBalance(row),false);
});

for(const [status,code] of [[429,'rate_limited'],[504,'relay_target_timeout'],[402,'credits_exhausted']])test(`supplier ${status} followed by last tools mismatch preserves supplier failure, not caller400`,async()=>{
 const f=fixture();f.catalogs.w[0].tools=false;f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw new AppError('SAMPLE_SUPPLIER_FAILURE',status,code)};
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===(status===429?429:503)&&e.code===(status===429?'same_model_rate_limited':'same_model_unavailable')&&Number.isFinite(e.retryAfterSeconds)&&!e.message.includes('WorkBuddy'));
 assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['q']);assert.equal(f.router.relay.cooldown({upstreamId:'w',model:glm}),null);assert.ok(f.router.relay.cooldown({upstreamId:'q',model:'gmodel'}));
});
test('all suppliers capability-only mismatches retain caller400 with no outage cooldown',async()=>{
 const f=fixture();f.catalogs.q[0].tools=false;f.catalogs.w[0].tools=false;
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===400&&e.code==='tools_not_supported');assert.equal(f.calls.length,0);assert.equal(f.router.relay.cooldown({upstreamId:'q',model:'gmodel'}),null);assert.equal(f.router.relay.cooldown({upstreamId:'w',model:glm}),null);
});
test('unrelated invalid request remains400 and never tries standby',async()=>{
 const f=fixture();f.platforms.chat=async(t,r)=>{f.calls.push({target:t,request:r});throw new AppError('SAMPLE_INVALID_REQUEST',400,'invalid_request')};
 await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===400&&e.code==='invalid_request');assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['q']);
});
