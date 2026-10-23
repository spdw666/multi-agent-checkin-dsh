import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {Router} from '../src/router.mjs';
import {Platforms} from '../src/platforms.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const model=id=>({id,callable:true,tools:true,maxTokens:4096,contextWindow:32768});
function fixture(){
 const calls=new Map(),normal=[model('deepseek-v4'),model('glm-5.3')],native={...model('gmodel'),name:'GLM-5.3',source:'qoder-official-signed-catalog'};
 const config={value:{accounts:[{id:'a',platform:'bigmodel',edition:'cn',credentials:{file:'SAMPLE-A'}},{id:'q',platform:'qoder'}],upstreams:[{id:'u',kind:'bigmodel',accountId:'a'},{id:'q',kind:'qoder',accountId:'q'}],routes:[{id:'DS',targets:[{upstreamId:'u',model:'deepseek-v4'}]},{id:'GLM',targets:[{upstreamId:'u',model:'glm-5.3'}]},{id:'Q',targets:[{upstreamId:'q',model:'gmodel'}]}],modelRelay:{enabled:true}}};
 const platforms={models:async id=>{calls.set(id,(calls.get(id)??0)+1);await pause(id==='q'?30:5);return id==='q'?[native]:normal;}};
 return {config,platforms,calls,normal,native,router:new Router(config,platforms)};
}
test('directory batch reuses a completed catalogue across delayed opaque-alias phases',async()=>{
 const f=fixture(),rows=(await f.router.models()).data;assert.equal(rows.length,3);assert.equal(f.calls.get('u'),1);assert.equal(f.calls.get('q'),1);
 assert.equal(rows.find(r=>r.id==='GLM').modelRelay.targetCount,2);
});
test('batch memo expires after each models call, including signed alias and capacity changes',async()=>{
 const f=fixture();await f.router.models();f.native.name='GLM-5.2';f.normal[0].maxTokens=8192;
 const rows=(await f.router.models()).data;assert.equal(f.calls.get('u'),2);assert.equal(f.calls.get('q'),2);assert.equal(rows.find(r=>r.id==='GLM').modelRelay.targetCount,1);assert.equal(rows.find(r=>r.id==='DS').maxTokens,8192);
});
for(const change of ['edition','credentials','upstream'])test(`Router flight source separates ${change} changes`,async()=>{
 const f=fixture();let release;const seen=[];f.platforms.models=async()=>{const edition=f.config.value.accounts[0].edition;seen.push(edition);if(seen.length===1)await new Promise(r=>release=r);return[model(edition)]};
 const one=f.router.catalog('u');await Promise.resolve();if(change==='edition')f.config.value.accounts[0].edition='ai';else if(change==='credentials')f.config.value.accounts[0].credentials.file='SAMPLE-B';else f.config.value.upstreams[0].endpoint='SAMPLE-B';
 const two=f.router.catalog('u');await Promise.resolve();release();await Promise.all([one,two]);assert.equal(seen.length,2);
});
test('Router source A-B-A does not revive the first still-running A flight',async()=>{
 const f=fixture(),releases=[];f.platforms.models=async()=>{const n=releases.length;await new Promise(r=>releases.push(r));return[model('result-'+n)]};
 const one=f.router.catalog('u');await Promise.resolve();f.config.value.accounts[0].edition='ai';const two=f.router.catalog('u');await Promise.resolve();f.config.value.accounts[0].edition='cn';const three=f.router.catalog('u');await Promise.resolve();
 const count=releases.length;for(const r of releases)r();await Promise.all([one,two,three]);assert.equal(count,3);
});
test('a source edit during models lookup restarts only the batch and never publishes old metadata',async()=>{
 const f=fixture();let changed=false;const original=f.platforms.models;
 f.platforms.models=async id=>{if(id==='u'&&!changed){changed=true;await pause(2);f.config.value.accounts[0].edition='ai';return[model('deepseek-v4')]};const rows=await original(id);return rows.map(m=>({...m,maxTokens:8192}))};
 const rows=(await f.router.models()).data;assert.ok(rows.length);assert.ok(rows.every(r=>r.maxTokens===8192));
});
test('disabling a route during catalogue lookup immediately excludes it from the returned batch',async()=>{
 const f=fixture(),read=f.platforms.models;let once=false;f.platforms.models=async id=>{if(!once){once=true;f.config.value.routes[0].enabled=false;}return read(id)};
 assert.equal((await f.router.models()).data.some(r=>r.id==='DS'),false);
});
test('manual WB pool selection during catalogue lookup determines the returned primary',async()=>{
 const f=fixture();f.config.value.accounts=[{id:'a',platform:'workbuddy',edition:'cn'},{id:'b',platform:'workbuddy',edition:'cn'}];f.config.value.upstreams=[{id:'u',accountId:'a',kind:'workbuddy'},{id:'v',accountId:'b',kind:'workbuddy'}];f.config.value.routes=[{id:'POOL',targets:[{upstreamId:'u',model:'deepseek-v4'}],accountPool:{enabled:true,accountIds:['a','b']}}];
 let once=false;f.platforms.models=async()=>{if(!once){once=true;f.router.pool.set('wb-pool-route:POOL',{preferredAccountId:'b',manualVersion:1})};return[model('deepseek-v4')]};
 assert.equal((await f.router.models()).data[0].upstream,'v');
});
test('catalogue lookup indexes retain first duplicate model exactly like Array.find',async()=>{
 const f=fixture();f.normal.push({...model('deepseek-v4'),maxTokens:1});assert.equal((await f.router.models()).data.find(r=>r.id==='DS').maxTokens,4096);
});
test('direct routeInfo also rechecks source and disabled state after asynchronous reads',async()=>{
 const f=fixture(),read=f.platforms.models;let changed=false;f.platforms.models=async id=>{if(!changed){changed=true;f.config.value.routes[0].enabled=false;}return read(id)};
 assert.equal(await f.router.routeInfo(f.config.value.routes[0]),undefined);
});
function platformFixture(){const f=fixture();f.config.value.upstreams[0].kind='workbuddy';f.config.value.accounts[0].platform='workbuddy';const platforms=new Platforms(f.config,{resolve:async()=>({edition:f.config.value.accounts[0].edition})});let calls=0;platforms.wb.fetchModels=async credential=>{calls++;return[model(credential.edition)]};return {...f,platforms,get count(){return calls}};}
for(const change of ['edition','credentials','upstream'])test(`Platforms cached source invalidates on ${change}`,async()=>{
 const f=platformFixture();await f.platforms.models('u');if(change==='edition')f.config.value.accounts[0].edition='ai';else if(change==='credentials')f.config.value.accounts[0].credentials.file='SAMPLE-B';else f.config.value.upstreams[0].endpoint='SAMPLE-B';
 await f.platforms.models('u');assert.equal(f.count,2);
});
test('old Platforms source completion cannot replace current source cache after A-B-A',async()=>{
 const f=platformFixture(),releases=[];f.platforms.fetchModels=async()=>{const n=releases.length;await new Promise(r=>releases.push(r));return[model('result-'+n)]};
 const a=f.platforms.models('u');await Promise.resolve();f.config.value.accounts[0].edition='ai';const b=f.platforms.models('u');await Promise.resolve();f.config.value.accounts[0].edition='cn';const c=f.platforms.models('u');await Promise.resolve();
 const count=releases.length;releases.at(-1)();await c;for(const r of releases)r();await Promise.all([a,b]);assert.equal(count,3);assert.equal((await f.platforms.models('u'))[0].id,'result-2');
});
test('disabled Platforms account does not leak its cached catalogue',async()=>{
 const f=platformFixture();await f.platforms.models('u');f.config.value.accounts[0].enabled=false;await assert.rejects(f.platforms.models('u'),e=>e.code==='upstream_disabled');
});
test('Platforms consumer cancellation releases listener while another catalogue consumer finishes',async()=>{
 const f=platformFixture(),c=new AbortController();let release,upstream;f.platforms.fetchModels=async(_,{signal})=>{upstream=signal;await new Promise(r=>release=r);return[model('SAMPLE')]};
 const a=f.platforms.models('u',{signal:c.signal}),b=f.platforms.models('u');await Promise.resolve();c.abort();
 try{await Promise.race([assert.rejects(a,e=>e.code==='request_cancelled'),pause(100).then(()=>{throw Error('cancellation remained blocked')})]);assert.equal(upstream.aborted,false);assert.equal(getEventListeners(c.signal,'abort').length,0);}finally{release();await b;}
});
test('Platforms explicit refresh is honored while ordinary subsequent reads reuse existing cache policy',async()=>{
 const f=platformFixture();await f.platforms.models('u');await f.platforms.models('u');assert.equal(f.count,1);await f.platforms.models('u',{refresh:true});assert.equal(f.count,2);assert.equal(f.platforms.catalogFlights.size,0);
});
test('Trae source change discards old wire stack before building a new source catalogue',async()=>{
 const f=platformFixture();f.config.value.upstreams[0].kind='trae';f.platforms.fetchModels=async()=>[model('SAMPLE')];await f.platforms.models('u');f.platforms.trae.set('a',{old:true});f.config.value.accounts[0].credentials.file='SAMPLE-B';await f.platforms.models('u');assert.equal(f.platforms.trae.has('a'),false);
});
test('credential source change while resolving cannot dispatch a mixed-source WorkBuddy catalogue',async()=>{
 const f=platformFixture();let release;f.platforms.credentials.resolve=async()=>{await new Promise(r=>release=r);return{edition:'cn'}};
 const pending=f.platforms.models('u');await Promise.resolve();await Promise.resolve();f.config.value.accounts[0].edition='ai';release();
 await assert.rejects(pending,e=>e.code==='model_directory_changed');assert.equal(f.count,0);assert.equal(f.platforms.catalogs.has('u'),false);
});
test('Trae source change after wire lookup does not dispatch remote lookup or mutate any wire cache',async()=>{
 const f=platformFixture();f.config.value.upstreams[0].kind='trae';let release,remoteCalls=0;const wire=new Map();
 f.platforms.traeStack=()=>({wire,solo:{fetchModels:async()=>{await new Promise(r=>release=r);return[{id:'SAMPLE',name:'SAMPLE',function:'fixture'}]}},remote:{fetchModels:async()=>{remoteCalls++;return[{id:'SAMPLE',name:'SAMPLE'}]}}});
 const pending=f.platforms.models('u');await Promise.resolve();await Promise.resolve();f.config.value.accounts[0].edition='ai';release();
 await assert.rejects(pending,e=>e.code==='model_directory_changed');assert.equal(remoteCalls,0);assert.equal(wire.size,0);
});
test('nonpool catalogue batches do not read unrelated pool ledger metadata',async()=>{
 const f=fixture();let reads=0;f.router.pool.get=()=>{reads++;return undefined};await f.router.models();assert.equal(reads,0);
});
test('enabling a formerly disabled route during lookup includes it in the returned directory',async()=>{
 const f=fixture(),read=f.platforms.models;f.config.value.routes[0].enabled=false;let once=false;
 f.platforms.models=async id=>{if(!once){once=true;f.config.value.routes[0].enabled=true;}return read(id)};
 assert.equal((await f.router.models()).data.some(r=>r.id==='DS'),true);
});
async function expectCatalogueTimeout(pending,nativeTimeout){
 let timer;try{await Promise.race([assert.rejects(pending,e=>e.code==='model_catalog_timeout'),new Promise((_,reject)=>{timer=nativeTimeout(()=>reject(new Error('catalogue timeout remained blocked')),100)})]);}finally{clearTimeout(timer);}
}
for(const delayed of ['solo','remote'])test(`timed-out Trae ${delayed} completion cannot overwrite a newer same-source wire cache`,async()=>{
 const f=platformFixture();f.config.value.upstreams[0].kind='trae';const wire=new Map();let soloCalls=0,remoteCalls=0,release;
 f.platforms.traeStack=()=>({wire,solo:{fetchModels:async()=>{const first=++soloCalls===1;if(first&&delayed==='solo')await new Promise(r=>release=r);return[{id:'SAMPLE',name:'SAMPLE',function:first?'old-function':'new-function'}]}},remote:{fetchModels:async()=>{if(++remoteCalls===1&&delayed==='remote')await new Promise(r=>release=r);return[{id:'SAMPLE',name:'SAMPLE'}]}}});
 const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===45000?10:ms,...args);
 try{
  await expectCatalogueTimeout(f.platforms.models('u'),nativeTimeout);
  assert.equal(f.platforms.catalogFlights.size,0);await f.platforms.models('u');assert.equal(wire.get('SAMPLE').function,'new-function');
  const latest=f.platforms.catalogs.get('u');release();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  assert.equal(wire.get('SAMPLE').function,'new-function');assert.equal(f.platforms.catalogs.get('u'),latest);assert.equal(f.platforms.catalogFlights.size,0);assert.equal(remoteCalls,delayed==='solo'?1:2);
 }finally{globalThis.setTimeout=nativeTimeout;release?.();await new Promise(r=>setImmediate(r));}
});
test('catalogue timeout during credential resolution prevents late provider dispatch',async()=>{
 const f=platformFixture();let release;f.platforms.credentials.resolve=async()=>{await new Promise(r=>release=r);return{edition:'cn'}};
 const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===45000?10:ms,...args);
 try{
  await expectCatalogueTimeout(f.platforms.models('u'),nativeTimeout);release();await new Promise(r=>setImmediate(r));
  assert.equal(f.count,0);assert.equal(f.platforms.catalogs.has('u'),false);assert.equal(f.platforms.catalogFlights.size,0);
 }finally{globalThis.setTimeout=nativeTimeout;release?.();await new Promise(r=>setImmediate(r));}
});
test('direct catalogue lookup with an aborted signal starts no credential or provider lookup',async()=>{
 const f=platformFixture(),c=new AbortController(),reason=new Error('SAMPLE cancelled');let credentialCalls=0;
 f.platforms.credentials.resolve=async()=>{credentialCalls++;return{edition:'cn'}};c.abort(reason);
 await assert.rejects(f.platforms.fetchModels('u',{signal:c.signal}),e=>e===reason);assert.equal(credentialCalls,0);assert.equal(f.count,0);assert.equal(f.platforms.catalogs.has('u'),false);
});
