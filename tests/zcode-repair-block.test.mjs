import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=process.env.GATEWAY_REPAIR_TEST_ROOT;
const at=name=>root?pathToFileURL(resolve(root,name)).href:new URL('../'+name,import.meta.url).href;
const {zcodeChat}=await import(at('src/zcode-models.mjs'));
const {hash,AppError}=await import(at('src/util.mjs'));
const {Router}=await import(at('src/router.mjs'));
const {collectChat}=await import(at('src/openai.mjs'));
const {relayFailureMetadata}=await import(at('src/client-contract.mjs'));
const {enrichGatewayFailure,gatewayRetryRecovery}=await import(at('bundle/retry-metadata.mjs'));
const credential={principal:'SAMPLE_PRINCIPAL',accessToken:'SAMPLE_TOKEN',identity:{deviceId:'SAMPLE_DEVICE'}};
const request={model:'glm-5.3-flash',messages:[{role:'user',content:'SAMPLE'}],max_tokens:16,stream:true};
const key='proxy-block/zcode/'+hash(credential.principal);
const ledger=()=>{const rows=new Map();return {get:k=>rows.get(k),set:(k,v)=>rows.set(k,v),rows};};
async function mocked(t,fn){const old=globalThis.fetch;globalThis.fetch=fn;t.after(()=>{globalThis.fetch=old;});}
for(const code of [3012,'3012'])test('official '+JSON.stringify(code)+' is typed503 with original405 retained, sanitized and local900s cooldown',async t=>{
 const l=ledger();let hits=0;await mocked(t,async()=>{hits++;return new Response(JSON.stringify({code,msg:'SAMPLE_SECRET_FROM_UPSTREAM'}),{status:405});});
 await assert.rejects(zcodeChat(credential,request,undefined,l),e=>{assert.equal(e.status,503);assert.equal(e.code,'zcode_upstream_blocked');assert.equal(e.upstreamStatus,405);assert.equal(e.upstreamCode,3012);assert.equal(e.retryable,false);assert.equal(e.retryAfterSeconds,900);assert.equal(e.retryAfterSource,'local_default');assert.equal(e.actionRequired,true);assert.match(e.message,/原生客户端/);assert.doesNotMatch(e.message,/SAMPLE_SECRET/);return true;});
 assert.equal(hits,1);assert.equal(l.get(key).code,3012);assert.equal(l.get(key).http,405);
});
test('unexpired account cooldown sends zero requests, retains original status and does not extend itself',async t=>{
 const l=ledger(),until=Date.now()+120000;l.set(key,{until,code:3012,http:405});let hits=0;await mocked(t,async()=>{hits++;throw Error('must not fetch');});
 for(let i=0;i<2;i++)await assert.rejects(zcodeChat(credential,request,undefined,l),e=>e.code==='zcode_upstream_blocked'&&e.upstreamStatus===405&&e.retryAfterSeconds<=120&&e.retryAfterSeconds>118);
 assert.equal(hits,0);assert.equal(l.get(key).until,until);
});
test('after natural cooldown expiry a user request makes one normal attempt and success clears local block',async t=>{
 const l=ledger();l.set(key,{until:Date.now()-1,code:3012,http:405});let hits=0;await mocked(t,async()=>{hits++;return new Response(JSON.stringify({id:'SAMPLE',content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});});
 const result=await zcodeChat(credential,request,undefined,l);assert.ok(result.response);assert.equal(hits,1);assert.equal(l.get(key).until,0);
});
test('non3012 method error remains405 and is not relabeled as an activity block',async t=>{
 const l=ledger();await mocked(t,async()=>new Response(JSON.stringify({code:123,msg:'SAMPLE_SECRET'}),{status:405}));
 await assert.rejects(zcodeChat(credential,request,undefined,l),e=>e.status===405&&e.code==='zcode_model_error'&&!e.message.includes('SAMPLE_SECRET'));assert.equal(l.get(key),undefined);
});
for(const relay of [true,false])test('3012 never switches account/model or retries a generation even with fallback503 and relay='+relay,async()=>{
 const id='glm-5.3-flash',calls=[],rows=new Map(),config={value:{accounts:[{id:'a'},{id:'b'}],upstreams:[{id:'a',kind:'zcode',accountId:'a'},{id:'b',kind:'zcode',accountId:'b'}],routes:[{id:'zcode/'+id,targets:[{upstreamId:'a',model:id},{upstreamId:'b',model:id}],fallbackStatuses:[405,503]}],modelRelay:{enabled:relay,reservePercent:10,reserveCredits:100,balanceMaxAgeSeconds:60}}};
 const platforms={models:async()=>[{id,tools:true,multimodal:true,contextWindow:1000000,maxTokens:128000}],chat:async t=>{calls.push(t.upstreamId);throw Object.assign(new AppError('SAMPLE',503,'zcode_upstream_blocked'),{upstreamStatus:405,retryAfterSeconds:900});}};
 const r=new Router(config,platforms,{ledger:{get:k=>rows.get(k),set:(k,v)=>rows.set(k,v)}});
 await assert.rejects(collectChat(r.chat({...request,model:'zcode/'+id})),e=>e.code==='zcode_upstream_blocked');assert.deepEqual(calls,['a']);assert.equal(rows.size,0,'no fake transient relay outage');
});
test('public root diagnosis retains zcode and typed3012 code instead of upstream/upstream_error',()=>{
 const m=relayFailureMetadata({root:{platform:'zcode',code:'zcode_upstream_blocked',status:503},last:{code:'zcode_upstream_blocked',status:503},attemptCount:1,skippedCount:0});assert.equal(m.root.platform,'zcode');assert.equal(m.root.code,'zcode_upstream_blocked');assert.equal(m.last.code,'zcode_upstream_blocked');
});
test('DSH sanitized failure shows actionable3012/localcooldown, preserves405 evidence and blocks outer retry',async()=>{
 const e={code:'SERVER',message:'503: '+JSON.stringify({error:{type:'zcode_upstream_blocked',code:'zcode_upstream_blocked',message:'SAMPLE_SECRET',upstreamStatus:405,retryAfterSeconds:900,retryAfterSource:'local_default',gatewayManagedRetry:true,gatewayRetryOwner:'gateway',gatewayRequestId:'aigw-00000000-0000-4000-8000-000000000000',relayFailure:{root:{platform:'zcode',code:'zcode_upstream_blocked',status:503},attemptCount:1,skippedCount:0}}})};
 const f=enrichGatewayFailure(e);assert.equal(f.gatewayCode,'zcode_upstream_blocked');assert.equal(f.upstreamCode,3012);assert.equal(f.upstreamStatus,405);assert.match(f.message,/原生客户端/);assert.match(f.message,/本地冷却剩余 900 秒/);assert.doesNotMatch(JSON.stringify(f),/SAMPLE_SECRET/);assert.equal(f.providerRetryAfterMs,undefined);
 let next=0;assert.equal(await gatewayRetryRecovery({provider:'ai-credit',failure:JSON.parse(JSON.stringify(f))},()=>{next++;return 'retry';}),undefined);assert.equal(next,0);
});
