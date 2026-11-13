import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {resolveCodeArtsCredential,codeartsStatus}=await import(pathToFileURL(join(root,'src/provider-codearts.mjs')));
const {Scheduler}=await import(pathToFileURL(join(root,'src/scheduler.mjs')));
const SNAP='huaweicloud.codearts-snap',AUTH='secret://'+JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'});
const hash=x=>createHash('sha256').update(x).digest('hex'),NOW=Date.parse('2026-10-27T15:59:00Z');
const credential={accessKey:'SAMPLE_AK',secretKey:'SAMPLE_SK',securityToken:'SAMPLE_ST'};
async function fixture(fn){
 const dir=await fs.mkdtemp(join(tmpdir(),'CodeArts-Recovery-')),file=join(dir,'State.VSCDB');
 const write=(key,value)=>{const db=new DatabaseSync(file);try{db.exec('create table if not exists ItemTable (key text primary key,value text)');db.prepare('insert or replace into ItemTable values (?,?)').run(key,value);}finally{db.close();}};
 write(SNAP,JSON.stringify({userInfoKey:{originData:{id:'SAMPLE_SUBJECT',accessKey:'SAMPLE_NATIVE_AK',secretKey:'SAMPLE_NATIVE_SK',securityToken:'SAMPLE_NATIVE_ST',expiresAt:new Date(1).toISOString()}}}));
 write(AUTH,'SAMPLE_ENVELOPE_A');
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 const auth={accessKey:'SAMPLE_NATIVE_AK',secretKey:'SAMPLE_NATIVE_SK',securitytoken:'SAMPLE_NATIVE_ST',expires_at:new Date(1).toISOString(),refresh_token:'SAMPLE_ONCE_REFRESH',loginContext:{pkcePair:{codeVerifier:'SAMPLE_PKCE'},dpopKeyPair:{privateKeyJwk:privateKey.export({format:'jwk'}),publicKeyJwk:publicKey.export({format:'jwk'})}}};
 const oldLocal=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=dir;let calls=0;
 const options={now:NOW,decryptAuthImpl:async()=>auth,fetchImpl:async(_url,init)=>{calls++;assert.equal(new URLSearchParams(init.body).get('refresh_token'),'SAMPLE_ONCE_REFRESH');if(calls>1)return Response.json({error_code:'STS5.1806'},{status:400});return Response.json({credentials:{access_key_id:'SAMPLE_ROTATED_AK',secret_access_key:'SAMPLE_ROTATED_SK',security_token:'SAMPLE_ROTATED_ST',expiration:new Date(NOW+3600000).toISOString()},refresh_token:'SAMPLE_ROTATED_REFRESH'});}};
 const seedLegacy=async(cachedAuth,extra={})=>{const cache=join(dir,'AI Credit Gateway','private-cache','codearts-'+hash(file).slice(0,16)+'.json');await fs.mkdir(dirname(cache),{recursive:true});await fs.writeFile(cache,JSON.stringify({sourceHash:hash('SAMPLE_ENVELOPE_A'),auth:cachedAuth,...extra}));return cache;};
 try{return await fn({dir,file,auth,options,write,seedLegacy,get calls(){return calls;}});}finally{if(oldLocal===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=oldLocal;await fs.rm(dir,{recursive:true,force:true});}
}
test('CodeArts same physical DB dot-path alias shares rotating refresh cache and never sends old token twice',()=>fixture(async f=>{
 await fs.mkdir(join(f.dir,'sub'));const alias=join(f.dir,'sub')+'/../State.VSCDB';
 assert.equal((await fs.stat(f.file)).ino,(await fs.stat(alias)).ino);
 const first=await resolveCodeArtsCredential({file:f.file},{},f.options);
 const second=await resolveCodeArtsCredential({file:alias},{},f.options);
 assert.equal(first.accessKey,'SAMPLE_ROTATED_AK');assert.equal(second.accessKey,first.accessKey);assert.equal(f.calls,1);
}));
test('CodeArts Windows case alias shares one cache and lock for the same physical DB',{skip:process.platform!=='win32'},()=>fixture(async f=>{
 const alias=f.file.toLowerCase();assert.equal((await fs.stat(f.file)).ino,(await fs.stat(alias)).ino);
 const first=await resolveCodeArtsCredential({file:f.file},{},f.options),second=await resolveCodeArtsCredential({file:alias},{},f.options);
 assert.equal(second.accessKey,first.accessKey);assert.equal(f.calls,1);
}));
test('CodeArts canonical path migration reuses original default legacy cache without consuming its old source token',()=>fixture(async f=>{
 const rotated={...f.auth,accessKey:'SAMPLE_EXISTING_ROTATED_AK',expires_at:new Date(NOW+3600000).toISOString(),refresh_token:'SAMPLE_ALREADY_ROTATED'};
 await f.seedLegacy(rotated);await fs.mkdir(join(f.dir,'sub'));const alias=join(f.dir,'sub')+'/../State.VSCDB';
 const result=await resolveCodeArtsCredential({file:alias},{},{...f.options,fetchImpl:async()=>{throw Error('MUST_NOT_CONSUME_SOURCE_TOKEN');}});
 assert.equal(result.accessKey,rotated.accessKey);assert.equal(f.calls,0);
}));
test('CodeArts same-login newer private-cache auth must not downgrade to older still-valid native auth',()=>fixture(async f=>{
 const native={...f.auth,expires_at:new Date(NOW+1800000).toISOString()},rotated={...f.auth,accessKey:'SAMPLE_EXISTING_ROTATED_AK',expires_at:new Date(NOW+3600000).toISOString(),refresh_token:'SAMPLE_ALREADY_ROTATED'};
 await f.seedLegacy(rotated);
 const result=await resolveCodeArtsCredential({file:f.file},{},{...f.options,decryptAuthImpl:async()=>native});
 assert.equal(result.accessKey,rotated.accessKey);assert.equal(f.calls,0);
}));
test('CodeArts legacy unknown-rotation marker survives alias migration and never replays a source token',()=>fixture(async f=>{
 await f.seedLegacy(f.auth,{refreshFailure:'codearts_refresh_unconfirmed',failedAt:NOW-1000,loginRequired:false});
 await fs.mkdir(join(f.dir,'sub'));const alias=join(f.dir,'sub')+'/../State.VSCDB';let network=0;
 await assert.rejects(resolveCodeArtsCredential({file:alias},{},{...f.options,fetchImpl:async()=>{network++;throw Error('MUST_NOT_REPLAY_UNKNOWN_ROTATION');}}),{code:'codearts_refresh_needs_login'});
 assert.equal(network,0);
}));
test('CodeArts conflicting same-source canonical and legacy rotations refuse migration without token replay',()=>fixture(async f=>{
 await fs.mkdir(join(f.dir,'sub'));const alias=join(f.dir,'sub')+'/../State.VSCDB';
 const legacy=join(f.dir,'AI Credit Gateway','private-cache','codearts-'+hash(alias).slice(0,16)+'.json');await fs.mkdir(dirname(legacy),{recursive:true});
 await fs.writeFile(legacy,JSON.stringify({sourceHash:hash('SAMPLE_ENVELOPE_A'),auth:{...f.auth,accessKey:'SAMPLE_LEGACY_ROTATION',refresh_token:'SAMPLE_LEGACY_NEXT',expires_at:new Date(NOW+3600000).toISOString()}}));
 const physical=await fs.realpath(f.file),canonical=join(f.dir,'AI Credit Gateway','private-cache','codearts-'+hash(physical).slice(0,16)+'.json');
 assert.notEqual(canonical,legacy);
 await fs.writeFile(canonical,JSON.stringify({sourceHash:hash('SAMPLE_ENVELOPE_A'),auth:{...f.auth,accessKey:'SAMPLE_CANONICAL_ROTATION',refresh_token:'SAMPLE_CANONICAL_NEXT',expires_at:new Date(NOW+3600000).toISOString()}}));
 const beforeLegacy=await fs.readFile(legacy),beforeCanonical=await fs.readFile(canonical);let network=0;
 await assert.rejects(resolveCodeArtsCredential({file:alias},{},{...f.options,fetchImpl:async()=>{network++;throw Error('MUST_NOT_PICK_UNKNOWN_FORK');}}),e=>e.status===409&&/^codearts_refresh_/.test(e.code??''));
 assert.equal(network,0);assert.deepEqual(await fs.readFile(legacy),beforeLegacy);assert.deepEqual(await fs.readFile(canonical),beforeCanonical);
}));
test('CodeArts migration never ignores an occupied legacy refresh lock or consumes its token concurrently',()=>fixture(async f=>{
 const legacy=await f.seedLegacy(f.auth);await fs.writeFile(legacy+'.lock','SAMPLE_ACTIVE_OWNER');
 await fs.mkdir(join(f.dir,'sub'));const alias=join(f.dir,'sub')+'/../State.VSCDB';let network=0;
 await assert.rejects(resolveCodeArtsCredential({file:alias},{},{...f.options,fetchImpl:async()=>{network++;throw Error('MUST_NOT_RACE_LEGACY_OWNER');}}),e=>e.status===409&&/^codearts_refresh_/.test(e.code??''));
 assert.equal(network,0);assert.equal(await fs.readFile(legacy+'.lock','utf8'),'SAMPLE_ACTIVE_OWNER');
}));
test('CodeArts config.dataDir keeps one rotating credential chain when LOCALAPPDATA views change',()=>fixture(async f=>{
 const config={dataDir:join(f.dir,'SAMPLE_SHARED_CONFIG_DATA')};
 const first=await resolveCodeArtsCredential({file:f.file},config,f.options);
 const secondView=join(f.dir,'SAMPLE_SECOND_LOCALAPPDATA');await fs.mkdir(secondView);process.env.LOCALAPPDATA=secondView;
 const second=await resolveCodeArtsCredential({file:f.file},config,f.options);
 assert.equal(first.accessKey,'SAMPLE_ROTATED_AK');assert.equal(second.accessKey,first.accessKey);assert.equal(f.calls,1);
 const canonical=await fs.realpath(f.file),cache=join(config.dataDir,'private-cache','codearts-'+hash(canonical).slice(0,16)+'.json');
 assert.equal(JSON.parse(await fs.readFile(cache,'utf8')).auth.accessKey,first.accessKey);
}));
test('CodeArts shared valid cache never falls back to acknowledged stale legacy views or their terminal marker',()=>fixture(async f=>{
 const config={dataDir:join(f.dir,'SAMPLE_SHARED_CONFIG_DATA')},physical=await fs.realpath(f.file);
 const firstLegacy=await f.seedLegacy(f.auth,{refreshFailure:'codearts_refresh_failed',loginRequired:true,failedAt:NOW-2000});
 const firstText=await fs.readFile(firstLegacy,'utf8');
 const secondView=join(f.dir,'SAMPLE_SECOND_LOCALAPPDATA'),secondLegacy=join(secondView,'AI Credit Gateway','private-cache','codearts-'+hash(f.file).slice(0,16)+'.json');
 await fs.mkdir(dirname(secondLegacy),{recursive:true});const secondText=JSON.stringify({sourceHash:hash('SAMPLE_ENVELOPE_A'),auth:f.auth,refreshFailure:'codearts_refresh_failed',loginRequired:true,failedAt:NOW-1000});await fs.writeFile(secondLegacy,secondText);
 const shared=join(config.dataDir,'private-cache','codearts-'+hash(physical).slice(0,16)+'.json');await fs.mkdir(dirname(shared),{recursive:true});
 const auth={...f.auth,accessKey:'SAMPLE_SHARED_VALID_AK',expires_at:new Date(NOW+3600000).toISOString(),refresh_token:'SAMPLE_SHARED_ROTATED_REFRESH'};
 await fs.writeFile(shared,JSON.stringify({sourceHash:hash('SAMPLE_ENVELOPE_A'),auth,legacyCacheDigests:[hash(firstText),hash(secondText)]}));
 let network=0;const options={...f.options,fetchImpl:async()=>{network++;throw Error('MUST_NOT_REFRESH_VALID_SHARED_CACHE');}};
 const first=await resolveCodeArtsCredential({file:f.file},config,options);process.env.LOCALAPPDATA=secondView;
 const second=await resolveCodeArtsCredential({file:f.file},config,options);
 assert.equal(first.accessKey,auth.accessKey);assert.equal(second.accessKey,auth.accessKey);assert.equal(network,0);
 assert.equal(JSON.parse(await fs.readFile(shared,'utf8')).auth.accessKey,auth.accessKey);assert.equal(await fs.readFile(firstLegacy,'utf8'),firstText);assert.equal(await fs.readFile(secondLegacy,'utf8'),secondText);
}));
test('CodeArts same config canonical and dot aliases coalesce concurrent resolution on the shared cache',()=>fixture(async f=>{
 const config={dataDir:join(f.dir,'SAMPLE_SHARED_CONFIG_DATA')};await fs.mkdir(join(f.dir,'sub'));
 const physical=await fs.realpath(f.file),alias=join(f.dir,'sub')+'/../State.VSCDB';
 const options={...f.options,fetchImpl:async(...args)=>{await new Promise(r=>setTimeout(r,20));return f.options.fetchImpl(...args);}};
 const [first,second]=await Promise.all([resolveCodeArtsCredential({file:physical},config,options),resolveCodeArtsCredential({file:alias},config,options)]);
 assert.equal(first.accessKey,'SAMPLE_ROTATED_AK');assert.equal(second.accessKey,first.accessKey);assert.equal(f.calls,1);
 const caches=await fs.readdir(join(config.dataDir,'private-cache'));assert.equal(caches.filter(x=>x.endsWith('.json')).length,1);assert.equal(caches.some(x=>x.endsWith('.lock')),false);
}));
test('CodeArts fresh native return rechecks source CAS rather than accepting a mixed native snapshot',()=>fixture(async f=>{
 const before=await fs.readFile(f.file);let changed=false;
 const opts={...f.options,decryptAuthImpl:async()=>{if(!changed){changed=true;f.write(AUTH,'SAMPLE_ENVELOPE_B');}return {...f.auth,expires_at:new Date(NOW+3600000).toISOString()};}};
 await assert.rejects(resolveCodeArtsCredential({file:f.file},{},opts),{code:'codearts_refresh_source_changed'});
 assert.equal(f.calls,0);assert.equal(changed,true);assert.notDeepEqual(await fs.readFile(f.file),before);
}));
test('CodeArts refresh source CAS refuses a native change before any refresh-token POST',()=>fixture(async f=>{
 const opts={...f.options,decryptAuthImpl:async()=>{f.write(AUTH,'SAMPLE_ENVELOPE_B');return f.auth;}};
 await assert.rejects(resolveCodeArtsCredential({file:f.file},{},opts),{code:'codearts_refresh_source_changed'});assert.equal(f.calls,0);
}));
const campaign={campaignId:34,type:'USER_LOGIN',title:'每日登录签到',status:'CONSUMED',claimable:false,benefitAmount:100,benefitUnit:'CREDIT',extra:{triggerEvent:'user.login',triggerMode:'MANUAL_CLAIM'}};
const statusAt=now=>codeartsStatus(credential,'daily-checkin',{now,fetchImpl:async()=>Response.json({code:0,data:{items:[campaign]}})});
test('CodeArts explicit early-renew window renews the current verified chain once without moving wall clock',()=>fixture(async f=>{
 const native={...f.auth,expires_at:new Date(NOW+1800000).toISOString()};
 const account={file:f.file},options={...f.options,decryptAuthImpl:async()=>native,renewWithinMs:3600000,fetchImpl:async(_u,init)=>{assert.equal(new URLSearchParams(init.body).get('refresh_token'),'SAMPLE_ONCE_REFRESH');return Response.json({credentials:{access_key_id:'SAMPLE_EARLY_RENEWED',secret_access_key:'SAMPLE_SK',security_token:'SAMPLE_ST',expiration:new Date(NOW+7200000).toISOString()},refresh_token:'SAMPLE_NEXT'});}};
 const result=await resolveCodeArtsCredential(account,{},options);assert.equal(result.accessKey,'SAMPLE_EARLY_RENEWED');assert.equal(Date.parse(result.expiresAt),NOW+7200000);
}));
test('CodeArts verified daily campaign advertises next China midnight independently of noon global plan',async()=>{
 for(const [at,next] of [['2026-10-27T15:59:59.999Z','2026-10-27T16:00:00.000Z'],['2026-10-27T16:00:00.000Z','2026-10-28T16:00:00.000Z']]){
  const value=await statusAt(Date.parse(at));assert.equal(value.nextClaimAt,next);assert.equal(value.known,true);
 }
});
test('CodeArts unknown campaign never invents a daily window',async()=>{
 const value=await codeartsStatus(credential,'daily-checkin',{now:NOW,fetchImpl:async()=>Response.json({code:0,data:{items:[]}})});
 assert.equal(value.known,false);assert.ok(value.nextClaimAt==null);
});
test('CodeArts midnight or resume wake selects only due CodeArts while settled future-window peer stays idle',async()=>{
 const prior=await statusAt(NOW),wall=Date.parse('2026-10-27T16:00:30Z'),s={enabled:true,startup:false,timezone:'Asia/Shanghai',hour:12,minute:0,jitterSeconds:0,retryMinutes:60};
 const config={value:{scheduler:s,accounts:[{id:'SAMPLE_CA',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]},{id:'SAMPLE_OTHER',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}]}};
 const last={day:'2026-10-27',signature:'SAMPLE_SIGNATURE',at:NOW,dailyDay:'2026-10-27',dailySignature:'SAMPLE_SIGNATURE',tasks:[{accountId:'SAMPLE_CA',task:'daily-checkin',day:'2026-10-27',signature:'SAMPLE_SIGNATURE',status:'already',checkedAt:NOW,nextClaimAt:prior.nextClaimAt},{accountId:'SAMPLE_OTHER',task:'daily-checkin',day:'2026-10-27',signature:'SAMPLE_SIGNATURE',status:'already',checkedAt:NOW,nextClaimAt:'2026-10-28T00:00:00Z'}]};
 const memory=new Map([['schedule-last',last]]),calls=[];
 const claims={all:async(selection,context)=>{calls.push({selection,context});return [{accountId:'SAMPLE_CA',task:'daily-checkin',day:'2026-10-28',status:'success',nextClaimAt:'2026-10-28T16:00:00Z',operationAttempted:true,automaticOperationConfirmed:true,automaticRewardConfirmed:true}];}};
 const ledger={get:k=>memory.get(k),set:(k,v)=>memory.set(k,v)},scheduler=new Scheduler(config,claims,ledger);scheduler.stopped=false;
 scheduler.context=()=>({s,day:'2026-10-28',signature:'SAMPLE_SIGNATURE',plan:{at:Date.parse('2026-10-28T04:00:00Z')}});
 const originalNow=Date.now;Date.now=()=>wall;
 try{await scheduler.tick();assert.equal(calls.length,1);assert.deepEqual(calls[0].selection,{tasks:[{accountId:'SAMPLE_CA',task:'daily-checkin'}]});assert.equal(calls[0].context.trigger,'automatic');assert.equal(memory.get('schedule-last').tasks.find(x=>x.accountId==='SAMPLE_CA').automaticRewardConfirmed,true);}finally{Date.now=originalNow;await scheduler.stop();}
});
