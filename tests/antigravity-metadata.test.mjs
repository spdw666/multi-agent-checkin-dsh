import test from 'node:test';
import assert from 'node:assert/strict';
import {antigravityModels} from '../src/antigravity.mjs';
import {Router} from '../src/router.mjs';

const expected={
  'claude-opus-4-6-thinking':[200000,64000],
  'claude-sonnet-4-6':[200000,64000],
  'gemini-3.6-flash-high':[1048576,65536],
  'gemini-3.7-flash-high':[1048576,65536],
  'gemini-3.8-flash-high':[1048576,65536],
  'gemini-3-flash':[1048576,65536],
  'gemini-pro-agent':[1048576,65535],
  'gemini-3.1-pro-low':[1048576,65535],
  'gpt-oss-120b-medium':[114000,32768],
  'gemini-3.1-flash-lite':[1048576,65535],
  'gemini-3.5-flash-lite':[1048576,65535],
};
function catalog(data){return antigravityModels({}, {accessToken:'fixture-local-key'}, {fetchImpl:async()=>Response.json({data})});}

test('Antigravity bare bridge IDs receive exact versioned limits for all eleven deployed chat models',async()=>{
  const rows=await catalog(Object.keys(expected).map(id=>({id})));
  assert.equal(rows.length,11);
  for(const row of rows){
    assert.deepEqual([row.contextWindow,row.maxTokens],expected[row.id],row.id);
    assert.notEqual(row.callable,false);
    assert.equal(row.verification,'unverified');
    assert.equal(row.multimodal,false);
    assert.match(row.limitsSource.contextWindow,/CLIProxyAPI.*d318bcc3/);
  }
});

test('Antigravity valid bridge metadata wins over the pinned fallback independently per field',async()=>{
  const rows=await catalog([
    {id:'gemini-3.8-flash-high',context_length:800000,max_completion_tokens:32000},
    {id:'claude-sonnet-4-6',context_length:250000},
    {id:'gpt-oss-120b-medium',max_completion_tokens:16000},
    {id:'new-model',context_length:120000,max_completion_tokens:8192},
    {id:'new-alias-fields',contextWindow:100000,maxTokens:4096},
  ]);
  assert.deepEqual(rows.map(m=>[m.contextWindow,m.maxTokens]),[[800000,32000],[250000,64000],[114000,16000],[120000,8192],[100000,4096]]);
  assert.equal(rows[0].limitsSource.contextWindow,'bridge.context_length');
  assert.equal(rows[0].limitsSource.maxTokens,'bridge.max_completion_tokens');
  assert.ok(rows.every(m=>m.callable!==false));
});

test('Antigravity invalid sizes never become limits; known exact IDs use pinned limits',async()=>{
  for(const value of [null,0,-1,1.5,'1048576',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    const [row]=await catalog([{id:'gemini-3.8-flash-high',context_length:value,max_completion_tokens:value}]);
    assert.equal(row.contextWindow,1048576);
    assert.equal(row.maxTokens,65536);
  }
});

test('Antigravity missing or contradictory limits keep unknown models visible for diagnosis but unpublished',async()=>{
  const rows=await catalog([
    {id:'gemini-future-flash'},
    {id:'unknown-context-only',context_length:100000},
    {id:'unknown-output-only',max_completion_tokens:8192},
    {id:'unknown-conflict',context_length:8192,max_completion_tokens:9000},
    {id:'gemini-3.8-flash-high',context_length:32000},
  ]);
  for(const row of rows){assert.equal(row.callable,false);assert.equal(row.metadataStatus,'limits_unknown');assert.match(row.unavailableReason,/容量/);}
  assert.equal(rows[0].contextWindow,undefined);
  const config={value:{upstreams:[{id:'a',kind:'antigravity'}],routes:rows.map(m=>({id:m.id,targets:[{upstreamId:'a',model:m.id}]}))}};
  assert.deepEqual((await new Router(config,{models:async()=>rows}).models()).data,[]);
});

test('Antigravity image generation remains disabled even with valid limits',async()=>{
  const [row]=await catalog([{id:'gemini-3.1-flash-image',context_length:1048576,max_completion_tokens:65536}]);
  assert.equal(row.callable,false);assert.match(row.unavailableReason,/图片生成/);
});

test('Antigravity recorded 49678-input successful response no longer crosses the published pi-ai window',async()=>{
  const id='gemini-3.8-flash-high',rows=await catalog([{id}]);
  const config={value:{upstreams:[{id:'antigravity-main',kind:'antigravity'}],routes:[{id:`antigravity-main/${id}`,targets:[{upstreamId:'antigravity-main',model:id}]}]}};
  const before=structuredClone(config.value),[published]=(await new Router(config,{models:async()=>rows}).models()).data;
  // Portable fixture of pi-ai's successful-stop overflow branch, including cached input.
  // The installed pi-ai implementation is also exercised in the deployment verification.
  const message={stopReason:'stop',usage:{input:49678,cacheRead:0,output:62}};
  const overflows=window=>message.stopReason==='stop'&&message.usage.input+message.usage.cacheRead>window;
  assert.equal(overflows(32768),true);
  assert.equal(overflows(published.contextWindow),false);
  assert.equal(published.contextWindow,1048576);
  assert.equal(published.maxTokens,65536);
  assert.deepEqual(config.value,before);
});
