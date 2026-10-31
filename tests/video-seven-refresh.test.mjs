import {register as registerSampleVaultLoader} from 'node:module';
import {mkdtemp as makeSampleVaultDir,writeFile as writeSampleVaultModule} from 'node:fs/promises';
import {tmpdir as sampleVaultTmpdir} from 'node:os';
import {join as sampleVaultJoin} from 'node:path';
import {pathToFileURL as sampleVaultFileURL} from 'node:url';
import {pathToFileURL} from 'node:url';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';
const MODULE_ROOT=process.env.VIDEO_GATEWAY_TEST_ROOT??fileURLToPath(new URL('..',import.meta.url));
// SAMPLE-only module injection gives fixture writes and every provider read the
// same reversible crypt callback. Production DPAPI and its host guard are not
// changed; the explicit Windows DPAPI test still calls the real exported API.
const sampleVaultDir=await makeSampleVaultDir(sampleVaultJoin(sampleVaultTmpdir(),'sample-vault-loader-'));
const sampleVaultTarget=sampleVaultFileURL(sampleVaultJoin(MODULE_ROOT,'src/video-session-vault.mjs')).href;
const sampleVaultWrapper=sampleVaultFileURL(sampleVaultJoin(sampleVaultDir,'vault.mjs')).href;
const sampleVaultLoader=sampleVaultFileURL(sampleVaultJoin(sampleVaultDir,'loader.mjs')).href;
await writeSampleVaultModule(new URL(sampleVaultWrapper),`import assert from 'node:assert/strict';
import * as real from ${JSON.stringify(sampleVaultTarget)};
export * from ${JSON.stringify(sampleVaultTarget)};
const crypt=async(mode,b,kind)=>{const prefix=Buffer.from('SAMPLE\\0'+kind+'\\0');if(mode==='protect')return Buffer.concat([prefix,Buffer.from(b).map(x=>x^0xa5)]);assert.ok(b.subarray(0,prefix.length).equals(prefix));return Buffer.from(b.subarray(prefix.length)).map(x=>x^0xa5);};
export const writeVideoSessionVault=(file,session,options={})=>real.writeVideoSessionVault(file,session,{...options,crypt:options.crypt??crypt});
export const readVideoSessionVault=(file,options={})=>real.readVideoSessionVault(file,{...options,crypt:options.crypt??crypt});
`);
await writeSampleVaultModule(new URL(sampleVaultLoader),`let target,wrapper;export function initialize(data){({target,wrapper}=data);}export async function resolve(specifier,context,nextResolve){const result=await nextResolve(specifier,context);return result.url===target&&context.parentURL!==wrapper?{url:wrapper,shortCircuit:true}:result;}`);
registerSampleVaultLoader(sampleVaultLoader,{parentURL:import.meta.url,data:{target:sampleVaultTarget,wrapper:sampleVaultWrapper}});
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {createGatewayVideoProvider:createGatewayVideoProviderRaw}=await import(pathToFileURL(path.join(MODULE_ROOT,'src',"provider-video-independent.mjs")).href);
// Renewal fixtures now answer the adapter's independent read-only daily-history
// probe with the current official ret/JSON-response envelope. Identity rotation
// remains under each fixture's fetchImpl and its original call-count assertions.
function createGatewayVideoProvider(kind,options={}){
 const fetchImpl=options.fetchImpl;
 return createGatewayVideoProviderRaw(kind,{...options,...(fetchImpl?{fetchImpl:(url,opt)=>kind==='xiaoyunque'&&new URL(url).pathname==='/commerce/v1/benefits/user_credit_history'?Promise.resolve(Response.json({ret:'0',response:JSON.stringify({records:[],has_more:false,new_cursor:''})})):kind==='hailuo'&&new URL(url).pathname==='/v1/api/user/equity'?Promise.resolve(Response.json({statusInfo:{code:0},data:{privilegeType:0,isPaidSubscription:false}})):fetchImpl(url,opt)}:{})});
}
const {writeVideoSessionVault,readVideoSessionVault}=await import(pathToFileURL(path.join(MODULE_ROOT,'src',"video-session-vault.mjs")).href);
const {CredentialManager}=await import(pathToFileURL(path.join(MODULE_ROOT,'src',"credentials.mjs")).href);
const {Platforms}=await import(pathToFileURL(path.join(MODULE_ROOT,'src',"platforms.mjs")).href);
const {ClaimService}=await import(pathToFileURL(path.join(MODULE_ROOT,'src',"claims.mjs")).href);
const {Ledger}=await import(pathToFileURL(path.join(MODULE_ROOT,'src',"store.mjs")).href);

const root=await mkdtemp(path.join(tmpdir(),'video-gateway-suite-')),dir=path.join(root,'refresh-fixtures',String(Date.now()));
await mkdir(dir,{recursive:true});
const results=[],sha=v=>createHash('sha256').update(v).digest('hex'),ids={jimeng:'SAMPLE_J_ID',xiaoyunque:'SAMPLE_X_ID',hailuo:'SAMPLE_H_ID'};
const origin={jimeng:'https://jimeng.jianying.com',xiaoyunque:'https://xyq.jianying.com',hailuo:'https://hailuoai.com'};
const account=(k,file)=>({id:'refresh-'+k,enabled:true,platform:k,inferenceEnabled:false,credentials:{kind:'file',file},tasks:[{id:'daily-checkin',enabled:true}]});
const config={path:p=>p};
function input(k){return {platform:k,origin:origin[k],cookies:[{name:k==='hailuo'?'_token':'sessionid',value:'SAMPLE_OLD',domain:k==='hailuo'?'hailuoai.com':'.jianying.com',path:'/',secure:true,httpOnly:true,sameSite:'lax'}],...(k==='hailuo'?{accessToken:'SAMPLE_OLD'}:{})};}
async function vault(name,k){const f=path.join(dir,name+'.json');await writeVideoSessionVault(f,input(k),{principal:ids[k]});return f;}
const asJson=(body,headers=[])=>Response.json(body,{headers:headers.map(value=>['Set-Cookie',value])});
const cookie=(opt={})=>new Headers(opt.headers).get('Cookie')??'';
const identity=(k,id=ids[k])=>k==='hailuo'?{statusInfo:{code:0},data:{userInfo:{userID:id}}}:{message:'success',data:k==='jimeng'?{user_id:id}:{user_id_str:id}};
async function test(name,fn){await fn();results.push({name,passed:true});}

await test('missing source maps identity_pending/401/beforeSubmission',async()=>{
 const p=createGatewayVideoProvider('xiaoyunque');await assert.rejects(p.resolve(account('xiaoyunque',path.join(dir,'missing.json')),config),e=>e.code==='video_session_identity_pending'&&e.status===401&&e.beforeSubmission===true);
});

for(const k of ['xiaoyunque','jimeng'])await test(k+' response rotation persists DPAPI and same immutable capability observes fresh current',async()=>{
 const file=await vault(k+'-rotation',k);let rotated=false,reads=0,mutations=0;
 const p=createGatewayVideoProvider(k,{fetchImpl:async(url,opt)=>{const u=new URL(url);reads++;
  if(u.pathname.includes('credit_receive')){mutations++;throw Error('fixture_must_not_mutate');}
  if(u.pathname.includes('passport')){const fresh=cookie(opt).includes('SAMPLE_NEW');if(rotated)assert.ok(fresh,'new cookie must be sent after rotation');const h=!rotated?['sessionid=SAMPLE_NEW; Domain=.jianying.com; Path=/; Secure; HttpOnly; SameSite=Lax']:[];rotated=true;return asJson(identity(k),h);}
  assert.ok(cookie(opt).includes('SAMPLE_NEW'));return asJson({ret:'0',data:{records:[]}});
 }}),c=await p.resolve(account(k,file),config),cap=c.videoSession;
 assert.equal(cap.cookies[0].value,'SAMPLE_OLD');assert.ok(Object.isFrozen(cap));
 assert.equal((await p.status(c)).known,true);assert.equal((await p.status(c)).known,true);
 assert.equal(c.videoSession,cap);assert.equal(cap.cookies[0].value,'SAMPLE_OLD');
 const fresh=await readVideoSessionVault(file,{platform:k});assert.equal(fresh.cookies[0].value,'SAMPLE_NEW');assert.equal(fresh.principalHash,c.principalHash);assert.equal(mutations,0);assert.ok(reads>=3);
});

await test('token cookie renewal updates token and expiry, persisted same canonical only',async()=>{
 const file=await vault('hailuo-renewal','hailuo');let issued=false;
 const p=createGatewayVideoProvider('hailuo',{fetchImpl:async(url,opt)=>{assert.equal(new URL(url).pathname,'/v1/api/user/info');const fresh=new Headers(opt.headers).get('token')==='SAMPLE_NEW';if(issued)assert.ok(fresh);const h=!issued?['_token=SAMPLE_NEW; Path=/; Secure; HttpOnly; Max-Age=3600']:[];issued=true;return asJson(identity('hailuo'),h);}}),c=await p.resolve(account('hailuo',file),config);
 assert.equal((await p.status(c)).active,false);assert.equal((await p.status(c)).active,false);
 const s=await readVideoSessionVault(file,{platform:'hailuo'});assert.equal(s.accessToken,'SAMPLE_NEW');assert.equal(s.cookies[0].value,'SAMPLE_NEW');assert.ok(s.expiresAtMs>Date.now());assert.equal(s.principal,ids.hailuo);
});

await test('rotated credential returning another principal never saves or replays',async()=>{
 const file=await vault('principal-change','xiaoyunque'),before=await readFile(file);let actions=0;
 const p=createGatewayVideoProvider('xiaoyunque',{fetchImpl:async(url,opt)=>{if(new URL(url).pathname.includes('credit_receive'))actions++;const fresh=cookie(opt).includes('SAMPLE_OTHER');return asJson(identity('xiaoyunque',fresh?'SAMPLE_OTHER_USER':ids.xiaoyunque),fresh?[]:['sessionid=SAMPLE_OTHER; Domain=.jianying.com; Path=/; Secure; HttpOnly']);}}),c=await p.resolve(account('xiaoyunque',file),config);
 await assert.rejects(p.status(c),e=>/principal/.test(e.code));assert.deepEqual(await readFile(file),before);assert.equal(actions,0);
});

await test('second rotation is itself verified before it is certified or written',async()=>{
 const file=await vault('second-rotation','xiaoyunque');const seen=[];
 const p=createGatewayVideoProvider('xiaoyunque',{fetchImpl:async(url,opt)=>{const value=cookie(opt);seen.push(value);return asJson(identity('xiaoyunque'),value.includes('SAMPLE_THIRD')?[]:[`sessionid=${value.includes('SAMPLE_NEW')?'SAMPLE_THIRD':'SAMPLE_NEW'}; Domain=.jianying.com; Path=/; Secure; HttpOnly`]);}}),c=await p.resolve(account('xiaoyunque',file),config);
 assert.equal((await p.status(c)).known,true);assert.ok(seen.length>=3);assert.ok(seen.slice(2).every(v=>v.includes('SAMPLE_THIRD')));assert.equal((await readVideoSessionVault(file,{platform:'xiaoyunque'})).cookies[0].value,'SAMPLE_THIRD');
});

await test('second issued token switching principal is rejected without a vault write',async()=>{
 const file=await vault('second-principal','xiaoyunque'),before=await readFile(file);
 const p=createGatewayVideoProvider('xiaoyunque',{fetchImpl:async(url,opt)=>{const value=cookie(opt);return asJson(identity('xiaoyunque',value.includes('SAMPLE_OTHER')?'SAMPLE_OTHER_USER':ids.xiaoyunque),value.includes('SAMPLE_OTHER')?[]:[`sessionid=${value.includes('SAMPLE_NEW')?'SAMPLE_OTHER':'SAMPLE_NEW'}; Domain=.jianying.com; Path=/; Secure; HttpOnly`]);}}),c=await p.resolve(account('xiaoyunque',file),config);
 await assert.rejects(p.status(c),e=>/principal/.test(e.code));assert.deepEqual(await readFile(file),before);
});

await test('perpetual server rotation is bounded and not certified as a refresh',async()=>{
 const file=await vault('unstable','xiaoyunque'),before=await readFile(file);let reads=0;
 const p=createGatewayVideoProvider('xiaoyunque',{fetchImpl:async()=>asJson(identity('xiaoyunque'),[`sessionid=SAMPLE_ROTATION_${++reads}; Domain=.jianying.com; Path=/; Secure; HttpOnly`])}),c=await p.resolve(account('xiaoyunque',file),config);
 await assert.rejects(p.status(c),e=>e.code==='video_session_rotation_unstable');assert.equal(reads,4);assert.deepEqual(await readFile(file),before);
});

await test('external source write during candidate identity fails pre-write CAS',async()=>{
 const file=await vault('pre-cas','xiaoyunque');let outside=false,ownWrites=0;
 const p=createGatewayVideoProvider('xiaoyunque',{writeVault:async(...args)=>{ownWrites++;return writeVideoSessionVault(...args);},fetchImpl:async(url,opt)=>{
  const fresh=cookie(opt).includes('SAMPLE_NEW');if(fresh&&!outside){outside=true;const s=input('xiaoyunque');s.cookies[0].value='SAMPLE_EXTERNAL';await writeVideoSessionVault(file,s,{principal:ids.xiaoyunque});}
  return asJson(identity('xiaoyunque'),fresh?[]:['sessionid=SAMPLE_NEW; Domain=.jianying.com; Path=/; Secure; HttpOnly']);
 }}),c=await p.resolve(account('xiaoyunque',file),config);
 await assert.rejects(p.status(c),e=>e.code==='video_session_source_changed');assert.equal(ownWrites,0);assert.equal((await readVideoSessionVault(file,{platform:'xiaoyunque'})).cookies[0].value,'SAMPLE_EXTERNAL');
});

await test('external source write after vault write fails post-write content/CAS and revokes stale capability',async()=>{
 const file=await vault('post-cas','xiaoyunque');let ownWrites=0;
 const p=createGatewayVideoProvider('xiaoyunque',{writeVault:async(...args)=>{assert.equal(args[2].expectedSourceHash,sha(await readFile(file)));ownWrites++;await writeVideoSessionVault(...args);const s=input('xiaoyunque');s.cookies[0].value='SAMPLE_EXTERNAL';await writeVideoSessionVault(file,s,{principal:ids.xiaoyunque});},fetchImpl:async(url,opt)=>asJson(identity('xiaoyunque'),cookie(opt).includes('SAMPLE_NEW')?[]:['sessionid=SAMPLE_NEW; Domain=.jianying.com; Path=/; Secure; HttpOnly'])}),c=await p.resolve(account('xiaoyunque',file),config);
 await assert.rejects(p.status(c),e=>e.code==='video_session_write_conflict'||e.code==='vault_write_failed');await assert.rejects(p.status(c),e=>e.code==='video_session_source_changed');assert.equal(ownWrites,1);
});

await test('B precondition false-attempt releases process fence; unknown false-attempt never releases it',async()=>{
 const file=await vault('precondition','xiaoyunque');let attempts=0,mode='precondition_failed';
 const p=createGatewayVideoProvider('xiaoyunque',{makeB:()=>({dailyStatus:async()=>({known:true,active:true,alreadyClaimed:false}),verifyIdentity:async()=>({authenticated:true,bound:true,principalHash:sha('xiaoyunque|'+origin.xiaoyunque+'|'+ids.xiaoyunque)}),claim:async()=>{attempts++;return {status:mode,operationAttempted:false,code:'baseline_history_incomplete'};}})}),c=await p.resolve(account('xiaoyunque',file),config);
 await assert.rejects(p.claim(c),e=>e.code==='baseline_history_incomplete'&&e.beforeSubmission===true);await assert.rejects(p.claim(c),e=>e.beforeSubmission===true);assert.equal(attempts,2);
 mode='settlement_pending';await assert.rejects(p.claim(c),e=>e.code==='video_daily_receipt_unconfirmed'&&e.beforeSubmission===false);await assert.rejects(p.claim(c),e=>e.code==='video_daily_previous_submission_pending'&&e.beforeSubmission===false);assert.equal(attempts,3);
});

await test('real B pre-dispatch identity401 is retryable in actual ClaimService/SQLite, not permanent uncertain',async()=>{
 const file=await vault('preflight401','xiaoyunque');let reads=0,actions=0;
 const p=createGatewayVideoProvider('xiaoyunque',{transport:async req=>{
  const u=new URL(req.url);if(u.pathname.includes('passport'))return {status:++reads===2?401:200,body:identity('xiaoyunque'),setCookies:[]};
  if(u.pathname.endsWith('user_credit_history'))return {status:200,body:{ret:'0',response:JSON.stringify({records:[],has_more:false,new_cursor:''})},setCookies:[]};
  assert.ok(u.pathname.endsWith('credit_receive'));actions++;return {status:200,body:{ret:'0',response:JSON.stringify({receive_quota:0})},setCookies:[]};
 }}),a=account('xiaoyunque',file),c=await p.resolve(a,config),data=path.join(dir,'preflight-db');await mkdir(data);const db=new Ledger(data);
 try{const conf={value:{accounts:[a],scheduler:{timezone:'Asia/Shanghai'}}},claims=new ClaimService(conf,{resolve:async()=>c},{status:async()=>p.status(c),claim:async()=>p.claim(c)},db),first=await claims.run(a.id,'daily-checkin',{trigger:'automatic'});assert.equal(first.status,'error');assert.equal(first.reason,'login_required');assert.equal(actions,0);const second=await claims.run(a.id,'daily-checkin',{trigger:'automatic'});assert.equal(second.status,'observed',JSON.stringify(second));assert.equal(second.automaticRewardConfirmed,false);assert.equal(actions,1);}finally{db.close();}
});

await test('official auth deletion persists expired tombstone; fresh CM/Platforms/Claims emit session_expired with zero network/replay',async()=>{
 const file=await vault('logout','hailuo');let reads=0,mutations=0;
 const p=createGatewayVideoProvider('hailuo',{fetchImpl:async(url)=>{reads++;if(new URL(url).pathname!=='/v1/api/user/info')mutations++;return asJson(identity('hailuo'),['_token=; Path=/; Max-Age=0; Secure; HttpOnly']);}}),c=await p.resolve(account('hailuo',file),config);
 await assert.rejects(p.status(c),e=>e.code==='video_session_expired');const s=await readVideoSessionVault(file,{platform:'hailuo'});assert.equal(s.expiresAtMs,1);assert.equal(s.accessToken,undefined);assert.equal(s.cookies[0].value,'SAMPLE_OLD');assert.equal(s.cookies[0].expirationDate,1);await assert.rejects(p.status(c),e=>e.code==='video_session_expired');assert.equal(reads,1);assert.equal(mutations,0);
 const data=path.join(dir,'restart');await mkdir(data);const conf={dataDir:data,path:p=>p,value:{accounts:[account('hailuo',file)],upstreams:[],routes:[],scheduler:{timezone:'Asia/Shanghai'}}},ledger=new Ledger(data),old=globalThis.fetch;let after=0;
 globalThis.fetch=async()=>{after++;throw Error('unexpected_real_request');};
 try{const cm=new CredentialManager(conf,ledger),platforms=new Platforms(conf,cm);await assert.rejects(cm.resolve('refresh-hailuo'),e=>e.code==='video_session_expired');await assert.rejects(platforms.status('refresh-hailuo','daily-checkin'),e=>e.code==='video_session_expired');const r=await new ClaimService(conf,cm,platforms,ledger).run('refresh-hailuo','daily-checkin',{trigger:'automatic'});assert.equal(r.status,'error');assert.equal(r.reason,'video_session_expired');assert.equal(r.automaticRewardConfirmed,false);assert.equal(r.operationAttempted,false);assert.equal(after,0);}finally{globalThis.fetch=old;ledger.close();}
});

await test('HTTP401 auth deletion also persists logout instead of silently retaining the old token',async()=>{
 const file=await vault('logout401','hailuo');let reads=0;
 const p=createGatewayVideoProvider('hailuo',{fetchImpl:async()=>{reads++;return new Response('{}',{status:401,headers:{'Set-Cookie':'_token=; Path=/; Max-Age=0; Secure; HttpOnly','Content-Type':'application/json'}});}}),c=await p.resolve(account('hailuo',file),config);
 await assert.rejects(p.status(c),e=>e.code==='video_session_expired');const s=await readVideoSessionVault(file,{platform:'hailuo'});assert.equal(s.expiresAtMs,1);assert.equal(s.accessToken,undefined);await assert.rejects(p.status(c),e=>e.code==='video_session_expired');assert.equal(reads,1);
});

const out={passed:results.length,failed:0,officialAccountRequests:0,browserProcesses:0,dpapi:'SAMPLE-crypt-injected; production DPAPI unchanged',results};await writeFile(path.join(root,'REFRESH_TEST_RESULT.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({...out,results:undefined}));
