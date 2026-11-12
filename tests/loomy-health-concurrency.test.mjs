import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loomyHealth,loomyHealthProbeBudget} from '../src/provider-loomy.mjs';
const SECRET={accessToken:'offline-health-fixture',principal:'offline-health-fixture'};
const ok=data=>Response.json({code:'000000',data});
test('health reads the official endpoints strictly in series with the balance read first',async()=>{
 const started=[];const fetchImpl=async(url,init)=>{assert.equal(init.method,'GET');const p=new URL(url).pathname;started.push(p);return p.includes('/points/records')?ok({availableBalance:10000,balance:5000,dailyBalance:5000}):p.endsWith('/models')?ok([]):ok({});};
 const h=await loomyHealth(SECRET,{fetchImpl});assert.deepEqual(started,['/api/v1/points/records','/api/v1/pet-work','/api/v1/user/identity','/api/v1/models']);assert.equal(loomyHealthProbeBudget(8000),8000);assert.equal(loomyHealthProbeBudget(20000),20000);assert.equal(loomyHealthProbeBudget(8000,30000),8000);assert.equal(h.balance.value,10000);assert.equal(h.status,'authenticated');assert.equal(h.balanceError,undefined);
});
test('a transient 900000 on the balance read is retried once and the retry is what gets reported',{timeout:10000},async()=>{
 let calls=0;const fetchImpl=async(url)=>{const p=new URL(url).pathname;if(p.includes('/points/records')){calls++;if(calls===1)return Response.json({code:'900000',desc:'系统内部错误',data:{}});return ok({availableBalance:8528,balance:3528,dailyBalance:5000});}return ok({});};
 const h=await loomyHealth(SECRET,{fetchImpl});assert.equal(calls,2);assert.equal(h.balance.value,8528);assert.equal(h.balanceError,undefined);assert.equal(h.status,'authenticated');
});
test('a persistent 900000 is reported as an upstream business error after exactly one retry',{timeout:10000},async()=>{
 let calls=0;const fetchImpl=async(url)=>{const p=new URL(url).pathname;if(p.includes('/points/records')){calls++;return Response.json({code:'900000',desc:'系统内部错误',data:{}});}return ok({});};
 const h=await loomyHealth(SECRET,{fetchImpl});assert.equal(calls,2);assert.equal(h.balance.value,null);assert.equal(h.balanceError.code,'loomy_business_error');assert.match(h.balanceError.message,/900000/);
});
test('health respects shorter caller budget and cancellation without successful pet balance fallback',async(t)=>{
 const controller=new AbortController();controller.abort();
 const h=await loomyHealth(SECRET,{timeoutMs:23,signal:controller.signal,fetchImpl:async(url,init)=>{assert.equal(init.signal.aborted,true);throw new DOMException('fixture caller cancelled','AbortError');}});assert.equal(loomyHealthProbeBudget(8000,23),23);assert.equal(loomyHealthProbeBudget(20000,23),23);assert.equal(h.balance.value,null);assert.equal(h.balanceError.code,'request_cancelled');assert.equal(h.modelsError.code,'request_cancelled');assert.equal(h.checkin.known,false);
});
test('health points stays fresh when independent metadata probes fail; main failure is retained separately',async()=>{
 const h=await loomyHealth(SECRET,{fetchImpl:async(url)=>url.includes('/points/records')?ok({availableBalance:0,balance:0,dailyBalance:0}):Promise.reject(Error('auxiliary unavailable'))});assert.equal(h.balance.value,0);assert.equal(h.status,'authenticated');assert.equal(h.balanceError,undefined);assert.ok(h.modelsError);assert.equal(h.checkin.known,false);assert.equal(h.capabilities.inference,undefined);
});

test('health enforces shortened deadlines on all in-flight probes and records critical balance timeout',{timeout:2000},async()=>{
 let started=0,cancelled=0;const h=await loomyHealth(SECRET,{timeoutMs:12,fetchImpl:async(_url,{signal})=>{started++;return new Promise((resolve,reject)=>{const abort=()=>{cancelled++;reject(new DOMException('fixture deadline','AbortError'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});}});assert.equal(started,4);assert.equal(cancelled,4);assert.equal(h.balance.value,null);assert.equal(h.balanceError.code,'request_cancelled');assert.equal(h.modelsError.code,'request_cancelled');
});
