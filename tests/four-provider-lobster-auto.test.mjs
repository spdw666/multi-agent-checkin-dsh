import test from 'node:test';
import assert from 'node:assert/strict';
import {lobsterClaimCheckin} from '../src/provider-lobster.mjs';

// Exact constraints from the installed official host's validateExecuteInput:
// D:/LobsterAI/resources/app.asar, dist-electron/main/ipcHandlers/activity/handlers.js.
const officialKeyPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const activityCode='daily-check-in-evergreen-prod-20260814';
const secret={accessToken:'fixture-token',principal:'fixture-principal'};
const slot=()=>({code:0,data:{slotState:'available',activity:{activityCode,configRevision:1,activityType:'daily_check_in',timezone:'Asia/Shanghai'}}});
const context=claimed=>({code:0,data:{activityCode,configRevision:1,lifecycleState:'active',authenticated:true,state:{claimedToday:claimed,completed:false,rewardCredits:100,claimedCredits:claimed?100:0},actions:claimed?[]:['check_in']}});

test('the real evergreen activity produces a key accepted by the official host, then one POST confirms',async()=>{
  let claimed=false;const posts=[];
  const fetchImpl=async(url,options)=>{
    if(options.method==='POST'){
      const body=JSON.parse(options.body);posts.push(body);
      // A permissive mock previously hid the production 51103 failure.
      if(!officialKeyPattern.test(body.idempotencyKey))return Response.json({code:51103,message:'Invalid activity idempotency key'});
      assert.deepEqual(Object.keys(body).sort(),['configRevision','idempotencyKey','payload']);
      assert.equal(body.configRevision,1);assert.deepEqual(body.payload,{});claimed=true;
      return Response.json({code:0,data:{success:true}});
    }
    return Response.json(String(url).includes('/slot')?slot():context(claimed));
  };
  const result=await lobsterClaimCheckin(secret,'daily-checkin',{fetchImpl});
  assert.equal(result.claimed,true);assert.equal(result.rechecked,true);assert.equal(posts.length,1);
  assert.equal(posts[0].idempotencyKey.length,59);
  assert.match(posts[0].idempotencyKey,officialKeyPattern);
});

test('idempotency keys stay bounded and distinct without embedding long activity names',async()=>{
  const keys=new Set();
  for(let i=0;i<12;i++){
    let claimed=false;
    await lobsterClaimCheckin(secret,'daily-checkin',{fetchImpl:async(url,options)=>{
      if(options.method==='POST'){const key=JSON.parse(options.body).idempotencyKey;assert.match(key,officialKeyPattern);assert.equal(keys.has(key),false);keys.add(key);claimed=true;return Response.json({code:0,data:{}});}
      return Response.json(String(url).includes('/slot')?slot():context(claimed));
    }});
  }
  assert.equal(keys.size,12);
});

for(const upstreamCode of [51103,51105,51106])test(`official rejection ${upstreamCode} is definitive only after unchanged official recheck`,async()=>{
  await assert.rejects(lobsterClaimCheckin(secret,'daily-checkin',{fetchImpl:async(url,options)=>Response.json(options.method==='POST'?{code:upstreamCode,message:'rejected'}:String(url).includes('/slot')?slot():context(false))}),error=>error.definitiveRejection===true&&error.upstreamCode===upstreamCode&&error.after.claimed===false);
});

test('a network failure remains uncertain, rather than a definitive server rejection',async()=>{
  await assert.rejects(lobsterClaimCheckin(secret,'daily-checkin',{fetchImpl:async(url,options)=>{if(options.method==='POST')throw new Error('connection lost');return Response.json(String(url).includes('/slot')?slot():context(false));}}),error=>error.code==='lobster_network_error'&&error.definitiveRejection!==true);
});

test('manual already-claimed state is read-only and does not assert a new automated grant',async()=>{
  let posts=0;const result=await lobsterClaimCheckin(secret,'daily-checkin',{fetchImpl:async(url,options)=>{if(options.method==='POST')posts++;return Response.json(String(url).includes('/slot')?slot():context(true));}});
  assert.equal(posts,0);assert.equal(result.submitted,false);assert.equal(result.alreadyClaimed,true);
});
