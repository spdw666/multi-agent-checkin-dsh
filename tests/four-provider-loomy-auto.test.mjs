import test from 'node:test';
import assert from 'node:assert/strict';
import {descriptor,loomyClaim,loomyStatus} from '../src/provider-loomy.mjs';
import {restoreLoomyDailyQuota} from '../src/daily-quota-receipt.mjs';
import {Ledger} from '../src/store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const now=Date.parse('2026-10-21T04:00:00Z');
const secret=name=>({accessToken:'fixture-token-'+name,principal:'fixture-principal-'+name});
function transport({receipt={},balance={},posts=[]}={}){
  return async(url,options)=>{
    if(options.method==='POST'){
      posts.push({path:new URL(url).pathname,body:JSON.parse(options.body)});
      return Response.json({code:'000000',data:receipt});
    }
    return Response.json({code:'000000',data:balance});
  };
}
const receipt={alreadyProcessed:false,currentBalance:10000,dailyBalance:5000,dailyQuota:5000,dailyCycleDate:'2026-10-21'};
const balance={availableBalance:10000,balance:5000,dailyBalance:5000};

test('daily login refresh has exact official empty POST then a dated, matching receipt',async()=>{
  const posts=[],owner=secret('fresh'),options={now,fetchImpl:transport({receipt,balance,posts})};
  assert.equal((await loomyStatus(owner,'daily-quota',options)).observed,false);
  const result=await loomyClaim(owner,'daily-quota',options);
  assert.deepEqual(posts,[{path:'/api/v1/points/first-login',body:{}}]);
  assert.equal(result.observed,true);assert.equal(result.confirmed,true);assert.equal(result.alreadyProcessed,false);
  assert.equal(result.claimed,false);assert.equal(result.dailyQuotaObserved,true);
  assert.equal(result.details.dailyQuotaAlreadyProcessed,false);
  assert.equal(result.details.dailyQuotaGrantOutcome,'newly_processed');
  const after=await loomyStatus(owner,'daily-quota',options);
  assert.equal(after.observed,true);assert.equal(after.details.dailyQuotaGrantOutcome,'newly_processed');
});

for(const [name,change,updatedBalance]of[
  ['missing cycle date',r=>delete r.dailyCycleDate,balance],
  ['yesterday',r=>r.dailyCycleDate='2026-10-20',balance],
  ['future day',r=>r.dailyCycleDate='2026-10-22',balance],
  ['missing daily quota',r=>delete r.dailyQuota,balance],
  ['negative daily quota',r=>r.dailyQuota=-1,balance],
  ['changed daily balance',()=>{},{...balance,dailyBalance:4999}],
  ['changed total balance',()=>{},{...balance,availableBalance:9999}],
])test(`a ${name} receipt never reports observed or confirmed`,async()=>{
  const next={...receipt};change(next);
  const result=await loomyClaim(secret(name),'daily-quota',{now,fetchImpl:transport({receipt:next,balance:updatedBalance})});
  assert.equal(result.dailyQuotaObserved,false);assert.equal(result.observed,false);assert.equal(result.confirmed,false);
  assert.equal(result.details.dailyQuotaAlreadyProcessed,null);assert.equal(result.details.dailyQuotaGrantOutcome,'unknown');
  assert.equal(result.reason,'daily_quota_receipt_unverified');assert.equal(result.submitted,true);
});

test('already processed official receipt is not evidence of a new grant by this request',async()=>{
  const result=await loomyClaim(secret('manual-first'),'daily-quota',{now,fetchImpl:transport({receipt:{...receipt,alreadyProcessed:true},balance})});
  assert.equal(result.observed,true);assert.equal(result.alreadyProcessed,true);assert.equal(result.claimed,false);
  assert.equal(result.details.dailyQuotaAlreadyProcessed,true);assert.equal(result.details.dailyQuotaGrantOutcome,'already_processed');
});

test('a nonboolean alreadyProcessed marker never supplies grant provenance',async()=>{
  for(const value of [undefined,0,1,'false','true']){
    const result=await loomyClaim(secret('invalid-marker-'+String(value)),'daily-quota',{now,fetchImpl:transport({receipt:{...receipt,alreadyProcessed:value},balance})});
    assert.equal(result.observed,true);assert.equal(result.details.dailyQuotaAlreadyProcessed,null);assert.equal(result.details.dailyQuotaGrantOutcome,'unknown');
  }
});

test('a previous day receipt expires together with its automatic-grant provenance',async()=>{
  const owner=secret('expiry-provenance'),options={now,fetchImpl:transport({receipt,balance})};
  await loomyClaim(owner,'daily-quota',options);
  const next=await loomyStatus(owner,'daily-quota',{...options,now:now+86400000});
  assert.equal(next.observed,false);assert.equal(next.details.dailyQuotaGrantOutcome,'unknown');assert.equal(next.details.dailyQuotaAlreadyProcessed,null);
});

const durableReceipt=details=>({status:'observed',result:{observationSchema:1,observationVerifiedDay:'2026-10-21',details:{dailyQuotaObserved:true,dailyCycleDate:'2026-10-21',dailyQuota:5000,dailyQuotaObservedAt:'2026-10-21T03:00:00Z',dailyQuotaSource:'/api/v1/points/first-login',...details}}});
const freshHealth=()=>({balance:{value:9900,dailyQuotaObserved:false,parts:[{value:5000},{value:4900}]}});

test('a cold ledger restores the same principal current-day grant provenance without changing fresh balance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'loomy-grant-provenance-'));let ledger=new Ledger(dir);
  try{
    const key=ledger.claimKey('loomy','owner-a','2026-10-21','daily-quota');
    ledger.reserve(key);ledger.finish(key,'observed',durableReceipt({dailyQuotaAlreadyProcessed:false,dailyQuotaGrantOutcome:'already_processed'}).result);
    ledger.close();ledger=new Ledger(dir);
    const restored=restoreLoomyDailyQuota(freshHealth(),ledger.claimReceipt(key),now);
    assert.equal(restored.balance.dailyQuotaObserved,true);assert.equal(restored.balance.dailyQuotaAlreadyProcessed,false);
    assert.equal(restored.balance.dailyQuotaGrantOutcome,'newly_processed');assert.equal(restored.balance.value,9900);assert.equal(restored.balance.parts[1].value,4900);
    const other=freshHealth();assert.equal(restoreLoomyDailyQuota(other,ledger.claimReceipt(ledger.claimKey('loomy','owner-b','2026-10-21','daily-quota')),now),other);
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('durable provenance is derived from the strict server boolean, never the stored label',()=>{
  for(const [value,expected]of[[false,'newly_processed'],[true,'already_processed'],[undefined,'unknown'],[null,'unknown'],['false','unknown'],[0,'unknown']]){
    const restored=restoreLoomyDailyQuota(freshHealth(),durableReceipt({dailyQuotaAlreadyProcessed:value,dailyQuotaGrantOutcome:'newly_processed'}),now);
    assert.equal(restored.balance.dailyQuotaObserved,true);assert.equal(restored.balance.dailyQuotaAlreadyProcessed,typeof value==='boolean'?value:null);
    assert.equal(restored.balance.dailyQuotaGrantOutcome,expected);
  }
});

test('old observations and changed-day receipts never gain new automatic-grant proof',()=>{
  const old=restoreLoomyDailyQuota(freshHealth(),durableReceipt({}),now);
  assert.equal(old.balance.dailyQuotaObserved,true);assert.equal(old.balance.dailyQuotaAlreadyProcessed,null);assert.equal(old.balance.dailyQuotaGrantOutcome,'unknown');
  const fresh=freshHealth(),expired=restoreLoomyDailyQuota(fresh,durableReceipt({dailyQuotaAlreadyProcessed:false,dailyQuotaGrantOutcome:'newly_processed'}),now+86400000);
  assert.equal(expired,fresh);assert.equal(expired.balance.dailyQuotaObserved,false);assert.equal(expired.balance.dailyQuotaGrantOutcome,undefined);
});

test('the idempotent reconciliation declaration covers daily-quota only, never pet-work or aliases',()=>{
  assert.deepEqual(descriptor.dailyReconciliationTasks,['daily-quota']);
  assert.equal(descriptor.dailyReconciliationMode,'idempotent-first-login');
  assert.equal(descriptor.dailyReconciliationTasks.includes('pet-work'),false);
  assert.equal(descriptor.dailyReconciliationTasks.includes('daily-checkin'),false);
  assert.equal(Object.isFrozen(descriptor.dailyReconciliationTasks),true);
});

function repeatedFirstLogin({loseFirstResponse=false}={}){
  let processed=false,grants=0,posts=0;
  return {
    get grants(){return grants;},get posts(){return posts;},
    fetchImpl:async(url,options)=>{
      if(options.method==='POST'){
        assert.equal(new URL(url).pathname,'/api/v1/points/first-login');assert.deepEqual(JSON.parse(options.body),{});
        const alreadyProcessed=processed;posts++;
        if(!processed){processed=true;grants++;}
        if(loseFirstResponse&&posts===1)throw new Error('response lost after the server committed');
        return Response.json({code:'000000',data:{...receipt,alreadyProcessed}});
      }
      return Response.json({code:'000000',data:processed?balance:{balance:5000,dailyBalance:0,availableBalance:5000}});
    },
  };
}

test('repeated empty first-login calls retain one server grant and report only the first as new processing',async()=>{
  const server=repeatedFirstLogin(),owner=secret('repeated-first-login'),options={now,fetchImpl:server.fetchImpl};
  const first=await loomyClaim(owner,'daily-quota',options),second=await loomyClaim(owner,'daily-quota',options);
  assert.equal(server.posts,2);assert.equal(server.grants,1);
  assert.equal(first.details.dailyQuotaGrantOutcome,'newly_processed');assert.equal(first.details.dailyQuotaAlreadyProcessed,false);
  assert.equal(second.details.dailyQuotaGrantOutcome,'already_processed');assert.equal(second.details.dailyQuotaAlreadyProcessed,true);
  assert.equal(second.observed,true);assert.equal(second.confirmed,true);assert.equal(second.details.value,first.details.value);
});

test('a lost first-login response can be reconciled by the same idempotent endpoint without another grant',async()=>{
  const server=repeatedFirstLogin({loseFirstResponse:true}),owner=secret('lost-first-login'),options={now,fetchImpl:server.fetchImpl};
  await assert.rejects(loomyClaim(owner,'daily-quota',options),{code:'loomy_network_error'});
  assert.equal((await loomyStatus(owner,'daily-quota',options)).observed,false);
  const reconciled=await loomyClaim(owner,'daily-quota',options);
  assert.equal(server.posts,2);assert.equal(server.grants,1);assert.equal(reconciled.confirmed,true);
  assert.equal(reconciled.details.dailyQuotaGrantOutcome,'already_processed');assert.equal(reconciled.details.dailyQuotaAlreadyProcessed,true);
});
