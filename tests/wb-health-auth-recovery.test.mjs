import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {Platforms}=await import(pathToFileURL(join(root,'src/platforms.mjs')));
const {CredentialManager}=await import(pathToFileURL(join(root,'src/credentials.mjs')));
const {Ledger}=await import(pathToFileURL(join(root,'src/store.mjs')));
const {workBuddySummary}=await import(pathToFileURL(join(root,'src/workbuddy-management.mjs')));
const {workBuddyFailure}=await import(pathToFileURL(join(root,'src/workbuddy-status.mjs')));
const {hash}=await import(pathToFileURL(join(root,'src/util.mjs')));
const old={accessToken:'SAMPLE-old',principal:'SAMPLE-owner',principalHash:'SAMPLE-bound',uid:'SAMPLE-owner',domain:'www.workbuddy.cn',edition:'cn'},fresh={...old,accessToken:'SAMPLE-new'};
const checkin=()=>({active:true,todayCheckedIn:true,todayCredit:100});
const packages=()=>Response.json({code:0,data:{Response:{Data:{Accounts:[{AccountId:'SAMPLE-pack',CapacitySize:100,CapacityRemain:90}],TotalCount:1}}}});
const denied=(status=401)=>new Response('<html>SAMPLE non-json auth page</html>',{status,headers:{'content-type':'text/html'}});
function setup(t,{renew=()=>fresh,credit,check}={}){
 const previous=globalThis.fetch,requests=[],resolves=[],checks=[],account={id:'SAMPLE-wb',platform:'workbuddy',edition:'cn'};
 globalThis.fetch=async(url,init)=>{requests.push({path:new URL(url).pathname,token:init.headers.Authorization,method:init.method});return credit?credit(init,requests.length):init.headers.Authorization==='Bearer '+old.accessToken?denied():packages();};
 t.after(()=>{globalThis.fetch=previous;});
 const credentials={account:()=>account,async resolve(id,options){resolves.push(options);return options?.renew?renew():old;}};
 const p=new Platforms({value:{accounts:[account]}},credentials);p.wb.fetchCheckinStatus=async c=>{checks.push(c.accessToken);return check?check(c,checks.length):checkin();};
 p.wb.claimDailyCheckin=async()=>assert.fail('read recovery must not claim');
 return {p,resolves,requests,checks};
}
test('actual credit HTTP401 renews exactly once and fresh package/check-in reads settle health',async t=>{
 const f=setup(t),h=await f.p.health('SAMPLE-wb');assert.equal(h.status,'authenticated');assert.equal(h.credits.total,90);assert.equal(h.checkin.todayCheckedIn,true);
 assert.deepEqual(f.resolves,[{force:true},{force:true,renew:true,rejectedAccessToken:old.accessToken}]);assert.deepEqual(f.checks,['SAMPLE-old']);assert.equal(f.requests.length,2);
});
test('unchanged rejected token is not sent again',async t=>{
 const f=setup(t,{renew:()=>old});await assert.rejects(f.p.health('SAMPLE-wb'),e=>e.status===401);assert.equal(f.requests.length,1);assert.equal(f.resolves.length,2);
});
for(const status of [403,429,502])test(`credit HTTP${status} does not consume native or rotating refresh credentials`,async t=>{
 const f=setup(t,{credit:()=>denied(status)});await assert.rejects(f.p.health('SAMPLE-wb'),e=>e.status===status);assert.equal(f.resolves.length,1);assert.equal(f.requests.length,1);
});
test('HTTP200 malformed JSON is a schema failure, not authentication recovery',async t=>{
 const f=setup(t,{credit:()=>new Response('SAMPLE invalid-json',{status:200})});await assert.rejects(f.p.health('SAMPLE-wb'),e=>e.status===502);assert.equal(f.resolves.length,1);
});
test('a second official401 stops without renewal loop',async t=>{
 const f=setup(t,{credit:()=>denied()});await assert.rejects(f.p.health('SAMPLE-wb'),e=>e.status===401);assert.equal(f.resolves.length,2);assert.equal(f.requests.length,2);
});
test('changed bound principal cannot be used for balance retry',async t=>{
 const f=setup(t,{renew:()=>({...fresh,principalHash:'SAMPLE-other'})});await assert.rejects(f.p.health('SAMPLE-wb'),{code:'principal_changed'});assert.equal(f.requests.length,1);
});
test('missing binding proof cannot replace a bound principal',async t=>{
 const f=setup(t,{renew:()=>({...fresh,principalHash:undefined})});await assert.rejects(f.p.health('SAMPLE-wb'),{code:'principal_changed'});assert.equal(f.requests.length,1);
});
test('an old credential without any stable identity cannot authorize a refreshed balance read',async t=>{
 const f=setup(t);f.p.credentials.resolve=async(_id,options)=>({accessToken:options?.renew?'SAMPLE-new':'SAMPLE-old'});
 await assert.rejects(f.p.health('SAMPLE-wb'),{code:'wb_read_refresh_identity_unverified'});assert.equal(f.requests.length,1);
});
test('edition mismatch cannot cross the CN/AI native login boundary',async t=>{
 const f=setup(t,{renew:()=>({...fresh,edition:'ai',domain:'www.workbuddy.ai'})});await assert.rejects(f.p.health('SAMPLE-wb'),{code:'wb_login_domain_mismatch'});assert.equal(f.requests.length,1);
});
test('native verification failure is propagated rather than showing a fake recovered balance',async t=>{
 const error=Object.assign(Error('SAMPLE native verification pending'),{code:'wb_native_verification_unconfirmed',status:502}),f=setup(t,{renew:()=>{throw error}});
 await assert.rejects(f.p.health('SAMPLE-wb'),e=>e===error);assert.equal(f.requests.length,1);
});
test('check-in-only401 can recover without discarding a good balance',async t=>{
 const f=setup(t,{credit:()=>packages(),check:c=>{if(c.accessToken===old.accessToken)throw Object.assign(Error('SAMPLE unauthorized'),{status:401});return checkin();}});
 const h=await f.p.health('SAMPLE-wb');assert.equal(h.credits.total,90);assert.equal(h.checkin.todayCheckedIn,true);assert.equal(f.requests.length,1);
});
test('recovering only the failed daily query never overwrites this run verified balance with a second transport failure',async t=>{
 const f=setup(t,{credit:(_init,n)=>n===1?packages():denied(503),check:c=>{if(c.accessToken===old.accessToken)throw Object.assign(Error('SAMPLE unauthorized'),{status:401});return checkin();}});
 const h=await f.p.health('SAMPLE-wb');assert.equal(h.credits.total,90);assert.equal(h.checkin.todayCheckedIn,true);assert.equal(f.requests.length,1);assert.deepEqual(f.checks,['SAMPLE-old','SAMPLE-new']);
});
test('failed check-in recovery keeps fresh credits but explicitly unknown daily status',async t=>{
 const f=setup(t,{credit:()=>packages(),renew:()=>{throw Object.assign(Error('SAMPLE offline'),{status:503,code:'wb_refresh_unconfirmed'})},check:()=>{throw Object.assign(Error('SAMPLE unauthorized'),{status:401});}});
 const h=await f.p.health('SAMPLE-wb');assert.equal(h.credits.total,90);assert.equal(h.checkin.todayCheckedIn,null);assert.equal(h.checkinError.code,'wb_refresh_unconfirmed');assert.equal(f.requests.length,1);
});
test('already valid health does not read native login or refresh tokens',async t=>{
 const f=setup(t,{credit:()=>packages()});assert.equal((await f.p.health('SAMPLE-wb')).credits.total,90);assert.deepEqual(f.resolves,[{force:true}]);
});
test('HTTP response media type survives sanitized management error persistence',()=>{
 const e=Object.assign(Error('SAMPLE auth failed'),{status:401,contentType:'text/html'});assert.equal(workBuddyFailure(e).contentType,'text/html');assert.equal(workBuddyFailure(e).banned,false);assert.equal(workBuddyFailure({...e,contentType:'text/html; secret=SAMPLE'}).contentType,undefined);
});
test('real CredentialManager→Platforms→summary recovers access-only revoked slot from verified native login without configuration/ban-toggle edits',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'wb-native-health-')),file=join(dir,'accounts','SAMPLE-wb','workbuddy-session.json'),nativeFile=join(dir,'native.info'),ledger=new Ledger(dir);
 t.after(async()=>{ledger.close();await rm(dir,{recursive:true,force:true});});await mkdir(join(file,'..'),{recursive:true});await writeFile(file,JSON.stringify({...old,principalHash:undefined,expiresAtMs:Date.now()+3600000}));await writeFile(nativeFile,'SAMPLE native immutable bytes');
 const account={id:'SAMPLE-wb',platform:'workbuddy',enabled:true,inferenceEnabled:false,edition:'cn',credentials:{kind:'file',file},tasks:[]},config={path:p=>p,dataDir:dir,value:{accounts:[account],routes:[],upstreams:[],workbuddy:{}}},before=JSON.stringify(config.value),credentials=new CredentialManager(config,ledger),p=new Platforms(config,credentials);
 const globalFetch=globalThis.fetch;let reads=0,nativeReads=0,refreshes=0;
 globalThis.fetch=async(_url,init)=>{reads++;return init.headers.Authorization==='Bearer '+old.accessToken?denied():packages();};t.after(()=>{globalThis.fetch=globalFetch;});
 credentials.workbuddyNativeRead=async()=>{nativeReads++;return {credential:{...fresh,refreshToken:'SAMPLE-new-refresh',expiresAtMs:Date.now()+7200000},source:{file:nativeFile,fingerprint:hash(await readFile(nativeFile))}};};
 credentials.workbuddyRefresh=async()=>{refreshes++;assert.fail('missing old refresh must not rotate anything')};
 p.wb.fetchCheckinStatus=async c=>{if(c.accessToken===old.accessToken)throw Object.assign(Error('SAMPLE rejected'),{status:401});return checkin();};
 ledger.set('wb-management-official-status:'+account.id,{status:'banned',source:'official_response',reason:'SAMPLE historical ban'});
 const service={config,credentials,platforms:p,ledger,router:{pool:{get:()=>null,revive(){}}}};
 const row=(await workBuddySummary(service,{refresh:true,accountId:account.id})).accounts[0];
 assert.equal(row.credentialStatus,'authenticated');assert.equal(row.ban.status,'clear');assert.equal(row.remaining,90);assert.equal(row.dailyCheckin.todayCheckedIn,true);assert.equal(row.inferenceEnabled,false);assert.equal(row.stale,false);assert.equal(row.error,undefined);assert.equal(JSON.stringify(config.value),before);assert.equal(nativeReads,1);assert.equal(refreshes,0);assert.equal(reads,3);
 const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.accessToken,fresh.accessToken);assert.equal(saved.refreshToken,'SAMPLE-new-refresh');assert.equal(saved.principal,old.principal);assert.equal(await readFile(nativeFile,'utf8'),'SAMPLE native immutable bytes');
 // A later 401 response from the previous version must reuse, not rotate, this saved login.
 const newer=await credentials.resolve(account.id,{force:true,renew:true,rejectedAccessToken:old.accessToken});assert.equal(newer.accessToken,fresh.accessToken);assert.equal(nativeReads,1);assert.equal(refreshes,0);
 ledger.set('wb-management-manual-status:'+account.id,{status:'banned',source:'user_marked'});
 const manual=(await workBuddySummary(service)).accounts[0];assert.equal(manual.ban.status,'banned');assert.equal(manual.ban.source,'user_marked');
});
