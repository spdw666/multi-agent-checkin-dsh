import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=process.env.VIDEO_SUMMARY_TEST_ROOT?pathToFileURL(resolve(process.env.VIDEO_SUMMARY_TEST_ROOT)+'/'):new URL('../',import.meta.url);
const {refreshAccountBalance}=await import(new URL('src/balances.mjs',root));
const {createVideoDailyProvider}=await import(new URL('src/provider-video-daily.mjs',root));
const {dayIn}=await import(new URL('src/util.mjs',root));
const {Scheduler}=await import(new URL('src/scheduler.mjs',root));

function fixture(platform,checkin,{receipt,websiteUrl,principalHash='SAMPLE_BOUND',value=100}={}){
 const account={id:'SAMPLE_ACCOUNT',platform,edition:'cn',enabled:true,credentials:{kind:'file',file:'SAMPLE_FILE'}};
 const keys=[],calls={writes:0,claims:0,reads:0};
 const service={config:{value:{accounts:[account],scheduler:{timezone:'Asia/Shanghai'}}},ledger:{principalHash:()=>principalHash,claimKey:(...args)=>{keys.push(args);return 'SAMPLE_KEY';},claimReceipt:()=>receipt,observeBalance:()=>{calls.writes++;}},platforms:{health:async()=>{calls.reads++;return {status:'authenticated',balance:{value,unit:'积分'},checkin,websiteUrl};}},claims:{run:()=>{calls.claims++;}}};
 return {account,service,keys,calls,read:()=>refreshAccountBalance(service,account,{observe:false})};
}
function officialVidu(amount=0,overrides={}){
 const now=new Date(),day=dayIn(now,'Asia/Shanghai');
 return {status:amount>0?'success':'observed',result:{serverConfirmed:true,claimed:amount>0,credits:amount,benefitOutcome:amount>0?'newly_granted':'no_new_daily_credit',officialDailyReceipt:{source:'/iam/v1/users/every-day-credit',day,amount,checkedAt:now.toISOString()},...overrides}};
}
const endpointStatus={known:true,active:true,claimed:null,reason:'daily_login_grant_endpoint_available'};

for(const platform of ['vidu','pixverse','jimeng','kling','xiaoyunque','hailuo','liblib'])test(platform+' keeps official claimed status separate from balance and automation',async()=>{
 const f=fixture(platform,{known:true,active:false,claimed:true,credits:20}),row=await f.read();
 assert.equal(row.dailyCheckin?.status,'claimed');assert.equal(row.checkedIn,true);assert.equal(row.dailyCheckin.credits,20);assert.equal(row.claimable,false);assert.equal(f.calls.claims,0);assert.equal(f.calls.writes,0);assert.equal(row.automaticRewardConfirmed,undefined);
});
test('Vidu retains same-principal/day official zero without showing pending or inventing a positive reward',async()=>{
 const f=fixture('vidu',endpointStatus,{receipt:officialVidu(),value:20}),row=await f.read();
 assert.equal(row.dailyCheckin?.status,'observed');assert.equal(row.dailyCheckin.credits,0);assert.equal(row.dailyCheckin.known,true);assert.equal(row.dailyCheckin.reason,'official_daily_zero_receipt_retained');assert.equal(row.checkedIn,null);assert.equal(row.claimable,false);assert.equal(row.value,20);assert.deepEqual(f.keys[0],['vidu','SAMPLE_BOUND',dayIn(new Date(),'Asia/Shanghai'),'daily-checkin','']);assert.equal(f.calls.claims,0);
});
test('Vidu positive retained official receipt restores claimed, never a new automatic grant',async()=>{
 const f=fixture('vidu',endpointStatus,{receipt:officialVidu(20)}),row=await f.read();assert.equal(row.dailyCheckin?.status,'claimed');assert.equal(row.checkedIn,true);assert.equal(row.dailyCheckin.source,'retained_official_daily_receipt');assert.equal(row.automaticRewardConfirmed,undefined);
});
for(const [name,mutate] of [
 ['no principal binding',f=>{f.service.ledger.principalHash=()=>undefined;}],
 ['wrong date',(_f,r)=>{r.result.officialDailyReceipt.day='2000-01-01';}],
 ['future date',(_f,r)=>{r.result.officialDailyReceipt.checkedAt='2099-01-01T00:00:00Z';}],
 ['wrong source',(_f,r)=>{r.result.officialDailyReceipt.source='/SAMPLE_WRONG';}],
 ['unconfirmed',(_f,r)=>{r.result.serverConfirmed=false;}],
 ['uncertain',(_f,r)=>{r.status='uncertain';}],
 ['mismatched amount',(_f,r)=>{r.result.credits=1;}],
 ['forged positive claimed',(_f,r)=>{r.result.claimed=true;}],
 ['no zero provenance',(_f,r)=>{delete r.result.benefitOutcome;}]
])test('Vidu rejects '+name+' receipt, does not infer claimed from balance',async()=>{
 const receipt=officialVidu(),f=fixture('vidu',endpointStatus,{receipt,value:20});mutate(f,receipt);const row=await f.read();assert.equal(row.dailyCheckin?.status,'unknown');assert.equal(row.checkedIn,null);assert.equal(row.claimable,null);assert.equal(row.dailyCheckin.credits,null);assert.equal(f.calls.claims,0);
});
for(const [platform,reason] of [['kling','membership_required'],['hailuo','current_free_trial_no_verified_daily']])test(platform+' current no-daily qualification is not pending or claimed',async()=>{
 const row=await fixture(platform,{known:true,active:false,claimed:null,reason}).read();assert.equal(row.dailyCheckin?.status,'not_available');assert.equal(row.dailyCheckin.reason,reason);assert.equal(row.checkedIn,null);assert.equal(row.claimable,false);
});
test('official eligible unclaimed status alone shows claimable; unknown health stays tri-state',async()=>{
 const a=await fixture('pixverse',{known:true,active:true,claimed:false,credits:30}).read();assert.equal(a.dailyCheckin?.status,'claimable');assert.equal(a.checkedIn,false);assert.equal(a.claimable,true);
 const b=await fixture('jimeng',{known:false,active:true,claimed:false}).read();assert.equal(b.dailyCheckin?.status,'unknown');assert.equal(b.checkedIn,null);assert.equal(b.claimable,null);
});
for(const [platform,url] of [['kling','https://klingai.com'],['hailuo','https://hailuoai.video'],['liblib','https://www.liblib.art']])test(platform+' uses actual validated regional website origin',async()=>{
 const row=await fixture(platform,{known:true,claimed:true},{websiteUrl:url}).read();assert.equal(row.websiteUrl,url);
 const bad=await fixture(platform,{known:true,claimed:true},{websiteUrl:'https://HOST.invalid/'}).read();assert.equal(bad.websiteUrl,undefined);
});
test('checkin error does not become pending or erase independent known balance',async()=>{
 const row=await fixture('jimeng',{known:false,error:'SAMPLE_OFFLINE'}).read();assert.equal(row.dailyCheckin?.status,'check_failed');assert.equal(row.checkedIn,null);assert.equal(row.value,100);
});
test('provider next window survives balance overview',async()=>{
 const next='2026-10-28T00:00:00.000Z',row=await fixture('pixverse',{known:true,claimed:true,nextClaimAt:next}).read();assert.equal(row.dailyCheckin?.nextClaimAt,next);assert.equal(row.nextClaimAt,next);
});
test('a cached prior-day video claimed badge is refreshed even inside the sixty-second balance TTL',async()=>{
 const f=fixture('jimeng',{known:true,active:false,claimed:true});
 f.service.balanceCache=new Map([[f.account.id,{accountId:f.account.id,platform:'jimeng',edition:'cn',checkedAt:new Date().toISOString(),checkedIn:true,value:1,dailyCheckin:{day:'2000-01-01',status:'claimed',todayCheckedIn:true}}]]);
 const row=await refreshAccountBalance(f.service,f.account,{refresh:false,observe:false});assert.equal(f.calls.reads,1);assert.equal(row.value,100);assert.equal(row.dailyCheckin.day,dayIn(new Date(),'Asia/Shanghai'));
});
test('Vidu explicitly schedules next China midnight, PixVerse keeps next UTC midnight',async()=>{
 const now=()=>new Date('2026-10-27T13:00:00.000Z'),vidu=createVideoDailyProvider('vidu',{now,fetchImpl:async()=>Response.json({credits:20})});
 const s=await vidu.status({});assert.equal(s.nextClaimAt,'2026-10-27T16:00:00.000Z');assert.equal(s.claimed,null);
 const pix=createVideoDailyProvider('pixverse',{now,fetchImpl:async()=>Response.json({ErrCode:0,Resp:[{task_type:1,sub_type:1,progress:3,reward:30}]})});assert.equal((await pix.status({})).nextClaimAt,'2026-10-28T00:00:00.000Z');
});
test('startup replaces an old settled Vidu null-window plan before the next noon gate',async()=>{
 const account={id:'SAMPLE',platform:'vidu',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]},config={value:{accounts:[account],scheduler:{enabled:true,startup:true,timezone:'Asia/Shanghai',hour:12,minute:0,jitterSeconds:0,retryMinutes:60}}},values=new Map(),ledger={get:key=>values.get(key),set:(key,value)=>values.set(key,structuredClone(value))};
 const date=new Date(),day=dayIn(date,'Asia/Shanghai'),nextClaimAt=new Date(Date.parse(day+'T00:00:00+08:00')+86400000).toISOString();let calls=0;
 const scheduler=new Scheduler(config,{all:async()=>{calls++;return [{accountId:'SAMPLE',task:'daily-checkin',status:'observed',day,nextClaimAt,reason:'official_daily_zero_receipt_retained'}];}},ledger),context=scheduler.context();
 ledger.set('schedule-last',{schemaVersion:2,day,dailyDay:day,signature:context.signature,dailySignature:context.signature,at:date.getTime(),tasks:[{accountId:'SAMPLE',task:'daily-checkin',status:'observed',day,signature:context.signature,nextClaimAt:null,retryDue:null}]});
 try{scheduler.start();await Promise.all([...scheduler.jobs]);assert.equal(calls,1);assert.equal(ledger.get('schedule-last').tasks[0].nextClaimAt,nextClaimAt);assert.equal(ledger.get('schedule-last').source,'startup');}finally{await scheduler.stop();}
});
