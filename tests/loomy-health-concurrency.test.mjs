import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loomyHealth,loomyHealthProbeBudget} from '../src/provider-loomy.mjs';
const SECRET={accessToken:'offline-health-fixture',principal:'offline-health-fixture'};
const ok=data=>Response.json({code:'000000',data});
test('health starts all four independent GET probes concurrently with fixed 20s/8s budgets',async(t)=>{
 
 const started=[],waiting=[];const fetchImpl=async(url,init)=>{assert.equal(init.method,'GET');started.push(new URL(url).pathname);await new Promise(resolve=>{waiting.push(resolve);if(waiting.length===4)for(const done of waiting)done();});return url.includes('/points/records')?ok({availableBalance:10000,balance:5000,dailyBalance:5000}):url.endsWith('/models')?ok([]):ok({});};
 const h=await loomyHealth(SECRET,{fetchImpl});assert.equal(started.length,4);assert.equal(loomyHealthProbeBudget(8000),8000);assert.equal(loomyHealthProbeBudget(20000),20000);assert.equal(loomyHealthProbeBudget(8000,30000),8000);assert.equal(h.balance.value,10000);assert.equal(h.status,'authenticated');assert.equal(h.balanceError,undefined);
});
test('health respects shorter caller budget and cancellation without successful pet balance fallback',async(t)=>{
 const controller=new AbortController();controller.abort();
 const h=await loomyHealth(SECRET,{timeoutMs:23,signal:controller.signal,fetchImpl:async(url,init)=>{assert.equal(init.signal.aborted,true);throw new DOMException('fixture caller cancelled','AbortError');}});assert.equal(loomyHealthProbeBudget(8000,23),23);assert.equal(loomyHealthProbeBudget(20000,23),23);assert.equal(h.balance.value,null);assert.equal(h.balanceError.code,'request_cancelled');assert.equal(h.modelsError.code,'request_cancelled');assert.equal(h.checkin.known,false);
});
test('health points stays fresh when independent metadata probes fail; main failure is retained separately',async()=>{
 const h=await loomyHealth(SECRET,{fetchImpl:async(url)=>url.includes('/points/records')?ok({availableBalance:0,balance:0,dailyBalance:0}):Promise.reject(Error('auxiliary unavailable'))});assert.equal(h.balance.value,0);assert.equal(h.status,'authenticated');assert.equal(h.balanceError,undefined);assert.ok(h.modelsError);assert.equal(h.checkin.known,false);assert.equal(h.capabilities.inference,false);
});

test('health enforces shortened deadlines on all in-flight probes and records critical balance timeout',{timeout:2000},async()=>{
 let started=0,cancelled=0;const h=await loomyHealth(SECRET,{timeoutMs:12,fetchImpl:async(_url,{signal})=>{started++;return new Promise((resolve,reject)=>{const abort=()=>{cancelled++;reject(new DOMException('fixture deadline','AbortError'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});}});assert.equal(started,4);assert.equal(cancelled,4);assert.equal(h.balance.value,null);assert.equal(h.balanceError.code,'request_cancelled');assert.equal(h.modelsError.code,'request_cancelled');
});
