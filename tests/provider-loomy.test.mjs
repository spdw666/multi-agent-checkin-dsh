// provider-loomy.test.mjs — dependency-injection tests for the unified Loomy contract.
// No ambient network; session fixtures are in-memory (readFileImpl injection). Secrets never surface.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  descriptor, loomyProvider, loomyResolve, loomyCredentialView, readLoomySession, loomyEnvPresence,
  loomyFetch, loomyRequest, loomyIdentity, loomyPetWork, loomyStatus, loomyClaim, loomyHealth,
  loomyModels, loomyPointBalance, loomyChat, transformLoomySse, LOOMY_POINTS_ORIGIN, LOOMY_MODEL_FAMILIES, LOOMY_SUCCESS_CODES,
} from '../src/provider-loomy.mjs';

const SESSION_TOKEN = 'fixture-session-token-0123456789abcdef';
const RAW_USERID = 'fixtureuserid123456';
const PHONE = '19900000000';
const sessionFixture = JSON.stringify({session: SESSION_TOKEN, userid: RAW_USERID, phone: PHONE, updatedAt: Date.UTC(2026, 9, 11, 4, 3, 59)});

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
const ok = (data) => jsonResponse({code: '000000', desc: '成功', data});
const err = (code, desc) => jsonResponse({code, desc, data: {}});

const SECRET = {accessToken: SESSION_TOKEN, principal: 'sha256:fixture', principalField: 'userid', phonePresent: true, updatedAt: null, source: 'electron_store_auth_session'};

// ------------------------------------------------------------------ descriptor / credential

test('loomy descriptor: real daily mechanic (pet-work) is declared, session auth kind', () => {
  assert.equal(descriptor.id, 'loomy');
  assert.equal(descriptor.authKind, 'session_token');
  assert.equal(descriptor.checkinSupported, true);
  assert.deepEqual(descriptor.checkinTasks, ['pet-work', 'daily-quota']);
  assert.ok(descriptor.underlyingProvider.includes('production'));
});

test('readLoomySession: parses auth-session.json; principal stable; no raw id/phone leaves', async () => {
  const secret = await readLoomySession({file: 'x', readFileImpl: async () => sessionFixture});
  assert.equal(secret.accessToken, SESSION_TOKEN);
  assert.ok(secret.principal.startsWith('sha256:'));
  const text = JSON.stringify(secret);
  assert.ok(!text.includes(RAW_USERID));
  assert.ok(!text.includes(PHONE));
  const again = await readLoomySession({file: 'x', readFileImpl: async () => sessionFixture});
  assert.equal(again.principal, secret.principal); // stable across reads
});

test('readLoomySession: empty session -> 401 credential_missing; malformed -> 401 session_parse', async () => {
  await assert.rejects(() => readLoomySession({file: 'x', readFileImpl: async () => JSON.stringify({session: '', userid: 'u'})}), e => e.status === 401 && e.code === 'loomy_credential_missing');
  await assert.rejects(() => readLoomySession({file: 'x', readFileImpl: async () => '{oops'}), e => e.status === 401 && e.code === 'loomy_session_parse');
  await assert.rejects(() => readLoomySession({file: 'x', readFileImpl: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }}), e => e.code === 'loomy_credential_missing');
});

test('resolve: reads a real temp file when referenced (integration, no network)', async () => {
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'loomy-test-'));
  try {
    const file = join(dir, 'auth-session.json');
    await writeFile(file, sessionFixture);
    const credential = await loomyResolve({credentials: {file}}, {});
    assert.equal(credential.accessToken, SESSION_TOKEN);
    assert.ok(!JSON.stringify(credential).includes(RAW_USERID));
    const view = loomyCredentialView(credential);
    assert.equal(view.present, true);
    assert.equal(view.principal, credential.principal);
    assert.ok(!JSON.stringify(view).includes(SESSION_TOKEN));
    assert.ok(!JSON.stringify(view).includes(RAW_USERID));
    assert.ok(!JSON.stringify(view).includes(PHONE));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('resolve: missing file -> 401 credential_missing (no fabricated login)', async () => {
  await assert.rejects(() => loomyResolve({credentials: {file: 'C:/definitely/not/here-auth-session.json'}}, {}), e => e.status === 401 && e.code === 'loomy_credential_file_unavailable');
});

test('provider export: full unified surface', () => {
  for (const fn of ['resolve', 'models', 'health', 'status', 'claim', 'chat']) assert.equal(typeof loomyProvider[fn], 'function', fn);
});

// ------------------------------------------------------------------ transport guards

test('loomy fetch: fixed origin/prefix guard + injection requirement', async () => {
  const spy = async () => jsonResponse({});
  await assert.rejects(() => loomyFetch(spy, '/etc/passwd', {}), e => e.code === 'loomy_endpoint_invalid');
  await assert.rejects(() => loomyFetch(spy, 'https://evil.example/api/v1/user/identity', {}), e => e.code === 'loomy_endpoint_invalid');
  await assert.rejects(() => loomyFetch(undefined, '/api/v1/user/identity', {}), e => e.code === 'loomy_fetch_not_injected');
  let seen = null;
  const fetchImpl = async (url, init) => { seen = {url: String(url), headers: init.headers}; return ok({}); };
  await loomyFetch(fetchImpl, '/api/v1/user/identity', {token: 't'});
  assert.ok(seen.url.startsWith(LOOMY_POINTS_ORIGIN + '/api/'));
  assert.equal(seen.headers.token, 't'); // official points-service token header convention
});

test('loomy transport: 40100-style HTTP and 100002 envelope are distinguished', async () => {
  const http401 = async () => new Response('', {status: 401});
  await assert.rejects(() => loomyIdentity(SECRET, {fetchImpl: http401}), e => e.status === 401 && e.code === 'loomy_auth_failed');
  const stale = async () => err('100002', '登录已失效，请重新登录');
  await assert.rejects(() => loomyIdentity(SECRET, {fetchImpl: stale}), e => e.status === 401 && e.code === 'loomy_session_expired');
  const biz = async () => err('100003', '其它业务错误');
  await assert.rejects(() => loomyIdentity(SECRET, {fetchImpl: biz}), e => e.status === 502 && e.code === 'loomy_business_error');
});

// ------------------------------------------------------------------ pet-work status/claim

const petWorkFixture = (claimed) => ok({businessDate: '2026-10-11', configVersion: 'v7', reachedTierId: 'tier-3', claimedToday: claimed, tiers: [{id: 'tier-1', label: '初档', points: 5}, {id: 'tier-3', label: '三档', points: 30}]});

test('pet-work: snapshot parses known fields; claim markers detected; keys reported', async () => {
  const fetchImpl = async () => petWorkFixture(false);
  const pet = await loomyPetWork(SECRET, {fetchImpl});
  assert.equal(pet.businessDate, '2026-10-11');
  assert.equal(pet.configVersion, 'v7');
  assert.equal(pet.reachedTierId, 'tier-3');
  assert.equal(pet.claimed, false);
  assert.equal(pet.tiers.length, 2);
  assert.ok(pet.keys.includes('businessDate'));
});

test('status: claimed today -> not claimable; unclaimed with preconditions -> claimable', async () => {
  const claimedBusy = async () => petWorkFixture(true);
  const s1 = await loomyStatus(SECRET, 'pet-work', {fetchImpl: claimedBusy});
  assert.equal(s1.claimed, true);
  assert.equal(s1.claimable, false);
  const openBusy = async () => petWorkFixture(false);
  const s2 = await loomyStatus(SECRET, 'pet-work', {fetchImpl: openBusy});
  assert.equal(s2.claimed, false);
  assert.equal(s2.claimable, true);
  await assert.rejects(() => loomyStatus(SECRET, 'weekly', {fetchImpl: openBusy}), e => e.status === 400 && e.code === 'loomy_task_unknown');
});

test('claim: already claimed -> no POST', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push(init.method ?? 'GET'); return petWorkFixture(true); };
  const r = await loomyClaim(SECRET, 'pet-work', {fetchImpl});
  assert.equal(r.submitted, false);
  assert.equal(r.alreadyClaimed, true);
  assert.ok(calls.every(m => m === 'GET'));
});

test('claim: preconditions missing -> no POST, honest reason', async () => {
  const calls = [];
  const fetchImpl = async () => ok({claimedToday: false}); // no businessDate/configVersion/reachedTierId
  const r = await loomyClaim(SECRET, 'pet-work', {fetchImpl});
  assert.equal(r.submitted, false);
  assert.equal(r.reason, 'preconditions_missing');
  assert.equal(calls.length, 0);
});

test('claim: submits exactly the three official fields; re-reads snapshot; success requires claimed marker', async () => {
  const posts = [];
  let reads = 0;
  const fetchImpl = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'POST') { posts.push({url: String(url), body: JSON.parse(init.body)}); return ok({awarded: true}); }
    reads += 1;
    return petWorkFixture(reads >= 2); // before: false, after: true
  };
  const r = await loomyClaim(SECRET, 'pet-work', {fetchImpl});
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/api/v1/pet-work/rewards'));
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['businessDate', 'configVersion', 'reachedTierId']);
  assert.equal(posts[0].body.businessDate, '2026-10-11');
  assert.equal(r.submitted, true);
  assert.equal(r.claimed, true);
});

test('claim: POST ok but snapshot marker unreadable -> submitted, NOT confirmed (no blind success)', async () => {
  let reads = 0;
  const fetchImpl = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'POST') return ok({awarded: true});
    reads += 1;
    return ok({businessDate: '2026-10-11', configVersion: 'v7', reachedTierId: 'tier-3',...(reads===1?{claimedToday:false}:{})}); // recheck has no claim marker
  };
  const r = await loomyClaim(SECRET, 'pet-work', {fetchImpl});
  assert.equal(r.submitted, true);
  assert.equal(r.confirmed, false);
  assert.equal(r.reason, 'snapshot_claim_marker_unverified');
});

// ------------------------------------------------------------------ health / models / chat

test('health: stale session (100002) reported honestly as session_expired, nothing fabricated', async () => {
  const fetchImpl = async () => err('100002', '登录已失效，请重新登录');
  const health = await loomyHealth(SECRET, {fetchImpl});
  assert.equal(health.status, 'session_expired');
  assert.equal(health.balance.value, null);
  assert.equal(health.balance.checkedIn, null);
  assert.equal(health.capabilities.checkin, true);
  assert.ok(health.note.includes('100002') || health.note.includes('重新登录'));
  assert.ok(!JSON.stringify(health).includes(SESSION_TOKEN));
});

test('health: no token -> credential_missing status, no network', async () => {
  let called = 0;
  const health = await loomyHealth({}, {fetchImpl: async () => { called++; }});
  assert.equal(health.status, 'credential_missing');
  assert.equal(called, 0);
});

test('health: pet-work cannot replace failed authoritative points balance', async () => {
  const fetchImpl = async (url) => String(url).includes('pet-work')
    ? ok({businessDate: '2026-10-11', configVersion: 'v7', reachedTierId: 't3', claimedToday: true, currentBalance: 120.5})
    : err('100004', 'identity 暂不可用');
  const health = await loomyHealth(SECRET, {fetchImpl});
  assert.equal(health.balance.value, null);
  assert.equal(health.balanceError.code, 'loomy_business_error');
  assert.equal(health.balance.checkedIn, null);
  assert.equal(health.services.petWork, 'ok');
  assert.ok(health.errors.identity);
});

test('models: families listed, capacity unverified -> null, not callable, honest reason', () => {
  const models = loomyModels();
  assert.equal(models.length, 0);
  for (const m of models) {
    assert.equal(m.callable, false);
    assert.equal(m.callableReason, 'model_transport_unverified_live');
    assert.equal(m.contextWindow, null);
    assert.equal(m.maxTokens, null);
    assert.equal(m.officialMaxTokens, null);
  }
});

test('chat: requires fetch and model; unverified path refuses clear mistakes', async () => {
  await assert.rejects(() => loomyChat(null, SECRET, {messages: []}, undefined, {fetchImpl: async () => ok({})}), e => e.code === 'loomy_chat_invalid');
  await assert.rejects(() => loomyChat(null, {}, {model: 'unverified', messages: []}, undefined, {}), e => e.code === 'loomy_credential_missing');
});

test('chat: JSON envelope error inside 200 becomes AppError; SSE passes through bounded', async () => {
  const bizErr = async () => jsonResponse({code: '100002', desc: '登录已失效'});
  await assert.rejects(() => loomyChat(null, SECRET, {model: 'm', messages: [], stream: false}, undefined, {fetchImpl: bizErr}), e => e.code === 'loomy_session_expired');
  const chunks = ['data: {"choices":[{"delta":{"content":"\u4f60\u597d"}}]}\n\ndata: [DONE]\n\n'];
  const sse = async (url) => String(url).endsWith('/models')?jsonResponse({data:[{id:'m',type:'chat',context_length:1000000,max_output_tokens:4096}]}):new Response(new ReadableStream({start(c){const enc = new TextEncoder(); for (const chunk of chunks) c.enqueue(enc.encode(chunk)); c.close();}}), {status: 200, headers: {'content-type': 'text/event-stream'}});
  const {response, verified} = await loomyChat(null, SECRET, {model: 'm', messages: [], stream:true}, undefined, {fetchImpl: sse});
  assert.equal(verified, 'official_production_protocol');
  const text = await response.text();
  assert.ok(text.includes('"content":"\u4f60\u597d"'));
  assert.ok(text.includes('data: [DONE]'));
});

test('transformLoomySse: business error inside the stream errors the Response', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: {"code":"100002","desc":"\u767b\u5f55\u5df2\u5931\u6548"}\n\n'];
  const upstream = new ReadableStream({start(c){const enc = new TextEncoder(); for (const chunk of chunks) c.enqueue(enc.encode(chunk)); c.close();}});
  const wrapped = transformLoomySse(upstream);
  await assert.rejects(() => wrapped.text(), e => e.code === 'loomy_session_expired' && e.status === 401);
});

test('env presence: legacy encrypted envelope detected without decrypt', async () => {
  const env = await loomyEnvPresence({envFilePath: 'x', readFileImpl: async () => 'LOOMYENC1:AAAABBBBCCCC=='});
  assert.equal(env.present, true);
  assert.equal(env.encryptedEnvelope, true);
  assert.equal(env.plaintextReadable, false);
  const missing = await loomyEnvPresence({envFilePath: 'x', readFileImpl: async () => { throw new Error('ENOENT'); }});
  assert.equal(missing.present, false);
});

const productionCatalog={object:'list',data:[{id:'official',type:'chat',context_length:1048576,max_output_tokens:384000,capabilities:{function_calling:true,vision:true},reasoning_efforts:['low','high'],default_reasoning_effort:'low'}]};
test('production origin and session headers match official runtime, not test environment',async()=>{await loomyFetch(async(url,init)=>{assert.equal(url,'https://loomyad.xunfei.cn/api/v1/models');assert.equal(init.headers.authorization,'Bearer fixture');assert.equal(init.headers.token,'fixture');assert.match(init.headers.traceparent,/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);assert.ok(init.headers['loomy-version']);assert.equal(init.redirect,'error');return jsonResponse(productionCatalog);},'/api/v1/models',{token:'fixture'});});
test('production catalog retains precise capability metadata',async()=>{const rows=await loomyModels(SECRET,{fetchImpl:async()=>jsonResponse(productionCatalog)});assert.equal(rows[0].contextWindow,1048576);assert.equal(rows[0].maxTokens,384000);assert.equal(rows[0].tools,true);assert.deepEqual(rows[0].reasoning.supportedEfforts,['low','high']);});
test('personal balance uses availableBalance field not a calculated sum or team balance',async()=>{const b=await loomyPointBalance(SECRET,{fetchImpl:async()=>ok({balance:5000,dailyBalance:4000,availableBalance:8999})});assert.equal(b.value,8999);assert.equal(b.parts[1].value,4000);const unknown=await loomyPointBalance(SECRET,{fetchImpl:async()=>ok({balance:0})});assert.equal(unknown.value,null);assert.equal(unknown.parts[0].value,0);});
test('daily quota observes official data without any claim POST',async()=>{let n=0;const s=await loomyStatus(SECRET,'daily-quota',{fetchImpl:async(url,init)=>{n++;assert.equal(init.method,'GET');return ok({availableBalance:5000,dailyBalance:3000});}});assert.equal(s.observed,false);assert.equal(s.active,true);assert.equal(s.claimed,false);assert.equal(s.details.value,5000);assert.equal(s.details.dailyQuotaObserved,false);assert.equal(n,1);});
test('real nested pet snapshot is observable but not a fabricated reward eligibility',async()=>{const fetchImpl=async()=>ok({enabled:true,businessDate:'2026-10-11',config:{version:'pet-work-v1',tiers:[{tierId:'tier_1'}]},status:{earnedPointsToday:0,rewardedTierIds:[],dailyRewardCapped:false}});const s=await loomyStatus(SECRET,'pet-work',{fetchImpl});assert.equal(s.observed,true);assert.equal(s.claimable,false);assert.equal(s.configVersion,'pet-work-v1');assert.equal(s.details.earnedPointsToday,0);assert.equal((await loomyClaim(SECRET,'pet-work',{fetchImpl})).submitted,false);});
test('chat rejects models outside the live catalog',async()=>{await assert.rejects(loomyChat({},SECRET,{model:'unknown'},undefined,{fetchImpl:async()=>jsonResponse(productionCatalog)}),{code:'loomy_model_unknown'});});
test('chat stream business errors remain errors after normalizer integration',async()=>{await assert.rejects(loomyChat({},SECRET,{model:'official'},undefined,{fetchImpl:async(url)=>url.endsWith('/models')?jsonResponse(productionCatalog):new Response('data: {"code":"100002","desc":"expired"}\n\n',{headers:{'content-type':'text/event-stream'}})}),{code:'loomy_session_expired'});});

const receiptNow='2026-10-13T04:00:00Z';
function dailyFetch({date='2026-10-13',mismatch=false,posts=[]}={}) { return async(url,init)=>{ if(init.method==='POST'){posts.push({url,body:JSON.parse(init.body)});return ok({alreadyProcessed:true,currentBalance:10000,dailyBalance:5000,dailyQuota:5000,...(date?{dailyCycleDate:date}:{})});}return ok({balance:5000,dailyBalance:5000,availableBalance:mismatch?9999:10000});}; }
test('daily-quota refresh: official empty POST then balance verification, never claims pet work',async()=>{const posts=[];const secret={...SECRET,principal:'daily-fixture'};const options={now:receiptNow,fetchImpl:dailyFetch({posts})};const r=await loomyClaim(secret,'daily-checkin',options);assert.equal(r.task,'daily-quota');assert.equal(r.claimed,false);assert.equal(r.dailyQuotaObserved,true);assert.equal(r.dailyCycleDate,'2026-10-13');assert.equal(r.alreadyProcessed,true);assert.deepEqual(posts,[{url:LOOMY_POINTS_ORIGIN+'/api/v1/points/first-login',body:{}}]);const health=await loomyPointBalance(secret,options);assert.equal(health.dailyQuotaObserved,true);assert.equal((await loomyPointBalance({...secret,accessToken:'rotated'},options)).dailyQuotaObserved,false);assert.equal((await loomyPointBalance(secret,{...options,now:'2026-10-14T04:00:00Z'})).dailyQuotaObserved,false);});
test('daily-quota missing date or mismatching balance never verifies receipt; failure clears previous evidence',async()=>{const secret={...SECRET,principal:'daily-fail-fixture'};for(const scenario of [{date:null},{mismatch:true},{date:'2026-10-12'}]){const r=await loomyClaim(secret,'daily-quota',{now:receiptNow,fetchImpl:dailyFetch(scenario)});assert.equal(r.dailyQuotaObserved,false);assert.equal(r.claimed,false);}await loomyClaim(secret,'daily-quota',{now:receiptNow,fetchImpl:dailyFetch()});await assert.rejects(loomyClaim(secret,'daily-quota',{now:receiptNow,fetchImpl:async()=>err('100002','expired')}));assert.equal((await loomyPointBalance(secret,{now:receiptNow,fetchImpl:dailyFetch()})).dailyQuotaObserved,false);});
test('caller-supplied pet progress cannot unlock an unqualified server snapshot',async()=>{let posts=0;const r=await loomyClaim(SECRET,'pet-work',{businessDate:'2026-10-13',configVersion:'v1',reachedTierId:'tier3',fetchImpl:async(url,init)=>{if(init.method==='POST')posts++;return ok({businessDate:'2026-10-13',config:{version:'v1'},status:{earnedPointsToday:0,rewardedTierIds:[]}});}});assert.equal(r.submitted,false);assert.equal(posts,0);});

test('real ClaimService and Ledger execute daily refresh once, preserve idempotency, and renew next day',async(t)=>{
  const {ClaimService}=await import('../src/claims.mjs'),{Ledger}=await import('../src/store.mjs'),{dayIn}=await import('../src/util.mjs');
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-13T04:00:00Z')});
  const dir=await mkdtemp(join(tmpdir(),'loomy-claim-integration-')),ledger=new Ledger(dir),secret={...SECRET,principal:'daily-integrated',principalHash:'daily-integrated'};let posts=0;
  const fetchImpl=async(url,init)=>{if(init.method==='POST'){posts++;assert.equal(url,LOOMY_POINTS_ORIGIN+'/api/v1/points/first-login');assert.deepEqual(JSON.parse(init.body),{});return ok({alreadyProcessed:true,currentBalance:10000,dailyBalance:5000,dailyQuota:5000,dailyCycleDate:dayIn(new Date(),'Asia/Shanghai')});}return ok({availableBalance:10000,balance:5000,dailyBalance:5000});};
  const options={fetchImpl},config={value:{accounts:[{id:'a',platform:'loomy',enabled:true,tasks:[{id:'daily-quota',enabled:true}]}],scheduler:{timezone:'Asia/Shanghai'}}};
  const service=new ClaimService(config,{resolve:async()=>secret},{status:async()=>loomyStatus(secret,'daily-quota',options),claim:async()=>loomyClaim(secret,'daily-quota',options)},ledger);
  try{
    const before=await loomyStatus(secret,'daily-quota',options);assert.equal(before.observed,false);assert.equal(before.active,true);
    const first=await service.run('a','daily-quota');assert.equal(first.status,'observed');assert.equal(first.claimed,false);assert.equal(first.officialRefreshConfirmed,true);assert.equal(first.details.dailyQuotaObserved,true);assert.equal(posts,1);
    assert.equal((await service.run('a','daily-quota')).status,'observed');assert.equal(posts,1);
    assert.equal((await loomyStatus(secret,'daily-quota',options)).active,false);
    t.mock.timers.tick(86400000);assert.equal((await loomyStatus(secret,'daily-quota',options)).observed,false);
    const next=await service.run('a','daily-quota');assert.equal(next.status,'observed');assert.equal(next.details.dailyCycleDate,'2026-10-14');assert.equal(next.officialRefreshConfirmed,true);assert.equal(posts,2);
    assert.equal((await service.run('a','daily-quota')).status,'observed');assert.equal(posts,2);
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});t.mock.timers.reset();}
});

