import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {ClaimService}=await import(pathToFileURL(resolve(root,'src/claims.mjs')));
const {Platforms}=await import(pathToFileURL(resolve(root,'src/platforms.mjs')));
const {Ledger}=await import(pathToFileURL(resolve(root,'src/store.mjs')));
const {dayIn}=await import(pathToFileURL(resolve(root,'src/util.mjs')));
const automatic={trigger:'automatic',source:'startup'};
async function fixture(t,platform='raccoon',task='daily-quota') {
 const dir=await mkdtemp(join(tmpdir(),'four-provider-execution-')),ledger=new Ledger(dir);
 t.after(async()=>{ledger.close();await rm(dir,{recursive:true,force:true});});
 const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform,tasks:[{id:task,enabled:true}]}]}};
 const credentials={account:()=>config.value.accounts[0],resolve:async()=>({principalHash:'SAMPLE'})};
 const key=ledger.claimKey(platform,'SAMPLE',dayIn(),task,'');
 return {config,credentials,ledger,key,task,service:p=>new ClaimService(config,credentials,p,ledger)};
}
for(const platform of ['lobster','loomy','codearts','raccoon'])test(`${platform}: manual pre-completion is never an automatic operation or reward`,async t=>{
 const task=['loomy','raccoon'].includes(platform)?'daily-quota':'daily-checkin',f=await fixture(t,platform,task);let calls=0;
 const observed=['loomy','raccoon'].includes(platform);
 const s=f.service({status:async()=>({known:true,active:false,observed,claimed:!observed}),claim:async()=>{calls++;}});
 const r=await s.run('a',task,automatic);
 assert.equal(calls,0);assert.equal(r.trigger,'automatic');assert.equal(r.triggerSource,'startup');assert.equal(r.operationAttempted,false);assert.equal(r.automaticOperationConfirmed,false);assert.equal(r.automaticRewardConfirmed,false);assert.equal(r.benefitOutcome,'available_before_run');
 const receipt=f.ledger.claimReceipt(f.key);assert.equal(receipt.result.automaticOperationConfirmed,false);
});
test('all forwards scheduler provenance; direct/API run stays manual',async t=>{
 const f=await fixture(t,'lobster','daily-checkin'),s=f.service({status:async()=>({known:true,claimed:true})});
 const [r]=await s.all(undefined,automatic);assert.equal(r.trigger,'automatic');assert.equal((await s.run('a',f.task)).trigger,'manual');
});
test('production reconciliation capability is limited to Raccoon daily GET path',async t=>{
 const f=await fixture(t),p=new Platforms(f.config,f.credentials);
 assert.equal(await p.dailyReconciliationMode('a','daily-quota'),'native-session-get');
 assert.equal(await p.dailyReconciliationMode('a','daily-checkin'),null);
 f.config.value.accounts[0].platform='lobster';assert.equal(await p.dailyReconciliationMode('a','daily-quota'),null);
});
test('Loomy daily initialization recovers a lost response but pet-work remains POST-fenced',async t=>{
 const f=await fixture(t,'loomy'),p=new Platforms(f.config,f.credentials);
 assert.equal(await p.dailyReconciliationMode('a','daily-quota'),'idempotent-first-login');
 assert.equal(await p.dailyReconciliationMode('a','pet-work'),null);
 assert.equal(await p.dailyReconciliationMode('a','daily-checkin'),null);
 let calls=0,done=false;p.status=async()=>({known:true,active:true,observed:done});
 p.claim=async()=>{if(++calls===1)throw Error('SAMPLE first response lost');done=true;return {observed:true,submitted:true,alreadyProcessed:true,details:{dailyQuotaAlreadyProcessed:true}};};
 const s=f.service(p);assert.equal((await s.run('a',f.task,automatic)).status,'uncertain');
 const r=await s.run('a',f.task,automatic);assert.equal(r.status,'observed');assert.equal(calls,2);assert.equal(r.automaticRewardConfirmed,false);assert.equal(r.benefitOutcome,'already_processed');
});
test('Loomy pet reward cannot borrow the daily initialization exception',async t=>{
 const f=await fixture(t,'loomy','pet-work');f.ledger.reserve(f.key);f.ledger.finish(f.key,'uncertain',{});let calls=0;
 const r=await f.service({dailyReconciliationMode:async()=> 'idempotent-first-login',status:async()=>({known:true,active:true,claimed:false}),claim:async()=>{calls++;}}).run('a',f.task,automatic);
 assert.equal(r.status,'uncertain');assert.equal(calls,0);
});
test('CodeArts automatic confirmation-only recovery records the operation but not new acquisition',async t=>{
 const f=await fixture(t,'codearts','daily-checkin');f.ledger.reserve(f.key);f.ledger.finish(f.key,'uncertain',{});let calls=0;
 const r=await f.service({status:async()=>({known:true,active:true,pendingConfirmation:!calls,claimed:calls>0}),claim:async(_a,_t,options)=>{assert.equal(options.confirmOnly,true);calls++;return {submitted:true,confirmed:true,claimed:true};}}).run('a',f.task,automatic);
 assert.equal(r.status,'success');assert.equal(r.automaticOperationConfirmed,true);assert.equal(r.automaticRewardConfirmed,false);assert.equal(calls,1);
});
test('CodeArts manually acquired but pending confirmation never counts as new automatic reward, even without old lease',async t=>{
 const f=await fixture(t,'codearts','daily-checkin');let calls=0;
 const r=await f.service({status:async()=>({known:true,active:true,pendingConfirmation:!calls,claimed:calls>0}),claim:async(_a,_t,options)=>{assert.equal(options.confirmOnly,true);calls++;return {submitted:true,confirmed:true,claimed:true};}}).run('a',f.task,automatic);
 assert.equal(r.status,'success');assert.equal(r.automaticOperationConfirmed,true);assert.equal(r.automaticRewardConfirmed,false);assert.equal(calls,1);
});
test('official after-midnight observation uses the confirmed day, not the submission day',async t=>{
 const RealDate=globalThis.Date;let now=RealDate.parse('2026-10-21T15:59:59Z');
 class Clock extends RealDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 globalThis.Date=Clock;
 try {
  const f=await fixture(t,'loomy');let done=false;
  const r=await f.service({status:async()=>({known:true,active:true,observed:done,details:{dailyCycleDate:done?'2026-10-22':'2026-10-21'}}),claim:async()=>{now+=2000;done=true;return {submitted:true,observed:true};}}).run('a',f.task,automatic);
  assert.equal(r.status,'observed');assert.equal(r.day,'2026-10-22');assert.equal(r.observationVerifiedDay,'2026-10-22');
 }finally{globalThis.Date=RealDate;}
});
test('old uncertain Raccoon wrong-POST receipt recovers only via approved GET initialization',async t=>{
 const f=await fixture(t);f.ledger.reserve(f.key);f.ledger.finish(f.key,'uncertain',{reason:'old_wrong_endpoint'});let operations=0;
 const p=new Platforms(f.config,f.credentials);
 p.status=async()=>({known:true,active:true,claimed:false,observed:operations>0});
 p.claim=async()=>{operations++;return {observed:true,automaticPerformed:true,submitted:false,mutation:false,operation:'daily-login-session-refresh',source:'native_session_get_chain'};};
 const r=await f.service(p).run('a',f.task,automatic);
 assert.equal(r.status,'observed');assert.equal(operations,1);assert.equal(r.submitted,false);assert.equal(r.mutation,false);assert.equal(r.automaticOperationConfirmed,true);assert.equal(r.automaticRewardConfirmed,false);assert.equal(r.benefitOutcome,'daily_validity_extended');assert.equal(r.operationSource,'native_session_get_chain');
});
test('GET session read failure after old uncertainty remains retryable without reward POST',async t=>{
 const f=await fixture(t);f.ledger.reserve(f.key);f.ledger.finish(f.key,'uncertain',{});let calls=0;
 const p=new Platforms(f.config,f.credentials);p.status=async()=>{throw Object.assign(Error('SAMPLE read'),{status:401,code:'credential_expired'});};p.claim=async()=>{calls++;};
 const r=await f.service(p).run('a',f.task,automatic);assert.equal(r.status,'error');assert.equal(r.loginRequired,true);assert.equal(calls,0);
});
test('GET-only operation delay remains retryable on reentry, no repeated claim POST',async t=>{
 const f=await fixture(t);let calls=0,done=false;
 const p=new Platforms(f.config,f.credentials);p.status=async()=>({known:true,active:true,observed:done});p.claim=async()=>{if(++calls===1)throw Object.assign(Error('SAMPLE delayed bill'),{beforeSubmission:true,retryable:true});done=true;return {observed:true,automaticPerformed:true,submitted:false,mutation:false};};
 const s=f.service(p);assert.equal((await s.run('a',f.task,automatic)).status,'error');assert.equal((await s.run('a',f.task,automatic)).status,'observed');assert.equal(calls,2);
});
test('other platforms cannot use reconciliation capability to escape uncertain POST fencing',async t=>{
 const f=await fixture(t,'lobster','daily-checkin');f.ledger.reserve(f.key);f.ledger.finish(f.key,'uncertain',{});let posts=0;
 const r=await f.service({dailyReconciliationMode:async()=> 'native-session-get',status:async()=>({known:true,active:true,claimed:false}),claim:async()=>{posts++;}}).run('a',f.task,automatic);
 assert.equal(r.status,'uncertain');assert.equal(posts,0);
});
for(const processed of [false,true,null])test(`Loomy processed=${processed}: initialization marker alone never proves a new daily credit`,async t=>{
 const f=await fixture(t,'loomy');let called=false;
 const details={dailyQuotaObserved:true,dailyCycleDate:dayIn(),dailyQuotaAlreadyProcessed:processed,dailyQuotaGrantOutcome:processed===false?'newly_processed':processed===true?'already_processed':'unknown'};
 const s=f.service({status:async()=>({known:true,active:true,observed:called,details}),claim:async()=>{called=true;return {observed:true,submitted:true,alreadyProcessed:processed,details};}});
 const r=await s.run('a',f.task,automatic);assert.equal(r.status,'observed');assert.equal(r.operationAttempted,true);assert.equal(r.automaticOperationConfirmed,true);assert.equal(r.automaticRewardConfirmed,false);assert.equal(r.details.dailyQuotaAlreadyProcessed,processed);assert.equal(f.ledger.claimReceipt(f.key).result.automaticRewardConfirmed,false);
});
test('official confirmed Lobster action retains fresh reward provenance',async t=>{
 const f=await fixture(t,'lobster','daily-checkin');let posts=0;
 const r=await f.service({status:async()=>({known:true,active:true,claimed:posts>0}),claim:async()=>{posts++;return {claimed:true,submitted:true};}}).run('a',f.task,automatic);
 assert.equal(r.status,'success');assert.equal(r.automaticOperationConfirmed,true);assert.equal(r.automaticRewardConfirmed,true);assert.equal(posts,1);
});
test('lost response reconciliation confirms official state but does not invent causal reward proof',async t=>{
 const f=await fixture(t,'lobster','daily-checkin');let posts=0;
 const r=await f.service({status:async()=>({known:true,active:true,claimed:posts>0}),claim:async()=>{posts++;throw Error('SAMPLE lost response');}}).run('a',f.task,automatic);
 assert.equal(r.status,'success');assert.equal(r.reconciledAfterError,true);assert.equal(r.automaticRewardConfirmed,false);assert.equal(posts,1);
});
test('a conflicting previous receipt cannot leak old automatic provenance into this run',async t=>{
 const f=await fixture(t,'lobster','daily-checkin');f.ledger.reserve(f.key);f.ledger.finish(f.key,'success',{automaticRewardConfirmed:true,automaticOperationConfirmed:true,trigger:'automatic'});
 const r=await f.service({status:async()=>({known:true,active:true,claimed:false})}).run('a',f.task);
 assert.equal(r.status,'uncertain');assert.equal(r.trigger,'manual');assert.equal(r.automaticRewardConfirmed,false);assert.equal(r.operationAttempted,false);
});
