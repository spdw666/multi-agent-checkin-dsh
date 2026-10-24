import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=process.env.GATEWAY_REPAIR_TEST_ROOT;
const modulePath=name=>root?pathToFileURL(resolve(root,'src',name)).href:new URL('../src/'+name,import.meta.url).href;
const {zcodeModels}=await import(modulePath('zcode-models.mjs'));
const {Router}=await import(modulePath('router.mjs'));
const {RequestPlan}=await import(modulePath('request-plan.mjs'));
const ids=['glm-5.3','glm-5.3-flash'];
const catalog=async(modelIds=ids)=>zcodeModels({},{now:1000,fetchBalance:async()=>({balances:[{available_units:1,expires_at:2,capabilities:modelIds.map(id=>'model:'+id)}]})});
async function directory(rows){
  const config={value:{accounts:[{id:'a',platform:'zcode'}],upstreams:[{id:'z',kind:'zcode',accountId:'a'}],routes:rows.map(m=>({id:'zcode-native/'+m.id,targets:[{upstreamId:'z',model:m.id}]})),modelRelay:{enabled:false}}};
  return (await new Router(config,{models:async()=>rows}).models()).data;
}
for(const id of ids){
  test(id+' declares the official decimal 1M context and 128K output, not the generic 32K fallback',async()=>{
    const [m]=await catalog([id]);assert.equal(m.contextWindow,1000000);assert.equal(m.maxTokens,128000);assert.equal(m.officialMaxTokens,128000);
    assert.equal(m.contextWindowSource,'official_docs_snapshot_2026-10-23');assert.equal(m.maxTokensSource,'official_docs_snapshot_2026-10-23');
    assert.ok(m.metadataSources.includes(id==='glm-5.3'?'https://docs.z.ai/guides/llm/glm-5.3':'https://docs.z.ai/guides/vlm/glm-5.3-flash'));
  });
  test(id+' public directory preserves its verified capacity',async()=>{
    const [m]=await directory(await catalog([id]));assert.equal(m.contextWindow,1000000);assert.equal(m.maxTokens,128000);
  });
  test(id+' keeps the screenshot-sized 173453 token estimate below its real published window without trimming',async()=>{
    const [m]=await directory(await catalog([id]));const request={model:m.id,messages:[{role:'user',content:'a'.repeat(173453)}],max_tokens:4096,stream:true};
    const saved=JSON.stringify(request),plan=new RequestPlan(request,{upstreams:[]});assert.ok(173453+request.max_tokens<m.contextWindow);assert.ok(plan.contract.contextEstimate.upperBound<m.contextWindow);assert.equal(plan.inspect((await catalog([id]))[0]).error,null);assert.equal(JSON.stringify(request),saved);
  });
}
test('GLM-5.3 remains text-only while the exact Flash model advertises image support',async()=>{
  const rows=await catalog();assert.equal(rows[0].multimodal,false);assert.equal(rows[1].multimodal,true);assert.equal(rows[1].tools,true);
  const published=await directory(rows);assert.equal(published[0].capabilities.multimodal,false);assert.equal(published[1].capabilities.multimodal,true);
});
for(const id of ['glm-5.3-flashx','glm-5.3-flash-unknown','glm-5.3-unknown','other-model'])test(id+' does not inherit unverified capacity from an adjacent name',async()=>{
  const [m]=await catalog([id]);assert.equal(m.contextWindow,undefined);assert.equal(m.maxTokens,undefined);assert.equal(m.officialMaxTokens,undefined);
  assert.equal(m.metadataSources,undefined);const [published]=await directory([m]);assert.equal(published.contextWindow,32768);assert.equal(published.maxTokens,4096);
});
test('an undeclared or expired entitlement is never created by the documentation supplement',async()=>{
  await assert.rejects(zcodeModels({},{now:2000,fetchBalance:async()=>({balances:[{available_units:1,expires_at:1,capabilities:ids.map(id=>'model:'+id)}]})}),e=>e.code==='zcode_no_active_entitlement');
  assert.deepEqual((await catalog(['other-model'])).map(m=>m.id),['other-model']);
});
test('one caller cannot mutate metadata reused by a later catalogue read',async()=>{
  const [first]=await catalog();assert.ok(Array.isArray(first.metadataSources));first.metadataSources.push('SAMPLE');first.contextWindow=1;const [next]=await catalog();assert.equal(next.contextWindow,1000000);assert.equal(next.metadataSources.includes('SAMPLE'),false);
});
test('reasoning controls advertise only the exact verified native Anthropic effort mapping',async()=>{
  for(const m of await catalog()){assert.deepEqual(m.reasoning.supportedEfforts,['low','high','max']);assert.deepEqual(m.reasoningEfforts,{low:'low',high:'high',max:'max'});}
});
