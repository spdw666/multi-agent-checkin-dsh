// provider-loomy.test.mjs — dependency-injection tests for the unified Loomy contract.
// No ambient network; session fixtures are in-memory (readFileImpl injection). Secrets never surface.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  descriptor, loomyProvider, loomyResolve, loomyCredentialView, readLoomySession, loomyEnvPresence,
  loomyFetch, loomyRequest, loomyIdentity, loomyPetWork, loomyStatus, loomyClaim, loomyHealth,
  loomyModels, loomyChat, transformLoomySse, LOOMY_POINTS_ORIGIN, LOOMY_MODEL_FAMILIES, LOOMY_SUCCESS_CODES,
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
  assert.deepEqual(descriptor.checkinTasks, ['pet-work', 'daily-checkin']);
  assert.ok(descriptor.underlyingProvider.includes('voicecloud'));
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
  await assert.rejects(() => loomyFetch(spy, 'https://evil.example/loomy/integration/api/v1/user/identity', {}), e => e.code === 'loomy_endpoint_invalid');
  await assert.rejects(() => loomyFetch(undefined, '/loomy/integration/api/v1/user/identity', {}), e => e.code === 'loomy_fetch_not_injected');
  let seen = null;
  const fetchImpl = async (url, init) => { seen = {url: String(url), headers: init.headers}; return ok({}); };
  await loomyFetch(fetchImpl, '/loomy/integration/api/v1/user/identity', {token: 't'});
  assert.ok(seen.url.startsWith(LOOMY_POINTS_ORIGIN + '/loomy/integration/'));
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
  const s2 = await loomyStatus(SECRET, 'daily-checkin', {fetchImpl: openBusy});
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
  assert.ok(posts[0].url.endsWith('/loomy/integration/api/v1/pet-work/rewards'));
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
    return ok({businessDate: '2026-10-11', configVersion: 'v7', reachedTierId: 'tier-3'}); // no claim marker either time
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

test('health: pet-work ok with balance field -> balance surfaced; identity failure tolerated', async () => {
  const fetchImpl = async (url) => String(url).includes('pet-work')
    ? ok({businessDate: '2026-10-11', configVersion: 'v7', reachedTierId: 't3', claimedToday: true, currentBalance: 120.5})
    : err('100004', 'identity 暂不可用');
  const health = await loomyHealth(SECRET, {fetchImpl});
  assert.equal(health.balance.value, 120.5);
  assert.equal(health.balance.checkedIn, true);
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
  const sse = async () => new Response(new ReadableStream({start(c){const enc = new TextEncoder(); for (const chunk of chunks) c.enqueue(enc.encode(chunk)); c.close();}}), {status: 200, headers: {'content-type': 'text/event-stream'}});
  const {response, verified} = await loomyChat(null, SECRET, {model: 'm', messages: [], stream:true}, undefined, {fetchImpl: sse});
  assert.equal(verified, 'unverified_live');
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
