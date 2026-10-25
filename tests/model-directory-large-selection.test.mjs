import test from 'node:test';
import assert from 'node:assert/strict';
import {importModels,exportModels} from '../src/model-directory.mjs';
function fixture(count=681){
 const catalog=Array.from({length:count},(_,i)=>({id:'model-'+i,name:'Model '+i,callable:true}));
 let saves=0,reads=0;
 const original={unknown:{preserved:true},accounts:[],upstreams:[{id:'sample',kind:'sample',enabled:true}],routes:[{id:'existing',enabled:false,targets:[{upstreamId:'sample',model:'existing'}]}]};
 const service={config:{value:structuredClone(original),async save(value){saves++;this.value=value;}},platforms:{async models(){reads++;return catalog;}}};
 return {service,original,catalog,get saves(){return saves;},get reads(){return reads;}};
}
test('directory saves the real 681-model filtered selection in exactly one commit',async()=>{
 const f=fixture(),items=f.catalog.map(m=>({upstreamId:'sample',model:m.id}));
 const result=await importModels(f.service,items);
 assert.equal(result.selected,681);assert.equal(f.saves,1);assert.equal(f.service.config.value.routes.length,682);
 assert.deepEqual(f.service.config.value.unknown,f.original.unknown);assert.deepEqual(f.service.config.value.routes[0],f.original.routes[0]);
 assert.ok(f.service.config.value.routes.slice(1).every(r=>r.enabled===true));
});
test('a bad item after the old 500 threshold never partially saves earlier selections',async()=>{
 const f=fixture(),items=f.catalog.map(m=>({upstreamId:'sample',model:m.id}));items.push({upstreamId:'sample',model:'absent'});
 await assert.rejects(importModels(f.service,items),{code:'invalid_model'});
 assert.equal(f.saves,0);assert.deepEqual(f.service.config.value,f.original);
});
test('large cross-account cancellation preserves exact aliases and commits once',async()=>{
 const f=fixture(0);f.service.config.value.routes=Array.from({length:960},(_,i)=>({id:'alias-'+i,enabled:true,targets:[{upstreamId:'sample',model:'model-'+i}]}));
 const items=f.service.config.value.routes.map((r,i)=>({upstreamId:'sample',model:'model-'+i,enabled:false,importedRouteIds:[r.id]}));
 await importModels(f.service,items);assert.equal(f.saves,1);assert.equal(f.reads,0);assert.ok(f.service.config.value.routes.every(r=>r.enabled===false));
});
test('the full 5000-item upper bound is accepted without remote reads for cancellation',async()=>{
 const f=fixture(0),items=Array.from({length:5000},(_,i)=>({upstreamId:'sample',model:'not-imported-'+i,enabled:false}));
 assert.equal((await importModels(f.service,items)).selected,5000);assert.equal(f.saves,1);assert.equal(f.reads,0);
});
test('5001 items and malformed envelopes fail before discovery or mutation',async()=>{
 for(const items of [Array.from({length:5001},()=>({upstreamId:'sample',model:'m'})),[],null,{}]){
  const f=fixture();await assert.rejects(importModels(f.service,items),{code:'invalid_selection'});assert.equal(f.saves,0);assert.equal(f.reads,0);assert.deepEqual(f.service.config.value,f.original);
 }
});
test('export retains its existing 500 exact-route bound independently',async()=>{
 const f=fixture();await assert.rejects(exportModels(f.service,Array.from({length:501},(_,i)=>'route-'+i)),{code:'invalid_selection'});assert.equal(f.saves,0);
});
