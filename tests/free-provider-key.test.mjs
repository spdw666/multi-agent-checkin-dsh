import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,writeFile,rm,mkdir,readdir,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {ConfigStore,projectRoot} from '../src/config.mjs';
import {startServer} from '../src/server.mjs';
import {prepareFreeProviderConfig,resolveFreeCredential,freeProviderChat,buildFreeProviderConfig} from '../src/free-providers.mjs';
import {AppError,redact,hash} from '../src/util.mjs';

const row={id:'fixture-chat',context_length:65536,top_provider:{max_completion_tokens:8192},supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}};
const result={id:'fixture-response',model:row.id,choices:[{index:0,message:{role:'assistant',content:'KEY_FIXTURE_OK'},finish_reason:'stop'}]};
let seq=0;const fixtureKey=()=>`synthetic-typed-key-${++seq}`;
async function setup(t,{status=200,catalog={data:[row]},onCatalog,failSave=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'free-provider-key-')),calls=[];
 const value=JSON.parse(await readFile(join(projectRoot,'config.example.json'),'utf8'));
 value.accounts=[];value.upstreams=[];value.routes=[];value.server={...value.server,host:'127.0.0.1',port:0};value.dataDir=join(dir,'data');value.scheduler.enabled=false;
 const file=join(dir,'config.json');await writeFile(file,JSON.stringify(value));const config=new ConfigStore(file);await config.load();
 const ledger={get(){},records(){return [];}},router={async *chat(){yield result;},async models(){return {object:'list',data:[]};}},service={config,ledger,router,keys:{apiKey:'synthetic-api-auth',adminKey:'synthetic-admin-auth'}};
 t.mock.method(https,'request',(url,options,callback)=>{
  calls.push({url:String(url),method:options.method,headers:options.headers});const req=new PassThrough();req.resume();
  queueMicrotask(async()=>{try{await onCatalog?.(service,calls);const response=new PassThrough();response.statusCode=status;response.headers={'content-type':'application/json'};response.setTimeout=()=>response;callback(response);response.end(status>=400?'':JSON.stringify(catalog));}catch(e){req.emit('error',e);}});return req;
 });
 const runtime=await startServer(service,{port:0});
 t.after(async()=>{await runtime.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&dir.includes('free-provider-key-'));await rm(dir,{recursive:true,force:true});});
 if(failSave)config.save=async()=>{throw new AppError('Fixture config write failed',500,'fixture_save_failed');};
 const request=async(path,body,{auth='synthetic-admin-auth',method='POST'}={})=>fetch(runtime.baseUrl+path,{method,headers:{authorization:'Bearer '+auth,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const post=(body,options)=>request('/admin/free-provider-add',body,options),get=path=>request(path,undefined,{method:'GET'});
 const keyPath=id=>join(config.dataDir,'private','free-providers',id,'credentials.json');
 const absent=async path=>assert.rejects(stat(path),{code:'ENOENT'});
 return {dir,file,config,service,calls,post,get,request,keyPath,absent};
}

test('typed API key: real local HTTP, isolated private JSON, real ConfigStore and exact registered auth header',async t=>{
 const f=await setup(t),apiKey=fixtureKey(),reply=await f.post({providerId:'groq',id:'typed-main',apiKey,models:[row.id]});
 assert.equal(reply.status,200);const body=await reply.json();assert.deepEqual(body,{saved:true,accountId:'typed-main',upstreamId:'typed-main',routesAdded:1,credentialStatus:'configured',enabled:true});
 const a=f.config.value.accounts[0];assert.deepEqual(a.credentials,{kind:'file',file:await realpath(f.keyPath('typed-main'))});assert.deepEqual(JSON.parse(await readFile(a.credentials.file,'utf8')),{apiKey});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].headers.authorization,'Bearer '+apiKey);assert.equal(f.calls[0].url,'https://api.groq.com/openai/v1/models');
 const c=await resolveFreeCredential(a);let auth;
 const chat=await freeProviderChat({},c,{model:row.id,messages:[{role:'user',content:'fixture'}],max_tokens:32},undefined,{fetchImpl:async(_url,options)=>{auth=options.headers.authorization;return Response.json(options.method==='POST'?result:{data:[row]});}});
 assert.equal(auth,'Bearer '+apiKey);assert.equal((await chat.response.json()).choices[0].message.content,'KEY_FIXTURE_OK');
 assert.deepEqual(await readdir(join(f.config.dataDir,'private','free-providers','typed-main')),['credentials.json']);
 if(process.platform!=='win32')assert.equal((await stat(a.credentials.file)).mode&0o777,0o600);
 for(const text of [JSON.stringify(body),JSON.stringify(f.config.value),await readFile(f.file,'utf8'),await readFile(f.file+'.backup.json','utf8'),await(await f.get('/admin/config')).text(),await(await f.get('/admin/free-providers')).text()])assert.equal(text.includes(apiKey),false);
 assert.equal(redact('Fixture '+apiKey),'Fixture [REDACTED]');
});

test('provider authentication rejection preserves typed credentials but saves disabled pending status',async t=>{
 const f=await setup(t,{status:401}),apiKey=fixtureKey(),r=await f.post({providerId:'groq',id:'auth-pending',apiKey});
 assert.equal(r.status,200);const body=await r.json();assert.equal(body.saved,true);assert.equal(body.enabled,false);assert.equal(body.credentialStatus,'rejected');assert.equal(body.setupError.code,'free_provider_http_error');
 assert.equal(f.config.value.upstreams[0].enabled,false);assert.deepEqual(JSON.parse(await readFile(f.keyPath('auth-pending'),'utf8')),{apiKey});assert.equal(JSON.stringify(body).includes(apiKey),false);
});

test('catalog outage leaves account pending configured, not authenticated or connected',async t=>{
 const f=await setup(t,{status:503}),apiKey=fixtureKey(),r=await f.post({providerId:'groq',id:'catalog-pending',apiKey,models:[row.id]});
 assert.equal(r.status,200);const body=await r.json();assert.equal(body.enabled,false);assert.equal(body.credentialStatus,'configured');assert.equal(body.routesAdded,0);assert.equal(body.setupError.code,'free_provider_http_error');assert.equal(f.config.value.routes.length,0);
});

test('blank typed key saves mandatory-key provider pending without files or network',async t=>{
 const f=await setup(t),r=await f.post({providerId:'groq',id:'blank-main',apiKey:'   '});assert.equal(r.status,200);const body=await r.json();assert.equal(body.credentialStatus,'missing');assert.equal(body.enabled,false);assert.equal(f.calls.length,0);assert.deepEqual(f.config.value.accounts[0].credentials,{kind:'none'});await f.absent(f.keyPath('blank-main'));
});

test('blank typed key supports documented anonymous provider only after zero-price catalog fixture',async t=>{
 const f=await setup(t),r=await f.post({providerId:'kilo',id:'anonymous-main',apiKey:'',models:[row.id]});assert.equal(r.status,200);const body=await r.json();assert.equal(body.credentialStatus,'anonymous');assert.equal(body.enabled,true);assert.equal(body.routesAdded,1);assert.equal(f.calls[0].headers.authorization,undefined);await f.absent(f.keyPath('anonymous-main'));
});

test('typed key input rejects non-string, excessive length, CRLF, embedded whitespace and control bytes pre-write',async t=>{
 const f=await setup(t);const invalid=[null,42,{},'X'.repeat(16385),'fixture\r\ninjected','fixture\0bad','fixture key','fixture\tkey','中文fixture'];
 for(let i=0;i<invalid.length;i++){const r=await f.post({providerId:'groq',id:'invalid-'+i,apiKey:invalid[i]});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'invalid_api_key');await f.absent(f.keyPath('invalid-'+i));}assert.equal(f.calls.length,0);assert.equal(f.config.value.accounts.length,0);
});

test('Cloudflare typed token requires and privately stores valid accountId, uses official account endpoint',async t=>{
 const f=await setup(t),apiKey=fixtureKey(),accountId='a'.repeat(32),r=await f.post({providerId:'cloudflare',id:'cloudflare-main',apiKey,accountId,models:[row.id]});assert.equal(r.status,200);assert.equal((await r.json()).enabled,true);assert.deepEqual(JSON.parse(await readFile(f.keyPath('cloudflare-main'),'utf8')),{apiKey,accountId});assert.equal(f.calls[0].url,`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`);assert.equal(f.calls[0].headers.authorization,'Bearer '+apiKey);assert.equal(JSON.stringify(f.config.value).includes(accountId),false);
});

test('Cloudflare absent or invalid accountId and accountId for other providers reject without filesystem effects',async t=>{
 const f=await setup(t),apiKey=fixtureKey(),cases=[{providerId:'cloudflare'},{providerId:'cloudflare',accountId:'../fixture'},{providerId:'cloudflare',accountId:42},{providerId:'groq',accountId:'a'.repeat(32)}];
 for(let i=0;i<cases.length;i++){const r=await f.post({...cases[i],id:'account-id-'+i,apiKey});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'invalid_account_id');}assert.equal(f.calls.length,0);await f.absent(join(f.config.dataDir,'private'));
});

test('allowlist, account path and model validation precede files and early secret remembering redacts later diagnostics',async t=>{
 const f=await setup(t),apiKey=fixtureKey(),cases=[{unknown:'fixture'},{id:'../escape'},{id:'NUL'},{id:'x'.repeat(81)},{models:['a','a']},{models:['model\nvalue']},{models:['x'.repeat(257)]},{models:[apiKey]}];
 for(let i=0;i<cases.length;i++){const r=await f.post({providerId:'groq',id:'validation-'+i,apiKey,...cases[i]});assert.equal(r.status,400);assert.equal((await r.text()).includes(apiKey),false);}assert.equal(f.calls.length,0);await f.absent(join(f.config.dataDir,'private'));assert.equal(redact('diagnostic '+apiKey),'diagnostic [REDACTED]');
});

test('typed-key and legacy-file fields are mutually exclusive including blank typed key',async t=>{
 const f=await setup(t),file=join(f.dir,'legacy.json');await writeFile(file,JSON.stringify({apiKey:fixtureKey()}));const before=hash(await readFile(file));
 for(const apiKey of [fixtureKey(),'']){const r=await f.post({providerId:'groq',id:'conflicting-main',apiKey,credentialFile:file});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'conflicting_credentials');}assert.equal(hash(await readFile(file)),before);assert.equal(f.calls.length,0);await f.absent(f.keyPath('conflicting-main'));
});

test('legacy absolute credentialFile remains supported and its exact original bytes are unchanged',async t=>{
 const f=await setup(t),apiKey=fixtureKey(),file=join(f.dir,'legacy-original.json');await writeFile(file,JSON.stringify({apiKey,models:[]})+'\n');const before=hash(await readFile(file));const r=await f.post({providerId:'groq',id:'legacy-main',credentialFile:file});assert.equal(r.status,200);assert.equal((await r.json()).enabled,true);assert.equal(f.config.value.accounts[0].credentials.file,file);assert.equal(hash(await readFile(file)),before);await f.absent(f.keyPath('legacy-main'));assert.equal(f.calls[0].headers.authorization,'Bearer '+apiKey);
 for(const credentialFile of ['relative.json','bad\npath',42]){const invalid=await f.post({providerId:'groq',id:'bad-path',credentialFile});assert.equal(invalid.status,400);}
});

test('duplicate existing account or upstream is rejected before directory creation and discovery',async t=>{
 const f=await setup(t),base=f.config.value;f.config.value={...base,accounts:[{id:'duplicate-main'}]};let r=await f.post({providerId:'groq',id:'duplicate-main',apiKey:fixtureKey()});assert.equal(r.status,409);assert.equal((await r.json()).error.code,'duplicate_account');f.config.value={...base,upstreams:[{id:'duplicate-main'}]};r=await f.post({providerId:'groq',id:'duplicate-main',apiKey:fixtureKey()});assert.equal(r.status,409);assert.equal(f.calls.length,0);await f.absent(join(f.config.dataDir,'private'));
});

test('orphan private credentials are never overwritten by reused ID',async t=>{
 const f=await setup(t),file=f.keyPath('orphan-main');await mkdir(join(file,'..'),{recursive:true});await writeFile(file,JSON.stringify({apiKey:fixtureKey()}));const before=hash(await readFile(file));const r=await f.post({providerId:'groq',id:'orphan-main',apiKey:fixtureKey()});assert.equal(r.status,409);assert.equal((await r.json()).error.code,'credential_file_exists');assert.equal(hash(await readFile(file)),before);assert.equal(f.config.value.accounts.length,0);assert.equal(f.calls.length,0);
});

test('unverified selected model aborts the transaction and removes only the new managed file',async t=>{
 const f=await setup(t),before=hash(await readFile(f.file)),r=await f.post({providerId:'groq',id:'bad-model',apiKey:fixtureKey(),models:['not-in-catalog']});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'invalid_model');assert.equal(hash(await readFile(f.file)),before);assert.equal(f.config.value.accounts.length,0);await f.absent(join(f.config.dataDir,'private','free-providers','bad-model'));
});

test('config save failure rolls back typed-key file and redacts secret from thrown persistence diagnostics',async t=>{
 const f=await setup(t),apiKey=fixtureKey(),before=hash(await readFile(f.file));f.config.save=async()=>{throw new AppError('Fixture write failure '+apiKey,500,'fixture_save_failed');};const r=await f.post({providerId:'groq',id:'save-fails',apiKey});assert.equal(r.status,500);const text=await r.text();assert.equal(text.includes(apiKey),false);assert.ok(text.includes('[REDACTED]'));assert.equal(hash(await readFile(f.file)),before);assert.equal(f.config.value.accounts.length,0);await f.absent(join(f.config.dataDir,'private','free-providers','save-fails'));
});

test('configuration changed during remote verification preserves concurrent save and removes abandoned key file',async t=>{
 const f=await setup(t,{onCatalog:async service=>{const v=structuredClone(service.config.value);v.scheduler.minute=(v.scheduler.minute+1)%60;await service.config.save(v);}}),minute=f.config.value.scheduler.minute;
 const r=await f.post({providerId:'groq',id:'concurrent-main',apiKey:fixtureKey()});assert.equal(r.status,409);assert.equal((await r.json()).error.code,'configuration_changed');assert.equal(f.config.value.scheduler.minute,(minute+1)%60);assert.equal(f.config.value.accounts.length,0);assert.equal(JSON.parse(await readFile(f.file,'utf8')).scheduler.minute,(minute+1)%60);await f.absent(f.keyPath('concurrent-main'));
});

test('real ConfigStore late-load failure restores exact pre-commit config bytes before key cleanup',async t=>{
 const f=await setup(t),apiKey=fixtureKey(),before=await readFile(f.file),original=f.config.value;f.config.load=async()=>{throw new AppError('Fixture late reload failed '+apiKey,500,'fixture_load_failed');};
 const r=await f.post({providerId:'groq',id:'late-load-fails',apiKey});assert.equal(r.status,500);const text=await r.text();assert.equal(text.includes(apiKey),false);assert.ok(text.includes('fixture_load_failed'));assert.deepEqual(await readFile(f.file),before);assert.equal(f.config.value,original);await f.absent(f.keyPath('late-load-fails'));
 const backup=await readFile(f.file+'.backup.json','utf8');assert.equal(backup.includes(apiKey),false);assert.deepEqual(JSON.parse(backup),JSON.parse(before));
});

test('late save failure preserves a changed disk config and the new credential it still references',async t=>{
 const f=await setup(t),apiKey=fixtureKey();f.config.save=async value=>{const edited=structuredClone(value);edited.scheduler.minute=(edited.scheduler.minute+1)%60;await writeFile(f.file,JSON.stringify(edited));f.config.value=edited;throw new AppError('Fixture external write followed by failure',500,'fixture_save_failed');};
 const r=await f.post({providerId:'groq',id:'disk-changed',apiKey});assert.equal(r.status,409);assert.equal((await r.json()).error.code,'configuration_changed');assert.equal(f.config.value.accounts[0].id,'disk-changed');assert.equal(JSON.parse(await readFile(f.file,'utf8')).accounts[0].id,'disk-changed');assert.deepEqual(JSON.parse(await readFile(f.keyPath('disk-changed'),'utf8')),{apiKey});
});

test('ambiguous disk recovery keeps the new credential and reports a typed recovery error',async t=>{
 const f=await setup(t),apiKey=fixtureKey();f.config.save=async()=>{await writeFile(f.file,'{fixture-incomplete-json');throw new AppError('Fixture ambiguous persistence failure',500,'fixture_save_failed');};const r=await f.post({providerId:'groq',id:'recovery-unknown',apiKey});assert.equal(r.status,500);assert.equal((await r.json()).error.code,'configuration_recovery_required');assert.deepEqual(JSON.parse(await readFile(f.keyPath('recovery-unknown'),'utf8')),{apiKey});assert.equal(await readFile(f.file,'utf8'),'{fixture-incomplete-json');
});

test('simultaneous same-ID typed-key requests have one winner and preserve the winner key',async t=>{
 const f=await setup(t),keys=[fixtureKey(),fixtureKey()],requests=await Promise.all(keys.map(apiKey=>f.post({providerId:'groq',id:'same-main',apiKey})));assert.deepEqual(requests.map(r=>r.status).sort(),[200,409]);const winner=requests.findIndex(r=>r.status===200);assert.equal(f.config.value.accounts.length,1);assert.equal(f.calls.length,1);assert.deepEqual(JSON.parse(await readFile(f.keyPath('same-main'),'utf8')),{apiKey:keys[winner]});
});

test('invalid managed parent directory rejects with no leaked key or user-file deletion',async t=>{
 const f=await setup(t),apiKey=fixtureKey();await mkdir(f.config.dataDir,{recursive:true});const file=join(f.config.dataDir,'private');await writeFile(file,'original-not-directory');const r=await f.post({providerId:'groq',id:'bad-dir',apiKey});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'invalid_credential_directory');assert.equal(await readFile(file,'utf8'),'original-not-directory');assert.equal(f.calls.length,0);assert.equal(f.config.value.accounts.length,0);
});

test('transaction rollback restores initial file behavior, commit keeps file, and subsequent user edits are preserved',async t=>{
 const f=await setup(t),prepared=await prepareFreeProviderConfig(f.config,f.config.value,{providerId:'groq',id:'rollback-copy',apiKey:fixtureKey()});assert.equal((await stat(f.keyPath('rollback-copy'))).isFile(),true);await prepared.rollback();await f.absent(f.keyPath('rollback-copy'));assert.equal(f.config.value.accounts.length,0);
 const committed=await prepareFreeProviderConfig(f.config,f.config.value,{providerId:'groq',id:'committed-copy',apiKey:fixtureKey()});committed.commit();await committed.rollback();assert.equal((await stat(f.keyPath('committed-copy'))).isFile(),true);
 const edited=await prepareFreeProviderConfig(f.config,f.config.value,{providerId:'groq',id:'edited-copy',apiKey:fixtureKey()});const newText=JSON.stringify({apiKey:fixtureKey(),ownerEdit:true});await writeFile(f.keyPath('edited-copy'),newText);await edited.rollback();assert.equal(await readFile(f.keyPath('edited-copy'),'utf8'),newText);
});

test('real HTTP 503/429 includes numeric Retry-After header/body and excludes invalid values or other statuses',async t=>{
 const f=await setup(t);const request={model:'fixture-model',messages:[{role:'user',content:'fixture'}]};
 for(const [status,value] of [[503,12.1],[429,4],[503,-1],[503,Infinity],[503,'10'],[402,7]]){
  f.service.router.chat=async function*(){const e=new AppError('Same model fixture cooling down',status,'same_model_cooling_down');e.retryAfterSeconds=value;throw e;};
  const r=await f.request('/v1/chat/completions',request,{auth:'synthetic-api-auth'}),body=await r.json();assert.equal(r.status,status);
  const valid=[503,429].includes(status)&&Number.isFinite(value)&&value>=0;assert.equal(r.headers.get('retry-after'),valid?String(Math.ceil(value)):null);assert.equal(body.error.retryAfterSeconds,valid?value:undefined);
 }
});

test('provider add requires admin authentication before it creates any credentials or discovers catalogs',async t=>{
 const f=await setup(t),r=await f.post({providerId:'groq',id:'unauth-main',apiKey:fixtureKey()},{auth:'synthetic-api-auth'});assert.equal(r.status,401);assert.equal(f.config.value.accounts.length,0);assert.equal(f.calls.length,0);await f.absent(join(f.config.dataDir,'private'));
});

test('pure config builder never embeds a typed key in management configuration',()=>{
 const apiKey=fixtureKey(),value=buildFreeProviderConfig({accounts:[],upstreams:[],routes:[]},{providerId:'groq',id:'pure-main',apiKey});assert.equal(JSON.stringify(value).includes(apiKey),false);assert.deepEqual(value.accounts[0].credentials,{kind:'none'});assert.equal(value.accounts[0].enabled,false);
});
