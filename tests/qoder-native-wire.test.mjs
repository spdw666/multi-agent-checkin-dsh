import test from'node:test';import assert from'node:assert/strict';import{pathToFileURL}from'node:url';
const{qoderChat}=await import(process.env.TEST_QODER_MODULE?pathToFileURL(process.env.TEST_QODER_MODULE).href:new URL('../src/provider-qoder.mjs',import.meta.url).href);
let counter=0;
const raw=()=>({key:'SAMPLE',display_name:'Sample',max_input_tokens:180000,is_vl:true,is_reasoning:true,context_config:{'200K':{token_count:200000,is_default:true},'400K':{token_count:400000}},thinking_config:{disabled:{},enabled:{is_default:true,efforts:{low:{},high:{is_default:true}}}}});
function decode(encoded){const std='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$',a=Math.floor(encoded.length/3),b=encoded.slice(encoded.length-a)+encoded.slice(a,encoded.length-a)+encoded.slice(0,a);return JSON.parse(Buffer.from([...b].map(c=>std[custom.indexOf(c)]).join(''),'base64').toString('utf8'))}
async function invoke(input={},model=raw()){
 const credential={edition:'cn',accessToken:'SAMPLE',uid:'native-wire-fixture-'+counter++,principal:'SAMPLE',machineId:'SAMPLE',identity:{machineToken:'SAMPLE',machineCode:'SAMPLE',machineType:'SAMPLE'}};let calls=0,body,headers;
 try{const r=await qoderChat({},credential,{model:'SAMPLE',messages:[{role:'user',content:'SAMPLE'}],...input},undefined,{fetchImpl:async(url,options)=>{calls++;if(url.includes('/model/list'))return Response.json({chat:[model]});body=decode(options.body);headers=options.headers;return new Response('data: '+JSON.stringify({body:JSON.stringify({choices:[{delta:{content:'SAMPLE'},finish_reason:'stop'}]})})+'\n\ndata: [DONE]\n\n')}});await r.response.text();return{calls,body,headers}}catch(error){return{calls,body,error}}
}
test('Qoder signed native body carries explicit generation fields in parameters, preserving old top-level fields',async()=>{
 const input={max_tokens:800,reasoning_effort:'low',temperature:0,top_p:0.9,tool_choice:'auto',tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],messages:[{role:'user',content:[{type:'text',text:'SAMPLE'},{type:'image_url',image_url:{url:'data:image/png;base64,U0FNUExF'}}]},{role:'assistant',content:'',tool_calls:[{id:'SAMPLE-id',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'SAMPLE-id',content:'SAMPLE'}]};const before=structuredClone(input);const r=await invoke(input);assert.equal(r.error,undefined);assert.deepEqual(r.body.parameters,{max_tokens:800,temperature:0,top_p:0.9,tool_choice:'auto',reasoning_effort:'low',enable_thinking:true});
 for(const key of ['max_tokens','reasoning_effort','temperature','top_p','tool_choice','messages','tools'])assert.deepEqual(r.body[key],input[key]);assert.deepEqual(input,before);assert.match(r.headers.Authorization,/^Bearer COSY\./);assert.match(r.body.request_id,/^[0-9a-f-]{36}$/);assert.equal(r.body.chat_record_id,r.body.request_id);assert.notEqual(r.body.session_id,r.body.request_id);assert.equal(r.body.model_config.key,'SAMPLE');assert.equal(r.body.model_config.max_input_tokens,180000);
});
test('Qoder none disables native thinking without changing caller-owned metadata',async()=>{
 const r=await invoke({reasoning_effort:'none',max_tokens:800});assert.equal(r.error,undefined);assert.equal(r.body.parameters.enable_thinking,false);assert.equal(r.body.parameters.reasoning_effort,'none');assert.equal(r.body.model_config.is_reasoning,false);assert.equal(r.body.chat_context.extra.modelConfig.is_reasoning,false);assert.equal(r.body.reasoning_effort,'none');
});
test('Qoder declared context selector enters parameters.context_length, never overwrites actual input capacity',async()=>{
 const r=await invoke({contextWindow:400000});assert.equal(r.error,undefined);assert.equal(r.body.parameters.context_length,400000);assert.equal(r.body.model_config.max_input_tokens,180000);
});
test('Qoder omitted context leaves native selection absent instead of guessing a default or reserve',async()=>{
 const r=await invoke();assert.equal(r.error,undefined);assert.equal(r.body.parameters.max_tokens,1024);assert.equal(r.body.parameters.context_length,undefined);assert.equal(r.body.model_config.max_input_tokens,180000);
});
test('Qoder invalid or undeclared context and unsupported efforts stop before dispatch',async()=>{
 for(const input of [{contextWindow:1000000},{contextWindow:'400000'},{contextWindow:-1},{reasoning_effort:'xhigh'},{reasoning_effort:'SAMPLE_SECRET'},{reasoning_effort:0}]){const r=await invoke(input);assert.ok(r.error);assert.equal(r.error.status,400);assert.equal(r.calls,1);assert.equal(r.body,undefined);assert.doesNotMatch(r.error.message,/SAMPLE_SECRET/);}
 const model=raw();delete model.thinking_config.disabled;const r=await invoke({reasoning_effort:'none'},model);assert.equal(r.error.code,'reasoning_effort_not_supported');assert.equal(r.calls,1);
});
test('Qoder existing output cap and missing actual input remain unchanged before dispatch',async()=>{
 const over=await invoke({max_tokens:1025});assert.equal(over.error.code,'provider_output_limit');assert.equal(over.calls,1);
 const missing=await invoke({contextWindow:200000},{...raw(),max_input_tokens:null});assert.equal(missing.error.code,'provider_model_unverified');assert.equal(missing.calls,1);
});
test('Qoder max_completion_tokens intention is projected to native output budget',async()=>{
 const r=await invoke({max_completion_tokens:700});assert.equal(r.error,undefined);assert.equal(r.body.max_tokens,700);assert.equal(r.body.parameters.max_tokens,700);
});
test('Qoder absent HTTP stream body retains a bounded empty-body diagnostic',async()=>{
 const credential={edition:'cn',accessToken:'SAMPLE',uid:'native-wire-empty-'+counter++,principal:'SAMPLE',machineId:'SAMPLE',identity:{machineToken:'SAMPLE',machineCode:'SAMPLE',machineType:'SAMPLE'}};let calls=0;
 await assert.rejects(qoderChat({},credential,{model:'SAMPLE',messages:[]},undefined,{fetchImpl:async url=>{calls++;return url.includes('/model/list')?Response.json({chat:[raw()]}):new Response(null)}}),e=>{assert.equal(e.code,'provider_stream_error');assert.equal(e.qoderFailureReason,'empty_body');assert.match(e.message,/reason=empty_body/);return true});assert.equal(calls,2);
});
