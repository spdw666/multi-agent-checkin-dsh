import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {readTraeIdentity,TraeUsageClient}=await import(process.env.TEST_TRAE_BUNDLE?pathToFileURL(process.env.TEST_TRAE_BUNDLE).href:new URL('../vendor/trae-core.mjs',import.meta.url).href);
async function fixture(work,{ids=['1111111111111111','2222222222222222'],sessions={}}={}){
 const root=await mkdtemp(join(tmpdir(),'trae-device-'));
 try{
  const file=join(root,'User/globalStorage/storage.json');await mkdir(join(root,'User/globalStorage'),{recursive:true});
  const storage={'telemetry.machineId':'native-machine','telemetry.devDeviceId':'telemetry-uuid',...Object.fromEntries(ids.map(id=>['iCubeAuthInfo://icube-dc:'+id,'private-key-pair-placeholder']))};
  await writeFile(file,JSON.stringify(storage));
  for(const [session,log] of Object.entries(sessions)){await mkdir(join(root,'logs',session),{recursive:true});await writeFile(join(root,'logs',session,'main.log'),log);}
  const read=()=>readTraeIdentity({path:file,edition:'cn',source:'desktop'},{platform:'linux',home:root,env:{}});
  await work(read);
 }finally{await rm(root,{recursive:true,force:true});}
}
const init=id=>'[ICDRS] (init) initialization done, did: '+id+', ldid: aha-local, rdid: '+id;
test('multiple historical keys use native current ID, not telemetry or first entry',async()=>fixture(async read=>assert.equal((await read()).deviceId,'2222222222222222'),{sessions:{'20261009T120000':init('2222222222222222')}}));
test('newest native session wins over historical device logs',async()=>fixture(async read=>assert.equal((await read()).deviceId,'2222222222222222'),{sessions:{'20261008T100000':init('1111111111111111'),'20261009T120000':init('2222222222222222')}}));
test('multiple histories without native evidence fail explicitly instead of wrong claim',async()=>fixture(async read=>assert.rejects(read(),/multiple historical device identities/)));
test('newest session still initializing never falls back to an obsolete completed session',async()=>fixture(async read=>assert.rejects(read(),/multiple historical device identities/),{sessions:{'20261008T100000':init('1111111111111111'),'20261009T120000':'[ICDRS] (init) start'}}));
test('last complete initialization within a session wins',async()=>fixture(async read=>assert.equal((await read()).deviceId,'2222222222222222'),{sessions:{'20261009T120000':init('1111111111111111')+'\n'+init('2222222222222222')}}));
test('native current device absent from key records fails instead of using an old ID',async()=>fixture(async read=>assert.rejects(read(),/active device is not present/),{sessions:{'20261009T120000':init('3333333333333333')}}));
test('single known device remains compatible without client logs',async()=>fixture(async read=>assert.equal((await read()).deviceId,'1111111111111111'),{ids:['1111111111111111']}));
test('resolve rdid init line supports alternate native log shape',async()=>fixture(async read=>assert.equal((await read()).deviceId,'2222222222222222'),{sessions:{'20261009T120000':'[ICDRS] (init) resolve rdid: 2222222222222222'}}));
test('tail init can override old startup identity without reading whole large log',async()=>fixture(async read=>assert.equal((await read()).deviceId,'2222222222222222'),{sessions:{'20261009T120000':init('1111111111111111')+'\n'+'x'.repeat(350000)+'\n'+init('2222222222222222')}}));
test('resolved native device is sent unchanged to check-in status and claim',async()=>fixture(async read=>{
 const identity=await read(),requests=[];
 const client=new TraeUsageClient({credential:async()=>({accessToken:'fixture-token',userRegion:'CN',edition:'cn'}),deviceId:async()=>identity.deviceId,fetchImpl:async(url,opts)=>{requests.push({url,device:opts.headers['x-device-id']});return Response.json(url.endsWith('/status')?{enable:true,checked_in:false,credits:100}:{code:0});}});
 await client.checkinStatus();assert.equal((await client.claimCheckin()).claimed,true);
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.device==='2222222222222222'));
},{sessions:{'20261009T120000':init('2222222222222222')}}));
