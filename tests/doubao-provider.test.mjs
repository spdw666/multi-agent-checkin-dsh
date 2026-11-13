import test from 'node:test';import assert from 'node:assert/strict';
import {DOUBAO_MODELS,doubaoModel,doubaoModels,doubaoCookie,doubaoChat} from '../src/provider-doubao.mjs';

const c={cookie:'sessionid=fixture; sessionid_ss=fixture',deviceId:'810790401142921'};
const enc=new TextEncoder();

// 把豆包 SSE 事件列表拼成 Response；body 走 ReadableStream 以便流式分支按真实 read() 拉取。
const sse=events=>new Response(new ReadableStream({start(ctl){for(const e of events)ctl.enqueue(enc.encode(`event: ${e.event}\ndata: ${typeof e.data==='string'?e.data:JSON.stringify(e.data)}\n\n`));ctl.close();}}),{status:200,headers:{'content-type':'text/event-stream'}});
const chunkOf=text=>({event:'STREAM_CHUNK',data:{patch_op:[{patch_object:1,patch_value:{content_block:[{block_type:10000,content:{text_block:{text}}}]}}]}});
const okStream=(...texts)=>sse([{event:'SSE_HEARTBEAT',data:{}},{event:'SSE_ACK',data:{ack_client_meta:{conversation_id:'1'}}},...texts.map(chunkOf),{event:'SSE_REPLY_END',data:{end_type:1}}]);

async function capture(input,events=okStream('OK')){
  let url,body;
  const {response}=await doubaoChat(c,input,undefined,{fetcher:async(u,o)=>{url=u;body=JSON.parse(o.body);const copy=events.clone?events.clone():events;return new Response(copy.body,{status:copy.status,headers:copy.headers});}});
  return {url:new URL(url),body,response};
}
async function drain(response){const t=await response.text();return t;}

test('catalog exposes exactly the ten client work-mode entries',()=>{
  const rows=doubaoModels();
  assert.equal(rows.length,10);
  assert.deepEqual(rows.map(r=>r.id),['auto','doubao-2.1-lite','doubao-2.1-pro','deepseek-v4.1-flash','kimi-k3.1-pro','kimi-k3.1-pro-highspeed','kimi-k3','glm-5.3','glm-5.3-flash','deepseek-v4-pro']);
  for(const r of rows){assert.equal(r.callable,true);assert.deepEqual(r.reasoning.supportedEfforts,['low','medium','high']);assert.equal(r.reasoning.control,'effort');}
  // 桥实测：9 个模型能被提示词约定驱动出 tool_calls，GLM 5.3 Flash 拒绝，故单独不声明 tools。
  assert.deepEqual(rows.filter(r=>r.tools===true).map(r=>r.id),['auto','doubao-2.1-lite','doubao-2.1-pro','deepseek-v4.1-flash','kimi-k3.1-pro','kimi-k3.1-pro-highspeed','kimi-k3','glm-5.3','deepseek-v4-pro']);
  assert.equal(rows.find(r=>r.id==='glm-5.3-flash').tools,false);
});

test('model keys are the values observed in the client, not i18n labels',()=>{
  const key=id=>DOUBAO_MODELS.find(m=>m.id===id).key;
  assert.equal(key('auto'),'9');
  assert.equal(key('doubao-2.1-pro'),'5');
  assert.equal(key('doubao-2.1-lite'),'seed-lite-7b');
  assert.equal(key('deepseek-v4.1-flash'),'person-deepseek-v4-1-flash-261017');
  assert.equal(key('kimi-k3.1-pro'),'person-kimi-k3-1-pro-261111');
  assert.equal(key('glm-5.3'),'person-glm-5-3-261111');
  assert.equal(key('deepseek-v4-pro'),'person-deepseek-v4-pro-ga-260813');
});

test('doubaoModel resolves bare id, prefixed id and raw model_item_key',()=>{
  assert.equal(doubaoModel('glm-5.3').id,'glm-5.3');
  assert.equal(doubaoModel('doubao/glm-5.3').id,'glm-5.3');
  assert.equal(doubaoModel('person-glm-5-3-261111').id,'glm-5.3');
  assert.equal(doubaoModel('5').id,'doubao-2.1-pro');
  assert.equal(doubaoModel('nope'),null);
  assert.equal(doubaoModel(undefined),null);
});

test('request targets the desktop client endpoint with aid 582478 and device-derived params',async()=>{
  const {url}=await capture({model:'glm-5.3',messages:[{role:'user',content:'fixture'}]});
  assert.equal(url.origin+url.pathname,'https://www.doubao.com/chat/completion');
  assert.equal(url.searchParams.get('aid'),'582478');
  assert.equal(url.searchParams.get('real_aid'),'582478');
  assert.equal(url.searchParams.get('device_id'),'810790401142921');
  assert.equal(url.searchParams.get('fp'),'verify_810790401142921');
  assert.equal(url.searchParams.get('web_id'),'810790401142921');
  assert.equal(url.searchParams.get('tea_uuid'),'810790401142921');
  assert.equal(url.searchParams.get('web_tab_id'),'810790401142921-1');
  assert.equal(url.searchParams.get('doubao_device_platform'),'desktop');
  // 网页版 497858 会被判「访问频繁」，任何位置都不许出现
  for(const v of url.searchParams.values())assert.notEqual(v,'497858');
});

test('body mirrors the client work mode and keeps model_item_key in sync in all three places',async()=>{
  const {body}=await capture({model:'kimi-k3.1-pro',messages:[{role:'user',content:'fixture'}],reasoning_effort:'high'});
  const key='person-kimi-k3-1-pro-261111';
  assert.equal(body.option.conversation_init_ext.model_item_key,key);
  assert.equal(body.option.model_config.model_item_key,key);
  assert.equal(body.option.aggregate_params.model_item_key,key);
  assert.equal(body.option.agent_mode,1);
  assert.equal(body.option.need_deep_think,10001);
  assert.equal(body.option.conversation_init_ext.mode_id,'3');
  assert.equal(body.option.conversation_mode,2);
  assert.equal(body.ext.use_deep_think,'10001');
  assert.equal(body.ext.agent_mode,'1');
  assert.equal(body.option.aggregate_params.reasoning_effort,'5');
  assert.equal(body.option.model_config.reasoning_effort,5);
});

test('every request rotates the correlation fields the server rejects as replay',async()=>{
  const a=(await capture({model:'glm-5.3',messages:[{role:'user',content:'fixture'}],stream:false})).body;
  await new Promise(r=>setTimeout(r,5));
  const b=(await capture({model:'glm-5.3',messages:[{role:'user',content:'fixture'}],stream:false})).body;
  assert.notEqual(a.option.unique_key,b.option.unique_key);
  assert.notEqual(a.messages[0].local_message_id,b.messages[0].local_message_id);
  assert.notEqual(a.messages[0].content_block[0].block_id,b.messages[0].content_block[0].block_id);
  assert.ok(b.option.create_time_ms>=a.option.create_time_ms);
});

test('thread_local_message_id tracks the first message id and ext stays stringified',async()=>{
  const {body}=await capture({model:'glm-5.3',messages:[{role:'user',content:'fixture'}],stream:false});
  const mid=body.messages[0].local_message_id;
  assert.deepEqual(body.option.general_task_param.thread_local_message_id,[mid]);
  assert.equal(typeof body.ext.general_task_param,'string');
  assert.deepEqual(JSON.parse(body.ext.general_task_param).thread_local_message_id,[mid]);
});

test('effort maps to the three wire values the client actually sends',async()=>{
  const wire=async e=>(await capture({model:'glm-5.3',messages:[{role:'user',content:'x'}],reasoning_effort:e,stream:false})).body.option.aggregate_params.reasoning_effort;
  assert.equal(await wire('low'),'3');
  assert.equal(await wire('medium'),'4');
  assert.equal(await wire('high'),'5');
});

test('unoffered effort tiers are refused instead of silently downgraded',async()=>{
  for(const bad of['minimal','xhigh','none','max']){
    await assert.rejects(capture({model:'glm-5.3',messages:[],reasoning_effort:bad}),e=>e.code==='reasoning_effort_not_supported'&&e.status===400);
  }
});

test('omitting effort falls back to the per-model default recorded from the client',async()=>{
  const medium=(await capture({model:'deepseek-v4.1-flash',messages:[{role:'user',content:'x'}],stream:false})).body;
  assert.equal(medium.option.aggregate_params.reasoning_effort,'4');
  const high=(await capture({model:'glm-5.3-flash',messages:[{role:'user',content:'x'}],stream:false})).body;
  assert.equal(high.option.aggregate_params.reasoning_effort,'5');
});

test('unknown model is rejected before any network call',async()=>{
  let called=false;
  await assert.rejects(doubaoChat(c,{model:'gpt-4o',messages:[]},undefined,{fetcher:async()=>{called=true;return okStream();}}),e=>e.code==='model_not_found'&&e.status===400);
  assert.equal(called,false);
});

test('missing cookie is reported as a credential problem, not a transport error',async()=>{
  await assert.rejects(doubaoChat({accessToken:'x'},{model:'glm-5.3',messages:[]},undefined,{fetcher:async()=>okStream()}),e=>e.code==='credential_missing'&&e.status===401);
  assert.equal(doubaoCookie({sessionid:'abc'}),'sessionid=abc; sessionid_ss=abc');
});

test('non-stream aggregates every text block into one chat.completion',async()=>{
  const {response}=await capture({model:'glm-5.3',messages:[{role:'user',content:'x'}],stream:false},okStream('22','\n') );
  const json=await response.json();
  assert.equal(json.object,'chat.completion');
  assert.equal(json.choices[0].message.content,'22\n');
  assert.equal(json.choices[0].finish_reason,'stop');
  assert.equal(json.model,'glm-5.3');
});

test('stream emits role, deltas, one finish and exactly one DONE',async()=>{
  const {response}=await capture({model:'glm-5.3',messages:[{role:'user',content:'x'}],stream:true},okStream('2','2'));
  const text=await drain(response);
  assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');
  assert.equal((text.match(/data: \[DONE\]/g)??[]).length,1);
  const frames=text.split('\n\n').filter(Boolean).map(f=>f.replace(/^data: /,''));
  const objs=frames.filter(f=>f!=='[DONE]').map(f=>JSON.parse(f));
  assert.equal(objs[0].choices[0].delta.role,'assistant');
  assert.deepEqual(objs.filter(o=>o.choices[0].delta.content).map(o=>o.choices[0].delta.content),['2','2']);
  assert.equal(objs.filter(o=>o.choices[0].finish_reason==='stop').length,1);
});

test('stream still terminates when the server never sends reply-end',async()=>{
  const {response}=await capture({model:'glm-5.3',messages:[{role:'user',content:'x'}],stream:true},sse([{event:'SSE_ACK',data:{}},chunkOf('7')]));
  const text=await drain(response);
  assert.ok(text.includes('"content":"7"'));
  assert.equal((text.match(/data: \[DONE\]/g)??[]).length,1);
});

test('rate-limit codes surface as 429 so the router can cool the account down',async()=>{
  for(const code of[710022002,710022004,710022013]){
    const events=sse([{event:'SSE_HEARTBEAT',data:{}},{event:'STREAM_ERROR',data:{error_code:code,error_msg:'系统错误',extra:{ack:'1'}}}]);
    await assert.rejects(capture({model:'glm-5.3',messages:[{role:'user',content:'x'}]},events),e=>e.status===429&&e.code==='doubao_rate_limited'&&String(e.message).includes(String(code)));
  }
});

test('expired login surfaces as 401',async()=>{
  const err=async code=>capture({model:'glm-5.3',messages:[{role:'user',content:'x'}]},sse([{event:'STREAM_ERROR',data:{error_code:code,error_msg:'x'}}]));
  await assert.rejects(err(710012001),e=>e.status===401);
  await assert.rejects(err(710012000),e=>e.status===401);
});

test('non-200 with a json error body is not mistaken for stream content',async()=>{
  await assert.rejects(capture({model:'glm-5.3',messages:[{role:'user',content:'x'}]},new Response(JSON.stringify({error_code:710020202,error_msg:'common invalid param'}),{status:200,headers:{'content-type':'application/json'}})),e=>e.code==='doubao_upstream_error'&&e.status===400);
});

test('a stream that closes before any event is an explicit failure',async()=>{
  await assert.rejects(capture({model:'glm-5.3',messages:[{role:'user',content:'x'}]},sse([])),e=>e.code==='doubao_empty_stream');
});

test('multi-turn is flattened into one in-band conversation block',async()=>{
  const {body}=await capture({model:'glm-5.3',messages:[{role:'user',content:'hi'},{role:'assistant',content:'hello'},{role:'user',content:'again'}],system:'be brief',stream:false});
  const text=body.messages[0].content_block[0].content.text_block.text;
  assert.ok(text.includes('<|im_start|>system'));
  assert.ok(text.includes('be brief'));
  assert.ok(text.includes('again'));
  assert.equal(body.messages.length,1);
});

const TOOL=[{type:'function',function:{name:'audit_add',description:'把两个数字相加',parameters:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}}}];

test('tools bridge turns a contract-shaped reply into tool_calls',async()=>{
  let calls=0,bodies=[];
  const fetcher=async(u,o)=>{calls++;bodies.push(JSON.parse(o.body));return okStream('{"tool_calls":[{"name":"audit_add","arguments":{"a":2,"b":3}}]}');};
  const {response}=await doubaoChat(c,{model:'deepseek-v4.1-flash',tools:TOOL,stream:false,messages:[{role:'user',content:'add 2 and 3'}]},undefined,{fetcher});
  const j=await response.json();
  assert.equal(calls,1);
  assert.equal(j.choices[0].finish_reason,'tool_calls');
  assert.equal(j.choices[0].message.tool_calls[0].function.name,'audit_add');
  assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments),{a:2,b:3});
  // 工具定义必须以「调用方约定」写进 user 文本，并带参数 schema；写进 system 会被部分模型判成注入。
  const text=bodies[0].messages[0].content_block[0].content.text_block.text;
  assert.ok(text.includes('audit_add'));
  assert.ok(text.includes('tool_calls'));
  // 契约只带名称与参数名（完整 schema 在 351 个工具时会撑到十万字符被上游判 710020202）。
  assert.ok(text.includes('audit_add(a, b)'));
  assert.ok(!('system' in (bodies[0].messages[0])));
});

test('tools bridge returns the plain answer without burning a retry',async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;return okStream('我不会调用这个工具');};
  const {response}=await doubaoChat(c,{model:'glm-5.3-flash',tools:TOOL,stream:false,messages:[{role:'user',content:'add'}]},undefined,{fetcher});
  const j=await response.json();
  // 当前实现不重试：把同一条契约再发一次只会重复一次拒绝，白烧一轮额度。
  assert.equal(calls,1);
  assert.equal(j.choices[0].finish_reason,'stop');
  assert.equal(j.choices[0].message.content,'我不会调用这个工具');
  assert.equal(j.choices[0].message.tool_calls,undefined);
});

test('tools bridge streams tool_calls in one delta and closes exactly once',async()=>{
  const fetcher=async()=>okStream('{"tool_calls":[{"name":"audit_add","arguments":{"a":5,"b":6}}]}');
  const {response}=await doubaoChat(c,{model:'kimi-k3.1-pro',tools:TOOL,stream:true,messages:[{role:'user',content:'add'}]},undefined,{fetcher});
  const text=await response.text();
  assert.ok(text.includes('"tool_calls"'));
  assert.ok(text.includes('"finish_reason":"tool_calls"'));
  assert.equal(text.split('[DONE]').length-1,1);
});

test('tool results and assistant tool_calls survive flattening into one turn',async()=>{
  const {body}=await capture({model:'glm-5.3',stream:false,messages:[
    {role:'user',content:'add 2 and 3'},
    {role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'audit_add',arguments:'{"a":2,"b":3}'}}]},
    {role:'tool',name:'audit_add',content:'5'},
  ]});
  const text=body.messages[0].content_block[0].content.text_block.text;
  assert.ok(text.includes('audit_add'));
  assert.ok(text.includes('[调用方程序返回的结果 / audit_add] 5'));
});