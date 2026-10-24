import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';

const root=process.env.GATEWAY_REPAIR_TEST_ROOT;
const moduleUrl=relative=>root?pathToFileURL(join(root,relative)).href:new URL('../'+relative,import.meta.url).href;
const {zcodeModels}=await import(moduleUrl('src/zcode-models.mjs'));
async function adapterFactory(t){
 try{return (await import(moduleUrl('bundle/index.mjs'))).createGatewayAdapter;}
 catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'){t.skip('Optional DSH peer packages absent');return;}throw error;}
}
const runtime={baseUrl:'http://127.0.0.1:1',key:'SAMPLE-offline-private-key'};
const catalog=()=>zcodeModels({}, {fetchBalance:async()=>({balances:[{available_units:1,capabilities:['model:glm-5.3','model:glm-5.3-flash']}]}),now:1000});
const entry=model=>({...model,id:'zcode-native/'+model.id,name:'ZCode · '+model.id,contextWindow:model.contextWindow??32768,maxTokens:model.maxTokens??8192,capabilities:{streaming:true,tools:model.tools===true,multimodal:model.multimodal===true}});

for(const id of ['glm-5.3','glm-5.3-flash'])test('actual DSH descriptor preserves verified '+id+' capacity for existing long session',async t=>{
 const create=await adapterFactory(t);if(!create)return;
 const models=(await catalog()).map(entry),before=JSON.stringify(models);
 const gateway=create({runtime,models});
 const resolved=await gateway.adapter.resolveModel('ai-credit','zcode-native/'+id);
 assert.equal(resolved.id,'zcode-native/'+id);
 assert.equal(resolved.context.contextWindow,1000000);
 assert.ok(173453<resolved.context.contextWindow,'reported session estimate must fit the verified capacity');
 assert.deepEqual(resolved.inputModalities,id==='glm-5.3-flash'?['text','image']:['text']);
 assert.equal(JSON.stringify(models),before,'descriptor construction must not rewrite catalog or messages');
});

test('DSH exact model refresh changes next call while an already prepared call retains its bound capacity',async t=>{
 const create=await adapterFactory(t);if(!create)return;
 const model=entry({id:'glm-5.3-flash',tools:true}),gateway=create({runtime,models:[model]});
 const prior=await gateway.adapter.prepareCall('ai-credit',model.id);
 assert.equal(prior.model.context.contextWindow,32768);
 const fresh=entry((await catalog()).find(m=>m.id==='glm-5.3-flash'));
 assert.equal(gateway.update([fresh]),true);
 assert.equal((await gateway.adapter.prepareCall('ai-credit',model.id)).model.context.contextWindow,1000000);
 assert.equal(prior.model.context.contextWindow,32768,'a refresh must not mutate an in-flight prepared call');
 assert.equal(model.contextWindow,32768,'caller-owned initial descriptor stays untouched');
 assert.equal(gateway.update([fresh]),false,'identical directory does not rebuild adapter');
});

test('DSH directory refresh coalesces one load and publishes new capacity without renaming model',async t=>{
 const create=await adapterFactory(t);if(!create)return;
 const {createModelRefresh}=await import(moduleUrl('bundle/model-refresh.mjs'));
 const old=[entry({id:'glm-5.3-flash',tools:true})],gateway=create({runtime,models:old});let loads=0;
 const fresh=(await catalog()).map(entry);
 const refresh=createModelRefresh({initialModels:old,load:async()=>{loads++;await new Promise(resolve=>setTimeout(resolve,5));return fresh;},update:models=>gateway.update(models)});
 try{assert.deepEqual(await Promise.all([refresh.refresh(),refresh.refresh(),refresh.refresh()]),[true,true,true]);assert.equal(loads,1);assert.equal((await gateway.adapter.resolveModel('ai-credit',old[0].id)).context.contextWindow,1000000);}
 finally{refresh.close();}
});

test('DSH refresh preserves unknown model conservative capacity and does not fabricate adjustable reasoning',async t=>{
 const create=await adapterFactory(t);if(!create)return;
 const gateway=create({runtime,models:[entry({id:'SAMPLE-future-model',tools:true})]});
 const resolved=await gateway.adapter.resolveModel('ai-credit','zcode-native/SAMPLE-future-model');
 assert.equal(resolved.context.contextWindow,32768);assert.equal(resolved.reasoning,undefined);
 assert.deepEqual(resolved.inputModalities,['text']);
});
