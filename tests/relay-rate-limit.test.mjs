import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {AppError} from '../src/util.mjs';
import {collectChat} from '../src/openai.mjs';

const {Router}=await import(process.env.RELAY_RATE_ROUTER_MODULE?pathToFileURL(process.env.RELAY_RATE_ROUTER_MODULE).href:new URL('../src/router.mjs',import.meta.url).href);
const model='deepseek-v4.1-flash',publicId='SAMPLE/'+model,key=t=>'relay-cooldown:'+t+'\0'+model;
const digest=r=>createHash('sha256').update(JSON.stringify(r)).digest('hex');
function fixture({single=false,small=true,delay,budget=10000,extra=false}={}){
 const ids=single?['primary']:['primary','standby'],state=new Map(),rows=[],calls=[],waits=[];
 const config={value:{server:{requestTimeoutMs:budget},modelRelay:{enabled:true},accounts:ids.map(id=>({id,platform:id==='primary'?'workbuddyai':'trae'})),upstreams:ids.map(id=>({id,accountId:id,kind:id==='primary'?'workbuddyai':'trae'})),routes:ids.map((id,i)=>({id:i?'SAMPLE_STANDBY/'+model:publicId,targets:[{upstreamId:id,model}]}))}};
 if(extra){config.value.accounts.push({id:'wb',platform:'workbuddy'});config.value.upstreams.push({id:'wb',accountId:'wb',kind:'workbuddy'});config.value.routes.push({id:'SAMPLE_WB/'+model,targets:[{upstreamId:'wb',model}]},{id:'SAMPLE_SG/'+model,targets:[{upstreamId:'primary',model:model+'-sg'}]});}
 const metadata=Object.fromEntries([...ids,...(extra?['wb']:[])].map(id=>[id,{id:model,callable:true,tools:true,contextWindow:id==='standby'&&small?200000:1000000,maxTokens:128000}]));
 const platforms={models:async id=>[metadata[id]],chat:async(target,request)=>{calls.push({target:structuredClone(target),request:structuredClone(request),hash:digest(request)});return {response:Response.json({choices:[{message:{content:'SAMPLE_COMPLETE'},finish_reason:'stop'}]})};}};
 const ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
 const router=new Router(config,platforms,{ledger,relayAttemptTimeoutMs:20,relayPrefillTimeoutMs:60,relayNetworkRetryDelayMs:0,relayRateLimitDelay:async(ms,signal)=>{waits.push(ms);if(delay)await delay(ms,signal);}});
 return {config,state,rows,calls,waits,metadata,platforms,router};
}
const request=()=>({model:publicId,stream:true,max_completion_tokens:128000,messages:[{role:'system',content:'SAMPLE_SYSTEM '.repeat(20000)},{role:'user',content:'Preserve the complete SAMPLE request.'},{role:'assistant',content:null,tool_calls:[{id:'SAMPLE_ORIGINAL_TOOL_ID',type:'function',function:{name:'read_sample',arguments:'{"path":"SAMPLE"}'}}]},{role:'tool',tool_call_id:'SAMPLE_ORIGINAL_TOOL_ID',content:'SAMPLE_COMPLETE_TOOL_RESULT'}],tools:[{type:'function',function:{name:'read_sample',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}],tool_choice:'auto'});
function rate({kind='unknown',code,retry,retryable=false,source='official_header'}={}){return Object.assign(new AppError('SAMPLE private upstream body must not persist',429,'provider_chat_rejected'),{rateLimitKind:kind,rateLimitRetryable:retryable,...(code!==undefined?{upstreamCode:code}:{}),...(retry!==undefined?{retryAfterSeconds:retry,retryAfterSource:source}:{})});}
function rejectPrimary(f,error,{thenSuccess=false}={}){const normal=f.platforms.chat;let count=0;f.platforms.chat=async(t,r,s)=>{if(t.upstreamId==='primary'&&(!thenSuccess||count++===0)){f.calls.push({target:structuredClone(t),request:structuredClone(r),hash:digest(r)});throw error;}return normal(t,r,s);};}
async function failure(f,raw=request(),signal){try{await collectChat(f.router.chat(raw,signal));assert.fail('Expected a failure');}catch(e){if(e.code==='ERR_ASSERTION')throw e;return e;}}
function unchanged(f,raw){const expected=digest(raw);for(const row of f.calls){assert.equal(row.hash,expected);assert.deepEqual(row.request,raw);}assert.equal(digest(raw),expected);}
function assertRate(e,{kind='unknown',source='local_default'}={}){assert.equal(e.status,429);assert.equal(e.code,'same_model_rate_limited');assert.equal(e.upstreamStatus,429);assert.equal(e.rateLimitKind,kind);assert.equal(e.retryAfterSource,source);assert.equal(e.gatewayManagedRetry,true);assert.ok(Number.isFinite(e.retryAfterSeconds));assert.ok(!e.message.includes('SAMPLE private'));assert.equal(e.message.includes('本地冷却不代表官方恢复时间'),source==='local_default');}

test('single unknown 429 is terminal 429 with a local probe delay, not a disguised503',async()=>{
 const f=fixture({single:true}),raw=request();rejectPrimary(f,rate());const e=await failure(f,raw);assertRate(e);assert.equal(e.rateLimitRetryable,false);assert.equal(f.calls.length,1);assert.equal(f.waits.length,0);unchanged(f,raw);
 const stored=f.state.get(key('primary'));assert.equal(stored.status,429);assert.equal(stored.errorCode,'provider_chat_rejected');assert.equal(stored.retryAfterSource,'local_default');assert.equal(stored.rateLimitKind,'unknown');assert.ok(!JSON.stringify(stored).includes('private'));
});
test('current 429 plus locally incompatible standby remains429 and keeps the whole request',async()=>{
 const f=fixture(),raw=request();rejectPrimary(f,rate());const e=await failure(f,raw);assertRate(e);assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);assert.deepEqual(f.rows.map(r=>r.error?.code),['provider_chat_rejected','relay_context_incompatible']);assert.equal(f.router.relay.cooldown({upstreamId:'standby',model}),null);unchanged(f,raw);
});
test('the following request recovers the persisted429 cause instead of exposing standby context',async()=>{
 const f=fixture();rejectPrimary(f,rate({kind:'long_window',code:6004,retry:1800}));assertRate(await failure(f),{kind:'long_window',source:'official_header'});f.calls.length=0;const e=await failure(f);assertRate(e,{kind:'long_window',source:'official_header'});assert.equal(e.upstreamCode,6004);assert.equal(e.rateLimitRetryable,false);assert.equal(f.calls.length,0);assert.equal(f.waits.length,0);
 const prepared=await f.router.relay.prepare(f.config.value.routes[0],f.config.value.routes[0].targets);assert.equal(prepared.blocked.length,1);assert.equal(prepared.blocked[0].status,429);assert.equal(prepared.blocked[0].errorCode,'provider_chat_rejected');assert.equal(prepared.blocked[0].target.upstreamId,'primary');
});
test('a tools mismatch cannot cover current or previous request rate limits',async()=>{
 const f=fixture({small:false});f.metadata.standby.tools=false;rejectPrimary(f,rate());assertRate(await failure(f));assertRate(await failure(f));assert.equal(f.calls.length,1);assert.equal(f.router.relay.cooldown({upstreamId:'standby',model}),null);
});
test('all cooling candidates retain429 and classified official wait instead of same_model_cooldown503',async()=>{
 const f=fixture();f.router.relay.failure(f.config.value.routes[0],{upstreamId:'primary',model},rate({kind:'long_window',code:6003,retry:3600}));f.router.relay.failure(f.config.value.routes[0],{upstreamId:'standby',model},rate({kind:'usage_limit',code:14015,retry:7200}));const e=await failure(f);assertRate(e,{kind:'long_window',source:'official_header'});assert.equal(e.upstreamCode,6003);assert.equal(f.calls.length,0);assert.equal(f.waits.length,0);
});
test('a legacy rate_limited row has truthful unknown429/local_default without automatic retry',async()=>{
 const f=fixture({single:true});f.state.set(key('primary'),{until:Date.now()+30000,reasonCode:'rate_limited'});const e=await failure(f);assertRate(e);assert.equal(e.rateLimitRetryable,false);assert.equal(f.calls.length,0);assert.equal(f.waits.length,0);
});
test('expired legacy rate cooldown admits a normal request and clears only that expired record',async()=>{
 const f=fixture({single:true}),raw=request();f.state.set(key('primary'),{until:Date.now()-1,reasonCode:'rate_limited'});assert.equal((await collectChat(f.router.chat(raw))).choices[0].message.content,'SAMPLE_COMPLETE');assert.equal(f.calls.length,1);assert.equal(f.state.get(key('primary')).until,0);unchanged(f,raw);
});
for(const [code,kind]of [[6003,'long_window'],[6004,'long_window'],[6007,'long_window'],[6008,'long_window'],[14015,'usage_limit'],[14018,'usage_limit'],[6000,'unknown']])test(`official code ${code} never becomes an automatic generation retry`,async()=>{
 const f=fixture({single:true});rejectPrimary(f,rate({kind,code,retry:5,retryable:true}));const e=await failure(f);assertRate(e,{kind,source:'official_header'});assert.equal(e.rateLimitRetryable,false);assert.equal(f.calls.length,1);assert.equal(f.waits.length,0);
});
test('Retry-After alone leaves an unknown429 unknown and never schedules a generation',async()=>{
 const f=fixture({single:true});rejectPrimary(f,rate({retry:17,retryable:true}));const e=await failure(f);assertRate(e,{source:'official_header'});assert.equal(e.rateLimitRetryable,false);assert.ok(e.retryAfterSeconds>=16&&e.retryAfterSeconds<=17);assert.equal(f.waits.length,0);
});
test('a forged transient flag without a known short-window code cannot trigger recovery',async()=>{
 const f=fixture({single:true});rejectPrimary(f,rate({kind:'transient',code:999999,retry:0,retryable:true}));const e=await failure(f);assertRate(e,{kind:'transient',source:'official_header'});assert.equal(e.rateLimitRetryable,false);assert.equal(f.waits.length,0);
});
test('official long waits are persisted unshortened, including the86400 second boundary',async()=>{
 const f=fixture({single:true}),started=Date.now();rejectPrimary(f,rate({kind:'long_window',code:6004,retry:86400}));const e=await failure(f);assertRate(e,{kind:'long_window',source:'official_header'});assert.equal(f.state.get(key('primary')).retryAfterSeconds,86400);assert.ok(f.state.get(key('primary')).until>=started+86400000);assert.equal(f.waits.length,0);
});
test('short-window code without official Retry-After has only local_default and does not guess a recovery',async()=>{
 const f=fixture({single:true});rejectPrimary(f,rate({kind:'transient',code:6001,retryable:true}));const e=await failure(f);assertRate(e,{kind:'transient'});assert.equal(f.waits.length,0);assert.equal(f.calls.length,1);
});
for(const [code,kind]of [[6004,'long_window'],[14015,'usage_limit']])test(`${kind} without official reset explicitly labels30 seconds as a local probe, not recovery`,async()=>{
 const f=fixture({single:true});rejectPrimary(f,rate({kind,code}));const e=await failure(f);assertRate(e,{kind});assert.equal(e.rateLimitRetryable,false);assert.equal(f.waits.length,0);assert.equal(f.state.get(key('primary')).retryAfterSeconds,30);
});
test('official Retry-After0 plus explicit transient code recovers exactly once and clears the matching circuit',async()=>{
 const f=fixture({single:true}),raw=request();rejectPrimary(f,rate({kind:'transient',code:6001,retry:0,retryable:true}),{thenSuccess:true});const result=await collectChat(f.router.chat(raw));assert.equal(result.choices[0].message.content,'SAMPLE_COMPLETE');assert.equal(f.calls.length,2);assert.equal(f.waits.length,1);assert.ok(f.waits[0]>=25);assert.equal(f.state.get(key('primary')).until,0);unchanged(f,raw);
});
test('production default delay really waits for Retry-After instead of using the test injector',async()=>{
 const f=fixture({single:true});f.router=new Router(f.config,f.platforms,{ledger:f.router.ledger,relayAttemptTimeoutMs:20,relayPrefillTimeoutMs:60});rejectPrimary(f,rate({kind:'transient',code:6001,retry:0,retryable:true}),{thenSuccess:true});const started=Date.now();await collectChat(f.router.chat(request()));assert.ok(Date.now()-started>=20);assert.equal(f.calls.length,2);assert.equal(f.state.get(key('primary')).until,0);
});
test('a compatible healthy standby completes before any short-window same-source recovery is considered',async()=>{
 const f=fixture({small:false}),raw=request();rejectPrimary(f,rate({kind:'transient',code:6001,retry:2,retryable:true}));await collectChat(f.router.chat(raw));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','standby']);assert.equal(f.waits.length,0);assert.equal(f.state.get(key('primary')).reasonCode,'rate_limited');unchanged(f,raw);
});
test('a current short-window rate limit recovers after an incompatible standby without trimming',async()=>{
 const f=fixture(),raw=request();rejectPrimary(f,rate({kind:'transient',code:6005,retry:2,retryable:true}),{thenSuccess:true});await collectChat(f.router.chat(raw));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary','primary']);assert.equal(f.waits.length,1);assert.ok(f.waits[0]>=1900&&f.waits[0]<=2025);assert.equal(f.rows.filter(r=>r.error?.code==='relay_context_incompatible').length,1);unchanged(f,raw);
});
test('a previous transient circuit can recover from the all-cooling branch with the original model/tools/budget',async()=>{
 const f=fixture({single:true}),raw=request();f.router.relay.failure(f.config.value.routes[0],{upstreamId:'primary',model},rate({kind:'transient',code:6002,retry:2,retryable:true}));await collectChat(f.router.chat(raw));assert.equal(f.calls.length,1);assert.equal(f.waits.length,1);assert.equal(f.state.get(key('primary')).until,0);unchanged(f,raw);
});
test('a second429 after recovery terminates without a second wait or extra generation',async()=>{
 const f=fixture({single:true});rejectPrimary(f,rate({kind:'transient',code:6006,retry:0,retryable:true}));const e=await failure(f);assertRate(e,{kind:'transient',source:'official_header'});assert.equal(f.calls.length,2);assert.equal(f.waits.length,1);
});
test('insufficient whole-request budget returns429 without starting an unfinishable wait',async()=>{
 const f=fixture({single:true,budget:1000});rejectPrimary(f,rate({kind:'transient',code:6001,retry:1,retryable:true}));const e=await failure(f);assertRate(e,{kind:'transient',source:'official_header'});assert.equal(f.waits.length,0);assert.equal(f.calls.length,1);
});
test('a transient official wait longer than the short-window policy is not shortened or replayed',async()=>{
 const f=fixture({single:true,budget:180000});rejectPrimary(f,rate({kind:'transient',code:6001,retry:61,retryable:true}));const e=await failure(f);assertRate(e,{kind:'transient',source:'official_header'});assert.ok(e.retryAfterSeconds>=60);assert.equal(f.waits.length,0);
});
test('cancellation before the request avoids catalog/chat/wait and persistent failures',async()=>{
 const f=fixture({single:true}),abort=new AbortController();abort.abort();const e=await failure(f,request(),abort.signal);assert.equal(e.code,'request_cancelled');assert.equal(e.status,499);assert.equal(f.calls.length,0);assert.equal(f.waits.length,0);assert.equal(f.state.size,0);
});
test('external cancellation during the bounded wait prevents all source recovery',async()=>{
 const abort=new AbortController(),f=fixture({single:true,delay:async()=>{abort.abort();throw new DOMException('SAMPLE abort','AbortError');}});rejectPrimary(f,rate({kind:'transient',code:6001,retry:1,retryable:true}));const e=await failure(f,request(),abort.signal);assert.equal(e.code,'request_cancelled');assert.equal(e.status,499);assert.equal(f.calls.length,1);assert.equal(f.waits.length,1);
});
test('whole-request timeout during a wait remains504 and never starts a new generation',async()=>{
 const abort=new AbortController(),f=fixture({single:true,delay:async()=>{abort.abort(new DOMException('SAMPLE deadline','TimeoutError'));throw abort.signal.reason;}});rejectPrimary(f,rate({kind:'transient',code:6001,retry:1,retryable:true}));const e=await failure(f,request(),abort.signal);assert.equal(e.code,'request_timeout');assert.equal(e.status,504);assert.equal(f.calls.length,1);
});
test('a fresh zero balance prevents recovery even when a transient rate circuit remains',async()=>{
 const f=fixture({single:true});f.router.relay.failure(f.config.value.routes[0],{upstreamId:'primary',model},rate({kind:'transient',code:6001,retry:1,retryable:true}));f.router.relay.balanceSource=()=>new Map([['primary',{value:0,unit:'积分',checkedAt:new Date().toISOString()}]]);assertRate(await failure(f),{kind:'transient',source:'official_header'});assert.equal(f.calls.length,0);assert.equal(f.waits.length,0);
});
test('a changed zero balance or manual disable during the wait wins over rate recovery',async()=>{
 for(const mode of ['balance','disabled']){let f;f=fixture({single:true,delay:async()=>{if(mode==='disabled')f.config.value.accounts[0].enabled=false;else f.router.relay.balanceSource=()=>new Map([['primary',{value:0,unit:'积分',checkedAt:new Date().toISOString()}]]);}});rejectPrimary(f,rate({kind:'transient',code:6001,retry:1,retryable:true}));assertRate(await failure(f),{kind:'transient',source:'official_header'});assert.equal(f.calls.length,1);assert.equal(f.waits.length,1);}
});
test('a concurrent newer rate circuit is neither shortened nor cleared by an earlier recovery',async()=>{
 let f;f=fixture({single:true,delay:async()=>{f.router.relay.failure(f.config.value.routes[0],{upstreamId:'primary',model},rate({kind:'long_window',code:6004,retry:3600}));}});rejectPrimary(f,rate({kind:'transient',code:6001,retry:1,retryable:true}));const e=await failure(f);assertRate(e,{kind:'long_window',source:'official_header'});assert.equal(e.upstreamCode,6004);assert.equal(f.calls.length,1);assert.equal(f.state.get(key('primary')).rateLimitKind,'long_window');
});
test('a new long-window circuit written during the final awaited balance prevents the queued recovery',async()=>{
 let afterWait=false,inserted;const f=fixture({single:true,delay:async()=>{afterWait=true;}});f.router.relay.balance=async()=>{if(afterWait){await Promise.resolve();f.router.relay.failure(f.config.value.routes[0],{upstreamId:'primary',model},rate({kind:'long_window',code:6004,retry:3600}));inserted=structuredClone(f.state.get(key('primary')));afterWait=false;}return {value:700,unit:'积分'};};rejectPrimary(f,rate({kind:'transient',code:6001,retry:1,retryable:true}));const e=await failure(f);assertRate(e,{kind:'long_window',source:'official_header'});assert.equal(e.upstreamCode,6004);assert.equal(f.calls.length,1);assert.equal(f.waits.length,1);assert.deepEqual(f.state.get(key('primary')),inserted);
});
test('a new long-window circuit written while the recovered cached catalog awaits blocks the actual chat attempt',async()=>{
 let afterWait=false,checks=0,reads=0,inserted;const f=fixture({single:true,delay:async()=>{afterWait=true;}}),target={upstreamId:'primary',model};
 const models=f.platforms.models;f.platforms.models=async id=>{reads++;return models(id);};
 const cooldown=f.router.relay.cooldown.bind(f.router.relay);
 f.router.relay.cooldown=t=>{const current=cooldown(t);if(afterWait&&++checks===2)queueMicrotask(()=>{f.router.relay.failure(f.config.value.routes[0],target,rate({kind:'long_window',code:6004,retry:3600}));inserted=structuredClone(f.state.get(key('primary')));});return current;};
 rejectPrimary(f,rate({kind:'transient',code:6001,retry:1,retryable:true}));const e=await failure(f);assertRate(e,{kind:'long_window',source:'official_header'});assert.equal(e.upstreamCode,6004);assert.equal(reads,1);assert.equal(f.calls.length,1);assert.equal(f.waits.length,1);assert.deepEqual(f.state.get(key('primary')),inserted);
});
test('successful recovery cannot clear a newer concurrent circuit written before delivery',async()=>{
 const f=fixture({single:true});const normal=f.platforms.chat;let n=0;f.platforms.chat=async(t,r,s)=>{if(!n++){f.calls.push({target:t,request:r,hash:digest(r)});throw rate({kind:'transient',code:6001,retry:0,retryable:true});}f.router.relay.failure(f.config.value.routes[0],t,rate({kind:'long_window',code:6004,retry:3600}));return normal(t,r,s);};await collectChat(f.router.chat(request()));assert.equal(f.state.get(key('primary')).rateLimitKind,'long_window');assert.ok(f.state.get(key('primary')).until>Date.now()+3500000);
});
test('rate failure does not cross the dedicated WB partition or silently substitute the-sg model',async()=>{
 const f=fixture({extra:true}),raw=request();rejectPrimary(f,rate());assertRate(await failure(f,raw));assert.deepEqual(f.calls.map(c=>c.target.upstreamId),['primary']);assert.equal(f.calls.some(c=>c.target.model.endsWith('-sg')),false);assert.equal(f.state.has(key('wb')),false);unchanged(f,raw);
});
test('authentication401 remains distinct and never schedules a rate-limit wait',async()=>{
 const f=fixture({single:true});rejectPrimary(f,new AppError('SAMPLE authentication rejected',401,'provider_chat_rejected'));const e=await failure(f);assert.equal(e.status,401);assert.equal(e.code,'provider_chat_rejected');assert.equal(e.rateLimitKind,undefined);assert.equal(f.waits.length,0);assert.equal(f.state.get(key('primary')).reasonCode,'authentication_unavailable');
});
test('a zero balance without a rate circuit stays402 and never calls an upstream',async()=>{
 const f=fixture({single:true});f.router.relay.balanceSource=()=>new Map([['primary',{value:0,unit:'积分',checkedAt:new Date().toISOString()}]]);const e=await failure(f);assert.equal(e.status,402);assert.equal(e.code,'same_model_credits_exhausted');assert.equal(f.calls.length,0);assert.equal(f.waits.length,0);
});
test('audit mode keeps the original429 and never writes relay cooldowns or auto-recovers',async()=>{
 const f=fixture({single:true});rejectPrimary(f,rate({kind:'transient',code:6001,retry:0,retryable:true}));await assert.rejects(collectChat(f.router.chat(request(),undefined,{source:'audit'})),e=>e.status===429&&e.code==='provider_chat_rejected');assert.equal(f.state.size,0);assert.equal(f.waits.length,0);
});
