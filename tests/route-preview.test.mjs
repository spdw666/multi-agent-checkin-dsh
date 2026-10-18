import test from 'node:test';
import assert from 'node:assert/strict';
import {previewRoute} from '../src/route-preview.mjs';

const now=Date.parse('2026-10-18T12:00:00Z');
const caps={id:'model-v1',contextWindow:20000,maxTokens:4096,tools:true,multimodal:true,callable:true};
function fixture({kind='codebuddy',model=caps,relay=false,extraRoutes=[],extraUpstreams=[],extraAccounts=[],rows=new Map()}={}){
  const value={modelRelay:{enabled:relay},accounts:[{id:'SAMPLE_ACCOUNT_123',platform:kind,enabled:true},...extraAccounts],upstreams:[{id:'up',kind,accountId:'SAMPLE_ACCOUNT_123',enabled:true},...extraUpstreams],routes:[{id:'public/model',enabled:true,targets:[{upstreamId:'up',model:'model-v1'}]},...extraRoutes]};
  const forbid=()=>{throw Error('unexpected side effect');};
  return {config:{value,load:forbid,save:forbid},platforms:{catalogs:new Map(model?[['up',[model]]]:[]),models:forbid,health:forbid,chat:forbid},credentials:{resolve:forbid,refresh:forbid},router:{relay:{prepare:forbid,discover:forbid},pool:{success:forbid,select:forbid}},ledger:{get:key=>rows.get(key),set:forbid,record:forbid,beginUsage:forbid,finishUsage:forbid}};
}
const metadata={routeId:'public/model',inputChars:1000,outputBudget:500,requiresTools:false,hasImages:false};
const request={model:'public/model',messages:[{role:'user',content:'SAMPLE_PROMPT'}],max_tokens:500};
test('preview uses existing RequestPlan capabilities and preserves all source state',()=>{
  const s=fixture(),before=JSON.stringify(s.config.value),cache=JSON.stringify([...s.platforms.catalogs]);
  const r=previewRoute(s,metadata,{now});
  assert.equal(r.candidates[0].state,'eligible');assert.equal(r.candidates[0].contextFit,'sufficient');assert.equal(r.candidates[0].outputFit,'sufficient');
  assert.equal(r.contract.serializedBytes,null);assert.equal(r.contract.contextEstimate.tokenCount,null);assert.equal(r.contractCompleteness,'partial_metadata');
  assert.deepEqual(r.sideEffects,{generationRequests:0,configWrites:0,stateWrites:0});assert.equal(JSON.stringify(s.config.value),before);assert.equal(JSON.stringify([...s.platforms.catalogs]),cache);
  assert.ok(!JSON.stringify(r).includes('SAMPLE_ACCOUNT_123'));assert.equal(r.candidates[0].catalog.freshness,'unknown');
});
test('full request bytes are real and original request fields are never trimmed or changed',()=>{
  const s=fixture(),original=structuredClone(request),r=previewRoute(s,{request},{now});
  assert.equal(r.mode,'request');assert.equal(r.contractCompleteness,'full_request');assert.equal(r.contract.serializedBytes,Buffer.byteLength(JSON.stringify(request)));
  assert.equal(r.candidates[0].state,'eligible');assert.deepEqual(request,original);assert.ok(!JSON.stringify(r).includes('SAMPLE_PROMPT'));
});
test('missing cached catalogue and undeclared capabilities stay unknown without online reads',()=>{
  const empty=previewRoute(fixture({model:null}),metadata,{now});assert.equal(empty.candidates[0].state,'unknown');assert.equal(empty.candidates[0].capabilities.contextWindow,null);
  const omitted=previewRoute(fixture({model:{id:'model-v1',contextWindow:20000,maxTokens:4096}}),{...metadata,requiresTools:true},{now});assert.equal(omitted.candidates[0].state,'unknown');assert.equal(omitted.candidates[0].capabilities.tools,null);
});
test('conservative context bound failure does not falsely claim the actual request cannot fit',()=>{
  const r=previewRoute(fixture(),{...metadata,inputChars:100000},{now});assert.equal(r.candidates[0].contextFit,'not_proven');assert.equal(r.candidates[0].state,'unknown');assert.equal(r.candidates[0].reasonCode,'context_fit_not_proven');
  const unknown=previewRoute(fixture(),{routeId:'public/model'},{now});assert.equal(unknown.candidates[0].contextFit,'unknown');assert.equal(unknown.contract.contextEstimate.upperBound,null);
});
test('known output ceiling, tool and image incompatibility have typed skip reasons',()=>{
  assert.equal(previewRoute(fixture(),{...metadata,outputBudget:9000},{now}).candidates[0].reasonCode,'relay_capacity_incompatible');
  assert.equal(previewRoute(fixture({model:{...caps,tools:false}}),{...metadata,requiresTools:true},{now}).candidates[0].reasonCode,'tools_not_supported');
  assert.equal(previewRoute(fixture({model:{...caps,multimodal:false}}),{...metadata,hasImages:true},{now}).candidates[0].reasonCode,'images_not_supported');
  const configured=previewRoute(fixture({model:{...caps,maxTokensSource:'configured_default',officialMaxTokens:undefined}}),metadata,{now});assert.equal(configured.candidates[0].capabilities.outputCapacity,null);assert.equal(configured.candidates[0].state,'unknown');
});
test('OpenCode complete request gate mirrors single user plain-text bridge',()=>{
  const s=fixture({kind:'opencode',model:{...caps,tools:false,multimodal:false}});
  const plain={model:'public/model',messages:[{role:'user',content:'SAMPLE'}]};
  assert.notEqual(previewRoute(s,plain,{now}).candidates[0].state,'skipped');
  const incompatible=[
    [{...plain,messages:[{role:'system',content:'SAMPLE'},{role:'user',content:'SAMPLE'}]},'relay_context_incompatible'],
    [{...plain,messages:[{role:'user',content:[{type:'text',text:'SAMPLE'}]}]},'relay_context_incompatible'],
    [{...plain,messages:[{role:'user',content:'SAMPLE',name:'SAMPLE'}]},'relay_context_incompatible'],
    [{...plain,max_tokens:500},'relay_capacity_incompatible'],
    [{...plain,temperature:0},'relay_capacity_incompatible'],
    [{...plain,reasoning_effort:'high'},'relay_capacity_incompatible'],
    [{...plain,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,SAMPLE'}}]}]},'images_not_supported'],
    [{...plain,tools:[{type:'function',function:{name:'SAMPLE'}}],tool_choice:'none'},'tools_not_supported'],
    [{...plain,messages:[{role:'assistant',tool_calls:[{id:'SAMPLE'}],content:null},{role:'tool',content:'SAMPLE',tool_call_id:'SAMPLE'}]},'tools_not_supported'],
  ];
  for(const [input,reason]of incompatible){const original=structuredClone(input),r=previewRoute(s,input,{now});assert.equal(r.candidates[0].state,'skipped');assert.equal(r.candidates[0].reasonCode,reason);assert.deepEqual(input,original);}
});
test('OpenCode metadata gate handles explicit budget, multi-role, images and tools',()=>{
  const s=fixture({kind:'opencode'});
  for(const [change,reason]of [[{messageCount:2,outputBudget:0},'relay_context_incompatible'],[{explicitParameters:['temperature'],outputBudget:0},'relay_capacity_incompatible'],[{hasImages:true},'images_not_supported'],[{hasToolHistory:true},'tools_not_supported'],[{requiresTools:true},'tools_not_supported']])assert.equal(previewRoute(s,{...metadata,...change},{now}).candidates[0].reasonCode,reason);
});
test('saved audit remains separate evidence and never invents model capacity or freshness',()=>{
  const rows=new Map([['model-audit',{results:[{upstreamId:'up',model:'model-v1',status:'passed',finishedAt:'2026-10-17T00:00:00Z',tests:[{stage:'ordinary',ok:true,text:'LEAK_TEXT',elapsedMs:123},{stage:'tools',ok:true,args:{password:'LEAK_ARGS'}}],reason:'LEAK_REASON'}]}]]);
  const r=previewRoute(fixture({model:null,rows}),metadata,{now});assert.equal(r.candidates[0].state,'unknown');assert.equal(r.candidates[0].audit.status,'passed');assert.equal(r.candidates[0].audit.checkedAt,'2026-10-17T00:00:00.000Z');assert.ok(!JSON.stringify(r).includes('LEAK'));assert.equal(r.candidates[0].catalog.checkedAt,null);
});
test('relay discovers only same-model same-partition candidates from cached catalogues',()=>{
  const s=fixture({relay:true,extraRoutes:[{id:'other',targets:[{upstreamId:'other-up',model:'model-v1'}]},{id:'wrong-model',targets:[{upstreamId:'wrong-up',model:'model-v2'}]},{id:'wrong-partition',targets:[{upstreamId:'wb-up',model:'model-v1'}]}],extraUpstreams:[{id:'other-up',kind:'qoder',accountId:'SECOND_ACCOUNT'},{id:'wrong-up',kind:'qoder',accountId:'SECOND_ACCOUNT'},{id:'wb-up',kind:'workbuddy',accountId:'THIRD_ACCOUNT'}],extraAccounts:[{id:'SECOND_ACCOUNT',platform:'qoder'},{id:'THIRD_ACCOUNT',platform:'workbuddy'}]});
  s.platforms.catalogs.set('other-up',[caps]);const r=previewRoute(s,metadata,{now});assert.equal(r.candidates.length,2);assert.deepEqual(r.candidates.map(c=>c.platform),['codebuddy','qoder']);
});
test('read-only cooldown and independent inference switch reasons do not mutate state',()=>{
  const rows=new Map([['relay-cooldown:up\0model-v1',{until:now+30000,reasonCode:'rate_limited'}]]),s=fixture({rows}),before=JSON.stringify([...rows]);
  const r=previewRoute(s,metadata,{now});assert.equal(r.candidates[0].state,'skipped');assert.equal(r.candidates[0].reasonCode,'rate_limited');assert.equal(r.candidates[0].cooldown.retryAfterSeconds,30);assert.equal(JSON.stringify([...rows]),before);
  const wb=fixture({kind:'workbuddy'});wb.config.value.accounts[0].inferenceEnabled=false;assert.equal(previewRoute(wb,metadata,{now}).candidates[0].reasonCode,'wb_inference_disabled');assert.equal(wb.config.value.accounts[0].enabled,true);
});
test('strict input validation rejects malformed types, ranges and ambiguous envelope fields',()=>{
  const invalid=[null,{},[],{...metadata,inputChars:'1000'},{...metadata,inputChars:-1},{...metadata,outputBudget:1.2},{...metadata,messageCount:0},{...metadata,requiresTools:'true'},{...metadata,hasImages:null},{...metadata,explicitParameters:[{}]},{...metadata,unknown:1},{request,extra:1},{...request,max_tokens:'100'},{...request,messages:[]},{...request,messages:[{role:'evil',content:'SAMPLE'}]},{...request,stream:'true'},{...request,temperature:NaN},{...request,tools:[{}]}];
  for(const input of invalid)assert.throws(()=>previewRoute(fixture(),input,{now}),e=>e.status===400);
  assert.throws(()=>previewRoute(fixture(),{...metadata,routeId:'missing'},{now}),e=>e.code==='model_not_found');
});
test('workbuddy pool preview exposes disabled members without changing eligibility switches',()=>{
  const s=fixture({kind:'workbuddy',extraAccounts:[{id:'SECOND_ACCOUNT',platform:'workbuddy',enabled:true,inferenceEnabled:false}],extraUpstreams:[{id:'other-up',kind:'workbuddy',accountId:'SECOND_ACCOUNT'}]});
  s.config.value.routes[0].accountPool={enabled:true,accountIds:['SAMPLE_ACCOUNT_123','SECOND_ACCOUNT']};
  s.platforms.catalogs.set('other-up',[caps]);
  const original=JSON.stringify(s.config.value),r=previewRoute(s,metadata,{now});assert.equal(r.candidates.length,2);assert.equal(r.candidates[1].reasonCode,'wb_inference_disabled');assert.ok(!JSON.stringify(r).includes('SECOND_ACCOUNT'));assert.equal(JSON.stringify(s.config.value),original);
});
test('opaque Qoder alias uses cached signed catalogue evidence rather than invented model equivalence',()=>{
  const s=fixture({kind:'qoder',relay:true,model:{...caps,id:'gmodel',name:'GLM-5.1',source:'qoder-official-signed-catalog'},extraRoutes:[{id:'other',targets:[{upstreamId:'other-up',model:'glm-5.1'}]}],extraUpstreams:[{id:'other-up',kind:'codebuddy',accountId:'SECOND_ACCOUNT'}],extraAccounts:[{id:'SECOND_ACCOUNT',platform:'codebuddy'}]});
  s.config.value.routes[0].targets[0].model='gmodel';s.platforms.catalogs.set('other-up',[{...caps,id:'glm-5.1'}]);
  assert.equal(previewRoute(s,metadata,{now}).candidates.length,2);
  s.platforms.catalogs.get('up')[0].source='unverified_label';assert.equal(previewRoute(s,metadata,{now}).candidates.length,1);
});
test('saved audit cooldown and platform machine codes reject account UID and opaque credential values',()=>{
  const id='ACCT20261018ABC',uid='UID778899XYZ',credential='OpaqueValue884422AB',gatewayKey='GatewayOpaque7788AA';
  for(const raw of [id,uid,credential,gatewayKey,'provider_'+id,'failure_'+credential]){
    const rows=new Map([['model-audit',{results:[{upstreamId:'up',model:'model-v1',status:'failed',tests:[{stage:'ordinary',ok:false,error:{code:raw}}]}]}],['relay-cooldown:up\0model-v1',{until:now+30000,reasonCode:raw}]]);
    const s=fixture({rows});s.config.value.accounts[0]={id,uid,credentials:{apiKey:credential}};s.config.value.upstreams[0].accountId=id;s.config.value.upstreams[0].kind=raw;s.keys={apiKey:gatewayKey};
    const r=previewRoute(s,metadata,{now}),candidate=r.candidates[0],text=JSON.stringify(r);
    assert.equal(candidate.audit.tests[0].errorCode,null);assert.equal(candidate.cooldown.reasonCode,null);assert.equal(candidate.reasonCode,'supplier_cooldown');assert.equal(candidate.platform,'unknown');
    for(const value of [id,uid,credential,gatewayKey])assert.ok(!text.includes(value));
  }
});
