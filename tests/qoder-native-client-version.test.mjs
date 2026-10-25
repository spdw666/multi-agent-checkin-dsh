import test from'node:test';import assert from'node:assert/strict';import{createHash,randomUUID}from'node:crypto';
import{qoderChat,signQoder}from'../src/provider-qoder.mjs';
// Independent shipped-artifact expectation, not read from provider constants:
// Qoder CN0.4.11 worker sha256 8f7869f4a3bec90e7642a126e6af164642316bc7f0f0c5ec7533f7edf817f974;
// runtime-info.json version1.1.75-hotfix.1, created2026-10-22T08:25:09.788Z,
// runtime-info.json sha256 9d769fa651eaf464c2d04dfa9d1692257948414bcd1194038fd2143446828a4e.
// commit cb3c036a38ba56e4a9aba7079186de52ae2e482d. Original artifacts remain unmodified.
const expectedNativeVersion='1.1.75-hotfix.1';
const credential=edition=>({edition,accessToken:'SAMPLE',uid:'version-'+randomUUID(),principal:'SAMPLE',machineId:'SAMPLE-MACHINE',identity:{machineToken:'SAMPLE-TOKEN',machineCode:'SAMPLE-CODE',machineType:'SAMPLE-TYPE'}});
function authPayload(headers){return JSON.parse(Buffer.from(headers.Authorization.slice('Bearer COSY.'.length).split('.')[0],'base64').toString('utf8'))}
function decode(encoded){const std='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$',n=Math.floor(encoded.length/3),b=encoded.slice(encoded.length-n)+encoded.slice(n,encoded.length-n)+encoded.slice(0,n);return JSON.parse(Buffer.from([...b].map(c=>std[custom.indexOf(c)]).join(''),'base64').toString('utf8'))}
for(const edition of ['cn','global']){
 test('Qoder native client version: '+edition+' signed header uses the independently pinned shipped version',()=>{
  const c=credential(edition),host=edition==='cn'?'gateway.qoder.com.cn':'api2.qoder.sh',s=signQoder('https://'+host+'/algo/api/v2/model/list?Encode=1','',c,{encode:false});
  assert.equal(s.headers['Cosy-Version'],expectedNativeVersion);
  assert.equal(s.headers['Cosy-MachineId'],c.machineId);assert.equal(s.headers['Cosy-MachineToken'],c.identity.machineToken);assert.equal(s.headers['Cosy-MachineCode'],c.identity.machineCode);assert.equal(s.headers['Cosy-MachineType'],c.identity.machineType);assert.equal(s.headers['Cosy-ClientType'],'5');
 });
 test('Qoder native client version: '+edition+' COSY payload keeps v1 and empty ideVersion with the new native version',()=>{
  const c=credential(edition),s=signQoder('https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1','',c,{encode:false}),[p,sig]=s.headers.Authorization.slice('Bearer COSY.'.length).split('.'),payload=authPayload(s.headers);
  assert.equal(payload.cosyVersion,expectedNativeVersion);assert.equal(payload.version,'v1');assert.equal(payload.ideVersion,'');
  assert.equal(sig,createHash('md5').update([p,s.headers['Cosy-Key'],s.headers['Cosy-Date'],'','/api/v2/model/list'].join('\n')).digest('hex'));assert.equal(payload.requestId.length,36);assert.ok(payload.info.length>0);
 });
 test('Qoder native client version: '+edition+' actual signed body changes business version only, retaining protocol budget identity and model configuration',async()=>{
  const c=credential(edition),input={model:'qmodel_38max',messages:[{role:'user',content:'SAMPLE'}]},before=structuredClone(input);let captured;
  const result=await qoderChat({},c,input,undefined,{fetchImpl:async(url,options)=>{
   if(url.includes('/model/list'))return Response.json({chat:[{key:'qmodel_38max',display_name:'Qwen3.8-Max',source:'system',format:'openai',is_vl:true,is_reasoning:true,max_input_tokens:180000}]});
   captured={body:decode(options.body),headers:options.headers};return new Response('data: '+JSON.stringify({statusCodeValue:200,body:JSON.stringify({choices:[{delta:{content:'SAMPLE'},finish_reason:'stop'}]})})+'\n\n');
  }});
  await result.response.text();const{body,headers}=captured;
  assert.equal(body.business.version,expectedNativeVersion);assert.equal(headers['Cosy-Version'],expectedNativeVersion);assert.equal(authPayload(headers).cosyVersion,expectedNativeVersion);
  assert.equal(body.version,'3');assert.equal(body.session_type,'qoderclicn');assert.equal(body.source,1);assert.equal(body.business.product,'cli');assert.equal(body.business.type,'agent');assert.equal(body.business.stage,'processing');assert.equal(body.agent_id,'agent_common');assert.equal(body.task_id,'common');
  assert.deepEqual(body.parameters,{max_tokens:1024});assert.equal(body.max_tokens,1024);assert.equal(body.parameters.reasoning_effort,undefined);assert.equal(body.parameters.enable_thinking,undefined);assert.equal(body.parameters.context_length,undefined);
  assert.deepEqual(body.model_config,{key:'qmodel_38max',display_name:'Qwen3.8-Max',model:'',format:'openai',is_vl:true,is_reasoning:true,api_key:'',url:'',source:'system',max_input_tokens:180000});
  assert.equal(body.chat_context.extra.modelConfig.is_reasoning,true);assert.deepEqual(input,before);assert.deepEqual(body.messages,input.messages);assert.equal(headers['X-Model-Key'],'qmodel_38max');assert.equal(headers['X-Model-Source'],'system');
  for(const key of ['request_id','request_set_id','session_id'])assert.equal(body[key].length,36);assert.equal(body.request_id,body.chat_record_id);
 });
}
