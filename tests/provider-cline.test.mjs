import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CLINE_API_ORIGIN,CLINE_CHAT_PATH,clineDescriptor,clineBalance,clineCheckin,clineCredentialView,clineFetch,clineHealth,clineModels,clineChat,clineStatus,clineClaim,clineProvider,resolveClineCredential,readClineLocalCredential,defaultClineCredentialFile} from '../src/provider-cline.mjs';

// Synthetic fixture only: three base64url-shaped segments, no real issuer or signature.
const TOKEN=['SAFE','FIXTURE','TOKEN'].map(s=>Buffer.from(s).toString('base64url')).join('.');

test('Cline official refresh is fixed-origin, preserves WorkOS binding and rejects changed identity',async()=>{
 const {refreshClineAuth,CLINE_REFRESH_URL}=await import('../src/provider-cline.mjs');const now=Date.now();
 const jwt=sub=>Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub,exp:Math.floor(now/1000)+3600})).toString('base64url')+'.fixture';
 const auth={accessToken:'workos:'+jwt('same'),refreshToken:'refresh-fixture'};let calls=0;
 const renewed=await refreshClineAuth(auth,{now,fetchImpl:async(url,o)=>{
  calls++;assert.equal(url,CLINE_REFRESH_URL);assert.equal(url,'https://api.cline.bot/api/v1/auth/refresh');assert.equal(o.redirect,'error');
  assert.deepEqual(JSON.parse(o.body),{refreshToken:'refresh-fixture',grantType:'refresh_token'});
  return Response.json({success:true,data:{accessToken:jwt('same'),refreshToken:'refresh-next',expiresAt:new Date(now+3600000).toISOString()}});
 }});
 assert.equal(calls,1);assert.equal(renewed.accessToken.startsWith('workos:'),true);assert.equal(renewed.refreshToken,'refresh-next');assert.equal(auth.refreshToken,'refresh-fixture');
 await assert.rejects(refreshClineAuth(auth,{fetchImpl:async()=>Response.json({success:true,data:{accessToken:jwt('other'),expiresAt:now+3600000}})}),{code:'cline_refresh_identity_mismatch'});
 calls=0;const failure=await refreshClineAuth(auth,{fetchImpl:async()=>{calls++;return Response.json({error:'refresh-fixture'},{status:401})}}).catch(e=>e);
 assert.equal(calls,1);assert.equal(failure.code,'cline_refresh_failed');assert.equal(failure.message.includes('refresh-fixture'),false);
});

test('Cline renewal cache is source-bound, single-flight, preserves original file and never replays a failed rotation',async()=>{
 const f=await fixture();const now=Date.now(),account={credentials:{file:f.file}},cacheFile=f.file+'.cache';
 const old={accessToken:TOKEN,refreshToken:'refresh-original',expiresAt:now-1000};
 try{
  await writeFile(f.file,JSON.stringify(old));const original=await readFile(f.file,'utf8');let calls=0;
  const options={now,cacheFile,fetchImpl:async()=>{calls++;return Response.json({success:true,data:{accessToken:TOKEN,refreshToken:'refresh-rotated',expiresAt:now+120000}})}};
  const [a,b]=await Promise.all([resolveClineCredential(account,{},options),resolveClineCredential(account,{},options)]);
  assert.equal(calls,1);assert.equal(a.token,b.token);assert.equal(await readFile(f.file,'utf8'),original);
  const cache=JSON.parse(await readFile(cacheFile,'utf8'));assert.equal(cache.refreshToken,'refresh-rotated');assert.equal(typeof cache.sourceHash,'string');
  await resolveClineCredential(account,{},options);assert.equal(calls,1);
  const failed={...options,now:now+180000,fetchImpl:async(url,o)=>{calls++;assert.equal(JSON.parse(o.body).refreshToken,'refresh-rotated');return Response.json({error:'invalid_grant'},{status:400})}};
  await assert.rejects(resolveClineCredential(account,{},failed),{code:'cline_refresh_failed'});
  await assert.rejects(resolveClineCredential(account,{},failed),{code:'cline_refresh_needs_login'});assert.equal(calls,2);
  await writeFile(f.file,JSON.stringify({...old,accessToken:'new-source-token',expiresAt:now+3600000}));
  const changed=await resolveClineCredential(account,{},options);assert.equal(changed.token,'new-source-token');assert.equal(calls,2);
 }finally{await f.cleanup();}
});

// 2026-10-31 回归：一次网络抖动曾把 cline-oauth.json 写成永久失败，账号在 UI 上永久"待检查/待获取",
// 而 refreshToken 完全是好的。瞬时失败只许记一段冷却，冷却过后必须自动续期成功。
test('Cline transient renewal failure cools down instead of blocking the account forever',async()=>{
 const f=await fixture();const now=Date.now(),account={credentials:{file:f.file}},cacheFile=f.file+'.cool-cache';
 try{
  await writeFile(f.file,JSON.stringify({accessToken:TOKEN,refreshToken:'refresh-live',expiresAt:now-1000}));
  const offline={now,cacheFile,fetchImpl:async()=>{throw Object.assign(new Error('socket hang up'),{code:'ECONNRESET'});}};
  const first=await resolveClineCredential(account,{},offline).catch(e=>e);
  assert.equal(first.code,'cline_refresh_unconfirmed');
  const poisoned=JSON.parse(await readFile(cacheFile,'utf8'));
  assert.equal(poisoned.refreshFailure,'cline_refresh_unconfirmed');
  assert.equal(poisoned.failedAt,now);assert.ok(poisoned.retryAt>now);
  let calls=0;
  const cooling=await resolveClineCredential(account,{},{...offline,now:now+1000,fetchImpl:async()=>{calls++;return Response.json({});}}).catch(e=>e);
  assert.equal(cooling.code,'cline_refresh_needs_login');assert.equal(cooling.status,503);
  assert.equal(cooling.message.includes('临时故障'),true);assert.equal(calls,0);
  const recovered=await resolveClineCredential(account,{},{now:now+120000,cacheFile,fetchImpl:async()=>{calls++;return Response.json({success:true,data:{accessToken:TOKEN,refreshToken:'refresh-live',expiresAt:now+3600000}})}});
  assert.equal(recovered.token,TOKEN);assert.equal(calls,1);
  const healed=JSON.parse(await readFile(cacheFile,'utf8'));
  assert.equal(healed.refreshFailure,undefined);assert.equal(healed.retryAt,undefined);assert.equal(healed.failedAt,undefined);
 }finally{await f.cleanup();}
});

test('Cline account balance follows the full official display scale and preserves true zero',()=>{
  assert.equal(clineBalance({success:true,data:{userId:'usr',balance:500000}},'usr').value,0.5);
  const zero=clineBalance({success:true,data:{userId:'usr',balance:0}},'usr');
  assert.equal(zero.value,0);assert.equal(zero.status,'known');assert.equal(zero.unit,'credits');
  for(const balance of [null,'500000',NaN,Infinity,undefined])
    assert.throws(()=>clineBalance({success:true,data:{userId:'usr',balance}},'usr'),{code:'cline_balance_schema'});
  assert.throws(()=>clineBalance({success:true,data:{userId:'other',balance:1}},'usr'),{code:'cline_balance_schema'});
  assert.throws(()=>clineBalance({success:false,data:{userId:'usr',balance:1}},'usr'),{code:'cline_balance_schema'});
});

test('Cline health derives balance identity from authenticated me and separates partial balance failure',async()=>{
  const credential={token:TOKEN,principal:'fixture',expiresAt:null};
  const calls=[];
  const result=await clineHealth(credential,{fetchImpl:async(url)=>{
    calls.push(url);return Response.json(url.endsWith('/me')?{success:true,data:{id:'usr-fixture'}}:{success:true,data:{userId:'usr-fixture',balance:500000}});
  }});
  assert.equal(result.status,'authenticated');assert.equal(result.balance.value,0.5);assert.equal(result.capabilities.balance,true);
  assert.equal(JSON.stringify(result).includes('usr-fixture'),false);
  assert.deepEqual(calls,['https://api.cline.bot/api/v1/users/me','https://api.cline.bot/api/v1/users/usr-fixture/balance']);
  for(const status of [401,403,500]){
    const partial=await clineHealth(credential,{fetchImpl:async(url)=>url.endsWith('/me')?Response.json({success:true,data:{id:'usr'}}):new Response('secret diagnostic',{status})});
    assert.equal(partial.status,'authenticated');assert.equal(partial.balance.value,null);assert.equal(partial.balance.httpStatus,status);
    assert.equal(JSON.stringify(partial).includes('secret diagnostic'),false);
  }
  const invalid=await clineHealth(credential,{fetchImpl:async()=>Response.json({success:true,data:{id:'../other'}})});
  assert.equal(invalid.balance.reason,'cline_balance_schema');assert.equal(invalid.balance.value,null);
});

test('Cline balance endpoint rejects encoded separators and unverified billing paths',async()=>{
  for(const path of ['/api/v1/users/u%2Fv/balance','/api/v1/users/u/balance/extra','/api/v1/users/u/billing','/api/v1/users/u/balance?token=x']){
    await assert.rejects(clineFetch(CLINE_API_ORIGIN+path,{token:TOKEN,fetchImpl:async()=>{throw new Error('must not fetch')}}),{code:'cline_endpoint_invalid'});
  }
});

async function fixture(auth={}) {
  const dir=await mkdtemp(join(tmpdir(),'dsh-cline-'));
  const file=join(dir,'sub','providers.json');
  await mkdir(join(dir,'sub'));
  await writeFile(file,JSON.stringify({version:1,lastUsedProvider:'cline',providers:{cline:{settings:{provider:'cline',auth:{accessToken:TOKEN,refreshToken:'rt-fixture',expiresAt:Date.parse('2026-10-11T05:08:01.000Z'),metadata:{tokenType:'Bearer',...auth}}},tokenSource:'oauth'}}}));
  return {file,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

// Shape mirrors the real GET /api/v1/ai/cline/models row (verified live 2026-10-11).
const CATALOG={data:[
  {id:'anthropic/claude-sonnet-4-6',name:'Claude Sonnet 4.6',context_length:200000,top_provider:{max_completion_tokens:64000},architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools','temperature']},
  {id:'liquid/lfm-2.5-2.6b:free',name:'LiquidAI: LFM2.5-2.6B (free)',context_length:65536,top_provider:{max_completion_tokens:8192},architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['temperature']},
  {id:'openrouter/auto',name:'Auto Router',context_length:null,top_provider:{max_completion_tokens:null},architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools']},
  {name:'no-id'},
]};

test('Cline descriptor is a chat-capable hosted-billing adapter with no checkin',()=>{
  assert.equal(clineDescriptor.id,'cline');assert.equal(clineDescriptor.name,'Cline');
  assert.equal(clineDescriptor.authKind,'oauth_bearer');assert.equal(clineDescriptor.checkinSupported,false);
  assert.equal(clineDescriptor.underlyingProvider,'cline-api');assert.equal(clineDescriptor.billing,'official_hosted_credits');
  assert.equal(clineDescriptor.byok,true);assert.equal(clineDescriptor.origin,CLINE_API_ORIGIN);
  assert.equal(clineDescriptor.chatSupported,true);assert.equal(clineDescriptor.chatPath,CLINE_CHAT_PATH);
  assert.equal(clineCheckin().status,'unsupported');assert.equal(clineCheckin().reason,'no_checkin_concept');
  assert.equal(clineBalance().status,'unknown');assert.equal(clineBalance().reason,'balance_not_fetched');
});

test('Cline credential view exposes presence, expiry and issuer but never the token',async()=>{
  const f=await fixture();
  try{
    const view=await readClineLocalCredential({file:f.file,now:Date.parse('2026-10-11T04:57:37.000Z')});
    assert.equal(view.present,true);assert.equal(view.expired,false);assert.equal(view.tokenType,'Bearer');
    assert.equal(view.tokenSegments,3);assert.equal(view.refreshTokenPresent,true);
    assert.equal(view.provider,'cline');assert.equal(view.tokenSource,'oauth');
    assert.equal(view.issuer,null);
    assert.equal(JSON.stringify(view).includes(TOKEN),false);assert.equal(Object.keys(view).includes('token'),false);
    assert.equal(clineCredentialView({token:TOKEN,segmentCount:3,issuer:null,tokenType:'Bearer',expiresAt:'2026-01-01T00:00:00.000Z',refreshTokenPresent:false,provider:'cline',tokenSource:'oauth'},Date.parse('2026-10-11T00:00:00Z')).expired,true);
  }finally{await f.cleanup();}
});

test('Cline fetch pins the official origin and refuses any unconfirmed path',async()=>{
  for(const url of ['https://evil.invalid/api/v1/users/me','https://api.cline.bot/api/v1/chat','https://api.cline.bot/api/v1/users/me?x=1','https://api.cline.bot/api/v1/users/me#f','https://user:pass@api.cline.bot/api/v1/users/me']){
    let calls=0;
    await assert.rejects(clineFetch(url,{token:TOKEN,fetchImpl:async()=>{calls++;return Response.json({})}}),{code:'cline_endpoint_invalid'});
    assert.equal(calls,0);
  }
  let seen;
  await clineFetch(`${CLINE_API_ORIGIN}/api/v1/users/me`,{token:TOKEN,fetchImpl:async(url,o)=>{seen=[url,o];return Response.json({success:true})}});
  assert.equal(seen[0],'https://api.cline.bot/api/v1/users/me');assert.equal(seen[1].redirect,'error');
  assert.equal(seen[1].headers.Authorization,'Bearer '+TOKEN);assert.equal(seen[1].headers.Accept,'application/json');
});

test('Cline health reports authentication from /users/me without leaking credentials',async()=>{
  const f=await fixture();
  try{
    const calls=[];
    const health=await clineHealth({credentialFile:f.file,now:Date.parse('2026-10-11T04:57:37.000Z'),fetchImpl:async(url)=>{calls.push(url);return Response.json({data:{id:'usr-fixture',email:'fixture-placeholder-not-an-address'},success:true})}});
    assert.deepEqual(calls,['https://api.cline.bot/api/v1/users/me','https://api.cline.bot/api/v1/users/usr-fixture/balance']);
    assert.equal(health.status,'authenticated');assert.equal(health.accountPresent,true);assert.equal(health.checkinSupported,false);
    assert.equal(health.balance.status,'unknown');assert.equal(health.credential.present,true);
    assert.equal(JSON.stringify(health).includes(TOKEN),false);
    // Same fixture on the real clock: the token expired at 05:08:01Z, so health says so instead of 'authenticated'
    // and spends no doomed round trip (live behaviour of this account, see docs/provider-cline.md).
    const expiredCalls=[];
    const expired=await clineHealth({credentialFile:f.file,fetchImpl:async()=>{expiredCalls.push(1);return Response.json({data:{id:'x'},success:true})}});
    assert.equal(expired.status,'credential_expired');assert.equal(expired.reason,'credential_expired');
    assert.equal(expired.credential.expired,true);assert.equal(expired.capabilities.inference,true);
    assert.equal(JSON.stringify(expired).includes(TOKEN),false);
    assert.deepEqual(expiredCalls,[]);
    const direct=await clineHealth(await resolveClineCredential({credentials:{file:f.file}},{path:p=>p},{refresh:false}),{now:Date.parse('2026-10-11T04:57:37.000Z'),fetchImpl:async()=>Response.json({data:{id:'x'},success:true})});
    assert.equal(direct.status,'authenticated');assert.equal(JSON.stringify(direct).includes(TOKEN),false);
    await assert.rejects(clineHealth({credentialFile:f.file,now:Date.parse('2026-10-11T04:57:37.000Z'),fetchImpl:async()=>Response.json({error:'unauthorized'},{status:401})}),{code:'cline_auth_failed'});
  }finally{await f.cleanup();}
});

test('Cline models map the official catalog and reject malformed payloads',async()=>{
  const f=await fixture();
  try{
    const rows=await clineModels({credentialFile:f.file,fetchImpl:async(url)=>{assert.equal(url,'https://api.cline.bot/api/v1/ai/cline/models');return Response.json(CATALOG)}});
    assert.deepEqual(rows.map(r=>r.id),['anthropic/claude-sonnet-4-6','liquid/lfm-2.5-2.6b:free','openrouter/auto']);
    assert.equal(rows[0].maxTokens,64000);assert.equal(rows[0].contextWindow,200000);assert.deepEqual(rows[0].inputModalities,['text','image']);
    assert.ok(rows.every(r=>r.verification==='official_catalog'));
    await assert.rejects(clineModels({credentialFile:f.file,fetchImpl:async()=>Response.json({data:{}})}),{code:'cline_catalog_schema'});
    await assert.rejects(clineModels({credentialFile:f.file,limit:1,fetchImpl:async()=>Response.json({data:[{id:'a'},{id:'b'}]})}),{code:'cline_catalog_too_large'});
  }finally{await f.cleanup();}
});

test('Cline models metadata exposes tools/multimodal and never publishes unknown capacity',async()=>{
  const rows=await clineModels({credential:{token:TOKEN},fetchImpl:async()=>Response.json(CATALOG)});
  const [sonnet,free,auto]=rows;
  assert.equal(sonnet.tools,true);assert.equal(sonnet.multimodal,true);assert.equal(sonnet.callable,true);
  assert.equal(free.tools,false);assert.equal(free.multimodal,false);assert.equal(free.callable,true);
  // Unknown capacity stays null and is not published as callable.
  assert.equal(auto.contextWindow,null);assert.equal(auto.maxTokens,null);assert.equal(auto.callable,false);
  assert.equal(auto.tools,true);
});

test('Cline provider object satisfies the integration contract',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(Object.keys(clineProvider).sort(),['chat','claim','descriptor','health','models','resolve','status','supportsCheckin']);
    const credential=await clineProvider.resolve({credentials:{file:f.file}},{},{refresh:false}); // account/config shape
    assert.equal(typeof credential.token,'string');assert.equal(credential.token,TOKEN);
    assert.equal(credential.accessToken,TOKEN);assert.equal(typeof credential.principal,'string');
    assert.equal(credential.principal.includes(TOKEN),false);
    const viaConfig=await clineProvider.resolve({credentials:{file:'nested/providers.json'}},{path:p=>{assert.equal(p,'nested/providers.json');return f.file;}},{refresh:false});
    assert.equal(viaConfig.token,TOKEN); // config.path() resolves explicit credential paths
    // resolve() must return the private credential that health/models/chat actually use.
    const health=await clineProvider.health(credential,{now:Date.parse('2026-10-11T04:57:37.000Z'),fetchImpl:async()=>Response.json({data:{id:'usr'},success:true})});
    assert.equal(health.status,'authenticated');assert.equal(health.capabilities.inference,true);
    // The same credential is refused by the expiry check, not by a fabricated success.
    const expired=await clineProvider.health(credential,{fetchImpl:async()=>{throw new Error('must not be called')}});
    assert.equal(expired.status,'credential_expired');assert.equal(expired.credential.expired,true);
    const models=await clineProvider.models(credential,{fetchImpl:async()=>Response.json(CATALOG)});
    assert.deepEqual(models.map(m=>m.id),['anthropic/claude-sonnet-4-6','liquid/lfm-2.5-2.6b:free','openrouter/auto']);
    // A public summary may leave the process; the credential itself must not be the summary.
    const publicView=clineCredentialView(credential);
    assert.equal(JSON.stringify(publicView).includes(TOKEN),false);assert.equal(publicView.present,true);
  }finally{await f.cleanup();}
});

test('Cline chat posts the documented OpenAI body to the documented endpoint and returns the upstream Response verbatim',async()=>{
  const credential={token:TOKEN,principal:'cline:fixture'};
  const upstream=Response.json({data:CATALOG.data});
  const seen=[];
  const rawStream=new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
  const result=await clineChat(upstream,credential,{model:'liquid/lfm-2.5-2.6b:free',messages:[{role:'user',content:'ping'}],max_tokens:16,stream:true,unsupported_field:'drop me',authorization:'Bearer attacker'},undefined,{fetchImpl:async(url,o)=>{seen.push([url,o]);return rawStream}});
  assert.equal(seen[0][0],'https://api.cline.bot/api/v1/chat/completions');
  assert.equal(seen[0][1].method,'POST');assert.equal(seen[0][1].redirect,'error');
  assert.equal(seen[0][1].headers.Authorization,'Bearer '+TOKEN);
  assert.equal(seen[0][1].headers['Content-Type'],'application/json');
  // Documented default is SSE, so Accept must not promise JSON while asking for a stream.
  assert.equal(seen[0][1].headers.Accept,'text/event-stream');
  assert.equal(JSON.parse(seen[0][1].body).model,'liquid/lfm-2.5-2.6b:free');
  assert.equal(JSON.parse(seen[0][1].body).max_tokens,16);assert.equal(JSON.parse(seen[0][1].body).stream,true);
  assert.equal('unsupported_field' in JSON.parse(seen[0][1].body),false);
  assert.equal('authorization' in JSON.parse(seen[0][1].body),false);
  // Verbatim upstream Response: same object, readable SSE stream, unmodified bytes.
  assert.equal(result.response instanceof Response,true);
  assert.equal(await result.response.text(),'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  assert.match(result.response.headers.get('content-type'),/text\/event-stream/);
  // Non-stream relays JSON unchanged too, and the Accept header follows the requested mode.
  const nonStreamSeen=[];
  const json=await clineChat(upstream,credential,{model:'liquid/lfm-2.5-2.6b:free',messages:[{role:'user',content:'ping'}],stream:false},undefined,{fetchImpl:async(url,o)=>{nonStreamSeen.push(o);return Response.json({id:'gen-1',choices:[],usage:{prompt_tokens:2}})}});
  assert.equal(nonStreamSeen[0].headers.Accept,'application/json');
  assert.equal(json.response.status,200);assert.deepEqual(await json.response.json(),{id:'gen-1',choices:[],usage:{prompt_tokens:2}});
  // No stream flag at all = the documented default (SSE).
  const defaultSeen=[];
  await clineChat({model:'m'},credential,{model:'m',messages:[{role:'user',content:'ping'}]},undefined,{fetchImpl:async(url,o)=>{defaultSeen.push(o);return Response.json({choices:[]})}});
  assert.equal(defaultSeen[0].headers.Accept,'text/event-stream');
  // The upstream target model is the fallback when the caller sends none.
  const fallback=await clineChat({model:'anthropic/claude-sonnet-4-6'},credential,{messages:[{role:'user',content:'ping'}]},undefined,{fetchImpl:async()=>Response.json({choices:[]})});
  assert.equal(fallback.response.status,200);
});

test('Cline chat fails closed on bad endpoints, bad requests and rejected auth without leaking the token',async()=>{
  const credential={token:TOKEN,principal:'cline:fixture'};
  let calls=0;
  const spy=async()=>{calls++;return Response.json({})};
  for(const [upstream,input] of [[{model:''},{model:'',messages:[{role:'user',content:'ping'}]}],[{model:'m'},{model:'m',messages:[]}],[{model:'m'},{model:'m'}],[{model:'m'},{model:'m',messages:'not-an-array'}]]){
    await assert.rejects(clineChat(upstream,credential,input,undefined,{fetchImpl:spy}),{code:'cline_chat_request_invalid'});
  }
  assert.equal(calls,0);
  const errors=[];
  for(const status of [401,403,402,500]){
    await clineChat({model:'m'},credential,{model:'m',messages:[{role:'user',content:'ping'}]},undefined,{fetchImpl:async()=>Response.json({error:{message:'upstream says no'}},{status})})
      .catch(e=>errors.push([e.code,e.status,e.message]));
  }
  assert.deepEqual(errors.map(e=>e[0]),['cline_auth_failed','cline_auth_failed','cline_upstream_error','cline_upstream_error']);
  assert.deepEqual(errors.map(e=>e[1]),[401,403,402,500]);
  assert.ok(errors.every(e=>!e[2].includes(TOKEN)&&!/Bearer [A-Za-z0-9._-]+/.test(e[2])));
  await assert.rejects(clineChat({model:'m'},{token:''},{model:'m',messages:[{role:'user',content:'ping'}]}),{code:'cline_credential_missing'});
  await assert.rejects(clineChat({model:'m'},credential,{model:'m',messages:[{role:'user',content:'ping'}]},undefined,{fetchImpl:async()=>{throw new Error('socket hang up')}}),{code:'cline_network_error'});
});

test('Cline status and claim stay honest about having no check-in concept',async()=>{
  const f=await fixture();
  try{
    const credential=await resolveClineCredential({credentials:{file:f.file}},{},{refresh:false});
    const status=clineStatus(credential);
    assert.equal(status.known,true);assert.equal(status.supportsCheckin,false);assert.equal(status.claimable,false);assert.equal(status.claimed,false);
    assert.equal(status.reason,'no_checkin_concept');assert.match(status.day,/^\d{4}-\d{2}-\d{2}$/);
    assert.equal(JSON.stringify(status).includes('credit'),false);
    const claim=clineClaim(credential,'daily-checkin');
    assert.equal(claim.claimed,false);assert.equal(claim.submitted,false);assert.equal(claim.refused,true);assert.equal(claim.reason,'no_checkin_concept');
    assert.equal(clineProvider.supportsCheckin,false);
    assert.equal(clineStatus({principal:'cline:fixture'}).known,true); // works with no argument too
  }finally{await f.cleanup();}
});

test('Cline chat path is whitelisted at exactly one origin, path and query shape',async()=>{
  for(const url of ['https://evil.invalid/api/v1/chat/completions','https://api.cline.bot/api/v1/chat/completion','https://api.cline.bot/v1/chat/completions','https://api.cline.bot/api/v1/chat/completions?stream=true','https://api.cline.bot/api/v1/chat/completions#x','https://user:pass@api.cline.bot/api/v1/chat/completions','http://api.cline.bot/api/v1/chat/completions']){
    let calls=0;
    await assert.rejects(clineFetch(url,{token:TOKEN,fetchImpl:async()=>{calls++;return Response.json({})}}),{code:'cline_endpoint_invalid'});
    assert.equal(calls,0,url);
  }
  let calls=0;
  await clineFetch(`${CLINE_API_ORIGIN}${CLINE_CHAT_PATH}`,{token:TOKEN,method:'POST',fetchImpl:async()=>{calls++;return Response.json({ok:true})}});
  assert.equal(calls,1);
});

test('Cline missing login and oversized or non-JSON responses fail closed with zero generation calls',async()=>{
  assert.equal(defaultClineCredentialFile().endsWith(join('.cline','data','settings','providers.json')),true);
  const empty=await fixture();await empty.cleanup();
  await assert.rejects(readClineLocalCredential({file:join(tmpdir(),'dsh-cline-absent','providers.json')}),{code:'cline_credential_unavailable'});
  const f=await fixture();
  try{
    await assert.rejects(clineFetch(`${CLINE_API_ORIGIN}/api/v1/users/me`,{token:TOKEN,fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))}),{code:'cline_response_too_large'});
    await assert.rejects(clineFetch(`${CLINE_API_ORIGIN}/api/v1/users/me`,{token:TOKEN,fetchImpl:async()=>new Response('<html>')}),{code:'cline_invalid_response'});
    const abort=new AbortController();abort.abort();
    await assert.rejects(clineFetch(`${CLINE_API_ORIGIN}/api/v1/users/me`,{token:TOKEN,signal:abort.signal,fetchImpl:async()=>{throw new Error('unreachable')}}),{code:'request_cancelled'});
  }finally{await f.cleanup();}
});

test('Cline reads no credential text into any error message',async()=>{
  const f=await fixture();
  try{
    let message='';
    await clineModels({credentialFile:f.file,fetchImpl:async()=>{throw new Error('socket hang up')}}).catch(e=>{message=e.message;});
    assert.equal(message.includes(TOKEN),false);assert.equal(message,'Cline 官方接口连接失败');
  }finally{await f.cleanup();}
});

test('Cline rechecks successful, failed and expired newer rotation under the process lock',async()=>{
 const fs=await import('node:fs/promises');const {syncBuiltinESMExports}=await import('node:module');const {hash}=await import('../src/util.mjs');
 for(const mode of ['fresh','failed','expired']){
  const f=await fixture(),now=Date.now(),cacheFile=f.file+'.race-cache';let calls=0,injected=0;
  const auth={accessToken:TOKEN,refreshToken:'old-refresh',expiresAt:now-1000};await writeFile(f.file,JSON.stringify(auth));const original=await readFile(f.file,'utf8');
  const latest={...auth,sourceHash:hash(original),refreshToken:'latest-refresh',expiresAt:mode==='fresh'?now+3600000:now-1,...(mode==='failed'?{refreshFailure:'already-attempted'}:{})};
  const originalOpen=fs.default.open;
  fs.default.open=async(path,...args)=>{const lock=await originalOpen(path,...args);if(path===cacheFile+'.lock'){injected++;await writeFile(cacheFile,JSON.stringify(latest));}return lock;};syncBuiltinESMExports();
  try{
   const request=resolveClineCredential({credentials:{file:f.file}},{},{now,cacheFile,fetchImpl:async(_url,options)=>{calls++;assert.equal(JSON.parse(options.body).refreshToken,'latest-refresh');return Response.json({success:true,data:{accessToken:TOKEN,refreshToken:'next-refresh',expiresAt:now+3600000}})}});
   if(mode==='failed')await assert.rejects(request,{code:'cline_refresh_needs_login'});else assert.equal((await request).token,TOKEN);
   assert.equal(injected,1);assert.equal(calls,mode==='expired'?1:0);assert.equal(await readFile(f.file,'utf8'),original);
  }finally{fs.default.open=originalOpen;syncBuiltinESMExports();await f.cleanup();}
 }
});
