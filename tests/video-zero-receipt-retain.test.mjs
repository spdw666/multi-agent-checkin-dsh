import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,mkdir,readFile}from'node:fs/promises';import path from'node:path';import{pathToFileURL}from'node:url';
const ROOT=path.resolve(import.meta.dirname,'..'),SOURCE=process.env.CLAIMS_SOURCE??path.join(ROOT,'src');
globalThis.fetch=async()=>{throw new Error('fixture_network_blocked');};
const {ClaimService}=await import(pathToFileURL(path.join(SOURCE,'claims.mjs'))),{Ledger}=await import(pathToFileURL(path.join(SOURCE,'store.mjs'))),{createVideoDailyProvider,officialVideoDailySettlement}=await import(pathToFileURL(path.join(SOURCE,'provider-video-daily.mjs'))),{hash,dayIn}=await import(pathToFileURL(path.join(SOURCE,'util.mjs')));
const CLOCK=Date.parse('2026-10-27T04:00:00.000Z'),ZONE='Asia/Shanghai';
async function setup(t){
  t.mock.timers.enable({apis:['Date'],now:CLOCK});await mkdir(path.join(ROOT,'proof/sqlite'),{recursive:true});const dir=await mkdtemp(path.join(ROOT,'proof/sqlite/case-'));let ledger=new Ledger(dir);t.after(()=>ledger.close());
  const account={id:'fixture-vidu',platform:'vidu',enabled:true,tasks:[{id:'daily-checkin',enabled:true},{id:'daily-quota',enabled:true}]},config={value:{accounts:[account],scheduler:{timezone:ZONE}}};
  let principal=hash('fixture-principal-a'),award=0,override;const calls={balances:0,grants:0,claims:0,paths:[]};
  const credential=()=>({principalHash:principal,accessToken:'SYNTHETIC_ONLY',authToken:'SYNTHETIC_ONLY'}),provider=createVideoDailyProvider('vidu',{now:()=>new Date(),fetchImpl:async url=>{const p=new URL(url).pathname;calls.paths.push(p);assert.equal(new URL(url).origin,'https://service.vidu.cn');if(p==='/credit/v1/credits/me'){calls.balances++;return new Response(JSON.stringify({credits:20,credits_free:20}));}if(p==='/iam/v1/users/every-day-credit'){calls.grants++;return new Response(JSON.stringify({credit:award}));}throw new Error('unexpected fixture path');}});
  const credentials={resolve:async()=>credential()},platforms={status:async(a,task)=>override===undefined?provider.status(credential(),task):override,claim:async(a,task)=>{calls.claims++;return provider.claim(credential(),task);}};
  let service=new ClaimService(config,credentials,platforms,ledger);
  const key=(task='daily-checkin',day=dayIn(new Date(),ZONE),kind=account.platform,p=principal)=>ledger.claimKey(kind,p,day,task,'');
  return {calls,config,account,provider,credential,get ledger(){return ledger;},get service(){return service;},key,setAward:n=>award=n,setStatus:s=>override=s,setPrincipal:p=>principal=hash(p),restart(){ledger.close();ledger=new Ledger(dir);service=new ClaimService(config,credentials,platforms,ledger);},tamper(change,status){const k=key(),old=ledger.claimReceipt(k),result=change(structuredClone(old.result));ledger.db.prepare('UPDATE claims SET result=?,status=? WHERE key=?').run(JSON.stringify(result),status??old.status,k);},seed(k,result,status='success'){ledger.db.prepare('INSERT INTO claims VALUES (?,?,?,?)').run(k,status,new Date().toISOString(),JSON.stringify(result));}};
}
const automatic={trigger:'automatic',source:'fixture-startup'};
const noNewFlags=['operationAttempted','automaticOperationConfirmed','automaticRewardConfirmed','submitted','mutation','automaticPerformed'];
async function zero(h){
  const first=await h.service.run('fixture-vidu','daily-checkin',automatic);
  assert.equal(first.status,'observed');assert.equal(first.credits,0);assert.equal(first.claimed,false);
  assert.equal(first.benefitOutcome,'no_new_daily_credit');assert.equal(first.serverConfirmed,true);
  assert.equal(first.automaticRewardConfirmed,false);assert.equal(first.officialDailyReceipt.amount,0);
  assert.equal(first.officialDailyReceipt.source,'/iam/v1/users/every-day-credit');
  assert.equal(h.calls.grants,1);assert.equal(h.calls.claims,1);return first;
}
function retained(next,h,first){
  assert.equal(next.status,'observed');assert.equal(next.reason,'official_daily_zero_receipt_retained');
  assert.equal(next.retainedOfficialReceipt,true);assert.equal(next.credits,0);assert.equal(next.claimed,false);
  assert.equal(next.observed,true);assert.equal(next.serverConfirmed,true);assert.equal(next.benefitOutcome,'no_new_daily_credit');
  for(const flag of noNewFlags)assert.equal(next[flag],false,flag);
  assert.deepEqual(next.officialDailyReceipt,first.officialDailyReceipt);assert.equal(h.calls.grants,1);assert.equal(h.calls.claims,1);
}
test('real opaque zero grant then startup balance20 preserves zero observation, original row and no replay',async t=>{
  const h=await setup(t),first=await zero(h),row=h.ledger.claimReceipt(h.key()),reads=h.calls.balances;
  const next=await h.service.run('fixture-vidu','daily-checkin',automatic);retained(next,h,first);
  assert.equal(h.calls.balances,reads+1);assert.deepEqual(h.ledger.claimReceipt(h.key()),row);
  assert.equal(h.ledger.records({limit:1})[0].status,'observed');
  assert.deepEqual(h.calls.paths.filter(p=>p!=='/credit/v1/credits/me'),['/iam/v1/users/every-day-credit']);
});
test('real SQLite reopen keeps same-day zero official receipt',async t=>{const h=await setup(t),first=await zero(h);h.restart();retained(await h.service.run('fixture-vidu','daily-checkin',automatic),h,first);});
test('manual recheck has no inherited old automatic flags',async t=>{const h=await setup(t),first=await zero(h),next=await h.service.run('fixture-vidu');retained(next,h,first);assert.equal(next.trigger,'manual');});
test('four repeated startups remain observed without replay or balance20 award',async t=>{const h=await setup(t),first=await zero(h);for(let i=0;i<4;i++)retained(await h.service.run('fixture-vidu','daily-checkin',automatic),h,first);});
const invalid=[
 ['source-missing',r=>delete r.officialDailyReceipt.source],['wrong-source',r=>r.officialDailyReceipt.source='/credit/v1/credits/me'],
 ['day-missing',r=>delete r.officialDailyReceipt.day],['wrong-day',r=>r.officialDailyReceipt.day='2026-10-26'],
 ['time-missing',r=>delete r.officialDailyReceipt.checkedAt],['invalid-time',r=>r.officialDailyReceipt.checkedAt='invalid'],
 ['future-time',r=>r.officialDailyReceipt.checkedAt=new Date(CLOCK+1000).toISOString()],['other-time-day',r=>r.officialDailyReceipt.checkedAt=new Date(CLOCK-86400000).toISOString()],
 ['positive-amount',r=>r.officialDailyReceipt.amount=20],['string-zero-amount',r=>r.officialDailyReceipt.amount='0'],['negative-amount',r=>r.officialDailyReceipt.amount=-1],['amount-missing',r=>delete r.officialDailyReceipt.amount],
 ['confirmation-missing',r=>delete r.serverConfirmed],['unconfirmed',r=>r.serverConfirmed=false],
 ['claimed-null',r=>r.claimed=null],['claimed-true',r=>r.claimed=true],['claimed-string',r=>r.claimed='false'],
 ['balance20-not-grant0',r=>r.credits=20],['credits-string',r=>r.credits='0'],['credits-missing',r=>delete r.credits],
 ['benefit-positive',r=>r.benefitOutcome='newly_granted'],['benefit-missing',r=>delete r.benefitOutcome],
 ['receipt-missing',r=>delete r.officialDailyReceipt]
];
for(const[name,change]of invalid)test('zero prior '+name+' does not retain or replay',async t=>{
 const h=await setup(t);await zero(h);h.tamper(r=>{change(r);return r;});
 const next=await h.service.run('fixture-vidu','daily-checkin',automatic);
 assert.equal(next.status,'uncertain');assert.equal(next.reason,'local_receipt_conflicts_server_state');
 assert.notEqual(next.retainedOfficialReceipt,true);assert.equal(next.serverConfirmed,false);
 assert.equal(next.operationAttempted,false);assert.equal(next.automaticRewardConfirmed,false);assert.equal(h.calls.grants,1);assert.equal(h.calls.claims,1);
});
for(const status of ['success','already','rejected','uncertain'])test('zero receipt with wrong terminal status '+status+' does not retain or replay',async t=>{
 const h=await setup(t);await zero(h);h.tamper(r=>r,status);const next=await h.service.run('fixture-vidu','daily-checkin',automatic);
 assert.equal(next.status,status==='rejected'?'rejected':'uncertain');assert.notEqual(next.retainedOfficialReceipt,true);assert.equal(next.operationAttempted,false);assert.equal(next.automaticRewardConfirmed,false);assert.equal(h.calls.grants,1);
});
test('fresh claimed:false contradiction remains uncertain, never replays',async t=>{const h=await setup(t);await zero(h);h.setStatus({known:true,active:true,claimed:false});const next=await h.service.run('fixture-vidu','daily-checkin',automatic);assert.equal(next.status,'uncertain');assert.equal(next.reason,'local_receipt_conflicts_server_state');assert.equal(next.operationAttempted,false);assert.equal(h.calls.grants,1);});
test('fresh claimed undefined is not the explicit null contract',async t=>{const h=await setup(t);await zero(h);h.setStatus({known:true,active:true});assert.equal((await h.service.run('fixture-vidu')).status,'uncertain');assert.equal(h.calls.grants,1);});
test('unknown fresh server state stays error',async t=>{const h=await setup(t);await zero(h);h.setStatus({known:false,claimed:null});assert.equal((await h.service.run('fixture-vidu')).status,'error');assert.equal(h.calls.grants,1);});
test('another platform cannot borrow even copied zero receipt',async t=>{const h=await setup(t);await zero(h);const row=h.ledger.claimReceipt(h.key());h.account.platform='pixverse';h.seed(h.key(),row.result,'observed');h.setStatus({known:true,active:true,claimed:null});const next=await h.service.run('fixture-vidu');assert.equal(next.status,'uncertain');assert.notEqual(next.retainedOfficialReceipt,true);assert.equal(h.calls.grants,1);});
test('another task cannot borrow even copied zero receipt',async t=>{const h=await setup(t);await zero(h);h.seed(h.key('daily-quota'),h.ledger.claimReceipt(h.key()).result,'observed');h.setStatus({known:true,active:true,claimed:null});assert.equal((await h.service.run('fixture-vidu','daily-quota')).status,'uncertain');assert.equal(h.calls.grants,1);});
test('next day has its own opaque zero grant, never borrows yesterday',async t=>{const h=await setup(t),first=await zero(h);t.mock.timers.tick(86400000);const next=await h.service.run('fixture-vidu','daily-checkin',automatic);assert.equal(next.status,'observed');assert.notEqual(next.day,first.day);assert.notEqual(next.retainedOfficialReceipt,true);assert.equal(next.credits,0);assert.equal(h.calls.grants,2);});
test('different principal has own zero grant and does not borrow another key',async t=>{const h=await setup(t);await zero(h);h.setPrincipal('fixture-principal-b');const next=await h.service.run('fixture-vidu','daily-checkin',automatic);assert.equal(next.status,'observed');assert.notEqual(next.retainedOfficialReceipt,true);assert.equal(next.credits,0);assert.equal(h.calls.grants,2);});
test('serialized zero or positive JSON still never passes opaque new-grant validator',()=>{for(const amount of[0,20])assert.equal(officialVideoDailySettlement('vidu',hash('a'),{officialDailyReceipt:{kind:'vidu',principalHash:hash('a'),day:'2026-10-27',source:'/iam/v1/users/every-day-credit',amount,checkedAt:'2026-10-27T04:00:00.000Z'}},'2026-10-27',ZONE),null);});
