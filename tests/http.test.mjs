import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {projectRoot} from '../src/config.mjs';
test('real HTTP gateway: auth, admin isolation, platform ordinary/SSE/tools, cancellation, body and origin checks',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'credit-http-'));let received=[];let cancelled=false;
  const fake=http.createServer(async(req,res)=>{if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model',tools:true,multimodal:false}]}));return;}
    let text='';for await(const c of req)text+=c;const input=JSON.parse(text);received.push({input,auth:req.headers.authorization});assert.equal(req.headers.authorization,'Bearer fixture-relay-key');
    if(input.messages[0].content==='cancel-fixture'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'started'},finish_reason:null}]})+'\n\n');res.on('close',()=>{cancelled=true});return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});const d=input.tools?.length?{tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name:'sum_numbers',arguments:'{"a":17,"b":25}'}}]}:{content:'fixture OK'};
    res.end('data: '+JSON.stringify({choices:[{index:0,delta:d,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:input.tools?.length?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });await new Promise(r=>fake.listen(0,'127.0.0.1',r));const upstream=`http://127.0.0.1:${fake.address().port}/v1`;
  const c=JSON.parse(await readFile(join(projectRoot,'config.example.json')));c.dataDir=join(dir,'data');c.accounts=[{id:'fixture-account',platform:'workbuddy',credentials:{mode:'local'}}];c.scheduler.enabled=false;c.scheduler.startup=false;c.server.port=0;c.server.bodyLimitBytes=2048;
  c.upstreams=[{id:'fixture',kind:'workbuddy',accountId:'fixture-account',enabled:true}];c.routes=[{id:'fixture/route',targets:[{upstreamId:'fixture',model:'fixture-model'}]}];
  await writeFile(join(dir,'config.json'),JSON.stringify(c));await writeFile(join(dir,'relay.json'),JSON.stringify({apiKey:'fixture-relay-key'}));const service=await createService(join(dir,'config.json'));service.platforms.models=async()=>[{id:'fixture-model',tools:true,multimodal:false}];service.platforms.chat=async(target,input,signal)=>({response:await fetch(upstream+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer fixture-relay-key'},body:JSON.stringify({...input,stream:true}),signal})});const runtime=await startServer(service);const base=runtime.baseUrl;
  const headers={Authorization:`Bearer ${service.keys.apiKey}`,'Content-Type':'application/json'};const admin={Authorization:`Bearer ${service.keys.adminKey}`,'Content-Type':'application/json'};
  try {
    assert.equal((await fetch(base+'/health')).status,200);assert.equal((await fetch(base+'/v1/models')).status,401);assert.equal((await fetch(base+'/v1/models',{headers:admin})).status,401);
    assert.equal((await fetch(base+'/admin/config',{headers})).status,401);assert.equal((await fetch(base+'/admin/config',{headers:admin})).status,200);
    assert.equal((await fetch(base+'/admin/model-directory',{headers})).status,401);
    const directory=await(await fetch(base+'/admin/model-directory',{headers:admin})).json();assert.equal(directory.count,1);assert.equal(directory.providers[0].models[0].imported,true);
    const select=enabled=>fetch(base+'/admin/model-import',{method:'POST',headers:admin,body:JSON.stringify({items:[{upstreamId:'fixture',model:'fixture-model',enabled}]})});
    assert.equal((await select(false)).status,200);assert.equal((await service.router.models()).data.length,0);assert.equal((await select(true)).status,200);assert.equal(service.config.value.routes.length,1);
    const list=await(await fetch(base+'/v1/models',{headers})).json();assert.equal(list.data[0].capabilities.tools,true);assert.equal(list.data[0].capabilities.multimodal,false);
    const request={model:'fixture/route',messages:[{role:'user',content:'fixture'}]};
    const plain=await(await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(request)})).json();assert.equal(plain.choices[0].message.content,'fixture OK');assert.equal(plain.model,'fixture/route');
    const stream=await(await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({...request,stream:true})})).text();assert.ok(stream.includes('[DONE]'));assert.ok(stream.includes('fixture OK'));
    const tools=[{type:'function',function:{name:'sum_numbers',parameters:{type:'object'}}}];const tool=await(await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({...request,tools})})).json();assert.equal(tool.choices[0].message.tool_calls[0].function.name,'sum_numbers');assert.equal(received.length,3);assert.equal(received[0].input.stream,true);
    assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers:{...headers,Origin:'https://external.invalid'},body:JSON.stringify(request)})).status,403);
    assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'{bad'})).status,400);
    assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({...request,messages:[{role:'user',content:'x'.repeat(3000)}]})})).status,413);
    const ac=new AbortController();const ongoing=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'fixture/route',stream:true,messages:[{role:'user',content:'cancel-fixture'}]}),signal:ac.signal});const reader=ongoing.body.getReader();await reader.read();ac.abort();try{await reader.read()}catch{};for(let i=0;i<50&&!cancelled;i++)await new Promise(r=>setTimeout(r,10));assert.equal(cancelled,true,'disconnect aborts upstream socket');
    const secretless=JSON.stringify(await(await fetch(base+'/admin/state',{headers:admin})).json());assert.ok(!secretless.includes(service.keys.apiKey));assert.ok(!secretless.includes(service.keys.adminKey));
  }finally{await runtime.close();await service.close();fake.closeAllConnections();await new Promise(r=>fake.close(r));await rm(dir,{recursive:true,force:true});}
});
