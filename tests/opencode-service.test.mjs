import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.GATEWAY_TEST_ROOT??resolve(import.meta.dirname,'..');
const {openCodeChat}=await import(pathToFileURL(join(root,'src/provider-opencode.mjs')));
let module;
try { module=await import(pathToFileURL(join(root,'src/opencode-service.mjs'))); }
catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }
const credential={password:'SAMPLE_PASSWORD'},service={kind:'opencode',baseUrl:'http://127.0.0.1:12345'};
const lifecycle=(name,fn)=>test(name,{skip:!module},fn);
test('official shared-service lifecycle resolver is installed',()=>assert.equal(typeof module?.createOpenCodeService,'function'));
lifecycle('live official state wins over stale configured port without a restart',async()=>{
  const seen=[];const resolver=module.createOpenCodeService({readState:async()=>({url:'http://127.0.0.1:23456'}),probe:async url=>{seen.push(url);return true;},start:async()=>assert.fail('unexpected start')});
  assert.equal((await resolver(service,credential)).baseUrl,'http://127.0.0.1:23456');assert.deepEqual(seen,['http://127.0.0.1:23456']);
});
lifecycle('cold official service starts once and rereads the resulting official port',async()=>{
  let live=false,starts=0;const resolver=module.createOpenCodeService({readState:async()=>({url:live?'http://127.0.0.1:23456':service.baseUrl}),probe:async()=>live,start:async()=>{live=true;starts++;}});
  assert.equal((await resolver(service,credential)).baseUrl,'http://127.0.0.1:23456');assert.equal(starts,1);
});
lifecycle('concurrent callers share one start rather than spawning competing services',async()=>{
  let live=false,starts=0;const resolver=module.createOpenCodeService({readState:async()=>({url:service.baseUrl}),probe:async()=>live,start:async()=>{starts++;await new Promise(r=>setTimeout(r,5));live=true;}});
  const rows=await Promise.all(Array.from({length:12},()=>resolver(service,credential)));assert.equal(starts,1);assert.equal(rows.length,12);
});
lifecycle('already cancelled requests perform no read probe or launch',async()=>{
  const fail=async()=>assert.fail('action after cancellation'),c=new AbortController();c.abort();
  const resolver=module.createOpenCodeService({readState:fail,probe:fail,start:fail});await assert.rejects(()=>resolver(service,credential,{signal:c.signal}),e=>e.code==='request_cancelled');
});
lifecycle('one cancelled waiter does not terminate another caller or the shared service',async()=>{
  let live=false,release;const gate=new Promise(r=>{release=r;});const resolver=module.createOpenCodeService({readState:async()=>({url:service.baseUrl}),probe:async()=>live,start:async()=>{await gate;live=true;}}),c=new AbortController();
  const a=resolver(service,credential,{signal:c.signal}),b=resolver(service,credential);c.abort();release();
  await assert.rejects(()=>a,e=>e.code==='request_cancelled');assert.equal((await b).baseUrl,service.baseUrl);
});
for(const baseUrl of ['https://SAMPLE.invalid','http://localhost:12345','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:12345/path'])lifecycle('reject invalid configured origin before read or launch: '+baseUrl,async()=>{
  const fail=async()=>assert.fail('action before validation'),resolver=module.createOpenCodeService({readState:fail,probe:fail,start:fail});
  await assert.rejects(()=>resolver({...service,baseUrl},credential),e=>e.code==='opencode_endpoint_invalid');
});
lifecycle('invalid official state never receives a credential or triggers a launch',async()=>{
  const fail=async()=>assert.fail('action before validation'),resolver=module.createOpenCodeService({readState:async()=>({url:'https://SAMPLE.invalid'}),probe:fail,start:fail});
  await assert.rejects(()=>resolver(service,credential),e=>e.code==='opencode_endpoint_invalid');
});
lifecycle('authentication rejection is not treated as a stopped service',async()=>{
  const resolver=module.createOpenCodeService({readState:async()=>null,probe:async()=>{const e=Error('SAMPLE rejected');e.code='opencode_service_auth_rejected';throw e;},start:async()=>assert.fail('authentication must not restart service')});
  await assert.rejects(()=>resolver(service,credential),e=>e.code==='opencode_service_auth_rejected');
});
lifecycle('failed startup clears the flight so a subsequent request can recover',async()=>{
  let live=false,starts=0;const resolver=module.createOpenCodeService({readState:async()=>null,probe:async()=>live,start:async()=>{if(++starts===1)throw Error('SAMPLE startup failure');live=true;}});
  await assert.rejects(()=>resolver(service,credential),/SAMPLE startup failure/);assert.equal((await resolver(service,credential)).baseUrl,service.baseUrl);assert.equal(starts,2);
});
lifecycle('unready service is a typed failure, not a fabricated connected state',async()=>{
  const resolver=module.createOpenCodeService({readState:async()=>null,probe:async()=>false,start:async()=>{}});await assert.rejects(()=>resolver(service,credential),e=>e.code==='opencode_service_not_ready');
});
lifecycle('later port changes are discovered rather than cached forever',async()=>{
  let url=service.baseUrl;const resolver=module.createOpenCodeService({readState:async()=>({url}),probe:async()=>true,start:async()=>assert.fail('unexpected start')});
  assert.equal((await resolver(service,credential)).baseUrl,url);url='http://127.0.0.1:23456';assert.equal((await resolver(service,credential)).baseUrl,url);
});
lifecycle('each caller validates its own origin even during another shared start',async()=>{
  let release,live=false;const gate=new Promise(r=>{release=r;});const resolver=module.createOpenCodeService({readState:async()=>null,probe:async()=>live,start:async()=>{await gate;live=true;}});
  const good=resolver(service,credential);await assert.rejects(()=>resolver({...service,baseUrl:'https://SAMPLE.invalid'},credential),e=>e.code==='opencode_endpoint_invalid');release();await good;
});
test('official FreeTierError keeps HTTP403 and its specific cause, not generic login401',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(options.method==='DELETE')return new Response(null,{status:204});
    if(String(url).endsWith('/api/session'))return Response.json({data:{id:'SAMPLE_SESSION'}});
    if(String(url).endsWith('/prompt'))return Response.json({data:{accepted:true}});
    return Response.json({data:[{type:'idle',outcome:'failed',error:{status:403,type:'provider.auth',message:"OpenCode's free tier can only be used from within OpenCode."}}]});
  });
  await assert.rejects(()=>openCodeChat({baseUrl:service.baseUrl},credential,{model:'SAMPLE-free',messages:[{role:'user',content:'SAMPLE prompt'}]}),e=>e.status===403&&e.code==='opencode_free_tier_rejected');
});
test('unsupported original tools remain intact and reject before service startup',async()=>{
  const request={model:'SAMPLE-free',messages:[{role:'user',content:'SAMPLE'}],tools:[{type:'function',function:{name:'SAMPLE_TOOL',parameters:{type:'object'}}}]},before=structuredClone(request);
  await assert.rejects(()=>openCodeChat({...service,baseUrl:'https://SAMPLE.invalid'},credential,request),e=>e.code==='tools_not_supported');assert.deepEqual(request,before);
});
test('official model country restriction keeps HTTP403 and is not mislabeled login failure',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(options.method==='DELETE')return new Response(null,{status:204});
    if(String(url).endsWith('/api/session'))return Response.json({data:{id:'SAMPLE_SESSION'}});
    if(String(url).endsWith('/prompt'))return Response.json({data:{accepted:true}});
    return Response.json({data:[{type:'idle',outcome:'failed',error:{status:403,message:'This model is not available in your country'}}]});
  });
  await assert.rejects(()=>openCodeChat({baseUrl:service.baseUrl},credential,{model:'SAMPLE-free',messages:[{role:'user',content:'SAMPLE prompt'}]}),e=>e.status===403&&e.code==='opencode_region_unavailable');
});
