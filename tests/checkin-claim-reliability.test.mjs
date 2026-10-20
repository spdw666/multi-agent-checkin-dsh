import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {ClaimService}=await import(pathToFileURL(resolve(root,'src/claims.mjs')));
const {Ledger}=await import(pathToFileURL(resolve(root,'src/store.mjs')));
const {dayIn}=await import(pathToFileURL(resolve(root,'src/util.mjs')));
async function fixture(t,platform='workbuddy'){
  const dir=await mkdtemp(join(tmpdir(),'checkin-reliability-')),ledger=new Ledger(dir);
  t.after(async()=>{ledger.close();await rm(dir,{recursive:true,force:true});});
  const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform,enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}]}};
  const credentials={resolve:async()=>({principalHash:'SAMPLE'})};
  const key=ledger.claimKey(platform,'SAMPLE',dayIn(),'daily-checkin','');
  return {ledger,config,credentials,key,service:p=>new ClaimService(config,credentials,p,ledger)};
}
test('crash in explicit preparing phase can recover and submit exactly once',async t=>{
  const f=await fixture(t);f.ledger.reserve(f.key,Date.now()-360000,{preparing:true});let posts=0;
  const s=f.service({status:async()=>({known:true,active:true,claimed:posts>0}),claim:async()=>{posts++;return {credit:1};}});
  assert.equal((await s.run('a')).status,'success');assert.equal(posts,1);
});
test('legacy running and submitted phases remain non-replayable',async t=>{
  for(const legacy of [true,false]){
    const f=await fixture(t);const r=f.ledger.reserve(f.key,Date.now()-360000,{preparing:!legacy});
    if(!legacy){f.ledger.markSubmitted(f.key,r.reservationId);f.ledger.db.prepare('UPDATE claims SET updated_at=? WHERE key=?').run(new Date(Date.now()-360000).toISOString(),f.key);}
    let posts=0;const s=f.service({status:async()=>({known:true,active:true,claimed:false}),claim:async()=>{posts++;}});
    assert.equal((await s.run('a')).status,'uncertain');assert.equal(posts,0);
  }
});
test('lost lease cannot mark submitted or overwrite newer worker result',async t=>{
  const f=await fixture(t),a=f.ledger.reserve(f.key,Date.now()-360000,{preparing:true}),b=f.ledger.reserve(f.key,Date.now(),{preparing:true});
  assert.notEqual(a.reservationId,b.reservationId);assert.equal(f.ledger.markSubmitted(f.key,a.reservationId),false);
  assert.equal(f.ledger.finish(f.key,'error',{},a.reservationId),false);assert.equal(f.ledger.claimReceipt(f.key).status,'running');
});
test('uncertain submission remains fenced when official status throws then recovers',async t=>{
  const f=await fixture(t);f.ledger.reserve(f.key);f.ledger.finish(f.key,'uncertain',{});let fail=true,posts=0;
  const s=f.service({status:async()=>{if(fail)throw new Error('read timeout');return {known:true,active:true,claimed:false};},claim:async()=>{posts++;}});
  assert.equal((await s.run('a')).status,'uncertain');fail=false;
  assert.equal((await s.run('a')).status,'uncertain');assert.equal(posts,0);
});
test('uncertain submission stays fenced through unknown or inactive server state',async t=>{
  for(const before of [{known:false},{known:true,active:false,claimed:false}]){
    const f=await fixture(t);f.ledger.reserve(f.key);f.ledger.finish(f.key,'uncertain',{});let posts=0;
    const s=f.service({status:async()=>before,claim:async()=>{posts++;}});
    assert.equal((await s.run('a')).status,'uncertain');assert.equal(f.ledger.claimReceipt(f.key).status,'uncertain');assert.equal(posts,0);
  }
});
test('delayed official confirmation settles with one POST and bounded GETs',async t=>{
  const f=await fixture(t);let posts=0,reads=0;
  const s=f.service({status:async()=>({known:true,active:true,claimed:++reads>=3}),claim:async()=>{posts++;return {credit:7};}});
  const r=await s.run('a');assert.equal(r.status,'success');assert.equal(r.serverConfirmed,true);assert.equal(posts,1);assert.equal(reads,3);
});
test('lost POST response is reconciled using fresh official state, not resubmitted',async t=>{
  const f=await fixture(t);let posts=0;
  const s=f.service({status:async()=>({known:true,active:true,claimed:posts>0}),claim:async()=>{posts++;throw new Error('response lost');}});
  const r=await s.run('a');assert.equal(r.status,'success');assert.equal(r.reconciledAfterError,true);assert.equal(posts,1);
});
test('read-after-write error can recover without poisoning claim receipt',async t=>{
  const f=await fixture(t);let posts=0,reads=0;
  const s=f.service({status:async()=>{if(++reads===2)throw new Error('GET reset');return {known:true,active:true,claimed:posts>0};},claim:async()=>{posts++;return {credit:7};}});
  assert.equal((await s.run('a')).status,'success');assert.equal(posts,1);assert.equal(reads,3);
});
test('unknown or truthy-but-nonboolean claimed state is never success',async t=>{
  for(const after of [{known:false,claimed:true},{known:true,claimed:'true'}]){
    const f=await fixture(t);let posts=0;
    const s=f.service({status:async()=>posts?after:{known:true,active:true,claimed:false},claim:async()=>{posts++;return {credit:1};}});
    assert.equal((await s.run('a')).status,'uncertain');assert.equal(posts,1);
  }
});
test('local success receipt cannot conceal a fresh 401 or cause another POST',async t=>{
  const f=await fixture(t);f.ledger.reserve(f.key);f.ledger.finish(f.key,'success',{serverConfirmed:true});let posts=0;
  const s=f.service({status:async()=>{throw Object.assign(new Error('expired'),{status:401,code:'credential_expired'});},claim:async()=>{posts++;}});
  const r=await s.run('a');assert.equal(r.status,'error');assert.equal(r.error.status,401);assert.equal(r.loginRequired,true);assert.equal(posts,0);assert.equal(f.ledger.claimReceipt(f.key).status,'success');
});
test('local success conflicting with official not-claimed is exposed, never replayed',async t=>{
  const f=await fixture(t);f.ledger.reserve(f.key);f.ledger.finish(f.key,'success',{serverConfirmed:true});let posts=0;
  const s=f.service({status:async()=>({known:true,active:true,claimed:false}),claim:async()=>{posts++;}});
  const r=await s.run('a');assert.equal(r.status,'uncertain');assert.equal(r.serverConfirmed,false);assert.equal(posts,0);
});
test('explicit before-submission temporary refusal remains retryable and keeps retryAt',async t=>{
  const f=await fixture(t);let posts=0;const retryAt=Date.now()+60000;
  const s=f.service({status:async()=>({known:true,active:true,claimed:posts>1}),claim:async()=>{if(++posts===1)throw Object.assign(new Error('busy'),{beforeSubmission:true,retryAt,code:'temporarily_busy'});return {credit:1};}});
  const a=await s.run('a');assert.equal(a.status,'error');assert.equal(a.retryAt,retryAt);assert.equal((await s.run('a')).status,'success');assert.equal(posts,2);
});
test('all tasks filter selects only requested account/task and preserves inference-disabled eligibility',async t=>{
  const f=await fixture(t);f.config.value.accounts[0].inferenceEnabled=false;f.config.value.accounts.push({id:'b',platform:'workbuddy',tasks:[{id:'daily-checkin',enabled:true}]});
  const calls=[];const s=f.service({status:async id=>{calls.push(id);return {known:true,active:true,claimed:true};},claim:async()=>{throw Error('unexpected');}});
  const result=await s.all({tasks:[{accountId:'a',task:'daily-checkin'}]});assert.equal(result.length,1);assert.deepEqual(calls,['a']);
});
