import test from 'node:test';
import assert from 'node:assert/strict';
import {Scheduler} from '../src/scheduler.mjs';

function fixture({at='2026-10-20T04:00:01Z',hour=0,retryMinutes=60,startup=false,enabled=true,accounts=['a','b'],all}={}) {
  const RealDate=globalThis.Date;let now=RealDate.parse(at);
  class ClockDate extends RealDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  globalThis.Date=ClockDate;
  const config={value:{scheduler:{enabled,startup,timezone:'Asia/Shanghai',hour,minute:0,jitterSeconds:0,retryMinutes},accounts:accounts.map(id=>({id,platform:'SAMPLE',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}))}};
  const ledger={values:new Map(),get(key){return this.values.get(key)},set(key,value){this.values.set(key,structuredClone(value));}};
  const calls=[],claims={all:async options=>{calls.push(options===undefined?null:structuredClone(options));return all?all(options,calls.length):config.value.accounts.map(a=>({accountId:a.id,task:'daily-checkin',status:'success'}));}};
  const scheduler=new Scheduler(config,claims,ledger);scheduler.stopped=false;
  return {scheduler,config,ledger,calls,now:()=>now,advance(ms){now+=ms},setAt(value){now=RealDate.parse(value)},async close(){await scheduler.stop();globalThis.Date=RealDate;}};
}
const row=(accountId,status,more={})=>({accountId,task:'daily-checkin',status,...more});

test('per-task retry starts after one minute and does not touch a successful account',async()=>{
  const f=fixture({all:async(_options,n)=>n===1?[row('a','error'),row('b','success')]:[row('a','success')]});
  try {await f.scheduler.tick();assert.equal(f.calls.length,1);f.advance(59999);await f.scheduler.tick();assert.equal(f.calls.length,1);f.advance(1);await f.scheduler.tick();assert.deepEqual(f.calls[1],{tasks:[{accountId:'a',task:'daily-checkin'}]});assert.equal(f.ledger.get('schedule-last').complete,true);}
  finally{await f.close();}
});

test('retry state survives scheduler restart and uses 1/5/15/60 minute bounded backoff',async()=>{
  const f=fixture({accounts:['a'],all:async()=>[row('a','error')]});
  try {await f.scheduler.tick();for(const [attempt,minutes] of [[1,1],[2,5],[3,15],[4,60],[5,60]]){const state=f.ledger.get('schedule-last').tasks[0];assert.equal(state.attempt,attempt);assert.equal(state.retryDue-f.now(),minutes*60000);const next=new Scheduler(f.config,f.scheduler.claims,f.ledger);next.stopped=false;f.advance(minutes*60000-1);await next.tick();assert.equal(f.calls.length,attempt);f.advance(1);await next.tick();assert.equal(f.calls.length,attempt+1);await next.stop();}}
  finally{await f.close();}
});

test('configured retryMinutes caps the exponential delay without an immediate retry',async()=>{
  const f=fixture({accounts:['a'],retryMinutes:2,all:async()=>[row('a','error')]});
  try {await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();assert.equal(f.ledger.get('schedule-last').tasks[0].retryDue-f.now(),120000);}
  finally{await f.close();}
});

test('an explicit upstream retryAt is respected even beyond the configured retry cap',async()=>{
  let retryAt;const f=fixture({accounts:['a'],retryMinutes:2,all:async()=>[row('a','error',{retryAt})]});
  try {retryAt=new Date(f.now()+90*60000).toISOString();await f.scheduler.tick();assert.equal(f.ledger.get('schedule-last').tasks[0].retryDue,Date.parse(retryAt));f.advance(89*60000);await f.scheduler.tick();assert.equal(f.calls.length,1);f.advance(60000);await f.scheduler.tick();assert.equal(f.calls.length,2);}
  finally{await f.close();}
});

test('explicit login-required errors use low-frequency credential reconciliation, not transport retry bursts',async()=>{
  const f=fixture({accounts:['a'],all:async()=>[row('a','error',{loginRequired:true,reason:'login_required'})]});
  try {await f.scheduler.tick();const s=f.ledger.get('schedule-last').tasks[0];assert.equal(s.retryDue-f.now(),3600000);assert.equal(s.loginRequired,true);f.advance(60000);await f.scheduler.tick();assert.equal(f.calls.length,1);}
  finally{await f.close();}
});

for(const status of ['not_available','device_occupied','rejected','action_required'])test(`${status} stays due for low-frequency reconciliation instead of finishing the whole day`,async()=>{
  const f=fixture({accounts:['a'],all:async(_options,n)=>[row('a',n===1?status:'already')]});
  try {await f.scheduler.tick();assert.equal(f.ledger.get('schedule-last').complete,false);assert.equal(f.ledger.get('schedule-last').tasks[0].retryDue-f.now(),3600000);f.advance(3599999);await f.scheduler.tick();assert.equal(f.calls.length,1);f.advance(1);await f.scheduler.tick();assert.equal(f.calls.length,2);assert.equal(f.ledger.get('schedule-last').complete,true);}
  finally{await f.close();}
});

test('uncertain result schedules only the unresolved task for confirmation',async()=>{
  const f=fixture({all:async(_options,n)=>n===1?[row('a','uncertain'),row('b','success')]:[row('a','already')]});
  try {await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();assert.deepEqual(f.calls[1],{tasks:[{accountId:'a',task:'daily-checkin'}]});assert.equal(f.ledger.get('schedule-last').tasks.find(r=>r.accountId==='b').status,'success');}
  finally{await f.close();}
});

test('startup result is persisted and a failure is not immediately submitted a second time',async()=>{
  const f=fixture({accounts:['a'],startup:true,all:async()=>[row('a','error')]});
  try {f.scheduler.stopped=true;f.scheduler.start();await Promise.all([...f.scheduler.jobs]);assert.equal(f.calls.length,1);assert.equal(f.ledger.get('schedule-last').tasks[0].attempt,1);assert.equal(f.ledger.get('schedule-last').source,'startup');}
  finally{await f.close();}
});

test('startup remains independent of the daily schedule enabled switch',async()=>{
  const f=fixture({accounts:['a'],startup:true,enabled:false});
  try {f.scheduler.stopped=true;f.scheduler.start();await Promise.all([...f.scheduler.jobs]);assert.equal(f.calls.length,1);assert.equal(f.ledger.get('schedule-last').source,'startup');f.advance(60000);await f.scheduler.tick();assert.equal(f.calls.length,1);}
  finally{await f.close();}
});

test('an explicit provider window at 10:00 bypasses a daily noon gate without skipping other noon tasks',async()=>{
  const f=fixture({at:'2026-10-19T04:00:01Z',hour:12,all:async(options,n)=>n===1?[row('a','already',{nextClaimAt:'2026-10-20T02:00:00Z'}),row('b','success')]:n===2?[row('a','success',{nextClaimAt:'2026-10-21T02:00:00Z'})]:[row('b','success')]});
  try {await f.scheduler.tick();f.setAt('2026-10-20T01:59:59Z');await f.scheduler.tick();assert.equal(f.calls.length,1);f.advance(1000);await f.scheduler.tick();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],{tasks:[{accountId:'a',task:'daily-checkin'}]});f.setAt('2026-10-20T04:00:01Z');await f.scheduler.tick();assert.equal(f.calls.length,3);assert.deepEqual(f.calls[2],{tasks:[{accountId:'b',task:'daily-checkin'}]});}
  finally{await f.close();}
});

test('sleep and wake catches an overdue retry before the next daily gate',async()=>{
  const f=fixture({at:'2026-10-19T04:00:01Z',hour:12,accounts:['a'],all:async(_options,n)=>[row('a',n===1?'error':'success')]});
  try {await f.scheduler.tick();f.setAt('2026-10-20T01:00:00Z');await f.scheduler.tick();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],{tasks:[{accountId:'a',task:'daily-checkin'}]});}
  finally{await f.close();}
});

test('a disabled account is removed from persisted retries and inference pause is ignored',async()=>{
  const f=fixture({all:async(_options,n)=>n===1?[row('a','error'),row('b','error')]:[row('b','success')]});
  try {await f.scheduler.tick();f.config.value.accounts[0].enabled=false;f.config.value.accounts[1].inferenceEnabled=false;f.advance(60000);await f.scheduler.tick();assert.deepEqual(f.calls[1],{tasks:[{accountId:'b',task:'daily-checkin'}]});assert.deepEqual(f.ledger.get('schedule-last').tasks.map(r=>r.accountId),['b']);}
  finally{await f.close();}
});

test('legacy schedule-last errors receive a persisted due time and recover selectively',async()=>{
  const f=fixture({all:async()=>[row('a','success')]});
  try {await f.scheduler.tick();const last=f.ledger.get('schedule-last');delete last.tasks;delete last.schemaVersion;last.complete=false;last.at=f.now()-3600001;last.results=[row('a','error'),row('b','success')];f.ledger.set('schedule-last',last);await f.scheduler.tick();assert.deepEqual(f.calls[1],{tasks:[{accountId:'a',task:'daily-checkin'}]});assert.equal(f.ledger.get('schedule-last').schemaVersion,2);}
  finally{await f.close();}
});

test('a rejected claim batch is persisted with backoff rather than retried on every thirty-second tick',async()=>{
  const f=fixture({accounts:['a'],all:async()=>{throw Object.assign(Error('SAMPLE batch failure'),{code:'SAMPLE_batch_failed'});}});
  try {await f.scheduler.tick();assert.equal(f.ledger.get('schedule-last').tasks[0].status,'error');f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,1);f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,2);}
  finally{await f.close();}
});

test('startup does not silently complete an account omitted from a partial batch',async()=>{
  const f=fixture({startup:true,all:async()=>[row('a','success')]});
  try {f.scheduler.stopped=true;f.scheduler.start();await Promise.all([...f.scheduler.jobs]);const missing=f.ledger.get('schedule-last').tasks.find(r=>r.accountId==='b');assert.equal(missing.status,'error');assert.equal(missing.reason,'checkin_batch_missing_result');assert.equal(f.ledger.get('schedule-last').complete,false);}
  finally{await f.close();}
});

test('a batch crossing midnight retains the receipt day and does not recheck that account at noon',async()=>{
  let f;f=fixture({at:'2026-10-19T15:59:59Z',hour:12,accounts:['a'],all:async()=>{f.setAt('2026-10-19T16:00:01Z');return [row('a','success',{day:'2026-10-20'})];}});
  try {await f.scheduler.tick();assert.equal(f.ledger.get('schedule-last').tasks[0].day,'2026-10-20');f.setAt('2026-10-20T04:00:01Z');await f.scheduler.tick();assert.equal(f.calls.length,1);assert.equal(f.ledger.get('schedule-last').dailyDay,'2026-10-20');}
  finally{await f.close();}
});

test('a task disabled while its batch is in flight is not restored as a pending retry',async()=>{
  let f;f=fixture({all:async(_options,n)=>{if(n===1)return [row('a','error'),row('b','error')];f.config.value.accounts[0].enabled=false;return [row('a','error'),row('b','success')];}});
  try {await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();assert.deepEqual(f.ledger.get('schedule-last').tasks.map(r=>r.accountId),['b']);assert.equal(f.ledger.get('schedule-last').complete,true);}
  finally{await f.close();}
});
