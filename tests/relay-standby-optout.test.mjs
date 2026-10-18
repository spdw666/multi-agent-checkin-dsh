import test from 'node:test';
import assert from 'node:assert/strict';
import {Router} from '../src/router.mjs';

// Minimal fixture: two suppliers of the same model; one is marked as "never a standby".
function fixture(){
  const model='deepseek-v4.1-flash';
  const config={value:{
    schemaVersion:1,
    server:{port:0,requestTimeoutMs:180000},
    dataDir:'./data',
    accounts:[
      {id:'a1',platform:'loomy',enabled:true,credentials:{kind:'auto'}},
      {id:'a2',platform:'workbuddyai',enabled:true,credentials:{kind:'auto'}},
    ],
    upstreams:[
      {id:'u1',kind:'loomy',accountId:'a1',enabled:true},
      {id:'u2',kind:'workbuddyai',accountId:'a2',enabled:true,relayStandby:false},
    ],
    routes:[
      {id:'u1/'+model,name:'primary',enabled:true,targets:[{upstreamId:'u1',model}]},
      {id:'u2/'+model,name:'big-request-rejects',enabled:true,targets:[{upstreamId:'u2',model}]},
    ],
    modelRelay:{enabled:true,reservePercent:10,reserveCredits:100,balanceMaxAgeSeconds:60},
  },async load(){}};
  const platforms={models:async()=>[{id:model,name:model,tools:true,multimodal:false,contextWindow:1048576,maxTokens:128000,callable:true,source:'fixture'}],chat:async()=>{throw new Error('unused')}};
  const ledger={get(){return null},set(){},push(){}};
  return {config,platforms,ledger,router:new Router(config,platforms,{ledger})};
}

test('relayStandby:false keeps the supplier out of another route relay set',async()=>{
  const f=fixture();
  const route=f.config.value.routes[0];
  const prepared=await f.router.relay.prepare(route,f.router.pool.candidates(route),undefined,{source:'api'});
  assert.deepEqual(prepared.targets.map(t=>t.upstreamId),['u1']);
});

test('relayStandby:false does not remove the supplier from its own route',async()=>{
  const f=fixture();
  const route=f.config.value.routes[1];
  const prepared=await f.router.relay.prepare(route,f.router.pool.candidates(route),undefined,{source:'api'});
  // Its own target must survive; other same-family suppliers may still be appended.
  assert.ok(prepared.targets.some(t=>t.upstreamId==='u2'));
});

test('relayStandby defaults to true so unmarked suppliers still relay',async()=>{
  const f=fixture();
  delete f.config.value.upstreams[1].relayStandby;
  const route=f.config.value.routes[0];
  const prepared=await f.router.relay.prepare(route,f.router.pool.candidates(route),undefined,{source:'api'});
  assert.deepEqual(prepared.targets.map(t=>t.upstreamId).sort(),['u1','u2']);
});
