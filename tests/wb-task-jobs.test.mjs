import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startWorkBuddyTaskJob,workBuddyTaskJob,activeWorkBuddyTaskJob,cancelWorkBuddyTaskJob} from '../src/workbuddy-task-jobs.mjs';
import {startServer} from '../src/server.mjs';

function fixture(run=async()=>{}){
 const map=new Map();return {config:{value:{accounts:[{id:'SAMPLE-A',platform:'workbuddy',enabled:true},{id:'SAMPLE-B',platform:'workbuddy',enabled:true},{id:'SAMPLE-OFF',platform:'workbuddy',enabled:false},{id:'SAMPLE-OTHER',platform:'loomy'}],server:{host:'127.0.0.1',port:0}}},ledger:{get:k=>map.get(k),set:(k,v)=>map.set(k,v)},workbuddyTaskExecutors:new Map(),workbuddyExecutorController:new AbortController(),workbuddyTaskJobRunner:run,keys:{adminKey:'SAMPLE-ADMIN-KEY-AT-LEAST-24-CHARS',apiKey:'SAMPLE-API-KEY-AT-LEAST-24-CHARS'}};
}
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function settled(s,id){for(let i=0;i<100;i++){const j=workBuddyTaskJob(s,id);if(['completed','cancelled','timed_out','failed'].includes(j.status))return j;await delay(2);}throw Error('SAMPLE job not settled');}

test('slow execution acknowledges immediately and GET progress never launches another execution',async()=>{
 const g=gate();let calls=0;const s=fixture(async(_,o)=>{calls++;o.onProgress({phase:'execution',accountId:'SAMPLE-A',taskCode:'SAMPLE-TASK',completed:1,total:3});await g.promise;});
 const before=Date.now(),j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});assert.equal(j.status,'running');assert.ok(Date.now()-before<100);await delay(2);
 for(let i=0;i<10;i++){const p=workBuddyTaskJob(s,j.jobId);assert.equal(p.progress.phase,'execution');assert.equal(p.progress.taskCode,'SAMPLE-TASK');assert.equal(p.progress.completed,1);assert.equal(p.progress.total,3);assert.equal(p.progress.accountId,'SAMPLE-A');}
 assert.equal(calls,1);g.resolve();assert.equal((await settled(s,j.jobId)).status,'completed');
});
test('active snapshot is local, includes live receipts and keeps automatic capability',async()=>{
 const g=gate(),s=fixture(async()=>g.promise);s.workbuddyTaskExecutors.set('SAMPLE-T',()=>{});
 const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});s.ledger.set('wb-management-tasks:SAMPLE-A',{accountId:'SAMPLE-A',tasks:[{taskCode:'SAMPLE-T',claimed:false}],receipts:[{taskCode:'SAMPLE-T',status:'accepted'}],checkedAt:'2026-10-16T00:00:00Z'});
 const p=workBuddyTaskJob(s,j.jobId);assert.equal(p.snapshot.tasks.length,1);assert.equal(p.snapshot.tasks[0].automaticExecution,true);assert.equal(p.snapshot.receipts[0].status,'accepted');g.resolve();await settled(s,j.jobId);
});
test('same active operation is idempotent and conflicting action is rejected',async()=>{
 const g=gate(),s=fixture(async()=>g.promise);const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A',action:'run',taskCode:'SAMPLE-T'});
 assert.equal(startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A',action:'run',taskCodes:['SAMPLE-T']}).jobId,j.jobId);
 assert.throws(()=>startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A',action:'claim'}),{code:'wb_tasks_busy'});
 g.resolve();await settled(s,j.jobId);
});
test('distinct accounts can progress separately but all-account job cannot overlap',async()=>{
 const g=gate(),s=fixture(async()=>g.promise),a=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'}),b=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-B'});
 assert.notEqual(a.jobId,b.jobId);assert.throws(()=>startWorkBuddyTaskJob(s,{}),{code:'wb_tasks_busy'});g.resolve();await settled(s,a.jobId);await settled(s,b.jobId);
});
test('all-account progress carries current account and aggregate local snapshots',async()=>{
 const g=gate(),s=fixture(async(_,o)=>{o.onProgress({phase:'query',accountId:'SAMPLE-B',completed:2,total:5});await g.promise;});
 s.ledger.set('wb-management-tasks:SAMPLE-A',{accountId:'SAMPLE-A',tasks:[{taskCode:'SAMPLE-T'}],receipts:[]});
 const j=startWorkBuddyTaskJob(s,{});await delay(2);assert.equal(workBuddyTaskJob(s,j.jobId).progress.accountId,'SAMPLE-B');assert.equal(j.snapshot.results.length,2);assert.equal(j.snapshot.tasks[0].accountId,'SAMPLE-A');
 assert.equal(activeWorkBuddyTaskJob(s,'SAMPLE-A').job.jobId,j.jobId);assert.throws(()=>startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'}),{code:'wb_tasks_busy'});g.resolve();await settled(s,j.jobId);
});
test('cancel does not release an operation whose current action ignores abort',async()=>{
 const g=gate();let signal,calls=0;const s=fixture(async(_,o)=>{calls++;signal=o.signal;await g.promise;});
 const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});await delay(2);const c=cancelWorkBuddyTaskJob(s,j.jobId);assert.equal(c.status,'cancelling');assert.equal(signal.aborted,true);
 assert.equal(activeWorkBuddyTaskJob(s,'SAMPLE-A').job.status,'cancelling');assert.equal(startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'}).jobId,j.jobId);assert.equal(calls,1);
 assert.throws(()=>startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A',action:'accept'}),{code:'wb_tasks_busy'});g.resolve();assert.equal((await settled(s,j.jobId)).status,'cancelled');assert.equal(activeWorkBuddyTaskJob(s,'SAMPLE-A').job,null);
});
test('deadline aborts future work without reporting unconfirmed current side effect finished',async()=>{
 const g=gate();let signal;const s=fixture(async(_,o)=>{signal=o.signal;await g.promise;});s.workbuddyTaskJobTimeoutMs=10;
 const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});await delay(25);const c=workBuddyTaskJob(s,j.jobId);assert.equal(c.status,'cancelling');assert.equal(c.cancelReason,'deadline');assert.equal(signal.aborted,true);assert.equal(signal.reason.code,'wb_task_job_timeout');g.resolve();assert.equal((await settled(s,j.jobId)).status,'timed_out');
});
test('cooperative query deadline promptly settles and preserves last tasks',async()=>{
 const s=fixture(async(_,o)=>delay(1000,undefined,{signal:o.signal}));s.workbuddyTaskQueryJobTimeoutMs=5;s.ledger.set('wb-management-tasks:SAMPLE-A',{accountId:'SAMPLE-A',tasks:[{taskCode:'SAMPLE-OLD'}],receipts:[]});
 const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A',action:'query'}),end=await settled(s,j.jobId);assert.equal(end.status,'timed_out');assert.equal(end.snapshot.tasks[0].taskCode,'SAMPLE-OLD');assert.equal(end.error.code,'wb_task_job_timeout');
});
test('shutdown stops queued work and keeps submitted work active until settle',async()=>{
 const g=gate(),s=fixture(async()=>g.promise),j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});await delay(2);s.workbuddyExecutorController.abort();assert.equal(workBuddyTaskJob(s,j.jobId).status,'cancelling');g.resolve();assert.equal((await settled(s,j.jobId)).status,'cancelled');
 const pre=fixture(async()=>{throw Error('should not start');});pre.workbuddyExecutorController.abort();const k=startWorkBuddyTaskJob(pre,{accountId:'SAMPLE-A'});assert.equal((await settled(pre,k.jobId)).status,'cancelled');
});
test('terminal result is current sanitized task snapshot and completed elapsed stays fixed',async()=>{
 const s=fixture(async(service)=>service.ledger.set('wb-management-tasks:SAMPLE-A',{accountId:'SAMPLE-A',tasks:[{taskCode:'SAMPLE-T',claimed:true}],receipts:[],checkedAt:'2026-10-16T00:00:00Z'}));
 const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'}),v=await settled(s,j.jobId);assert.equal(v.result.tasks[0].claimed,true);assert.equal(v.snapshot.checkedAt,'2026-10-16T00:00:00Z');await delay(4);assert.equal(workBuddyTaskJob(s,j.jobId).progress.elapsedMs,v.progress.elapsedMs);
});
test('completed job result is frozen while current snapshot can advance',async()=>{
 const s=fixture(async(service)=>service.ledger.set('wb-management-tasks:SAMPLE-A',{accountId:'SAMPLE-A',tasks:[{taskCode:'SAMPLE-T',claimed:true}],receipts:[]}));
 const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});await settled(s,j.jobId);
 s.ledger.set('wb-management-tasks:SAMPLE-A',{accountId:'SAMPLE-A',tasks:[{taskCode:'SAMPLE-NEW',claimed:false}],receipts:[]});
 const v=workBuddyTaskJob(s,j.jobId);assert.equal(v.result.tasks[0].taskCode,'SAMPLE-T');assert.equal(v.snapshot.tasks[0].taskCode,'SAMPLE-NEW');v.result.tasks.length=0;assert.equal(workBuddyTaskJob(s,j.jobId).result.tasks.length,1);
});
test('closing rejects new jobs and shutdown tracks queued job until complete',async()=>{
 const g=gate(),s=fixture(async()=>g.promise);const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});assert.equal(s.workbuddyTaskJobFlights.size,1);s.workbuddyTaskJobsClosing=true;assert.throws(()=>startWorkBuddyTaskJob(s,{accountId:'SAMPLE-B'}),{code:'wb_task_service_stopping'});g.resolve();await settled(s,j.jobId);assert.equal(s.workbuddyTaskJobFlights.size,0);
});
test('temporary local snapshot failure keeps previous rows without losing job completion',async()=>{
 const g=gate(),s=fixture(async()=>g.promise);s.ledger.set('wb-management-tasks:SAMPLE-A',{accountId:'SAMPLE-A',tasks:[{taskCode:'SAMPLE-OLD'}],receipts:[]});const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});s.ledger.get=()=>{throw Error('SAMPLE DB busy');};const p=workBuddyTaskJob(s,j.jobId);assert.equal(p.snapshot.tasks[0].taskCode,'SAMPLE-OLD');assert.equal(p.snapshotError.code,'wb_task_snapshot_temporarily_unavailable');g.resolve();assert.equal((await settled(s,j.jobId)).status,'completed');assert.equal(s.workbuddyTaskJobFlights.size,0);
});
test('task failure has bounded typed error, releases job for explicit later operation',async()=>{
 const s=fixture(async()=>{const e=Error('SAMPLE upstream unavailable');e.code='SAMPLE_ERROR';e.status=502;throw e;});const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});const v=await settled(s,j.jobId);assert.equal(v.status,'failed');assert.equal(v.error.code,'SAMPLE_ERROR');assert.equal(activeWorkBuddyTaskJob(s,'SAMPLE-A').job,null);assert.notEqual(startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'}).jobId,j.jobId);
});
test('progress strips unknown fields and invalid phases',async()=>{
 const g=gate(),s=fixture(async(_,o)=>{o.onProgress({phase:'SAMPLE-UNKNOWN',taskCode:'SAMPLE-T',completed:-1,total:Infinity,credential:'SAMPLE_PRIVATE',prompt:'SAMPLE_PRIVATE'});await g.promise;});
 const j=startWorkBuddyTaskJob(s,{accountId:'SAMPLE-A'});await delay(2);const v=workBuddyTaskJob(s,j.jobId);assert.equal(v.progress.phase,'queued');assert.equal(v.progress.completed,0);assert.equal(v.progress.total,0);assert.doesNotMatch(JSON.stringify(v),/SAMPLE_PRIVATE/);g.resolve();await settled(s,j.jobId);
});
for(const invalid of [null,[],{action:'SAMPLE-BAD'},{accountId:'SAMPLE-OFF'},{accountId:'SAMPLE-OTHER'},{accountId:''},{taskCodes:[null]},{taskCode:''},{signal:'SAMPLE'},{onProgress:'SAMPLE'}])test('invalid request does not start a task '+JSON.stringify(invalid),()=>{let calls=0;const s=fixture(async()=>calls++);assert.throws(()=>startWorkBuddyTaskJob(s,invalid));assert.equal(calls,0);});
test('unknown job is not silently restarted',()=>{const s=fixture();assert.throws(()=>workBuddyTaskJob(s,'SAMPLE-UNKNOWN'),{code:'wb_task_job_not_found'});assert.throws(()=>cancelWorkBuddyTaskJob(s,'SAMPLE-UNKNOWN'),{code:'wb_task_job_not_found'});});
test('HTTP start is 202 and GET/cancel are independently authenticated and nonblocking',async()=>{
 const g=gate();let count=0;const s=fixture(async()=>{count++;await g.promise;});const server=await startServer(s,{port:0});
 const headers={authorization:'Bearer '+s.keys.adminKey,'content-type':'application/json'};
 try{
  const denied=await fetch(server.baseUrl+'/admin/workbuddy/task-jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:'SAMPLE-A'})});assert.equal(denied.status,401);
  const response=await fetch(server.baseUrl+'/admin/workbuddy/task-jobs',{method:'POST',headers,body:JSON.stringify({accountId:'SAMPLE-A'})});assert.equal(response.status,202);const j=await response.json();
  const poll=await fetch(server.baseUrl+'/admin/workbuddy/task-jobs/'+j.jobId,{headers});assert.equal(poll.status,200);assert.equal((await poll.json()).status,'running');
  const active=await fetch(server.baseUrl+'/admin/workbuddy/task-jobs?accountId=SAMPLE-A',{headers});assert.equal((await active.json()).job.jobId,j.jobId);
  const cancel=await fetch(server.baseUrl+'/admin/workbuddy/task-jobs/'+j.jobId+'/cancel',{method:'POST',headers,body:'{}'});assert.equal(cancel.status,202);assert.equal((await cancel.json()).status,'cancelling');assert.equal(count,1);g.resolve();assert.equal((await settled(s,j.jobId)).status,'cancelled');
 }finally{g.resolve();await server.close();}
});
