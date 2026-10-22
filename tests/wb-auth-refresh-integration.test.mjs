import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {createService}=await import(pathToFileURL(join(root,'src/service.mjs'))),{startServer}=await import(pathToFileURL(join(root,'src/server.mjs'))),{hash}=await import(pathToFileURL(join(root,'src/util.mjs')));
async function fixture(t,{nativeAccepted=true}={}) {
 const dir=await mkdtemp(join(tmpdir(),'wb-auth-api-')),data=join(dir,'data'),file=join(data,'accounts','SAMPLE-wb','workbuddy-session.json'),nativeFile=join(dir,'native.info');await mkdir(join(file,'..'),{recursive:true});
 const old={accessToken:'SAMPLE-revoked',principal:'SAMPLE-same-owner',uid:'SAMPLE-same-owner',edition:'cn',domain:'www.workbuddy.cn',expiresAtMs:Date.now()+86400000};
 await writeFile(file,JSON.stringify(old));await writeFile(nativeFile,'SAMPLE stable native login');
 const config=JSON.parse(await readFile(join(root,'config.example.json'),'utf8'));config.dataDir=data;config.scheduler.enabled=false;config.scheduler.startup=false;config.workbuddy={autoTasks:false,autoMigrateSessions:false};config.accounts=[{id:'SAMPLE-wb',platform:'workbuddy',enabled:true,inferenceEnabled:false,edition:'cn',credentials:{kind:'file',file},tasks:[]}];config.upstreams=[];config.routes=[];
 const conf=join(dir,'config.json');await writeFile(conf,JSON.stringify(config));const before=await readFile(conf),s=await createService(conf),calls=[];let nativeReads=0,refreshes=0;
 const realFetch=globalThis.fetch;
 const mocked=async(url,init)=>{
  const path=new URL(url).pathname;if(new URL(url).hostname==='127.0.0.1')return realFetch(url,init);
  const token=init.headers.Authorization,c={path,method:init.method,token};calls.push(c);
  if(token==='Bearer SAMPLE-revoked'||!nativeAccepted)return new Response('SAMPLE unauthorized HTML',{status:401,headers:{'content-type':'text/html'}});
  assert.equal(token,'Bearer SAMPLE-native-fresh');
  if(path==='/v2/activity/growth/tasks')return Response.json({code:0,data:{tasks:[{task_code:'SAMPLE-task',title:'SAMPLE daily task',accept_status:'claimed',progress:{current:1,target:1}}]}});
  assert.equal(path,'/v2/billing/meter/get-user-resource');return Response.json({code:0,data:{Response:{Data:{Accounts:[{AccountId:'SAMPLE-package',CapacitySize:100,CapacityRemain:90}],TotalCount:1}}}});
 };
 globalThis.fetch=mocked;
 s.workbuddyRuntime={fetchImpl:mocked,sessionRoot:()=>join(dir,'SAMPLE-session-root'),isRunning:async()=>false};
 s.credentials.workbuddyNativeRead=async()=>{nativeReads++;return {credential:{...old,accessToken:'SAMPLE-native-fresh',refreshToken:'SAMPLE-native-rt',expiresAtMs:Date.now()+172800000},source:{file:nativeFile,fingerprint:hash(await readFile(nativeFile))}};};
 s.credentials.workbuddyRefresh=async()=>{refreshes++;assert.fail('read import must not rotate any refresh token')};
 s.platforms.wb.fetchCheckinStatus=async c=>{if(c.accessToken==='SAMPLE-revoked')throw Object.assign(Error('SAMPLE unauthorized'),{status:401});return {active:true,todayCheckedIn:true,todayCredit:100};};
 s.ledger.set('wb-management-official-status:SAMPLE-wb',{status:'banned',reason:'SAMPLE historical official rejection',source:'official_response'});
 const server=await startServer(s,{port:0});
 t.after(async()=>{await server.close();await s.close();globalThis.fetch=realFetch;await rm(dir,{recursive:true,force:true,maxRetries:5});});
 return {s,server,calls,before,conf,file,nativeFile,nativeReads:()=>nativeReads,refreshes:()=>refreshes,get:async()=>{const r=await realFetch(server.baseUrl+'/admin/workbuddy/accounts/SAMPLE-wb/details?refresh=1',{headers:{Authorization:'Bearer '+s.keys.adminKey}});assert.equal(r.status,200);return r.json();}};
}
test('actual admin detail refresh concurrently recovers balance and task reads once, preserves disabled inference and native login, clears only verified official failure',async t=>{
 const f=await fixture(t),response=await f.get(),a=response.account;
 assert.equal(a.credentialStatus,'authenticated');assert.equal(a.ban.status,'clear');assert.equal(a.remaining,90);assert.equal(a.dailyCheckin.todayCheckedIn,true);assert.equal(a.tasks.items.length,1);assert.equal(a.tasks.stale,false);assert.equal(a.stale,false);assert.equal(a.inferenceEnabled,false);assert.equal(f.nativeReads(),1);assert.equal(f.refreshes(),0);
 assert.ok(f.calls.some(c=>c.path==='/v2/activity/growth/tasks'&&c.token==='Bearer SAMPLE-native-fresh'));
 assert.ok(f.calls.every(c=>c.path==='/v2/activity/growth/tasks'&&c.method==='GET'||c.path==='/v2/billing/meter/get-user-resource'&&c.method==='POST'));
 assert.deepEqual(await readFile(f.conf),f.before);assert.equal(await readFile(f.nativeFile,'utf8'),'SAMPLE stable native login');
 const serialized=JSON.stringify(response);for(const secret of ['SAMPLE-revoked','SAMPLE-native-fresh','SAMPLE-native-rt'])assert.equal(serialized.includes(secret),false);
 const later=await f.get();assert.equal(later.account.credentialStatus,'authenticated');assert.equal(f.nativeReads(),1);assert.equal(f.refreshes(),0);
});
test('real detail refresh with rejected candidate keeps official ban and old snapshot; no false clear or balance success',async t=>{
 const f=await fixture(t,{nativeAccepted:false}),before=await readFile(f.file),response=await f.get();
 assert.equal(response.account.ban.status,'banned');assert.equal(response.account.credentialStatus,'banned');assert.equal(response.account.error.status,401);assert.deepEqual(await readFile(f.file),before);assert.equal(f.refreshes(),0);assert.equal(f.s.ledger.get('wb-management-official-status:SAMPLE-wb').status,'banned');assert.deepEqual(await readFile(f.conf),f.before);
});
