import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {miniMaxRequest,miniMaxStatus,miniMaxClaim} from '../src/minimax.mjs';
import {miniMaxLeaseEndpoint,requestMiniMaxLease,readMiniMaxDesktop} from '../src/minimax-desktop.mjs';
import {qwenRequest} from '../src/qwenwork.mjs';
import {CredentialManager,resolveCredentialFile} from '../src/credentials.mjs';
import {Ledger} from '../src/store.mjs';
import {ClaimService} from '../src/claims.mjs';
import {Scheduler} from '../src/scheduler.mjs';
import {zcodeStatus,zcodeClaim,zcodeReceiptKey} from '../src/zcode.mjs';
import {hash,dayIn,AppError} from '../src/util.mjs';
const credential={accessToken:'fixture-opaque-token',principal:'account-a',region:'cn',authMode:'desktop-oauth',webIdentity:{device_id:'device-a',user_id:'account-a'}};
const temp=()=>mkdtemp(join(tmpdir(),'credit-v2-'));
test('MiniMax native OAuth uses bearer, mcode and account-owned device; POST signs exact JSON',()=>{
 const {url,options}=miniMaxRequest(credential,'/signin/claim',{body:{},now:1791354000000});
 const u=new URL(url);assert.equal(u.searchParams.has('token'),false);assert.equal(u.searchParams.get('client'),'mcode');assert.equal(u.searchParams.get('device_id'),'device-a');assert.equal(options.headers.Authorization,'Bearer fixture-opaque-token');assert.equal(options.body,'{}');assert.equal(options.headers['x-signature'],createHash('md5').update('1791354000I*7Cf%WZ#S&%1RlZJ&C2{}').digest('hex'));
 const other=miniMaxRequest({...credential,region:'intl',webIdentity:{device_id:'device-b',user_id:'account-b'}},'/signin/status');assert.equal(new URL(other.url).hostname,'agent.minimax.io');assert.equal(new URL(other.url).searchParams.get('device_id'),'device-b');
});
test('MiniMax real shape: today status 2 -> 3 and claim_result 1/2; malformed results fail',async()=>{
 const fetchImpl=async()=>Response.json({base_resp:{status_code:0},data:{days:[{is_today:true,status:2,points:800,bonus_points:400}]}});
 assert.equal((await miniMaxStatus(credential,{fetchImpl})).claimed,false);
 assert.equal((await miniMaxStatus(credential,{fetchImpl:async()=>Response.json({base_resp:{status_code:0},data:{days:[{is_today:true,status:3,points:800}]}})})).claimed,true);
 const claim=await miniMaxClaim(credential,{fetchImpl:async()=>Response.json({base_resp:{status_code:0},data:{points:800,claim_result:2}})});assert.deepEqual(claim,{credit:800,already:true});
 await assert.rejects(miniMaxClaim(credential,{fetchImpl:async()=>Response.json({base_resp:{status_code:0},data:{claim_result:0}})}));
});
test('MiniMax lease endpoint canonicalizes Windows profile paths',()=>{const a=miniMaxLeaseEndpoint('C:\\Users\\ms\\.minimax\\','win32'),b=miniMaxLeaseEndpoint('c:\\users\\MS\\.minimax','win32');assert.equal(a.endpoint,b.endpoint);assert.equal(a.capabilityFile.toLowerCase(),b.capabilityFile.toLowerCase());});
test('MiniMax local lease handles fragmented frames and rejects a mismatched audience',async()=>{
 const dir=await temp(),cap=join(dir,'mcode-auth-lease-v1.cap'),endpoint=process.platform==='win32'?'\\\\.\\pipe\\credit-test-'+process.pid:join(dir,'test.sock');await writeFile(cap,'a'.repeat(43));let invalid=false;
 const server=net.createServer(socket=>{let b=Buffer.alloc(0);socket.on('data',chunk=>{b=Buffer.concat([b,chunk]);if(b.length<4||b.length<4+b.readUInt32BE(0))return;const r=JSON.parse(b.subarray(4).toString());assert.equal(r.capability,'a'.repeat(43));const payload=Buffer.from(JSON.stringify({version:1,requestId:r.requestId,ok:true,result:{method:'lease',accessToken:'fixture-lease',expiresAtMs:Date.now()+600000,generation:1,audience:invalid?'wrong':'agent-backend',scopes:['agent.default']}})),frame=Buffer.alloc(4+payload.length);frame.writeUInt32BE(payload.length);payload.copy(frame,4);socket.write(frame.subarray(0,3));setTimeout(()=>socket.end(frame.subarray(3)),5);});});
 await new Promise(r=>server.listen(endpoint,r));try{assert.equal((await requestMiniMaxLease(dir,{endpoint:{endpoint,capabilityFile:cap}})).accessToken,'fixture-lease');invalid=true;await assert.rejects(requestMiniMaxLease(dir,{endpoint:{endpoint,capabilityFile:cap}}),e=>e.code==='minimax_broker_invalid');}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});
test('MiniMax desktop record excludes refresh tokens from resolved credentials',async()=>{
 const dir=await temp(),profile=join(dir,'profile'),file=join(dir,'auth.json');await mkdir(profile);await writeFile(file,JSON.stringify({records:{'com.minimax.mcode.oauth.prod.cn\0fixture':{accessToken:'fixture-access',refreshToken:'fixture-refresh',clientId:'mcode-public',audience:'agent-backend',expiresAtMs:Date.now()+600000,generation:1}}}));await writeFile(join(profile,'minimax-agent-cn-config.json'),JSON.stringify({sharedUser:{realUserID:'account-a',deviceID:'device-a'}}));
 try{const r=await readMiniMaxDesktop(file,{credentials:{runtimeDataDir:dir,profileDir:profile}}, {path:p=>p},{leaseRequest:async()=>{throw new AppError('offline',401,'minimax_broker_unavailable')}});assert.equal(r.principal,'account-a');assert.equal(r.source,'desktop-oauth');assert.equal(r.refreshToken,undefined);}finally{await rm(dir,{recursive:true,force:true})}
});
test('QwenWork accepts its actual code=ok envelope, but still rejects business errors',async()=>{
 let code='ok';const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code,data:{quota:{remaining:2100}}}))});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const url='http://127.0.0.1:'+server.address().port;assert.equal((await qwenRequest(url)).data.quota.remaining,2100);code='INVALID_TOKEN';await assert.rejects(qwenRequest(url),e=>e.code==='business_error');}finally{await new Promise(r=>server.close(r))}
});
test('QwenWork CN current client storage has priority over stale non-CN storage',async()=>{
 const dir=await temp(),prior=process.env.APPDATA;try{process.env.APPDATA=dir;for(const n of ['QwenWorkCN','QwenWork']){await mkdir(join(dir,n));await writeFile(join(dir,n,'auth-v2.dat'),'{}')}const file=await resolveCredentialFile({platform:'qwenwork',credentials:{file:'auto'}},{});assert.equal(file,join(dir,'QwenWorkCN/auth-v2.dat'));}finally{process.env.APPDATA=prior;await rm(dir,{recursive:true,force:true})}
});
test('expired QwenWork credentials enter renewal without a self-flight deadlock',async()=>{
 const manager=new CredentialManager({value:{accounts:[{id:'a',platform:'qwenwork',credentials:{}}]}},{});manager.read=async()=>{throw new AppError('expired',401,'credential_expired')};manager.refreshQwen=async()=>({accessToken:'renewed-fixture'});assert.equal((await manager.resolve('a')).accessToken,'renewed-fixture');assert.equal(manager.flights.size,0);
});
test('ZCode claim persists a receipt when the native preview disappears after one-time grant',async()=>{
 const dir=await temp(),ledger=new Ledger(dir),c={...credential,identity:{deviceId:'device-a'}},plan={plan_id:'plan-a',name:'Trust',entitlements:[{grant_units:100000000,period:'one_time'}]};let claimed=false,posts=0;
 const request=async(url,options)=>{if(url.includes('/preview'))return {data:{plans:claimed?[]:[plan]}};if(url.includes('/balance'))return {data:{plans:claimed?[plan]:[],balances:claimed?[{plan_id:'plan-a',remaining_units:100000000}]:[]}};assert.equal(options.headers['X-Aliyun-Captcha-Verify-Region'],'sgp');assert.equal(options.headers['X-Aliyun-Captcha-Verify-Param'],'fixture-param');posts++;claimed=true;return {data:{plan}}};
 try{const result=await zcodeClaim(c,{ledger,request,profileDir:dir,validate:async()=> 'fixture-param'});assert.equal(result.credit,100000000);assert.equal(result.unit,'token');assert.equal((await zcodeStatus(c,{ledger,request})).claimed,true);assert.equal(posts,1);assert.deepEqual(ledger.get(zcodeReceiptKey(c,'plan-a')).periods,['one_time']);}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('ZCode old per-plan receipt is reconciled from balance without a second POST',async()=>{
 const dir=await temp(),ledger=new Ledger(dir),c={...credential,identity:{deviceId:'a'}};ledger.set(zcodeReceiptKey(c,'old'),{serverConfirmed:true,planId:'old'});try{const s=await zcodeStatus(c,{ledger,request:async url=>{if(url.includes('/preview'))return {data:{plans:[]}};assert.ok(url.includes('/balance'));return {data:{plans:[{plan_id:'old'}]}}}});assert.equal(s.claimed,true);assert.equal(ledger.get('zcode-confirmed/'+hash(c.principal)).reconciled,true);}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('daily quota observations keep observed status on repeat and never fabricate a claim POST',async()=>{
 const dir=await temp(),ledger=new Ledger(dir),config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'qwenwork',tasks:[{id:'daily-quota',enabled:true}]}]}};let posts=0;try{const service=new ClaimService(config,{resolve:async()=>({principalHash:'a'})},{status:async()=>({known:true,observed:true,reason:'automatic_daily_quota_read_only',details:{wallets:{dailyBalance:100}}}),claim:async()=>{posts++;}},ledger);assert.equal((await service.run('a','daily-quota')).status,'observed');assert.equal((await service.run('a','daily-quota')).status,'observed');assert.equal(posts,0);}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('ZCode pre-submission challenge is action_required rather than uncertain; later verification can retry',async()=>{
 const dir=await temp(),ledger=new Ledger(dir),config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'a',platform:'zcode',tasks:[{id:'free-plan-claim',enabled:true}]}]}};let calls=0,claimed=false;const service=new ClaimService(config,{resolve:async()=>({principalHash:'a'})},{status:async()=>({known:true,active:true,claimed}),claim:async()=>{calls++;if(calls===1){const e=new AppError('challenge',409,'zcode_validation_required');e.actionRequired=true;e.beforeSubmission=true;throw e}claimed=true;return {credit:100,unit:'token'}}},ledger);try{assert.equal((await service.run('a','free-plan-claim')).status,'action_required');assert.equal((await service.run('a','free-plan-claim')).status,'success');assert.equal(calls,2);}finally{ledger.close();await rm(dir,{recursive:true,force:true})}
});
test('enabling an account after the old daily run completed still schedules it today',async()=>{
 const dir=await temp(),ledger=new Ledger(dir),config={value:{scheduler:{enabled:true,startup:false,timezone:'Asia/Shanghai',hour:0,minute:0,jitterSeconds:0,retryMinutes:60},accounts:[{id:'a',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}]}};let runs=0;const scheduler=new Scheduler(config,{all:async()=>{runs++;return []}},ledger);scheduler.stopped=false;try{await scheduler.tick();assert.equal(runs,1);await scheduler.tick();assert.equal(runs,1);config.value.accounts.push({id:'b',enabled:true,tasks:[{id:'daily-quota',enabled:true}]});await scheduler.tick();assert.equal(runs,2);assert.equal(ledger.get('schedule-last').day,dayIn());}finally{await scheduler.stop();ledger.close();await rm(dir,{recursive:true,force:true})}
});
