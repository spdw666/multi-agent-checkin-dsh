import test from 'node:test';
import assert from 'node:assert/strict';
import {loomyHealth} from '../src/provider-loomy.mjs';
import {desktopBalance} from '../src/provider-registry.mjs';
const secret={accessToken:'fixture-only'};
const response=data=>new Response(JSON.stringify({code:'000000',data}),{headers:{'content-type':'application/json'}});
async function health(pet){return loomyHealth(secret,{fetchImpl:async(url,init)=>{assert.equal(init.method,'GET');if(url.endsWith('/pet-work'))return pet instanceof Error?Promise.reject(pet):response(pet);if(url.includes('/points/records'))return response({availableBalance:123,dailyBalance:100});if(url.endsWith('/models'))return response([]);return response({});}});}
const base={businessDate:'2026-10-11',configVersion:'fixture-version',claimed:false};
for(const [name,pet,expected] of [
 ['native progress without reached tier',{businessDate:'2026-10-11',config:{version:'v1'},status:{earnedPointsToday:0,rewardedTierIds:[]}},false],
 ['explicit eligibility requires every server marker',{...base,reachedTierId:'tier1'},true],
 ['missing business date',{...base,businessDate:undefined,reachedTierId:'tier1'},null],
 ['missing config version',{...base,configVersion:undefined,reachedTierId:'tier1'},null],
 ['already claimed',{...base,claimed:true,reachedTierId:'tier1'},false],
 ['empty snapshot',{},null],
 ['empty nested status',{status:{}},null],
 ['pet endpoint failed',new Error('fixture unavailable'),null],
])test('Loomy health reward eligibility: '+name,async()=>{const h=await health(pet);assert.equal(h.checkin.claimable,expected);assert.equal(h.checkin.kind,'pet_work');const b=desktopBalance(h);assert.equal(b.claimable,expected);assert.equal(b.checkinKind,'pet_work');assert.equal(b.value,123);assert.equal(b.credentialStatus,'authenticated');});
test('desktop generic checkin retains original flags',()=>{const b=desktopBalance({checkin:{known:true,claimed:true},balance:{value:0,unit:'points'}});assert.equal(b.checkedIn,true);assert.equal(b.checkinKnown,true);assert.equal(b.claimable,null);assert.equal(b.checkinKind,null);assert.equal(b.value,0);});
