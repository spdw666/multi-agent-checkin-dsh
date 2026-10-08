import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeChat,collectChat,sseEvents,validateChat} from '../src/openai.mjs';
import {Ledger} from '../src/store.mjs';
import {ClaimService} from '../src/claims.mjs';
import {Router} from '../src/router.mjs';
import {validateConfig,ConfigStore,projectRoot} from '../src/config.mjs';
import {AppError,dayIn,redact,rememberSecret} from '../src/util.mjs';
import {dailyPlan,Scheduler} from '../src/scheduler.mjs';
import {prepareChatBody,declaredTools} from '../vendor/workbuddy-core.mjs';
const content=d=>({choices:[{index:0,delta:d,finish_reason:null}]});
const finish=reason=>({choices:[{index:0,delta:{},finish_reason:reason}]});
const response=(events,done=true)=>new Response(events.map(e=>typeof e==='string'?e:`data: ${JSON.stringify(e)}\n\n`).join('')+(done?'data: [DONE]\n\n':''),{headers:{'Content-Type':'text/event-stream'}});
test('SSE: fragmented UTF-8, CRLF, comments, multi-line data',async()=>{
  const bytes=new TextEncoder().encode(':comment\r\nevent: chunk\r\ndata: 你\r\ndata: 好\r\n\r\n');let i=0;
  const stream=new ReadableStream({pull(c){if(i===bytes.length)c.close();else c.enqueue(bytes.slice(i,i+=1))}});
  const rows=[];for await(const e of sseEvents(stream))rows.push(e);assert.deepEqual(rows,[{event:'chunk',data:'你\n好'}]);
});
test('shared OpenAI layer aggregates text, reasoning and usage',async()=>{
  const r=await collectChat(normalizeChat(response([content({role:'assistant'}),content({reasoning_content:'think'}),content({content:'O'}),content({content:'K'}),finish('stop'),{choices:[],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}]),{model:'route'}));
  assert.equal(r.model,'route');assert.equal(r.choices[0].message.content,'OK');assert.equal(r.choices[0].message.reasoning_content,'think');assert.equal(r.usage.total_tokens,5);
});
test('tool-call fragments preserve indexes/IDs/name/arguments; no tool executes in gateway',async()=>{
  const r=await collectChat(normalizeChat(response([content({tool_calls:[{index:0,id:'call-a',type:'function',function:{name:'sum',arguments:'{"a":'}}]}),content({tool_calls:[{index:0,function:{arguments:'17}'}}]}),finish('tool_calls')]),{model:'route'}));
  assert.equal(r.choices[0].finish_reason,'tool_calls');assert.deepEqual(r.choices[0].message.tool_calls,[{id:'call-a',type:'function',function:{name:'sum',arguments:'{"a":17}'}}]);
});
test('parallel tools and normal JSON upstream responses use same collector',async()=>{
  const tools=[{index:1,id:'b',type:'function',function:{name:'right',arguments:'{}'}},{index:0,id:'a',type:'function',function:{name:'left',arguments:'{}'}}];
  const r=await collectChat(normalizeChat(response([content({tool_calls:tools}),finish('tool_calls')]),{model:'r'}));assert.deepEqual(r.choices[0].message.tool_calls.map(t=>t.id),['a','b']);
  const json=new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'YES'},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}});
  assert.equal((await collectChat(normalizeChat(json,{model:'r'}))).choices[0].message.content,'YES');
});
test('200 business errors, event errors, malformed JSON, empty and truncated streams fail',async()=>{
  for(const r of [response([{code:9004,msg:'business'}]),response(['event: error\ndata: {"error":{"message":"failure"}}\n\n']),response(['data: {bad\n\n']),response([]),response([content({content:'half'})],false)])await assert.rejects(collectChat(normalizeChat(r,{model:'r'})));
});
test('DSML recovery only accepts fully closed declared tools',async()=>{
  const mark='｜DSML｜';const markup=`<${mark}function_calls><${mark}invoke name="sum"><${mark}parameter name="a" string="false">17</${mark}parameter></${mark}invoke></${mark}function_calls>`;
  const gate={declaredNames:new Set(['sum']),requiredParameters:new Map([['sum',['a']]])};
  const r=await collectChat(normalizeChat(response([content({content:markup}),finish('stop')]),{model:'r',recovery:gate}));assert.equal(r.choices[0].message.tool_calls?.[0]?.function.name,'sum');
  const missing=await collectChat(normalizeChat(response([content({content:markup.slice(0,-25)}),finish('length')]),{model:'r',recovery:gate}));assert.equal(missing.choices[0].message.tool_calls,undefined);assert.ok(missing.choices[0].message.content.length>0);
  const undeclared=await collectChat(normalizeChat(response([content({content:markup}),finish('stop')]),{model:'r',recovery:{declaredNames:new Set()}}));assert.equal(undeclared.choices[0].message.tool_calls,undefined);assert.equal(undeclared.choices[0].message.content,markup);
});
test('WorkBuddy request preparation preserves history/tools and maps developer role',()=>{
  const body=JSON.parse(prepareChatBody(JSON.stringify({model:'m',messages:[{role:'developer',content:'SYSTEM'},{role:'assistant',tool_calls:[{id:'c',type:'function',function:{name:'sum',arguments:'{}'}}],reasoning_content:'why'},{role:'tool',tool_call_id:'c',content:'42'}],tools:[{type:'function',function:{name:'sum',parameters:{required:['a']}}}],tool_choice:{type:'function',function:{name:'sum'}}})));
  assert.equal(body.stream,true);assert.equal(body.messages[0].role,'system');assert.equal(body.messages[2].tool_call_id,'c');assert.equal(body.messages[1].reasoning_content,'why');assert.equal(body.tool_choice,'sum');assert.equal(declaredTools(JSON.stringify(body)).pinnedToolName,'sum');
  assert.equal(JSON.parse(prepareChatBody(JSON.stringify({...body,tool_choice:'none'}))).tools,undefined);
});
test('fallback happens before role-only prelude, never after first useful output',async()=>{
  const config={value:{routes:[{id:'r',targets:[{upstreamId:'a',model:'m'},{upstreamId:'b',model:'m'}]}]}};let calls=[];
  const p={async models(){return [{id:'m',tools:true}]},async chat(t){calls.push(t.upstreamId);return {response:t.upstreamId==='a'?response([content({role:'assistant'}),{error:{message:'retryable'}}]):response([content({content:'fallback'}),finish('stop')])}}};
  const r=await collectChat(new Router(config,p).chat({model:'r',messages:[{role:'user',content:'x'}]}));assert.equal(r.choices[0].message.content,'fallback');assert.deepEqual(calls,['a','b']);
  calls=[];p.chat=async t=>{calls.push(t.upstreamId);return {response:response([content({content:'committed'}),{error:{message:'stop'}}])}};
  await assert.rejects(collectChat(new Router(config,p).chat({model:'r',messages:[{role:'user',content:'x'}]})));assert.deepEqual(calls,['a']);
});
test('no fallback on authentication rejection, and unknown tool/image capabilities are rejected',async()=>{
  const config={value:{routes:[{id:'r',targets:[{upstreamId:'a',model:'m'},{upstreamId:'b',model:'m'}]}]}};let calls=0;
  const p={async models(){return [{id:'m'}]},async chat(){calls++;throw new AppError('login',401,'auth')}};
  const router=new Router(config,p);await assert.rejects(collectChat(router.chat({model:'r',messages:[{role:'user',content:'x'}]})),e=>e.status===401);assert.equal(calls,1);
  await assert.rejects(collectChat(router.chat({model:'r',messages:[{role:'user',content:'x'}],tools:[{type:'function',function:{name:'t'}}]})),e=>e.code==='tools_not_supported');
  await assert.rejects(collectChat(router.chat({model:'r',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:'}}]}]})),e=>e.code==='images_not_supported');
});
test('SQLite claims: concurrency, same-day idempotency, restart persistence, account isolation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'credit-ledger-'));let ledger=new Ledger(dir);const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'workbuddy',tasks:[{id:'daily-checkin',enabled:true}]},{id:'b',platform:'workbuddy',tasks:[{id:'daily-checkin',enabled:true}]}]}};
  let submissions=0;const states=new Map();const credentials={async resolve(id){return {principalHash:id}}};
  const platforms={async status(id){await new Promise(r=>setTimeout(r,20));return {known:true,active:true,claimed:states.get(id)??false,credits:100}},async claim(id){submissions++;states.set(id,true);return {credit:100}}};
  try {const service=new ClaimService(config,credentials,platforms,ledger);const results=await Promise.all([service.run('a'),service.run('a')]);assert.ok(results.some(r=>r.status==='success'));assert.equal(submissions,1);assert.equal((await service.run('b')).status,'success');assert.equal(submissions,2);
    ledger.close();ledger=new Ledger(dir);assert.equal((await new ClaimService(config,credentials,platforms,ledger).run('a')).status,'already');assert.equal(submissions,2);assert.equal(ledger.records().length,4);
  }finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('claim timeout stays uncertain; server already claimed never submits',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'credit-uncertain-'));const ledger=new Ledger(dir);const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'workbuddy',tasks:[{id:'daily-checkin',enabled:true}]}]}};
  let calls=0,claimed=false;const platforms={async status(){return {known:true,active:true,claimed}},async claim(){calls++;throw new Error('timeout')}};const c=new ClaimService(config,{async resolve(){return {principalHash:'p'}}},platforms,ledger);
  try{assert.equal((await c.run('a')).status,'uncertain');assert.equal((await c.run('a')).status,'uncertain');assert.equal(calls,1);claimed=true;assert.equal((await c.run('a')).status,'already');assert.equal(calls,1);}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('principal change requires explicit rebind; no implicit account switching',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'credit-binding-'));const ledger=new Ledger(dir);try{assert.equal(ledger.bind('a','workbuddy','user1').ok,true);assert.equal(ledger.bind('a','workbuddy','user2').ok,false);ledger.unbind('a');assert.equal(ledger.bind('a','workbuddy','user2').ok,true);}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('claims disabled, activity inactive and device occupied remain distinct',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'credit-disabled-'));const ledger=new Ledger(dir);const account={id:'a',platform:'trae',tasks:[{id:'daily-checkin',enabled:false}]};const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[account]}};
  const p={async status(){return {known:true,active:false}},async claim(){assert.fail('must not submit')}};const c=new ClaimService(config,{async resolve(){return {principalHash:'p'}}},p,ledger);
  try{assert.equal((await c.run('a')).status,'skipped');account.tasks[0].enabled=true;assert.equal((await c.run('a')).status,'not_available');p.status=async()=>({known:true,active:true,deviceOccupied:true});assert.equal((await c.run('a')).status,'device_occupied');}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('configuration validation enforces account/platform separation and explicit exposure',async()=>{
  const c=JSON.parse(await readFile(join(projectRoot,'config.example.json')));validateConfig(c);
  assert.throws(()=>validateConfig({...c,server:{...c.server,host:'0.0.0.0'}}));
  assert.throws(()=>validateConfig({...c,accounts:[...c.accounts,c.accounts[0]]}));
  assert.throws(()=>validateConfig({...c,upstreams:[{id:'bad',kind:'trae',accountId:'workbuddy-main'}]}));
  assert.throws(()=>validateChat({model:'m',messages:[]}));
});
test('daily schedule and Beijing day are independent of host timezone',()=>{
  assert.equal(dayIn(new Date('2026-10-06T17:00:00Z')),'2026-10-07');
  assert.equal(new Date(dailyPlan(new Date('2026-10-07T01:00:00Z'),{timezone:'Asia/Shanghai',hour:10,minute:0},30)).toISOString(),'2026-10-07T02:00:30.000Z');
});
test('credential values are redacted before logging',()=>{rememberSecret('fixture-secret-token');assert.equal(redact('fixture-secret-token'),'[REDACTED]');assert.equal(redact('Bearer opaque-key'),'Bearer [REDACTED]');});

test('definitive business rejection is terminal for the day, unlike a network timeout',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'credit-rejected-'));const ledger=new Ledger(dir);let submissions=0;
 const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'trae',tasks:[{id:'daily-checkin',enabled:true}]}]}};
 const p={async status(){return {known:true,active:true,claimed:false}},async claim(){submissions++;const e=new AppError('9004 invalid device',502,'claim_rejected');e.definitiveRejection=true;throw e}};
 const c=new ClaimService(config,{async resolve(){return {principalHash:'p'}}},p,ledger);
 try{assert.equal((await c.run('a')).status,'rejected');assert.equal((await c.run('a')).status,'rejected');assert.equal(submissions,1)}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('scheduler preserves daily jitter across restart and drains startup jobs before ledger close',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'credit-schedule-'));const ledger=new Ledger(dir);let jobs=0,completed=0;
 const config={value:{scheduler:{enabled:true,startup:true,timezone:'Asia/Shanghai',hour:23,minute:59,jitterSeconds:30,retryMinutes:60}}};
 const claims={async all(){jobs++;await new Promise(r=>setTimeout(r,20));completed++;return []}};
 try{const scheduler=new Scheduler(config,claims,ledger);scheduler.start();await scheduler.stop();assert.equal(completed,1);const plan=ledger.get('schedule-plan');
 const next=new Scheduler(config,claims,ledger);next.stopped=false;await next.tick();const after=ledger.get('schedule-plan');await next.tick();assert.deepEqual(ledger.get('schedule-plan'),after);assert.ok(after.jitterSeconds>=0&&after.jitterSeconds<=30);
 }finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});

