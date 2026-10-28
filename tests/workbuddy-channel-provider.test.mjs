import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const at=path=>process.env.WORKBUDDY_CHANNEL_TEST_ROOT?pathToFileURL(resolve(process.env.WORKBUDDY_CHANNEL_TEST_ROOT,path)).href:new URL('../'+path,import.meta.url).href;
const {Platforms}=await import(at('src/platforms.mjs'));
const {WorkBuddyUpstreamClient}=await import(at('vendor/workbuddy-core.mjs'));

function fixture(result, {edition='ai',domain='www.workbuddy.ai'}={}) {
  const config={value:{accounts:[{id:'SAMPLE_ACCOUNT',platform:'workbuddy',edition,enabled:true}],upstreams:[{id:'SAMPLE_UPSTREAM',kind:'workbuddy',accountId:'SAMPLE_ACCOUNT',enabled:true}]}};
  let resolves=0,sends=0;
  const credential={accessToken:'SAMPLE_TOKEN',edition,domain,principal:'SAMPLE_PRINCIPAL'};
  const p=new Platforms(config,{resolve:async()=>{resolves++;return credential;}});
  p.wb.chatStream=async()=>{sends++;return typeof result==='function'?result():result;};
  return {p,config,credential,counts:()=>({resolves,sends}),target:{upstreamId:'SAMPLE_UPSTREAM',model:'deepseek-v4.1-flash'}};
}
const request={model:'SAMPLE_ROUTE',messages:[{role:'user',content:'SAMPLE_INPUT'}],max_tokens:256};

for(const code of [11128,'11128'])test('HTTP 400 structured '+JSON.stringify(code)+' becomes a typed channel rejection',async()=>{
  const f=fixture({ok:false,status:400,kind:'client',message:JSON.stringify({code,msg:'SAMPLE_PRIVATE_BODY',requestId:'SAMPLE_PRIVATE_ID'})});
  await assert.rejects(f.p.chat(f.target,request),e=>{
    assert.equal(e.code,'workbuddy_channel_rejected');assert.equal(e.status,400);assert.equal(e.upstreamCode,11128);assert.equal(e.upstreamStatus,400);assert.equal(e.workBuddyChannel,'ai');
    assert.match(e.message,/渠道校验/);assert.doesNotMatch(e.message,/SAMPLE_PRIVATE/);return true;
  });
  assert.equal(f.counts().sends,1);
});

for(const [label,status,body] of [
  ['similar number',400,{code:111280}],['numeric suffix',400,{code:'11128x'}],['numeric padding',400,{code:' 11128'}],
  ['plain prose',400,'SAMPLE code 11128 Illegal API invocation from an unapproved channel'],
  ['ordinary message property',400,{code:0,msg:'11128'}],['nested user content',400,{content:{code:11128}}],
  ['array',400,[{code:11128}]],['null',400,null],['auth status',401,{code:11128}],['rate limit status',429,{code:11128}],
  ['server status',500,{code:11128}],['contradictory status',400,{code:11128,status:429}],
])test('does not channel-classify '+label,async()=>{
  const f=fixture({ok:false,status,kind:'client',message:typeof body==='string'?body:JSON.stringify(body)});
  await assert.rejects(f.p.chat(f.target,request),e=>e.code!=='workbuddy_channel_rejected'&&e.status===status);
});

test('a known rejected actual credential channel is skipped before provider POST',async()=>{
  const f=fixture({ok:true,response:new Response('{}')});
  await assert.rejects(f.p.chat(f.target,request,undefined,{workBuddyRejectedChannels:['ai']}),e=>e.code==='workbuddy_channel_skipped'&&e.upstreamRequestSent===false);
  assert.equal(f.counts().sends,0);
});

test('actual credential edition wins over stale account edition',async()=>{
  const f=fixture({ok:true,response:new Response('{}')});f.config.value.accounts[0].edition='cn';
  assert.equal(await f.p.workBuddyChannel(f.target),'ai');
  await assert.rejects(f.p.chat(f.target,request,undefined,{workBuddyRejectedChannels:['ai']}),e=>e.code==='workbuddy_channel_skipped');
  assert.equal(f.counts().sends,0);
});

test('another actual channel remains eligible and carries its typed internal channel marker',async()=>{
  const f=fixture({ok:true,response:new Response('{}')},{edition:'cn',domain:'www.workbuddy.cn'});
  const out=await f.p.chat(f.target,request,undefined,{workBuddyRejectedChannels:['ai']});
  assert.equal(out.workBuddyChannel,'cn');assert.equal(f.counts().sends,1);
});

for(const [domain,edition,channel,origin]of [
  ['www.codebuddy.ai','cn','codebuddy-ai','https://www.codebuddy.ai'],
  ['www.codebuddy.cn','ai','cn','https://copilot.tencent.com'],
  [' WWW.WORKBUDDY.AI ','cn','ai','https://www.workbuddy.ai'],
  [' WWW.CODEBUDDY.AI ','ai','codebuddy-ai','https://www.codebuddy.ai'],
  ['','ai','cn','https://copilot.tencent.com'],
])test('channel identity follows actual vendor endpoint for '+JSON.stringify(domain)+' / edition '+edition,async t=>{
  const f=fixture(undefined,{domain,edition}),urls=[];f.p.wb=new WorkBuddyUpstreamClient();
  t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url));return new Response(JSON.stringify({code:11128}),{status:400,headers:{'Content-Type':'application/json'}});});
  assert.equal(await f.p.workBuddyChannel(f.target),channel);
  await assert.rejects(f.p.chat(f.target,request),e=>e.code==='workbuddy_channel_rejected'&&e.workBuddyChannel===channel);
  assert.deepEqual(urls,[origin+'/v2/chat/completions']);
});

test('the two global brands are independent channels rather than a shared global rejection',async()=>{
  const f=fixture({ok:true,response:new Response('{}')},{domain:'www.codebuddy.ai',edition:'ai'});
  const out=await f.p.chat(f.target,request,undefined,{workBuddyRejectedChannels:['ai']});
  assert.equal(out.workBuddyChannel,'codebuddy-ai');assert.equal(f.counts().sends,1);
  await assert.rejects(f.p.chat(f.target,request,undefined,{workBuddyRejectedChannels:['codebuddy-ai']}),e=>e.code==='workbuddy_channel_skipped');
  assert.equal(f.counts().sends,1);
});

test('missing actual transport domain stays unknown instead of trusting edition',async()=>{
  const f=fixture({ok:true,response:new Response('{}')});delete f.credential.domain;
  assert.equal(await f.p.workBuddyChannel(f.target),undefined);
  const out=await f.p.chat(f.target,request,undefined,{workBuddyRejectedChannels:['ai','codebuddy-ai','cn']});
  assert.equal(out.workBuddyChannel,undefined);assert.equal(f.counts().sends,1);
});

test('upstream body classification does not mutate caller messages or tool parameters',async()=>{
  const f=fixture({ok:false,status:400,kind:'client',message:JSON.stringify({code:11128})});const q=structuredClone(request);q.tools=[{type:'function',function:{name:'SAMPLE_TOOL',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}}];const before=structuredClone(q);
  await assert.rejects(f.p.chat(f.target,q));assert.deepEqual(q,before);
});
