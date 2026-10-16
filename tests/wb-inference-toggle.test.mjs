import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigStore,validateConfig} from '../src/config.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {withConfigMutation} from '../src/model-directory.mjs';
import {setWorkBuddyInference,workBuddySummary,switchWorkBuddyAccount} from '../src/workbuddy-management.mjs';
import {WorkBuddyPool,workBuddyParticipation} from '../src/workbuddy-pool.mjs';
import {ModelRelay} from '../src/model-relay.mjs';
import {Router} from '../src/router.mjs';
import {Platforms} from '../src/platforms.mjs';
import {collectChat} from '../src/openai.mjs';

const msg={model:'pool',messages:[{role:'user',content:'SAMPLE'}]};
const response=()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'SAMPLE_OK'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
const models=async()=>[{id:'sample-model',callable:true,tools:true,contextWindow:32768,maxTokens:4096}];
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'wb-inference-')),value=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url),'utf8'));
  value.dataDir=join(dir,'data');value.server.port=0;value.scheduler.enabled=false;value.scheduler.startup=false;value.workbuddy={autoTasks:true,autoMigrateSessions:false};
  value.accounts=['a','b'].map(id=>({id,label:'SAMPLE_'+id,platform:'workbuddy',edition:'cn',enabled:true,credentials:{kind:'file',file:join(dir,id+'.json')},tasks:[{id:'daily-checkin',enabled:true}]}));
  value.accounts.push({id:'other',platform:'workbuddyai',enabled:true,inferenceEnabled:false,credentials:{kind:'file',file:join(dir,'other.json')},tasks:[]});
  value.upstreams=value.accounts.map(a=>({id:'u'+a.id,kind:a.platform,accountId:a.id,enabled:true}));
  value.routes=[{id:'pool',enabled:true,targets:[{upstreamId:'ua',model:'sample-model'}],accountPool:{enabled:true,accountIds:['a','b'],cooldownSeconds:60}},{id:'single',enabled:true,relay:false,targets:[{upstreamId:'ua',model:'sample-model'}]},{id:'other',enabled:true,relay:false,targets:[{upstreamId:'uother',model:'sample-model'}]}];
  for(const a of value.accounts)await writeFile(a.credentials.file,JSON.stringify({accessToken:'SAMPLE_TOKEN',uid:'SAMPLE_'+a.id,principal:'SAMPLE_'+a.id,edition:'cn',domain:'www.workbuddy.cn'}));
  const file=join(dir,'config.json');await writeFile(file,JSON.stringify(value));
  const service=await createService(file,{workbuddyRuntime:{sessionRoot:()=>join(dir,'sessions'),isRunning:async()=>false}});
  service.platforms.models=models;
  return {dir,file,service,async close(){await service.close();await rm(dir,{recursive:true,force:true,maxRetries:5});}};
}

test('inference defaults true, exact boolean schema and summary retain stopped account data and task status',async()=>{
  const f=await fixture();try{
    const s=f.service,before=structuredClone(s.config.value),tasks={accountId:'a',tasks:[],checkedAt:'2030-01-01T00:00:00Z'};
    s.ledger.set('wb-management-tasks:a',tasks);s.balanceCache=new Map([['a',{value:30,total:100,dailyCheckin:{status:'claimed',todayCheckedIn:true}}],['b',{value:40,total:100}]]);
    assert.equal((await workBuddySummary(s)).accounts[0].inferenceEnabled,true);
    for(const invalid of [null,'false',0,{}]){const c=structuredClone(before);c.accounts[0].inferenceEnabled=invalid;assert.throws(()=>validateConfig(c),{code:'invalid_config'});}
    await withConfigMutation(s,()=>setWorkBuddyInference(s,'a',{enabled:false}));
    const expected=structuredClone(before);expected.accounts[0].inferenceEnabled=false;assert.deepEqual(s.config.value,expected);
    const view=await workBuddySummary(s),a=view.accounts.find(a=>a.id==='a');
    assert.equal(a.enabled,true);assert.equal(a.inferenceEnabled,false);assert.equal(a.usageStatus,'inference_disabled');assert.equal(a.remaining,30);assert.equal(a.dailyCheckin.status,'claimed');assert.equal(a.tasks.checkedAt,tasks.checkedAt);
    assert.equal(view.totals.remaining,70);assert.equal(view.totals.inferenceRemaining,40);assert.equal(view.totals.inferenceDisabledAccounts,1);assert.equal(view.totals.inferenceEnabledAccounts,1);assert.equal(view.totals.balanceScope,'enabled_non_banned_accounts_including_inference_disabled');
    await withConfigMutation(s,()=>setWorkBuddyInference(s,'a',{enabled:true}));assert.equal((await workBuddySummary(s)).accounts[0].inferenceEnabled,true);
  }finally{await f.close();}
});

test('admin inference HTTP validates identity/body and preserves latest queued and external configuration',async()=>{
  const f=await fixture();let server;try{
    const s=f.service;server=await startServer(s,{port:0});
    const request=async(id,body,key=s.keys.adminKey)=>{const r=await fetch(server.baseUrl+'/admin/workbuddy/accounts/'+id+'/inference',{method:'POST',headers:{Authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
    assert.equal((await request('a',{enabled:false},s.keys.apiKey)).status,401);
    for(const b of [{},{enabled:'false'},{enabled:0},{enabled:false,autoTasks:false},[],null])assert.equal((await request('a',b)).status,400);
    assert.equal((await request('other',{enabled:false})).status,404);assert.equal((await request('missing',{enabled:false})).status,404);
    const external=JSON.parse(await readFile(f.file,'utf8'));external.routes[0].name='SAMPLE_EXTERNAL_ROUTE';await writeFile(f.file,JSON.stringify(external));
    const stopped=await request('a',{enabled:false});assert.equal(stopped.status,200);assert.equal(stopped.data.inferenceEnabled,false);assert.equal(stopped.data.automaticCheckinUnchanged,true);assert.equal(stopped.data.automaticTasksUnchanged,true);
    assert.equal(s.config.value.routes[0].name,'SAMPLE_EXTERNAL_ROUTE');
    const queued=withConfigMutation(s,async()=>{await new Promise(r=>setTimeout(r,15));const value=structuredClone(s.config.value);value.routes[0].name='SAMPLE_QUEUED_ROUTE';await s.config.save(value);});
    await Promise.all([queued,request('a',{enabled:true}),request('b',{enabled:false})]);
    const disk=JSON.parse(await readFile(f.file,'utf8'));assert.equal(disk.routes[0].name,'SAMPLE_QUEUED_ROUTE');assert.equal(disk.accounts[0].inferenceEnabled,true);assert.equal(disk.accounts[1].inferenceEnabled,false);assert.equal(disk.accounts[0].enabled,true);assert.equal(disk.accounts[1].tasks[0].enabled,true);assert.deepEqual(disk.routes[0].accountPool.accountIds,['a','b']);
    const detail=await fetch(server.baseUrl+'/admin/workbuddy/accounts/b/details',{headers:{Authorization:'Bearer '+s.keys.adminKey}});assert.equal((await detail.json()).account.inferenceEnabled,false);
  }finally{await server?.close();await f.close();}
});

test('pool/nonpool and relay inactive/audit/ignoreCooldown paths all exclude inference false without touching other partition',async()=>{
  const f=await fixture();try{
    const c=f.service.config;c.value.accounts[0].inferenceEnabled=false;
    const p=new WorkBuddyPool(c),pool=c.value.routes[0],single=c.value.routes[1],relay=new ModelRelay(c,{});
    assert.deepEqual(p.candidates(pool,{ignoreCooldown:true,includeBlocked:true}).map(t=>t.accountId),['b']);assert.deepEqual(p.candidates(single,{ignoreCooldown:true,includeBlocked:true}),[]);
    assert.deepEqual(relay.candidates(single,single.targets,{ignoreCooldown:true,source:'audit'}),[]);assert.deepEqual((await relay.discover(single,single.targets,undefined,{ignoreCooldown:true,source:'audit'})).targets,[]);
    c.value.modelRelay={enabled:true};assert.equal(relay.enabled(single.targets[0]),false);assert.equal(relay.enabled(c.value.routes[2].targets[0]),true);
    assert.deepEqual(relay.candidates(pool,p.candidates(pool),{ignoreCooldown:true}).map(t=>t.upstreamId),['ub']);
    assert.equal(workBuddyParticipation(f.service,pool).excludedAccounts.find(a=>a.accountId==='a').reason,'inference_disabled');
    assert.throws(()=>p.select(pool,'a'),{code:'invalid_pool_account'});
    f.service.credentials.resolve=async()=>{throw Error('SAMPLE unexpected credential read');};await assert.rejects(switchWorkBuddyAccount(f.service,'a'),{code:'wb_inference_disabled'});
  }finally{await f.close();}
});

test('fresh request and public models reload stale worker config; primary false pool still uses available member',async()=>{
  const f=await fixture();try{
    const stale=new ConfigStore(f.file);await stale.load();const calls=[],r=new Router(stale,{models,chat:async t=>{calls.push(t.upstreamId);return {response:response()};}});
    await setWorkBuddyInference(f.service,'a',{enabled:false});assert.equal(stale.value.accounts[0].inferenceEnabled,undefined);
    const listed=await r.models();assert.ok(listed.data.some(m=>m.id==='pool'));assert.ok(!listed.data.some(m=>m.id==='single'));assert.ok(listed.data.some(m=>m.id==='other'));
    assert.equal((await collectChat(r.chat(msg))).choices[0].message.content,'SAMPLE_OK');assert.deepEqual(calls,['ub']);
    await setWorkBuddyInference(f.service,'b',{enabled:false});assert.ok(!(await r.models()).data.some(m=>m.id==='pool'));
    await assert.rejects(collectChat(r.chat(msg)),{code:'account_pool_unavailable'});assert.deepEqual(calls,['ub']);
  }finally{await f.close();}
});

test('direct WB transport reads latest disk and rechecks after credential await; disabled 401 refresh never sends second call',async()=>{
  const f=await fixture();try{
    const stale=new ConfigStore(f.file);await stale.load();let network=0,resolves=0;
    const credentials={resolve:async()=>{resolves++;return {accessToken:'SAMPLE',uid:'SAMPLE'};}};
    const p=new Platforms(stale,credentials);p.wb.chatStream=async()=>{network++;return {ok:true,response:response()};};
    await setWorkBuddyInference(f.service,'a',{enabled:false});await assert.rejects(p.chat({upstreamId:'ua',model:'sample-model'},msg),{code:'wb_inference_disabled'});assert.equal(network,0);assert.equal(resolves,0);
    await setWorkBuddyInference(f.service,'a',{enabled:true});await stale.load();
    credentials.resolve=async()=>{await setWorkBuddyInference(f.service,'a',{enabled:false});return {accessToken:'SAMPLE',uid:'SAMPLE'};};
    await assert.rejects(p.chat({upstreamId:'ua',model:'sample-model'},msg),{code:'wb_inference_disabled'});assert.equal(network,0);
    await setWorkBuddyInference(f.service,'a',{enabled:true});await stale.load();resolves=0;
    credentials.resolve=async()=>{resolves++;if(resolves===2)await setWorkBuddyInference(f.service,'a',{enabled:false});return {accessToken:'SAMPLE_'+resolves,uid:'SAMPLE'};};
    p.wb.chatStream=async()=>{network++;return {ok:false,status:401,kind:'auth',message:'SAMPLE'};};
    await assert.rejects(p.chat({upstreamId:'ua',model:'sample-model'},msg),{code:'wb_inference_disabled'});assert.equal(network,1);assert.equal(resolves,2);
  }finally{await f.close();}
});

test('disable during catalogue await skips the stopped target; completed in-flight stream is not aborted or replayed',async()=>{
  const f=await fixture();try{
    const c={value:structuredClone(f.service.config.value)},calls=[];let stopDuringCatalog=true;
    const r=new Router(c,{models:async id=>{if(id==='ua'&&stopDuringCatalog)c.value.accounts[0].inferenceEnabled=false;return models();},chat:async t=>{calls.push(t.upstreamId);return {response:response()};}});
    await collectChat(r.chat(msg));assert.deepEqual(calls,['ub']);assert.equal(r.relay.get('relay-cooldown:ua\0sample-model'),undefined);
    stopDuringCatalog=false;c.value.accounts[0].inferenceEnabled=true;
    let release,began;const entered=new Promise(r=>began=r),wait=new Promise(r=>release=r);
    const r2=new Router(c,{models,chat:async t=>{calls.push(t.upstreamId);began();await wait;return {response:response()};}});
    const flight=collectChat(r2.chat(msg));await entered;c.value.accounts[0].inferenceEnabled=false;release();assert.equal((await flight).choices[0].message.content,'SAMPLE_OK');assert.deepEqual(calls,['ub','ua']);
  }finally{await f.close();}
});

test('legacy in-memory transport stub without accounts keeps default behavior; real missing account and read gate fail closed',async()=>{
  const config={value:{upstreams:[{id:'ua',kind:'workbuddy',accountId:'a'}]}},credentials={resolve:async()=>({accessToken:'SAMPLE'})},p=new Platforms(config,credentials);let calls=0;
  p.wb.chatStream=async()=>{calls++;return {ok:true,response:response()};};
  await p.chat({upstreamId:'ua',model:'sample-model'},msg);assert.equal(calls,1);
  config.value.accounts=[];await assert.rejects(p.chat({upstreamId:'ua',model:'sample-model'},msg),{code:'wb_inference_disabled'});assert.equal(calls,1);
  delete config.value.accounts;config.workBuddyInferenceAllowed=async()=>true;await assert.rejects(p.chat({upstreamId:'ua',model:'sample-model'},msg),{code:'wb_inference_disabled'});assert.equal(calls,1);
  config.workBuddyInferenceAllowed=async()=>false;await assert.rejects(p.chat({upstreamId:'ua',model:'sample-model'},msg),{code:'wb_inference_disabled'});assert.equal(calls,1);
});

test('legacy in-memory router stub without upstream inventory retains normal pre-output fallback',async()=>{
  const config={value:{routes:[{id:'pool',targets:[{upstreamId:'first',model:'sample-model'},{upstreamId:'second',model:'sample-model'}]}]}},calls=[];
  const router=new Router(config,{models,chat:async t=>{calls.push(t.upstreamId);if(t.upstreamId==='first')throw Object.assign(Error('SAMPLE retryable'),{status:503});return {response:response()};}});
  assert.equal((await collectChat(router.chat(msg))).choices[0].message.content,'SAMPLE_OK');assert.deepEqual(calls,['first','second']);
});
