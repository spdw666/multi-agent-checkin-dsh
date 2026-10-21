import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {ClaimService}=await import(pathToFileURL(resolve(root,'src/claims.mjs')));
const {Ledger}=await import(pathToFileURL(resolve(root,'src/store.mjs')));
const {Platforms}=await import(pathToFileURL(resolve(root,'src/platforms.mjs')));
const {dayIn}=await import(pathToFileURL(resolve(root,'src/util.mjs')));

test('a fresh CodeArts lease with an already CLAIMED campaign must not credit another acquisition',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codearts-review-pending-')),ledger=new Ledger(dir);
  let confirmed=false;
  try{
    const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'codearts',tasks:[{id:'daily-checkin',enabled:true}]}]}};
    const platforms={status:async()=>({known:true,active:true,pendingConfirmation:!confirmed,claimed:confirmed,status:confirmed?'CONFIRMED':'CLAIMED'}),claim:async()=>{confirmed=true;return {submitted:true,confirmed:true,claimed:true};}};
    const result=await new ClaimService(config,{resolve:async()=>({principalHash:'fixture-codearts'})},platforms,ledger).run('a','daily-checkin',{trigger:'automatic',source:'startup'});
    assert.equal(result.status,'success');assert.equal(result.automaticOperationConfirmed,true);
    assert.equal(result.automaticRewardConfirmed,false,'a campaign already CLAIMED before this run is confirmation-only');
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('actual Platforms plus Loomy adapter recover an uncertain empty first-login without reopening pet rewards',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'loomy-review-real-stack-')),ledger=new Ledger(dir),previousFetch=globalThis.fetch;
  const day=dayIn(new Date(),'Asia/Shanghai');let posts=0,grants=0,processed=false;
  const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'loomy',tasks:[{id:'daily-quota',enabled:true}]}]}};
  const credentials={ledger,account:()=>config.value.accounts[0],resolve:async()=>({principalHash:'fixture-owner-real-stack',principal:'fixture-owner-real-stack',accessToken:'fixture-token-real-stack'})};
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;
    if(options.method==='POST'){
      assert.equal(path,'/api/v1/points/first-login');assert.deepEqual(JSON.parse(options.body),{});posts++;
      if(!processed){processed=true;grants++;}
      if(posts===1)throw new Error('transport failed after server commit');
      return Response.json({code:'000000',data:{alreadyProcessed:true,currentBalance:10000,dailyBalance:5000,dailyQuota:5000,dailyCycleDate:day}});
    }
    assert.equal(path,'/api/v1/points/records');return Response.json({code:'000000',data:{availableBalance:processed?10000:5000,dailyBalance:processed?5000:0,balance:5000}});
  };
  try{
    const service=new ClaimService(config,credentials,new Platforms(config,credentials),ledger);
    const first=await service.run('a','daily-quota',{trigger:'automatic',source:'startup'});
    assert.equal(first.status,'uncertain');assert.equal(first.automaticRewardConfirmed,false);
    const second=await service.run('a','daily-quota',{trigger:'automatic',source:'retry'});
    assert.equal(second.status,'observed');assert.equal(second.automaticOperationConfirmed,true);assert.equal(second.automaticRewardConfirmed,false);
    assert.equal(second.benefitOutcome,'already_processed');assert.equal(second.details.dailyQuotaGrantOutcome,'already_processed');assert.equal(posts,2);assert.equal(grants,1);
  }finally{globalThis.fetch=previousFetch;ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('actual Raccoon recovery replaces an old unknown write with GET initialization and an exact extended daily bill',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'raccoon-review-real-stack-')),ledger=new Ledger(dir),previousFetch=globalThis.fetch;
  const day=dayIn(new Date(),'Asia/Shanghai'),dayEnd=Date.parse(day+'T00:00:00+08:00')+86400000;
  const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'raccoon',tasks:[{id:'daily-quota',enabled:true}]}]}};
  const credentials={ledger,account:()=>config.value.accounts[0],resolve:async()=>({principalHash:'fixture-raccoon-real-stack',principal:'fixture-raccoon-real-stack',authKind:'bearer',accessToken:'fixture-token'})};
  const key=ledger.claimKey('raccoon','fixture-raccoon-real-stack',day,'daily-quota','');
  ledger.reserve(key);ledger.finish(key,'uncertain',{reason:'old_wrong_endpoint'});
  const operations=[];let initialized=false;
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;assert.equal(options.method,'GET');
    if(path==='/api/web/points/v1/balance')return Response.json({code:0,data:{daily_points:300,available_points:5300}});
    if(path==='/api/web/points/v1/bills')return Response.json({code:0,data:{items:[{biz_type:'daily_grant',points:300,grant_at:day+'T00:00:00+08:00',expire_at:new Date(initialized?dayEnd+86400000:dayEnd-1000).toISOString()}]}});
    assert.equal(options.headers['X-Org-Code'],'');operations.push(path);
    if(path==='/api/web/office/v3/setting_info')initialized=true;
    else assert.equal(path,'/api/web/auth/v1/user_info');
    return Response.json({code:0,data:{}});
  };
  try{
    const result=await new ClaimService(config,credentials,new Platforms(config,credentials),ledger).run('a','daily-quota',{trigger:'automatic',source:'retry'});
    assert.equal(result.status,'observed');assert.equal(result.automaticOperationConfirmed,true);assert.equal(result.automaticRewardConfirmed,false);
    assert.equal(result.benefitOutcome,'daily_validity_extended');assert.equal(result.details.receipt.loginExtended,true);
    assert.deepEqual(operations,['/api/web/auth/v1/user_info','/api/web/office/v3/setting_info']);
  }finally{globalThis.fetch=previousFetch;ledger.close();await rm(dir,{recursive:true,force:true});}
});
