import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkBuddyTasks,queryWorkBuddyTasks,workBuddyTaskSnapshot} from '../src/workbuddy-tasks.mjs';
const task=(code,extra={})=>({task_code:code,title:'SAMPLE '+code,progress:{current:0,target:1},accept_status:'accepted',reward_credit:100,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(raw=[task('SAMPLE_TASK')]){
  const data=new Map(),state={tasks:structuredClone(raw),queries:0,accepts:[],claims:[],events:[],query:null,accept:null,claim:null};
  const service={config:{value:{accounts:[{id:'SAMPLE_ACCOUNT',platform:'workbuddy',edition:'cn',enabled:true}],workbuddy:{autoTasks:true}}},ledger:{get:k=>data.get(k),set:(k,v)=>data.set(k,v)},credentials:{resolve:async()=>({edition:'cn',uid:'SAMPLE_UID',accessToken:'SAMPLE_PROGRESS_ACCESS_TOKEN'})},claims:{run:async()=>({status:'already',reason:'server_already_claimed'})},workbuddyTaskExecutors:new Map(),workbuddyRuntime:{taskPollDelays:[0,0,0]}};
  service.workbuddyRuntime.fetchImpl=async(url,init)=>{
    if(url.endsWith('/tasks')){state.events.push('query');state.queries++;await state.query?.(state,init);return Response.json({code:0,data:{tasks:state.tasks}});}
    if(url.endsWith('/accept')){const codes=JSON.parse(init.body).task_codes;state.events.push('accept:'+codes.join(','));state.accepts.push(codes);const ack=await state.accept?.(codes,init);for(const row of state.tasks)if(codes.includes(row.task_code))row.accept_status='accepted';return Response.json({code:0,data:ack??{}});}
    if(url.endsWith('/claim')){const code=decodeURIComponent(url.split('/').at(-2));state.events.push('claim:'+code);state.claims.push(code);await state.claim?.(code,init);state.tasks.find(t=>t.task_code===code).accept_status='claimed';return Response.json({code:0,data:{credit:100}});}
    throw Error('Unexpected SAMPLE URL');
  };
  return {service,state,data,run:options=>runWorkBuddyTasks(service,{accountId:'SAMPLE_ACCOUNT',action:'run',...options})};
}

test('bulk automatic run skips acceptance and extra queries for fifteen manual-only tasks',async()=>{
  const f=fixture(Array.from({length:15},(_,i)=>task('SAMPLE_MANUAL_'+i,{accept_status:'not_accepted'}))),progress=[];
  const result=await f.run({onProgress:p=>progress.push(p)});
  assert.equal(f.state.queries,1);assert.equal(f.state.accepts.length,0);assert.equal(f.state.claims.length,0);assert.equal(result.receipts.filter(r=>r.status==='action_required').length,15);
  assert.equal(progress.at(-1).phase,'finished');assert.equal(progress.at(-1).completed,15);assert.equal(progress.at(-1).total,15);assert.equal(progress.at(-1).status,'completed');
  assert.deepEqual(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').progress,progress.at(-1));
});
test('explicit accept still accepts every selected manual-only task',async()=>{
  const f=fixture([task('SAMPLE_A',{accept_status:'not_accepted'}),task('SAMPLE_B',{accept_status:'not_accepted'})]);
  const result=await f.run({action:'accept'});assert.equal(f.state.accepts.length,2);assert.equal(result.receipts.filter(r=>r.status==='accepted').length,2);assert.equal(f.state.claims.length,0);
});
test('explicit selected run preserves intentional acceptance of a manual task',async()=>{
  const f=fixture([task('SAMPLE_A',{accept_status:'not_accepted'})]);const r=await f.run({taskCodes:['SAMPLE_A']});assert.deepEqual(f.state.accepts,[['SAMPLE_A']]);assert.ok(r.receipts.some(x=>x.status==='action_required'));
});
test('bulk plan claims already-qualified rewards before starting expensive real executors',async()=>{
  const f=fixture([task('SAMPLE_REAL'),task('SAMPLE_REWARD',{progress:{current:1,target:1}}),task('SAMPLE_MANUAL',{accept_status:'not_accepted'})]);
  f.service.workbuddyTaskExecutors.set('SAMPLE_REAL',async()=>{f.state.events.push('execute');return {status:'deferred',reason:'SAMPLE runner busy'};});
  await f.run();assert.ok(f.state.events.indexOf('claim:SAMPLE_REWARD')<f.state.events.indexOf('execute'));assert.equal(f.state.accepts.length,0);
});
test('bulk plan preserves first_buddy prerequisite order among real executors',async()=>{
  const f=fixture([task('skill_1'),task('first_buddy')]),order=[];for(const code of ['skill_1','first_buddy'])f.service.workbuddyTaskExecutors.set(code,async()=>{order.push(code);return {status:'deferred'};});await f.run();assert.deepEqual(order,['first_buddy','skill_1']);
});
test('external-wait capability is not accepted by bulk automatic execution',async()=>{
  const f=fixture([task('SAMPLE_EXTERNAL',{accept_status:'not_accepted'})]);let called=0;const executor=async()=>{called++;return {status:'deferred'};};executor.capability={feature:'external_wait'};f.service.workbuddyTaskExecutors.set('SAMPLE_EXTERNAL',executor);await f.run();assert.equal(called,0);assert.equal(f.state.accepts.length,0);assert.equal(f.state.queries,1);
});
test('progress reports every execution phase with bounded metadata and monotonically completed items',async()=>{
  const f=fixture([task('SAMPLE_TASK',{accept_status:'not_accepted'})]),progress=[];
  f.service.workbuddyTaskExecutors.set('SAMPLE_TASK',async()=>{f.state.tasks[0].progress.current=1;return {status:'completed',accessToken:'NEVER_REPORT',raw:{secret:'NEVER_REPORT'}};});
  await f.run({onProgress:p=>progress.push(p)});for(const phase of ['init','query','accept','execution','progress_poll','claim','finished'])assert.ok(progress.some(p=>p.phase===phase),phase);
  for(const [i,p] of progress.entries()){assert.equal(p.accountId,'SAMPLE_ACCOUNT');assert.ok(Object.hasOwn(p,'taskCode'));assert.equal(typeof p.completed,'number');assert.equal(typeof p.total,'number');if(i)assert.ok(p.completed>=progress[i-1].completed);assert.ok(Object.keys(p).every(k=>['accountId','phase','taskCode','completed','total','checkedAt','status','reason'].includes(k)));}
  assert.equal(JSON.stringify(progress).includes('NEVER_REPORT'),false);assert.equal(progress.at(-1).completed,1);
});
test('throwing progress observer cannot fail or replay a task mutation',async()=>{
  const f=fixture([task('SAMPLE_TASK',{progress:{current:1,target:1}})]);const r=await f.run({onProgress:()=>{throw Error('SAMPLE UI closed');}});assert.equal(f.state.claims.length,1);assert.ok(r.receipts.some(x=>x.status==='claimed'));
});
test('aborted read with a transport ignoring AbortSignal returns promptly and discards its late success',async()=>{
  const f=fixture(),controller=new AbortController(),gate=deferred(),started=deferred();await queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'});const old=workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT');
  f.state.query=async()=>{started.resolve();await gate.promise;f.state.tasks[0].progress.current=1;};const p=queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT',signal:controller.signal});await started.promise;const before=Date.now();controller.abort(Error('SAMPLE cancel read'));await assert.rejects(p,/SAMPLE cancel read/);assert.ok(Date.now()-before<500);assert.equal(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').lastSuccessAt,old.lastSuccessAt);
  gate.resolve();await tick();const cached=workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT');assert.equal(cached.tasks[0].current,0);assert.equal(cached.stale,false);assert.equal(cached.error,null);assert.equal(cached.lastSuccessAt,old.lastSuccessAt);
});
test('read timeout also bounds a non-cooperative response body parser',async()=>{
  const f=fixture(),body=deferred();f.service.workbuddyRuntime.taskRequestTimeoutMs=15;f.service.workbuddyRuntime.fetchImpl=async()=>({ok:true,status:200,json:()=>body.promise});const before=Date.now();await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'}),e=>e.code==='wb_task_request_timeout');assert.ok(Date.now()-before<500);body.resolve({code:0,data:{tasks:[task('SAMPLE_LATE')]}});await tick();assert.equal(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').tasks.length,0);
});
test('read timeout bounds a transport ignoring the timeout signal',async()=>{
  const f=fixture(),gate=deferred();f.service.workbuddyRuntime.taskRequestTimeoutMs=15;f.state.query=()=>gate.promise;const before=Date.now();await assert.rejects(queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'}),e=>e.code==='wb_task_request_timeout');assert.ok(Date.now()-before<500);gate.resolve();await tick();assert.equal(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').tasks.length,0);
});
test('late failure from an older query cannot replace a newer successful snapshot',async()=>{
  const f=fixture(),gate=deferred(),started=deferred();f.state.query=async s=>{if(s.queries===1){started.resolve();await gate.promise;throw Error('SAMPLE old failure');}};const old=queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'});await started.promise;f.state.tasks[0].progress.current=1;await queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'});const current=workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT');gate.resolve();await assert.rejects(old,/SAMPLE old failure/);const after=workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT');assert.equal(after.tasks[0].current,1);assert.equal(after.error,null);assert.equal(after.lastSuccessAt,current.lastSuccessAt);assert.equal(after.progress.status,'completed');
});
test('late older query success returns the newer snapshot rather than overwriting it',async()=>{
  const f=fixture(),gate=deferred(),started=deferred();let calls=0;f.service.workbuddyRuntime.fetchImpl=async()=>{const index=++calls;if(index===1){started.resolve();await gate.promise;}return Response.json({code:0,data:{tasks:[task('SAMPLE_TASK',{progress:{current:index===1?0:1,target:1}})]}});};
  const old=queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'});await started.promise;await queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'});gate.resolve();const r=await old;assert.equal(r.tasks[0].current,1);assert.equal(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').tasks[0].current,1);
});
test('non-cooperative acceptance keeps account locked and flight alive until settled after cancel',async()=>{
  const f=fixture([task('SAMPLE_TASK',{accept_status:'not_accepted'})]),controller=new AbortController(),gate=deferred(),started=deferred(),progress=[];
  f.state.accept=async()=>{started.resolve();await gate.promise;};const p=f.run({action:'accept',signal:controller.signal,onProgress:p=>progress.push(p)});await started.promise;controller.abort(Error('SAMPLE stop accept'));await tick();assert.equal(f.service.workbuddyTaskFlights.size,1);assert.equal(progress.at(-1).status,'cancelling');await assert.rejects(f.run({action:'accept'}),e=>e.code==='wb_tasks_busy');assert.equal(f.state.accepts.length,1);
  gate.resolve();await assert.rejects(p,/SAMPLE stop accept/);assert.equal(f.service.workbuddyTaskFlights.size,0);assert.equal(f.state.queries,1);assert.equal(f.state.claims.length,0);assert.equal(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').tasks[0].accepted,false);assert.equal(progress.at(-1).status,'cancelled');
  f.state.accept=null;await f.run({action:'accept'});assert.equal(f.state.accepts.length,1);
});
test('non-cooperative real executor cannot be replayed while cancellation is waiting for settlement',async()=>{
  const f=fixture(),controller=new AbortController(),gate=deferred(),started=deferred();let actions=0;f.service.workbuddyTaskExecutors.set('SAMPLE_TASK',async()=>{actions++;started.resolve();await gate.promise;f.state.tasks[0].progress.current=1;return {status:'completed'};});
  const p=f.run({signal:controller.signal});await started.promise;controller.abort(Error('SAMPLE stop executor'));await tick();assert.equal(f.service.workbuddyTaskFlights.size,1);await assert.rejects(f.run(),e=>e.code==='wb_tasks_busy');assert.equal(actions,1);gate.resolve();await assert.rejects(p,/SAMPLE stop executor/);assert.equal(f.state.claims.length,0);assert.equal(f.state.queries,1);assert.equal(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').tasks[0].current,0);assert.equal(f.service.workbuddyTaskFlights.size,0);
});
test('cancelled unknown claim retains submitted guard and never repeats the mutation',async()=>{
  const f=fixture([task('SAMPLE_TASK',{progress:{current:1,target:1}})]),controller=new AbortController(),gate=deferred(),started=deferred();f.state.claim=async()=>{started.resolve();await gate.promise;};const p=f.run({signal:controller.signal});await started.promise;controller.abort(Error('SAMPLE stop claim'));await tick();await assert.rejects(f.run(),e=>e.code==='wb_tasks_busy');assert.equal(f.service.workbuddyTaskFlights.size,1);gate.resolve();await assert.rejects(p,/SAMPLE stop claim/);f.state.tasks[0].accept_status='accepted';f.state.claim=null;const r=await f.run();assert.equal(f.state.claims.length,1);assert.ok(r.receipts.some(x=>x.status==='claim_unconfirmed'&&x.reason==='previous_submission_not_confirmed'));
});
test('aborted bulk query never starts the next account and emits account-specific progress',async()=>{
  const f=fixture(),controller=new AbortController(),gate=deferred(),started=deferred(),progress=[];f.service.config.value.accounts.push({id:'SAMPLE_SECOND',platform:'workbuddy',enabled:true,edition:'cn'});let resolves=0;const resolve=f.service.credentials.resolve;f.service.credentials.resolve=async(...args)=>{resolves++;return resolve(...args);};f.state.query=async()=>{started.resolve();await gate.promise;};const p=runWorkBuddyTasks(f.service,{action:'query',signal:controller.signal,onProgress:p=>progress.push(p)});await started.promise;controller.abort(Error('SAMPLE batch stop'));await assert.rejects(p,/SAMPLE batch stop/);assert.equal(resolves,1);assert.ok(progress.every(x=>x.accountId==='SAMPLE_ACCOUNT'));gate.resolve();await tick();
});
test('cancel during progress callback prevents the following execution or mutation',async()=>{
  const f=fixture([task('SAMPLE_TASK',{accept_status:'not_accepted'})]),controller=new AbortController();let actions=0;f.service.workbuddyTaskExecutors.set('SAMPLE_TASK',async()=>{actions++;return {status:'completed'};});await assert.rejects(f.run({signal:controller.signal,onProgress:p=>{if(p.phase==='accept')controller.abort(Error('SAMPLE observer cancel'));}}),/SAMPLE observer cancel/);assert.equal(f.state.accepts.length,0);assert.equal(actions,0);assert.equal(f.state.claims.length,0);
});
test('zero-receipt cancellation preserves all previous receipts and the last confirmed task snapshot',async()=>{
  const f=fixture([task('SAMPLE_TASK',{progress:{current:1,target:1}})]);await f.run({action:'claim'});const old=workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT'),saved=structuredClone(f.data.get('wb-management-task-receipts:SAMPLE_ACCOUNT')),controller=new AbortController(),gate=deferred(),started=deferred();
  f.state.query=async()=>{started.resolve();await gate.promise;};const p=f.run({signal:controller.signal});await started.promise;controller.abort(Error('SAMPLE cancel before receipt'));await assert.rejects(p,/SAMPLE cancel before receipt/);assert.deepEqual(f.data.get('wb-management-task-receipts:SAMPLE_ACCOUNT'),saved);assert.deepEqual(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').tasks,old.tasks);assert.equal(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').lastSuccessAt,old.lastSuccessAt);gate.resolve();await tick();assert.deepEqual(f.data.get('wb-management-task-receipts:SAMPLE_ACCOUNT'),saved);
});
test('a partial new operation appends receipts while preserving lastReceipt for unprocessed tasks',async()=>{
  const f=fixture([task('SAMPLE_A',{progress:{current:1,target:1}}),task('SAMPLE_B',{progress:{current:1,target:1}})]);await f.run({action:'claim'});const before=workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT'),bReceipt=before.tasks.find(t=>t.taskCode==='SAMPLE_B').lastReceipt;const result=await f.run({action:'claim',taskCodes:['SAMPLE_A']});assert.equal(result.receipts.length,1);assert.equal(result.receipts[0].taskCode,'SAMPLE_A');
  const after=workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT');assert.deepEqual(after.tasks.find(t=>t.taskCode==='SAMPLE_B').lastReceipt,bReceipt);assert.equal(after.receipts.length,before.receipts.length+1);assert.equal(after.tasks.find(t=>t.taskCode==='SAMPLE_A').lastReceipt.status,'already_claimed');await queryWorkBuddyTasks(f.service,{accountId:'SAMPLE_ACCOUNT'});assert.deepEqual(workBuddyTaskSnapshot(f.service,'SAMPLE_ACCOUNT').tasks.find(t=>t.taskCode==='SAMPLE_B').lastReceipt,bReceipt);
});
test('receipt history remains bounded to two hundred newest sanitized entries',async()=>{
  const f=fixture([task('SAMPLE_TASK',{accept_status:'claimed'})]);f.data.set('wb-management-task-receipts:SAMPLE_ACCOUNT',Array.from({length:200},(_,i)=>({accountId:'SAMPLE_ACCOUNT',action:'run',taskCode:'SAMPLE_OLD_'+i,status:'already_claimed',serverConfirmed:true,raw:{secret:'NEVER_REPORT'}})));const r=await f.run({action:'claim'}),saved=f.data.get('wb-management-task-receipts:SAMPLE_ACCOUNT');assert.equal(r.receipts.length,1);assert.equal(saved.length,200);assert.equal(saved[0].taskCode,'SAMPLE_OLD_1');assert.equal(saved.at(-1).taskCode,'SAMPLE_TASK');assert.equal(JSON.stringify(saved).includes('NEVER_REPORT'),false);
});
