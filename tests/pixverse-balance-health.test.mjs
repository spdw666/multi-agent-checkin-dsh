import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
const root=process.env.PIXVERSE_TEST_ROOT??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {createVideoDailyProvider,parsePixVerseLoginTask}=await import(pathToFileURL(path.join(root,'src/provider-video-daily.mjs')));
const credential={accessToken:'SAMPLE',authToken:'SAMPLE',principal:'SAMPLE'};
const task=(progress=0,reward=30)=>[{task_type:1,sub_type:1,progress,reward}];
const json=value=>new Response(JSON.stringify({ErrCode:0,Resp:value}),{headers:{'Content-Type':'application/json'}});
function fixture({progress=0,balance={credit_daily:30,credit_monthly:0,credit_package:60},taskReply,taskHttp}={}){
 const seen=[];const p=createVideoDailyProvider('pixverse',{fetchImpl:async(url,options)=>{seen.push({url,method:options.method});if(url.endsWith('/user/credits'))return json(balance);if(url.endsWith('/task/list'))return taskHttp?new Response('SAMPLE_PRIVATE',{status:taskHttp}):json(taskReply??task(progress));throw Error('Unexpected mutation');}});return {p,seen};
}
test('official progress0 is pending, not invalid/claimed/claimable',()=>{const s=parsePixVerseLoginTask(task());assert.equal(s.known,false);assert.equal(s.active,false);assert.equal(s.claimed,null);assert.equal(s.reason,'daily_login_task_pending');assert.equal(s.details.progress,0);});
test('real captured shape keeps90 balance when daily task progress0',async()=>{const {p,seen}=fixture();const h=await p.health(credential);assert.equal(h.balance.value,90);assert.equal(h.status,'authenticated');assert.equal(h.checkin.known,false);assert.equal(h.checkin.claimed,null);assert.match(h.balance.note,/余额已核验/);assert.equal(seen.length,2);assert.ok(seen.every(r=>r.method==='GET'));});
test('progress0 never dispatches a reward POST',async()=>{const {p,seen}=fixture();await assert.rejects(()=>p.claim(credential),e=>e.beforeSubmission===true&&e.code==='video_daily_not_claimable');assert.ok(seen.every(r=>!r.url.endsWith('/reward/claim')&&r.method==='GET'));});
for(const reply of [{list:[]},[{task_type:1,sub_type:1,progress:99,reward:30}],task().concat(task())])test('malformed/unknown/ambiguous task does not erase verified balance '+JSON.stringify(reply),async()=>{const {p}=fixture({taskReply:reply});const h=await p.health(credential);assert.equal(h.balance.value,90);assert.equal(h.checkin.known,false);assert.equal(h.checkin.active,false);assert.equal(h.checkin.claimed,null);assert.doesNotMatch(JSON.stringify(h),/SAMPLE_PRIVATE/);});
test('real zero balance is retained with pending task',async()=>{const {p}=fixture({balance:{credit_daily:0,credit_monthly:'0',credit_package:0}});assert.equal((await p.health(credential)).balance.value,0);});
test('bad balance still fails rather than fabricating90 or zero',async()=>{const {p}=fixture({balance:{credit_daily:30,credit_package:60}});await assert.rejects(()=>p.health(credential),e=>e.code==='video_daily_response_invalid');});
for(const taskHttp of [401,403,429,500])test('task HTTP '+taskHttp+' remains a genuine failure',async()=>{const {p}=fixture({taskHttp});await assert.rejects(()=>p.health(credential),e=>e.status===(taskHttp===403?401:taskHttp));});
for(const [progress,claimed,active]of [[1,false,false],[2,false,true],[3,true,false],[4,false,false]])test('existing progress'+progress+' unchanged',()=>{const s=parsePixVerseLoginTask(task(progress));assert.equal(s.claimed,claimed);assert.equal(s.active,active);assert.equal(s.known,true);});
