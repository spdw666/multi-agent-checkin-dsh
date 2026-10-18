import test from 'node:test';import assert from 'node:assert/strict';
import {Router} from '../src/router.mjs';import {collectChat} from '../src/openai.mjs';
const id='deepseek-v4.1-flash',publicId='client/'+id;
const NL=String.fromCharCode(10);
const sse=(deltas)=>new Response('data: '+JSON.stringify({choices:deltas})+NL+NL+'data: [DONE]'+NL+NL,{headers:{'content-type':'text/event-stream'}});
function fixture(reply){
  const calls=[],rows=[],values=new Map();
  const config={value:{server:{requestTimeoutMs:10000},accounts:[{id:'p',platform:'codebuddy'}],upstreams:[{id:'p',kind:'codebuddy',accountId:'p'}],routes:[{id:publicId,targets:[{upstreamId:'p',model:id}]}],modelRelay:{enabled:true}}};
  const platforms={models:async()=>[{id,callable:true,tools:true,maxTokens:8192,reasoningEfforts:{low:'low',max:'max'}}],chat:async(t,r)=>{calls.push({t,r});return{response:reply()}}};
  const ledger={get:k=>values.get(k),set:(k,v)=>{values.set(k,v);},record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(i,r)=>rows[i]=r};
  return {router:new Router(config,platforms,{ledger}),rows,values,calls,config};
}
const request={model:publicId,messages:[{role:'user',content:'继续'}],max_tokens:16,stream:true};

test('reasoning-only answer with empty body is reported as a caller budget problem, not an upstream outage',async()=>{
  const f=fixture(()=>(sse([{delta:{reasoning_content:'想一想'},finish_reason:null},{delta:{},finish_reason:'length'}])));
  await assert.rejects(collectChat(f.router.chat(request)),e=>{assert.equal(e.code,'reasoning_budget_exhausted');assert.equal(e.status,400);return true;});
  assert.equal(f.rows[0].error.code,'reasoning_budget_exhausted');
  const cooldowns=[...f.values.keys()].filter(k=>k.startsWith('relay-cooldown:'));
  assert.deepEqual(cooldowns,[]);
});

test('a genuinely empty upstream answer keeps the original 502 empty_response',async()=>{
  const f=fixture(()=>(sse([{delta:{},finish_reason:null},{delta:{},finish_reason:'stop'}])));
  await assert.rejects(collectChat(f.router.chat(request)),e=>{assert.equal(e.code,'empty_response');assert.equal(e.status,502);return true;});
  assert.equal(f.rows[0].error.code,'empty_response');
});

test('content still wins over reasoning and is delivered unchanged',async()=>{
  const f=fixture(()=>(sse([{delta:{reasoning_content:'thought'},finish_reason:null},{delta:{content:'OK'},finish_reason:null},{delta:{},finish_reason:'stop'}])));
  const out=await collectChat(f.router.chat(request));
  assert.equal(out.choices[0].message.content,'OK');
  assert.equal(out.choices[0].message.reasoning_content,'thought');
});
