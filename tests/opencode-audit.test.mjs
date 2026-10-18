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
const {testModel,startModelAudit,auditStageTimeout}=await load('src/model-audit.mjs');
const {modelDirectory}=await load('src/model-directory.mjs');
const {startServer}=await load('src/server.mjs');
function fixture(){
 let report;
 const calls=[];
 const s={calls,config:{value:{server:{host:'127.0.0.1',port:0},accounts:[{id:'SAMPLE'}],upstreams:[{id:'oc',kind:'opencode',accountId:'SAMPLE'}],routes:[{id:'off',enabled:false,targets:[{upstreamId:'oc',model:'one-free'}]}]}},
 keys:{apiKey:'SAMPLE-api',adminKey:'SAMPLE-admin'},
 ledger:{get:()=>report,set:(_,v)=>{report=structuredClone(v)}},
 router:{models:async()=>({data:[]})},
 platforms:{models:async()=>[{id:'one-free',tools:false,maxTokens:4096},{id:'two-free',tools:false,maxTokens:4096}],
 async chat(t,r){
  calls.push({t,r});
  assert.ok(!Object.hasOwn(r,'max_tokens'),'OpenCode does not accept explicit max_tokens');
  assert.ok(!Object.hasOwn(r,'tools'));
  return {response:new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'AUDIT_OK'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})};
 }}};
 return s;
}
const selection={scope:'models',items:[{upstreamId:'oc',model:'one-free'},{upstreamId:'oc',model:'two-free'}]};
test('OpenCode uses its supported plain-text contract in both ordinary and SSE probes',async()=>{
 const s=fixture(),row=await testModel(s,s.config.value.upstreams[0],{id:'one-free',tools:false,maxTokens:4096});
 assert.equal(s.calls.length,2);assert.ok(row.tests.slice(0,2).every(t=>t.ok));assert.equal(row.capabilityStatus,'chat_only');assert.equal(row.status,'partial');
 assert.equal(row.tests.filter(t=>t.status==='unsupported').length,2);
 assert.ok(s.calls.every(c=>c.t.upstreamId==='oc'&&c.t.model==='one-free'&&c.r.messages.length===1));
});
test('OpenCode has the measured 120-second native generation budget without changing other platforms',()=>{
 assert.equal(auditStageTimeout({kind:'opencode'}),120000);assert.equal(auditStageTimeout({kind:'workbuddy'}),45000);
});
test('precise model selection audits unimported models, preserves config and unrelated history',async()=>{
 const s=fixture(),before=structuredClone(s.config.value),old={upstreamId:'other',model:'keep',status:'passed',finishedAt:'original',tests:[]};
 s.ledger.set('',{results:[old]});const started=startModelAudit(s,selection);assert.equal(started.total,2);await s.auditPromise;
 const r=s.ledger.get();assert.equal(r.status,'completed');assert.equal(r.completed,2);assert.equal(r.results.length,3);
 assert.deepEqual(r.results.find(x=>x.model==='keep'),old);assert.deepEqual(s.config.value,before);assert.equal(s.calls.length,4);
 assert.ok(r.results.filter(x=>x.upstreamId==='oc').every(x=>x.capabilityStatus==='chat_only'&&x.finishedAt));
});
test('selection validation rejects malformed, duplicated, disabled or oversized requests before mutation',()=>{
 for(const items of [[],null,[{}],[{upstreamId:'oc',model:''}],[{upstreamId:'missing',model:'x'}],[selection.items[0],selection.items[0]],Array(501).fill(selection.items[0])]){
  const s=fixture();assert.throws(()=>startModelAudit(s,{scope:'models',items}),e=>e.status===400);assert.equal(s.ledger.get(),undefined);
 }
 const s=fixture();s.config.value.accounts[0].enabled=false;
 assert.throws(()=>startModelAudit(s,selection),e=>e.status===400);assert.equal(s.ledger.get(),undefined);
});
test('withdrawn model is marked unavailable from refreshed catalog, never fabricated as passed',async()=>{
 for(const model of ['absent-free','catalog']){const s=fixture();startModelAudit(s,{scope:'models',items:[{upstreamId:'oc',model}]});await s.auditPromise;
 assert.equal(s.ledger.get().results[0].status,'unavailable');assert.equal(s.calls.length,0);}
});
test('concurrent precise selection returns 409 and never silently queues a different target set',async()=>{
 const s=fixture();let release;s.platforms.models=()=>new Promise(r=>release=()=>{s.platforms.models=async()=>[{id:'one-free',tools:false}];r([{id:'one-free',tools:false}]);});
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
 const row=await testModel(s,s.config.value.upstreams[0],{id:'one-free',tools:false});
 assert.equal(row.status,'failed');assert.equal(row.capabilityStatus,'tools_undeclared');assert.equal(row.tests[0].error.code,'opencode_region_unavailable');
});
test.after(()=>rm(dir,{recursive:true,force:true}));
