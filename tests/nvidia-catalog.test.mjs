import test from 'node:test';
import assert from 'node:assert/strict';
import {nvidiaCatalogSnapshot,parseNvidiaBuildCatalog,parseNvidiaBuildMetadata,mergeNvidiaCatalog,nvidiaFreeCatalog,NVIDIA_BUILD_CATALOG_URL} from '../src/nvidia-catalog.mjs';
import {nvidiaChat,nvidiaModels,nvidiaQuota} from '../src/nvidia.mjs';
const flight=obj=>'<script>self.__next_f.push('+JSON.stringify([1,'a:'+JSON.stringify(obj)+'\n'])+')</script>';
const resource=(name,{publisher='nvidia',chat=true,free=true}={})=>({name,displayName:name,description:'Official fixture',labels:[{key:'publisher',values:[publisher]},{key:'nimType',values:free?['Free Endpoint']:['Download Available']},{key:'playgroundType',values:chat?['chat']:[]}]});
const build=(rows,total=rows.length)=>flight({searchResult:{resultTotal:total,results:[{resources:rows},{resources:rows}]}});
const metadata=(id,context=262144,maximum=8192)=>flight({specifications:{contextLength:context,inputModalities:['Text','Image'],outputModalities:['Text']},modelCapability:{functionCalling:true},schema:{properties:{model:{type:'string',title:'Model',default:id},max_tokens:{type:'integer',title:'Max Tokens',default:1024,...(maximum===null?{}:{maximum})}}}});
const body={model:'nvidia/nemotron-3-super-120b-a12b',messages:[{role:'user',content:'hi'}],max_tokens:64};
const ok=()=>Response.json({choices:[{message:{content:'OK'},finish_reason:'stop'}]});

test('NVIDIA complete official snapshot classifies all 38 free endpoints, without equating API membership to free',()=>{
  const snapshot=nvidiaCatalogSnapshot();assert.equal(snapshot.models.length,38);assert.equal(snapshot.freeEndpointCount,38);
  assert.equal(new Set(snapshot.models.map(x=>x.id)).size,38);assert.equal(snapshot.models.filter(x=>x.chat).length,17);
  const rows=mergeNvidiaCatalog([...snapshot.models.filter(x=>!x.id.includes('ising-calibration-1-35b')).map(x=>({id:x.id})),{id:'unknown/not-free'}],snapshot);
  assert.equal(rows.filter(x=>x.importable).length,16);assert.equal(rows.filter(x=>x.importable&&x.tools).length,13);
  assert.equal(rows.find(x=>x.id==='unknown/not-free').freeEndpoint,false);
  for(const m of rows.filter(x=>x.importable)){assert.ok(m.contextWindow>0&&m.maxTokens>0);assert.equal(m.category,'chat');assert.equal(m.verification,'unverified');}
  for(const m of rows.filter(x=>!x.chat))assert.equal(m.callable,false);
  assert.equal(rows.find(x=>x.id==='nvidia/nemotron-3-embed-1b').category,'embedding');
  assert.equal(rows.find(x=>x.id==='nvidia/magpie-tts-zeroshot').category,'audio');
  assert.equal(rows.find(x=>x.id==='nvidia/cosmos3-nano').category,'video');
});
test('NVIDIA GLM Build slug maps to precise dotted model ID, configured output is never official maximum',()=>{
  const rows=nvidiaCatalogSnapshot().models;
  for(const id of ['z-ai/glm-5.3','z-ai/glm-5.3-flash']){const m=rows.find(x=>x.id===id);assert.equal(m.contextWindow,1048576);assert.equal(m.maxTokens,1024);assert.equal(m.officialMaxTokens,null);assert.equal(m.maxTokensSource,'configured_default');assert.equal(m.metadataStatus,'documented_context_configured_output');}
  const missing=rows.find(x=>x.id==='nvidia/ising-calibration-1-35b-a3b');assert.equal(missing.contextWindow,null);assert.equal(missing.maxTokens,null);
  rows[0].contextWindow=1;assert.notEqual(nvidiaCatalogSnapshot().models[0].contextWindow,1);
});
test('NVIDIA Build parser uses resolved official labels, deduplicates search groups and rejects incomplete pages',()=>{
  const rows=parseNvidiaBuildCatalog(build([resource('model-a'),resource('embed-b',{chat:false})]));assert.equal(rows.length,2);assert.equal(rows[0].chat,true);assert.equal(rows[1].category,'embedding');
  assert.throws(()=>parseNvidiaBuildCatalog(build([resource('a')],38)),{code:'nvidia_build_incomplete'});
  assert.throws(()=>parseNvidiaBuildCatalog(build([resource('paid',{free:false})])),{code:'nvidia_build_incomplete'});
  assert.throws(()=>parseNvidiaBuildCatalog('<html>changed</html>'),{code:'nvidia_build_schema'});
  assert.throws(()=>parseNvidiaBuildCatalog('x'.repeat(4*1024*1024+1)),{code:'nvidia_build_schema'});
});
test('NVIDIA new model metadata accepts exact schema output, distinguishes default cap, never creates 32K context',()=>{
  const row=parseNvidiaBuildCatalog(build([resource('new-model')]))[0];
  const exact=parseNvidiaBuildMetadata(metadata('nvidia/new.model'),row);assert.equal(exact.id,'nvidia/new.model');assert.equal(exact.contextWindow,262144);assert.equal(exact.officialMaxTokens,8192);assert.equal(exact.tools,true);assert.equal(exact.multimodal,true);
  const configured=parseNvidiaBuildMetadata(metadata('nvidia/new.model',1048576,null),row);assert.equal(configured.maxTokens,1024);assert.equal(configured.officialMaxTokens,null);assert.equal(configured.maxTokensSource,'configured_default');
  const unknown=parseNvidiaBuildMetadata(metadata('nvidia/new.model',null,null),row);assert.equal(unknown.contextWindow,null);assert.equal(mergeNvidiaCatalog([{id:unknown.id}],{models:[unknown]})[0].callable,false);
});
test('NVIDIA dynamically discovers an officially free chat model beyond snapshot and caches its verified metadata',async()=>{
  let calls=[];const buildFetchImpl=async(url,o)=>{calls.push(url);assert.equal(o.headers?.Authorization,undefined);return new Response(url===NVIDIA_BUILD_CATALOG_URL?build([resource('new-live')]):metadata('nvidia/new.live',524288,16384));};
  const catalog=await nvidiaFreeCatalog({now:1000000,force:true,buildFetchImpl});assert.equal(catalog.catalogSource,'official_build');assert.equal(catalog.models[0].id,'nvidia/new.live');
  await nvidiaFreeCatalog({now:1000001,buildFetchImpl});assert.equal(calls.length,2);
  const merged=mergeNvidiaCatalog([{id:'nvidia/new.live'}],catalog);assert.equal(merged[0].importable,true);
  const answer=await nvidiaChat({},{apiKey:'dynamic-model-fixture'},{...body,model:'nvidia/new.live'},undefined,{fetchImpl:async()=>ok()});assert.equal((await answer.response.json()).choices[0].message.content,'OK');
  const fallback=await nvidiaFreeCatalog({now:5000000,force:true,buildFetchImpl:async()=>{throw Error('offline')}});assert.equal(fallback.catalogSource,'cached_official_build');assert.equal(fallback.stale,true);assert.equal(fallback.models[0].id,'nvidia/new.live');
});
test('NVIDIA unknown/non-chat model and undeclared tools fail before network, configured GLM cap is enforced',async()=>{
  let calls=0;const options={fetchImpl:async()=>{calls++;return ok()}};
  for(const model of ['unknown/not-free','nvidia/nemotron-3-embed-1b','nvidia/ising-calibration-1-35b-a3b'])await assert.rejects(nvidiaChat({},{apiKey:'guard'},{...body,model},undefined,options),{code:'nvidia_model_metadata_unknown'});
  await assert.rejects(nvidiaChat({},{apiKey:'guard'},{...body,model:'meta/llama-3.2-11b-vision-instruct',tools:[{type:'function',function:{name:'a'}}]},undefined,options),{code:'nvidia_tools_not_supported'});
  await assert.rejects(nvidiaChat({},{apiKey:'guard'},{...body,model:'z-ai/glm-5.3',max_tokens:1025},undefined,options),{code:'nvidia_max_tokens_invalid'});assert.equal(calls,0);
});
test('NVIDIA auth history outlives five-minute quota observations; public directory cannot downgrade or repair auth',async()=>{
  const c={apiKey:'auth-history-fixture'},now=1000000000;
  await nvidiaChat({},c,body,undefined,{now,fetchImpl:async()=>new Response(JSON.stringify({choices:[]}),{headers:{'x-ratelimit-remaining-requests':'8'}})});
  let q=nvidiaQuota(c,{now:now+300001});assert.equal(q.credentialStatus,'authenticated');assert.equal(q.requestRemaining,null);assert.equal(q.source,'official_response_headers');assert.equal(q.observationStatus,'expired');assert.equal(q.lastAuthenticatedAt,new Date(now).toISOString());
  await nvidiaModels(c,{now:now+400000,fetchImpl:async()=>Response.json({data:[]})});q=nvidiaQuota(c,{now:now+400000});assert.equal(q.credentialStatus,'authenticated');assert.equal(q.lastDirectoryAt,new Date(now+400000).toISOString());assert.equal(q.lastAuthenticatedAt,new Date(now).toISOString());
  await assert.rejects(nvidiaChat({},c,body,undefined,{now:now+500000,fetchImpl:async()=>new Response('',{status:401})}));
  await nvidiaModels(c,{now:now+600000,fetchImpl:async()=>Response.json({data:[]})});q=nvidiaQuota(c,{now:now+600000});assert.equal(q.credentialStatus,'rejected');assert.equal(q.lastAuthErrorAt,new Date(now+500000).toISOString());assert.equal(q.lastAuthenticatedAt,new Date(now).toISOString());assert.equal(q.balanceApplicability,'not_applicable');
});
test('NVIDIA 429 timestamp and account cooldown remain visible independently of quota expiry',async()=>{
  const c={apiKey:'429-history-fixture'},now=2000000000;
  await assert.rejects(nvidiaChat({},c,body,undefined,{now,fetchImpl:async()=>new Response('',{status:429,headers:{'retry-after':'600'}})}));
  const q=nvidiaQuota(c,{now:now+300001});assert.equal(q.last429At,new Date(now).toISOString());assert.equal(q.cooldownUntil,new Date(now+600000).toISOString());assert.equal(q.requestRemaining,null);
  assert.equal(nvidiaQuota({apiKey:'other-429'}).last429At,null);
});
