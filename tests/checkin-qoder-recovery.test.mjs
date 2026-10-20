import test from 'node:test';
import assert from 'node:assert/strict';
import {readQoderNativeIdentity} from '../src/provider-qoder.mjs';

const native={machineToken:'fixture-native-token',machineCode:'fixture-native-code',machineType:'native'};
const success=()=>({status:0,stdout:JSON.stringify(native)});
const options=(spawnImpl,now=1000)=>({spawnImpl,now,authMtimeMs:1});
function assertLocal(error,kind,{actionRequired=false}={}){
  assert.equal(error.code,'provider_identity_missing');assert.equal(error.status,503);
  assert.equal(error.retryable,true);assert.equal(error.beforeSubmission,true);
  assert.equal(error.identityReadFailure,kind);assert.equal(error.actionRequired===true,actionRequired);
  assert.equal(error.message,`Qoder本机身份读取暂不可用 (${kind})`);
  const diagnostic=JSON.stringify(error);
  for(const secret of ['fixture-sensitive-uid','fixture-sensitive-stdout','fixture-sensitive-stderr'])assert.ok(!diagnostic.includes(secret));
  return true;
}
test('Qoder nonzero local helper exit is typed 503 and does not spawn an immediate retry',()=>{
  let calls=0;
  assert.throws(()=>readQoderNativeIdentity('nonzero-helper','fixture-sensitive-uid',options(()=>{calls++;return {status:9,stdout:'fixture-sensitive-stdout',stderr:'fixture-sensitive-stderr'}})),e=>assertLocal(e,'nonzero'));
  assert.equal(calls,1);
});
test('Qoder helper timeout and thrown spawn error become bounded local diagnostics',()=>{
  assert.throws(()=>readQoderNativeIdentity('timeout-helper','fixture-sensitive-uid',options(()=>({status:null,signal:'SIGTERM',error:Object.assign(Error('fixture-sensitive-stderr'),{code:'ETIMEDOUT'}),stdout:'fixture-sensitive-stdout'}))),e=>assertLocal(e,'timeout'));
  assert.throws(()=>readQoderNativeIdentity('spawn-helper','fixture-sensitive-uid',options(()=>{throw Object.assign(Error('fixture-sensitive-stderr'),{code:'EACCES'})})),e=>assertLocal(e,'spawn_failed'));
});
test('Qoder missing helper remains a local 503 with explicit low-frequency action-required marker',()=>{
  assert.throws(()=>readQoderNativeIdentity('missing-helper','fixture-sensitive-uid',options(()=>({status:null,error:Object.assign(Error('fixture-sensitive-stderr'),{code:'ENOENT'})}))),e=>assertLocal(e,'helper_missing',{actionRequired:true}));
});
test('Qoder malformed JSON and incomplete native identity are classified without returning output fragments',()=>{
  for(const [kind,stdout] of [['invalid_json','fixture-sensitive-stdout'],['incomplete',JSON.stringify({machineToken:'fixture-sensitive-stdout'})]]){
    assert.throws(()=>readQoderNativeIdentity(kind+'-helper','fixture-sensitive-uid',options(()=>({status:0,stdout,stderr:'fixture-sensitive-stderr'}))),e=>assertLocal(e,kind));
  }
});
test('Qoder failed native read is not cached and the next scheduled read can recover',()=>{
  let calls=0;const spawnImpl=()=>{calls++;return calls===1?{status:1,stdout:''}:success()};
  assert.throws(()=>readQoderNativeIdentity('recovery-helper','fixture-sensitive-uid',options(spawnImpl)),e=>assertLocal(e,'nonzero'));
  assert.deepEqual(readQoderNativeIdentity('recovery-helper','fixture-sensitive-uid',options(spawnImpl,61000)),native);
  const cached=readQoderNativeIdentity('recovery-helper','fixture-sensitive-uid',options(spawnImpl,62000));cached.machineToken='changed-fixture';
  assert.deepEqual(readQoderNativeIdentity('recovery-helper','fixture-sensitive-uid',options(spawnImpl,63000)),native);assert.equal(calls,2);
});
test('Qoder five-minute cache expiry never masks a failed native refresh with stale identity',()=>{
  let calls=0;const spawnImpl=()=>{calls++;return calls===2?{status:1,stdout:''}:success()};
  assert.deepEqual(readQoderNativeIdentity('expiry-helper','fixture-sensitive-uid',options(spawnImpl)),native);
  assert.throws(()=>readQoderNativeIdentity('expiry-helper','fixture-sensitive-uid',options(spawnImpl,301000)),e=>assertLocal(e,'nonzero'));
  assert.deepEqual(readQoderNativeIdentity('expiry-helper','fixture-sensitive-uid',options(spawnImpl,361000)),native);assert.equal(calls,3);
});
