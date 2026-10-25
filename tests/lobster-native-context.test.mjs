import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lobsterModels, LOBSTER_SERVER_ORIGIN} from '../src/provider-lobster.mjs';
const expected = {'MiniMax-M2.7':204800,'qwen3.6-plus':1000000,'kimi-k2.6':262144,'kimi-k2.5':262144,'glm-5.1':202800,'glm-5':202800};
async function catalog(rows, options = {}) {
  let reads = 0;
  const models = await lobsterModels({accessToken:'SAMPLE'}, {...options,fetchImpl:async (url, init) => {
    reads++;
    assert.equal(String(url), LOBSTER_SERVER_ORIGIN + '/api/models/available');
    assert.equal(init?.method ?? 'GET', 'GET');
    return Response.json({code:0,data:rows});
  }});
  assert.equal(reads, 1);
  return models;
}
const entry = (modelId, extra = {}) => ({modelId,provider:'LobsterAI',contextWindow:null,accessible:true,supportsToolCalling:null,supportsImage:false,...extra});
for (const [id, value] of Object.entries(expected)) {
  test(`native exact server registry context: ${id}`,async()=>{
    const [m]=await catalog([entry(id)]);
    assert.equal(m.contextWindow,value);
    assert.equal(m.officialContextWindow,null);
    assert.equal(m.contextWindowSource,'native_client_registry');
    assert.equal(m.contextWindowEvidence.nativeVersion,'2026.10.23');
    assert.equal(m.contextWindowEvidence.artifactSha256,'9e64675081a5e9c689b35672ee864ab878df4c88c3bb177ea08dab11b028a7f6');
    assert.equal(m.contextWindowEvidence.memberSha256,'9050623fcc7ac0a3eba6ac246fa502e56a8fd69a621e873d28d76d25a2534643');
    assert.equal(m.callable,true);
    assert.equal(m.tools,false);
    assert.equal(m.toolsField,'unproven');
    assert.equal(m.maxTokens,65536);
    assert.equal(m.maxTokensSource,'configured_default');
    assert.equal(m.officialMaxTokens,null);
    assert.equal(m.verification,'official_catalog'); // roster provenance remains compatible
  });
  test(`valid official capacity precedes native registry: ${id}`,async()=>{
    const [m]=await catalog([entry(id,{contextWindow:345678})]);
    assert.equal(m.contextWindow,345678);
    assert.equal(m.officialContextWindow,345678);
    assert.equal(m.contextWindowSource,'official_catalog');
    assert.equal(m.contextWindowEvidence,undefined);
  });
}
for(const id of ['qwen3.5-plus-2026-04-20','glm-5v-turbo','doubao-seed-2-0-code-preview-260215']) test(`generic selector never grants capacity: ${id}`,async()=>{
  const [m]=await catalog([entry(id,{contextWindows:[{id:'model-default',contextWindow:200000}],presetContextWindows:{balanced:400000}})]);
  // The exact Qwen snapshot now has a separately sourced manufacturer declaration.
  // The generic selector still grants no capacity; the declared 1M does not
  // borrow its 200k selector or the unrelated 400k preset.
  if (id === 'qwen3.5-plus-2026-04-20') {
    assert.equal(m.contextWindow,1000000);assert.equal(m.officialContextWindow,null);
    assert.equal(m.contextWindowSource,'manufacturer_documentation');assert.equal(m.callable,true);
    assert.equal(m.callableReason,null);assert.equal(m.contextWindowEvidence.declaredContextWindow,1000000);
  } else {
    assert.equal(m.contextWindow,null);assert.equal(m.officialContextWindow,null);
    assert.equal(m.contextWindowSource,null);assert.equal(m.callable,false);
    assert.equal(m.callableReason,'context_window_unknown');assert.equal(m.contextWindowEvidence,undefined);
  }
});
for(const value of [0,-1,1.5,'204800',false,Number.MAX_SAFE_INTEGER+1])test(`explicit invalid context has no fallback: ${JSON.stringify(value)}`,async()=>{
  const [m]=await catalog([entry('MiniMax-M2.7',{contextWindow:value})]);
  assert.equal(m.contextWindow,null);assert.equal(m.officialContextWindow,null);assert.equal(m.contextWindowSource,null);assert.equal(m.callable,false);
});
test('absent official context uses exact native declaration',async()=>{
 const e=entry('MiniMax-M2.7');delete e.contextWindow;const[m]=await catalog([e]);assert.equal(m.contextWindow,204800);assert.equal(m.officialContextWindow,null);
});
for(const id of ['minimax-m2.7','MiniMax-M2.7-highspeed','qwen3.5-plus','glm-5.1-future','__proto__'])test(`no case family suffix or prototype fallback: ${id}`,async()=>{
 const[m]=await catalog([entry(id)]);assert.equal(m.contextWindow,null);assert.equal(m.contextWindowSource,null);assert.equal(m.callable,false);
});
test('native context never overrides account/catalog restriction',async()=>{
 const[m]=await catalog([entry('MiniMax-M2.7',{accessible:false,restrictionHint:'SAMPLE restriction'})]);assert.equal(m.contextWindow,204800);assert.equal(m.accessible,false);assert.equal(m.callable,false);assert.equal(m.callableReason,'upstream_restricted');assert.equal(m.restrictionHint,'SAMPLE restriction');
});
for(const supportsToolCalling of [false,true,null])test(`native context preserves tools declaration ${supportsToolCalling}`,async()=>{
 const[m]=await catalog([entry('MiniMax-M2.7',{supportsToolCalling})]);assert.equal(m.tools,supportsToolCalling===true);assert.equal(m.toolsField,supportsToolCalling===null?'unproven':String(supportsToolCalling));assert.equal(m.toolsSource,'official_catalog');
});
test('unknown model retains positive official capacity',async()=>{
 const[m]=await catalog([entry('new-official-model',{contextWindow:456789})]);assert.equal(m.contextWindow,456789);assert.equal(m.officialContextWindow,456789);assert.equal(m.contextWindowSource,'official_catalog');assert.equal(m.callable,true);
});
test('external options and metadata cannot inject arbitrary context',async()=>{
 const[m]=await catalog([entry('unknown',{nativeContextWindow:999999,contextWindowSource:'native_client_registry'})],{nativeContextWindows:{unknown:999999},nativeContextWindow:999999});assert.equal(m.contextWindow,null);assert.equal(m.callable,false);
});
test('fixed evidence cannot be mutated through a prior catalog row',async()=>{
 const[m]=await catalog([entry('MiniMax-M2.7')]);assert.throws(()=>{m.contextWindowEvidence.nativeVersion='SAMPLE';},TypeError);const[n]=await catalog([entry('glm-5')]);assert.equal(n.contextWindowEvidence.nativeVersion,'2026.10.23');
});
test('catalog projection leaves original metadata and ordering intact',async()=>{
 const input=[entry('glm-5'),entry('glm-5v-turbo'),entry('qwen3.6-plus')];const before=structuredClone(input);const models=await catalog(input);assert.deepEqual(input,before);assert.deepEqual(models.map(m=>m.id),input.map(m=>m.modelId));
});
