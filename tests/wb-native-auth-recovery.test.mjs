import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {CredentialManager}=await import(pathToFileURL(join(root,'src/credentials.mjs')));
const {hash}=await import(pathToFileURL(join(root,'src/util.mjs')));

test('an existing different ledger binding prevents native adoption before a verification or write',async t=>{
 const f=await fixture(t),before=await readFile(f.file);f.manager.ledger.principalHash=()=>hash('workbuddy\0SAMPLE-other');
 await assert.rejects(f.read({renew:true}),{code:'principal_changed'});assert.deepEqual(await readFile(f.file),before);assert.equal(f.count().verifications,0);
});
test('a ledger identity change during native verification cannot commit the recovered snapshot',async t=>{
 const f=await fixture(t),before=await readFile(f.file);let bound=hash('workbuddy\0'+f.old.principal);f.manager.ledger.principalHash=()=>bound;
 f.manager.workbuddyNativeVerify=async()=>{bound=hash('workbuddy\0SAMPLE-other');return {authenticated:true};};
 await assert.rejects(f.read({renew:true}),{code:'principal_changed'});assert.deepEqual(await readFile(f.file),before);assert.equal(f.count().refreshes,0);
});

async function fixture(t,{owned=true,expiry=Date.now()+3600000,refreshToken='',native={}}={}) {
  const dir=await mkdtemp(join(tmpdir(),'wb-native-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const id='fixture-wb',file=owned?join(dir,'accounts',id,'workbuddy-session.json'):join(dir,'external.json');
  await mkdir(join(file,'..'),{recursive:true});
  const old={accessToken:'fixture-old-access',refreshToken,uid:'fixture-principal',principal:'fixture-principal',expiresAtMs:expiry,domain:'www.codebuddy.cn',edition:'cn',profileRaw:{nickname:'old-label'},metadata:{unchanged:true}};
  await writeFile(file,JSON.stringify(old));
  const nativeFile=join(dir,'native.info');await writeFile(nativeFile,JSON.stringify({version:1,note:'fixture native bytes'}));
  const current={accessToken:'fixture-new-access',refreshToken:'fixture-new-refresh',uid:'fixture-principal',principal:'fixture-principal',expiresAtMs:Date.now()+7200000,refreshExpiresAtMs:Date.now()+86400000,domain:'www.workbuddy.cn',edition:'cn',profileRaw:{nickname:'new-label'},...native};
  const account={id,platform:'workbuddy',edition:'cn',enabled:true,inferenceEnabled:false,credentials:{kind:'file',file}},config={dataDir:dir,path:p=>p,value:{accounts:[account],routes:[{id:'preserved-route',enabled:false}]}};
  const manager=new CredentialManager(config,{bind:(_id,_platform,p)=>({ok:p===old.principal,fingerprint:'fixture-bound'})});
  let nativeReads=0,verifications=0,refreshes=0;
  manager.workbuddyNativeRead=async()=>{nativeReads++;return {credential:current,source:{file:nativeFile,fingerprint:hash(await readFile(nativeFile))}}};
  manager.workbuddyNativeVerify=async c=>{verifications++;assert.equal(c.accessToken,current.accessToken);return {authenticated:true};};
  manager.workbuddyRefresh=async()=>{refreshes++;throw Error('old refresh token must not be consumed')};
  return {dir,id,file,nativeFile,old,current,account,config,manager,count:()=>({nativeReads,verifications,refreshes}),saved:()=>readFile(file,'utf8').then(JSON.parse),read:options=>manager.resolve(id,options)};
}

test('same-principal native login replaces an unexpired access-only owned snapshot after real-auth renewal',async t=>{
  const f=await fixture(t),configuration=JSON.stringify(f.config.value),nativeBefore=await readFile(f.nativeFile);
  const c=await f.read({force:true,renew:true});
  assert.equal(c.accessToken,'fixture-new-access');assert.equal(c.principalHash,'fixture-bound');
  const saved=await f.saved();assert.equal(saved.refreshToken,'fixture-new-refresh');assert.equal(saved.domain,'www.workbuddy.cn');assert.equal(saved.expiresAtMs,f.current.expiresAtMs);assert.deepEqual(saved.profileRaw,{nickname:'new-label'});assert.equal(saved.managedBy,'ai-credit-gateway');assert.equal(saved.credentialVersion,1);assert.equal(saved.principal,f.old.principal);assert.deepEqual(saved.metadata,f.old.metadata);
  assert.deepEqual(f.count(),{nativeReads:1,verifications:1,refreshes:0});assert.deepEqual(await readFile(f.nativeFile),nativeBefore);assert.equal(JSON.stringify(f.config.value),configuration);assert.equal(f.config.value.accounts[0].inferenceEnabled,false);
  const state=JSON.parse(await readFile(f.file+'.refresh-state.json','utf8'));assert.equal(state.status,'complete');
});

test('normal reads of a healthy saved slot do not read native login or perform validation',async t=>{
  const f=await fixture(t),before=await readFile(f.file);assert.equal((await f.read()).accessToken,f.old.accessToken);assert.deepEqual(f.count(),{nativeReads:0,verifications:0,refreshes:0});assert.deepEqual(await readFile(f.file),before);
});

test('nearly expired owned snapshot adopts a verified native login without consuming its old RT',async t=>{
  const f=await fixture(t,{expiry:Date.now()+45000,refreshToken:'fixture-old-refresh'});assert.equal((await f.read()).accessToken,f.current.accessToken);assert.equal(f.count().refreshes,0);assert.equal(f.count().verifications,1);
});

test('native adoption does not keep an old RT when the new native session has none',async t=>{
  const f=await fixture(t,{refreshToken:'fixture-stale-refresh',native:{refreshToken:undefined,refreshExpiresAtMs:undefined}});
  assert.equal((await f.read({renew:true})).accessToken,f.current.accessToken);const saved=await f.saved();assert.equal(saved.refreshToken,'');assert.equal(saved.refreshExpiresAtMs,undefined);assert.equal(f.count().refreshes,0);
});

for(const [name,native] of [['another principal',{uid:'other',principal:'other'}],['conflicting native UID',{uid:'other'}],['another edition',{edition:'ai',domain:'www.workbuddy.ai'}],['expired access',{expiresAtMs:Date.now()-1000}],['unchanged access',{accessToken:'fixture-old-access'}],['unknown expiry',{expiresAtMs:undefined}]])test('native '+name+' is not copied into an owned account',async t=>{
  const f=await fixture(t,{native}),before=await readFile(f.file);const c=await f.read({renew:true});assert.equal(c.accessToken,f.old.accessToken);assert.deepEqual(await readFile(f.file),before);assert.equal(f.count().verifications,0);assert.equal(f.count().refreshes,0);
});

test('unreadable native login leaves an access-only slot unchanged without submitting refresh',async t=>{
  const f=await fixture(t),before=await readFile(f.file);f.manager.workbuddyNativeRead=async()=>{throw Object.assign(Error('fixture helper read failed'),{code:'credential_decrypt_failed'})};assert.equal((await f.read({renew:true})).accessToken,f.old.accessToken);assert.deepEqual(await readFile(f.file),before);assert.equal(f.count().refreshes,0);
});

test('a new native credential needs explicit successful official verification before persistence',async t=>{
  const f=await fixture(t),before=await readFile(f.file);const error=Object.assign(Error('fixture upstream rejected'),{status:401,code:'wb_upstream_rejected'});f.manager.workbuddyNativeVerify=async()=>{throw error};await assert.rejects(f.read({renew:true}),e=>e===error);assert.deepEqual(await readFile(f.file),before);assert.equal(f.count().refreshes,0);await assert.rejects(readFile(f.file+'.refresh-state.json'),{code:'ENOENT'});
});

test('a non-proving verification return is rejected instead of silently persisting new tokens',async t=>{
  const f=await fixture(t),before=await readFile(f.file);f.manager.workbuddyNativeVerify=async()=>({authenticated:false});await assert.rejects(f.read({renew:true}),{code:'wb_native_verification_unconfirmed'});assert.deepEqual(await readFile(f.file),before);assert.equal(f.count().refreshes,0);
});

test('native changes while being read or while verified cannot overwrite an owned slot',async t=>{
  for(const phase of ['before','after']){
    const f=await fixture(t),before=await readFile(f.file),original=f.manager.workbuddyNativeRead;
    if(phase==='before')f.manager.workbuddyNativeRead=async()=>{const candidate=await original();await writeFile(f.nativeFile,'changed-before-verification');return candidate;};
    else f.manager.workbuddyNativeVerify=async()=>{await writeFile(f.nativeFile,'changed-after-verification');return {authenticated:true};};
    await assert.rejects(f.read({renew:true}),{code:'wb_native_source_changed'});assert.deepEqual(await readFile(f.file),before);assert.equal(f.count().refreshes,0);
  }
});

test('full saved-slot JSON CAS preserves a concurrent metadata-only edit and avoids clearing old markers',async t=>{
  const f=await fixture(t);f.manager.workbuddyNativeVerify=async()=>{await writeFile(f.file,JSON.stringify({...f.old,metadata:{concurrent:true}}));return {authenticated:true};};const c=await f.read({renew:true});assert.equal(c.accessToken,f.old.accessToken);assert.deepEqual((await f.saved()).metadata,{concurrent:true});assert.equal(f.count().refreshes,0);await assert.rejects(readFile(f.file+'.refresh-state.json'),{code:'ENOENT'});
});

test('an existing cross-process lock prevents native adoption and all renewal network work',async t=>{
  const f=await fixture(t),before=await readFile(f.file);await writeFile(f.file+'.refresh-state.json.lock','fixture-owner');await assert.rejects(f.read({renew:true}),{code:'wb_refresh_pending'});assert.deepEqual(f.count(),{nativeReads:0,verifications:0,refreshes:0});assert.deepEqual(await readFile(f.file),before);
});

for(const status of ['pending','unconfirmed','rejected'])test('fresh verified native login supersedes old '+status+' marker without replaying its RT',async t=>{
  const f=await fixture(t,{refreshToken:'fixture-old-refresh'}),sourceFingerprint=hash(JSON.stringify([f.old.principal,f.old.accessToken,f.old.refreshToken]));await writeFile(f.file+'.refresh-state.json',JSON.stringify({sourceFingerprint,status,attemptedAt:1}));assert.equal((await f.read({renew:true})).accessToken,f.current.accessToken);assert.equal(f.count().refreshes,0);assert.equal(JSON.parse(await readFile(f.file+'.refresh-state.json')).status,'complete');
});

test('same old native login cannot unblock an unconfirmed rotating token marker',async t=>{
  const f=await fixture(t,{refreshToken:'fixture-old-refresh',native:{accessToken:'fixture-old-access'}}),sourceFingerprint=hash(JSON.stringify([f.old.principal,f.old.accessToken,f.old.refreshToken]));await writeFile(f.file+'.refresh-state.json',JSON.stringify({sourceFingerprint,status:'unconfirmed',attemptedAt:1}));await assert.rejects(f.read({renew:true}),{code:'wb_refresh_unconfirmed'});assert.equal(f.count().verifications,0);assert.equal(f.count().refreshes,0);
});

test('arbitrary external JSON never reads native login, verifies, refreshes, or writes',async t=>{
  const f=await fixture(t,{owned:false,refreshToken:'fixture-old-refresh'}),before=await readFile(f.file);assert.equal((await f.read({renew:true})).accessToken,f.old.accessToken);assert.deepEqual(f.count(),{nativeReads:0,verifications:0,refreshes:0});assert.deepEqual(await readFile(f.file),before);
});

test('concurrent callers share one native read and official validation',async t=>{
  const f=await fixture(t);const results=await Promise.all(Array.from({length:6},()=>f.read({force:true,renew:true})));assert.ok(results.every(c=>c.accessToken===f.current.accessToken));assert.deepEqual(f.count(),{nativeReads:1,verifications:1,refreshes:0});
});

test('a delayed 401 for the replaced access token reuses the new slot without native verification or RT rotation',async t=>{
  const f=await fixture(t);const rejectedAccessToken=f.old.accessToken;
  assert.equal((await f.read({force:true,renew:true,rejectedAccessToken})).accessToken,f.current.accessToken);
  assert.equal((await f.read({force:true,renew:true,rejectedAccessToken})).accessToken,f.current.accessToken);
  assert.deepEqual(f.count(),{nativeReads:1,verifications:1,refreshes:0});
  for(const file of [f.file,f.file+'.refresh-state.json'])assert.equal((await readFile(file,'utf8')).includes('rejectedAccessToken'),false);
});

test('a 401 for the current token still permits the single existing owned-RT renewal path',async t=>{
  const f=await fixture(t,{refreshToken:'fixture-old-refresh',native:{accessToken:'fixture-old-access'}});let rotations=0;
  f.manager.workbuddyRefresh=async raw=>{rotations++;return {...raw,accessToken:'fixture-rotated',refreshToken:'fixture-rotated-refresh',expiresAtMs:Date.now()+7200000};};
  assert.equal((await f.read({renew:true,rejectedAccessToken:f.old.accessToken})).accessToken,'fixture-rotated');assert.equal(rotations,1);assert.equal(f.count().verifications,0);
});

test('the default native reader uses the desktop source without binding real ledger state or changing source bytes',async t=>{
  const f=await fixture(t),oldEnv=process.env.WORKBUDDY_AUTH_FILE;
  await writeFile(f.nativeFile,JSON.stringify({account:{uid:f.old.principal,nickname:'native fixture'},auth:{accessToken:f.current.accessToken,refreshToken:f.current.refreshToken,expiresAt:f.current.expiresAtMs,domain:'www.workbuddy.cn'}}));
  const before=await readFile(f.nativeFile),configuration=JSON.stringify(f.config.value);
  process.env.WORKBUDDY_AUTH_FILE=f.nativeFile;delete f.manager.workbuddyNativeRead;
  try {assert.equal((await f.read({renew:true,rejectedAccessToken:f.old.accessToken})).accessToken,f.current.accessToken);assert.deepEqual(await readFile(f.nativeFile),before);assert.equal(JSON.stringify(f.config.value),configuration);assert.equal(f.count().verifications,1);assert.equal(f.count().refreshes,0);}
  finally {if(oldEnv===undefined)delete process.env.WORKBUDDY_AUTH_FILE;else process.env.WORKBUDDY_AUTH_FILE=oldEnv;}
});
