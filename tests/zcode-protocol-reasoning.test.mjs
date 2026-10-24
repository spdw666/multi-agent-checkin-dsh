import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// The same test file must run against the frozen baseline, modified tree and
// independently restored rollback tree. No credentials or upstream calls.
const root=process.env.GATEWAY_REPAIR_TEST_ROOT;
const modulePath=name=>root?pathToFileURL(resolve(root,name)).href:new URL('../'+name,import.meta.url).href;
const {zcodeBody,zcodeModels}=await import(modulePath('src/zcode-models.mjs'));
const {anthropicBody}=await import(modulePath('src/anthropic.mjs'));
const {Router}=await import(modulePath('src/router.mjs'));
const {thinkingMetadata}=await import(modulePath('src/reasoning.mjs'));

const ids=['glm-5.3','glm-5.3-flash'];
const efforts=['low','high','max'];
const expectedEfforts={low:'low',high:'high',max:'max'};
const request=(id,extra={})=>({model:id,messages:[{role:'system',content:'SAMPLE system'},{role:'user',content:'SAMPLE user'}],...extra});
const catalog=(modelIds=ids)=>zcodeModels({},{now:1000,fetchBalance:async()=>({balances:[{available_units:1,expires_at:2,capabilities:modelIds.map(id=>'model:'+id)}]})});
const invalidEffort=e=>e?.code==='reasoning_effort_not_supported'&&e?.status===400;

for(const id of ids){
  test(id+' catalog exposes only documented low/high/max and mandatory reasoning',async()=>{
    const row=(await catalog()).find(m=>m.id===id);
    assert.deepEqual(row.reasoning?.supportedEfforts,efforts);
    assert.equal(row.reasoning?.alwaysEnabled,true);
    assert.deepEqual(row.reasoningEfforts,expectedEfforts);
    assert.equal(row.defaultMaxTokens,128000);
    assert.equal(row.maxTokens,128000);
  });

  for(const effort of efforts)test(id+' projects '+effort+' into native Anthropic thinking/output_config',()=>{
    const input=request(id,{reasoning_effort:effort,max_completion_tokens:128000}),before=JSON.stringify(input);
    const body=zcodeBody(input);
    assert.deepEqual(body.thinking,{type:'enabled'});
    assert.deepEqual(body.output_config,{effort});
    assert.equal(Object.hasOwn(body,'reasoning_effort'),false);
    assert.equal(body.max_tokens,128000);
    assert.equal(JSON.stringify(input),before);
  });

  test(id+' omitted effort uses documented max without inventing a smaller output budget',()=>{
    const body=zcodeBody(request(id,{max_tokens:4312}));
    assert.deepEqual(body.thinking,{type:'enabled'});
    assert.deepEqual(body.output_config,{effort:'max'});
    assert.equal(body.max_tokens,4312);
  });

  test(id+' null effort is omission rather than a null wire field',()=>{
    const body=zcodeBody(request(id,{reasoning_effort:null,max_completion_tokens:7919}));
    assert.deepEqual(body.thinking,{type:'enabled'});
    assert.deepEqual(body.output_config,{effort:'max'});
    assert.equal(Object.hasOwn(body,'reasoning_effort'),false);
    assert.equal(body.max_tokens,7919);
  });

  test(id+' rejects unsupported efforts instead of silently translating them',()=>{
    for(const effort of ['none','off','disabled','minimal','medium','xhigh','unsupported']){
      assert.throws(()=>zcodeBody(request(id,{reasoning_effort:effort})),invalidEffort,'unexpected acceptance of '+effort);
    }
  });

  test(id+' rejects disabled thinking instead of silently enabling it',()=>{
    assert.throws(()=>zcodeBody(request(id,{thinking:{type:'disabled'}})),invalidEffort);
    assert.throws(()=>zcodeBody(request(id,{reasoning_effort:'max',thinking:{type:'disabled'}})),invalidEffort);
  });

  test(id+' retains every original message, tool schema and explicit budget while adding effort',()=>{
    const tools=Array.from({length:331},(_,i)=>({type:'function',function:{name:'SAMPLE_TOOL_'+i,description:'SAMPLE '+i,parameters:{type:'object',properties:{value:{type:'string'}},required:[],additionalProperties:false}}}));
    const input=request(id,{messages:[{role:'system',content:'SAMPLE system'},{role:'user',content:'SAMPLE prior'},{role:'assistant',content:'SAMPLE answer'},{role:'user',content:'SAMPLE latest'}],tools,tool_choice:'auto',reasoning_effort:'high',max_completion_tokens:128000,max_tokens:4321});
    const before=JSON.stringify(input),plain=anthropicBody(input),body=zcodeBody(input);
    assert.equal(body.thinking?.type,'enabled');
    assert.equal(body.output_config?.effort,'high');
    assert.deepEqual(body.messages.slice(1),plain.messages);
    assert.deepEqual(body.system.slice(-plain.system.length),plain.system);
    assert.deepEqual(body.tools,plain.tools);
    assert.equal(body.tools.length,331);
    assert.deepEqual(body.tool_choice,plain.tool_choice);
    assert.equal(body.max_tokens,128000);
    assert.equal(body.stream,true);
    assert.equal(JSON.stringify(input),before);
  });
}

test('unknown future IDs and neighboring GLM variants receive no invented reasoning metadata or wire options',async()=>{
  const unknown=['glm-5.3-flashx','glm-5.3-next','glm-5.4','SAMPLE-unknown'];
  for(const row of await catalog(unknown)){
    assert.equal(row.reasoning,undefined);
    assert.equal(row.reasoningEfforts,undefined);
    const body=zcodeBody(request(row.id));
    assert.equal(Object.hasOwn(body,'thinking'),false);
    assert.equal(Object.hasOwn(body,'output_config'),false);
    assert.equal(thinkingMetadata(row).reasoning,false);
  }
});

test('Router aliases carry exact native efforts into the existing DSH thinking metadata',async()=>{
  const rows=await catalog();
  const aliases=['SAMPLE-opaque-text','SAMPLE-opaque-vision'];
  const config={value:{accounts:[{id:'SAMPLE-account',platform:'zcode'}],upstreams:[{id:'SAMPLE-upstream',kind:'zcode',accountId:'SAMPLE-account'}],routes:ids.map((id,i)=>({id:aliases[i],targets:[{upstreamId:'SAMPLE-upstream',model:id}]})),modelRelay:{enabled:false}}};
  const directory=(await new Router(config,{models:async()=>rows}).models()).data;
  assert.equal(directory.length,2);
  for(const row of directory){
    assert.deepEqual(row.reasoningEfforts,expectedEfforts);
    assert.deepEqual(row.reasoning.supportedEfforts,efforts);
    assert.equal(row.reasoning.alwaysEnabled,true);
    const metadata=thinkingMetadata(row);
    assert.equal(metadata.reasoning,true);
    assert.equal(metadata.compat.supportsReasoningEffort,true);
    for(const effort of efforts)assert.equal(metadata.thinkingLevelMap[effort],effort);
    for(const effort of ['off','minimal','medium','xhigh'])assert.equal(metadata.thinkingLevelMap[effort],null);
  }
});
