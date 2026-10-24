import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=process.env.GATEWAY_REPAIR_TEST_ROOT,at=n=>root?pathToFileURL(path.resolve(root,n)).href:new URL('../'+n,import.meta.url).href;
const {anthropicChunks}=await import(at('src/anthropic.mjs'));
const {zcodeChat}=await import(at('src/zcode-models.mjs'));
const {normalizeChat,collectChat}=await import(at('src/openai.mjs'));
const {hash}=await import(at('src/util.mjs'));
const {gatewayFailureContract}=await import(at('src/client-contract.mjs'));
const {enrichGatewayFailure}=await import(at('bundle/retry-metadata.mjs'));
const credential={principal:'SAMPLE_PRINCIPAL',accessToken:'SAMPLE_TOKEN',identity:{deviceId:'SAMPLE_DEVICE'}};
const request={model:'glm-5.3-flash',messages:[{role:'user',content:'SAMPLE'}],max_tokens:4096,stream:true};
const sse=events=>new Response(events.map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const ledger=()=>{const values=new Map();return {get:k=>values.get(k),set:(k,v)=>values.set(k,v)};};
const key='proxy-block/zcode/'+hash(credential.principal);
async function consume(iterable){for await(const _ of iterable){}}
for(const code of [3012,'3012',3001])test('SSE business code '+code+' is not relabeled truncated_stream or leaked',async()=>{
 await assert.rejects(consume(anthropicChunks(sse([{code,msg:'SAMPLE_PRIVATE_UPSTREAM'}]))),e=>{
  assert.equal(e.code,'upstream_business_error');assert.equal(e.upstreamCode,Number(code));assert.doesNotMatch(e.message,/SAMPLE_PRIVATE/);return true;
 });
});
test('nested error business code survives normal Anthropic error framing',async()=>{
 await assert.rejects(consume(anthropicChunks(sse([{type:'error',error:{code:3012,message:'SAMPLE_PRIVATE'}}]))),e=>e.upstreamCode===3012&&e.code==='upstream_business_error'&&!e.message.includes('SAMPLE_PRIVATE'));
});
test('error-code strings are not reflected into public messages',async()=>{
 await assert.rejects(consume(anthropicChunks(sse([{code:'SAMPLE_SECRET',msg:'SAMPLE_PRIVATE'}]))),e=>e.code==='upstream_business_error'&&e.upstreamCode===undefined&&!e.message.includes('SAMPLE'));
});
for(const first of [false,true])test('HTTP200 stream3012 creates one real block, no follow-up fetch, rolePrelude='+first,async t=>{
 let hits=0;const l=ledger(),old=globalThis.fetch;globalThis.fetch=async()=>{hits++;return sse([...(first?[{type:'message_start',message:{usage:{input_tokens:1}}}]:[]),{code:3012,msg:'SAMPLE_PRIVATE'}]);};t.after(()=>{globalThis.fetch=old;});
 const {response}=await zcodeChat(credential,request,undefined,l);
 await assert.rejects(collectChat(normalizeChat(response,{model:'SAMPLE'})),e=>{
  assert.equal(e.code,'zcode_upstream_blocked');assert.equal(e.status,503);assert.equal(e.upstreamStatus,200);assert.equal(e.upstreamCode,3012);assert.equal(e.upstreamRequestSent,true);assert.equal(e.retryable,false);return true;
 });
 assert.equal(hits,1);assert.equal(l.get(key).http,200);const until=l.get(key).until;
 await assert.rejects(zcodeChat(credential,request,undefined,l),e=>e.code==='zcode_upstream_blocked'&&e.upstreamRequestSent===false&&e.upstreamStatus===200);
 assert.equal(hits,1);assert.equal(l.get(key).until,until);
});
test('non3012 stream error does not invent activity block',async t=>{
 const l=ledger(),old=globalThis.fetch;globalThis.fetch=async()=>sse([{code:3001,msg:'SAMPLE'}]);t.after(()=>{globalThis.fetch=old;});
 const {response}=await zcodeChat(credential,request,undefined,l);
 await assert.rejects(collectChat(normalizeChat(response)),e=>e.code==='upstream_business_error'&&e.upstreamCode===3001);
 assert.equal(l.get(key).until,0);
});
test('normal thinking/text and completion are unchanged',async()=>{
 const events=[{code:0,type:'message_start',message:{usage:{input_tokens:2}}},{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'SAMPLE_THINK'}},{type:'content_block_delta',delta:{type:'text_delta',text:'SAMPLE_OK'}},{type:'message_delta',usage:{output_tokens:4},delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
 const chunks=[];for await(const c of anthropicChunks(sse(events)))chunks.push(c);
 assert.equal(chunks.flatMap(c=>c.choices??[]).map(c=>c.delta.reasoning_content??'').join(''),'SAMPLE_THINK');
 assert.equal(chunks.flatMap(c=>c.choices??[]).map(c=>c.delta.content??'').join(''),'SAMPLE_OK');assert.deepEqual(chunks.at(-1).usage,{prompt_tokens:2,completion_tokens:4,total_tokens:6});
});
test('public3012 contract and DSH retain actual HTTP200 while terminal status stays503',()=>{
 const context={requestId:'aigw-00000000-0000-4000-8000-000000000000'},error={code:'zcode_upstream_blocked',upstreamStatus:200,upstreamRequestSent:true};
 const contract=gatewayFailureContract(error,context);assert.equal(contract.upstreamStatus,200);
 const f=enrichGatewayFailure({code:'SERVER',message:'503: '+JSON.stringify({error:{type:error.code,...error,...contract}})});
 assert.equal(f.upstreamStatus,200);assert.equal(f.status,503);assert.match(f.message,/不代表账号整体封禁/);assert.doesNotMatch(f.message,/完成官方验证/);
});
