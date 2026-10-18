import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {setImmediate as tick} from 'node:timers/promises';
import {join,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Run this same correct-behaviour suite against a frozen baseline or the stage.
const root=process.env.GATEWAY_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {Router}=await import(pathToFileURL(join(root,'src/router.mjs')));
const {collectChat}=await import(pathToFileURL(join(root,'src/openai.mjs')));
const {AppError}=await import(pathToFileURL(join(root,'src/util.mjs')));
const model='deepseek-v4.1-flash',route='SAMPLE/'+model;
function fixture({single=false}={}){
  const ids=single?['primary']:['primary','standby'],values=new Map(),rows=[],calls=[],waits=[];
  const config={value:{server:{requestTimeoutMs:100000},accounts:ids.map(id=>({id,platform:'codebuddy'})),upstreams:ids.map(id=>({id,kind:'codebuddy',accountId:id})),routes:ids.map((id,i)=>({id:i?'SAMPLE_STANDBY/'+model:route,targets:[{upstreamId:id,model}]})),modelRelay:{enabled:true}}};
  const platforms={models:async()=>[{id:model,callable:true,tools:true,contextWindow:200000,maxTokens:8192}],chat:undefined};
  const ledger={get:k=>values.get(k),set:(k,v)=>values.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>{rows[i]=r;}};
  const router=new Router(config,platforms,{ledger,relayAttemptTimeoutMs:1000,relayNetworkRetryDelayMs:0,relayRateLimitDelay:async ms=>{waits.push(ms);}});
  return {config,platforms,values,rows,calls,waits,router};
}
const request=()=>({model:route,stream:true,max_tokens:4096,max_completion_tokens:4096,messages:[{role:'system',content:'SAMPLE complete system context'},{role:'user',content:'SAMPLE complete user context'},{role:'assistant',content:null,tool_calls:[{id:'SAMPLE_TOOL_ID',type:'function',function:{name:'sample_read',arguments:'{"path":"SAMPLE"}'}}]},{role:'tool',tool_call_id:'SAMPLE_TOOL_ID',content:'SAMPLE full tool result'}],tools:[{type:'function',function:{name:'sample_read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}],tool_choice:'auto'});
const reply=(message,finish='stop',usage)=>({response:Response.json({choices:[{message,finish_reason:finish}],...(usage?{usage}:{})})});
function recordCall(f,t,r){f.calls.push({upstream:t.upstreamId,request:structuredClone(r)});}
const rate=(kind='transient',code=6001)=>Object.assign(new AppError('SAMPLE official limit',429,'provider_chat_rejected'),{upstreamCode:code,rateLimitKind:kind,rateLimitRetryable:kind==='transient',retryAfterSeconds:0,retryAfterSource:'official_header'});

test('reasoning-only stop below the budget falls through to a healthy same-model supplier',async()=>{
  const f=fixture(),raw=request(),original=structuredClone(raw);
  f.platforms.chat=async(t,r)=>{recordCall(f,t,r);return t.upstreamId==='primary'?reply({content:'',reasoning_content:'SAMPLE short thought'},'stop',{completion_tokens:10,completion_tokens_details:{reasoning_tokens:10}}):reply({content:'SAMPLE_STANDBY_ANSWER'});};
  const out=await collectChat(f.router.chat(raw));
  assert.equal(out.choices[0].message.content,'SAMPLE_STANDBY_ANSWER');
  assert.deepEqual(f.calls.map(c=>c.upstream),['primary','standby']);
  assert.deepEqual(f.calls.map(c=>c.request),[original,original]);
  assert.equal(f.rows[0].error.code,'empty_response');
  assert.equal(f.rows[0].completionTokens,10);
  assert.deepEqual(raw,original);
});

test('reasoning-only stop on the final supplier is a 502 empty answer, not a caller 400',async()=>{
  const f=fixture({single:true});f.platforms.chat=async()=>reply({content:'',reasoning_content:'SAMPLE short thought'},'stop');
  await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===502&&e.code==='empty_response');
  assert.equal(f.rows[0].error.code,'empty_response');
});

test('an explicit length finish with only reasoning keeps the truthful budget diagnosis and no replay',async()=>{
  const f=fixture();f.platforms.chat=async(t,r)=>{recordCall(f,t,r);return reply({content:'',reasoning_content:'SAMPLE budget consumed'},'length',{completion_tokens:4096,completion_tokens_details:{reasoning_tokens:4096}});};
  await assert.rejects(collectChat(f.router.chat(request())),e=>e.status===400&&e.code==='reasoning_budget_exhausted');
  assert.equal(f.calls.length,1);assert.equal(f.rows[0].completionTokens,4096);
  assert.deepEqual([...f.values.keys()].filter(k=>k.startsWith('relay-cooldown:')),[]);
});

test('content or native tool calls still wins over reasoning even at the length boundary',async()=>{
  for(const message of [{content:'SAMPLE_BODY',reasoning_content:'SAMPLE thought'},{content:null,reasoning_content:'SAMPLE thought',tool_calls:[{id:'SAMPLE_NEW_TOOL',type:'function',function:{name:'sample_read',arguments:'{"path":"SAMPLE_NEXT"}'}}]}]){
    const f=fixture({single:true});f.platforms.chat=async()=>reply(message,'length');
    const out=await collectChat(f.router.chat(request()));
    assert.equal(out.choices[0].finish_reason,'length');
    assert.equal(out.choices[0].message.reasoning_content,message.reasoning_content);
    if(message.tool_calls)assert.deepEqual(out.choices[0].message.tool_calls,message.tool_calls);else assert.equal(out.choices[0].message.content,message.content);
  }
});

test('a small last target is skipped and original-supplier recovery retains the original full output budget',async()=>{
  const f=fixture(),raw=request(),original=structuredClone(raw);let primaryCalls=0;
  f.platforms.models=async id=>[{id:model,callable:true,tools:true,contextWindow:200000,maxTokens:id==='primary'?8192:1024}];
  f.platforms.chat=async(t,r)=>{recordCall(f,t,r);if(t.upstreamId==='primary'&&++primaryCalls===2)return reply({content:'SAMPLE_RECOVERED_'+r.max_tokens});throw rate();};
  const out=await collectChat(f.router.chat(raw));
  assert.equal(out.choices[0].message.content,'SAMPLE_RECOVERED_4096');
  assert.deepEqual(f.calls.map(c=>[c.upstream,c.request.max_tokens,c.request.max_completion_tokens]),[['primary',4096,4096],['primary',4096,4096]]);
  for(const c of f.calls)assert.deepEqual(c.request,original);
  assert.deepEqual(f.rows.filter(r=>r.outputClamped),[]);
  assert.equal(f.rows[1].status,'skipped');assert.equal(f.rows[1].candidatePlan.reasonCode,'relay_capacity_incompatible');
  assert.equal(f.rows[1].dispatchCount,0);assert.equal(f.rows.at(-1).requestOutcome.attemptCount,2);assert.equal(f.rows.at(-1).requestOutcome.skippedCount,1);
  assert.deepEqual(raw,original);assert.equal(f.waits.length,1);
});

test('a final small supplier is not sent a silently reduced request after the original supplier fails',async()=>{
  const f=fixture(),raw=request(),original=structuredClone(raw);
  f.platforms.models=async id=>[{id:model,callable:true,tools:true,contextWindow:200000,maxTokens:id==='primary'?8192:1024}];
  f.platforms.chat=async(t,r)=>{recordCall(f,t,r);if(t.upstreamId==='primary')throw new AppError('SAMPLE unavailable',503,'provider_chat_rejected');return reply({content:'SAMPLE_SMALL_ANSWER'});};
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===503&&e.relayFailure.root.code==='provider_chat_rejected'&&e.relayFailure.last.code==='relay_capacity_incompatible');
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].request,original);assert.deepEqual(raw,original);
  assert.equal(f.rows[1].status,'skipped');assert.equal(f.rows[1].dispatchCount,0);assert.equal(f.rows[1].outputClamped,undefined);
});

test('official long-window 6004 traverses the pool at most once and never schedules recovery',async()=>{
  const f=fixture(),raw=request(),original=structuredClone(raw);f.platforms.chat=async(t,r)=>{recordCall(f,t,r);throw rate('long_window',6004);};
  await assert.rejects(collectChat(f.router.chat(raw)),e=>e.status===429&&e.code==='same_model_rate_limited'&&e.upstreamCode===6004&&e.rateLimitKind==='long_window'&&e.rateLimitRetryable===false);
  assert.deepEqual(f.calls.map(c=>c.upstream),['primary','standby']);assert.equal(f.waits.length,0);
  for(const c of f.calls)assert.deepEqual(c.request,original);
  assert.deepEqual(raw,original);
});

async function workerFixture(){
  const sourceFile=join(root,'bundle/index.mjs'),text=await readFile(sourceFile,'utf8');
  const begin=text.indexOf('export async function createBundleRuntime('),end=text.indexOf('\nexport function apply(',begin);assert.ok(begin>=0&&end>begin);
  const symbol=text.slice(begin,end).replace(/^export /,'').replaceAll('import.meta.url',JSON.stringify(pathToFileURL(sourceFile).href));
  const children=[],delays=[],timers=new Map();let now=0,id=0;
  const spawn=()=>{const child=new EventEmitter();Object.assign(child,{pid:1000+children.length,stderr:new EventEmitter(),exitCode:null,connected:true,kill(){this.exitCode=1;this.connected=false;this.emit('exit',1,null);return true;},send(m){if(m.type==='shutdown'){this.exitCode=0;this.connected=false;this.emit('exit',0,null);}}});children.push(child);queueMicrotask(()=>child.emit('message',{type:'ready',baseUrl:'http://127.0.0.1:'+child.pid,key:'SAMPLE_KEY_'+child.pid}));return child;};
  const setTimeout=(callback,ms)=>{const key=++id;timers.set(key,{callback,ms,at:now+ms});return key;};
  const dependencyNames=['spawn','access','basename','process','fileURLToPath','URL','homedir','join','diagnostic','rememberSecret','errorView','fetch','setTimeout','clearTimeout','Date'];
  const factory=new Function(...dependencyNames,symbol+';return createBundleRuntime;');
  const create=factory(spawn,async()=>{},basename,process,fileURLToPath,URL,()=>'/SAMPLE_HOME',join,async()=>{},()=>{},e=>({message:e.message}),async()=>{throw new Error('SAMPLE no network');},setTimeout,key=>timers.delete(key),{now:()=>now});
  const runtime=await create('SAMPLE_CONFIG');
  const advance=async ms=>{const until=now+ms;while(true){const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].callback();await tick();}now=until;await tick();};
  const crash=async()=>{const c=children.at(-1);c.exitCode=1;c.connected=false;c.emit('exit',1,null);await tick();};
  const restart=async()=>{await crash();const timer=[...timers.values()].sort((a,b)=>a.at-b.at)[0];assert.ok(timer);delays.push(timer.ms);await advance(timer.at-now);};
  return {children,delays,timers,runtime,advance,crash,restart};
}

test('worker ready-then-crash loops back off exponentially instead of resetting on ready',async()=>{
  const f=await workerFixture();try{for(let i=0;i<5;i++)await f.restart();assert.deepEqual(f.delays,[500,1000,2000,4000,8000]);assert.equal(f.children.length,6);}finally{await f.runtime.close();}
});

test('worker backoff caps at 30 seconds while immediately crashing replacements remain unstable',async()=>{
  const f=await workerFixture();try{for(let i=0;i<9;i++)await f.restart();assert.deepEqual(f.delays,[500,1000,2000,4000,8000,16000,30000,30000,30000]);}finally{await f.runtime.close();}
});

test('a worker healthy for at least 60 seconds resets the next crash delay to 500ms',async()=>{
  const f=await workerFixture();try{for(let i=0;i<3;i++)await f.restart();await f.advance(60000);await f.restart();assert.deepEqual(f.delays,[500,1000,2000,500]);}finally{await f.runtime.close();}
});

test('closing during a scheduled restart prevents a replacement from spawning',async()=>{
  const f=await workerFixture();await f.crash();await f.runtime.close();await f.advance(30000);assert.equal(f.children.length,1);
});
