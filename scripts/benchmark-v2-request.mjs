// Offline, synthetic whole-router benchmark. No provider or real account calls.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]??'.');
const {Router}=await import(pathToFileURL(path.join(root,'src/router.mjs'))),{collectChat}=await import(pathToFileURL(path.join(root,'src/openai.mjs')));
const request={model:'SAMPLE-route',messages:Array.from({length:256},(_,i)=>({role:i%2?'assistant':'user',content:'SAMPLE context '.repeat(512)})),tools:Array.from({length:64},(_,i)=>({type:'function',function:{name:'read_sample_'+i,parameters:{type:'object',description:'SAMPLE schema '.repeat(128),properties:{text:{type:'string'}}}}})),max_tokens:512};
const targets=Array.from({length:8},(_,i)=>({upstreamId:'u'+i,model:'SAMPLE-model'})),config={value:{accounts:[],upstreams:targets.map(t=>({id:t.upstreamId,kind:'bigmodel'})),routes:[{id:request.model,targets}],modelRelay:{enabled:false}}};
let calls=0,rows=0;
const platforms={models:async()=>[{id:'SAMPLE-model',tools:true,contextWindow:10000000,maxTokens:4096}],chat:async(t)=>{calls++;if(t.upstreamId!=='u7')throw Object.assign(Error('SAMPLE failure'),{status:500,code:'sample_failure'});return {response:new Response(JSON.stringify({choices:[{message:{content:'SAMPLE answer'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})}}};
const state=new Map(),router=new Router(config,platforms,{ledger:{get:k=>state.get(k),set:(k,v)=>state.set(k,v),record(){},beginUsage:()=>++rows,finishUsage(){}}}),iterations=25,rounds=[];
for(let round=0;round<6;round++){const start=performance.now();for(let i=0;i<iterations;i++){const result=await collectChat(router.chat(request));assert.equal(result.choices[0].message.content,'SAMPLE answer');}const ms=performance.now()-start;if(round)rounds.push(ms);}
assert.equal(calls,6*iterations*8);assert.equal(rows,calls);
console.log(JSON.stringify({benchmark:'large_request_8_attempts',root,input:{serializedBytes:Buffer.byteLength(JSON.stringify(request)),messages:256,tools:64,attemptsPerRequest:8,iterations,warmups:1,rounds:5},roundsMs:rounds,medianMs:[...rounds].sort((a,b)=>a-b)[2],dispatches:calls,usageRows:rows,output:'SAMPLE answer',equality:'all answers and attempt counts asserted'},null,2));
