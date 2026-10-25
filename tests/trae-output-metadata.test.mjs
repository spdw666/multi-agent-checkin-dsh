import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {mergeTraeModelSources}=await import(process.env.TEST_TRAE_BUNDLE?pathToFileURL(process.env.TEST_TRAE_BUNDLE).href:new URL('../vendor/trae-core.mjs',import.meta.url).href);

const remote=(id='SAMPLE',name='Sample')=>({id,name,contextWindow:200000,maxContextWindow:1000000,reasoningSupported:false});

test('Trae merge retains the matched wire output separately from remote context',()=>{
  const [model]=mergeTraeModelSources([remote()],[{id:'SAMPLE',name:'Sample',contextWindow:168000,maxTokens:32000,function:'solo_work_remote'}]);
  assert.equal(model.maxTokens,32000);
  assert.equal(model.contextWindow,200000);
  assert.equal(model.maxContextWindow,1000000);
  assert.equal(model.wireFunction,'solo_work_remote');
});

test('Trae display aliases keep exact wire identity and output declaration',()=>{
  const [model]=mergeTraeModelSources([remote('display-id','Shared name')],[{id:'wire-id',name:'Shared name',maxTokens:65536,function:'chat_v3'}]);
  assert.equal(model.maxTokens,65536);
  assert.equal(model.wireConfigName,'wire-id');
  assert.equal(model.wireFunction,'chat_v3');
});

test('Trae exact ID takes precedence over an unrelated same display name',()=>{
  const [model]=mergeTraeModelSources([remote('SAMPLE','Shared name')],[{id:'alias',name:'Shared name',maxTokens:64000},{id:'SAMPLE',name:'Other',maxTokens:32768}]);
  assert.equal(model.maxTokens,32768);
  assert.equal(model.wireConfigName,undefined);
});

test('Trae missing wire output stays unknown instead of inventing a default',()=>{
  const [model]=mergeTraeModelSources([remote()],[{id:'SAMPLE',name:'Sample',function:'solo_work_remote'}]);
  assert.equal(model.maxTokens,undefined);
});

test('Trae rejects invalid declared output integers',()=>{
  for(const maxTokens of [0,-1,3.5,NaN,Infinity,'32000',Number.MAX_SAFE_INTEGER+1]){
    const [model]=mergeTraeModelSources([remote()],[{id:'SAMPLE',name:'Sample',maxTokens}]);
    assert.equal(model.maxTokens,undefined,String(maxTokens));
  }
});

test('Trae display-only rows never inherit another model output or function',()=>{
  const [model]=mergeTraeModelSources([remote('remote-only','Remote only')],[{id:'other',name:'Other',maxTokens:128000,function:'chat_v3'}]);
  assert.equal(model.maxTokens,undefined);
  assert.equal(model.wireConfigName,undefined);
  assert.equal(model.wireFunction,undefined);
});

test('Trae wire-output merge preserves declared reasoning and effective credit rate',()=>{
  const [model]=mergeTraeModelSources([{...remote(),reasoningSupported:true,reasoning:{supported:['low','high','xhigh'],defaultEffort:'high'},creditMultiplier:0.8,multimodal:true}],[{id:'SAMPLE',name:'Sample',maxTokens:32000,creditMultiplier:0.08}]);
  assert.equal(model.maxTokens,32000);
  assert.equal(model.creditMultiplier,0.08);
  assert.equal(model.multimodal,true);
  assert.deepEqual(model.reasoningEfforts,{low:'light',high:'high',xhigh:'extra_high'});
});

test('Trae output metadata merge does not mutate caller-owned rows',()=>{
  const models=[{...remote(),unknown:{retained:true}}],wire=[{id:'SAMPLE',name:'Sample',maxTokens:32000,extra:{retained:true}}];
  const original=structuredClone({models,wire});
  assert.equal(mergeTraeModelSources(models,wire)[0].maxTokens,32000);
  assert.deepEqual({models,wire},original);
});
