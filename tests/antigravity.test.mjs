import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {antigravityBase,antigravityRequest,antigravityModels,antigravityChat,localBridgeFetch} from '../src/antigravity.mjs';
import {validateConfig} from '../src/config.mjs';
import {normalizeBalance} from '../src/balances.mjs';
import {normalizeChat} from '../src/openai.mjs';
import {importModels} from '../src/model-directory.mjs';
const credential={accessToken:'fixture-only-bridge-key'};
test('Antigravity import uses its own platform name without changing existing routes',async()=>{
  let saved;const value={accounts:[],upstreams:[{id:'ag',kind:'antigravity'}],routes:[{id:'old',enabled:false,targets:[{upstreamId:'old',model:'old'}]}]};
  await importModels({config:{value,save:async v=>{saved=v;}},platforms:{models:async()=>[{id:'test',name:'Gemini test'}]}},[{upstreamId:'ag',model:'test'}]);
  assert.equal(saved.routes[1].name,'Antigravity · Gemini test');assert.equal(saved.routes[0].enabled,false);assert.equal(value.routes.length,1);
});
test('Antigravity is a dedicated loopback bridge, not an arbitrary relay',()=>{
  assert.equal(antigravityBase({}),'http://127.0.0.1:19431/v1');
  for(const url of ['https://example.com/v1','http://localhost:19431/v1','http://127.0.0.2/v1','http://user:pass@127.0.0.1/v1','http://127.0.0.1/v1?q=1','http://127.0.0.1/v1#key','http://127.0.0.1/admin','invalid'])assert.throws(()=>antigravityBase({sidecarBaseUrl:url}),e=>e.code==='invalid_antigravity_bridge');
});
test('Antigravity config accepts explicit account and rejects remote bridge and mismatched account',async()=>{
  const c=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url)));
  c.accounts.push({id:'ag',platform:'antigravity',credentials:{kind:'file',file:'./private/ag.json'}});
  c.upstreams.push({id:'ag',kind:'antigravity',accountId:'ag'});assert.equal(validateConfig(c),c);
  c.upstreams.at(-1).sidecarBaseUrl='https://example.com/v1';assert.throws(()=>validateConfig(c));
  delete c.upstreams.at(-1).sidecarBaseUrl;c.upstreams.at(-1).accountId=c.accounts[0].id;assert.throws(()=>validateConfig(c));
});
test('Antigravity catalog deduplicates identifiers without claiming live verification',async()=>{
  const rows=await antigravityModels({},credential,{fetchImpl:async()=>Response.json({data:[{id:'gemini-test',context_length:10000},{id:'gemini-test'},{id:''},{id:null},{name:'bad'}]})});
  assert.equal(rows.length,1);assert.equal(rows[0].verification,'unverified');assert.equal(rows[0].contextWindow,10000);assert.equal(rows[0].multimodal,false);
});
test('Antigravity catalog handles malformed JSON and invalid list',async()=>{
  for(const data of [{models:[]},{data:'bad'}])await assert.rejects(antigravityModels({},credential,{fetchImpl:async()=>Response.json(data)}),e=>e.code==='invalid_upstream_response');
  await assert.rejects(antigravityModels({},credential,{fetchImpl:async()=>new Response('bad json')}),e=>e.code==='invalid_upstream_response');
});
test('Antigravity cold-start readiness retries only empty GET catalogs',async()=>{
  let calls=0;const rows=await antigravityModels({},credential,{fetchImpl:async(url,options)=>{assert.equal(options.method,'GET');return Response.json({data:++calls===1?[]:[{id:'ready-model'}]});}});
  assert.equal(calls,2);assert.equal(rows[0].id,'ready-model');
});
test('Antigravity region rejection explicitly requests US-node retry',async()=>{
  await assert.rejects(antigravityRequest({},credential,'/models',{fetchImpl:async()=>Response.json({error:{message:'User location is not supported for the API use.'}},{status:400})}),e=>e.code==='antigravity_region_unsupported'&&e.status===400&&e.message.includes('美国节点'));
});
test('Antigravity auth, quota and generic errors never reflect credentials or provider details',async()=>{
  for(const status of [301,401,403,429,500])await assert.rejects(antigravityRequest({},credential,'/models',{fetchImpl:async()=>Response.json({error:{message:'private@example.com secret-value '+credential.accessToken}},{status})}),e=>!e.message.includes('private@')&&!e.message.includes('secret-value')&&!e.message.includes(credential.accessToken)&&e.status===(status>=400?status:502));
});
test('Antigravity bridge connection and abort errors are distinct and sanitized',async()=>{
  await assert.rejects(antigravityRequest({},credential,'/models',{fetchImpl:async()=>{throw new Error('private detail');}}),e=>e.code==='antigravity_bridge_unavailable');
  await assert.rejects(antigravityRequest({},credential,'/models',{signal:AbortSignal.abort(),fetchImpl:async()=>{throw Error('aborted');}}),e=>e.code==='request_cancelled');
  await assert.rejects(antigravityRequest({},credential,'/models',{fetchImpl:async()=>{throw Object.assign(Error('private detail'),{code:'ETIMEDOUT'});}}),e=>e.code==='antigravity_timeout'&&e.status===504);
});
test('Antigravity unknown quota is not reported as zero or daily checkin',()=>{
  const b=normalizeBalance('antigravity',{status:'bridge_ready',models:12});assert.equal(b.value,null);assert.equal(b.checkedIn,false);assert.equal(b.unit,'模型配额');assert.match(b.note,/实际调用/);
});
test('Antigravity catalog tolerates null entries and bounds large JSON',async()=>{
  const rows=await antigravityModels({},credential,{fetchImpl:async()=>Response.json({data:[null,{id:'one'}]})});assert.equal(rows.length,1);
  const images=await antigravityModels({},credential,{fetchImpl:async()=>Response.json({data:[{id:'gemini-flash-image'}]})});assert.equal(images[0].callable,false);
  await assert.rejects(antigravityModels({},credential,{fetchImpl:async()=>new Response(' '.repeat(4*1024*1024+1))}),e=>e.code==='antigravity_response_too_large');
});
test('Antigravity auto-start refuses executable hash drift before spawn',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ag-bridge-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const exe=join(dir,'fixture.bin');await writeFile(exe,'non-executable fixture');
  const upstream={sidecar:{autoStart:true,executable:exe,configFile:join(dir,'absent.json'),sha256:'0'.repeat(64)}};
  await assert.rejects(antigravityRequest(upstream,credential,'/models',{config:{path:x=>x},fetchImpl:async()=>{throw Object.assign(Error('refused'),{code:'ECONNREFUSED'});}}),e=>e.code==='antigravity_bridge_hash_changed');
});
test('Antigravity region message variants have the same actionable code',async()=>{
  for(const message of ['REGION not supported','not available in your country'])await assert.rejects(antigravityRequest({},credential,'/models',{fetchImpl:async()=>Response.json({error:{message}},{status:400})}),e=>e.code==='antigravity_region_unsupported');
});
test('Antigravity loopback HTTP passes SSE tools and usage without proxy or redirects',async t=>{
  let seen;const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;seen={auth:req.headers.authorization,path:req.url,body:JSON.parse(body)};res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_test',type:'function',function:{name:'probe',arguments:'{"value":1}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}})+'\n\ndata: [DONE]\n\n');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const input={model:'gemini-test',messages:[{role:'user',content:'test'}],stream:true,reasoning_effort:null,tools:[{type:'function',function:{name:'probe',parameters:{type:'object'}}}]};
  const {response}=await antigravityChat({sidecarBaseUrl:`http://127.0.0.1:${server.address().port}/v1`},credential,input);
  const chunks=[];for await(const c of normalizeChat(response,{model:'ag/test'}))chunks.push(c);
  assert.equal(seen.auth,'Bearer '+credential.accessToken);assert.equal(seen.path,'/v1/chat/completions');assert.equal('reasoning_effort' in seen.body,false);assert.equal(input.reasoning_effort,null);assert.ok(chunks.some(c=>c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name==='probe'));assert.ok(chunks.some(c=>c.usage?.total_tokens===5));
});
test('Antigravity transport does not follow redirect locations',async t=>{
  const server=http.createServer((req,res)=>{res.writeHead(302,{Location:'http://example.com'});res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const response=await localBridgeFetch(`http://127.0.0.1:${server.address().port}/v1/models`);assert.equal(response.status,302);await response.text();
});
