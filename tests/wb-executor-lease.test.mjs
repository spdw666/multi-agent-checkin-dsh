import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {Ledger} from '../src/store.mjs';
import {hash} from '../src/util.mjs';
import {withWorkBuddyExecutorLease} from '../src/workbuddy-executor-lease.mjs';

const key='SAMPLE-ACCOUNT:SAMPLE-TASK',metaKey='workbuddy.executor.lease:'+hash(key);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'SAMPLE-wb-lease-')),a=new Ledger(directory),b=new Ledger(directory);let closedA=false,closedB=false;
 t.after(async()=>{if(!closedA)a.close();if(!closedB)b.close();const rel=relative(resolve(tmpdir()),resolve(directory));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&basename(directory).startsWith('SAMPLE-wb-lease-'));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{a,b,serviceA:{ledger:a},serviceB:{ledger:b},closeA(){a.close();closedA=true;},closeB(){b.close();closedB=true;}};
}
const read=ledger=>ledger.get(metaKey);

test('two real Ledger instances sharing one database admit exactly one owner',async t=>{
 const f=await fixture(t),gate=deferred();let callbackCount=0;
 const first=withWorkBuddyExecutorLease(f.serviceA,key,async assertOwned=>{callbackCount++;assertOwned();await gate.promise;assertOwned();return 'SAMPLE-DONE';});
 const lease=read(f.b);assert.match(lease.owner,/^[0-9a-f-]{36}$/);assert.ok(lease.expiresAt>Date.now()+119000);
 await assert.rejects(withWorkBuddyExecutorLease(f.serviceB,key,()=>{callbackCount++;}),{code:'wb_executor_busy'});assert.equal(callbackCount,1);
 gate.resolve();assert.equal(await first,'SAMPLE-DONE');assert.equal(read(f.b),undefined);
 assert.equal(await withWorkBuddyExecutorLease(f.serviceB,key,()=>42),42);
});
test('an expired lease is recovered atomically and a live successor is not removed by the old owner',async t=>{
 const f=await fixture(t),gate=deferred(),secondGate=deferred();let oldGuard;
 const first=withWorkBuddyExecutorLease(f.serviceA,key,async guard=>{oldGuard=guard;await gate.promise;});first.catch(()=>{});
 const old=read(f.a);f.b.set(metaKey,{...old,expiresAt:Date.now()-1});
 const second=withWorkBuddyExecutorLease(f.serviceB,key,async guard=>{guard();await secondGate.promise;});
 const successor=read(f.b);assert.notEqual(successor.owner,old.owner);assert.throws(oldGuard,{code:'wb_executor_lease_lost'});
 gate.resolve();await assert.rejects(first,{code:'wb_executor_lease_lost'});assert.equal(read(f.a).owner,successor.owner);
 secondGate.resolve();await second;assert.equal(read(f.a),undefined);
});
test('synchronous assertOwned rejects an expired owner before heartbeat and remains lost',async t=>{
 const f=await fixture(t);
 await assert.rejects(withWorkBuddyExecutorLease(f.serviceA,key,async guard=>{const lease=read(f.a);f.b.set(metaKey,{...lease,expiresAt:Date.now()-1});assert.throws(guard,{code:'wb_executor_lease_lost'});f.b.set(metaKey,{...lease,expiresAt:Date.now()+120000});guard();}),{code:'wb_executor_lease_lost'});
 assert.equal(read(f.b),undefined);
});
test('callback errors and cancellation release only their own lease',async t=>{
 const f=await fixture(t),failure=Error('SAMPLE callback failure');
 await assert.rejects(withWorkBuddyExecutorLease(f.serviceA,key,()=>{throw failure;}),e=>e===failure);assert.equal(read(f.b),undefined);
 const controller=new AbortController(),cancel=Error('SAMPLE cancellation');
 await assert.rejects(withWorkBuddyExecutorLease(f.serviceA,key,async guard=>{guard();controller.abort(cancel);controller.signal.throwIfAborted();}),e=>e===cancel);assert.equal(read(f.b),undefined);
});
test('heartbeat extends a live lease at 15 seconds and stops after release',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setInterval','Date'],now:2000000});
 const gate=deferred();let guard;
 const active=withWorkBuddyExecutorLease(f.serviceA,key,async owned=>{guard=owned;await gate.promise;});
 assert.equal(read(f.a).expiresAt,2120000);t.mock.timers.tick(15000);assert.equal(read(f.b).expiresAt,2135000);guard();
 t.mock.timers.tick(105000);guard();assert.equal(read(f.b).expiresAt,2240000);
 gate.resolve();await active;assert.equal(read(f.a),undefined);t.mock.timers.tick(300000);assert.equal(read(f.a),undefined);
 assert.throws(guard,{code:'wb_executor_lease_lost'});
});
test('heartbeat loses ownership on replacement and never overwrites a successor',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setInterval','Date'],now:3000000});const gate=deferred();let guard;
 const active=withWorkBuddyExecutorLease(f.serviceA,key,async owned=>{guard=owned;await gate.promise;});active.catch(()=>{});
 const successor={version:1,owner:'SAMPLE-SUCCESSOR',expiresAt:3999999};f.b.set(metaKey,successor);t.mock.timers.tick(15000);
 assert.throws(guard,{code:'wb_executor_lease_lost'});assert.deepEqual(read(f.b),successor);gate.resolve();await assert.rejects(active,{code:'wb_executor_lease_lost'});assert.deepEqual(read(f.b),successor);
});
test('database closure fails the guard and finally cleans the heartbeat without masking loss',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setInterval','Date'],now:4000000});
 await assert.rejects(withWorkBuddyExecutorLease(f.serviceA,key,async guard=>{f.closeA();assert.throws(guard,{code:'wb_executor_lease_lost'});}),{code:'wb_executor_lease_lost'});
 t.mock.timers.tick(300000);assert.equal(read(f.b).owner.length,36);
});
test('Map/no-db fixtures call work directly without reading or writing fixture storage',async()=>{
 const map=new Map(),service={ledger:{get(){throw Error('SAMPLE no reads');},set(){throw Error('SAMPLE no writes');}}};
 assert.equal(await withWorkBuddyExecutorLease(service,key,guard=>{guard();return 'SAMPLE';}),'SAMPLE');assert.equal(map.size,0);
});
test('a busy acquisition does not invoke work or roll back another connection transaction',async t=>{
 const f=await fixture(t);f.b.db.exec('PRAGMA busy_timeout=0');f.a.db.exec('BEGIN IMMEDIATE');let calls=0;
 try{await assert.rejects(withWorkBuddyExecutorLease(f.serviceB,key,()=>{calls++;}),{code:'wb_executor_busy'});assert.equal(calls,0);f.a.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('SAMPLE-UNRELATED','1');f.a.db.exec('COMMIT');}
 catch(error){try{f.a.db.exec('ROLLBACK');}catch{}throw error;}
 assert.equal(f.b.get('SAMPLE-UNRELATED'),1);assert.equal(read(f.a),undefined);
});
