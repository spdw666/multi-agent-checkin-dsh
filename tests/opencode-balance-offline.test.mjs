import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const root=process.env.GATEWAY_TEST_ROOT??resolve(import.meta.dirname,'..');
const {openCodeHealth,openCodeModels}=await import(pathToFileURL(join(root,'src/provider-opencode.mjs')));
const {balances,normalizeBalance}=await import(pathToFileURL(join(root,'src/balances.mjs')));
const credential={password:'SAMPLE_PASSWORD',accessToken:'SAMPLE_TOKEN'};
const upstream={baseUrl:'http://127.0.0.1:12345'};
async function database(t,used=3){
  const dir=await mkdtemp(join(tmpdir(),'SAMPLE-opencode-balance-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'SAMPLE.db'),db=new DatabaseSync(file);
  db.exec('CREATE TABLE session_message(type TEXT,time_created INTEGER,data TEXT)');
  for(let n=0;n<used;n++)db.prepare('INSERT INTO session_message VALUES(?,?,?)').run('assistant',Date.now(),JSON.stringify({model:{providerID:'opencode',id:'SAMPLE-free'}}));
  db.close();return {id:'SAMPLE_OC',platform:'opencode',credentials:{file}};
}
function network(t,{offline=true,billingStatus=200,billing={balanceMicroCents:'100000000'}}={}){
  const calls=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{
    calls.push({url:String(url),method:options.method??'GET'});
    if(String(url).endsWith('/api/model')){
      if(offline)throw new TypeError('fetch failed');
      return Response.json({data:[{providerID:'opencode',id:'SAMPLE-free'}]});
    }
    assert.equal(String(url),'https://opencode.ai/console/api/billing/status');
    return Response.json(billing,{status:billingStatus});
  });return calls;
}
test('offline model service cannot block local quota or official billing; transport remains unavailable',async t=>{
  const account=await database(t),calls=network(t);
  const h=await openCodeHealth(credential,upstream,{account});
  assert.equal(h.balance.value,197);assert.equal(h.balance.unit,'次（估算）');
  assert.equal(h.balance.parts.find(p=>p.name==='Zen 付费余额').value,1);
  assert.equal(h.capabilities.inference,false);assert.equal(h.freeModels,null);
  assert.equal(h.bridge.error.code,'opencode_bridge_unreachable');
  assert.match(h.balance.note,/本机.*服务.*未连接/);assert.equal(h.balanceKnown,true);
  assert.ok(calls.every(x=>x.method==='GET'));assert.equal(calls.length,2);
});
test('offline service and official HTTP500 still show local estimate without inventing USD0',async t=>{
  const account=await database(t,0);network(t,{billingStatus:500});
  const h=await openCodeHealth(credential,upstream,{account});
  assert.equal(h.balance.value,200);assert.match(h.balance.note,/HTTP 500/);
  assert.equal(h.balance.parts.some(p=>p.name==='Zen 付费余额'),false);
  assert.equal(h.billing.known,false);assert.equal(h.billing.status,500);
});
test('unreadable local database falls back only to an observed official USD amount',async t=>{
  network(t);const h=await openCodeHealth(credential,upstream,{account:{credentials:{file:join(tmpdir(),'SAMPLE-MISSING.db')}}});
  assert.equal(h.balance.value,1);assert.equal(h.balance.unit,'USD');assert.equal(h.balanceKnown,true);
  assert.equal(h.balance.parts.some(p=>p.name==='今日免费请求'),false);
});
test('both quota sources unavailable remain null and unknown, never a fabricated balance',async t=>{
  network(t,{billingStatus:500});const h=await openCodeHealth(credential,upstream,{account:{credentials:{file:join(tmpdir(),'SAMPLE-MISSING.db')}}});
  assert.equal(h.balance.value,null);assert.equal(h.balanceKnown,false);assert.equal(h.known,false);assert.equal(h.billing.known,false);
});
for(const amount of [null,undefined,'', '   ',false,'NaN',-1])test('missing or malformed official balance is not coerced into USD0: '+JSON.stringify(amount),async t=>{
  network(t,{offline:false,billing:{balanceMicroCents:amount}});
  const h=await openCodeHealth(credential,upstream,{account:{credentials:{file:join(tmpdir(),'SAMPLE-MISSING.db')}}});
  assert.equal(h.balance.value,null);assert.equal(h.balance.parts.some(p=>p.name==='Zen 付费余额'),false);
});
test('observed official zero remains a known USD0, not an unknown amount',async t=>{
  network(t,{billing:{balanceMicroCents:'0'}});const h=await openCodeHealth(credential,upstream,{account:{credentials:{file:join(tmpdir(),'SAMPLE-MISSING.db')}}});
  assert.equal(h.balance.value,0);assert.equal(h.balance.unit,'USD');assert.equal(h.balanceKnown,true);
});
test('invalid endpoint stays a distinct transport diagnostic while local usage is retained',async t=>{
  const account=await database(t);network(t);
  const h=await openCodeHealth(credential,{baseUrl:'https://SAMPLE.invalid'},{account});
  assert.equal(h.balance.value,197);assert.equal(h.bridge.error.code,'opencode_endpoint_invalid');assert.equal(h.capabilities.inference,false);
});
test('direct model discovery still throws when the bridge is offline',async t=>{
  network(t);await assert.rejects(()=>openCodeModels(credential,upstream),e=>e.code==='opencode_bridge_unreachable');
});
test('reachable model service retains its catalog without being needed for quota',async t=>{
  const account=await database(t);network(t,{offline:false});const h=await openCodeHealth(credential,upstream,{account});
  assert.equal(h.status,'ok');assert.equal(h.freeModels,1);assert.equal(h.capabilities.inference,true);assert.equal(h.balance.value,197);
});
test('real balances normalization produces checkedAt and nonstale number even with offline bridge',async t=>{
  const account=await database(t);network(t,{billingStatus:500});
  const service={config:{value:{accounts:[account]}},platforms:{health:()=>openCodeHealth(credential,upstream,{account})},ledger:{observeBalance(){}}};
  const result=await balances(service,{refresh:true}),row=result.accounts[0];
  assert.equal(row.value,197);assert.equal(row.unit,'次（估算）');assert.equal(row.stale,false);
  assert.equal(row.error,undefined);assert.ok(Number.isFinite(Date.parse(row.checkedAt)));assert.match(row.note,/HTTP 500/);
  assert.equal(normalizeBalance('opencode',await service.platforms.health()).value,197);
});
