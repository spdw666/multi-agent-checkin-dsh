import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.mjs';

function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'gateway-store-opt-')),l=new Ledger(dir);try{return fn(l,dir);}finally{try{l.close();}catch{}rmSync(dir,{recursive:true,force:true});}}
test('compiled metadata SQL is reused while parameters and parsed result objects stay independent',()=>fixture(l=>{
  l.set('SAMPLE_A',{v:1});l.set('SAMPLE_B',{v:2});let prepares=0;const original=l.db.prepare.bind(l.db);l.db.prepare=(sql)=>{prepares++;return original(sql);};
  for(let i=0;i<20;i++){const a=l.get('SAMPLE_A');assert.deepEqual(a,{v:1});a.v=999;assert.deepEqual(l.get('SAMPLE_B'),{v:2});assert.equal(l.get('MISSING'),undefined);}
  assert.equal(prepares,1,'one compiled SELECT instead of one per read');
}));
test('cached statements observe commits from another connection and transaction rollback',()=>fixture((l,dir)=>{
  const peer=new Ledger(dir);try{l.set('SAMPLE',1);assert.equal(l.get('SAMPLE'),1);peer.set('SAMPLE',2);assert.equal(l.get('SAMPLE'),2);l.db.exec('BEGIN IMMEDIATE');l.set('SAMPLE',3);assert.equal(l.get('SAMPLE'),3);l.db.exec('ROLLBACK');assert.equal(l.get('SAMPLE'),2);peer.set('SAMPLE',4);assert.equal(l.get('SAMPLE'),4);}finally{peer.close();}
}));
test('connection-local statement cache never shares statements or values across ledgers',()=>fixture(l=>fixture(other=>{
  l.set('SAMPLE',1);other.set('SAMPLE',9);assert.equal(l.get('SAMPLE'),1);assert.equal(other.get('SAMPLE'),9);l.close();assert.throws(()=>l.get('SAMPLE'));assert.equal(other.get('SAMPLE'),9);
})));
test('claim and principal statements remain fresh across idempotent state changes',()=>fixture(l=>{
  l.bind('SAMPLE','sample','one');const a=l.principalHash('SAMPLE');l.unbind('SAMPLE');assert.equal(l.principalHash('SAMPLE'),undefined);l.bind('SAMPLE','sample','two');assert.notEqual(l.principalHash('SAMPLE'),a);
  const r=l.reserve('SAMPLE_CLAIM',Date.now(),{preparing:true});assert.equal(l.reserve('SAMPLE_CLAIM').acquired,false);assert.equal(l.markSubmitted('SAMPLE_CLAIM',r.reservationId),true);assert.equal(l.finish('SAMPLE_CLAIM','success',{ok:true},r.reservationId),true);assert.equal(l.claimReceipt('SAMPLE_CLAIM').status,'success');assert.equal(l.reserve('SAMPLE_CLAIM').acquired,false);
}));
test('balance account history uses the account index and preserves observation semantics',()=>fixture(l=>{
  const row={accountId:'SAMPLE',checkedAt:'2026-01-01T00:00:00Z',unit:'credits',value:10};l.observeBalance(row);l.observeBalance(row);l.observeBalance({...row,stale:true,value:0});l.observeBalance({...row,value:7});l.observeBalance({...row,unit:'other',value:4});
  const history=l.balanceChanges('SAMPLE');assert.equal(history.length,3);assert.equal(history[0].previous_value,null);assert.equal(history[1].change,-3);
  const plan=l.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM balance_observations WHERE account_id=? ORDER BY id DESC LIMIT 1').all('SAMPLE');assert.match(plan.map(r=>r.detail).join(' '),/USING INDEX balance_account_id/);
}));
test('balance index migration is idempotent and preserves existing rows on reopen',()=>fixture((l,dir)=>{
  l.observeBalance({accountId:'SAMPLE',checkedAt:'2026-01-01',unit:'credits',value:5});l.db.exec('DROP INDEX IF EXISTS balance_account_id');const reopened=new Ledger(dir);try{assert.equal(reopened.balanceChanges('SAMPLE')[0].value,5);const index=reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='balance_account_id'").get();assert.ok(index);}finally{reopened.close();}
}));
