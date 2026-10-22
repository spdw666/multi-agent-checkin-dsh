import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {queryWorkBuddyTasks,runWorkBuddyTasks,workBuddyTaskSnapshot}=await import(pathToFileURL(resolve(root,'src/workbuddy-tasks.mjs')));
const old={accessToken:'SAMPLE_OLD_ACCESS',uid:'SAMPLE_UID',principalHash:'SAMPLE_PRINCIPAL_HASH',edition:'cn',domain:'www.workbuddy.cn'};
const tasks=[{task_code:'SAMPLE_TASK',title:'SAMPLE task',progress:{current:0,target:1},accept_status:'not_accepted'}];
function fixture(options={}){
  const data=new Map(),calls={resolve:[],fetch:[]};let number=0;
  const service={config:{value:{accounts:[{id:'a',platform:'workbuddy',edition:'cn',enabled:true}]}},ledger:{get:key=>data.get(key),set:(key,value)=>data.set(key,value)},credentials:{resolve:async(id,flags)=>{calls.resolve.push({id,flags});return flags?.renew?(options.renew?options.renew():options.fresh??{...old,accessToken:'SAMPLE_NEW_ACCESS'}):options.old??old;}},workbuddyRuntime:{taskRequestTimeoutMs:2000,fetchImpl:async(url,init)=>{
    calls.fetch.push({url,method:init.method,authorization:init.headers.Authorization,domain:init.headers['X-Domain'],body:init.body});
    assert.equal(new URL(url).pathname,'/v2/activity/growth/tasks');assert.equal(init.method,'GET');
    if(options.fetch)return options.fetch(++number,url,init);
    if(++number===1)return new Response('SAMPLE unauthorized',{status:401,headers:{'content-type':'text/html'}});
    return Response.json({code:0,data:{tasks}});
  }}};
  return {service,calls,data};
}

test('read-only UI task refresh renews exactly once and re-queries with same-account fresh credentials',async()=>{
  const f=fixture(),result=await queryWorkBuddyTasks(f.service,{accountId:'a'});
  assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].taskCode,'SAMPLE_TASK');assert.equal(result.error,null);assert.equal(result.stale,false);
  assert.deepEqual(f.calls.resolve,[{id:'a',flags:undefined},{id:'a',flags:{force:true,renew:true,rejectedAccessToken:old.accessToken}}]);
  assert.deepEqual(f.calls.fetch.map(call=>call.authorization),['Bearer SAMPLE_OLD_ACCESS','Bearer SAMPLE_NEW_ACCESS']);
  assert.equal(f.calls.fetch.length,2);assert.ok(f.calls.fetch.every(call=>call.method==='GET'&&call.body===undefined));
});

test('a changed domain can re-query without pretending an unchanged token was renewed',async()=>{
  const f=fixture({fresh:{...old,domain:'www.codebuddy.cn'}});
  assert.equal((await queryWorkBuddyTasks(f.service,{accountId:'a'})).tasks.length,1);
  assert.deepEqual(f.calls.fetch.map(call=>call.domain),['www.workbuddy.cn','www.codebuddy.cn']);
});

for(const field of ['uid','principalHash'])test(`a changed ${field} stops before using another account's credential`,async()=>{
  const f=fixture({fresh:{...old,accessToken:'SAMPLE_NEW_ACCESS',[field]:'SAMPLE_DIFFERENT'}});
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a'}),{code:'principal_changed',status:409});
  assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.resolve.length,2);
});

test('missing a previously known UID is not accepted merely because the principal hash matches',async()=>{
  const fresh={...old,accessToken:'SAMPLE_NEW_ACCESS'};delete fresh.uid;
  const f=fixture({fresh});await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a'}),{code:'principal_changed'});assert.equal(f.calls.fetch.length,1);
});

test('a stable UID alone can bind task read recovery when hashes were not supplied',async()=>{
  const before={...old},fresh={...old,accessToken:'SAMPLE_NEW_ACCESS'};delete before.principalHash;delete fresh.principalHash;
  const f=fixture({old:before,fresh});assert.equal((await queryWorkBuddyTasks(f.service,{accountId:'a'})).tasks.length,1);assert.equal(f.calls.fetch.length,2);
});

test('no comparable stable identity never authorizes use of the new token',async()=>{
  const before={accessToken:old.accessToken,edition:'cn'},fresh={accessToken:'SAMPLE_NEW_ACCESS',edition:'cn'};
  const f=fixture({old:before,fresh});await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a'}),{code:'wb_task_refresh_identity_unverified'});assert.equal(f.calls.fetch.length,1);
});

test('unchanged token and domain preserve the first rejection and do not repeat the task read',async()=>{
  const f=fixture({fresh:{...old}});await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a'}),{code:'wb_task_http_auth_rejected',status:401});
  assert.equal(f.calls.resolve.length,2);assert.equal(f.calls.fetch.length,1);
});

test('renewal failure propagates without another official query',async()=>{
  const f=fixture({renew:async()=>{throw Object.assign(Error('SAMPLE refresh rejected'),{code:'wb_refresh_login_required',status:401});}});
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a'}),{code:'wb_refresh_login_required'});assert.equal(f.calls.fetch.length,1);
});

for(const status of [403,429,500,200])test(`HTTP ${status} does not request native credential renewal`,async()=>{
  const f=fixture({fetch:async()=>new Response('SAMPLE non-JSON response',{status,headers:{'content-type':'text/html'}})});
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a'}),error=>error.status===(status===200?502:status));
  assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.fetch.length,1);
});

test('valid JSON HTTP 401 uses the same one-time read-only recovery',async()=>{
  const f=fixture({fetch:async number=>number===1?Response.json({code:12153,msg:'SAMPLE offline session'},{status:401}):Response.json({code:0,data:{tasks}})});
  assert.equal((await queryWorkBuddyTasks(f.service,{accountId:'a'})).tasks.length,1);assert.equal(f.calls.resolve.length,2);assert.equal(f.calls.fetch.length,2);
});

test('a second 401 stops without a second renewal or third query',async()=>{
  const f=fixture({fetch:async()=>new Response('SAMPLE unauthorized',{status:401})});
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a'}),{status:401});assert.equal(f.calls.resolve.length,2);assert.equal(f.calls.fetch.length,2);
});

test('pre-aborted UI refresh never resolves a credential or starts a query',async()=>{
  const f=fixture(),controller=new AbortController(),reason=Error('SAMPLE pre-cancel');controller.abort(reason);
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a',signal:controller.signal}),error=>error===reason);
  assert.equal(f.calls.resolve.length,0);assert.equal(f.calls.fetch.length,0);assert.equal(workBuddyTaskSnapshot(f.service,'a').error,null);
});

test('cancellation after the rejected read prevents renewal',async()=>{
  const controller=new AbortController(),reason=Error('SAMPLE cancelled read');
  const f=fixture({fetch:async()=>{controller.abort(reason);return new Response('SAMPLE unauthorized',{status:401});}});
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a',signal:controller.signal}),error=>error===reason);
  assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.fetch.length,1);assert.equal(workBuddyTaskSnapshot(f.service,'a').error,null);
});

test('cancellation while credential recovery settles prevents the second query and stale snapshot write',async()=>{
  const controller=new AbortController(),reason=Error('SAMPLE cancelled renewal');
  const f=fixture({renew:async()=>{controller.abort(reason);return {...old,accessToken:'SAMPLE_NEW_ACCESS'};}});
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a',signal:controller.signal}),error=>error===reason);
  assert.equal(f.calls.resolve.length,2);assert.equal(f.calls.fetch.length,1);assert.equal(workBuddyTaskSnapshot(f.service,'a').error,null);
});

test('cancellation during the retry remains cancellation rather than a saved auth failure',async()=>{
  const controller=new AbortController(),reason=Error('SAMPLE cancelled retry');
  const f=fixture({fetch:async number=>{if(number===1)return new Response('SAMPLE unauthorized',{status:401});controller.abort(reason);return Response.json({code:0,data:{tasks}});}});
  await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'a',signal:controller.signal}),error=>error===reason);
  assert.equal(f.calls.fetch.length,2);assert.equal(workBuddyTaskSnapshot(f.service,'a').error,null);
});

test('run/accept/claim operation entry points do not borrow the UI query renewal loop',async()=>{
  for(const action of ['run','accept','claim']){
    const f=fixture();await assert.rejects(runWorkBuddyTasks(f.service,{accountId:'a',action,taskCodes:['SAMPLE_TASK']}),{status:401});
    assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.fetch.length,1);
  }
});
