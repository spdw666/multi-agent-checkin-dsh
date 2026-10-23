// Offline synthetic directory benchmark; --root selects baseline or modified tree.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
const at=process.argv.indexOf('--root'),root=resolve(at>=0?process.argv[at+1]:'.');
const {Router}=await import(pathToFileURL(resolve(root,'src/router.mjs')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){
 const calls=new Map(),normal=['deepseek-v4','glm-5.3'].map(id=>({id,tools:true,callable:true,maxTokens:4096,contextWindow:32768}));
 const config={value:{accounts:[{id:'a',platform:'bigmodel'},{id:'q',platform:'qoder'}],upstreams:[{id:'u',kind:'bigmodel',accountId:'a'},{id:'q',kind:'qoder',accountId:'q'}],routes:[{id:'DS',targets:[{upstreamId:'u',model:'deepseek-v4'}]},{id:'GLM',targets:[{upstreamId:'u',model:'glm-5.3'}]},{id:'Q',targets:[{upstreamId:'q',model:'gmodel'}]}],modelRelay:{enabled:true}}};
 const platforms={models:async id=>{calls.set(id,(calls.get(id)??0)+1);await sleep(id==='q'?60:30);return id==='u'?normal:[{...normal[1],id:'gmodel',name:'GLM-5.3',source:'qoder-official-signed-catalog'}]}};
 return {router:new Router(config,platforms),calls};
}
const samples=[];let calls,hash;
for(let i=0;i<6;i++){
 const f=fixture(),start=performance.now(),result=await f.router.models(),elapsed=performance.now()-start;
 const current=createHash('sha256').update(JSON.stringify(result)).digest('hex');if(hash&&hash!==current)throw Error('nondeterministic catalogue');hash=current;
 if(i)samples.push(elapsed);calls=Object.fromEntries(f.calls);
}
const delayed={samplesMs:samples.map(n=>+n.toFixed(3)),medianMs:+[...samples].sort((a,b)=>a-b)[2].toFixed(3),upstreamCalls:calls,resultSha256:hash};
const hot=[];
for(const enabledRoutes of [14,83]){
 const config={value:{accounts:Array.from({length:29},(_,i)=>({id:'a'+i,platform:'bigmodel',credentials:{kind:'file',file:'SAMPLE-'+i}})),upstreams:Array.from({length:29},(_,i)=>({id:'u'+i,kind:'bigmodel',accountId:'a'+i})),routes:Array.from({length:83},(_,i)=>({id:'route-'+i,enabled:i<enabledRoutes,targets:[{upstreamId:'u'+i%29,model:'model-'+i%12}]})),modelRelay:{enabled:true}}};
 const catalog=Array.from({length:12},(_,i)=>({id:'model-'+i,tools:true,callable:true,maxTokens:4096,contextWindow:32768}));let lookups=0,poolReads=0;
 const router=new Router(config,{models:async()=>{lookups++;return catalog}},{ledger:{get:()=>{poolReads++;return undefined;}}});
 for(let i=0;i<10;i++)await router.models();lookups=0;poolReads=0;const rounds=[];let last,outputHash;
 for(let r=0;r<5;r++){
  const start=performance.now();for(let i=0;i<100;i++)last=await router.models();rounds.push(performance.now()-start);
  const digest=createHash('sha256').update(JSON.stringify(last)).digest('hex');if(outputHash&&outputHash!==digest)throw Error('hot directory result changed');outputHash=digest;
 }
 hot.push({accounts:29,routes:83,enabledRoutes,iterations:500,warmups:10,samples100CallsMs:rounds.map(v=>+v.toFixed(3)),median100CallsMs:+[...rounds].sort((a,b)=>a-b)[2].toFixed(3),catalogLookups:lookups,poolLedgerReads:poolReads,resultSha256:outputHash});
}
console.log(JSON.stringify({benchmark:'catalog-staggered-and-hot',root,delayed,hot}));
