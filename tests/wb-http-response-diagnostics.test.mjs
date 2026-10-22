import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {fetchWorkBuddyCreditDetails}=await import(pathToFileURL(resolve(root,'src/workbuddy-resources.mjs')));
const {WorkBuddyTaskClient}=await import(pathToFileURL(resolve(root,'src/workbuddy-tasks.mjs')));
const {workBuddyFailure}=await import(pathToFileURL(resolve(root,'src/workbuddy-status.mjs')));

const secret='SAMPLE_HTTP_DIAGNOSTICS_PRIVATE_TOKEN';
const credential={edition:'cn',accessToken:secret,uid:'SAMPLE_UID',principal:'SAMPLE_UID',domain:'www.workbuddy.cn'};
const surfaces=[
  {name:'resource',read:fetchImpl=>fetchWorkBuddyCreditDetails(credential,{fetchImpl})},
  {name:'task',read:fetchImpl=>new WorkBuddyTaskClient(credential,{fetchImpl}).query()},
];
for(const surface of surfaces)for(const status of [401,403,429,500])test(`${surface.name}: non-JSON HTTP ${status} retains HTTP context without leaking raw response`,async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return new Response(`<html>raw upstream ${secret} SAMPLE_PRIVATE_BODY account banned</html>`,{status,headers:{'content-type':'text/html; charset=SAMPLE_PRIVATE_PARAMETER'}});};
  await assert.rejects(surface.read(fetchImpl),error=>{
    assert.equal(error.status,status);assert.equal(error.httpStatus,status);assert.equal(error.contentType,'text/html');assert.equal(error.banned,false);
    const type=[401,403].includes(status)?'http_auth_rejected':status===429?'http_rate_limited':'http_rejected';
    assert.equal(error.code,`wb_${surface.name}_${type}`);assert.match(error.message,new RegExp(`HTTP ${status}`));assert.match(error.message,/非 JSON/);
    assert.equal(workBuddyFailure(error).authRejected,[401,403].includes(status));assert.equal(workBuddyFailure(error).banned,false);
    if(status===429)assert.equal(error.retryable,true);
    const exposed=JSON.stringify({message:error.message,...error});
    for(const marker of [secret,'SAMPLE_PRIVATE_BODY','SAMPLE_PRIVATE_PARAMETER','account banned'])assert.equal(exposed.includes(marker),false);
    return true;
  });
  assert.equal(calls,1,'response diagnostics do not retry reads or mutations');
});

for(const surface of surfaces)test(`${surface.name}: HTTP 200 malformed JSON is a schema failure, not rejected authentication`,async()=>{
  await assert.rejects(surface.read(async()=>new Response(`malformed ${secret}`,{status:200,headers:{'content-type':'application/json; charset=utf-8'}})),error=>{
    assert.equal(error.status,502);assert.equal(error.httpStatus,200);assert.equal(error.contentType,'application/json');
    assert.equal(error.code,`wb_${surface.name}_response_invalid`);assert.equal(workBuddyFailure(error).authRejected,false);
    assert.match(error.message,/HTTP 200/);assert.match(error.message,/JSON/);assert.equal(error.message.includes(secret),false);return true;
  });
});

for(const surface of surfaces)test(`${surface.name}: empty non-JSON 401 preserves absent content type as null`,async()=>{
  await assert.rejects(surface.read(async()=>new Response(null,{status:401})),error=>error.status===401&&error.httpStatus===401&&error.contentType===null&&error.code===`wb_${surface.name}_http_auth_rejected`);
});

for(const surface of surfaces)test(`${surface.name}: valid JSON official errors retain original business code and rejection semantics`,async()=>{
  await assert.rejects(surface.read(async()=>Response.json({code:12153,msg:'SAMPLE official offline session not found'},{status:401})),error=>error.status===401&&error.httpStatus===401&&error.upstreamCode===12153&&error.code===(surface.name==='resource'?'wb_upstream_rejected':'wb_task_request_rejected')&&workBuddyFailure(error).banned===false);
});

test('resource success retains the exact official package normalization',async()=>{
  const result=await fetchWorkBuddyCreditDetails(credential,{fetchImpl:async()=>Response.json({code:0,data:{Response:{Data:{TotalCount:1,Accounts:[{AccountId:'SAMPLE_PACKAGE',CapacitySize:100,CapacityRemain:80}]}}}})});
  assert.equal(result.total,80);assert.equal(result.capacityTotal,100);assert.equal(result.complete,true);
});

test('task success retains the official list and does not submit accept or claim',async()=>{
  const calls=[];const result=await new WorkBuddyTaskClient(credential,{fetchImpl:async(url,options)=>{calls.push({url,method:options.method,body:options.body});return Response.json({code:0,data:{tasks:[]}});}}).query();
  assert.deepEqual(result,[]);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].body,undefined);
});

test('task diagnostics preserve cancellation during JSON parsing',async()=>{
  const controller=new AbortController(),cancelled=Error('SAMPLE cancellation');
  const client=new WorkBuddyTaskClient(credential,{signal:controller.signal,fetchImpl:async()=>({ok:true,status:200,headers:new Headers({'content-type':'text/html'}),json:async()=>{controller.abort(cancelled);throw SyntaxError('SAMPLE malformed response');}})});
  await assert.rejects(client.query(),error=>error===cancelled);
});

test('an explicit task accept receiving HTML 401 is never silently replayed',async()=>{
  let calls=0;
  const client=new WorkBuddyTaskClient(credential,{fetchImpl:async(url,options)=>{
    calls++;assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{task_codes:['SAMPLE_TASK']});
    return new Response('SAMPLE non-JSON rejection',{status:401,headers:{'content-type':'text/plain'}});
  }});
  await assert.rejects(client.accept(['SAMPLE_TASK']),{code:'wb_task_http_auth_rejected',status:401,httpStatus:401});
  assert.equal(calls,1);
});
