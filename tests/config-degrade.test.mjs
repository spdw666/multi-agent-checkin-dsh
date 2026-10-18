import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig} from '../src/config.mjs';

// A file valid everywhere except one account. Saving must still refuse it; loading
// must degrade so the rest of the gateway keeps serving instead of returning 400.
function base(){
  return {
    schemaVersion:1,
    server:{host:'127.0.0.1',port:19421},
    dataDir:'./data',
    scheduler:{hour:12,minute:0,jitterSeconds:0,timezone:'Asia/Shanghai'},
    accounts:[
      {id:'good',platform:'workbuddy',enabled:true,credentials:{kind:'auto'},tasks:[]},
      {id:'future-platform',platform:'not-shipped-yet',enabled:true,credentials:{kind:'auto'},tasks:[]},
    ],
    upstreams:[
      {id:'good',kind:'workbuddy',accountId:'good',enabled:true},
      {id:'future',kind:'not-shipped-yet',accountId:'future-platform',enabled:true},
    ],
    routes:[
      {id:'good/model',enabled:true,targets:[{upstreamId:'good',model:'m'}]},
      {id:'future/model',enabled:true,targets:[{upstreamId:'future',model:'m'}]},
    ],
  };
}

test('strict validation still rejects a single unknown platform',()=>{
  assert.throws(()=>validateConfig(base()),e=>e.status===400&&e.code==='invalid_config');
});

test('lenient validation drops only the unknown account, its upstream and its route',()=>{
  const cfg=validateConfig(base(),{lenient:true});
  assert.deepEqual(cfg.accounts.map(a=>a.id),['good']);
  assert.deepEqual(cfg.upstreams.map(u=>u.id),['good']);
  assert.deepEqual(cfg.routes.map(r=>r.id),['good/model']);
  const skipped=cfg.skipped;
  assert.equal(skipped.length,3);
  assert.deepEqual(skipped.map(s=>s.kind+':'+s.id).sort(),['account:future-platform','route:future/model','upstream:future']);
});

test('skipped diagnostics are not serialized into the saved config shape',()=>{
  const cfg=validateConfig(base(),{lenient:true});
  assert.equal(JSON.stringify(cfg).includes('skipped'),false);
});

test('a fully valid config reports no degradation',()=>{
  const ok=base();
  ok.accounts.pop();ok.upstreams.pop();ok.routes.pop();
  const cfg=validateConfig(ok,{lenient:true});
  assert.equal(cfg.skipped,undefined);
});
