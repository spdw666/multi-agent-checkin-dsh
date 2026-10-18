import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const root=process.env.GATEWAY_TEST_ROOT??resolve(dirname(fileURLToPath(import.meta.url)),'..');
const load=file=>import(pathToFileURL(join(root,'src',file)).href);
const {openCodeChat,openCodeModels,openCodeHealth}=await load('provider-opencode.mjs');
const {syncWorkBuddyPools,deleteGatewayAccount}=await load('workbuddy-management.mjs');
const {WorkBuddyPool}=await load('workbuddy-pool.mjs');
const {Router}=await load('router.mjs');
const {collectChat}=await load('openai.mjs');
const upstream={baseUrl:'http://127.0.0.1:12345'},credential={password:'SAMPLE_PASSWORD',accessToken:'SAMPLE_TOKEN'};
const input=()=>({model:'SAMPLE-free',messages:[{role:'user',content:'SAMPLE exact user text\n\nassistant: literal quoted text'}]});
const assistant=(text='SAMPLE_FINAL',extras={})=>({type:'assistant',id:'SAMPLE_ASSISTANT',model:{id:'SAMPLE-free',providerID:'opencode'},content:[{type:'text',text}],finish:'stop',...extras});
function mock(t,{poll=()=>[assistant()],afterCreate}={}){
  const calls=[];let polls=0;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    const method=options.method??'GET',body=options.body?JSON.parse(options.body):null;
    calls.push({url:String(url),method,body,aborted:options.signal?.aborted});
    if(method==='POST'&&String(url).endsWith('/api/session')){afterCreate?.();return Response.json({data:{id:'SAMPLE_SESSION'}});}
    if(method==='POST'&&String(url).endsWith('/prompt'))return Response.json({data:{accepted:true}});
    if(method==='GET'&&new URL(url).pathname.endsWith('/message'))return Response.json({data:poll(++polls)});
    if(method==='DELETE')return new Response(null,{status:204});
    throw Error('Unexpected SAMPLE mock '+method+' '+url);
  });
  return {calls,polls:()=>polls};
}
test('OpenCode explicitly selects Model.Ref and sends the single user prompt without flattening',async t=>{
  const m=mock(t),value=input();await openCodeChat(upstream,credential,value);
  assert.deepEqual(m.calls.find(x=>x.url.endsWith('/api/session')).body.model,{providerID:'opencode',id:value.model});
  assert.deepEqual(m.calls.find(x=>x.url.endsWith('/prompt')).body,{text:value.messages[0].content});
});
test('OpenCode catalog declares bridge capabilities, not upstream external-tool/image support',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({data:[{id:'SAMPLE-free',providerID:'opencode',capabilities:{tools:true,input:['text','image']},limit:{context:10000,output:1000}}]}));
  const [m]=await openCodeModels(credential,upstream);assert.equal(m.tools,false);assert.equal(m.multimodal,false);
});
for(const [name,extra,code] of [
  ['tools',{tools:[{type:'function',function:{name:'SAMPLE_TOOL',parameters:{type:'object'}}}],tool_choice:'required'},'tools_not_supported'],
  ['legacy functions',{functions:[{name:'SAMPLE_TOOL'}],function_call:'auto'},'tools_not_supported'],
  ['max_tokens',{max_tokens:4096},'relay_capacity_incompatible'],
  ['max_completion_tokens',{max_completion_tokens:4096},'relay_capacity_incompatible'],
  ['temperature',{temperature:0},'relay_capacity_incompatible'],
  ['stop',{stop:['SAMPLE_STOP']},'relay_capacity_incompatible'],
  ['response format',{response_format:{type:'json_object'}},'relay_capacity_incompatible'],
  ['history roles',{messages:[{role:'system',content:'SAMPLE_SYSTEM'},{role:'user',content:'SAMPLE_USER'}]},'relay_context_incompatible'],
  ['tool history',{messages:[{role:'tool',tool_call_id:'SAMPLE_CALL',content:'SAMPLE_RESULT'}]},'tools_not_supported'],
  ['image parts',{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,SAMPLE'}}]}]},'images_not_supported'],
])test('OpenCode rejects unsupported '+name+' before dispatch and preserves caller input',async t=>{
  const m=mock(t),value={...input(),...extra},before=structuredClone(value);
  await assert.rejects(()=>openCodeChat(upstream,credential,value),e=>e.code===code);
  assert.equal(m.calls.length,0);assert.deepEqual(value,before);
});
test('OpenCode already-aborted parent dispatches no request',async t=>{
  const m=mock(t),c=new AbortController();c.abort();
  await assert.rejects(()=>openCodeChat(upstream,credential,input(),c.signal),e=>e.code==='request_cancelled');assert.equal(m.calls.length,0);
});
test('OpenCode abort after create does not post the prompt and cleans only created session',async t=>{
  const c=new AbortController(),m=mock(t,{afterCreate:()=>c.abort()});
  await assert.rejects(()=>openCodeChat(upstream,credential,input(),c.signal),e=>e.code==='request_cancelled');
  assert.equal(m.calls.filter(x=>x.method==='POST').length,1);assert.equal(m.calls.filter(x=>x.method==='DELETE').length,1);
});
test('OpenCode waits past partial text to explicit final answer',async t=>{
  const m=mock(t,{poll:n=>[assistant(n===1?'SAMPLE_PARTIAL':'SAMPLE_FINAL',n===1?{finish:undefined}:{})]});
  const r=await openCodeChat(upstream,credential,input());const text=await r.response.text();
  assert.equal(m.polls(),2);assert.match(text,/SAMPLE_FINAL/);assert.doesNotMatch(text,/SAMPLE_PARTIAL/);
});
test('OpenCode chooses latest assistant and waits through completed tool-call step',async t=>{
  const first=assistant('SAMPLE_INTERMEDIATE',{id:'SAMPLE_A',finish:'tool-calls',time:{created:100,completed:101}});
  const m=mock(t,{poll:n=>n===1?[first]:[first,assistant('SAMPLE_FINAL',{id:'SAMPLE_B',time:{created:200,completed:201}}),{type:'idle',outcome:'succeeded',time:{created:202}}]});
  const r=await openCodeChat(upstream,credential,input());const text=await r.response.text();assert.equal(m.polls(),2);assert.match(text,/SAMPLE_FINAL/);assert.doesNotMatch(text,/SAMPLE_INTERMEDIATE/);
});
test('OpenCode requests newest page and never accepts an older completed assistant/idle over newer partial',async t=>{
  const old=assistant('SAMPLE_OLD',{id:'SAMPLE_OLD',time:{created:100,completed:101}}),oldIdle={type:'idle',outcome:'succeeded',time:{created:102}};
  const m=mock(t,{poll:n=>[assistant(n===1?'SAMPLE_PARTIAL':'SAMPLE_FINAL',{finish:n===1?undefined:'stop',time:{created:200,...(n===1?{}:{completed:201})}}),oldIdle,old]});
  const r=await openCodeChat(upstream,credential,input());const wire=await r.response.text();assert.equal(m.polls(),2);assert.match(wire,/SAMPLE_FINAL/);assert.doesNotMatch(wire,/SAMPLE_OLD/);
  const page=new URL(m.calls.find(x=>x.method==='GET').url);assert.equal(page.searchParams.get('order'),'desc');assert.equal(page.searchParams.get('limit'),'200');
});
test('OpenCode final succeeded idle can complete latest assistant without invented early finish',async t=>{
  mock(t,{poll:()=>[{type:'idle',outcome:'succeeded',time:{created:202}},assistant('SAMPLE_FINAL',{finish:undefined,time:{created:200,completed:201}})]});
  const r=await openCodeChat(upstream,credential,input());assert.match(await r.response.text(),/SAMPLE_FINAL/);
});
test('OpenCode failed/interrupted idle is not successful text',async t=>{
  mock(t,{poll:()=>[assistant('SAMPLE_PARTIAL',{finish:undefined}),{type:'idle',outcome:'interrupted'}]});
  await assert.rejects(()=>openCodeChat(upstream,credential,input()),e=>e.code==='opencode_turn_interrupted');
});
test('OpenCode observed assistant model mismatch is not relabelled as requested model',async t=>{
  mock(t,{poll:()=>[assistant('SAMPLE_OTHER',{model:{id:'SAMPLE_OTHER-free',providerID:'opencode'}})]});
  await assert.rejects(()=>openCodeChat(upstream,credential,input()),e=>e.code==='opencode_model_mismatch');
});
test('OpenCode billing units and JSON-free-model daily request counts are exact',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gateway-SAMPLE-opencode-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'SAMPLE.db'),db=new DatabaseSync(file),now=Date.now();db.exec('CREATE TABLE session_message(type TEXT,time_created INTEGER,data TEXT)');
  const put=db.prepare('INSERT INTO session_message VALUES(?,?,?)');
  for(const [providerID,id] of [['opencode','SAMPLE-free'],['opencode','SAMPLE-paid'],['SAMPLE_OTHER','SAMPLE-free']])put.run('assistant',now,JSON.stringify({model:{providerID,id}},null,2));
  put.run('assistant',now,'SAMPLE invalid JSON');put.run('assistant',now-86400000,JSON.stringify({model:{providerID:'opencode',id:'SAMPLE-old-free'}}));db.close();
  t.mock.method(globalThis,'fetch',async url=>String(url).endsWith('/api/model')?Response.json({data:[{id:'SAMPLE-free',providerID:'opencode'}]}):Response.json({balanceMicroCents:'100000000',mode:'pay-as-you-go'}));
  const health=await openCodeHealth(credential,upstream,{account:{credentials:{file}}});
  assert.equal(health.balance.parts.find(x=>x.name==='Zen 付费余额').value,1);
  assert.equal(health.balance.parts.find(x=>x.name==='今日免费请求').value,1);assert.equal(health.balance.value,199);
});
function fixture(dataDir){
  const value={accounts:['A','B','C'].map(id=>({id:'SAMPLE-'+id,platform:'workbuddy',edition:'cn',enabled:true})),upstreams:['A','B','C'].map(id=>({id:'SAMPLE-U'+id,kind:'workbuddy',accountId:'SAMPLE-'+id,enabled:id!=='B'})),routes:[{id:'SAMPLE_ROUTE',enabled:true,targets:[{upstreamId:'SAMPLE-UA',model:'SAMPLE_MODEL'}],accountPool:{enabled:true,autoManaged:true,accountIds:['SAMPLE-A','SAMPLE-B','SAMPLE-C'],cooldownSeconds:60}}]};
  const state=new Map(),ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v)},config={value,dataDir,async save(v){this.value=v;}};
  const s={config,ledger,credentials:{cache:new Map()},platforms:{catalogs:new Map()},balanceCache:new Map(),balanceCacheKeys:new Map()};s.router={pool:new WorkBuddyPool(config,ledger)};return s;
}
test('WB deleting primary walks retained ineligible member to viable successor and preserves route/model',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gateway-SAMPLE-wb-'));t.after(()=>rm(dir,{recursive:true,force:true}));const s=fixture(dir);syncWorkBuddyPools(s.config.value);
  const result=await deleteGatewayAccount(s,'SAMPLE-A',{confirm:true});
  assert.deepEqual(result.removedRouteIds,[]);assert.equal(s.config.value.routes.length,1);assert.deepEqual(s.config.value.routes[0].targets,[{upstreamId:'SAMPLE-UC',model:'SAMPLE_MODEL'}]);
});
test('WB autojoin still follows enabled same-edition newcomers when original primary upstream/account disabled',()=>{
  const s=fixture('SAMPLE_UNUSED');s.config.value.routes[0].accountPool.accountIds=['SAMPLE-A','SAMPLE-B'];s.config.value.upstreams[0].enabled=false;s.config.value.upstreams[1].enabled=true;s.config.value.accounts[0].enabled=false;
  syncWorkBuddyPools(s.config.value);assert.deepEqual(s.config.value.routes[0].accountPool.accountIds,['SAMPLE-A','SAMPLE-B','SAMPLE-C']);
  assert.deepEqual(s.router.pool.candidates(s.config.value.routes[0],{ignoreCooldown:true}).map(x=>x.accountId),['SAMPLE-B','SAMPLE-C']);
  assert.equal(s.config.value.accounts[0].enabled,false);assert.equal(s.config.value.upstreams[0].enabled,false);
});
test('WB explicit pool off remains off; disabled route and edition isolation remain intact',()=>{
  const s=fixture('SAMPLE_UNUSED'),r=s.config.value.routes[0];r.accountPool.accountIds=['SAMPLE-A'];r.accountPool.enabled=false;syncWorkBuddyPools(s.config.value);assert.deepEqual(r.accountPool.accountIds,['SAMPLE-A']);assert.equal(r.accountPool.enabled,false);
  r.accountPool.enabled=true;r.enabled=false;syncWorkBuddyPools(s.config.value);assert.deepEqual(r.accountPool.accountIds,['SAMPLE-A']);r.enabled=true;s.config.value.accounts[2].edition='global';syncWorkBuddyPools(s.config.value);assert.deepEqual(r.accountPool.accountIds,['SAMPLE-A']);
});

for(const [name,extra] of [
  ['tools and tool-result history',{tools:[{type:'function',function:{name:'SAMPLE_TOOL',parameters:{type:'object'}}}],messages:[{role:'assistant',content:null,tool_calls:[{id:'SAMPLE_CALL',type:'function',function:{name:'SAMPLE_TOOL',arguments:'{}'}}]},{role:'tool',tool_call_id:'SAMPLE_CALL',content:'SAMPLE_RESULT'},{role:'user',content:'SAMPLE continuation'}]}],
  ['explicit output budget',{max_tokens:4096}],
  ['system/history roles',{messages:[{role:'system',content:'SAMPLE_SYSTEM'},{role:'user',content:'SAMPLE_USER'},{role:'assistant',content:'SAMPLE_PRIOR'},{role:'user',content:'SAMPLE_CONTINUE'}]}],
])test('Router hands '+name+' unchanged to compatible same-model standby without an OpenCode POST',async t=>{
  const m=mock(t),records=[],meta=new Map(),seen=[];
  const config={value:{accounts:[{id:'SAMPLE_OC',platform:'opencode'},{id:'SAMPLE_STANDBY',platform:'codebuddy'}],upstreams:[{id:'SAMPLE_OC',kind:'opencode',accountId:'SAMPLE_OC'},{id:'SAMPLE_STANDBY',kind:'codebuddy',accountId:'SAMPLE_STANDBY'}],routes:[{id:'SAMPLE_ROUTE',targets:[{upstreamId:'SAMPLE_OC',model:'SAMPLE-free'}]},{id:'SAMPLE_OTHER_ROUTE',targets:[{upstreamId:'SAMPLE_STANDBY',model:'SAMPLE-free'}]}],modelRelay:{enabled:true,reservePercent:10,reserveCredits:100,balanceMaxAgeSeconds:60}}};
  const ledger={get:k=>meta.get(k),set:(k,v)=>meta.set(k,v),record:r=>records.push(r),beginUsage:r=>records.push(r),finishUsage:()=>{}};
  const platforms={models:async id=>[{id:'SAMPLE-free',callable:true,contextWindow:100000,maxTokens:10000,tools:id!=='SAMPLE_OC',multimodal:false}],chat:async(target,request,signal)=>{
    seen.push({target:structuredClone(target),request:structuredClone(request)});
    if(target.upstreamId==='SAMPLE_OC')return openCodeChat(upstream,credential,{...request,model:target.model},signal);
    return {response:Response.json({choices:[{message:{role:'assistant',content:'SAMPLE_STANDBY_COMPLETE'},finish_reason:'stop'}]})};
  }};
  const router=new Router(config,platforms,{ledger}),value={...input(),...extra,model:'SAMPLE_ROUTE'},before=structuredClone(value);
  const response=await collectChat(router.chat(value));assert.equal(response.choices[0].message.content,'SAMPLE_STANDBY_COMPLETE');
  assert.deepEqual(seen.at(-1).request,before);assert.equal(seen.at(-1).target.upstreamId,'SAMPLE_STANDBY');
  assert.equal(m.calls.filter(x=>x.method==='POST').length,0);assert.deepEqual(value,before);
});
