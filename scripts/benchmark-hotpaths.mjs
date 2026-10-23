// Synthetic, offline benchmark. Never opens the gateway's real database or configuration.
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const root=path.resolve(option('--root')??path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const {Ledger}=await import(pathToFileURL(path.join(root,'src/store.mjs'))),{dayIn}=await import(pathToFileURL(path.join(root,'src/util.mjs')));
const dir=await mkdtemp(path.join(tmpdir(),'gateway-hotpaths-')),ledger=new Ledger(dir),hash=s=>createHash('sha256').update(s).digest('hex');
function measure(fn){fn();const samples=[];let result;for(let i=0;i<5;i++){const start=performance.now();result=fn();samples.push(performance.now()-start);}const sorted=[...samples].sort((a,b)=>a-b);return {medianMs:sorted[2],samplesMs:samples,result};}
try{
  for(let i=0;i<64;i++)ledger.set('SAMPLE_'+i,{value:i,label:'synthetic'});
  let prepareCalls=0;const prepare=ledger.db.prepare.bind(ledger.db);ledger.db.prepare=sql=>{prepareCalls++;return prepare(sql);};
  const metadata=measure(()=>{let sum=0;for(let i=0;i<20000;i++)sum+=ledger.get('SAMPLE_'+(i%64)).value;return sum;});metadata.prepareCallsIncludingWarmup=prepareCalls;
  const dates=Array.from({length:3120},(_,i)=>new Date(Date.UTC(2026,9,23,0,i)));
  const calendar=measure(()=>hash(dates.map(d=>dayIn(d,'Asia/Shanghai')).join('|')));
  ledger.db.exec('BEGIN');const insert=prepare('INSERT INTO balance_observations(account_id,checked_at,unit,value) VALUES (?,?,?,?)');
  for(let i=0;i<50000;i++)insert.run(i%1000===0?'SAMPLE_TARGET':'SAMPLE_OTHER','2026-01-01','credits',i);
  ledger.db.exec('COMMIT');
  const history=measure(()=>{let sum=0;for(let i=0;i<100;i++)sum+=ledger.balanceChanges('SAMPLE_TARGET',50).length;return sum;});
  const queryPlan=prepare('EXPLAIN QUERY PLAN SELECT * FROM balance_observations WHERE account_id=? ORDER BY id DESC LIMIT 1').all('SAMPLE_TARGET').map(r=>r.detail);
  const report={schema:1,node:process.version,root,input:{metadataReadsPerRound:20000,metadataKeys:64,datesPerRound:3120,timezone:'Asia/Shanghai',historyRows:50000,historyReadsPerRound:100,historyRowsPerRead:50,warmup:1,measuredRounds:5,synthetic:true},metadata,calendar,history,queryPlan};
  const text=JSON.stringify(report,null,2)+'\n';if(option('--output'))await writeFile(path.resolve(option('--output')),text);console.log(text);
}finally{ledger.close();await rm(dir,{recursive:true,force:true});}
