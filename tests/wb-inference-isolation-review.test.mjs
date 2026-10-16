// Independent, fully synthetic review coverage. No live config, auth, HTTP,
// check-in, task executor, official client, or generation endpoint is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const root=process.env.WB_REVIEW_SOURCE_ROOT?pathToFileURL(resolve(process.env.WB_REVIEW_SOURCE_ROOT)+'/'):new URL('../',import.meta.url);
const load=name=>import(new URL('src/'+name+'.mjs',root));
const [{WorkBuddyPool},{ModelRelay,relayDefaults},{Router},{Platforms},{ClaimService},{ConfigStore,validateConfig},{collectChat},management,{runWorkBuddyTasks},{executeRegisteredWorkBuddyTask},{Scheduler}]=await Promise.all(['workbuddy-pool','model-relay','router','platforms','claims','config','openai','workbuddy-management','workbuddy-tasks','workbuddy-executors','scheduler'].map(load));
const fixtureRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)),'review-fixtures');
const id='deepseek-v4.1-flash';
const request={model:'route-a',messages:[{role:'user',content:'SAMPLE'}]};
const response=()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'SAMPLE'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
const models=async()=>[{id,tools:true,callable:true,contextWindow:1000000,maxTokens:128000}];
function fixture(){
  const accounts=[{id:'a',platform:'workbuddy',edition:'cn',enabled:true},{id:'b',platform:'workbuddy',edition:'cn',enabled:true},{id:'international',platform:'workbuddy',edition:'ai',enabled:true},{id:'other',platform:'trae',edition:'cn',enabled:true}].map(a=>({...a,credentials:{kind:'file',file:'SAMPLE-'+a.id+'.json'},tasks:[{id:'daily-checkin',enabled:true}]}));
  const value={schemaVersion:1,accounts,upstreams:accounts.map(a=>({id:'up-'+a.id,accountId:a.id,kind:a.platform,enabled:true})),routes:[{id:'route-a',enabled:true,targets:[{upstreamId:'up-a',model:id}],accountPool:{enabled:true,accountIds:['a','b','international'],cooldownSeconds:60}},{id:'route-b',enabled:true,targets:[{upstreamId:'up-b',model:id}]},{id:'route-international',enabled:true,targets:[{upstreamId:'up-international',model:id}]},{id:'route-other',enabled:true,targets:[{upstreamId:'up-other',model:id}]}],scheduler:{enabled:false,startup:false,timezone:'Asia/Shanghai',hour:0,minute:0,jitterSeconds:0},server:{host:'127.0.0.1',port:0},modelRelay:{...relayDefaults,enabled:false},workbuddy:{autoTasks:true,autoMigrateSessions:true}};
  return {value};
}
function memoryLedger(){const meta=new Map();return {get:k=>meta.get(k),set:(k,v)=>meta.set(k,v),record:()=>{},meta};}
function taskService(config){const ledger=memoryLedger(),resolutions=[],queries=[];return {config,ledger,resolutions,queries,credentials:{resolve:async accountId=>{resolutions.push(accountId);return {accessToken:'SAMPLE-TOKEN',uid:'SAMPLE-UID-'+accountId,principal:'SAMPLE-'+accountId,edition:config.value.accounts.find(a=>a.id===accountId).edition};}},workbuddyRuntime:{fetchImpl:async(url,options)=>{queries.push([url,options.method]);assert.equal(options.method,'GET','fixture must not submit, accept, claim or generate');return Response.json({code:0,data:{tasks:[]}});}},workbuddyTaskExecutors:new Map()};}

test('review: missing inferenceEnabled retains default participation; explicit false only excludes inference',()=>{
  const config=fixture(),pool=new WorkBuddyPool(config),route=config.value.routes[0];
  assert.deepEqual(pool.candidates(route).map(t=>t.accountId),['a','b']);
  config.value.accounts[0].inferenceEnabled=false;
  assert.deepEqual(pool.candidates(route).map(t=>t.accountId),['b']);
  assert.deepEqual(pool.candidates(route,{ignoreCooldown:true,includeBlocked:true}).map(t=>t.accountId),['b']);
  assert.equal(config.value.accounts[0].enabled,true);
  assert.equal(config.value.accounts[0].tasks[0].enabled,true);
});

test('review: explicit nonpool route and pool=false never bypass account inference pause',()=>{
  const config=fixture(),pool=new WorkBuddyPool(config),route=config.value.routes[0];
  config.value.accounts[0].inferenceEnabled=false;
  for(const policy of [undefined,{enabled:false,accountIds:['a','b']}]){route.accountPool=policy;assert.deepEqual(pool.candidates(route),[]);}
});

test('review: same-edition pool and workbuddy-versus-other relay partition remain intact',async()=>{
  const config=fixture(),pool=new WorkBuddyPool(config),route=config.value.routes[0];
  config.value.accounts[0].inferenceEnabled=false;config.value.modelRelay.enabled=true;
  assert.deepEqual(pool.candidates(route).map(t=>t.accountId),['b']);
  const relay=new ModelRelay(config,{models});
  assert.ok(relay.candidates(route,pool.candidates(route)).every(t=>t.upstreamId!=='up-other'));
  const discovered=await relay.discover(route,pool.candidates(route));
  assert.ok(discovered.targets.every(t=>t.upstreamId!=='up-other'&&t.upstreamId!=='up-a'));
});

test('review: relay candidates and discovery filter paused accounts even when relay is inactive',async()=>{
  const config=fixture(),relay=new ModelRelay(config,{models}),route=config.value.routes[0],raw=route.targets;
  config.value.accounts[0].inferenceEnabled=false;
  for(const active of [false,true]){config.value.modelRelay.enabled=active;
    assert.equal(relay.enabled(raw[0]),false);
    assert.ok(!relay.candidates(route,raw).some(t=>t.upstreamId==='up-a'));
    assert.ok(!(await relay.discover(route,raw)).targets.some(t=>t.upstreamId==='up-a'));
  }
});

test('review: router model list and chat never invoke paused account while another same-pool account remains',async()=>{
  const config=fixture(),calls=[],catalogCalls=[],platforms={models:async upstreamId=>{catalogCalls.push(upstreamId);return models();},chat:async t=>{calls.push(t.upstreamId);return {response:response()};}};
  config.value.accounts[0].inferenceEnabled=false;
  const router=new Router(config,platforms);
  const info=await router.routeInfo(config.value.routes[0]);assert.equal(info.upstream,'up-b');
  await collectChat(router.chat(request));assert.deepEqual(calls,['up-b']);assert.ok(!catalogCalls.includes('up-a'));
});

test('review: direct Platforms.chat rejects paused account before resolving any credentials',async()=>{
  const config=fixture();config.value.accounts[0].inferenceEnabled=false;let resolutions=0,generations=0;
  const platforms=new Platforms(config,{resolve:async()=>{resolutions++;throw Error('credential access must be blocked');}});
  platforms.wb={chatStream:async()=>{generations++;throw Error('generation must be blocked');}};
  await assert.rejects(platforms.chat(config.value.routes[0].targets[0],request),{code:'wb_inference_disabled'});
  assert.equal(resolutions,0);assert.equal(generations,0);
});

test('review: account disabled during in-flight catalogue is rechecked before official generation',async()=>{
  const config=fixture();delete config.value.routes[0].accountPool;
  let release,entered,generations=0,resolutions=0;const gate=new Promise(r=>release=r),began=new Promise(r=>entered=r);
  const platforms=new Platforms(config,{resolve:async()=>{resolutions++;return {accessToken:'SAMPLE'};}});
  platforms.models=async()=>{entered();await gate;return models();};
  platforms.wb={chatStream:async()=>{generations++;return {ok:true,response:response()};}};
  const router=new Router(config,platforms),pending=collectChat(router.chat(request));await began;
  config.value.accounts[0].inferenceEnabled=false;release();
  await assert.rejects(pending,{code:'wb_inference_disabled'});assert.equal(generations,0);assert.equal(resolutions,0);
});

test('review: stop inference does not remove account from daily-checkin selection; legacy enabled=false still does',async()=>{
  const config=fixture();config.value.accounts[0].inferenceEnabled=false;config.value.accounts[1].enabled=false;
  const claims=new ClaimService(config),seen=[];claims.run=async accountId=>{seen.push(accountId);return {accountId};};
  await claims.all();assert.deepEqual(seen,['a','international','other']);
});

test('review: scheduled checkin retains inference-paused account; inference toggle does not reschedule completed checkin',async()=>{
  const config=fixture();config.value.scheduler.enabled=true;config.value.accounts[0].inferenceEnabled=false;config.value.accounts[1].enabled=false;
  const claims=new ClaimService(config),seen=[];claims.run=async accountId=>{seen.push(accountId);return {accountId,status:'already'};};
  const ledger=memoryLedger(),scheduler=new Scheduler(config,claims,ledger);scheduler.stopped=false;
  await scheduler.tick();assert.deepEqual(seen,['a','international','other']);const signature=ledger.get('schedule-plan').signature;
  config.value.accounts[0].inferenceEnabled=true;await scheduler.tick();
  assert.equal(ledger.get('schedule-plan').signature,signature);assert.deepEqual(seen,['a','international','other'],'changing inference is not a new daily task plan');
});

test('review: task query batch keeps inference-paused account and excludes legacy disabled account',async()=>{
  const config=fixture();config.value.accounts[0].inferenceEnabled=false;config.value.accounts[1].enabled=false;config.value.accounts[2].enabled=false;
  const service=taskService(config),result=await runWorkBuddyTasks(service,{action:'query'});
  assert.deepEqual(result.results.map(r=>r.accountId),['a']);assert.deepEqual(service.resolutions,['a']);assert.equal(service.queries.length,1);
});

test('review: automatic task selection remains active after inference pause, with mocked checkin and no executor',async()=>{
  const config=fixture();config.value.accounts[0].inferenceEnabled=false;config.value.accounts[1].enabled=false;config.value.accounts[2].enabled=false;
  const service=taskService(config),checkins=[];service.claims={run:async accountId=>{checkins.push(accountId);return {status:'already',reason:'server_already_claimed'};}};
  const result=await management.runAutomaticWorkBuddyTasks(service);
  assert.equal(result.enabled,true);assert.deepEqual(checkins,['a']);assert.deepEqual(service.resolutions,['a']);assert.ok(service.queries.every(([,method])=>method==='GET'));
});

test('review: registered real-chat task keeps official-runner execution domain despite inference pause',async()=>{
  const config=fixture();config.value.accounts[0].inferenceEnabled=false;let submissions=0,credentialReads=0,gatewayChats=0;
  const service={config,ledger:memoryLedger(),credentials:{resolve:async()=>{credentialReads++;return {uid:'SAMPLE-UID',accessToken:'SAMPLE-TOKEN'};}},platforms:{health:async()=>({credits:{total:10,packages:[]},checkin:{}}),chat:async()=>{gatewayChats++;throw Error('task must not bypass or use gateway chat');}},workbuddyRuntime:{runOfficialCli:async ctx=>{submissions++;await ctx.onBeforeSpawn();return {valid:true,completedTools:[],artifacts:[]};}}};
  const task={taskCode:'first_buddy',current:0,target:1};
  const first=await executeRegisteredWorkBuddyTask({service,accountId:'a',task});
  assert.equal(first.status,'completed');assert.equal(submissions,1);assert.equal(gatewayChats,0);assert.equal(credentialReads,1);
  assert.equal((await executeRegisteredWorkBuddyTask({service,accountId:'a',task})).status,'completed');assert.equal(submissions,1,'completed automatic work must not replay');
});

test('review: paused account switch is rejected before credentials/client migration side effects',async()=>{
  const config=fixture();config.value.accounts[0].inferenceEnabled=false;let resolutions=0;
  const service={config,ledger:memoryLedger(),credentials:{resolve:async()=>{resolutions++;throw Error('must not resolve credentials');}},router:{pool:new WorkBuddyPool(config)},workbuddyRuntime:{isRunning:async()=>{throw Error('must not inspect client');}}};
  await assert.rejects(management.switchWorkBuddyAccount(service,'a',{switchClient:true,migrate:true}),{code:'wb_inference_disabled'});assert.equal(resolutions,0);
});

test('review: inferenceEnabled validates booleans and persists independently from enabled/tasks/settings',async()=>{
  const config=fixture();for(const value of ['false',0,null]){config.value.accounts[0].inferenceEnabled=value;assert.throws(()=>validateConfig(config.value),{code:'invalid_config'});}
  config.value.accounts[0].inferenceEnabled=false;await mkdir(fixtureRoot,{recursive:true});const dir=await mkdtemp(join(fixtureRoot,'persistence-'));
  try{const file=join(dir,'config.json');await writeFile(file,JSON.stringify(config.value));const writer=new ConfigStore(file);await writer.load();const next=structuredClone(writer.value);next.accounts[0].inferenceEnabled=true;await writer.save(next);const reader=new ConfigStore(file);await reader.load();assert.equal(reader.value.accounts[0].inferenceEnabled,true);assert.deepEqual(reader.value.accounts[0].tasks,config.value.accounts[0].tasks);assert.equal(reader.value.accounts[0].enabled,true);assert.deepEqual(reader.value.workbuddy,config.value.workbuddy);assert.deepEqual(reader.value.routes,config.value.routes);}
  finally{await rm(dir,{recursive:true,force:true,maxRetries:5});}
});

test('review: separate stale worker reads newly persisted pause on next chat, without waiting 30-second reload',async()=>{
  const config=fixture();delete config.value.routes[0].accountPool;await mkdir(fixtureRoot,{recursive:true});const dir=await mkdtemp(join(fixtureRoot,'stale-worker-'));
  try{const file=join(dir,'config.json');await writeFile(file,JSON.stringify(config.value));const admin=new ConfigStore(file),worker=new ConfigStore(file);await admin.load();await worker.load();let calls=0;const router=new Router(worker,{models,chat:async()=>{calls++;return {response:response()};}});
    const next=structuredClone(admin.value);next.accounts[0].inferenceEnabled=false;await admin.save(next);
    assert.notEqual(worker.value.accounts[0].inferenceEnabled,false,'worker starts with stale snapshot');
    await assert.rejects(collectChat(router.chat(request)));assert.equal(calls,0,'no old-memory account can spend after POST persistence');
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:5});}
});
