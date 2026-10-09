import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const memory=await mkdtemp(join(tmpdir(),'retry-audit-'));process.env.AI_CREDIT_MEMORY=memory;
const {retryTargets,startModelAudit}=await import('../src/model-audit.mjs');
const {zcodeModels}=await import('../src/zcode-models.mjs');
function service(rows,{catalog,error}={}){
 let report={status:'completed',results:rows};let requests=0;
 return {config:{value:{accounts:[{id:'a'},{id:'disabled',enabled:false}],upstreams:[{id:'up',kind:'fixture',accountId:'a'},{id:'off',kind:'fixture',accountId:'disabled'}],routes:[{id:'unchanged',targets:[{upstreamId:'up',model:'good'}]}]}},ledger:{get:()=>structuredClone(report),set:(_k,v)=>{report=structuredClone(v)}},platforms:{models:async()=>{if(error)throw error;return catalog??[{id:'bad',tools:true}];},async chat(_t,r){requests++;const delta=r.tool_choice?.function?{tool_calls:[{index:0,id:'call',type:'function',function:{name:'audit_add',arguments:'{"a":2,"b":3}'}}]}:{content:r.messages.some(m=>m.role==='tool')?'5':'AUDIT_OK'};return {response:new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})};}},get requests(){return requests;}};
}
test('retryTargets chooses all non-passed statuses, deduplicates, skips disabled accounts',()=>{
 const s=service(['passed','failed','partial','uncertain','unavailable'].map((status,i)=>({upstreamId:'up',model:'m'+i,status})).concat([{upstreamId:'off',model:'x',status:'failed'},{upstreamId:'up',model:'m1',status:'failed'}]));
 assert.deepEqual(retryTargets(s).map(r=>r.model),['m1','m2','m3','m4']);
});
test('targeted retry preserves untouched history/routes and keeps the old failure as evidence',async()=>{
 const good={upstreamId:'up',model:'good',status:'passed',finishedAt:'old-time',tests:[]};const bad={upstreamId:'up',model:'bad',status:'partial',reason:'empty text',tests:[]};
 const s=service([good,bad]),routes=structuredClone(s.config.value.routes);startModelAudit(s,{scope:'retry'});const r=await s.auditPromise;
 assert.equal(r.total,1);assert.equal(r.completed,1);assert.equal(r.summary.passed,1);assert.equal(s.requests,4);
 assert.deepEqual(r.results.find(r=>r.model==='good'),good);assert.deepEqual(s.config.value.routes,routes);
 assert.equal(r.results.find(r=>r.model==='bad').previousAttempts[0].status,'partial');
});
test('empty retry is completed without invoking a previously passed model',async()=>{
 const s=service([{upstreamId:'up',model:'good',status:'passed'}]);startModelAudit(s,{scope:'retry'});const r=await s.auditPromise;assert.equal(r.total,0);assert.equal(r.status,'completed');assert.equal(s.requests,0);
});
test('missing wire remains unavailable without model substitution or chat submission',async()=>{
 const s=service([{upstreamId:'up',model:'bad',status:'unavailable'}],{catalog:[{id:'other',tools:true}]});startModelAudit(s,{scope:'retry'});const r=await s.auditPromise;assert.equal(r.summary.unavailable,1);assert.equal(s.requests,0);assert.equal(r.results[0].model,'bad');
});
test('recovered catalog failure is removed and its real catalog gets audited',async()=>{
 const s=service([{upstreamId:'up',model:'catalog',status:'uncertain'}]);startModelAudit(s,{scope:'retry'});const r=await s.auditPromise;assert.equal(r.results.some(r=>r.model==='catalog'),false);assert.equal(r.summary.passed,1);
});
test('catalog recovery plus a model failure runs each model once',async()=>{
 const s=service([{upstreamId:'up',model:'catalog',status:'uncertain'},{upstreamId:'up',model:'bad',status:'partial'}]);startModelAudit(s,{scope:'retry'});const r=await s.auditPromise;assert.equal(r.total,1);assert.equal(r.completed,1);assert.equal(s.requests,4);
});
test('retry scope is accepted by authenticated HTTP and rejects the public key',async()=>{
 const {startServer}=await import('../src/server.mjs');const s=service([{upstreamId:'up',model:'bad',status:'partial'}]);s.config.value.server={host:'127.0.0.1',port:0};s.keys={apiKey:'fixture-public',adminKey:'fixture-admin'};const rt=await startServer(s);
 try{const denied=await fetch(rt.baseUrl+'/admin/model-tests',{method:'POST',headers:{Authorization:'Bearer fixture-public','Content-Type':'application/json'},body:'{"scope":"retry"}'});assert.equal(denied.status,401);const accepted=await fetch(rt.baseUrl+'/admin/model-tests',{method:'POST',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json'},body:'{"scope":"retry"}'});assert.equal(accepted.status,202);assert.equal((await accepted.json()).scope,'retry');await s.auditPromise;}finally{await rt.close();}
});
test('ZCode no-active-entitlement is explicit and does not abort other upstream state',async()=>{
 const error=Object.assign(Error('no active entitlement'),{code:'zcode_no_active_entitlement',status:402});const s=service([{upstreamId:'up',model:'catalog',status:'uncertain'}],{error});startModelAudit(s,{scope:'retry'});const r=await s.auditPromise;assert.equal(r.status,'completed');assert.equal(r.summary.unavailable,1);assert.equal(r.results[0].error.code,'zcode_no_active_entitlement');assert.equal(r.results[0].previousAttempts.length,1);
});
test('ZCode empty plans/balances yields an account entitlement cause rather than vague empty catalog',async()=>{
 await assert.rejects(zcodeModels({},{fetchBalance:async()=>({plans:[],balances:[]})}),e=>e.code==='zcode_no_active_entitlement'&&e.status===402);
});
test('ZCode zero or expired grant never advertises a callable model',async()=>{
 await assert.rejects(zcodeModels({},{now:2000,fetchBalance:async()=>({balances:[{available_units:10,expires_at:1,capabilities:['model:expired']},{available_units:0,capabilities:['model:zero']}]})}),e=>e.status===402);
});
test('ZCode valid grant deduplicates model capabilities and ignores non-model/malformed entries',async()=>{
 const r=await zcodeModels({},{now:1000,fetchBalance:async()=>({balances:[{available_units:1,expires_at:2,capabilities:['model:glm-5.3-flash','model:glm-5.3-flash','other',null,'model:']}]})});assert.deepEqual(r.map(m=>m.id),['glm-5.3-flash']);assert.equal(r[0].transportVerified,true);
});
test('ZCode schema drift and absent model permission are distinguished from depleted quota',async()=>{
 await assert.rejects(zcodeModels({},{fetchBalance:async()=>({})}),e=>e.code==='zcode_balance_schema');
 await assert.rejects(zcodeModels({},{fetchBalance:async()=>({balances:[{available_units:1,capabilities:['other']}]})}),e=>e.code==='zcode_model_capability_missing');
});
test.after(async()=>{await rm(memory,{recursive:true,force:true});});
