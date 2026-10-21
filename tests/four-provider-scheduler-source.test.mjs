import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {Scheduler}=await import(pathToFileURL(join(root,'src/scheduler.mjs')));
const {CredentialManager}=await import(pathToFileURL(join(root,'src/credentials.mjs')));
const {codeartsProvider}=await import(pathToFileURL(join(root,'src/provider-codearts.mjs')));

const row=(accountId,status,more={})=>({accountId,task:'daily-checkin',status,...more});
function fixture({all,startup=false,serviceCredentials=false}={}) {
  const RealDate=globalThis.Date;let now=RealDate.parse('2026-10-21T04:00:01Z');
  class Clock extends RealDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  globalThis.Date=Clock;
  const config={value:{scheduler:{enabled:true,startup,timezone:'Asia/Shanghai',hour:0,minute:0,jitterSeconds:0,retryMinutes:60},accounts:['a','b'].map(id=>({id,platform:'codearts',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}))}};
  const ledger={values:new Map(),get(k){return this.values.get(k)},set(k,v){this.values.set(k,structuredClone(v));}};
  const versions=new Map([['a','fixture-a-v1'],['b','fixture-b-v1']]),reads=[],calls=[];
  let sourceHook;
  const credentials={async sourceVersion(id){reads.push(id);if(sourceHook)return sourceHook(id);return versions.get(id)??null;}};
  const claims={all:async(options,context)=>{calls.push({options:options===undefined?null:structuredClone(options),context:structuredClone(context)});return all?all(options,context,calls.length):[row('a','error',{loginRequired:true}),row('b','success')];}};
  if(!serviceCredentials)claims.credentials=credentials;
  const scheduler=new Scheduler(config,claims,ledger);scheduler.stopped=false;
  if(serviceCredentials){config.value.clientUpdates={enabled:false};scheduler.service={credentials,config,ledger};}
  return {scheduler,ledger,versions,reads,calls,credentials,config,advance(ms){now+=ms},now:()=>now,setSourceHook(fn){sourceHook=fn},async close(){await scheduler.stop();globalThis.Date=RealDate;}};
}

test('automatic scheduler captures credential version before a failed batch, not after it',async()=>{
  let f;f=fixture({all:async()=>{f.versions.set('a','fixture-a-v2');return [row('a','error',{loginRequired:true}),row('b','success')];}});
  try {await f.scheduler.tick();assert.equal(f.ledger.get('schedule-last').tasks.find(r=>r.accountId==='a').credentialSourceVersion,'fixture-a-v1');}
  finally {await f.close();}
});

test('changed native login wakes only the blocked task within thirty seconds instead of waiting one hour',async()=>{
  const f=fixture();try {
    await f.scheduler.tick();f.versions.set('a','fixture-a-v2');f.versions.set('b','fixture-b-v2');
    f.advance(29999);await f.scheduler.tick();assert.equal(f.calls.length,1);
    f.advance(1);await f.scheduler.tick();assert.equal(f.calls.length,2);
    assert.deepEqual(f.calls[1].options,{tasks:[{accountId:'a',task:'daily-checkin'}]});
    assert.deepEqual(f.calls[1].context,{trigger:'automatic',source:'credential-change'});
    assert.equal(f.ledger.get('schedule-last').tasks.find(r=>r.accountId==='a').credentialSourceVersion,'fixture-a-v2');
    f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,2);
  } finally {await f.close();}
});

test('stable login versions do not turn authentication backoff into repeated submissions',async()=>{
  const f=fixture();try {await f.scheduler.tick();for(let n=0;n<4;n++){f.advance(30000);await f.scheduler.tick();}assert.equal(f.calls.length,1);}
  finally {await f.close();}
});

test('legacy login failures without a source stamp receive one bounded migration recheck',async()=>{
  const f=fixture();try {
    await f.scheduler.tick();const last=f.ledger.get('schedule-last');delete last.tasks[0].credentialSourceVersion;f.ledger.set('schedule-last',last);
    f.advance(29999);await f.scheduler.tick();assert.equal(f.calls.length,1);
    f.advance(1);await f.scheduler.tick();assert.equal(f.calls.length,2);
    assert.equal(f.ledger.get('schedule-last').tasks[0].credentialSourceVersion,'fixture-a-v1');
    f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,2);
  } finally {await f.close();}
});

test('unknown or failing source reads neither overwrite the old stamp nor manufacture a login change',async()=>{
  const f=fixture();try {
    await f.scheduler.tick();f.versions.set('a',null);f.advance(30000);await f.scheduler.tick();
    assert.equal(f.calls.length,1);assert.equal(f.ledger.get('schedule-last').tasks[0].credentialSourceVersion,'fixture-a-v1');
    f.setSourceHook(async()=>{throw Error('fixture source unavailable')});f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,1);
    f.setSourceHook(undefined);f.versions.set('a','fixture-a-v2');f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,2);
  } finally {await f.close();}
});

test('a failed recheck with temporarily unreadable source retains the previous successful stamp',async()=>{
  const f=fixture();try {
    await f.scheduler.tick();f.versions.set('a',null);f.advance(3600000);await f.scheduler.tick();
    assert.equal(f.calls.length,2);assert.equal(f.ledger.get('schedule-last').tasks[0].credentialSourceVersion,'fixture-a-v1');
  } finally {await f.close();}
});

test('successful tasks and explicit rate-limited failures never use credential-change wakeup',async()=>{
  const f=fixture({all:async()=>[row('a','error',{loginRequired:true,retryAt:new Date(Date.now()+7200000).toISOString(),reason:'codearts_refresh_deferred'}),row('b','success')]});
  try {await f.scheduler.tick();f.versions.set('a','fixture-a-v2');f.versions.set('b','fixture-b-v2');f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,1);}
  finally {await f.close();}
});

test('async source comparison is fenced against overlapping scheduler ticks',async()=>{
  const f=fixture();try {
    await f.scheduler.tick();f.advance(30000);let release;const gate=new Promise(r=>{release=r});let waiting=false;
    f.setSourceHook(async id=>{if(id==='a'){waiting=true;await gate;}return 'fixture-'+id+'-v2';});
    const one=f.scheduler.tick();for(let i=0;i<100&&!waiting;i++)await new Promise(r=>setImmediate(r));
    assert.equal(waiting,true,'source comparison must run before a credential wake-up');
    const two=f.scheduler.tick();release();await Promise.all([one,two]);assert.equal(f.calls.length,2);
  } finally {await f.close();}
});

test('scheduler passes automatic trigger in the second argument and persists operation attribution',async()=>{
  const f=fixture({all:async(_opts,context)=>[row('a','success',{operationAttempted:true,automaticOperationConfirmed:true,automaticRewardConfirmed:true,trigger:context?.trigger,triggerSource:context?.source}),row('b','success')]});
  try {
    await f.scheduler.tick();assert.equal(f.calls[0].options,null);assert.deepEqual(f.calls[0].context,{trigger:'automatic',source:'scheduled'});
    const saved=f.ledger.get('schedule-last');for(const result of [saved.tasks[0],saved.results[0]]){
      assert.equal(result.operationAttempted,true);assert.equal(result.automaticOperationConfirmed,true);assert.equal(result.automaticRewardConfirmed,true);assert.equal(result.trigger,'automatic');assert.equal(result.triggerSource,'scheduled');
    }
  } finally {await f.close();}
});

test('source wake can use service credentials without calling a provider resolve',async()=>{
  const f=fixture({serviceCredentials:true});try {await f.scheduler.tick();f.versions.set('a','fixture-a-v2');f.advance(30000);await f.scheduler.tick();assert.equal(f.calls.length,2);}
  finally {await f.close();}
});

test('startup and ordinary recovery are attributed as automatic without changing the first argument',async()=>{
  const f=fixture({startup:true,all:async()=>[row('a','error'),row('b','success')]});try {
    f.scheduler.stopped=true;f.scheduler.start();await Promise.all([...f.scheduler.jobs]);
    assert.deepEqual(f.calls[0],{options:null,context:{trigger:'automatic',source:'startup'}});
    f.advance(60000);await f.scheduler.tick();assert.deepEqual(f.calls[1],{options:{tasks:[{accountId:'a',task:'daily-checkin'}]},context:{trigger:'automatic',source:'recovery'}});
  } finally {await f.close();}
});

test('CredentialManager sourceVersion delegates only the read-only provider source API',async()=>{
  const original=codeartsProvider.credentialSourceVersion,resolve=codeartsProvider.resolve;
  const account={id:'a',platform:'codearts',enabled:true,credentials:{file:'fixture-source'}};
  const config={value:{accounts:[account,{id:'b',platform:'SAMPLE',enabled:true}]}};
  const manager=new CredentialManager(config,{bind(){throw Error('source inspection must not bind credentials')}});
  let calls=0;codeartsProvider.resolve=()=>{throw Error('source inspection must not resolve credentials')};
  codeartsProvider.credentialSourceVersion=async(a,c)=>{calls++;assert.equal(a,account);assert.equal(c,config);return 'fixture-version'};
  try {
    assert.equal(await manager.sourceVersion('a'),'fixture-version');assert.equal(calls,1);
    assert.equal(await manager.sourceVersion('b'),null);assert.equal(await manager.sourceVersion('absent'),null);
    codeartsProvider.credentialSourceVersion=async()=>{throw Error('fixture SQLite locked')};assert.equal(await manager.sourceVersion('a'),null);
    codeartsProvider.credentialSourceVersion=async()=>null;assert.equal(await manager.sourceVersion('a'),null);
  } finally {codeartsProvider.credentialSourceVersion=original;codeartsProvider.resolve=resolve;}
});
