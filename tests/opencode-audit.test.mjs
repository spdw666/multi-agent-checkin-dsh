import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'oc-audit-'));
process.env.AI_CREDIT_MEMORY=dir;
const root=process.env.AI_GATEWAY_TEST_ROOT??resolve(import.meta.dirname,'..');
const load=p=>import(pathToFileURL(join(root,p)).href);
const {testModel,startModelAudit,auditStageTimeout,AUDIT_STAGES}=await load('src/model-audit.mjs');
const {modelDirectory}=await load('src/model-directory.mjs');
const {startServer}=await load('src/server.mjs');
// 长文阶段要求 ≥600 字符且含独立的 200；fixture 必须真的写满，否则会把「凭证」判失败。
const longText='1 '+Array.from({length:199},(_,i)=>i+2).join(' ')+'\nThe list ends at 200.';
const model=id=>({id,tools:true,multimodal:true,maxTokens:32000,contextWindow:200000});
function fixture(){
 let report;
 const calls=[];
 const s={calls,config:{value:{server:{host:'127.0.0.1',port:0},accounts:[{id:'SAMPLE'}],upstreams:[{id:'oc',kind:'opencode',accountId:'SAMPLE'}],routes:[{id:'off',enabled:false,targets:[{upstreamId:'oc',model:'one-free'}]}]}},
 keys:{apiKey:'SAMPLE-api',adminKey:'SAMPLE-admin'},
 ledger:{get:()=>report,set:(_,v)=>{report=structuredClone(v)}},
 router:{models:async()=>({data:[]})},
 platforms:{models:async()=>[model('one-free'),model('two-free')],
 async chat(t,r){
  calls.push({t,r});
  // 会话桥没有原生生成参数通道：max_tokens 必须继续被剥掉；tools 现在走提示词契约，允许出现。
  assert.ok(!Object.hasOwn(r,'max_tokens'),'OpenCode bridge does not accept explicit max_tokens');
  const last=r.messages[r.messages.length-1],text=typeof last?.content==='string'?last.content:'';
  const wantTool=Array.isArray(r.tools)&&r.tool_choice!=='none';
  const delta=wantTool
   ?{reasoning_content:'fixture-reasoning',tool_calls:[{index:0,id:'c',type:'function',function:{name:'audit_add',arguments:'{"a":2,"b":3}'}}]}
   :{content:text.includes('integers from 1 to 200')?longText:r.messages.some(m=>m.role==='tool')?'5':'AUDIT_OK'};
  return {response:new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})};
 }}};
 return s;
}
const selection={scope:'models',items:[{upstreamId:'oc',model:'one-free'},{upstreamId:'oc',model:'two-free'}]};
test('OpenCode audits the full five stages through its session bridge contract',async()=>{
 const s=fixture(),row=await testModel(s,s.config.value.upstreams[0],model('one-free'));
 assert.equal(s.calls.length,AUDIT_STAGES.length);
 assert.deepEqual(row.tests.map(t=>t.stage),[...AUDIT_STAGES]);
 assert.ok(row.tests.every(t=>t.ok&&!t.status),JSON.stringify(row.tests));
 assert.equal(row.status,'passed');assert.equal(row.capabilityStatus,'full');
 assert.equal(row.tests.find(t=>t.stage==='output').ok,true);
 assert.equal(row.tests.find(t=>t.stage==='tools').tool,'audit_add');
 assert.ok(s.calls.every(c=>c.t.upstreamId==='oc'&&c.t.model==='one-free'));
 // 工具阶段带提示词契约，普通阶段保持单条纯文本——两条通道都不能带原生 max_tokens。
 assert.equal(s.calls.findIndex(c=>Array.isArray(c.r.tools)&&c.r.tool_choice!=='none'),AUDIT_STAGES.indexOf('tools'));
});
test('OpenCode keeps the measured 300-second generation budget without changing other platforms',()=>{
 assert.equal(auditStageTimeout({kind:'opencode'}),300000);assert.equal(auditStageTimeout({kind:'workbuddy'}),45000);
});
test('precise model selection audits unimported models, preserves config and unrelated history',async()=>{
 const s=fixture(),before=structuredClone(s.config.value),old={upstreamId:'other',model:'keep',status:'passed',finishedAt:'original',tests:[]};
 s.ledger.set('',{results:[old]});const started=startModelAudit(s,selection);assert.equal(started.total,2);await s.auditPromise;
 const r=s.ledger.get();assert.equal(r.status,'completed');assert.equal(r.completed,2);assert.equal(r.results.length,3);
 assert.deepEqual(r.results.find(x=>x.model==='keep'),old);assert.deepEqual(s.config.value,before);
 assert.equal(s.calls.length,AUDIT_STAGES.length*2);
 assert.ok(r.results.filter(x=>x.upstreamId==='oc').every(x=>x.capabilityStatus==='full'&&x.finishedAt));
});
test('selection validation rejects malformed, duplicated, disabled or oversized requests before mutation',()=>{
 for(const items of [[],null,[{}],[{upstreamId:'oc',model:''}],[{upstreamId:'missing',model:'x'}],[selection.items[0],selection.items[0]],Array(501).fill(selection.items[0])]){
  const s=fixture();assert.throws(()=>startModelAudit(s,{scope:'models',items}),e=>e.status===400);assert.equal(s.ledger.get(),undefined);
 }
 const s=fixture();s.config.value.accounts[0].enabled=false;
 assert.throws(()=>startModelAudit(s,selection),e=>e.status===400);assert.equal(s.ledger.get(),undefined);
});
test('withdrawn model is marked unavailable from refreshed catalog, never fabricated as passed',async()=>{
 for(const id of ['absent-free','catalog']){const s=fixture();startModelAudit(s,{scope:'models',items:[{upstreamId:'oc',model:id}]});await s.auditPromise;
 assert.equal(s.ledger.get().results[0].status,'unavailable');assert.equal(s.calls.length,0);}
});
test('concurrent precise selection returns 409 and never silently queues a different target set',async()=>{
 const s=fixture();let release;s.platforms.models=()=>new Promise(r=>release=()=>{s.platforms.models=async()=>[model('one-free')];r([model('one-free')]);});
 startModelAudit(s,{scope:'models',items:[selection.items[0]]});
 assert.throws(()=>startModelAudit(s,selection),e=>e.status===409&&e.code==='audit_in_progress');assert.equal(s.auditQueued,undefined);
 release();await s.auditPromise;
});
test('official audit HTTP endpoint persists model-scoped progress and results',async()=>{
 const s=fixture(),rt=await startServer(s);
 try{
  const res=await fetch(rt.baseUrl+'/admin/model-tests',{method:'POST',headers:{authorization:'Bearer SAMPLE-admin','content-type':'application/json'},body:JSON.stringify(selection)});
  assert.equal(res.status,202);await s.auditPromise;
  const report=await(await fetch(rt.baseUrl+'/admin/model-tests',{headers:{authorization:'Bearer SAMPLE-admin'}})).json();
  assert.equal(report.completed,2);assert.equal(report.status,'completed');
 }finally{await rt.close();}
});
test('directory displays verified chat from timestamped successful tests; failed/stale labels do not turn green',async()=>{
 const s=fixture();s.ledger.set('',{results:[
  {upstreamId:'oc',model:'one-free',status:'partial',capabilityStatus:'chat_only',finishedAt:'2026-10-18T00:00:00Z',tests:[{stage:'ordinary',ok:true},{stage:'stream',ok:true}]},
  {upstreamId:'oc',model:'two-free',status:'failed',capabilityStatus:'tools_undeclared',reason:'region rejected',tests:[{stage:'ordinary',ok:false}]}
 ]});
 const models=(await modelDirectory(s)).providers[0].models;
 assert.equal(models[0].status,'chat_verified');assert.equal(models[1].status,undefined);
 assert.equal(models[1].audit.status,'failed');assert.equal(models[0].imported,false);
});
test('real auth failure is recorded with original code and is never chat verified',async()=>{
 const s=fixture();s.platforms.chat=async()=>{throw Object.assign(Error('SAMPLE region unavailable'),{status:403,code:'opencode_region_unavailable'})};
 const row=await testModel(s,s.config.value.upstreams[0],model('one-free'));
 // capabilityStatus 描述「声明的能力是否完整」，不是结果；模型声明了工具所以是 full，
 // 认证失败必须由 status='failed' 表达，绝不能被当成 chat_verified 绿灯。
 assert.equal(row.status,'failed');assert.equal(row.capabilityStatus,'full');assert.equal(row.tests[0].error.code,'opencode_region_unavailable');
});
test.after(()=>rm(dir,{recursive:true,force:true}));
