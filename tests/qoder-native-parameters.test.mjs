import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {parseQoderModels,qoderChat}=await import(process.env.TEST_QODER_MODULE?pathToFileURL(process.env.TEST_QODER_MODULE).href:new URL('../src/provider-qoder.mjs',import.meta.url).href);

const declared=()=>({key:'SAMPLE',display_name:'Sample',max_input_tokens:180000,is_vl:true,is_reasoning:true,
 context_config:{'1M':{token_count:1000000},'200K':{token_count:200000,is_default:true},'400K':{token_count:400000}},
 thinking_config:{disabled:{},enabled:{is_default:true,efforts:{xhigh:{},low:{},medium:{is_default:true}}}}});
const parse=model=>parseQoderModels({chat:[model]})[0];

test('Qoder native context options carry their exact source and unique default',()=>{
 const model=parse(declared()),native=model.qoderNativeParameters;
 assert.equal(native.source,'qoder-official-signed-catalog');assert.equal(native.wireVerified,false);
 assert.deepEqual(native.context,{source:'context_config',options:[{id:'1M',tokenCount:1000000,isDefault:false},{id:'200K',tokenCount:200000,isDefault:true},{id:'400K',tokenCount:400000,isDefault:false}],defaultTokenCount:200000});
 assert.equal(model.contextWindow,180000);assert.equal(model.callable,true);
});

test('Qoder native thinking preserves declared modes and actual effort identifiers',()=>{
 const native=parse(declared()).qoderNativeParameters;
 assert.deepEqual(native.thinking,{source:'thinking_config',modes:[{id:'disabled',isDefault:false},{id:'enabled',isDefault:true}],defaultMode:'enabled',efforts:[{id:'xhigh',isDefault:false},{id:'low',isDefault:false},{id:'medium',isDefault:true}],defaultEffort:'medium'});
});

test('Qoder native declarations never invent generic reasoning controls',()=>{
 const model=parse(declared());assert.equal(model.reasoning,null);assert.equal(model.reasoningEfforts,undefined);
 assert.equal(model.maxTokens,1024);assert.equal(model.maxTokensSource,'configured_default');assert.equal(model.officialMaxTokens,null);
});

test('Qoder explicit input and output limits outrank native context selector metadata',()=>{
 const model=parse({...declared(),max_input_tokens:96000,max_output_tokens:8192});
 assert.equal(model.contextWindow,96000);assert.equal(model.maxTokens,8192);assert.equal(model.officialMaxTokens,8192);assert.equal(model.maxTokensSource,'official_catalog');
 assert.equal(model.qoderNativeParameters.context.defaultTokenCount,200000);
});

test('Qoder missing actual input limit stays uncallable despite an explicit context default',()=>{
 const model=parse({...declared(),max_input_tokens:null});assert.equal(model.contextWindow,null);assert.equal(model.callable,false);assert.equal(model.qoderNativeParameters.context.defaultTokenCount,200000);
});

test('Qoder ambiguous defaults remain unknown instead of choosing the first or maximum',()=>{
 const raw=declared();raw.context_config['1M'].is_default=true;raw.thinking_config.disabled.is_default=true;raw.thinking_config.enabled.efforts.low.is_default=true;
 const native=parse(raw).qoderNativeParameters;assert.equal(native.context.defaultTokenCount,null);assert.equal(native.thinking.defaultMode,null);assert.equal(native.thinking.defaultEffort,null);
});

test('Qoder malformed parameter structures and invalid token counts are not promoted',()=>{
 for(const context_config of [null,[],{bad:{token_count:'200000'}},{zero:{token_count:0}},{float:{token_count:200000.1}},{huge:{token_count:Number.MAX_SAFE_INTEGER+1}}]){
  assert.equal(parse({key:'SAMPLE',max_input_tokens:180000,context_config,thinking_config:null}).qoderNativeParameters,undefined);
 }
 const model=parse({key:'SAMPLE',max_input_tokens:180000,thinking_config:{enabled:{efforts:[]}}});assert.deepEqual(model.qoderNativeParameters.thinking.efforts,[]);assert.equal(model.qoderNativeParameters.thinking.defaultEffort,null);
});

test('Qoder native parser leaves source rows and unrelated fields untouched',()=>{
 const raw=declared();raw.unknown={retained:true};raw.thinking_config.enabled.efforts.future_native_level={};const original=structuredClone(raw);const model=parse(raw);
 assert.deepEqual(raw,original);assert.ok(model.qoderNativeParameters.thinking.efforts.some(e=>e.id==='future_native_level'));assert.equal(model.reasoningEfforts,undefined);
});

test('Qoder boolean reasoning without a native parameter declaration keeps the old contract',()=>{
 const model=parse({key:'SAMPLE',max_input_tokens:180000,is_reasoning:true});assert.equal(model.isReasoning,true);assert.equal(model.reasoning,null);assert.equal(model.qoderNativeParameters,undefined);
});

test('Qoder context-only native config does not fabricate thinking or a default mode',()=>{
 const model=parse({...declared(),thinking_config:null});assert.equal(model.qoderNativeParameters.thinking,null);assert.equal(model.qoderNativeParameters.context.defaultTokenCount,200000);
});

test('Qoder native parameter metadata does not change explicit chat fields or caller objects',async()=>{
 const credential={edition:'cn',accessToken:'SAMPLE-NOT-A-SECRET',uid:'native-parameters-fixture',principal:'SAMPLE',machineId:'SAMPLE',identity:{machineToken:'SAMPLE',machineCode:'SAMPLE',machineType:'SAMPLE'}};
 const input={model:'SAMPLE',messages:[{role:'user',content:[{type:'text',text:'SAMPLE'},{type:'image_url',image_url:{url:'data:image/png;base64,U0FNUExF'}}]},{role:'assistant',content:'',tool_calls:[{id:'SAMPLE-call',type:'function',function:{name:'read',arguments:'{"path":"SAMPLE"}'}}]},{role:'tool',tool_call_id:'SAMPLE-call',content:'SAMPLE'},{role:'user',content:'SAMPLE'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}],tool_choice:'auto',reasoning_effort:'low',max_tokens:800,temperature:0,top_p:0.9};const before=structuredClone(input);let seen,calls=0;
 const result=await qoderChat({},credential,input,undefined,{fetchImpl:async(url,options)=>{
  calls++;if(url.includes('/model/list'))return Response.json({chat:[declared()]});
  const std='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$',encoded=options.body,a=Math.floor(encoded.length/3),base64=encoded.slice(encoded.length-a)+encoded.slice(a,encoded.length-a)+encoded.slice(0,a);seen=JSON.parse(Buffer.from([...base64].map(c=>std[custom.indexOf(c)]).join(''),'base64').toString('utf8'));
  return new Response('data:'+JSON.stringify({body:JSON.stringify({choices:[{delta:{content:'SAMPLE'},finish_reason:'stop'}]})})+'\n\ndata:'+JSON.stringify({body:'[DONE]'})+'\n\n');
 }});
 await result.response.text();assert.equal(calls,2);assert.equal(seen.max_tokens,800);assert.equal(seen.reasoning_effort,'low');assert.equal(seen.temperature,0);assert.equal(seen.top_p,0.9);assert.deepEqual(seen.messages,input.messages);assert.deepEqual(seen.tools,input.tools);assert.equal(seen.tool_choice,'auto');assert.equal(seen.model_config.max_input_tokens,180000);assert.equal(seen.qoderNativeParameters,undefined);assert.deepEqual(input,before);
});
