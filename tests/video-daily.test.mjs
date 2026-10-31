import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.VIDEO_TEST_ROOT??fileURLToPath(new URL('..',import.meta.url));
const load=async name=>import(pathToFileURL(join(root,'src',name)).href);
let api;try{api=await load('provider-video-daily.mjs');}catch{}
const need=()=>{assert.ok(api,'video daily-credit provider must exist');return api;};
const c={accessToken:'SAMPLE-session',authToken:'SAMPLE-session',principal:'SAMPLE-user',principalHash:'SAMPLE-principal-hash'};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const tasks=(progress=2,reward=30)=>[{task_type:1,sub_type:1,progress,reward}];

test('video providers are registered, claim-only and expose no models or chat',async()=>{
 const {desktopProvider,videoDailyProviderKinds}=await load('provider-registry.mjs');
 assert.deepEqual([...videoDailyProviderKinds],['vidu','pixverse','jimeng','kling','xiaoyunque','hailuo','liblib']);
 for(const kind of videoDailyProviderKinds){const p=await desktopProvider(kind);assert.deepEqual(await p.models(),[]);assert.equal(p.chat,undefined);assert.equal(p.descriptor.claimOnly,true);assert.equal(p.descriptor.inference,false);}
});
test('video accounts validate without an upstream, and video upstreams are rejected',async()=>{
 const {validateConfig}=await load('config.mjs');
 const config={schemaVersion:1,dataDir:'./data',accounts:[{id:'vidu-main',platform:'vidu',credentials:{kind:'file',file:'./private.json'},tasks:[{id:'daily-checkin',enabled:true}]}],upstreams:[],routes:[],server:{host:'127.0.0.1',port:0},scheduler:{timezone:'Asia/Shanghai',hour:12,minute:0,jitterSeconds:0}};
 assert.doesNotThrow(()=>validateConfig(structuredClone(config)));
 assert.throws(()=>validateConfig({...config,upstreams:[{id:'forbidden',kind:'vidu',accountId:'vidu-main'}]}),e=>e.code==='video_daily_no_inference');
});
test('opaque daily receipt rejects user-shaped and cross-principal objects',()=>{
 const {officialVideoDailySettlement}=need();
 assert.equal(officialVideoDailySettlement('vidu',c.principalHash,{officialDailyReceipt:{kind:'vidu',amount:99,day:'2026-10-27',principalHash:c.principalHash}},'2026-10-27'),null);
});
for(const amount of [0,12])test(`Vidu exact daily GET: root credit=${amount}, same-principal/day settlement`,async()=>{
 const {createVideoDailyProvider,officialVideoDailySettlement}=need();const seen=[];
 const p=createVideoDailyProvider('vidu',{now:()=>new Date('2026-10-27T04:00:00Z'),fetchImpl:async(url,o)=>{seen.push([url,o]);return json({credit:amount});}});
 const result=await p.claim(c);
 assert.equal(seen.length,1);assert.equal(seen[0][0],'https://service.vidu.cn/iam/v1/users/every-day-credit');assert.equal(seen[0][1].method,'GET');assert.equal(seen[0][1].body,undefined);assert.equal(seen[0][1].redirect,'error');
 const receipt=officialVideoDailySettlement('vidu',c.principalHash,result,'2026-10-27');assert.equal(receipt.status,amount>0?'success':'observed');assert.equal(receipt.result.credits,amount);assert.equal(receipt.result.benefitOutcome,amount>0?'newly_granted':'no_new_daily_credit');
 assert.equal(officialVideoDailySettlement('pixverse',c.principalHash,result,'2026-10-27'),null);assert.equal(officialVideoDailySettlement('vidu','OTHER',result,'2026-10-27'),null);assert.equal(officialVideoDailySettlement('vidu',c.principalHash,result,'2026-10-28'),null);
});
for(const bad of [{},{data:{credit:9}},{credit:-1},{credit:0.25},{credit:null},{credit:'NaN'},{credit:Infinity}])test(`Vidu rejects non-contract receipt ${JSON.stringify(bad)}`,async()=>{
 const {createVideoDailyProvider}=need();const p=createVideoDailyProvider('vidu',{fetchImpl:async()=>json(bad)});await assert.rejects(()=>p.claim(c),e=>e.code==='video_daily_response_invalid');
});
test('Vidu health is read-only and never calls the daily-grant endpoint',async()=>{
 const {createVideoDailyProvider}=need();const seen=[];const p=createVideoDailyProvider('vidu',{fetchImpl:async(url)=>{seen.push(url);return json({credits:0,credits_free:0,credits_subscribed:0,credits_expire_today:0});}});
 const h=await p.health(c);assert.equal(h.balance.value,0);assert.equal(h.checkin.claimed,null);assert.equal(h.capabilities.inference,false);assert.ok(seen.every(url=>url.endsWith('/credit/v1/credits/me')));
});
for(const [progress,active,claimed]of [[1,false,false],[2,true,false],[3,false,true],[4,false,false]])test(`PixVerse daily LOGIN progress ${progress}`,()=>{
 const s=need().parsePixVerseLoginTask(tasks(progress));assert.equal(s.active,active);assert.equal(s.claimed,claimed);
});
test('PixVerse does not claim absent, non-daily, unfinished or zero-reward tasks',async()=>{
 const {createVideoDailyProvider}=need();for(const rows of [[],[{task_type:2,sub_type:1,progress:2,reward:30}],tasks(1),tasks(2,0)]){const seen=[];const p=createVideoDailyProvider('pixverse',{fetchImpl:async(url)=>{seen.push(url);return json({ErrCode:0,Resp:rows});}});await assert.rejects(()=>p.claim(c),e=>e.beforeSubmission===true);assert.ok(seen.every(u=>u.endsWith('/task/list')));}
});
test('PixVerse already-claimed daily task performs no reward write',async()=>{
 const {createVideoDailyProvider}=need();const seen=[];const p=createVideoDailyProvider('pixverse',{fetchImpl:async(url)=>{seen.push(url);return json({ErrCode:0,Resp:tasks(3)});}});assert.equal((await p.claim(c)).submitted,false);assert.equal(seen.length,1);
});
test('PixVerse sends only reward/claim sub_type LOGIN=1 with Token and personal workspace',async()=>{
 const {createVideoDailyProvider}=need();const seen=[];const p=createVideoDailyProvider('pixverse',{fetchImpl:async(url,o)=>{seen.push([url,o]);return json({ErrCode:0,Resp:url.endsWith('/task/list')?tasks(2):{}});}});
 const result=await p.claim(c);assert.equal(result.submitted,true);assert.equal(result.officialDailyReceipt,undefined);assert.equal(seen.length,2);assert.equal(seen[1][0],'https://app-api.pixverse.ai/creative_platform/reward/claim');assert.equal(seen[1][1].method,'POST');assert.deepEqual(JSON.parse(seen[1][1].body),{sub_type:1});assert.equal(seen[1][1].headers.Token,c.authToken);assert.equal(seen[1][1].headers['Workspace-Id'],'0');assert.equal(seen[1][1].headers['X-Platform'],'Web');
});
for(const payload of [{ErrCode:1,Resp:[]},{Resp:[]},{ErrCode:0},{ErrCode:0,Resp:{list:[]}}])test(`PixVerse rejects bad envelope ${JSON.stringify(payload)}`,async()=>{
 const {createVideoDailyProvider}=need();await assert.rejects(()=>createVideoDailyProvider('pixverse',{fetchImpl:async()=>json(payload)}).status(c));
});
test('PixVerse duplicate daily login rows are ambiguous, never picked arbitrarily',()=>{
 assert.throws(()=>need().parsePixVerseLoginTask([...tasks(),...tasks(3)]),e=>e.code==='video_daily_task_ambiguous');
});
test('fixed official endpoint allowlist rejects unknown kinds/paths before fetch',async()=>{
 const {videoDailyJson}=need();let calls=0;for(const [kind,path]of [['doubao','/x'],['vidu','https://HOST/steal'],['pixverse','/creative_platform/generate']])await assert.rejects(()=>videoDailyJson(kind,path,c,{fetchImpl:async()=>{calls++;}}),e=>e.code==='video_daily_endpoint_invalid'&&e.beforeSubmission===true);assert.equal(calls,0);
});
test('HTTP auth failure is typed login-required without copying raw response',async()=>{
 const {createVideoDailyProvider}=need();const p=createVideoDailyProvider('vidu',{fetchImpl:async()=>new Response('SAMPLE-SECRET',{status:401})});await assert.rejects(()=>p.status(c),e=>e.code==='video_daily_login_required'&&e.loginRequired===true&&!e.message.includes('SAMPLE-SECRET'));
});
test('oversize and non-JSON replies never become daily receipts',async()=>{
 const {createVideoDailyProvider}=need();for(const response of [new Response('<html>SAMPLE</html>'),new Response('x'.repeat(1048577))])await assert.rejects(()=>createVideoDailyProvider('vidu',{fetchImpl:async()=>response}).claim(c));
});
test('file credentials keep secrets local, preserve zero expiry distinction and missing-login state',async()=>{
 const {resolveVideoDailyCredential}=need();const dir=await mkdtemp(join(tmpdir(),'video-daily-'));try{
  const file=join(dir,'session.json'),a={platform:'vidu',credentials:{kind:'file',file}},config={path:x=>x};await assert.rejects(()=>resolveVideoDailyCredential('vidu',a,config),e=>e.code==='video_daily_login_required');
  await writeFile(file,JSON.stringify({principal:'SAMPLE-user',cookie:'sessionid=SAMPLE'}));const v=await resolveVideoDailyCredential('vidu',a,config);assert.equal(v.principal,'SAMPLE-user');assert.equal(v.cookie,'sessionid=SAMPLE');
  await writeFile(file,JSON.stringify({principal:'SAMPLE-user',cookie:'a\r\nX-Secret:SAMPLE'}));await assert.rejects(()=>resolveVideoDailyCredential('vidu',a,config),e=>e.code==='video_daily_login_required');
  await writeFile(file,JSON.stringify({principal:'SAMPLE-user',accessToken:'SAMPLE',expiresAtMs:0}));await assert.rejects(()=>resolveVideoDailyCredential('vidu',a,config),e=>e.code==='video_daily_credential_invalid');
 }finally{await rm(dir,{recursive:true,force:true});}
});

function fixture(kind,provider,{uncertain=false}={}){
 const recorded=[],state={submitted:0,finishes:[]};
 const config={value:{scheduler:{timezone:'Asia/Shanghai'},accounts:[{id:'video',platform:kind,enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}]}};
 const credentials={resolve:async()=>c};
 const ledger={claimKey:()=> 'SAMPLE-key',reserve:()=>({acquired:true,reservationId:'SAMPLE',uncertain}),markSubmitted:()=>{state.submitted++;return true;},finish:(_k,s,r)=>{state.finishes.push([s,r]);return true;},record:r=>recorded.push(r)};
 return {config,credentials,platforms:{status:(_id,t)=>provider.status(c,t),claim:(_id,t)=>provider.claim(c,t)},ledger,recorded,state};
}
for(const amount of [0,9])test(`ClaimService Vidu receipt integrates amount ${amount} without fabricating fresh awards`,async()=>{
 const {createVideoDailyProvider}=need();const {ClaimService}=await load('claims.mjs');const seen=[];const provider=createVideoDailyProvider('vidu',{fetchImpl:async(url)=>{seen.push(url);return json(url.endsWith('every-day-credit')?{credit:amount}:{credits:0});}}),f=fixture('vidu',provider);
 const result=await new ClaimService(f.config,f.credentials,f.platforms,f.ledger).run('video','daily-checkin',{trigger:'automatic',source:'test'});assert.equal(result.status,amount>0?'success':'observed');assert.equal(result.automaticRewardConfirmed,amount>0);assert.equal(result.automaticOperationConfirmed,true);assert.equal(result.credits,amount);assert.equal(seen.filter(u=>u.endsWith('every-day-credit')).length,1);assert.equal(f.recorded.length,1);
});
test('ClaimService PixVerse acknowledgement requires official re-read progress CLAIMED',async()=>{
 const {createVideoDailyProvider}=need();const {ClaimService}=await load('claims.mjs');let submitted=false,posts=0;
 const provider=createVideoDailyProvider('pixverse',{fetchImpl:async(url)=>{if(url.endsWith('/reward/claim')){posts++;submitted=true;return json({ErrCode:0,Resp:{}});}return json({ErrCode:0,Resp:tasks(submitted?3:2)});}}),f=fixture('pixverse',provider);
 const r=await new ClaimService(f.config,f.credentials,f.platforms,f.ledger).run('video','daily-checkin',{trigger:'automatic'});assert.equal(r.status,'success');assert.equal(r.serverConfirmed,true);assert.equal(posts,1);assert.equal(r.automaticRewardConfirmed,true);
});
test('previous uncertain video submissions only read and never replay the claim',async()=>{
 const {createVideoDailyProvider}=need();const {ClaimService}=await load('claims.mjs');const calls=[];const p=createVideoDailyProvider('vidu',{fetchImpl:async(url)=>{calls.push(url);return json({credits:0});}}),f=fixture('vidu',p,{uncertain:true});const r=await new ClaimService(f.config,f.credentials,f.platforms,f.ledger).run('video');assert.equal(r.status,'uncertain');assert.equal(f.state.submitted,0);assert.ok(calls.every(u=>u.endsWith('/credits/me')));
});
test('PixVerse uses UTC entitlement day and exposes the next UTC-midnight provider window',async()=>{
 const {videoDailyClaimDay,createVideoDailyProvider}=need();
 assert.equal(videoDailyClaimDay('pixverse',new Date('2026-10-27T16:30:00Z'),'Asia/Shanghai'),'2026-10-27');
 assert.equal(videoDailyClaimDay('vidu',new Date('2026-10-27T16:30:00Z'),'Asia/Shanghai'),'2026-10-28');
 const p=createVideoDailyProvider('pixverse',{now:()=>new Date('2026-10-27T16:30:00Z'),fetchImpl:async()=>json({ErrCode:0,Resp:tasks(3)})});
 assert.equal((await p.status(c)).nextClaimAt,'2026-10-28T00:00:00.000Z');
});
test('HTTP 502 after Vidu action stays uncertain and does not become a retryable pre-submission failure',async()=>{
 const {createVideoDailyProvider}=need();const {ClaimService}=await load('claims.mjs');let actionCalls=0;
 const p=createVideoDailyProvider('vidu',{fetchImpl:async(url)=>{if(url.endsWith('every-day-credit')){actionCalls++;return new Response('bad gateway',{status:502});}return json({credits:0});}}),f=fixture('vidu',p);
 const r=await new ClaimService(f.config,f.credentials,f.platforms,f.ledger).run('video');assert.equal(r.status,'uncertain');assert.equal(r.automaticRewardConfirmed,false);assert.equal(actionCalls,1);assert.equal(f.state.submitted,1);
});
test('HTTP 502 after PixVerse claim stays uncertain without a second reward POST',async()=>{
 const {createVideoDailyProvider}=need();const {ClaimService}=await load('claims.mjs');let posts=0;
 const p=createVideoDailyProvider('pixverse',{fetchImpl:async(url)=>{if(url.endsWith('/reward/claim')){posts++;return new Response('bad gateway',{status:502});}return json({ErrCode:0,Resp:tasks(2)});}}),f=fixture('pixverse',p);
 const r=await new ClaimService(f.config,f.credentials,f.platforms,f.ledger).run('video');assert.equal(r.status,'uncertain');assert.equal(posts,1);assert.equal(r.automaticRewardConfirmed,false);
});
test('Vidu settlement honors the caller ledger timezone rather than a hardcoded receipt date',async()=>{
 const {createVideoDailyProvider,officialVideoDailySettlement}=need();const p=createVideoDailyProvider('vidu',{now:()=>new Date('2026-10-27T20:00:00Z'),fetchImpl:async()=>json({credit:7})}),result=await p.claim(c);
 assert.equal(officialVideoDailySettlement('vidu',c.principalHash,result,'2026-10-27','UTC').status,'success');
 assert.equal(officialVideoDailySettlement('vidu',c.principalHash,result,'2026-10-28','Asia/Shanghai').status,'success');
 assert.equal(officialVideoDailySettlement('vidu',c.principalHash,result,'2026-10-26','UTC'),null);
});
test('account enrollment is preview-first, idempotent, and never adds upstreams/routes or credentials',async()=>{
 need();const {setupVideoDaily}=await import(pathToFileURL(join(root,'scripts/setup-video-daily.mjs')).href);const dir=await mkdtemp(join(tmpdir(),'video-enroll-'));
 try{const file=join(dir,'config.json'),original=JSON.parse(await readFile(join(root,'config.example.json'),'utf8'));await writeFile(file,JSON.stringify(original));const before=await readFile(file,'utf8');
  const preview=await setupVideoDaily(file);assert.equal(preview.mode,'preview');assert.equal(await readFile(file,'utf8'),before);
  const result=await setupVideoDaily(file,{apply:true});assert.equal(result.added.length,7);const after=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(after.upstreams,original.upstreams);assert.deepEqual(after.routes,original.routes);assert.deepEqual(after.scheduler,original.scheduler);assert.deepEqual(after.accounts.slice(0,original.accounts.length),original.accounts);assert.equal(result.credentialsWritten,false);
  const once=await readFile(file,'utf8');assert.equal((await setupVideoDaily(file,{apply:true})).added.length,0);assert.equal(await readFile(file,'utf8'),once);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('PixVerse malformed or unknown business acknowledgement remains uncertain, never retryable error',async()=>{
 const {createVideoDailyProvider}=need();const {ClaimService}=await load('claims.mjs');for(const response of [{},{ErrCode:12345,Resp:{}}]){let posts=0;const p=createVideoDailyProvider('pixverse',{fetchImpl:async(url)=>{if(url.endsWith('/reward/claim')){posts++;return json(response);}return json({ErrCode:0,Resp:tasks(2)});}}),f=fixture('pixverse',p);const result=await new ClaimService(f.config,f.credentials,f.platforms,f.ledger).run('video');assert.equal(result.status,'uncertain');assert.equal(posts,1);}
});
