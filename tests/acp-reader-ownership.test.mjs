import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=process.env.SAMPLE_ACP_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {consumeWorkBuddyAcpStream}=await import(pathToFileURL(join(root,'src/workbuddy-executor-acp.mjs')));
const wire=row=>'data: '+JSON.stringify(row)+'\n\n';
const terminal={jsonrpc:'2.0',id:'SAMPLE_RPC',result:{stopReason:'end_turn'}};
const update={jsonrpc:'2.0',method:'session/update',params:{sessionId:'SAMPLE_SESSION',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SAMPLE'}}}};
function response(chunks,{never=false,cancelThrows=false}={}){
 let i=0,cancels=0;const body=new ReadableStream({pull(c){if(i<chunks.length)c.enqueue(new TextEncoder().encode(chunks[i++]));else if(!never)c.close();},cancel(){cancels++;if(cancelThrows)throw new Error('SAMPLE cancel failure');}});
 return {body,get cancels(){return cancels;},response:new Response(body,{headers:{'content-type':'text/event-stream'}})};
}
test('early terminal result cancels unread transport and releases its reader lock',async()=>{
 const f=response([wire(terminal),'SAMPLE unread']);assert.equal((await consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC')).stopReason,'end_turn');assert.equal(f.cancels,1);assert.equal(f.body.locked,false);
});
test('clean EOF terminal without a final delimiter releases the reader lock',async()=>{
 const f=response([wire(update),wire(terminal).trimEnd()]);assert.equal((await consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC')).stopReason,'end_turn');assert.equal(f.body.locked,false);
});
test('missing terminal rejection also releases the reader lock',async()=>{
 const f=response([wire(update)]);await assert.rejects(consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC'),e=>e.code==='wb_acp_terminal_missing');assert.equal(f.body.locked,false);
});
test('callback failure preserves the exact error while canceling and releasing the reader',async()=>{
 const f=response([wire(update),wire(terminal)]),failure=new Error('SAMPLE callback failed');await assert.rejects(consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC',()=>{throw failure;}),e=>e===failure);assert.equal(f.cancels,1);assert.equal(f.body.locked,false);
});
test('frame limit rejection releases the reader without weakening the original bound',async()=>{
 const f=response(['data: '+JSON.stringify({SAMPLE:'x'.repeat(2*1024*1024)})+'\n\n'],{never:true});await assert.rejects(consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC'),e=>e.code==='wb_acp_frame_limit');assert.equal(f.cancels,1);assert.equal(f.body.locked,false);
});
test('cancel rejection does not leave the already owned stream locked',async()=>{
 const f=response([wire(terminal)],{never:true,cancelThrows:true});assert.equal((await consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC')).stopReason,'end_turn');assert.equal(f.cancels,1);assert.equal(f.body.locked,false);
});
test('parent cancellation while read awaits propagates its original reason and releases the reader',async()=>{
 const f=response([],{never:true}),controller=new AbortController(),reason=new Error('SAMPLE cancelled');const pending=consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC',undefined,{signal:controller.signal});controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(f.cancels,1);assert.equal(f.body.locked,false);
});
test('pre-cancelled request never acquires a stream reader',async()=>{
 const f=response([wire(terminal)]),controller=new AbortController(),reason=new Error('SAMPLE pre-cancelled');controller.abort(reason);await assert.rejects(consumeWorkBuddyAcpStream(f.response,'SAMPLE_RPC',undefined,{signal:controller.signal}),e=>e===reason);assert.equal(f.cancels,0);assert.equal(f.body.locked,false);
});
