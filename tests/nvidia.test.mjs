import test from 'node:test';
import assert from 'node:assert/strict';
import {nvidiaModels,nvidiaHealth,nvidiaChat,nvidiaQuota,emptyNvidiaQuota,nvidiaFetch} from '../src/nvidia.mjs';
const id='nvidia/nemotron-3-super-120b-a12b',ds='deepseek-ai/deepseek-v4.1-flash';
const creds=s=>({accessToken:'fixture-nvidia-key-'+s});
const list=(rows=[{id}],headers={})=>Response.json({data:rows},{headers});
const chat=(headers={})=>Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]},{headers});
const input={model:id,messages:[{role:'user',content:'Hello'}],max_tokens:64};
test('NVIDIA maps Pi max_completion_tokens to official max_tokens without dropping the output budget',async()=>{let body;await nvidiaChat({},creds('alias'),{model:id,messages:input.messages,max_completion_tokens:32768},undefined,{fetchImpl:async(url,o)=>{body=JSON.parse(o.body);return chat()}});assert.equal(body.max_tokens,32768);assert.equal(body.max_completion_tokens,undefined)});
test('NVIDIA rejects conflicting output budget aliases before network',async()=>{let calls=0;await assert.rejects(nvidiaChat({},creds('alias-conflict'),{...input,max_completion_tokens:128},undefined,{fetchImpl:async()=>{calls++;return chat()}}),{code:'nvidia_max_tokens_conflict'});assert.equal(calls,0)});
test('NVIDIA validates aliased output budgets against model metadata before network',async()=>{let calls=0;for(const n of [null,0,-1,1.1,32769])await assert.rejects(nvidiaChat({},creds('alias-cap'),{model:id,messages:input.messages,max_completion_tokens:n},undefined,{fetchImpl:async()=>{calls++;return chat()}}),{code:'nvidia_max_tokens_invalid'});assert.equal(calls,0)});
test('NVIDIA fixed official model endpoint, auth header, and exact reviewed metadata',async()=>{
  const c=creds('models'),rows=await nvidiaModels(c,{fetchImpl:async(url,o)=>{
    assert.equal(url,'https://integrate.api.nvidia.com/v1/models');assert.equal(o.method,'GET');assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,'Bearer '+c.accessToken);
    return list([{id},{id:ds},{id},{id:'future-llm',context_length:1000000,tools:true},{id:'embedding'},{id:null}]);
  }});
  assert.equal(rows.filter(x=>x.freeEndpoint).length,38);assert.equal(rows.length,40);
  assert.deepEqual([id,ds].map(id=>{const x=rows.find(m=>m.id===id);return [x.contextWindow,x.maxTokens,x.tools]}),[[1048576,32768,true],[1048576,1048576,true]]);
  for(const name of ['future-llm','embedding']){const r=rows.find(x=>x.id===name);assert.equal(r.callable,false);assert.equal(r.contextWindow,undefined);assert.equal(r.tools,false);}
  assert.ok(rows.every(x=>x.verification==='unverified'));assert.equal(rows.find(x=>x.id===ds).multimodal,true);
});
test('NVIDIA catalog reachability is not authenticated generation or a daily quota',async()=>{
  const h=await nvidiaHealth(creds('unknown'),{fetchImpl:async()=>list()});
  assert.equal(h.status,'catalog_reachable');assert.equal(h.quota.credentialStatus,'catalog_verified');
  for(const k of ['dailyLimit','remaining','requestLimit','requestRemaining','tokenLimit','tokenRemaining','resetAt','retryAfterSeconds'])assert.equal(h.quota[k],null);
  assert.equal(h.quota.source,'official_policy');assert.equal(emptyNvidiaQuota().remaining,null);
});
test('NVIDIA missing credentials cause zero network calls',async()=>{
  let calls=0;await assert.rejects(nvidiaModels({}, {fetchImpl:async()=>{calls++;return list()}}),{code:'nvidia_key_missing'});assert.equal(calls,0);
});
test('NVIDIA rate-limit header observations retain nulls, account isolation and finite lifetime',async()=>{
  const c=creds('quotas'),now=Date.parse('2026-10-11T03:00:00Z');
  await nvidiaChat({},c,input,undefined,{now,fetchImpl:async()=>chat({'x-ratelimit-limit-requests':'12','x-ratelimit-remaining-requests':'0','x-ratelimit-limit-tokens':'10000','x-ratelimit-remaining-tokens':'999','x-ratelimit-reset-requests':'1m30s','retry-after':'90'})});
  const q=nvidiaQuota(c,{now});assert.equal(q.requestLimit,12);assert.equal(q.requestRemaining,0);assert.equal(q.tokenLimit,10000);assert.equal(q.tokenRemaining,999);assert.equal(q.resetAt,'2026-10-11T03:01:30.000Z');assert.equal(q.retryAfterSeconds,90);assert.equal(q.credentialStatus,'authenticated');assert.equal(q.source,'official_response_headers');assert.equal(q.dailyLimit,null);
  const h=await nvidiaHealth(c,{now:now+1000,fetchImpl:async()=>list()});assert.equal(h.quota.requestRemaining,0);assert.equal(h.quota.observedAt,q.observedAt);
  assert.equal(nvidiaQuota(creds('different-account'),{now}).requestLimit,null);assert.equal(nvidiaQuota(c,{now:now+300001}).requestLimit,null);
  q.requestRemaining=777;assert.equal(nvidiaQuota(c,{now}).requestRemaining,0);
  await nvidiaChat({},c,input,undefined,{now:now+300002,fetchImpl:async()=>chat()});
  const fresh=nvidiaQuota(c,{now:now+300002});assert.equal(fresh.credentialStatus,'authenticated');assert.equal(fresh.requestRemaining,null);
});
test('NVIDIA invalid rate headers stay unknown and Retry-After date is parsed',async()=>{
  const now=Date.parse('2026-10-11T03:00:00Z'),c=creds('dates');
  const h=await nvidiaHealth(c,{now,fetchImpl:async()=>list(undefined,{'x-ratelimit-limit-requests':'40RPM','x-ratelimit-remaining-requests':'-1','x-ratelimit-reset-requests':'nonsense','retry-after':'Sun, 11 Oct 2026 03:02:00 GMT'})});
  assert.equal(h.quota.requestLimit,null);assert.equal(h.quota.requestRemaining,null);assert.equal(h.quota.resetAt,null);assert.equal(h.quota.retryAfterSeconds,120);
});
test('NVIDIA chat preserves tool calls/results and allows only documented body fields',async()=>{
  const messages=[{role:'user',content:'Add'},{role:'assistant',tool_calls:[{id:'t1',type:'function',function:{name:'sum',arguments:'{"a":1}'}}]},{role:'tool',tool_call_id:'t1',content:'2'}],tools=[{type:'function',function:{name:'sum',parameters:{type:'object'}}}];
  const result=await nvidiaChat({baseUrl:'https://untrusted.invalid'},creds('tools'),{...input,messages,tools,tool_choice:'auto',apiKey:'discard',reasoning_effort:'none'},undefined,{fetchImpl:async(url,o)=>{assert.equal(url,'https://integrate.api.nvidia.com/v1/chat/completions');const body=JSON.parse(o.body);assert.deepEqual(body.messages,messages);assert.deepEqual(body.tools,tools);assert.equal(body.tool_choice,'auto');assert.equal(body.apiKey,undefined);assert.equal(body.chat_template_kwargs.enable_thinking,false);return chat();}});
  assert.equal((await result.response.json()).choices[0].message.content,'OK');assert.deepEqual(result.input.messages,messages);
});
test('NVIDIA SSE is returned without buffering or losing tool deltas',async()=>{
  const sse='data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"sum","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
  const r=await nvidiaChat({},creds('sse'),{...input,stream:true},undefined,{fetchImpl:async()=>new Response(sse,{headers:{'content-type':'text/event-stream'}})});
  assert.equal(await r.response.text(),sse);assert.equal(r.input.stream,true);
});
test('NVIDIA request abort propagates while waiting and before fetch',async()=>{
  const a=new AbortController();a.abort();let calls=0;
  await assert.rejects(nvidiaModels(creds('abort1'),{signal:a.signal,fetchImpl:async()=>{calls++;return list()}}),{code:'request_cancelled'});assert.equal(calls,0);
  const b=new AbortController(),p=nvidiaModels(creds('abort2'),{signal:b.signal,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  setTimeout(()=>b.abort(),5);await assert.rejects(p,{code:'request_cancelled'});
});
test('NVIDIA bounded catalog JSON rejects oversize and schema changes',async()=>{
  await assert.rejects(nvidiaModels(creds('large'),{fetchImpl:async()=>new Response(' '.repeat(4*1024*1024+1))}),{code:'nvidia_response_too_large'});
  await assert.rejects(nvidiaModels(creds('invalid'),{fetchImpl:async()=>new Response('{')}),{code:'nvidia_invalid_response'});
  await assert.rejects(nvidiaModels(creds('schema'),{fetchImpl:async()=>Response.json({data:{}})}),{code:'nvidia_catalog_schema'});
});
test('NVIDIA auth, throttling, redirects and network errors never echo key or provider body',async()=>{
  const c=creds('SECRET');for(const [status,code]of [[401,'nvidia_auth_failed'],[403,'nvidia_auth_failed'],[429,'nvidia_rate_limited'],[302,'nvidia_redirect_rejected'],[500,'nvidia_upstream_error']]){
    await assert.rejects(nvidiaModels(c,{fetchImpl:async()=>new Response(c.accessToken,{status,headers:{'retry-after':'20'}})}),e=>e.code===code&&!e.message.includes(c.accessToken));
  }
  await assert.rejects(nvidiaModels(c,{fetchImpl:async()=>{throw Error(c.accessToken)}}),e=>e.code==='nvidia_network_error'&&!e.message.includes(c.accessToken));
});
test('NVIDIA failed authentication clears stale quota observations',async()=>{
  const c=creds('invalidate');await nvidiaHealth(c,{fetchImpl:async()=>list(undefined,{'x-ratelimit-remaining-requests':'4'})});
  await assert.rejects(nvidiaModels(c,{fetchImpl:async()=>new Response('',{status:401})}));
  const q=nvidiaQuota(c);assert.equal(q.credentialStatus,'rejected');assert.equal(q.requestRemaining,null);
  await nvidiaHealth(c,{fetchImpl:async()=>list()});assert.equal(nvidiaQuota(c).credentialStatus,'rejected');
});
test('NVIDIA private loopback proxy is validated without global environment mutation',async()=>{
  const before=process.env.HTTPS_PROXY;
  const c={...creds('proxy'),proxyUrl:'http://127.0.0.1:7890'};
  await nvidiaModels(c,{fetchImpl:async(url,o)=>{assert.equal(o.nvidiaProxyUrl,'http://127.0.0.1:7890/');return list()}});assert.equal(process.env.HTTPS_PROXY,before);
  for(const proxyUrl of ['https://evil.invalid','http://user:pass@127.0.0.1:7890','http://127.0.0.1:7890/path'])await assert.rejects(nvidiaModels({...c,proxyUrl},{fetchImpl:async()=>list()}),{code:'nvidia_proxy_invalid'});
  assert.throws(()=>nvidiaFetch('https://evil.invalid/v1/models'),{code:'nvidia_endpoint_invalid'});
});
test('NVIDIA rejects unknown model metadata, excessive output, and undeclared reasoning without fetch',async()=>{
  let calls=0;const options={fetchImpl:async()=>{calls++;return chat()}};
  await assert.rejects(nvidiaChat({},creds('guard'),{...input,model:'unknown'},undefined,options),{code:'nvidia_model_metadata_unknown'});
  await assert.rejects(nvidiaChat({},creds('guard'),{...input,max_tokens:32769},undefined,options),{code:'nvidia_max_tokens_invalid'});
  await assert.rejects(nvidiaChat({},creds('guard'),{...input,reasoning_effort:'max'},undefined,options),{code:'reasoning_effort_not_supported'});assert.equal(calls,0);
});
test('NVIDIA honors server Retry-After with bounded account cooldown and exposes seconds',async()=>{const c=creds('cooldown');let calls=0;const fetchImpl=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'20'}});};await assert.rejects(nvidiaChat({},c,input,undefined,{fetchImpl,now:100000}),e=>e.status===429&&e.retryAfterSeconds===20);await assert.rejects(nvidiaChat({},c,input,undefined,{fetchImpl,now:105000}),e=>e.retryAfterSeconds===15);assert.equal(calls,1);await assert.rejects(nvidiaChat({},c,input,undefined,{fetchImpl,now:121000}),e=>e.retryAfterSeconds===20);assert.equal(calls,2);});

test('NVIDIA Kimi K3 documented low reasoning passes through with reasoning history intact',async()=>{let body;const messages=[{role:'user',content:'x'},{role:'assistant',content:null,reasoning_content:'fixture reasoning',tool_calls:[{id:'t',type:'function',function:{name:'f',arguments:'{}'}}]},{role:'tool',tool_call_id:'t',content:'5'}];await nvidiaChat({},creds('kimi-low'),{model:'moonshotai/kimi-k3',messages,max_tokens:4096,reasoning_effort:'low'},undefined,{fetchImpl:async(url,o)=>{body=JSON.parse(o.body);return chat()}});assert.equal(body.reasoning_effort,'low');assert.deepEqual(body.messages,messages);assert.equal(body.chat_template_kwargs,undefined)});
test('NVIDIA Kimi reasoning default is left to upstream, not silently reduced for user chats',async()=>{const r=await nvidiaChat({},creds('kimi-default'),{model:'moonshotai/kimi-k3',messages:input.messages,max_tokens:64},undefined,{fetchImpl:async()=>chat()});assert.equal(r.input.reasoning_effort,undefined)});
test('NVIDIA Kimi rejects unsupported thinking off and arbitrary effort before network',async()=>{for(const effort of ['none','medium','ultra'])await assert.rejects(nvidiaChat({},creds('kimi-invalid'),{model:'moonshotai/kimi-k3',messages:input.messages,reasoning_effort:effort},undefined,{fetchImpl:async()=>{throw Error('network should not occur')}}),{code:'reasoning_effort_not_supported'})});
