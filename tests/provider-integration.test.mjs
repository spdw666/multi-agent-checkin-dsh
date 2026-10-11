import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaimService} from '../src/claims.mjs';
import {Scheduler} from '../src/scheduler.mjs';
import {Ledger} from '../src/store.mjs';
import {validateConfig} from '../src/config.mjs';
import {desktopProviderKinds,desktopBalance,providerCapabilities} from '../src/provider-registry.mjs';
import {importModels} from '../src/model-directory.mjs';
const schedule={enabled:true,startup:false,timezone:'Asia/Shanghai',hour:0,minute:0,jitterSeconds:0,retryMinutes:60};
test('all desktop kinds validate without changing existing account switches',async()=>{
 const c=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url)));c.accounts=[];c.upstreams=[];c.routes=[];
 for(const kind of desktopProviderKinds){c.accounts.push({id:kind,platform:kind,enabled:false,credentials:{kind:'desktop',file:'auto'}});c.upstreams.push({id:kind,kind,accountId:kind,enabled:false})}
 assert.equal(validateConfig(c),c);assert.ok(c.accounts.every(a=>!a.enabled));
 c.accounts[0].credentials.apiKey='fixture';assert.throws(()=>validateConfig(c),e=>e.code==='inline_credentials');
});
test('desktop capabilities and unavailable balance do not invent zero credits or check-in',()=>{
 assert.equal(providerCapabilities({}, {supportsCheckin:true}).checkin,true);
 assert.equal(providerCapabilities({chat(){}},{capabilities:{checkin:false}}).checkin,false);
 assert.equal(desktopBalance({status:'authenticated',balance:{value:null,unit:'Credits'}}).value,null);
 assert.equal(desktopBalance({status:'authenticated',balance:{value:0}}).value,0);
});
test('Qoder campaign-window idempotency permits the next 10:00 window on the same day',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'campaign-test-')),ledger=new Ledger(dir);let window='one',claimed=false,posts=0;
 const config={value:{scheduler:schedule,accounts:[{id:'q',platform:'qoder',tasks:[{id:'daily-checkin',enabled:true}]}]}};
 const service=new ClaimService(config,{resolve:async()=>({principalHash:'fixture'})},{status:async()=>({known:true,active:true,claimed,campaignWindowId:window,nextClaimAt:new Date(Date.now()+3600000).toISOString()}),claim:async()=>{posts++;claimed=true;return {credit:100}}},ledger);
 try{assert.equal((await service.run('q')).status,'success');assert.equal((await service.run('q')).status,'already');assert.equal(posts,1);window='two';claimed=false;assert.equal((await service.run('q')).status,'success');assert.equal(posts,2)}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('scheduler wakes at provider window after its natural-day run already completed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'window-schedule-')),ledger=new Ledger(dir),config={value:{scheduler:schedule,accounts:[]}};let runs=0;
 const scheduler=new Scheduler(config,{all:async()=>{runs++;return [{status:'already',nextClaimAt:new Date(Date.now()+3600000).toISOString()}]}},ledger);scheduler.stopped=false;
 try{await scheduler.tick();await scheduler.tick();assert.equal(runs,1);const last=ledger.get('schedule-last');ledger.set('schedule-last',{...last,nextClaimAt:Date.now()-1});await scheduler.tick();assert.equal(runs,2);await scheduler.tick();assert.equal(runs,2)}finally{await scheduler.stop();ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('new provider imports retain brand names and preserve other disabled routes',async()=>{
 const value={upstreams:[{id:'q',kind:'qoder',accountId:'q'}],routes:[{id:'old',enabled:false,targets:[{upstreamId:'q',model:'old'}]}]};
 const service={config:{value,save:async c=>{service.config.value=c}},platforms:{models:async()=>[{id:'qfmodel',name:'Real model',callable:true}]}};
 await importModels(service,[{upstreamId:'q',model:'qfmodel'}]);assert.equal(service.config.value.routes[0].enabled,false);assert.equal(service.config.value.routes[1].name,'Qoder · Real model');
});

test('management config rejects all new provider inline credential aliases',async()=>{const base=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url)));for(const field of ['token','secret','accessKey','secretKey','securityToken','machineToken','clientSecret','privateKey','secretAccessKey','sessionToken','bearerToken','idToken']){const c=structuredClone(base);c.accounts[0].credentials[field]='SYNTHETIC-ONLY';assert.throws(()=>validateConfig(c),e=>e.code==='inline_credentials',field);}});
test('Qoder reused campaign id is independently claimable after its 10:00 day boundary',async()=>{const dir=await mkdtemp(join(tmpdir(),'campaign-day-')),ledger=new Ledger(dir);let day='2026-10-10',claimed=false,posts=0;const config={value:{scheduler:schedule,accounts:[{id:'q',platform:'qoder',tasks:[{id:'daily-checkin',enabled:true}]}]}};const service=new ClaimService(config,{resolve:async()=>({principalHash:'fixture'})},{status:async()=>({known:true,active:true,claimed,day,campaignWindowId:'same-id',nextClaimAt:new Date(Date.now()+3600000).toISOString()}),claim:async()=>{posts++;claimed=true;return {credit:100}}},ledger);try{assert.equal((await service.run('q')).status,'success');assert.equal((await service.run('q')).status,'already');day='2026-10-11';claimed=false;assert.equal((await service.run('q')).status,'success');assert.equal(posts,2);}finally{ledger.close();await rm(dir,{recursive:true,force:true});}});
test('shared model refresh forwards both refresh and provider force without exposing credentials',async()=>{const {Platforms}=await import('../src/platforms.mjs');const {qoderProvider}=await import('../src/provider-qoder.mjs');const old=qoderProvider.models,seen=[];const account={id:'q',platform:'qoder'},config={value:{accounts:[account],upstreams:[{id:'q-up',kind:'qoder',accountId:'q'}]}};qoderProvider.models=async(_credential,options)=>{seen.push(options);return [{id:'fixture',contextWindow:1000,maxTokens:100}]};try{const p=new Platforms(config,{account:()=>account,resolve:async()=>({accessToken:'SYNTHETIC-ONLY'})});await p.models('q-up');await p.models('q-up');await p.models('q-up',{refresh:true});assert.equal(seen.length,2);assert.equal(seen[0].force,false);assert.equal(seen[1].refresh,true);assert.equal(seen[1].force,true);assert.ok(seen[1].signal instanceof AbortSignal);}finally{qoderProvider.models=old;}});

test('balance cache reflects current enabled and label without extra health request',async()=>{const {balances}=await import('../src/balances.mjs');const account={id:'q',platform:'qoder',edition:'cn',label:'before',enabled:true};let reads=0;const service={config:{value:{accounts:[account]}},platforms:{health:async()=>{reads++;return {status:'authenticated',balance:{value:100},capabilities:{checkin:true}}}}};await balances(service);Object.assign(account,{enabled:false,label:'after'});const row=(await balances(service)).accounts[0];assert.equal(row.enabled,false);assert.equal(row.edition,'cn');assert.equal(row.label,'after');assert.equal(row.value,100);assert.equal(reads,1);assert.equal(account.enabled,false);});
test('partial checkin preserves unknown capability and error instead of saying unsupported',()=>{const health={status:'authenticated',checkin:{known:false,error:'provider_http_error'},supportsCheckin:false,capabilities:{checkin:false,inference:true},balance:{value:null}};const capabilities=providerCapabilities({supportsCheckin:true},health);assert.equal(capabilities.checkin,null);const row=desktopBalance({...health,capabilities});assert.equal(row.checkinKnown,false);assert.equal(row.checkinError,'provider_http_error');assert.equal(row.value,null);assert.equal(row.credentialStatus,'authenticated');});

test('balance cache isolates editions and credential references instead of relabeling old region values',async()=>{const {balances}=await import('../src/balances.mjs');const account={id:'q',platform:'qoder',edition:'cn',credentials:{kind:'file',file:'CN_PRIVATE_REF'}};let reads=0;const service={config:{value:{accounts:[account]}},platforms:{health:async()=>{reads++;return {status:'authenticated',balance:{value:account.edition==='cn'?100:account.credentials.file==='GLOBAL_REF'?200:300},capabilities:{checkin:true}}}}};assert.equal((await balances(service)).accounts[0].value,100);account.edition='global';account.credentials.file='GLOBAL_REF';const global=(await balances(service)).accounts[0];assert.equal(global.edition,'global');assert.equal(global.value,200);assert.equal(reads,2);account.credentials.file='OTHER_GLOBAL_REF';assert.equal((await balances(service)).accounts[0].value,300);assert.equal(reads,3);});

test('catalog imports encode colon/free and long IDs without changing real upstream target',async()=>{
 const {importedRouteId}=await import('../src/model-directory.mjs');const colon=importedRouteId('cline','liquid/model:free');
 assert.match(colon,/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/);assert.notEqual(colon,importedRouteId('cline','liquid/model_free'));assert.equal(importedRouteId('q','qfmodel'),'q/qfmodel');assert.ok(importedRouteId('q','a'.repeat(220)).length<=128);
 const service={config:{value:{upstreams:[{id:'cline',kind:'cline'}],routes:[]},save:async c=>{service.config.value=c}},platforms:{models:async()=>[{id:'liquid/model:free',name:'Free',callable:true}]}};
 await importModels(service,[{upstreamId:'cline',model:'liquid/model:free'}]);assert.equal(service.config.value.routes[0].targets[0].model,'liquid/model:free');assert.equal(service.config.value.routes[0].id,colon);
});
