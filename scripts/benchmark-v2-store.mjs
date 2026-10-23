// Offline synthetic benchmark; --root selects baseline/modified/rollback code.
// Node 22+: node scripts/benchmark-v2-store.mjs --root PATH [--rows 100000] [--rounds 5] [--out FILE]
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const args=process.argv.slice(2),option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1]};
const root=resolve(option('root')??fileURLToPath(new URL('../',import.meta.url))),rows=Number(option('rows')??100000),rounds=Number(option('rounds')??5);
if(!Number.isInteger(rows)||rows<1000||rows>1000000||!Number.isInteger(rounds)||rounds<1||rounds>20)throw Error('Invalid synthetic benchmark size');
const {Ledger}=await import(pathToFileURL(join(root,'src/store.mjs'))),{buildActivityContext}=await import(pathToFileURL(join(root,'src/activity-context.mjs'))),{buildRequestDiagnostics}=await import(pathToFileURL(join(root,'src/request-diagnostics.mjs')));
const dir=mkdtempSync(join(tmpdir(),'gateway-store-v2-bench-')),ledger=new Ledger(dir),now=Date.parse('2026-10-23T12:00:00Z');
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
try{
 const insert=ledger.db.prepare('INSERT INTO usage_calls(started_at,account_id,model,status,detail) VALUES (?,?,?,?,?)'),records=ledger.db.prepare('INSERT INTO records(time,day,platform,account_id,task,status,result) VALUES (?,?,?,?,?,?,?)');
 ledger.db.exec('BEGIN');for(let i=0;i<rows;i++){const startedAt=new Date(now-(rows-i)*300000).toISOString(),accountId='SAMPLE-'+i%40,model='SAMPLE-model-'+i%5,status=i%10?'completed':'failed';insert.run(startedAt,accountId,model,status,JSON.stringify({startedAt,accountId,model,status,requestId:'SAMPLE-request-'+i,source:'api',dispatched:true,totalTokens:i%1000,context:{schema:1,composition:{user:{chars:100,estimatedTokens:25}},messageCount:1,toolNames:[],fileActivity:{}}}));records.run(startedAt,startedAt.slice(0,10),'SAMPLE-'+i%5,accountId,'daily','success',JSON.stringify({sample:i}));}ledger.db.exec('COMMIT');
 // Match the live configuration's account cardinality without reading it. The
 // nested credential references are synthetic; diagnostics must walk these too.
 const config={accounts:Array.from({length:29},(_,i)=>({id:'SAMPLE-'+i,uid:'SAMPLE-uid-'+i,credentials:{source:'SAMPLE-reference-source-'+i,accessToken:{env:'SAMPLE_ACCESS_REFERENCE_'+i},refreshToken:{file:'SAMPLE_REFRESH_REFERENCE_'+i},native:{database:'SAMPLE_DATABASE_REFERENCE_'+i,principal:'SAMPLE_PRINCIPAL_REFERENCE_'+i}}})),upstreams:Array.from({length:29},(_,i)=>({id:'SAMPLE-upstream-'+i,accountId:'SAMPLE-'+i}))};
 const service={ledger,config:{value:config},keys:{apiKey:'SAMPLE_GATEWAY_API_REFERENCE',adminKey:'SAMPLE_GATEWAY_ADMIN_REFERENCE'}},from=new Date(now-40*86400000).toISOString(),to=new Date(now).toISOString();
 const cases={
  analyticsPages(){const all=[];let cursor=0;do{const p=ledger.usage({from,to,beforeId:cursor,limit:500,includeTotal:false});all.push(...p.records);cursor=p.nextBeforeId;if(!cursor||all.length>=10000)break;}while(true);return all;},
  accountUsage(){return Array.from({length:20},(_,i)=>ledger.usage({accountId:'SAMPLE-'+i%40,limit:50,beforeId:Math.floor(rows/2)}));},
  accountRecords(){return Array.from({length:20},(_,i)=>ledger.records({accountId:'SAMPLE-'+i%40,platform:'SAMPLE-'+i%5,limit:100}));},
  activity(){return buildActivityContext(service,{range:'30d',now,limit:100});},
  diagnostics(){return buildRequestDiagnostics(service,{range:'30d',now,limit:100});}
 };
 const measurements={};for(const [name,fn] of Object.entries(cases)){const hashes=[],samples=[];for(let i=0;i<=rounds;i++){const start=performance.now(),value=fn(),ms=performance.now()-start;hashes.push(digest(value));if(i)samples.push(ms);}if(new Set(hashes).size!==1)throw Error('Nondeterministic benchmark output: '+name);measurements[name]={medianMs:[...samples].sort((a,b)=>a-b)[Math.floor(samples.length/2)],samplesMs:samples,resultSha256:hashes[0]};}
 const report={schema:1,node:process.version,root,fixture:{rows,rounds,warmups:1,now:new Date(now).toISOString(),accountCount:40,configuredAccountCount:29,configSha256:digest(config),credentialRefsPerAccount:5,modelCount:5,sampleOnly:true},measurements};
 if(option('out'))writeFileSync(resolve(option('out')),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
