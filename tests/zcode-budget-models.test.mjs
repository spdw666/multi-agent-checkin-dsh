import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=process.env.GATEWAY_REPAIR_TEST_ROOT;
const modulePath=name=>root?pathToFileURL(resolve(root,name)).href:new URL('../'+name,import.meta.url).href;
const {zcodeModels}=await import(modulePath('src/zcode-models.mjs'));
const {Router}=await import(modulePath('src/router.mjs'));
const {gatewayRequestPolicy}=await import(modulePath('bundle/request-policy.mjs'));
const ids=['glm-5.3','glm-5.3-flash'];
async function rows(){
  const catalog=await zcodeModels({},{now:1000,fetchBalance:async()=>({balances:[{available_units:1,expires_at:2,capabilities:ids.map(id=>'model:'+id)}]})});
  const config={value:{accounts:[{id:'a',platform:'zcode'}],upstreams:[{id:'z',kind:'zcode',accountId:'a'}],routes:ids.map((id,i)=>({id:i?'arbitrary-flash-alias':'zcode-native/'+id,targets:[{upstreamId:'z',model:id}]})),modelRelay:{enabled:false}}};
  return (await new Router(config,{models:async()=>catalog}).models()).data;
}
for(const index of [0,1])test(ids[index]+' exports a formal provider default through exact and arbitrary route aliases',async()=>{
  const m=(await rows())[index];assert.equal(m.maxTokens,128000);assert.equal(m.defaultMaxTokens,128000);assert.equal(m.defaultMaxTokensSource,'official_docs_snapshot_2026-10-23');assert.equal(gatewayRequestPolicy({},[m]).configuredMaxTokens.get(m.id),128000);
});
test('other live model ceilings provide only their own route default',()=>{
  assert.equal(gatewayRequestPolicy({},[{id:'other',maxTokens:131072}]).configuredMaxTokens.get('other'),131072);
});
test('a declared default is bounded by its positive catalog ceiling without mutating metadata',()=>{
  const m={id:'sample',maxTokens:1000,defaultMaxTokens:2000},before=JSON.stringify(m);assert.equal(gatewayRequestPolicy({},[m]).configuredMaxTokens.get('sample'),1000);assert.equal(JSON.stringify(m),before);
  for(const defaultMaxTokens of [null,0,-1,'128000',NaN,Infinity])assert.equal(gatewayRequestPolicy({},[{...m,defaultMaxTokens}]).configuredMaxTokens.size,0);
});
test('explicit runtime defaults remain opt-in and per-model bounded',async()=>{
  const m=(await rows())[1];assert.equal(gatewayRequestPolicy({maxOutputTokens:4096},[m]).configuredMaxTokens.get(m.id),4096);assert.equal(gatewayRequestPolicy({maxOutputTokens:200000},[m]).configuredMaxTokens.get(m.id),128000);
});
async function adapter(t,models,runtime){
  let createGatewayAdapter;try{({createGatewayAdapter}=await import(modulePath('bundle/index.mjs')))}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'){t.skip('Optional DSH peer packages absent');return}throw e}
  return createGatewayAdapter({runtime:{baseUrl:'http://127.0.0.1:1',key:'SAMPLE-loopback',...runtime},models});
}
test('installed PiAiAdapter exposes the negotiated default to resolveModel and prepareCall',async t=>{
  const models=await rows(),g=await adapter(t,models);if(!g)return;
  for(const m of models){assert.equal((await g.adapter.resolveModel('ai-credit',m.id)).defaultMaxTokens,128000);assert.equal((await g.adapter.prepareCall('ai-credit',m.id)).model.defaultMaxTokens,128000);}
});
test('refresh swaps independent profile/provider snapshots and preserves already-prepared capacities',async t=>{
  const models=await rows(),g=await adapter(t,models);if(!g)return;const id=models[1].id;
  const prepared=await g.adapter.prepareCall('ai-credit',id),oldProfiles=g.adapter.config.profiles(),old=oldProfiles.get('ai-credit');
  assert.equal(g.update(models.map(m=>({...m,maxTokens:64000,defaultMaxTokens:64000}))),true);
  assert.equal(prepared.model.defaultMaxTokens,128000);assert.equal(old.configuredMaxTokens.get(id),128000);assert.notEqual(g.adapter.config.profiles().get('ai-credit'),old);
  assert.equal((await g.adapter.resolveModel('ai-credit',id)).defaultMaxTokens,64000);assert.equal(old.piProvider.getModels().find(m=>m.id===id).maxTokens,128000);
  assert.equal(g.update(models.map(m=>({...m,maxTokens:64000,defaultMaxTokens:64000}))),false);
});
test('refresh uses each remaining live ceiling and removes a deleted model default',async t=>{
  const models=await rows(),g=await adapter(t,models);if(!g)return;const id=models[1].id;
  g.update(models.map(m=>{const n={...m};delete n.defaultMaxTokens;delete n.defaultMaxTokensSource;return n}));assert.equal((await g.adapter.resolveModel('ai-credit',id)).defaultMaxTokens,128000);
  g.update(models.slice(0,1));await assert.rejects(g.adapter.resolveModel('ai-credit',id));
});
async function wireFixture(t){
  const captured=[],capturedHeaders=[],server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;captured.push(JSON.parse(body));capturedHeaders.push({...req.headers});res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"id":"SAMPLE","object":"chat.completion.chunk","model":"SAMPLE","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const models=await rows(),g=await adapter(t,models,{baseUrl:'http://127.0.0.1:'+server.address().port});if(!g)return;
  const m=models[1],messages=[{role:'user',content:[{type:'text',text:'SAMPLE '.repeat(101000)}]}],tools=Array.from({length:331},(_,i)=>({name:'sample_tool_'+i,description:'SAMPLE '+i,parameters:{type:'object',properties:{value:{type:'string'}},additionalProperties:false}}));
  const invoke=async(stream,extra={})=>{const chunks=[];for await(const chunk of stream({provider:'ai-credit',model:m.id,messages,tools,...extra}))chunks.push(chunk);assert.equal(chunks.at(-1)?.type,'finish');assert.notEqual(chunks.at(-1)?.reason?.kind,'error');return captured.at(-1)};
  return {g,messages,tools,captured,capturedHeaders,invoke,id:m.id};
}
test('actual installed PiAi serialization with 331 tools and 707KB text uses 128000 when caller omitted budget',async t=>{
  const f=await wireFixture(t);if(!f)return;const before=JSON.stringify([f.messages,f.tools]);const prepared=await f.g.adapter.prepareCall('ai-credit',f.id);
  assert.equal(prepared.model.defaultMaxTokens,128000);const body=await f.invoke(prepared.stream);assert.equal(body.max_completion_tokens,128000);assert.equal(body.tools.length,331);assert.ok(JSON.stringify(body).length>714000);assert.equal(JSON.stringify([f.messages,f.tools]),before);
});
test('actual installed PiAi preserves explicit 131072 caller budget instead of silently trimming it',async t=>{
  const f=await wireFixture(t);if(!f)return;const body=await f.invoke(options=>f.g.adapter.stream(options),{maxTokens:131072});assert.equal(body.max_completion_tokens,131072);assert.equal(body.tools.length,331);assert.equal(f.capturedHeaders.at(-1)['x-bili-plugin-max-output'],'128000');
});
test('already prepared request uses old provider output ceiling while next call gets refreshed default',async t=>{
  const f=await wireFixture(t);if(!f)return;const old=await f.g.adapter.prepareCall('ai-credit',f.id),models=await rows();f.g.update(models.map(m=>({...m,maxTokens:64000,defaultMaxTokens:64000})));
  assert.equal((await f.invoke(old.stream)).max_completion_tokens,128000);assert.equal(f.capturedHeaders.at(-1)['x-bili-plugin-max-output'],'128000');const next=await f.g.adapter.prepareCall('ai-credit',f.id);assert.equal(next.model.defaultMaxTokens,64000);assert.equal((await f.invoke(next.stream)).max_completion_tokens,64000);assert.equal(f.capturedHeaders.at(-1)['x-bili-plugin-max-output'],'64000');
});
test('cold first SDK request carries authoritative model-specific default before any runtime-info lookup',async t=>{
  const f=await wireFixture(t);if(!f)return;const body=await f.invoke(options=>f.g.adapter.stream(options));assert.equal(body.max_completion_tokens,128000);
  const headers=f.capturedHeaders[0];assert.equal(headers['x-bili-plugin-max-output'],'128000');assert.equal(headers['x-bili-plugin-model'],f.id);assert.equal(headers['x-ai-credit-source'],'dsh');
});
test('declared context and live ceiling negotiate a default; explicit runtime uses the same formal map',async t=>{
  const m={id:'SAMPLE-unknown',name:'SAMPLE',contextWindow:1000000,maxTokens:128000,capabilities:{multimodal:false}},g=await adapter(t,[m]);if(!g)return;
  const headers=g.adapter.config.profiles().get('ai-credit').piProvider.getModels()[0].headers;assert.equal(headers['x-bili-plugin-max-output'],'128000');assert.equal(headers['x-bili-plugin-model'],m.id);assert.equal(headers['x-bili-plugin-context-window'],String(m.contextWindow));
  const explicit=await adapter(t,[m],{maxOutputTokens:4096});const profile=explicit.adapter.config.profiles().get('ai-credit');assert.equal(profile.piProvider.getModels()[0].headers['x-bili-plugin-max-output'],String(profile.configuredMaxTokens.get(m.id)));
});
