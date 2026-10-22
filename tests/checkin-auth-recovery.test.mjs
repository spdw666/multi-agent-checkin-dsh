import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Platforms} from '../src/platforms.mjs';
import {CredentialManager} from '../src/credentials.mjs';
import {lobsterProvider} from '../src/provider-lobster.mjs';
import {Ledger} from '../src/store.mjs';
import {dayIn} from '../src/util.mjs';

const rejection=(status=401)=>Object.assign(Error('fixture credential rejected'),{code:'WORKBUDDY_CREDENTIAL_REJECTED',status});
const official=(claimed=false)=>({active:true,todayCheckedIn:claimed,todayCredit:claimed?100:0});
function fixture(resolve){
  const account={id:'fixture-wb',platform:'workbuddy'},seen=[];
  const credentials={account:()=>account,async resolve(id,options){seen.push({id,options});return {principalHash:'fixture-owner',...(resolve?await resolve(id,options):{accessToken:'fixture-old'})};}};
  return {platforms:new Platforms({value:{accounts:[account]}},credentials),seen};
}
test('WB successful read-only checkin status does not force a renewal',async()=>{
  const {platforms:p,seen}=fixture();let reads=0;
  p.wb.fetchCheckinStatus=async()=>{reads++;return official(false)};
  assert.deepEqual(await p.status('fixture-wb','daily-checkin'),{known:true,active:true,claimed:false,credits:0,details:official(false)});
  assert.equal(reads,1);assert.deepEqual(seen,[{id:'fixture-wb',options:undefined}]);
});
test('WB checkin status 401 renews once and returns only the fresh official result',async()=>{
  const {platforms:p,seen}=fixture((_id,options)=>({accessToken:options?.renew?'fixture-new':'fixture-old',principalHash:'fixture-owner'}));
  const tokens=[];let writes=0;
  p.wb.fetchCheckinStatus=async c=>{tokens.push(c.accessToken);if(c.accessToken==='fixture-old')throw rejection();return official(true)};
  p.wb.claimDailyCheckin=async()=>{writes++;assert.fail('status must not claim')};
  const s=await p.status('fixture-wb','daily-checkin');
  assert.equal(s.claimed,true);assert.equal(s.credits,100);assert.deepEqual(tokens,['fixture-old','fixture-new']);
  assert.deepEqual(seen[1],{id:'fixture-wb',options:{force:true,renew:true,rejectedAccessToken:'fixture-old'}});assert.equal(writes,0);
});
test('WB rejected unchanged credential is not sent to checkin status a second time',async()=>{
  const {platforms:p,seen}=fixture();const error=rejection();let reads=0;
  p.wb.fetchCheckinStatus=async()=>{reads++;throw error};
  await assert.rejects(p.status('fixture-wb','daily-checkin'),e=>e===error);
  assert.equal(reads,1);assert.equal(seen.length,2);assert.equal(seen[1].options.renew,true);
});
test('WB checkin recheck failing with 401 does not enter a renewal loop',async()=>{
  const {platforms:p,seen}=fixture((_id,options)=>({accessToken:options?.renew?'fixture-new':'fixture-old'}));let reads=0;
  const first=rejection(),second=rejection();
  p.wb.fetchCheckinStatus=async()=>{reads++;throw reads===1?first:second};
  await assert.rejects(p.status('fixture-wb','daily-checkin'),e=>e===second);
  assert.equal(reads,2);assert.equal(seen.length,2);
});
for(const status of [403,429,502])test(`WB status HTTP ${status} does not consume a refresh token`,async()=>{
  const {platforms:p,seen}=fixture();const error=rejection(status);let reads=0;
  p.wb.fetchCheckinStatus=async()=>{reads++;throw error};
  await assert.rejects(p.status('fixture-wb','daily-checkin'),e=>e===error);assert.equal(reads,1);assert.equal(seen.length,1);
});
test('WB status transport failure is not treated as credential rejection',async()=>{
  const {platforms:p,seen}=fixture();const error=Error('fixture timeout');
  p.wb.fetchCheckinStatus=async()=>{throw error};await assert.rejects(p.status('fixture-wb','daily-checkin'),e=>e===error);assert.equal(seen.length,1);
});
test('WB uncertain renewal propagates without rechecking or resubmitting the claim',async()=>{
  const error=Object.assign(Error('fixture refresh unconfirmed'),{code:'wb_refresh_unconfirmed',status:503});
  const {platforms:p,seen}=fixture((_id,options)=>{if(options?.renew)throw error;return {accessToken:'fixture-old'}});let reads=0;
  p.wb.fetchCheckinStatus=async()=>{reads++;throw rejection()};
  await assert.rejects(p.status('fixture-wb','daily-checkin'),e=>e===error);assert.equal(reads,1);assert.equal(seen.length,2);
});
test('WB renewed checkin credential retains the same bound principal',async()=>{
  const {platforms:p,seen}=fixture((_id,options)=>({accessToken:options?.renew?'fixture-new':'fixture-old',principalHash:options?.renew?'different-owner':'fixture-owner'}));let reads=0;
  p.wb.fetchCheckinStatus=async()=>{reads++;throw rejection()};
  await assert.rejects(p.status('fixture-wb','daily-checkin'),{code:'principal_changed'});assert.equal(reads,1);assert.equal(seen.length,2);
});
test('WB claim POST 401 is never automatically renewed or replayed by Platforms.claim',async()=>{
  const {platforms:p,seen}=fixture();const error=rejection();let writes=0;
  p.wb.claimDailyCheckin=async()=>{writes++;throw error};
  await assert.rejects(p.claim('fixture-wb','daily-checkin'),e=>e===error);assert.equal(writes,1);assert.equal(seen.length,1);
});

async function ownedFixture(t,{owned=true}={}){
  const dir=await mkdtemp(join(tmpdir(),'checkin-auth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const account={id:'fixture-wb',platform:'workbuddy',credentials:{kind:'file',file:owned?join(dir,'accounts','fixture-wb','workbuddy-session.json'):join(dir,'native.json')}};
  const file=account.credentials.file;await mkdir(join(file,'..'),{recursive:true});
  const raw={accessToken:'fixture-old',refreshToken:'fixture-rt',principal:'fixture-user',uid:'fixture-user',expiresAtMs:Date.now()+3600000,domain:'www.workbuddy.cn',edition:'cn'};
  await writeFile(file,JSON.stringify(raw));
  const config={dataDir:dir,path:p=>p,value:{accounts:[account]}},credentials=new CredentialManager(config,{bind:(_id,_platform,principal)=>({ok:principal==='fixture-user',fingerprint:'fixture-owner'})});
  return {platforms:new Platforms(config,credentials),credentials,file,raw};
}
test('WB status401 integrates the owned credential rotation and atomically persists the fresh session',async t=>{
  const {platforms:p,credentials,file,raw}=await ownedFixture(t);let rotations=0,reads=0;
  credentials.workbuddyRefresh=async current=>{rotations++;return {...current,accessToken:'fixture-new',refreshToken:'fixture-next-rt'}};
  p.wb.fetchCheckinStatus=async c=>{reads++;if(c.accessToken==='fixture-old')throw rejection();return official(true)};
  assert.equal((await p.status('fixture-wb','daily-checkin')).claimed,true);assert.equal(rotations,1);assert.equal(reads,2);
  const saved=JSON.parse(await readFile(file));assert.equal(saved.accessToken,'fixture-new');assert.equal(saved.refreshToken,'fixture-next-rt');assert.equal(saved.principal,raw.principal);
});
test('WB status401 leaves an arbitrary user-selected credential file unchanged',async t=>{
  const {platforms:p,credentials,file}=await ownedFixture(t,{owned:false});const before=await readFile(file,'utf8');let rotations=0,reads=0;
  credentials.workbuddyRefresh=async()=>{rotations++;assert.fail('native credential is read-only')};const error=rejection();
  p.wb.fetchCheckinStatus=async()=>{reads++;throw error};
  await assert.rejects(p.status('fixture-wb','daily-checkin'),e=>e===error);assert.equal(rotations,0);assert.equal(reads,1);assert.equal(await readFile(file,'utf8'),before);
});

for(const [name,status,expected] of [
  ['explicitly claimable',{known:true,claimable:true,claimed:false},true],
  ['explicitly not claimable',{known:true,claimable:false,claimed:false},false],
  ['pending official confirmation',{known:true,claimable:false,pendingConfirmation:true},true],
  ['explicit active false',{known:true,active:false,claimable:true},false],
  ['missing capability',{known:true,claimed:false},undefined],
  ['non-boolean capability',{known:true,claimable:'true'},undefined],
])test('desktop status active normalization: '+name,async()=>{
  const original=lobsterProvider.status,before=structuredClone(status);let claims=0;
  lobsterProvider.status=async()=>status;
  const p=new Platforms({value:{}},{account:()=>({id:'fixture-lobster',platform:'lobster'}),resolve:async()=>({accessToken:'fixture-lobster-token'})});
  p.claim=async()=>{claims++;assert.fail('status must not mutate')};
  try{const result=await p.status('fixture-lobster','daily-checkin');assert.equal(result.active,expected);assert.equal(result.claimable,status.claimable);assert.equal(claims,0);assert.deepEqual(status,before)}finally{lobsterProvider.status=original;}
});

async function loomyFixture(t,{oldDay=false,otherPrincipal=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'checkin-loomy-')),ledger=new Ledger(dir),originalFetch=globalThis.fetch;
  t.after(async()=>{globalThis.fetch=originalFetch;ledger.close();await rm(dir,{recursive:true,force:true})});
  const stamp=new Date(Date.now()-(oldDay?86400000:1000)).toISOString(),day=dayIn(new Date(stamp),'Asia/Shanghai');
  const task='daily-quota',owner=otherPrincipal?'fixture-other-owner':'fixture-loomy-owner';
  const key=ledger.claimKey('loomy',owner,day,task);ledger.reserve(key);
  ledger.finish(key,'observed',{observationSchema:1,observationVerifiedDay:day,details:{dailyQuotaObserved:true,dailyCycleDate:day,dailyQuota:5000,dailyQuotaObservedAt:stamp,dailyQuotaSource:'/api/v1/points/first-login'}});
  const requests=[];globalThis.fetch=async(url,options={})=>{requests.push({url:String(url),method:options.method??'GET'});return Response.json({code:'000000',data:{availableBalance:9900,balance:5000,dailyBalance:4900}})};
  const account={id:'fixture-loomy',platform:'loomy',tasks:[{id:task,enabled:true}]};
  const p=new Platforms({value:{accounts:[account]}},{account:()=>account,ledger,resolve:async()=>({principalHash:'fixture-loomy-owner',principal:'fixture-loomy-user',accessToken:'fixture-cold-session'})});
  return {p,requests};
}
test('Loomy cold status restores same-principal current-day official receipt alongside a fresh balance',async t=>{
  const {p,requests}=await loomyFixture(t);const status=await p.status('fixture-loomy','daily-quota');
  assert.equal(status.observed,true);assert.equal(status.active,false);assert.equal(status.claimable,false);assert.equal(status.details.dailyQuota,5000);
  assert.equal(status.details.value,9900);assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');assert.ok(requests[0].url.includes('/points/records'));
});
for(const [name,options] of [['prior-day',{oldDay:true}],['different-principal',{otherPrincipal:true}]])test(`Loomy status does not restore a ${name} receipt`,async t=>{
  const {p,requests}=await loomyFixture(t,options);const status=await p.status('fixture-loomy','daily-quota');
  assert.equal(status.observed,false);assert.equal(status.active,true);assert.equal(status.details.dailyQuotaObserved,false);assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');
});
test('Loomy status fresh balance GET failure is not replaced with a durable success receipt',async t=>{
  const {p,requests}=await loomyFixture(t);globalThis.fetch=async()=>{requests.push({method:'GET'});return new Response('{}',{status:503})};
  await assert.rejects(p.status('fixture-loomy','daily-quota'));assert.equal(requests.length,1);
});
