// Targeted retry via the running authenticated gateway; no second audit writer.
import {resolve,dirname,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {errorView,rememberSecret} from '../src/util.mjs';
const file=resolve(process.argv[2]??'config.local.json');
try{
 const config=JSON.parse(await readFile(file,'utf8'));
 const dataDir=resolve(dirname(file),config.dataDir);
 const runtime=JSON.parse(await readFile(join(dataDir,'runtime.json'),'utf8'));
 const keys=JSON.parse(await readFile(join(dataDir,'api-keys.json'),'utf8'));rememberSecret(keys.adminKey);
 const url=new URL(runtime.baseUrl);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Runtime is not a local gateway');
 const headers={Authorization:`Bearer ${keys.adminKey}`,'Content-Type':'application/json'},started=Date.now();
 const initial=await fetch(runtime.baseUrl+'/admin/model-tests',{method:'POST',headers,body:JSON.stringify({scope:'retry'}),signal:AbortSignal.timeout(15000)});
 const first=await initial.json();if(!initial.ok)throw Object.assign(Error(first.error?.message??'Retry request failed'),first.error);
 const minimumStart=first.scope==='retry'?Date.parse(first.startedAt):started;
 for(;;){
  const response=await fetch(runtime.baseUrl+'/admin/model-tests',{headers,signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Audit status HTTP '+response.status);
  const report=await response.json();
  if(report.scope==='retry'&&Date.parse(report.startedAt)>=minimumStart&&['completed','error'].includes(report.status)){
   const keys=new Set(report.jobKeys??[]),rows=report.results.filter(r=>keys.has(r.upstreamId+'\0'+r.model));
   for(const r of rows)console.log('RETEST',JSON.stringify({upstreamId:r.upstreamId,model:r.model,status:r.status,reason:r.reason}));
   console.log('RETEST_SUMMARY',JSON.stringify(report.summary??{}));
   if(report.status==='error')throw Object.assign(Error(report.error?.message??'Audit failed'),report.error);
   break;
  }
  if(Date.now()-started>1800000)throw Error('Targeted audit exceeded 30-minute wait budget');
  await new Promise(r=>setTimeout(r,1000));
 }
}catch(e){console.log(JSON.stringify({error:errorView(e)}));process.exitCode=1;}
