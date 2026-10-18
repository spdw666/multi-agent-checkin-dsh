import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequestDiagnostics,diagnoseRequestRows} from '../src/request-diagnostics.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.mjs';
import {UsageAttempt} from '../src/usage.mjs';

const now=Date.parse('2026-10-18T12:00:00.000Z');
const row=(over={})=>({id:1,requestId:'req-sample',attempt:1,startedAt:'2026-10-18T11:00:00.000Z',finishedAt:'2026-10-18T11:00:01.000Z',durationMs:1000,firstTokenMs:300,routeId:'public/model',model:'model-v1',platform:'workbuddy',accountId:'SAMPLE_ACCOUNT_123',source:'dsh-desktop',status:'completed',dispatched:true,dispatchCount:1,...over});
const fixture=(rows,config={})=>({config:{value:config},ledger:{usage:({beforeId=0,limit=500,from='',to=''})=>{const filtered=[...rows].filter(r=>(!beforeId||r.id<beforeId)&&(!from||r.startedAt>=from)&&(!to||r.startedAt<=to)).sort((a,b)=>b.id-a.id);return {records:filtered.slice(0,limit),nextBeforeId:filtered.length>limit?filtered[limit-1].id:null};}}});
test('diagnostics distinguish candidates, actual dispatch and client completion',()=>{
  const r=buildRequestDiagnostics(fixture([
    row({id:1,attempt:1,status:'failed',error:{code:'provider_timeout',status:504},requestOutcome:{schema:1,state:'ongoing'}}),
    row({id:2,attempt:2,status:'skipped',dispatched:false,dispatchCount:0,candidatePlan:{state:'skipped',reasonCode:'tools_not_supported'},error:{code:'tools_not_supported',status:400},requestOutcome:{schema:1,state:'ongoing'}}),
    row({id:3,attempt:3,platform:'codebuddy',status:'completed',finishedAt:'2026-10-18T11:00:03.000Z',requestOutcome:{schema:1,state:'completed'},relayFailure:{root:{code:'provider_timeout',status:504,platform:'workbuddy'},last:{code:'tools_not_supported',status:400}},context:{toolNames:['write_file'],fileActivity:{write:9}}}),
  ]),{now}).items[0];
  assert.equal(r.candidateCount,3);assert.equal(r.skippedCount,1);assert.equal(r.attemptCount,2);assert.equal(r.dispatchCount,2);
  assert.equal(r.actualSupplies.length,2);assert.equal(r.status,'success');assert.equal(r.firstReason.code,'provider_timeout');assert.equal(r.lastReason.code,'tools_not_supported');
  assert.equal(r.completion.gatewayRequest,'success');assert.equal(r.completion.toolExecution,'unknown');assert.equal(r.completion.clientTurn,'unknown');
  assert.equal(r.timing.totalMs,3000);assert.equal(r.timing.firstTokenMs,null);assert.equal(r.timing.connectMs,null);assert.equal(r.timing.generationMs,null);
});
test('pre-dispatch outcome is not counted as an upstream candidate or attempt',()=>{
  const r=diagnoseRequestRows([row({rowType:'request_outcome',status:'failed',dispatched:false,error:{code:'same_model_rate_limited',status:429},requestOutcome:{schema:1,state:'failed'}})]);
  assert.equal(r.candidateCount,0);assert.equal(r.attemptCount,0);assert.equal(r.dispatchCount,0);assert.deepEqual(r.actualSupplies,[]);assert.equal(r.firstReason.code,'same_model_rate_limited');
});
test('projection exports only whitelisted metadata and pseudonymous account references',()=>{
  const config={accounts:[{id:'SAMPLE_ACCOUNT_123'}]};
  const r=buildRequestDiagnostics(fixture([row({routeId:'SAMPLE_ACCOUNT_123/model',prompt:'LEAK_PROMPT',password:'LEAK_SECRET',profile:'LEAK_PROFILE',accountLabel:'LEAK_LABEL',error:{code:'provider_timeout',status:504,message:'LEAK_ERROR'},transportFailure:{phase:'response_header',code:'ETIMEDOUT',timeoutOrigin:'header_deadline',url:'LEAK_URL'},candidatePlan:{state:'skipped',reasonCode:'tools_not_supported',body:'LEAK_BODY',capabilities:{tools:false,multimodal:true,contextWindow:10000,outputCapacity:1000,token:'LEAK_TOKEN'}},requestContract:{schema:1,messageCount:2,toolCount:1,serializedBytes:100,outputBudget:50,contextEstimate:{method:'utf8_bytes_plus_overhead',upperBound:5000,prompt:'LEAK_CONTEXT'},messages:[{content:'LEAK_MESSAGES'}]}})],config),{now});
  const text=JSON.stringify(r);assert.ok(!text.includes('LEAK'));assert.ok(!text.includes('SAMPLE_ACCOUNT_123'));assert.match(r.items[0].actualSupplies[0].accountRef,/^account-[0-9a-f]{10}$/);
  assert.equal(r.items[0].candidates[0].transportFailure.phase,'response_header');assert.equal(r.items[0].contract.contextEstimate.tokenCount,null);
});
test('unsafe identifiers and unsafe typed codes remain null',()=>{
  const r=diagnoseRequestRows([row({model:'C:/Users/private/file.txt',routeId:'https://HOST/PAYLOAD',error:{code:'Bearer_TOKEN',status:999},candidatePlan:{state:'arbitrary',reasonCode:'secret-key'},transportFailure:{phase:'LEAK',code:'LEAK',timeoutOrigin:'LEAK'}})]);
  assert.equal(r.model,null);assert.equal(r.requestedRoute,null);assert.equal(r.firstReason,null);assert.equal(r.candidates[0].plan.state,'unknown');assert.equal(r.candidates[0].reasonCode,null);assert.deepEqual(r.candidates[0].transportFailure,{phase:null,code:null,timeoutOrigin:null});
});
test('list filters and direct lookup retain explicit metadata-only semantics',()=>{
  const rows=[row(),row({id:2,requestId:'req-hermes',source:'hermes',model:'other-model',routeId:'other-route'}),row({id:3,requestId:'req-old',startedAt:'2026-08-01T10:00:00Z'})];
  assert.equal(buildRequestDiagnostics(fixture(rows),{now,source:'hermes'}).items[0].requestId,'req-hermes');
  assert.equal(buildRequestDiagnostics(fixture(rows),{now,model:'other-route'}).items[0].requestId,'req-hermes');
  assert.equal(buildRequestDiagnostics(fixture(rows),{now,search:'workbuddy'}).items.length,2);
  assert.equal(buildRequestDiagnostics(fixture(rows),{now,requestId:'req-old'}).request.requestId,'req-old');
  assert.equal(buildRequestDiagnostics(fixture(rows),{now,requestId:'req-missing'}).request,null);
  assert.equal(buildRequestDiagnostics(fixture(rows),{now,range:'all'}).items.length,3);
});
test('pagination handles more than 500 ledger rows and stops a stuck cursor',()=>{
  const rows=Array.from({length:550},(_,i)=>row({id:i+1,requestId:'req-'+i}));const r=buildRequestDiagnostics(fixture(rows),{now,limit:'200'});
  assert.equal(r.coverage.matchingItems,550);assert.equal(r.items.length,200);assert.equal(r.coverage.usageRowsScanned,550);
  let calls=0;const broken={ledger:{usage:()=>{calls++;return {records:[row()],nextBeforeId:1};}}};
  assert.equal(buildRequestDiagnostics(broken,{now}).coverage.truncated,true);assert.equal(calls,2);
  calls=0;const cycle={ledger:{usage:()=>({records:[row()],nextBeforeId:++calls===1?1:calls===2?2:1})}};assert.equal(buildRequestDiagnostics(cycle,{now}).coverage.truncated,true);assert.equal(calls,3);
});
test('running requests preserve unknown finish and duration, never infer completion from tool context',()=>{
  const r=diagnoseRequestRows([row({status:'running',finishedAt:undefined,firstTokenMs:null,requestOutcome:{schema:1,state:'ongoing'},context:{toolResults:{chars:100}}})]);
  assert.equal(r.status,'running');assert.equal(r.finishedAt,null);assert.equal(r.timing.totalMs,null);assert.equal(r.completion.toolExecution,'unknown');
});
test('strict filters reject malformed input instead of silently coercing',()=>{
  for(const options of [{range:'2d'},{source:'OTHER'},{limit:0},{limit:201},{limit:'1.5'},{limit:true},{requestId:'C:/Users/SAMPLE'},{search:{}},{now:'invalid'}])assert.throws(()=>buildRequestDiagnostics(fixture([]),options),e=>e.status===400);
});
test('original HTTP 429 / 6004 long-window metadata remains typed in the root diagnosis',()=>{
  const r=diagnoseRequestRows([row({status:'failed',error:{code:'provider_rate_limited',status:429,message:'LEAK_MESSAGE'},rateLimit:{upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,retryAfterSeconds:7200,retryAfterSource:'official_body',body:'LEAK_BODY'},relayFailure:{root:{code:'provider_rate_limited',status:429,platform:'workbuddy'},last:{code:'relay_context_incompatible',status:503}}})]);
  assert.equal(r.firstReason.upstreamCode,6004);assert.equal(r.firstReason.rateLimitKind,'long_window');assert.equal(r.firstReason.rateLimitRetryable,false);assert.equal(r.firstReason.retryAfterSource,'official_body');assert.equal(r.candidates[0].rateLimit.upstreamCode,6004);assert.ok(!JSON.stringify(r).includes('LEAK'));
});
test('real SQLite UsageAttempt rows project counts without exposing prompt or identities',()=>{
  const dir=mkdtempSync(join(tmpdir(),'gateway-request-diagnostics-')),ledger=new Ledger(dir);
  try{
    const config={accounts:[{id:'SAMPLE_ACCOUNT_123'}],upstreams:[{id:'up',kind:'workbuddy',accountId:'SAMPLE_ACCOUNT_123'}]};
    const attempt=new UsageAttempt(ledger,config,{model:'public/model',messages:[{role:'user',content:'NEVER_EXPORT_PROMPT'}]},{upstreamId:'up',model:'model-v1'},{requestId:'sqlite-sample',source:'hermes'});
    attempt.dispatched();attempt.chunk({choices:[{delta:{content:'SAMPLE'}}],usage:{total_tokens:10}});attempt.finish('completed');attempt.finalizeRequest({schema:1,state:'completed'});
    const r=buildRequestDiagnostics({ledger,config:{value:config}},{now:Date.now()+100}).items[0];
    assert.equal(r.requestId,'sqlite-sample');assert.equal(r.dispatchCount,1);assert.equal(r.candidates[0].knownTokens,10);assert.equal(r.completion.clientTurn,'unknown');assert.ok(!JSON.stringify(r).includes('NEVER_EXPORT'));assert.ok(!JSON.stringify(r).includes('SAMPLE_ACCOUNT_123'));
  }finally{ledger.close();if(!dir.startsWith(join(tmpdir(),'gateway-request-diagnostics-')))throw Error('unexpected test target');rmSync(dir,{recursive:true,force:true});}
});
test('observed output timing splits only compatible same-attempt duration counters',()=>{
  const r=diagnoseRequestRows([row({durationMs:1234,firstTokenMs:234})]);
  assert.equal(r.timing.preFirstOutputMs,234);assert.equal(r.timing.postFirstOutputMs,1000);assert.equal(r.timing.outputTimingScope,'single_dispatched_attempt');
  assert.equal(r.candidates[0].preFirstOutputMs,234);assert.equal(r.candidates[0].postFirstOutputMs,1000);assert.equal(r.timing.connectMs,null);assert.equal(r.timing.tlsMs,null);assert.equal(r.timing.generationMs,null);
  for(const over of [{durationMs:null},{firstTokenMs:null},{firstTokenMs:1235},{firstTokenMs:-1},{durationMs:NaN}]){const unknown=diagnoseRequestRows([row({durationMs:1234,firstTokenMs:234,...over})]);assert.equal(unknown.timing.preFirstOutputMs,null);assert.equal(unknown.timing.postFirstOutputMs,null);}
  const zero=diagnoseRequestRows([row({durationMs:0,firstTokenMs:0})]);assert.equal(zero.timing.preFirstOutputMs,0);assert.equal(zero.timing.postFirstOutputMs,0);
});
test('multi-dispatch output timing remains per candidate rather than fabricated whole-request split',()=>{
  const r=diagnoseRequestRows([row({status:'failed',durationMs:500,firstTokenMs:100}),row({id:2,attempt:2,durationMs:1000,firstTokenMs:200})]);
  assert.equal(r.timing.preFirstOutputMs,null);assert.equal(r.timing.postFirstOutputMs,null);assert.equal(r.timing.outputTimingScope,'per_candidate_only');
  assert.equal(r.candidates[0].preFirstOutputMs,100);assert.equal(r.candidates[0].postFirstOutputMs,400);assert.equal(r.candidates[1].preFirstOutputMs,200);assert.equal(r.candidates[1].postFirstOutputMs,800);
});
test('machine-code-shaped account UID and opaque credential values are rejected, never masked as error categories',()=>{
  const id='ACCT20261018ABC',uid='UID778899XYZ',credential='OpaqueValue884422AB',config={accounts:[{id,uid,credentials:{apiKey:credential}}]};
  for(const value of [id,uid,credential,'provider_'+id,'upstream_'+credential]){
    const r=diagnoseRequestRows([row({accountId:id,platform:value,error:{code:value,status:500},candidatePlan:{state:'skipped',reasonCode:value},relayFailure:{root:{code:value,status:500,platform:value},last:{code:value,status:500}}})],config),text=JSON.stringify(r);
    assert.equal(r.candidates[0].reasonCode,null);assert.equal(r.firstReason,null);assert.equal(r.lastReason,null);assert.equal(r.candidates[0].platform,'unknown');for(const raw of [id,uid,credential])assert.ok(!text.includes(raw));
  }
  const s=fixture([row({error:{code:credential,status:500}})]);s.keys={apiKey:credential};assert.equal(buildRequestDiagnostics(s,{now}).items[0].firstReason,null);
});
