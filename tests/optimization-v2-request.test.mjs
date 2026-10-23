import test from 'node:test';
import assert from 'node:assert/strict';
import {UsageAttempt} from '../src/usage.mjs';
import {captureRequestContext} from '../src/activity-context.mjs';
import {Router} from '../src/router.mjs';
import {collectChat} from '../src/openai.mjs';

const sample=()=>({model:'SAMPLE-route',messages:[{role:'user',content:'SAMPLE prompt'}, {role:'assistant',content:null,tool_calls:[{function:{name:'read_file',arguments:'SAMPLE arguments'}}]}, {role:'tool',content:'SAMPLE result'}],tools:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}],max_tokens:512});
const target={upstreamId:'u0',model:'SAMPLE-model'};
function fixture(n=3){
 const rows=[],calls=[],config={value:{accounts:[],upstreams:Array.from({length:n},(_,i)=>({id:'u'+i,kind:'bigmodel'})),routes:[{id:'SAMPLE-route',targets:Array.from({length:n},(_,i)=>({...target,upstreamId:'u'+i}))}],modelRelay:{enabled:false}}};
 const platforms={models:async()=>[{id:'SAMPLE-model',tools:true,maxTokens:4096,contextWindow:10000000}],chat:async(t,body)=>{calls.push(body);if(calls.length<n)throw Object.assign(Error('SAMPLE retry'),{status:500,code:'sample_failure'});return {response:new Response(JSON.stringify({choices:[{message:{content:'SAMPLE answer'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})}}};
 const state=new Map(),ledger={get:k=>state.get(k),set:(k,v)=>state.set(k,v),record(){},beginUsage:r=>(rows.push(r),rows.length-1),finishUsage:(id,r)=>rows[id]=r};
 return {router:new Router(config,platforms,{ledger}),rows,calls};
}
test('v2 request: direct UsageAttempt callers keep fresh metadata capture',()=>{
 const req=sample(),a=new UsageAttempt(null,{},req,target);req.messages[0].content+=' longer';const b=new UsageAttempt(null,{},req,target);
 assert.deepEqual(b.row.context,captureRequestContext(req));assert.notEqual(a.row.context.composition.user.chars,b.row.context.composition.user.chars);
});
test('v2 request: supplied submitted-context snapshot is used instead of re-reading payload',()=>{
 const req=sample(),snapshot=captureRequestContext(req);req.messages[0].content+=' subsequently altered';
 const a=new UsageAttempt(null,{},req,target,{requestContext:snapshot});assert.deepEqual(a.row.context,snapshot);
});
test('v2 request: each attempt has an independent deep copy of context',()=>{
 const req=sample(),snapshot=captureRequestContext(req),a=new UsageAttempt(null,{},req,target,{requestContext:snapshot}),b=new UsageAttempt(null,{},req,target,{requestContext:snapshot});
 a.row.context.composition.user.chars=999;a.row.context.toolNames.push('write_file');a.row.context.fileActivity.read=999;
 assert.deepEqual(b.row.context,snapshot);assert.notEqual(a.row.context,snapshot);assert.notEqual(b.row.context,snapshot);
});
test('v2 request: router serializes original request once and scans tools once across retries',async()=>{
 const f=fixture(),req=sample(),stringify=JSON.stringify;let bodies=0,tools=0;
 JSON.stringify=function(value,...args){if(value===req)bodies++;if(value===req.tools)tools++;return stringify.call(this,value,...args)};
 try{await collectChat(f.router.chat(req));}finally{JSON.stringify=stringify;}
 assert.equal(f.calls.length,3);assert.equal(bodies,1);assert.equal(tools,1);
 for(const row of f.rows)assert.deepEqual(row.context,captureRequestContext(req));
 assert.equal(new Set(f.rows.map(r=>r.context)).size,3);
});
test('v2 request: retries preserve payload and do not persist prompts or tool arguments',async()=>{
 const f=fixture(),req=sample(),before=structuredClone(req);await collectChat(f.router.chat(req));assert.deepEqual(req,before);
 for(const body of f.calls)assert.deepEqual(body,req);
 const stored=JSON.stringify(f.rows);for(const text of ['SAMPLE prompt','SAMPLE arguments','SAMPLE result'])assert.equal(stored.includes(text),false);
 assert.deepEqual(f.rows.map(r=>r.status),['failed','failed','completed']);
});
test('v2 request: consecutive requests capture their own changed context',async()=>{
 const f=fixture(1),req=sample();await collectChat(f.router.chat(req));const expected=f.rows[0].context.composition.user.chars;
 req.messages[0].content+=' changed';await collectChat(f.router.chat(req));assert.equal(f.rows[1].context.composition.user.chars,expected+8);
});
test('v2 request: valid unknown route records original context without supplier attempt',async()=>{
 const f=fixture(),req=sample();req.model='SAMPLE-absent';await assert.rejects(collectChat(f.router.chat(req)),e=>e.code==='model_not_found');
 assert.equal(f.calls.length,0);assert.equal(f.rows.length,1);assert.equal(f.rows[0].rowType,'request_outcome');assert.deepEqual(f.rows[0].context,captureRequestContext(req));
});
test('v2 request: invalid body keeps metadata-only terminal failure',async()=>{
 const f=fixture();await assert.rejects(collectChat(f.router.chat({messages:null})),e=>e.code==='invalid_request_error');
 assert.equal(f.calls.length,0);assert.equal(f.rows.length,1);assert.equal(f.rows[0].context.messageCount,0);
});
