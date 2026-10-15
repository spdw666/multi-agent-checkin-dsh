import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptRelayReasoning} from '../src/relay-reasoning.mjs';

const wb = {id:'deepseek-v4.1-flash',reasoning:{supportedEfforts:['low','high','max']}};
const highOnly = {reasoning:{supportedEfforts:['high']}};
const plain = {id:'deepseek-v4.1-flash',reasoning:true,isReasoning:true};
const trae = {reasoningEfforts:{low:'light',high:'heavy'}};
const binary = {reasoning:{supportedEfforts:['off','on'],control:'thinking',canDisableThinking:true}};
const always = {reasoning:{supportedEfforts:['low','high','max'],alwaysEnabled:true,canDisableThinking:false}};
const switchable = {reasoningEfforts:{off:'none',low:'low',high:'high',max:'max'}};
const entry = (name, model, request, expected, options = {}) => ({name,model,request,expected,options});

const fixtures = [
  entry('WorkBuddy max -> plain desktop strips unsupported effort',plain,{reasoning_effort:'max'},null),
  entry('WorkBuddy max -> NVIDIA DeepSeek built-in reasoning omits effort',plain,{reasoning_effort:'max'},null,{kind:'nvidia'}),
  entry('plain -> WorkBuddy explicitly chooses actual maximum',wb,{},'max',{sourceModel:plain}),
  entry('SDK null -> WorkBuddy explicitly chooses actual maximum',wb,{reasoning_effort:null},'max',{sourceModel:plain}),
  entry('plain default off -> WorkBuddy is maximum rather than accidental disabled',wb,{reasoning_effort:'off'},'max',{sourceModel:plain}),
  entry('plain default none -> selectable target is maximum',wb,{reasoning_effort:'none'},'max',{sourceModel:plain}),
  entry('explicit valid source low remains low',wb,{reasoning_effort:'low'},'low'),
  entry('explicit valid source high remains high',wb,{reasoning_effort:'high'},'high'),
  entry('max -> only high target clamps to actual high',highOnly,{reasoning_effort:'max'},'high'),
  entry('max -> Trae high maps native heavy',trae,{reasoning_effort:'max'},'heavy',{kind:'trae'}),
  entry('Trae native heavy -> WorkBuddy resolves source high',wb,{reasoning_effort:'heavy'},'high',{sourceModel:trae}),
  entry('Trae native light -> WorkBuddy resolves source low',wb,{reasoning_effort:'light'},'low',{sourceModel:trae}),
  entry('xhigh -> nearest higher declared tier max',wb,{reasoning_effort:'xhigh'},'max',{sourceModel:{reasoningEfforts:{xhigh:'xhigh'}}}),
  entry('medium -> next declared tier high',wb,{reasoning_effort:'medium'},'high',{sourceModel:{reasoningEfforts:{medium:'medium'}}}),
  entry('plain -> Trae maps highest xhigh without fictional max',
    {reasoningEfforts:{low:'light',high:'heavy',xhigh:'extra_high'}},{},'extra_high',{kind:'trae',sourceModel:plain}),
  entry('nested SDK null never overrides top max',wb,{reasoning_effort:'max',extra_body:{reasoning_effort:null}},'max'),
  entry('top SDK null permits explicit nested low',wb,{reasoning_effort:null,extra_body:{reasoning_effort:'low'}},'low'),
  entry('structured reasoning effort normalizes to declared top field',wb,{reasoning:{effort:'high'}},'high'),
  entry('structured extra-body effort normalizes to declared top field',wb,{extra_body:{reasoning:{effort:'low'}}},'low'),
  entry('unrecognized source effort uses known target maximum',wb,{reasoning_effort:'ultra'},'max'),
  entry('unranked opaque metadata never manufactures tiers',{reasoning:{supportedEfforts:['turbo']}},{reasoning_effort:'max'},null),
  entry('missing target metadata removes all unsupported controls',undefined,{reasoning_effort:'high'},null),
  entry('source explicit off -> switchable target preserves accepted none',switchable,{reasoning_effort:'off'},'none',{sourceModel:switchable}),
  entry('source disabled -> always-enabled target selects maximum',always,{reasoning_effort:'none'},'max',{sourceModel:switchable}),
  entry('binary source off -> tier target selects maximum',wb,{thinking:{type:'disabled'}},'max',{sourceModel:binary}),
  entry('defaultEffort alone is not selectable maximum',{reasoning:{defaultEffort:'high'}},{reasoning_effort:'max'},null),
  entry('boolean-only target drops structured thinking request',plain,{thinking:{type:'enabled',budget_tokens:1024}},null),
  entry('Lobster declared aliases choose actual highest native high',
    {reasoningOptions:['off','high'],reasoningEffortMapping:{off:'off',low:'high',medium:'high',high:'high'}},
    {reasoning_effort:'max'},'high',{kind:'lobster'}),
  entry('Lobster canonical max is emitted for native adapter conversion',
    {reasoningOptions:['off','high','max'],reasoningEffortMapping:{off:'off',low:'high',high:'high',xhigh:'max',max:'max'}},
    {},'max',{kind:'lobster',sourceModel:plain}),
  entry('native Lobster source envelope max resolves source level',wb,
    {lobsterai_options:{version:1,thinking:{level:'max'}}},'max',{sourceModel:{reasoningOptions:['high','max'],reasoningEffortMapping:{high:'high',max:'max'}}}),
  entry('null-only unsupported controls are removed rather than serialized',plain,
    {reasoning_effort:null,reasoning:null,thinking:null,extra_body:{reasoning_effort:null}},null),
  entry('single medium declaration is the actual target maximum',{reasoningEfforts:{medium:'medium'}}, {},'medium',{sourceModel:plain}),
];
for (const fixture of fixtures) test(fixture.name, () => {
  const input = {model:'client-route/deepseek-v4.1-flash',messages:[{role:'user',content:'SAMPLE'}],...fixture.request};
  const before = structuredClone(input);
  const {request,metadata} = adaptRelayReasoning(input,fixture.model,{kind:'workbuddy',sourceModel:wb,...fixture.options});
  assert.deepEqual(input,before);
  assert.equal(request.model,input.model);
  assert.equal(request.messages,input.messages);
  assert.equal(request.reasoning_effort,fixture.expected ?? undefined);
  assert.equal(request.extra_body?.reasoning_effort,undefined);
  assert.equal(request.extra_body?.reasoning,undefined);
  assert.equal(request.lobsterai_options,undefined);
  if (fixture.expected === null) assert.equal(metadata.targetMaximum,null);
});

test('tier max -> BigModel binary emits enabled and no fictional max', () => {
  const {request,metadata} = adaptRelayReasoning({reasoning_effort:'max'},binary,{kind:'bigmodel',sourceModel:wb});
  assert.deepEqual(request,{thinking:{type:'enabled'}});
  assert.equal(metadata.mode,'binary');
  assert.equal(metadata.targetMaximum,null);
});

test('explicit source disabled -> real binary target emits disabled', () => {
  const {request} = adaptRelayReasoning({thinking:{type:'disabled'}},binary,{kind:'bigmodel',sourceModel:switchable});
  assert.deepEqual(request,{thinking:{type:'disabled'}});
});

test('declared native supportedThinkingTypes uses only native thinking field', () => {
  const model = {reasoning:{supportedThinkingTypes:['enabled','disabled']}};
  const {request} = adaptRelayReasoning({reasoning_effort:'max'},model,{sourceModel:wb});
  assert.deepEqual(request,{thinking:{type:'enabled'}});
});

test('BigModel GLM5.3 levels plus force-on controls are enabled and actual max', () => {
  const {request} = adaptRelayReasoning({thinking:{type:'disabled'},reasoning_effort:'off'},always,
    {kind:'bigmodel',sourceModel:plain});
  assert.deepEqual(request,{reasoning_effort:'max',thinking:{type:'enabled'}});
});

test('native thinking types alongside real levels do not collapse a tiered model into binary', () => {
  const model = {reasoning:{...always.reasoning,supportedThinkingTypes:['enabled']}};
  const {request,metadata} = adaptRelayReasoning({},model,{kind:'bigmodel',sourceModel:plain});
  assert.deepEqual(request,{reasoning_effort:'max',thinking:{type:'enabled'}});
  assert.equal(metadata.targetMaximum,'max');
});

test('real levels with native disabled switch emit disabled without fictional disabled effort', () => {
  const model = {reasoning:{supportedEfforts:['low','high'],supportedThinkingTypes:['enabled','disabled']}};
  const {request} = adaptRelayReasoning({reasoning_effort:'off'},model,{kind:'bigmodel',sourceModel:switchable});
  assert.deepEqual(request,{thinking:{type:'disabled'}});
});

test('effort aliases with duplicate native wire values do not manufacture a bigger tier', () => {
  const model = {reasoningEfforts:{low:'light',high:'heavy',xhigh:'heavy',max:'heavy'}};
  const {request,metadata} = adaptRelayReasoning({},model,{kind:'trae',sourceModel:plain});
  assert.equal(request.reasoning_effort,'heavy');
  assert.equal(metadata.targetMaximum,'high');
});

test('binary generic wire uses an explicitly mapped enabled value rather than guessing on', () => {
  const model = {reasoningEfforts:{off:'disabled',high:'enabled'}};
  const {request,metadata} = adaptRelayReasoning({reasoning_effort:'max'},model,{sourceModel:wb});
  assert.deepEqual(request,{reasoning_effort:'enabled'});
  assert.equal(metadata.wireEffort,'enabled');
  assert.equal(metadata.targetMaximum,null);
});

test('native controls are removed from both root and extra body; unrelated template keys stay', () => {
  const input = {
    reasoning_effort:'max',thinking:{type:'enabled'},reasoning:{effort:'max'},
    chat_template_kwargs:{enable_thinking:true,low_effort:true,unrelated:'kept'},
    extra_body:{thinking:{level:'max'},reasoning_effort:null,thinking_level:'max',
      lobsterai_options:{version:1,thinking:{level:'max'}},
      chat_template_args:{thinking_mode:'on',reasoning_budget:512,fixture_option:7},custom_flag:true},
  };
  const before = structuredClone(input);
  const {request,metadata} = adaptRelayReasoning(input,plain,{sourceModel:wb});
  assert.deepEqual(input,before);
  assert.deepEqual(request,{chat_template_kwargs:{unrelated:'kept'},extra_body:{chat_template_args:{fixture_option:7},custom_flag:true}});
  assert.ok(metadata.removedFields.includes('extra_body.reasoning_effort'));
});

test('thinking configuration and camel-case budgets are stripped only at request-control locations', () => {
  const fields = {
    thinking_config:{thinking_budget:2048},thinkingConfig:{thinkingBudget:2048},
    reasoning_config:{effort:'max'},reasoningConfig:{effort:'max'},
    enableThinking:true,disableThinking:false,thinkingBudget:2048,reasoningBudget:2048,
    thinking_budget_tokens:2048,reasoning_budget_tokens:2048,thinkingBudgetTokens:2048,
    reasoningBudgetTokens:2048,reasoning_enabled:true,reasoningEnabled:true,
    thinking_type:'enabled',thinkingType:'enabled',thinking_format:'native',thinkingFormat:'native',
    include_thoughts:true,includeThoughts:true,
  };
  const tools = [{type:'function',function:{name:'fixture',parameters:{type:'object',properties:fields}}}];
  const messages = [{role:'tool',tool_call_id:'call-SAMPLE',content:JSON.stringify(fields)}];
  const original = {reasoning_effort:'max',...fields,tools,messages,
    extra_body:{...fields,fixture:7},max_tokens:4096};
  const before = structuredClone(original);
  const {request} = adaptRelayReasoning(original,plain,{sourceModel:wb});
  assert.deepEqual(request,{tools,messages,extra_body:{fixture:7},max_tokens:4096});
  assert.deepEqual(original,before);
  assert.equal(request.tools,tools);
  assert.equal(request.messages,messages);
});

test('declared source tier within camel thinkingConfig preserves valid low intent', () => {
  const {request} = adaptRelayReasoning({thinkingConfig:{thinkingLevel:'low'}},wb,{sourceModel:wb});
  assert.deepEqual(request,{reasoning_effort:'low'});
});

test('reasoning metadata never logs arbitrary input or undeclared native strings', () => {
  const secretLikeInput = 'TOKEN_PRIVATE_SAMPLE';
  const {request,metadata} = adaptRelayReasoning({reasoning_effort:secretLikeInput},wb,{sourceModel:wb});
  assert.equal(request.reasoning_effort,'max');
  assert.equal(metadata.sourceIntent,'unrecognized');
  assert.equal(JSON.stringify(metadata).includes(secretLikeInput),false);
  const native = 'DECLARED_OPAQUE_NATIVE_SAMPLE';
  const adapted = adaptRelayReasoning({}, {reasoningEfforts:{high:native}}, {sourceModel:plain});
  assert.equal(adapted.request.reasoning_effort,native);
  assert.equal(adapted.metadata.wireEffort,'declared_native');
  assert.equal(JSON.stringify(adapted.metadata).includes(native),false);
});

test('conversation, tool schema/results, output budget, stream and cancellation references stay exact', () => {
  const controller = new AbortController();
  const messages = [
    {role:'system',content:'PROJECT_SAMPLE'},
    {role:'assistant',content:null,reasoning_content:'Prior legitimate reasoning',tool_calls:[{id:'call-SAMPLE',type:'function',function:{name:'fixture',arguments:'{"thinking":"SAMPLE"}'}}]},
    {role:'tool',tool_call_id:'call-SAMPLE',content:'FILE_NONCE_SAMPLE'},
  ];
  const tools = [{type:'function',function:{name:'fixture',parameters:{type:'object',properties:{reasoning_effort:{type:'string'}}}}}];
  const request = {model:'original-client-model-ID',messages,tools,tool_choice:'auto',max_tokens:4096,
    max_completion_tokens:4096,stream:false,signal:controller.signal,timeoutMs:300000,
    reasoning_effort:'max',extra_body:{reasoning_effort:null,custom:'SAMPLE'}};
  const snapshots = {messages:JSON.stringify(messages),tools:JSON.stringify(tools)};
  const result = adaptRelayReasoning(request,plain,{sourceModel:wb}).request;
  for (const key of ['model','messages','tools','tool_choice','max_tokens','max_completion_tokens','stream','signal','timeoutMs'])
    assert.equal(result[key],request[key]);
  assert.equal(JSON.stringify(result.messages),snapshots.messages);
  assert.equal(JSON.stringify(result.tools),snapshots.tools);
  assert.deepEqual(request.extra_body,{reasoning_effort:null,custom:'SAMPLE'});
});

test('non-relay invocation keeps original object and original behavior', () => {
  const request = {reasoning_effort:'max',extra_body:{reasoning_effort:null},thinking:{type:'enabled'}};
  const result = adaptRelayReasoning(request,plain,{sourceModel:wb,relayed:false});
  assert.equal(result.request,request);
  assert.deepEqual(result.metadata,{mode:'unchanged',changed:false});
});

test('each attempted target adapts the original rather than leaking prior target decisions', () => {
  const original = {model:'route',reasoning_effort:'max',extra_body:{reasoning_effort:null},messages:[]};
  const a = adaptRelayReasoning(original,plain,{sourceModel:wb}).request;
  const b = adaptRelayReasoning(original,trae,{kind:'trae',sourceModel:wb}).request;
  const c = adaptRelayReasoning(original,wb,{sourceModel:wb}).request;
  assert.equal(a.reasoning_effort,undefined);
  assert.equal(b.reasoning_effort,'heavy');
  assert.equal(c.reasoning_effort,'max');
  assert.equal(original.reasoning_effort,'max');
});

test('repeat adaptation to same target is byte-stable and leaves caller unmodified', () => {
  const original = {model:'route',extra_body:{reasoning_effort:null},messages:[]};
  const one = adaptRelayReasoning(original,wb,{sourceModel:plain}).request;
  const two = adaptRelayReasoning(original,wb,{sourceModel:plain}).request;
  const again = adaptRelayReasoning(one,wb,{sourceModel:plain}).request;
  assert.equal(JSON.stringify(one),JSON.stringify(two));
  assert.equal(JSON.stringify(one),JSON.stringify(again));
  assert.equal(original.reasoning_effort,undefined);
});
