import test from 'node:test';import assert from 'node:assert/strict';
import{pathToFileURL}from'node:url';
const{unwrapQoderSSE}=await import(process.env.TEST_QODER_MODULE?pathToFileURL(process.env.TEST_QODER_MODULE).href:new URL('../src/provider-qoder.mjs',import.meta.url).href);
const consume=body=>new Response(unwrapQoderSSE(body)).text();
const source=text=>new Response(text).body;
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
const chunk=value=>frame({body:typeof value==='string'?value:JSON.stringify(value)});
const failure=async(body,reason,extra={})=>{
 let error;try{await consume(body)}catch(e){error=e}assert.ok(error);assert.equal(error.code,'provider_stream_error');assert.equal(error.status,502);assert.equal(error.qoderFailureReason,reason);for(const[key,value]of Object.entries(extra))assert.equal(error[key],value);return error;
};
test('Qoder stream preserves only bounded business code/status and releases the upstream reader',async()=>{
 const raw=source(chunk({error:{code:3012,status:403,message:'SAMPLE-SECRET-RAW',request:'SAMPLE-PRIVATE'}}));
 const e=await failure(raw,'upstream_business_error',{upstreamCode:3012,upstreamStatus:403});assert.match(e.message,/upstreamCode=3012/);assert.match(e.message,/upstreamStatus=403/);assert.doesNotMatch(JSON.stringify(e)+e.message,/SAMPLE-SECRET|SAMPLE-PRIVATE/);assert.equal(raw.locked,false);const{errorView}=await import('../src/util.mjs');assert.match(errorView(e).message,/upstreamCode=3012/);
});
test('Qoder explicit envelope error is not discarded by headers or a contradictory body',async()=>{
 for(const packet of [{headers:{private:'SAMPLE_SECRET'},error:{code:103,status:400,message:'SAMPLE_SECRET'}},{body:JSON.stringify({choices:[{finish_reason:'stop'}]}),error:{code:103,status:400}}]){const e=await failure(source(frame(packet)),'upstream_business_error',{upstreamCode:103,upstreamStatus:400});assert.doesNotMatch(e.message,/SAMPLE_SECRET/);}
});
test('Qoder stream permits a closed machine-code enum, never arbitrary token-shaped code text',async()=>{
 const e=await failure(source(chunk({error:{code:'PERMISSION_DENIED',status:403,message:'RAW'}})),'upstream_business_error',{upstreamCode:'permission_denied'});assert.doesNotMatch(e.message,/RAW/);
 const bad=await failure(source(chunk({error:{code:'SAMPLE_SECRET_TOKEN_123',message:'RAW'}})),'upstream_business_error');assert.equal(bad.upstreamCode,undefined);assert.doesNotMatch(bad.message,/SAMPLE_SECRET|RAW/);
});
test('Qoder numeric business-code strings retain their type and bounded zero values',async()=>{
 await failure(source(chunk({error:{code:'00103',status_code:'429'}})),'upstream_business_error',{upstreamCode:'00103',upstreamStatus:429});
 await failure(source(chunk({error:{code:0,status:0}})),'upstream_business_error',{upstreamCode:0,upstreamStatus:undefined});
});
test('Qoder malformed outer JSON reports parser stage without echoing frame text',async()=>{
 const e=await failure(source('data: {SAMPLE_RAW_AUTH\n\n'),'invalid_frame_json');assert.doesNotMatch(e.message,/SAMPLE_RAW_AUTH/);
});
test('Qoder malformed nested body reports parser stage and safe envelope code only',async()=>{
 const e=await failure(source(frame({body:'SAMPLE_RAW_AUTH',code:103,status:400})),'invalid_body_json',{upstreamCode:103,upstreamStatus:400});assert.doesNotMatch(e.message,/SAMPLE_RAW_AUTH/);
});
test('Qoder malformed JSON roots and choices are classified as parser-shape failures',async()=>{
 for(const raw of ['[]','123'])await failure(source('data: '+raw+'\n\n'),'invalid_frame_shape');
 for(const body of ['[]'])await failure(source(frame({body})),'invalid_body_shape');
 for(const choices of [{},[null]])await failure(source(chunk({choices})),'invalid_choices');
});
test('Qoder incomplete frame is distinct from a stream missing its terminal marker',async()=>{
 await failure(source('data: {"SAMPLE":"unfinished"}'),'incomplete_frame');
 await failure(source(chunk({choices:[{delta:{content:'SAMPLE'}}]})),'missing_finish');
});
test('Qoder frame limit rejects oversized data without retaining raw data',async()=>{
 const e=await failure(source('data: '+ 'SAMPLE_SECRET'.repeat(360000)),'frame_limit');assert.ok(e.message.length<200);assert.equal(e.upstreamCode,undefined);
});
test('Qoder transport and forged AppError text do not bypass diagnostic sanitization',async()=>{
 const {AppError}=await import('../src/util.mjs');
 for(const e of [new Error('SAMPLE_RAW_AUTH'),new AppError('SAMPLE_RAW_AUTH',502,'provider_stream_error')]){
  const body=new ReadableStream({pull(ctrl){ctrl.error(e)}});const error=await failure(body,'transport_error');assert.doesNotMatch(error.message,/SAMPLE_RAW_AUTH/);assert.equal(body.locked,false);
 }
});
test('Qoder success/tool/usage/CRLF streams keep exact fields and one DONE',async()=>{
 const text=(frame({headers:{request:'SAMPLE'}})+chunk({choices:[{delta:{tool_calls:[{index:0,id:'SAMPLE-call',function:{name:'read',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+chunk({choices:[],usage:{prompt_tokens:5,completion_tokens:3}})+chunk('[DONE]')).replaceAll('\n','\r\n');let at=0;
 const body=new ReadableStream({pull(ctrl){if(at===text.length)return ctrl.close();ctrl.enqueue(new TextEncoder().encode(text[at++]));}});const result=await consume(body);assert.match(result,/SAMPLE-call/);assert.match(result,/prompt_tokens/);assert.equal(result.match(/\[DONE\]/g).length,1);assert.equal(body.locked,false);
});
test('Qoder consumer cancellation reaches source and releases lock',async()=>{
 let cancelled=false;const body=new ReadableStream({pull(ctrl){ctrl.enqueue(new TextEncoder().encode(chunk({choices:[{delta:{content:'SAMPLE'}}]})));},cancel(){cancelled=true}});const reader=unwrapQoderSSE(body).getReader();await reader.read();await reader.cancel('SAMPLE');assert.equal(cancelled,true);assert.equal(body.locked,false);
});
const native=(body,statusCodeValue=200,extra={})=>({statusCodeValue,statusCode:statusCodeValue===200?'OK':'ERROR',body:typeof body==='string'?body:JSON.stringify(body),...extra});
const answer=(finish='stop')=>({choices:[{index:0,delta:{content:'SAMPLE'},...(finish?{finish_reason:finish}:{})}]});
const eventFrame=(event,value)=>'event: '+event+'\n'+frame(value);
test('Qoder native wrapper: numeric200 is success independently of statusCode label or plain code',async()=>{
 for(const extra of [{statusCode:'OK',code:0},{statusCode:'SAMPLE',code:'0'},{statusCode:500}]){const result=await consume(source(frame(native(answer(),200,extra))));assert.match(result,/SAMPLE/);assert.equal(result.match(/\[DONE\]/g).length,1);}
});
test('Qoder native wrapper: numeric0 and string0 plain control packets are not business errors',async()=>{
 for(const code of [0,'0']){const result=await consume(source(frame({code})+frame(native(answer()))));assert.match(result,/SAMPLE/);}
});
test('Qoder native wrapper: non200 status wins even when body has code0 or valid choices',async()=>{
 for(const status of [400,403,429,500])for(const body of [{code:0,message:'SAMPLE_SECRET'},answer()]){const e=await failure(source(frame(native(body,status))),'upstream_packet_status',{upstreamStatus:status});assert.doesNotMatch(e.message,/SAMPLE_SECRET/);if(body.code===0)assert.equal(e.upstreamCode,0);}
});
test('Qoder native wrapper: finish event permits empty or auxiliary bodies, including non200 finish status',async()=>{
 for(const body of ['', ' ', JSON.stringify({cost:1}), 'SAMPLE-nonJSON-finish-metadata']){const result=await consume(source(frame(native(answer(null)))+eventFrame('finish',native(body,500))));assert.match(result,/SAMPLE/);assert.equal(result.match(/\[DONE\]/g).length,1);}
});
test('Qoder native wrapper: null payload and null choices are controls while usage remains available',async()=>{
 const text=frame(null)+frame(native('null'))+frame({...native(''),body:null})+frame({choices:null})+frame(native({choices:null,usage:{prompt_tokens:5,completion_tokens:0}}))+frame(native(answer()));
 const result=await consume(source(text));assert.match(result,/SAMPLE/);assert.match(result,/prompt_tokens/);assert.match(result,/"choices":\[\]/);
});
test('Qoder native wrapper: native payload permits EOF while legacy unmarked truncation stays protected',async()=>{
 const result=await consume(source(frame(native(answer(null)))));assert.match(result,/SAMPLE/);assert.equal(result.match(/\[DONE\]/g).length,1);
 await failure(source(chunk(answer(null))),'missing_finish');
});
test('Qoder native wrapper: successful body precedes contradictory outer error, direct headers error still fails',async()=>{
 const result=await consume(source(frame(native(answer(),200,{error:{code:103,message:'SAMPLE_SECRET'}}))));assert.match(result,/SAMPLE/);assert.doesNotMatch(result,/SAMPLE_SECRET/);
 await failure(source(frame({headers:{},error:{code:103,status:403}})),'upstream_business_error',{upstreamCode:103,upstreamStatus:403});
});
test('Qoder native wrapper: recoverable parser/body-shape faults cannot poison a later native payload',async()=>{
 for(const first of [frame(native('SAMPLE-notJSON')),frame(native('[]')),frame({...native(''),body:{choices:[]}}),'data: {bad-json\n\n']){const result=await consume(source(first+frame(native(answer()))));assert.match(result,/SAMPLE/);}
 await failure(source(frame(native('SAMPLE-notJSON'))),'invalid_body_json',{upstreamStatus:200});
 await failure(source(frame({...native(''),body:{choices:[]}})),'invalid_wrapper_body',{upstreamStatus:200});
});
test('Qoder native wrapper: native control markers outside and inside body do not become malformed JSON',async()=>{
 const markers=['[NOT_EXCEED_QUOTA]','[EXCEED_QUOTA]SAMPLE','[NOTIFICATIONS]#{}'];let text='';for(const marker of markers)text+='data: '+marker+'\n\n'+frame(native(marker));text+=frame(native(answer()));assert.match(await consume(source(text)),/SAMPLE/);
});
test('Qoder native wrapper: finish exemption never hides a parsed body error',async()=>{
 await failure(source(eventFrame('finish',native({error:{code:103,status:403,message:'SAMPLE_SECRET'}},500))),'upstream_business_error',{upstreamCode:103,upstreamStatus:403});
});
test('Qoder native wrapper: numeric200 success is not inferred from string200',async()=>{
 await failure(source(frame(native(answer(),'200'))),'upstream_packet_status',{upstreamStatus:200});
});
