import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  CODEARTS_ORIGIN,CODEARTS_BALANCE_SOURCE,buildCanonicalRequest,canonicalQuery,canonicalUri,codeartsBalance,codeartsCampaigns,
  codeartsCheckin,codeartsClaim,codeartsCredentialView,codeartsCredits,codeartsDescriptor,codeartsHealth,
  codeartsModels,codeartsProvider,codeartsRequest,sdkDate,signCodeArtsRequest,
} from '../src/provider-codearts.mjs';
import {dayIn} from '../src/util.mjs';

const AK='AKIDFIXTURE0000000000';
const SK='SKFIXTURE0000000000000000000000000000000';
const ST='STFIXTURE0000000000000000';
const XSDK='20261011T050723Z';
const CREDENTIAL={accessKey:AK,secretKey:SK,securityToken:ST,expiresAt:'2026-10-12T06:13:28.158Z',loginType:'codearts',
  stationType:'china ',domainId:'domain-fixture',hasStaticAccessToken:false,scopesEmpty:true,source:'ide_state_vscdb'};

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'dsh-codearts-'));
  const file=join(dir,'state.vscdb');
  const db=new DatabaseSync(file);
  db.exec('create table ItemTable (key text primary key, value text)');
  db.prepare('insert into ItemTable values (?,?)').run('huaweicloud.codearts-snap',JSON.stringify({userInfoKey:{loginType:'codearts',originData:{id:'origin-fixture-1',account:{id:'account-fixture',label:'ACCOUNT LABEL MUST NOT LEAK'},domainId:'domain-fixture',accessToken:'',accessKey:AK,secretKey:SK,securityToken:ST,expiresAt:'2026-10-12T06:13:28.158Z',stationType:'china ',scopes:[]}},'' :''}));
  db.close();
  return {file,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

// Golden vectors produced by the MIT reference signer (references/codearts-signer.py, Hongsheng Luo / Robbs,
// see references/codearts-LICENSE) with the same fixture credential and X-Sdk-Date. Byte-for-byte equality
// is the point: any drift in canonical URI/query/header order or payload hash breaks these.
const GOLDEN={
  builtin:{method:'GET',path:'/v1/model/builtin',rawQuery:'',headers:{'Content-Type':'application/json','X-Language':'zh-cn','Agent-Type':'PromptCenter'},
    payload:'',signedHeaders:'agent-type;content-type;x-language;x-sdk-content-sha256;x-sdk-date;x-security-token',
    signature:'f2d2df496120472d0dc8f5b40f955128d700cc448e01c2d25fd968105e0c4032'},
  statistics:{method:'GET',path:'/snap-manager/v1/statistics/plugin',rawQuery:'',headers:{'Content-Type':'application/json','X-Language':'zh-cn'},
    payload:'',signedHeaders:'content-type;x-language;x-sdk-content-sha256;x-sdk-date;x-security-token',
    signature:'6a453e61089e99473949d3d8f8a58ab54b9fcd997a83f3a4348e43f460697e27'},
  delivery:{method:'GET',path:'/v1/ops/delivery',rawQuery:'channel=IDE',headers:{'Content-Type':'application/json','X-Language':'zh-cn','Agent-Type':'PromptCenter'},
    payload:'',signedHeaders:'agent-type;content-type;x-language;x-sdk-content-sha256;x-sdk-date;x-security-token',
    signature:'0a50ab286f7a24b38b1fe8867ca98520f911dd1ecdac7bb3aa25cd30307efb57'},
  claim:{method:'POST',path:'/v1/ops/claim',rawQuery:'',headers:{'Content-Type':'application/json','X-Language':'zh-cn','Agent-Type':'PromptCenter'},
    payload:'{"campaignId":1,"idempotentKey":"claim_1_1791695255229","channel":"IDE"}',
    signedHeaders:'agent-type;content-type;x-language;x-sdk-content-sha256;x-sdk-date;x-security-token',
    signature:'d9c947d652a49c6e9731910eb60ba927b06368ca1b2645dc2101aff0544fab09'},
  chat:{method:'POST',path:'/api/v2/chat/completions',rawQuery:'',
    headers:{'Content-Type':'application/json','Accept':'text/event-stream','X-Language':'zh-cn','x-auth-token':ST,
      'x-snap-traceid':'0123456789abcdef0123456789abcdef','app-id':'CodeAgent3.0','is_confidential':'false'},
    payload:'{"model":"GLM-5.2","stream":true,"messages":[{"role":"user","content":"ping"}],"chat_id":"' + 'f'.repeat(32) + '","prompt_cache_key":"' + 'f'.repeat(32) + '","tool_stream":true}',
    signedHeaders:'accept;app-id;content-type;is_confidential;x-auth-token;x-language;x-sdk-content-sha256;x-sdk-date;x-security-token;x-snap-traceid',
    signature:'468c35682365ba0f9e85ab9cafef03bbf2fe9bd71a1818a45a953ec35d810a5f'},
};
const EMPTY_SHA='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('CodeArts canonical request reproduces the official Huawei worked example step by step',()=>{
  // Official doc published vector (https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html):
  // GET /v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs?limit=2&marker=13551d6b-755d-4757-b956-536f674975c0
  //   CanonicalURI   /v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs/    (note the appended trailing slash)
  //   CanonicalQuery limit=2&marker=13551d6b-755d-4757-b956-536f674975c0
  //   SignedHeaders  content-type;host;x-sdk-date
  //   RequestPayload e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  //   HashedCanonicalRequest b25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a
  // The doc's SK is redacted ("MFyf***VmHc"), so the published Signature cannot be recomputed; the
  // HashedCanonicalRequest is the authoritative public check and it must match byte for byte.
  const built=buildCanonicalRequest({
    method:'GET',path:'/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs',
    rawQuery:'limit=2&marker=13551d6b-755d-4757-b956-536f674975c0',
    headers:{'content-type':'application/json',host:'service.region.example.com'},
    xSdkDate:'20191115T033655Z',
  });
  assert.equal(built.signedHeaders,'content-type;host;x-sdk-date');
  assert.equal(built.payloadHash,EMPTY_SHA);
  assert.equal(built.hashedCanonicalRequest,'b25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a');
  assert.equal(built.canonicalRequest,['GET','/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs/',
    'limit=2&marker=13551d6b-755d-4757-b956-536f674975c0',
    'content-type:application/json\nhost:service.region.example.com\nx-sdk-date:20191115T033655Z\n',
    'content-type;host;x-sdk-date',EMPTY_SHA].join('\n'));
  assert.equal(built.canonicalUri,'/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs/');

  // Our signer additionally writes X-Sdk-Content-Sha256 (the CodeArts engine expects it), so its
  // SignedHeaders is the doc's set plus that header; the hash chain and date are unchanged.
  const signed=signCodeArtsRequest({accessKey:'QTWA***KYUC',secretKey:'MFyf***VmHc'},
    {method:'GET',path:'/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs',
     rawQuery:'limit=2&marker=13551d6b-755d-4757-b956-536f674975c0',
     headers:{'content-type':'application/json',host:'service.region.example.com'},xSdkDate:'20191115T033655Z'});
  assert.equal(signed['X-Sdk-Content-Sha256'],EMPTY_SHA);
  assert.equal(signed.Authorization.includes('SignedHeaders=content-type;host;x-sdk-content-sha256;x-sdk-date'),true);
  assert.match(signed.Authorization,/Signature=[0-9a-f]{64}$/);
});

test('CodeArts descriptor now reports the confirmed IAM signing scheme and credit ledger',()=>{
  assert.equal(codeartsDescriptor.id,'codearts');assert.equal(codeartsDescriptor.authKind,'iam_aksk_hmac');
  assert.equal(codeartsDescriptor.checkinSupported,true);assert.equal(codeartsDescriptor.underlyingProvider,'huaweicloud-snap-access');
  assert.equal(codeartsDescriptor.billing,'official_points');assert.equal(codeartsDescriptor.byok,false);
  assert.equal(codeartsDescriptor.origin,CODEARTS_ORIGIN);
  assert.match(codeartsDescriptor.signingSource,/api-sign-algorithm-002\.html$/);
  assert.equal(CODEARTS_BALANCE_SOURCE.excludes,'opengw-token-pool');
  assert.equal(CODEARTS_BALANCE_SOURCE.unit,'CREDIT');
  assert.equal(codeartsBalance().status,'available');assert.equal(codeartsCheckin().status,'available');
  assert.equal(codeartsCheckin().campaignId,1);
});

test('CodeArts signer reproduces the reference implementation byte for byte',()=>{
  for(const [name,vector] of Object.entries(GOLDEN)){
    const signed=signCodeArtsRequest({accessKey:AK,secretKey:SK,securityToken:ST},{method:vector.method,path:vector.path,rawQuery:vector.rawQuery,
      headers:vector.headers,payload:Buffer.from(vector.payload,'utf8'),xSdkDate:XSDK});
    assert.equal(signed.Authorization,`SDK-HMAC-SHA256 Access=${AK}, SignedHeaders=${vector.signedHeaders}, Signature=${vector.signature}`,name);
    assert.equal(signed['X-Sdk-Date'],XSDK,name);
    assert.equal(signed['X-Security-Token'],ST,name);
  }
  const empty=signCodeArtsRequest({accessKey:AK,secretKey:SK,securityToken:ST},{method:'GET',path:'/v1/model/builtin',headers:{},xSdkDate:XSDK});
  assert.equal(empty['X-Sdk-Content-Sha256'],EMPTY_SHA);
});

test('CodeArts canonical URI appends the trailing slash and canonical query sorts and encodes',()=>{
  assert.equal(canonicalUri('/v1/model/builtin'),'/v1/model/builtin/');
  assert.equal(canonicalUri('/v1/ops/'),'/v1/ops/');
  assert.equal(canonicalUri('/'),'/');
  assert.equal(canonicalUri('/a b/c'),'/a%20b/c/');
  assert.equal(canonicalQuery(''),'');
  assert.equal(canonicalQuery('b=2&a=1&a=0&empty='),'a=0&a=1&b=2&empty=');
  assert.equal(canonicalQuery('q=a b&z=1'),'q=a%20b&z=1');
  assert.equal(sdkDate(Date.parse('2026-10-11T05:07:23.552Z')),'20261011T050723Z');
});

test('CodeArts signer fails closed without AK/SK and never mutates its input headers',()=>{
  assert.throws(()=>signCodeArtsRequest({},{method:'GET',path:'/v1/model/builtin',xSdkDate:XSDK}),{code:'codearts_credential_missing'});
  assert.throws(()=>signCodeArtsRequest({accessKey:AK,secretKey:SK},{method:'GET',path:'/v1/model/builtin'}),{code:'codearts_sign_invalid'});
  const headers={'Content-Type':'application/json'};
  const signed=signCodeArtsRequest({accessKey:AK,secretKey:SK,securityToken:ST},{method:'GET',path:'/v1/model/builtin',headers,xSdkDate:XSDK});
  assert.deepEqual(Object.keys(headers),['Content-Type']);
  assert.equal(signed.Authorization.includes(SK),false);assert.equal(signed.Authorization.includes(ST),false);
  const injected=signCodeArtsRequest({accessKey:AK,secretKey:SK,securityToken:'x\r\nbad'},{method:'GET',path:'/v1/model/builtin',headers:{'X-Test':'a\r\nb'},xSdkDate:XSDK});
  assert.equal(injected.Authorization.includes('\r'),false);assert.equal(injected.Authorization.includes('\n'),false);
});

test('CodeArts credential resolve returns a private in-memory object able to sign, and a secret-free public view',async()=>{
  const f=await fixture();
  try{
    const credential=await codeartsProvider.resolve({file:f.file});
    assert.equal(credential.accessKey,AK);assert.equal(credential.secretKey,SK);assert.equal(credential.securityToken,ST);
    const signed=signCodeArtsRequest(credential,{method:'GET',path:'/v1/model/builtin',headers:{},xSdkDate:XSDK});
    assert.match(signed.Authorization,/^SDK-HMAC-SHA256 Access=AKIDFIXTURE0000000000, /);
    const view=codeartsCredentialView(credential,Date.parse('2026-10-11T05:07:23.000Z'));
    assert.equal(view.present,true);assert.equal(view.expired,false);assert.equal(view.hasAccessKey,true);
    assert.equal(view.hasSecurityToken,true);assert.equal(view.authKind,'iam_aksk_hmac');
    const serialized=JSON.stringify(view);
    for(const secret of [AK,SK,ST,'ACCOUNT LABEL MUST NOT LEAK','account-fixture','domain-fixture'])assert.equal(serialized.includes(secret),false,`leaked ${secret}`);
    assert.equal(Object.keys(view).includes('accessKey'),false);assert.equal(Object.keys(view).includes('securityToken'),false);
  }finally{await f.cleanup();}
});

test('CodeArts missing session store fails closed before any network call',async()=>{
  let calls=0;
  await assert.rejects(codeartsProvider.resolve({file:join(tmpdir(),'dsh-codearts-absent','state.vscdb')}),{code:'codearts_state_unavailable'});
  await assert.rejects(codeartsModels({},{fetchImpl:async()=>{calls++;return Response.json({})}}),{code:'codearts_credential_missing'});
  await assert.rejects(codeartsHealth({},{}),{code:'codearts_credential_missing'});
  assert.equal(calls,0);
});

test('CodeArts request signs the fixed official route table and refuses everything else',async()=>{
  for(const [method,path,rawQuery] of [['GET','/v1/agent-center/agents/useragents',''],['GET','/v1/model/builtin','x=1'],
    ['POST','/v1/model/builtin',''],['POST','/v1/ops/claim','channel=IDE'],['GET','/v1/ops/delivery','channel=OTHER'],['GET','/api/v2/chat/completions','']]){
    let calls=0;
    await assert.rejects(codeartsRequest(CREDENTIAL,{method,path,rawQuery,fetchImpl:async()=>{calls++;return Response.json({})}}),{code:'codearts_endpoint_invalid'});
    assert.equal(calls,0);
  }
  let seen;
  await codeartsRequest(CREDENTIAL,{method:'GET',path:'/v1/model/builtin',now:Date.parse('2026-10-11T05:07:23.552Z'),
    fetchImpl:async(url,o)=>{seen=[url,o];return Response.json({builtinModels:[]})}});
  assert.equal(seen[0],'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin');
  assert.equal(seen[1].redirect,'error');assert.equal(seen[1].headers['X-Sdk-Date'],XSDK);
  assert.equal(seen[1].headers['Agent-Type'],'PromptCenter');assert.equal(seen[1].headers['X-Security-Token'],ST);
  assert.match(seen[1].headers.Authorization,/^SDK-HMAC-SHA256 Access=/);
  assert.equal(seen[1].headers['x-auth-token'],undefined);
  assert.equal(seen[1].body,undefined);
});

test('CodeArts models expose the official catalog with honest capacity and callable flags',async()=>{
  const rows=await codeartsModels(CREDENTIAL,{fetchImpl:async(url,o)=>{
    assert.equal(url,'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin');
    assert.equal(o.headers['Agent-Type'],'PromptCenter');
    return Response.json({count:3,builtinModels:[
      {model_id:'GLM-5.2',model_name:'GLM-5.2',enable:true,display_enabled:true,model_category:'文本生成',supports_images:false,credit:[{ratio_display:'0.7x'}]},
      {model_id:'Qwen3-VL-235B',model_name:'Qwen3-VL-235B',enable:true,supports_images:true,credit:[]},
      {model_id:'glm-5.2-sft-harmony',enable:false,supports_images:false},
      {model_name:'no-id'},
    ]});
  }});
  assert.deepEqual(rows.map(r=>r.id),['GLM-5.2','Qwen3-VL-235B','glm-5.2-sft-harmony']);
  assert.equal(rows[0].toolRoundtripVerified,true);assert.ok(rows.slice(1).every(r=>r.toolRoundtripVerified===false));
  const glm=rows[0];
  assert.equal(glm.contextWindow,16384);assert.equal(glm.maxTokens,2048);assert.equal(glm.tools,true);assert.deepEqual(glm.toolChoiceModes,["auto","none"]);assert.equal(glm.auditToolChoice,"auto");
  assert.equal(glm.callable,true);assert.equal(glm.callableReason,null);
  assert.equal(glm.enabled,true);assert.equal(glm.verification,'official_catalog');assert.equal(glm.creditRate,0.7);
  assert.equal(rows[1].multimodal,true);assert.equal(rows[1].creditRate,null);assert.equal(rows[2].enabled,false);
  assert.ok(rows.slice(1).every(r=>r.callable===false),'unknown capacity must never be published as callable');
  await assert.rejects(codeartsModels(CREDENTIAL,{fetchImpl:async()=>Response.json({builtinModels:{}})}),{code:'codearts_catalog_schema'});
  await assert.rejects(codeartsModels(CREDENTIAL,{limit:1,fetchImpl:async()=>Response.json({builtinModels:[{model_id:'a'},{model_id:'b'}]})}),{code:'codearts_catalog_too_large'});
});

test('CodeArts credits read the snap business ledger only, never the excluded opengw token pool',async()=>{
  const calls=[];
  const credits=await codeartsCredits(CREDENTIAL,{fetchImpl:async(url)=>{calls.push(url);return Response.json({
    start_date:'2026-10-01',end_date:'2026-10-31',package:{spec_code:'codearts.agent.individual.trial',package_name_cn:'体验版',status:'normal',is_credit_package:true},
    metrics:[{name:'usageTotalPackageCredit',package_credit_amount:5500,package_credit_used:0,package_credit_remain:5500,package_credit_expiring_amount:0},
      {name:'usageBasicPackageCredit',package_credit_remain:500},{name:'usageBonusPackageCredit',package_credit_remain:5000},
      {name:'usageOnDemandPackageCredit',package_credit_remain:0},{name:'usageTokenChatMessages',package_token_amount:1}],
  })}});
  assert.deepEqual(calls,['https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin']);
  assert.equal(credits.status,'available');assert.equal(credits.remaining,5500);assert.equal(credits.totalGranted,5500);
  assert.equal(credits.unit,'CREDIT');assert.equal(credits.ledger,'snap-business-credits');
  assert.deepEqual(credits.components,{basic:500,bonus:5000,onDemand:0,tokenPackRemaining:1});
  assert.equal(credits.package.name,'体验版');
  await assert.rejects(codeartsCredits(CREDENTIAL,{fetchImpl:async()=>Response.json({metrics:{}})}),{code:'codearts_balance_schema'});
});

test('CodeArts daily check-in state comes from the real campaign and never from HTTP 200 alone',async()=>{
  const delivery=status=>Response.json({code:0,message:'ok',data:{channel:'IDE',serverTime:1791695255229,items:[
    {campaignId:3,title:'推荐码上有礼',claimable:false,status:null,benefitAmount:1000},
    {campaignId:4,title:'新用户注册送 4000 积分',claimable:false,status:'CLAIMED',benefitAmount:4000},
    {campaignId:2,title:'学生认证领4000积分',claimable:false,status:null,benefitAmount:4000},
    {campaignId:1,title:'每日签到领1000积分',claimable:status==='ELIGIBLE',status,benefitUnit:'CREDIT',benefitAmount:1000,extra:{endTime:'2026-12-30T16:00:00Z'}},
  ]}});
  const done=await codeartsProvider.status(CREDENTIAL,'daily-checkin',{fetchImpl:async()=>delivery('CONFIRMED')});
  assert.equal(done.known,true);assert.equal(done.claimed,true);assert.equal(done.claimable,false);assert.equal(done.campaignId,1);
  assert.equal(done.credit,1000);assert.equal(done.unit,'CREDIT');assert.equal(done.day,dayIn(new Date()));
  assert.equal(done.endsAt,'2026-12-30T16:00:00Z');assert.equal(done.source,'/v1/ops/delivery?channel=IDE');
  const open=await codeartsProvider.status(CREDENTIAL,'daily-checkin',{fetchImpl:async()=>delivery('ELIGIBLE')});
  assert.equal(open.claimable,true);assert.equal(open.claimed,false);
  const claimedNotConfirmed=await codeartsProvider.status(CREDENTIAL,'daily-checkin',{fetchImpl:async()=>delivery('CLAIMED')});
  assert.equal(claimedNotConfirmed.claimed,false);assert.equal(claimedNotConfirmed.pendingConfirmation,true);assert.equal(claimedNotConfirmed.claimable,false);
  const absent=await codeartsProvider.status(CREDENTIAL,'daily-checkin',{fetchImpl:async()=>Response.json({code:0,message:'ok',data:{items:[]}})});
  assert.equal(absent.known,false);
  await assert.rejects(codeartsProvider.status(CREDENTIAL,'weekly-reward',{fetchImpl:async()=>{throw new Error('unreachable')}}),{code:'codearts_task_unknown'});
});

test('CodeArts claim refuses when not claimable and requires a post-write server recheck otherwise',async()=>{
  let posts=0;
  const closed={campaignId:1,title:'每日签到领1000积分',status:'CONFIRMED',claimable:false,benefitAmount:1000,benefitUnit:'CREDIT'};
  const open={...closed,status:'ELIGIBLE',claimable:true};
  const settled=await codeartsProvider.claim(CREDENTIAL,'daily-checkin',{fetchImpl:async(url,o)=>{
    if(o?.method==='POST')posts++;
    return Response.json({code:0,message:'ok',data:{items:[closed]}});
  }});
  assert.equal(settled.submitted,false);assert.equal(settled.alreadyClaimed,true);assert.equal(posts,0);

  const flow=[];
  let submitted=false;
  const result=await codeartsProvider.claim(CREDENTIAL,'daily-checkin',{fetchImpl:async(url,o)=>{
    flow.push(`${o.method} ${url}`);
    if(o.method==='GET')return Response.json({code:0,message:'ok',data:{items:[submitted?closed:open]}});
    submitted=true;
    return Response.json({code:0,message:'ok',data:{}});
  }});
  assert.equal(result.submitted,true);assert.equal(result.confirmed,true);assert.equal(result.rechecked,true);assert.equal(result.claimed,true);
  assert.deepEqual(flow,['GET https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE',
    'POST https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim',
    'POST https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/confirm',
    'GET https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE']);

  // HTTP 200 with no server-visible state change must NOT be reported as a successful claim.
  await assert.rejects(codeartsProvider.claim(CREDENTIAL,'daily-checkin',{fetchImpl:async(url,o)=>{
    if(o.method==='GET')return Response.json({code:0,message:'ok',data:{items:[open]}});
    return Response.json({code:0,message:'ok',data:{}});
  }}),{code:'codearts_claim_unconfirmed'});

  // A non-zero business code over HTTP 200 is a business failure, not a success.
  await assert.rejects(codeartsProvider.claim(CREDENTIAL,'daily-checkin',{fetchImpl:async(url,o)=>
    o.method==='GET'?Response.json({code:0,message:'ok',data:{items:[open]}}):Response.json({code:40001,message:'尚未到达权益刷新时间'})
  }),{code:'codearts_business_error'});
});

test('CodeArts health aggregates live identity, credits, campaign and catalog without leaking secrets',async()=>{
  const f=await fixture();
  try{
    const credential=await codeartsProvider.resolve({file:f.file});
    const seen=[];
    const health=await codeartsProvider.health(credential,{now:Date.parse('2026-10-11T05:07:23.000Z'),fetchImpl:async(url)=>{
      seen.push(url.split('?')[0].replace(CODEARTS_ORIGIN,''));
      if(url.includes('current/user'))return Response.json({user_id:'user-fixture',user_name:'name-fixture',domain_id:'domain-fixture',user_type:'personal',app_types:['IDE']});
      if(url.includes('statistics/plugin'))return Response.json({metrics:[{name:'usageTotalPackageCredit',package_credit_amount:5500,package_credit_remain:5500}]});
      if(url.includes('ops/delivery'))return Response.json({code:0,message:'ok',data:{items:[{campaignId:1,title:'每日签到领1000积分',status:'CONFIRMED',claimable:false,benefitAmount:1000,benefitUnit:'CREDIT'}]}});
      return Response.json({count:1,builtinModels:[{model_id:'GLM-5.2',model_name:'GLM-5.2',enable:true}]});
    }});
    assert.equal(health.status,'authenticated');assert.equal(health.identity.present,true);assert.equal(health.identity.userType,'personal');
    assert.equal(health.balance.remaining,5500);assert.equal(health.checkin.status,'CONFIRMED');assert.equal(health.modelCount,1);
    assert.equal(health.credential.expired,false);assert.equal(health.checkinSupported,true);
    assert.deepEqual([...seen].sort(),['/snap-manager/v1/current/user','/snap-manager/v1/statistics/plugin','/v1/model/builtin','/v1/ops/delivery']);
    const serialized=JSON.stringify(health);
    for(const secret of [AK,SK,ST,'user-fixture','name-fixture'])assert.equal(serialized.includes(secret),false,`leaked ${secret}`);
  }finally{await f.cleanup();}
});

test('CodeArts chat signs the v2 SSE endpoint, keeps securityToken in x-auth-token, and relays the upstream response',async()=>{
  let seen;
  const upstream=new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
  const {response,chatId}=await codeartsProvider.chat(null,CREDENTIAL,{model:'GLM-5.2',messages:[{role:'user',content:'ping'}],temperature:0.2,max_tokens:16},undefined,
    {now:Date.parse('2026-10-11T05:07:23.552Z'),traceId:'0123456789abcdef0123456789abcdef',fetchImpl:async(url,o)=>{seen=[url,o];return upstream}});
  assert.equal((await response.json()).choices[0].message.content,'hi');
  assert.equal(seen[0],'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions');
  assert.equal(seen[1].method,'POST');assert.equal(seen[1].redirect,'error');
  assert.equal(seen[1].headers['x-auth-token'],ST);assert.equal(seen[1].headers.Accept,'text/event-stream');
  assert.equal(seen[1].headers['app-id'],'CodeAgent3.0');assert.equal(seen[1].headers['X-Security-Token'],ST);
  assert.match(seen[1].headers.Authorization,/^SDK-HMAC-SHA256 Access=AKIDFIXTURE0000000000, /);
  const body=JSON.parse(seen[1].body.toString('utf8'));
  assert.equal(body.model,'GLM-5.2');assert.equal(body.stream,true);assert.equal(body.temperature,0.2);assert.equal(body.max_tokens,16);
  assert.equal(body.chat_id,chatId);assert.equal(body.prompt_cache_key,chatId);assert.equal(body.tool_stream,true);
  assert.match(chatId,/^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(body).sort(),['chat_id','max_tokens','messages','model','prompt_cache_key','stream','temperature','tool_stream']);
  assert.equal(seen[1].body.toString('utf8').includes(SK),false);

  const deterministic=await codeartsProvider.chat(null,CREDENTIAL,{model:'GLM-5.2',messages:[{role:'user',content:'ping'}]},undefined,
    {fetchImpl:async(url,o)=>{seen=[url,o];return new Response('data: [DONE]\n\n')}});
  assert.notEqual(deterministic.chatId,chatId,'identical independent requests must not share an upstream session');

  await assert.rejects(codeartsProvider.chat(null,CREDENTIAL,{messages:[]},undefined,{fetchImpl:async()=>{throw new Error('unreachable')}}),{code:'codearts_chat_invalid'});
  await assert.rejects(codeartsProvider.chat(null,{}, {model:'GLM-5.2',messages:[]},undefined,{fetchImpl:async()=>{throw new Error('unreachable')}}),{code:'codearts_credential_missing'});
  await assert.rejects(codeartsProvider.chat(null,CREDENTIAL,{model:'GLM-5.2',messages:[]},undefined,{fetchImpl:async()=>Response.json({error_msg:'APIG.0301'},{status:401})}),{code:'codearts_auth_failed'});
});

test('CodeArts response bound, JSON guard, abort and redaction hold with no generation call',async()=>{
  await assert.rejects(codeartsRequest(CREDENTIAL,{method:'GET',path:'/v1/model/builtin',fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))}),{code:'codearts_response_too_large'});
  await assert.rejects(codeartsRequest(CREDENTIAL,{method:'GET',path:'/v1/model/builtin',fetchImpl:async()=>new Response('not json')}),{code:'codearts_invalid_response'});
  const abort=new AbortController();abort.abort();
  await assert.rejects(codeartsRequest(CREDENTIAL,{method:'GET',path:'/v1/model/builtin',signal:abort.signal,fetchImpl:async()=>{throw new Error('unreachable')}}),{code:'request_cancelled'});
  let message='';
  await codeartsModels(CREDENTIAL,{fetchImpl:async()=>{throw new Error(`socket hang up ${SK}`)}}).catch(e=>{message=e.message;});
  assert.equal(message,'CodeArts 官方接口连接失败');assert.equal(message.includes(SK),false);
  await assert.rejects(codeartsRequest(CREDENTIAL,{method:'GET',path:'/v1/model/builtin',fetchImpl:async()=>Response.json({error_msg:'x',error_code:'APIG.0301'},{status:500})}),{code:'codearts_upstream_error'});
  const auth=await codeartsRequest(CREDENTIAL,{method:'GET',path:'/v1/model/builtin',fetchImpl:async()=>Response.json({error_code:'APIG.0301'},{status:401})}).catch(e=>e);
  assert.equal(auth.code,'codearts_auth_failed');assert.equal(auth.upstreamCode,'APIG.0301');
  const {codeartsErrorView}=await import('../src/provider-codearts.mjs');
  assert.equal(codeartsErrorView(Object.assign(new Error(`bad ${ST}`),{code:'codearts_auth_failed',status:401})).message.includes(ST),false);
});

test('CodeArts tool choice never silently weakens forced modes and none sends no tools',async()=>{
  const {buildCodeArtsChatBody}=await import('../src/provider-codearts.mjs');
  const tools=[{type:'function',function:{name:'read_fixture',parameters:{type:'object',properties:{}}}}];
  const input={messages:[{role:'user',content:'test'}],tools};
  const auto=buildCodeArtsChatBody({...input,tool_choice:'auto'},'GLM-5.2','fixture');
  assert.deepEqual(auto.tools,tools);assert.equal(auto.tool_choice,'auto');
  const none=buildCodeArtsChatBody({...input,tool_choice:'none'},'GLM-5.2','fixture');
  assert.equal('tools' in none,false);assert.equal('tool_choice' in none,false);
  for(const choice of ['required',{type:'function',function:{name:'read_fixture'}},'unknown'])
    assert.throws(()=>buildCodeArtsChatBody({...input,tool_choice:choice},'GLM-5.2','fixture'),{code:'codearts_tool_choice_unsupported'});
  assert.deepEqual(buildCodeArtsChatBody({...input,tool_choice:null},'GLM-5.2','fixture').tools,tools);
});

test('CodeArts refresh uses exact official STS, PKCE and ES256 DPoP without secret diagnostics or retries',async()=>{
  const {generateKeyPairSync,verify}=await import('node:crypto');
  const {refreshCodeArtsAuth,CODEARTS_TOKEN_URL}=await import('../src/provider-codearts.mjs');
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const auth={account:{id:'fixture'},refresh_token:'fixture-refresh',loginContext:{pkcePair:{codeVerifier:'fixture-verifier'},dpopKeyPair:{privateKeyJwk:privateKey.export({format:'jwk'}),publicKeyJwk:publicKey.export({format:'jwk'})}}};
  let calls=0;
  const refreshed=await refreshCodeArtsAuth(auth,{now:100000,fetchImpl:async(url,o)=>{
    calls++;assert.equal(url,CODEARTS_TOKEN_URL);assert.equal(o.redirect,'error');
    const body=new URLSearchParams(o.body);assert.equal(body.get('client_id'),'codearts-agent');assert.equal(body.get('refresh_token'),'fixture-refresh');assert.equal(body.get('code_verifier'),'fixture-verifier');
    const [h,p,s]=o.headers.DPoP.split('.');const header=JSON.parse(Buffer.from(h,'base64url'));const payload=JSON.parse(Buffer.from(p,'base64url'));
    assert.equal(header.alg,'ES256');assert.equal('d' in header.jwk,false);assert.equal(payload.htu,CODEARTS_TOKEN_URL);assert.equal(payload.htm,'POST');assert.equal(payload.iat,100);
    assert.equal(verify('sha256',Buffer.from(h+'.'+p),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(s,'base64url')),true);
    return Response.json({credentials:{access_key_id:'fixture-ak',secret_access_key:'fixture-sk',security_token:'fixture-token',expiration:new Date(200000).toISOString()},refresh_token:'fixture-next'});
  }});
  assert.equal(calls,1);assert.equal(refreshed.refresh_token,'fixture-next');assert.equal(auth.refresh_token,'fixture-refresh');
  calls=0;const error=await refreshCodeArtsAuth(auth,{fetchImpl:async()=>{calls++;return Response.json({error_code:'STS5.1806',error_msg:'fixture-refresh'},{status:400})}}).catch(e=>e);
  assert.equal(calls,1);assert.equal(error.code,'codearts_refresh_failed');assert.equal(error.upstreamCode,'STS5.1806');assert.equal(error.message.includes('fixture-refresh'),false);
});

test('CodeArts error codes distinguish IAM from concurrency and retain response size limits',async()=>{
  const input={model:'GLM-5.2',messages:[{role:'user',content:'test'}]};
  for(const [status,upstreamCode,retryable] of [[401,'APIG.0301',false],[400,'TM.00001041',true],[400,'OTHER',false],[401,'TM.00001041',false],[403,'TM.00001041',false],[500,'TM.00001041',false]]){
    const e=await codeartsProvider.chat(null,CREDENTIAL,input,undefined,{fetchImpl:async()=>Response.json({error_code:upstreamCode,error_msg:'diagnostic'},{status})}).catch(e=>e);
    assert.equal(e.upstreamCode,upstreamCode);assert.equal(e.retryable,retryable);
    assert.equal(e.status,retryable?429:status);assert.equal(e.upstreamStatus,status);
    assert.equal(e.message,`CodeArts 聊天接口 HTTP ${status} (${upstreamCode})`);
  }
  await assert.rejects(codeartsProvider.chat(null,CREDENTIAL,input,undefined,{fetchImpl:async()=>new Response('x'.repeat(1048577),{status:500})}),{code:'codearts_response_too_large'});
});

test('CodeArts private refresh cache is source-bound, single-flight, non-replaying and leaves the source untouched',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');const {resolveCodeArtsCredential}=await import('../src/provider-codearts.mjs');
 const f=await fixture();const key='secret://'+JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'});
 const writeSource=value=>{const db=new DatabaseSync(f.file);try{db.prepare('insert or replace into ItemTable values (?,?)').run(key,value)}finally{db.close()}};
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 const auth={accessKey:AK,secretKey:SK,securitytoken:ST,expires_at:new Date(1).toISOString(),refresh_token:'fixture-original',loginContext:{pkcePair:{codeVerifier:'fixture-verifier'},dpopKeyPair:{privateKeyJwk:privateKey.export({format:'jwk'}),publicKeyJwk:publicKey.export({format:'jwk'})}}};
 try{
  writeSource('source-A');const before=await readFile(f.file);let calls=0;
  const options={cacheFile:join(f.file+'-cache.json'),now:100000,decryptAuthImpl:async()=>auth,fetchImpl:async()=>{calls++;return Response.json({credentials:{access_key_id:'new-ak',secret_access_key:'new-sk',security_token:'new-st',expiration:new Date(300000).toISOString()},refresh_token:'next-refresh'})}};
  const account={credentials:{file:f.file}};
  const [a,b]=await Promise.all([resolveCodeArtsCredential(account,{},options),resolveCodeArtsCredential(account,{},options)]);
  assert.equal(calls,1);assert.equal(a.accessKey,'new-ak');assert.equal(b.accessKey,'new-ak');assert.deepEqual(await readFile(f.file),before);
  await resolveCodeArtsCredential(account,{},options);assert.equal(calls,1);
  const failed={...options,now:400000,fetchImpl:async()=>{calls++;return Response.json({error_code:'STS5.1806'},{status:400})}};
  await assert.rejects(resolveCodeArtsCredential(account,{},failed),{code:'codearts_refresh_failed'});
  await assert.rejects(resolveCodeArtsCredential(account,{},failed),{code:'codearts_refresh_needs_login'});assert.equal(calls,2);
  writeSource('source-B');const changed=await resolveCodeArtsCredential(account,{}, {...options,decryptAuthImpl:async()=>({...auth,accessKey:'source-B-ak',expires_at:new Date(900000).toISOString()})});
  assert.equal(changed.accessKey,'source-B-ak');assert.equal(calls,2);
 }finally{await f.cleanup();}
});

test('CodeArts tool result reuses its native chat ID but identical independent greetings stay isolated',async()=>{
 const {codeartsChatId}=await import('../src/provider-codearts.mjs');
 const input={model:'GLM-5.2',messages:[{role:'user',content:'same greeting'}]};
 const c={...CREDENTIAL,principal:'session-fixture'};
 assert.notEqual(codeartsChatId(input,c,input.model),codeartsChatId(input,c,input.model));
 assert.equal(codeartsChatId({...input,sessionId:'explicit'},c,input.model),codeartsChatId({...input,sessionId:'explicit',messages:[{role:'user',content:'next'}]},c,input.model));
 for(const stream of [false,true]){
  const callId='tool-session-'+stream;const first=await codeartsProvider.chat(null,c,{...input,stream},undefined,{fetchImpl:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:callId,type:'function',function:{name:'read_fixture',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')});
  await first.response.text();
  const follow={...input,messages:[...input.messages,{role:'tool',tool_call_id:callId,content:'result'}]};
  assert.equal(codeartsChatId(follow,c,input.model),first.chatId);
  assert.notEqual(codeartsChatId(follow,{...c,principal:'other-account'},input.model),first.chatId);
 }
});

test('CodeArts campaigns list is read-only and the provider object matches the integration contract',async()=>{
  const {items,ended}=await codeartsCampaigns(CREDENTIAL,{fetchImpl:async()=>Response.json({code:0,message:'ok',data:{items:[{campaignId:1},{campaignId:3}],endedCampaigns:[]}})});
  assert.deepEqual(items.map(i=>i.campaignId),[1,3]);assert.equal(ended,0);
  for(const key of ['resolve','models','health','status','claim','chat'])assert.equal(typeof codeartsProvider[key],'function',key);
  assert.equal(Object.isFrozen(codeartsDescriptor),true);
});

test('CodeArts lock recheck uses another process rotation or failure without replaying old tokens',async()=>{
 const fs=await import('node:fs/promises');const {syncBuiltinESMExports}=await import('node:module');const {generateKeyPairSync,createHash}=await import('node:crypto');const {resolveCodeArtsCredential}=await import('../src/provider-codearts.mjs');
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 for(const mode of ['fresh','failed','expired']){
  const f=await fixture(),now=100000,cacheFile=f.file+'.race-cache';let calls=0,injected=0;
  const key='secret://'+JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'});const db=new DatabaseSync(f.file);db.prepare('insert or replace into ItemTable values (?,?)').run(key,'race-source');db.close();
  const original=await readFile(f.file);const auth={accessKey:AK,secretKey:SK,securitytoken:ST,expires_at:new Date(1).toISOString(),refresh_token:'old-refresh',loginContext:{pkcePair:{codeVerifier:'fixture-verifier'},dpopKeyPair:{privateKeyJwk:privateKey.export({format:'jwk'}),publicKeyJwk:publicKey.export({format:'jwk'})}}};
  const latest={sourceHash:createHash('sha256').update('race-source').digest('hex'),auth:{...auth,accessKey:'latest-ak',refresh_token:'latest-refresh',expires_at:new Date(mode==='fresh'?now+3600000:1).toISOString()},...(mode==='failed'?{refreshFailure:'already-attempted'}:{})};
  const originalOpen=fs.default.open;fs.default.open=async(path,...args)=>{const lock=await originalOpen(path,...args);if(path===cacheFile+'.lock'){injected++;await fs.writeFile(cacheFile,JSON.stringify(latest));}return lock;};syncBuiltinESMExports();
  try{
   const request=resolveCodeArtsCredential({credentials:{file:f.file}},{},{now,cacheFile,decryptAuthImpl:async()=>auth,fetchImpl:async(_url,options)=>{calls++;assert.equal(new URLSearchParams(options.body).get('refresh_token'),'latest-refresh');return Response.json({credentials:{access_key_id:'renewed-ak',secret_access_key:'renewed-sk',security_token:'renewed-st',expiration:new Date(now+3600000).toISOString()},refresh_token:'next-refresh'})}});
   if(mode==='failed')await assert.rejects(request,{code:'codearts_refresh_needs_login'});else assert.equal((await request).accessKey,mode==='fresh'?'latest-ak':'renewed-ak');
   assert.equal(injected,1);assert.equal(calls,mode==='expired'?1:0);assert.deepEqual(await readFile(f.file),original);
  }finally{fs.default.open=originalOpen;syncBuiltinESMExports();await f.cleanup();}
 }
});

test('CodeArts pending claim only confirms and a failed confirm is never reported credited',async()=>{let state='CLAIMED',posts=[];const fetchImpl=async(url,init)=>{if(init.method==='POST'){posts.push(new URL(url).pathname);state='CONFIRMED';return Response.json({code:0,data:{}})}return Response.json({code:0,data:{items:[{campaignId:1,status:state,claimable:false,benefitAmount:1000}]}})};const result=await codeartsClaim(CREDENTIAL,'daily-checkin',{fetchImpl});assert.equal(result.claimed,true);assert.equal(result.confirmed,true);assert.deepEqual(posts,['/v1/ops/confirm']);await assert.rejects(codeartsClaim(CREDENTIAL,'daily-checkin',{fetchImpl:async(url,init)=>init.method==='POST'?Response.json({code:9},{status:503}):Response.json({code:0,data:{items:[{campaignId:1,status:'CLAIMED',claimable:false}]}})}),{code:'codearts_claim_unconfirmed'});});
test('CodeArts stable credential binding survives repacked storage and uses the rotated token across days',async()=>{const {generateKeyPairSync}=await import('node:crypto');const {resolveCodeArtsCredential}=await import('../src/provider-codearts.mjs');const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const f=await fixture();const key='secret://'+JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'});const write=value=>{const db=new DatabaseSync(f.file);db.prepare('insert or replace into ItemTable values (?,?)').run(key,value);db.close()};const auth={accessKey:AK,secretKey:SK,securitytoken:ST,expires_at:new Date(1).toISOString(),refresh_token:'old-refresh',loginContext:{pkcePair:{codeVerifier:'fixture-verifier'},dpopKeyPair:{privateKeyJwk:privateKey.export({format:'jwk'}),publicKeyJwk:publicKey.export({format:'jwk'})}}};const now=2000000000000,seen=[];const options={now,cacheFile:f.file+'.cache',decryptAuthImpl:async()=>auth,fetchImpl:async(_url,i)=>{seen.push(new URLSearchParams(i.body).get('refresh_token'));return Response.json({credentials:{access_key_id:'next-ak',secret_access_key:SK,security_token:ST,expiration:new Date(options.now+3600000).toISOString()},refresh_token:'next-'+seen.length})}};try{write('envelope-A');await resolveCodeArtsCredential({file:f.file},{},options);write('envelope-B');await resolveCodeArtsCredential({file:f.file},{},options);assert.deepEqual(seen,['old-refresh']);options.now+=86400000;await resolveCodeArtsCredential({file:f.file},{},options);assert.deepEqual(seen,['old-refresh','next-1']);}finally{await f.cleanup()}});
test('CodeArts InvalidDPoPHeader is explicit non-consuming rejection with timed retry',async()=>{const {generateKeyPairSync}=await import('node:crypto');const {resolveCodeArtsCredential}=await import('../src/provider-codearts.mjs');const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const f=await fixture(),key='secret://'+JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'});const db=new DatabaseSync(f.file);db.prepare('insert into ItemTable values (?,?)').run(key,'envelope');db.close();const now=2000000000000;let calls=0;const auth={accessKey:AK,secretKey:SK,securitytoken:ST,expires_at:new Date(1).toISOString(),refresh_token:'old-refresh',loginContext:{pkcePair:{codeVerifier:'fixture-verifier'},dpopKeyPair:{privateKeyJwk:privateKey.export({format:'jwk'}),publicKeyJwk:publicKey.export({format:'jwk'})}}};const opts={now,cacheFile:f.file+'.cache',decryptAuthImpl:async()=>auth,fetchImpl:async()=>{calls++;if(calls===1)return Response.json({error_code:'InvalidDPoPHeader'},{status:400});return Response.json({credentials:{access_key_id:'fresh',secret_access_key:SK,security_token:ST,expiration:new Date(now+3600000).toISOString()},refresh_token:'rotated'})}};try{await assert.rejects(resolveCodeArtsCredential({file:f.file},{},opts),{code:'codearts_refresh_failed',retryable:true});await assert.rejects(resolveCodeArtsCredential({file:f.file},{},{...opts,now:now+1}),{code:'codearts_refresh_deferred'});assert.equal(calls,1);assert.equal((await resolveCodeArtsCredential({file:f.file},{},{...opts,now:now+600001})).accessKey,'fresh');assert.equal(calls,2)}finally{await f.cleanup()}});

test('CodeArts unknown refresh result stays blocked after storage rewrap but a new native credential recovers',async()=>{const {generateKeyPairSync}=await import('node:crypto');const {resolveCodeArtsCredential}=await import('../src/provider-codearts.mjs');const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const f=await fixture(),key='secret://'+JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'});const set=v=>{const db=new DatabaseSync(f.file);db.prepare('insert or replace into ItemTable values (?,?)').run(key,v);db.close()};const now=2000000000000;let calls=0;let auth={accessKey:AK,secretKey:SK,securitytoken:ST,expires_at:new Date(1).toISOString(),refresh_token:'old-refresh',loginContext:{pkcePair:{codeVerifier:'fixture-verifier'},dpopKeyPair:{privateKeyJwk:privateKey.export({format:'jwk'}),publicKeyJwk:publicKey.export({format:'jwk'})}}};const opts={now,cacheFile:f.file+'.cache',decryptAuthImpl:async()=>auth,fetchImpl:async()=>{calls++;throw Error('transport outcome unknown')}};try{set('A');await assert.rejects(resolveCodeArtsCredential({file:f.file},{},opts),{code:'codearts_refresh_unconfirmed'});set('B');await assert.rejects(resolveCodeArtsCredential({file:f.file},{},opts),{code:'codearts_refresh_needs_login'});auth={...auth,accessKey:'native-new',expires_at:new Date(now+3600000).toISOString()};assert.equal((await resolveCodeArtsCredential({file:f.file},{},opts)).accessKey,'native-new');assert.equal(calls,1)}finally{await f.cleanup()}});

for(const state of ['CLAIMED','CONFIRMED','CLAIMABLE'])test('CodeArts confirmOnly recovery never issues claim after status '+state,async()=>{
 let current=state;const posts=[];const fetchImpl=async(url,init)=>{
  if(init.method==='POST'){posts.push(new URL(url).pathname);current='CONFIRMED';return Response.json({code:0,data:{}})}
  return Response.json({code:0,data:{items:[{campaignId:1,status:current,claimable:current==='CLAIMABLE',benefitAmount:1000}]}});
 };
 const result=await codeartsClaim(CREDENTIAL,'daily-checkin',{confirmOnly:true,fetchImpl});
 assert.deepEqual(posts,state==='CLAIMED'?['/v1/ops/confirm']:[]);
 assert.equal(result.submitted,state==='CLAIMED');
 if(state==='CLAIMABLE'){assert.equal(result.claimed,false);assert.equal(result.reason,'pending_confirmation_changed')}
 else assert.equal(result.claimed,true);
});
