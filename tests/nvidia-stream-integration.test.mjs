import test from 'node:test';
import assert from 'node:assert/strict';
import {nvidiaChat,nvidiaModels} from '../src/nvidia.mjs';
import {Router} from '../src/router.mjs';
import {startServer} from '../src/server.mjs';
import {collectChat,sseEvents} from '../src/openai.mjs';

const model='nvidia/nemotron-3-super-120b-a12b';
const encoder=new TextEncoder();
const event=data=>'data: '+JSON.stringify(data)+'\n\n';
const delta=content=>event({choices:[{index:0,delta:{content},finish_reason:null}]});
const finish=event({choices:[{index:0,delta:{},finish_reason:'stop'}]});
const errorEvent=secret=>'event: error\n'+event({error:{message:'Upstream diagnostic '+secret+' Bearer '+secret}});
const response=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});
let serial=0;
async function fixture(t,produce,{fallback=false}={}){
  const credential={accessToken:'NVIDIA_STREAM_SENTINEL_'+(++serial)+'_DO_NOT_LEAK'},rows=[],calls=[];
  const config={value:{accounts:[{id:'nv-account',label:'Fixture NVIDIA',platform:'nvidia'}],
    upstreams:[{id:'nv',kind:'nvidia',accountId:'nv-account'},{id:'fallback',kind:'nvidia',accountId:'nv-account'}],
    routes:[{id:'nv-route',targets:[{upstreamId:'nv',model},...(fallback?[{upstreamId:'fallback',model}]:[])]}],
    server:{host:'127.0.0.1',port:0,requestTimeoutMs:3000}}};
  const state=new Map();
  const ledger={get:key=>state.get(key),set:(key,value)=>state.set(key,value),beginUsage(row){rows.push({...row});return rows.length-1;},finishUsage(id,row){rows[id]={...row};}};
  const fetchImpl=async(url,options)=>{
    assert.ok(url.startsWith('https://integrate.api.nvidia.com/v1/'));
    assert.equal(options.headers.Authorization,'Bearer '+credential.accessToken);
    if(url.endsWith('/models'))return Response.json({data:[{id:model}]});
    return produce({secret:credential.accessToken,signal:options.signal,body:JSON.parse(options.body)});
  };
  const platforms={models:async()=>nvidiaModels(credential,{fetchImpl}),chat:async(target,input,signal)=>{
    calls.push(target.upstreamId);
    if(target.upstreamId==='fallback')return {response:response(delta('FALLBACK_OK')+finish+'data: [DONE]\n\n')};
    // Mirror Platforms.chat's real NVIDIA branch: provider ID and SSE upstream.
    return nvidiaChat({},credential,{...input,model:target.model,stream:true},signal,{fetchImpl});
  }};
  const router=new Router(config,platforms,{ledger});
  const runtime=await startServer({config,router,ledger,keys:{apiKey:'fixture-client-key',adminKey:'fixture-admin-key'}});
  t.after(()=>runtime.close());
  const request={model:'nv-route',messages:[{role:'user',content:'PRIVATE_PROMPT_NOT_FOR_TELEMETRY'}],stream:true};
  const post=overrides=>fetch(runtime.baseUrl+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer fixture-client-key','Content-Type':'application/json'},body:JSON.stringify({...request,...overrides})});
  return {router,request,post,rows,calls,credential};
}

test('NVIDIA SSE error before first usable token becomes a redacted HTTP error and failed usage',async t=>{
  const f=await fixture(t,({secret})=>response(errorEvent(secret)));
  const r=await f.post(),wire=await r.text();assert.equal(r.status,502);assert.match(wire,/upstream_stream_error/);
  assert.ok(!wire.includes(f.credential.accessToken));assert.match(wire,/REDACTED/);
  assert.equal(f.rows.length,1);assert.equal(f.rows[0].status,'failed');assert.equal(f.rows[0].error.code,'upstream_stream_error');
  assert.ok(!JSON.stringify(f.rows).includes(f.credential.accessToken));assert.ok(!JSON.stringify(f.rows).includes('PRIVATE_PROMPT_NOT_FOR_TELEMETRY'));
});

test('NVIDIA SSE error after first token emits redacted terminal error, never DONE or fallback success',async t=>{
  const f=await fixture(t,({secret})=>response(delta('PARTIAL')+errorEvent(secret)),{fallback:true});
  const r=await f.post(),wire=await r.text();assert.equal(r.status,200);assert.match(wire,/PARTIAL/);assert.match(wire,/event: error/);assert.match(wire,/upstream_stream_error/);
  assert.ok(!wire.includes(f.credential.accessToken));assert.ok(!wire.includes('[DONE]'));assert.ok(!wire.includes('FALLBACK_OK'));
  assert.deepEqual(f.calls,['nv']);assert.equal(f.rows.length,1);assert.equal(f.rows[0].status,'failed');assert.ok(!JSON.stringify(f.rows).includes(f.credential.accessToken));
  const events=[];for await(const e of sseEvents(response(wire).body))events.push(e);
  assert.equal(events.at(-1).event,'error');
});

test('NVIDIA clean EOF without finish or DONE records truncated_stream rather than successful partial reply',async t=>{
  const f=await fixture(t,()=>response(delta('ONLY_HALF')),{fallback:true});
  const r=await f.post(),wire=await r.text();assert.equal(r.status,200);assert.match(wire,/ONLY_HALF/);assert.match(wire,/truncated_stream/);assert.ok(!wire.includes('[DONE]'));
  assert.deepEqual(f.calls,['nv']);assert.equal(f.rows[0].status,'failed');assert.equal(f.rows[0].error.code,'truncated_stream');
});

test('NVIDIA transport disconnect after a usable token remains a failure with redacted network diagnostic',async t=>{
  const f=await fixture(t,({secret})=>{
    let pulls=0;return new Response(new ReadableStream({pull(controller){
      if(pulls++===0)controller.enqueue(encoder.encode(delta('SOCKET_PARTIAL')));
      else controller.error(new Error('mock connection reset '+secret));
    }}),{headers:{'content-type':'text/event-stream'}});
  },{fallback:true});
  const r=await f.post(),wire=await r.text();assert.match(wire,/SOCKET_PARTIAL/);assert.match(wire,/event: error/);assert.ok(!wire.includes('[DONE]'));assert.ok(!wire.includes(f.credential.accessToken));
  assert.equal(f.rows[0].status,'failed');assert.ok(!JSON.stringify(f.rows).includes(f.credential.accessToken));assert.deepEqual(f.calls,['nv']);
});

test('NVIDIA role-only prelude never commits a blank 200 response before an error',async t=>{
  const prelude=event({choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]});
  const f=await fixture(t,({secret})=>response(prelude+errorEvent(secret)));
  const r=await f.post();assert.equal(r.status,502);assert.equal(f.rows[0].firstTokenMs,null);assert.equal(f.rows[0].status,'failed');
  assert.ok(!(await r.text()).includes(f.credential.accessToken));
});

test('NVIDIA fragmented UTF-8 text, split native tool arguments and usage trailer survive adapter and Router',async t=>{
  const f=await fixture(t,()=>{
    const source=delta('你好')+
      event({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'sum',arguments:'{"a":'}}]},finish_reason:null}]})+
      event({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'2,"b":3}'}}]},finish_reason:null}]})+
      event({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+
      event({choices:[],usage:{prompt_tokens:44,completion_tokens:9,total_tokens:53}})+'data: [DONE]\n\n';
    const bytes=encoder.encode(source);let offset=0;
    return new Response(new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(offset,offset+=7));}}),{headers:{'content-type':'text/event-stream'}});
  });
  const result=await collectChat(f.router.chat({...f.request,tools:[{type:'function',function:{name:'sum'}}]}));
  assert.equal(result.choices[0].message.content,'你好');assert.equal(result.choices[0].finish_reason,'tool_calls');assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{a:2,b:3});
  assert.equal(result.usage.total_tokens,53);assert.equal(f.rows[0].status,'completed');assert.equal(f.rows[0].totalTokens,53);
});

test('NVIDIA client iterator closes after first token: upstream cancelled and usage never completed',async t=>{
  let cancelled=false;
  const f=await fixture(t,()=>new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(delta('FIRST')));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  const iterator=f.router.chat(f.request);const first=await iterator.next();assert.equal(first.done,false);await iterator.return();
  assert.equal(cancelled,true);assert.equal(f.rows[0].status,'cancelled');assert.notEqual(f.rows[0].status,'completed');
});

test('NVIDIA response with malformed trailing SSE after first token does not synthesize completion',async t=>{
  const f=await fixture(t,()=>response(delta('BEFORE_BAD_JSON')+'data: {broken\n\n'));
  const r=await f.post(),wire=await r.text();assert.match(wire,/malformed_sse/);assert.ok(!wire.includes('[DONE]'));assert.equal(f.rows[0].status,'failed');
});
