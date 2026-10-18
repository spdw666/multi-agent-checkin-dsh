import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.GATEWAY_TEST_ROOT??resolve(import.meta.dirname,'..');
const {buildActivityContext,captureRequestContext}=await import(pathToFileURL(resolve(root,'src/activity-context.mjs')));
const now=Date.parse('2026-10-18T06:00:00Z');
const context=captureRequestContext({messages:[{role:'user',content:'SAMPLE_DATA'}]});
const row=(x={})=>({id:1,requestId:'SAMPLE-request',attempt:1,source:'dsh',startedAt:'2026-10-18T05:00:00Z',finishedAt:'2026-10-18T05:00:01Z',status:'completed',platform:'SAMPLE',model:'SAMPLE-model',routeId:'SAMPLE-route',context,totalTokens:3,...x});
const build=records=>buildActivityContext({ledger:{usage:()=>({records}),records:()=>[]}},{now});
test('14 skipped candidates are not 14 calls, relays, unknown usages, or repeated input',()=>{
 const skipped=Array.from({length:14},(_,i)=>row({id:i+1,attempt:i+1,status:'skipped',dispatched:false,dispatchCount:0,totalTokens:null,error:{code:'relay_capacity_incompatible'},requestOutcome:{schema:1,state:'ongoing',candidateCount:15,skippedCount:i+1,attemptCount:0,dispatchCount:0}}));
 const result=build([...skipped,row({id:15,attempt:15,dispatched:true,dispatchCount:1,requestOutcome:{schema:1,state:'completed',candidateCount:15,skippedCount:14,attemptCount:1,dispatchCount:1}})]);
 assert.equal(result.kpis.requests,1);assert.equal(result.kpis.attempts,1);assert.equal(result.kpis.dispatches,1);assert.equal(result.kpis.skippedCandidates,14);assert.equal(result.kpis.relays,0);assert.equal(result.kpis.unknownTokenAttempts,0);assert.equal(result.kpis.success,1);
 assert.equal(result.kpis.estimatedInputTokens,3);assert.equal(result.composition.user.chars,11);
 assert.equal(result.items[0].candidateCount,15);assert.equal(result.items[0].attempts[0].status,'skipped');
});
test('all skipped request is one unavailable final request, zero upstream attempts',()=>{
 const result=build([row({status:'skipped',dispatched:false,dispatchCount:0,totalTokens:null,requestOutcome:{schema:1,state:'failed',candidateCount:1,skippedCount:1,attemptCount:0,dispatchCount:0}})]);
 assert.equal(result.kpis.requests,1);assert.equal(result.kpis.failed,1);assert.equal(result.kpis.attempts,0);assert.equal(result.kpis.skippedCandidates,1);assert.equal(result.kpis.dispatches,0);assert.equal(result.kpis.unknownTokenAttempts,0);
});
test('same candidate transport retry is two dispatches but one candidate attempt',()=>{
 const result=build([row({dispatched:true,dispatchCount:2,requestOutcome:{schema:1,state:'completed',candidateCount:1,skippedCount:0,attemptCount:1,dispatchCount:2}})]);
 assert.equal(result.kpis.attempts,1);assert.equal(result.kpis.dispatches,2);assert.equal(result.kpis.relays,0);
});
test('legacy uninstrumented failures and completions remain compatible',()=>{
 const result=build([row({status:'failed',totalTokens:null}),row({id:2,attempt:2})]);
 assert.equal(result.kpis.attempts,2);assert.equal(result.kpis.dispatches,2);assert.equal(result.kpis.skippedCandidates,0);assert.equal(result.kpis.success,1);assert.equal(result.kpis.failed,0);assert.equal(result.kpis.relays,1);
});
test('outcome and failure metadata project only a bounded whitelist',()=>{
 const result=build([row({dispatched:true,dispatchCount:1,requestOutcome:{schema:1,state:'completed',candidateCount:1,skippedCount:0,attemptCount:1,dispatchCount:1,body:'SAMPLE_MUST_NOT_LEAK'},relayFailure:{root:{code:'provider_timeout',status:504,platform:'loomy',body:'SAMPLE_MUST_NOT_LEAK'},last:{code:'tools_not_supported',status:400},raw:'SAMPLE_MUST_NOT_LEAK'}})]);
 assert.equal(result.items[0].dispatchCount,1);assert.ok(!JSON.stringify(result).includes('SAMPLE_MUST_NOT_LEAK'));
});
test('request-only terminal is one failed request with no fabricated upstream candidate',()=>{
 const result=build([row({rowType:'request_outcome',attempt:0,status:'failed',platform:'',dispatched:false,dispatchCount:0,totalTokens:null,requestOutcome:{schema:1,state:'failed',candidateCount:0,skippedCount:0,attemptCount:0,dispatchCount:0}})]);
 assert.equal(result.kpis.requests,1);assert.equal(result.kpis.failed,1);assert.equal(result.kpis.attempts,0);assert.equal(result.kpis.dispatches,0);assert.equal(result.kpis.relays,0);assert.equal(result.items[0].candidateCount,0);assert.deepEqual(result.items[0].attempts,[]);
});
