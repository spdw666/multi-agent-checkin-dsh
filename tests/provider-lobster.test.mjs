// provider-lobster.test.mjs — dependency-injection tests for the unified LobsterAI provider contract.
// No ambient network: every network path goes through an injected fetchImpl. No real credentials:
// resolve is exercised against a temporary SQLite DB created inside the test itself.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  descriptor, lobsterProvider, readLobsterToken, lobsterResolve, lobsterCredentialView,
  lobsterModels, lobsterBalance, lobsterActivitySlot, lobsterCheckinContext, lobsterStatus,
  lobsterClaimCheckin, lobsterHealth, lobsterChat, lobsterFetch, sseErrorOf, transformSse,
  LOBSTER_SERVER_ORIGIN,
} from '../src/provider-lobster.mjs';
import {desktopCompletionLimit} from '../src/provider-sse.mjs';

// ------------------------------------------------------------------ helpers

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
const sseResponse = (chunks, status = 200) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  },
}), {status, headers: {'content-type': 'text/event-stream'}});
const boundedSse = (records, cycles = 1000) => new Response(new ReadableStream({
  async pull(controller) {
    for (let i = 0; i < cycles; i++) {
      controller.enqueue(new TextEncoder().encode(records));
      await Promise.resolve();
    }
    controller.close();
  },
}), {status: 200});

const TOKEN_VALUE = 'fixture-token-value-not-a-real-secret';
const RAW_ID = 'fixture-account-id-987654321';

async function makeFixtureDb(dir, {token = TOKEN_VALUE, user = {yid: RAW_ID, phone: '19900000000', nickname: 'FixtureUser', accountMode: 'personal'}} = {}) {
  const dbPath = join(dir, `lobster-${Math.random().toString(16).slice(2)}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
  insert.run('auth_tokens', JSON.stringify({accessToken: token, refreshToken: 'fixture-refresh'}), 1);
  insert.run('auth_user', JSON.stringify(user), 1);
  db.close();
  return dbPath;
}

function setKv(dbPath, key, value) {
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(value), key);
  db.close();
}

const SECRET_CRED = {accessToken: TOKEN_VALUE, principal: 'sha256:fixtureprincipal', principalField: 'yid', refreshTokenPresent: true, accountMode: 'personal', expiresAtMs: null, source: 'desktop_sqlite_kv', credential: {present: true}};

const modelsFixture = [
  {modelId: 'deepseek-flash', modelName: 'DeepSeek-V4.1-Flash', supportsImage: true, supportsThinking: true, thinkingConfig: {options: [{level: 'off'}, {level: 'high'}, {level: 'max'}], defaultLevel: 'high'}, supportsToolCalling: null, contextWindow: 1000000, costMultiplier: 0.05, accessible: true},
  {modelId: 'mystery-model', modelName: 'Mystery', supportsImage: false, supportsThinking: false, thinkingConfig: null, supportsToolCalling: false, contextWindow: null, costMultiplier: null, accessible: true},
  {modelId: 'restricted-model', modelName: 'Restricted', supportsImage: false, supportsThinking: false, thinkingConfig: null, supportsToolCalling: null, contextWindow: 1000000, costMultiplier: 1, accessible: false, restrictionHint: '本次不可用'},
];

const slotFixture = {code: 0, message: 'success', data: {slotState: 'available', serverTime: 'T', activity: {activityCode: 'daily-check-in-evergreen-prod-20260814', configRevision: 1, activityType: 'daily_check_in', cardTitle: '每日积分礼', timezone: 'Asia/Shanghai', loginRequired: true}}};
const contextFixture = (claimedToday) => ({code: 0, message: 'success', data: {activityCode: 'daily-check-in-evergreen-prod-20260814', configRevision: 1, lifecycleState: 'active', authenticated: true, loginRequired: true, serverTime: 'T', state: {totalDays: 36500, claimedDays: claimedToday ? 1 : 0, claimedToday, completed: false, rewardCredits: 100, claimedCredits: claimedToday ? 100 : 0, timezone: 'Asia/Shanghai'}, actions: claimedToday ? [] : ['check_in']}});
const quotaFixture = {code: 0, message: 'success', data: {freeCreditsUsed: 0.0261, freeCreditsTotal: 300, freeCreditsRemaining: 299.9739, planName: '免费', freeCreditsExpiresAt: '2026-10-25', hasPaidCredits: true}};
const profileFixture = {code: 0, message: 'success', data: {totalCreditsRemaining: 399.9739, creditItems: [{type: 'free', label: '新用户赠送', creditsRemaining: 299.9739, expiresAt: '2026-10-25T12:13:55'}, {type: 'campaign', label: '每日登录奖励', creditsRemaining: 100, expiresAt: '2026-11-10T12:14:33'}]}};

let scratchDir = null;
async function scratch() {
  if (!scratchDir) scratchDir = await mkdtemp(join(tmpdir(), 'lobster-test-'));
  return scratchDir;
}
test.after(async () => { if (scratchDir) await rm(scratchDir, {recursive: true, force: true}); });

// ------------------------------------------------------------------ credential / resolve

test('lobster descriptor: check-in now supported (old "no check-in" claim superseded)', () => {
  assert.equal(descriptor.id, 'lobster');
  assert.equal(descriptor.checkinSupported, true);
  assert.equal(descriptor.claimSupported, true);
  assert.ok(descriptor.underlyingProvider.includes('youdao'));
});

test('readLobsterToken: reads real kv rows and re-reads on every call', async () => {
  const dir = await scratch();
  const dbPath = await makeFixtureDb(dir);
  const first = await readLobsterToken({dbFile: dbPath});
  assert.equal(first.accessToken, TOKEN_VALUE);
  assert.equal(first.refreshTokenPresent, true);
  assert.equal(first.principalField, 'yid');
  assert.ok(first.principal.startsWith('sha256:'));
  assert.ok(!first.principal.includes(RAW_ID));
  // The desktop may rotate the token between resolves: change the DB, re-read, expect the new value.
  setKv(dbPath, 'auth_tokens', {accessToken: 'rotated-token-value', refreshToken: 'r2'});
  const second = await readLobsterToken({dbFile: dbPath});
  assert.equal(second.accessToken, 'rotated-token-value');
  const third = await readLobsterToken({dbFile: dbPath});
  assert.equal(third.accessToken, second.accessToken); // stable while unchanged
});

test('readLobsterToken: principal stable across reads, raw ID never materializes', async () => {
  const dir = await scratch();
  const dbPath = await makeFixtureDb(dir);
  const a = await readLobsterToken({dbFile: dbPath});
  const b = await readLobsterToken({dbFile: dbPath});
  assert.equal(a.principal, b.principal);
  assert.ok(!JSON.stringify(a).includes(RAW_ID));
  assert.ok(!JSON.stringify(a).includes('19900000000'));
  assert.ok(!JSON.stringify(a).includes('FixtureUser'));
});

test('readLobsterToken: missing DB -> 401, not a crash', async () => {
  await assert.rejects(() => readLobsterToken({dbFile: 'C:/definitely/not/here.sqlite'}), e => e.status === 401 && e.code === 'lobster_db_unavailable');
});

test('resolve: honors account.credentials.file (sqlite path), token non-empty, public view clean', async () => {
  const dir = await scratch();
  const dbPath = await makeFixtureDb(dir);
  const credential = await lobsterResolve({credentials: {file: dbPath}}, {});
  assert.equal(credential.accessToken, TOKEN_VALUE);
  assert.ok(credential.principal.startsWith('sha256:'));
  const view = lobsterCredentialView(credential);
  assert.equal(view.present, true);
  assert.equal(view.principal, credential.principal);
  const viewText = JSON.stringify(view);
  assert.ok(!viewText.includes(TOKEN_VALUE));
  assert.ok(!viewText.includes(RAW_ID));
  assert.ok(!viewText.includes('19900000000'));
  assert.ok(!viewText.includes('FixtureUser'));
});

test('resolve: honors credentials file with {lobster:{dbFile}} settings and config.path()', async () => {
  const dir = await scratch();
  const dbPath = await makeFixtureDb(dir);
  const settingsPath = join(dir, 'lobster-settings.json');
  await writeFile(settingsPath, JSON.stringify({lobster: {dbFile: dbPath}}));
  const credential = await lobsterResolve({credentials: {file: 'lobster-settings.local.json'}}, {path: () => settingsPath});
  assert.equal(credential.accessToken, TOKEN_VALUE);
});

test('resolve: missing settings file -> 401 credential_file_unavailable', async () => {
  await assert.rejects(() => lobsterResolve({credentials: {file: 'C:/nope/settings.json'}}, {}), e => e.status === 401 && e.code === 'lobster_credential_file_unavailable');
});

test('resolve: DB present but not logged in -> 401 credential_missing', async () => {
  const dir = await scratch();
  const dbPath = await makeFixtureDb(dir, {token: ''});
  await assert.rejects(() => lobsterResolve({credentials: {file: dbPath}}, {}), e => e.status === 401 && e.code === 'lobster_credential_missing');
});

test('lobsterProvider export: full unified surface', () => {
  for (const fn of ['resolve', 'models', 'health', 'status', 'claim', 'chat']) assert.equal(typeof lobsterProvider[fn], 'function', fn);
});

// ------------------------------------------------------------------ transport guards

test('lobsterFetch: fixed origin + allow-listed paths only', async () => {
  const spy = async () => { throw new Error('must not be called'); };
  for (const url of [
    'https://evil.example/api/models/available',
    `${LOBSTER_SERVER_ORIGIN}/api/other`,
    `${LOBSTER_SERVER_ORIGIN}/api/client-activities/x/actions/delete_everything`,
    `${LOBSTER_SERVER_ORIGIN}/api/client-activities/${'x'.repeat(200)}/context?configRevision=1`,
  ]) {
    await assert.rejects(() => lobsterFetch(spy, url, {}), e => e.code === 'lobster_endpoint_invalid', url);
  }
  // Whitelisted shapes pass the guard (network still never reached thanks to the spy contract below).
  let reached = null;
  const fetchImpl = async (url) => { reached = String(url); return jsonResponse({code: 0, data: []}); };
  await lobsterFetch(fetchImpl, `${LOBSTER_SERVER_ORIGIN}/api/client-activities/a-b.c_d/actions/check_in`, {method: 'POST'});
  assert.ok(reached.includes('/actions/check_in'));
});

test('lobsterFetch: requires injected fetchImpl; timeout/abort surfaces as 499', async () => {
  await assert.rejects(() => lobsterFetch(undefined, `${LOBSTER_SERVER_ORIGIN}/api/models/available`, {}), e => e.code === 'lobster_fetch_not_injected');
  const aborting = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(() => lobsterFetch(aborting, `${LOBSTER_SERVER_ORIGIN}/api/models/available`, {}), e => e.status === 499 && e.code === 'request_cancelled');
});

test('transport: HTTP 401 -> lobster_auth_failed with status preserved; 403 same; 500 -> upstream_error', async () => {
  for (const [status, code] of [[401, 'lobster_auth_failed'], [403, 'lobster_auth_failed'], [500, 'lobster_upstream_error']]) {
    const fetchImpl = async () => new Response('', {status});
    await assert.rejects(() => lobsterModels(SECRET_CRED, {fetchImpl}), e => e.status === status && e.code === code);
  }
});

// ------------------------------------------------------------------ models

test('models: official context kept; configured output flagged (no fake official claims)', async () => {
  const fetchImpl = async () => jsonResponse({code: 0, data: modelsFixture});
  const models = await lobsterModels(SECRET_CRED, {fetchImpl});
  assert.equal(models.length, 3);
  const flash = models.find(m => m.id === 'deepseek-flash');
  assert.equal(flash.contextWindow, 1000000);
  assert.equal(flash.maxTokens, 65536);
  assert.equal(flash.maxTokensSource, 'configured_default');
  assert.equal(flash.officialMaxTokens, null);
  assert.equal(flash.callable, true);
  assert.equal(flash.tools, true); // supportsToolCalling null upstream -> not claimed
  assert.equal(flash.toolsField, 'live_verified');
  assert.deepEqual(flash.reasoningOptions, ['off', 'high', 'max']);
  assert.equal(flash.multimodal, true);
});

test('models: unknown capacity -> callable false; restricted -> not callable', async () => {
  const fetchImpl = async () => jsonResponse({code: 0, data: modelsFixture});
  const models = await lobsterModels(SECRET_CRED, {fetchImpl});
  const mystery = models.find(m => m.id === 'mystery-model');
  assert.equal(mystery.contextWindow, null);
  assert.equal(mystery.callable, false);
  assert.equal(mystery.callableReason, 'context_window_unknown');
  const restricted = models.find(m => m.id === 'restricted-model');
  assert.equal(restricted.callable, false);
  assert.equal(restricted.callableReason, 'upstream_restricted');
});

test('models: rejects without token or fetch, and schema errors are explicit', async () => {
  await assert.rejects(() => lobsterModels({}, {fetchImpl: async () => jsonResponse({})}), e => e.code === 'lobster_credential_missing');
  await assert.rejects(() => lobsterModels(SECRET_CRED, {fetchImpl:null}), e => e.code === 'lobster_fetch_not_injected');
  await assert.rejects(() => lobsterModels(SECRET_CRED, {fetchImpl: async () => jsonResponse({code: 0, data: {not: 'a list'}})}), e => e.code === 'lobster_catalog_schema');
});

// ------------------------------------------------------------------ balance

test('balance: quota + profile parts, sum correct, free row not double counted', async () => {
  const fetchImpl = async url => jsonResponse(String(url).includes('/quota') ? quotaFixture : profileFixture);
  const balance = await lobsterBalance(SECRET_CRED, {fetchImpl});
  assert.equal(balance.unit, 'points');
  assert.equal(balance.value, 399.9739); // 299.9739 free + 100 campaign (free row from profile skipped)
  assert.equal(balance.parts.length, 2);
  assert.equal(balance.parts.find(p => p.kind === 'free').value, 299.9739);
  assert.equal(balance.parts.find(p => p.kind === 'campaign').value, 100);
  assert.ok(balance.note.includes('quota/profile-summary'));
  assert.equal(balance.checkedIn, null); // health fills this; balance alone must not guess
});

test('balance: quota 403 + profile ok -> partial data, quota error exposed, no estimate', async () => {
  const fetchImpl = async url => String(url).includes('/quota') ? new Response('', {status: 403}) : jsonResponse(profileFixture);
  const balance = await lobsterBalance(SECRET_CRED, {fetchImpl});
  assert.equal(balance.value, 100); // only campaign part; nothing invented for the 403 quota
  assert.equal(balance.errors.quota.status, 403);
  assert.equal(balance.errors.profileSummary, null);
});

test('balance: both upstreams down -> value null, never an estimate', async () => {
  const fetchImpl = async () => new Response('', {status: 500});
  const balance = await lobsterBalance(SECRET_CRED, {fetchImpl});
  assert.equal(balance.value, null);
  assert.ok(balance.errors.quota && balance.errors.profileSummary);
});

// ------------------------------------------------------------------ status / claim

test('status: real claimedToday=true state -> claimed, not claimable, no POST', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method ?? 'GET'});
    if (String(url).includes('/slot')) return jsonResponse(slotFixture);
    return jsonResponse(contextFixture(true));
  };
  const status = await lobsterStatus(SECRET_CRED, 'daily-checkin', {fetchImpl});
  assert.equal(status.known, true);
  assert.equal(status.claimed, true);
  assert.equal(status.claimable, false);
  assert.equal(status.activityCode, 'daily-check-in-evergreen-prod-20260814'); // discovered from slot, not hard-coded
  assert.equal(status.claimedDays, 1);
  assert.equal(status.rewardCredits, 100);
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('status: not yet claimed today -> claimable true when action offered', async () => {
  const fetchImpl = async url => jsonResponse(String(url).includes('/slot') ? slotFixture : contextFixture(false));
  const status = await lobsterStatus(SECRET_CRED, 'daily-checkin', {fetchImpl});
  assert.equal(status.claimed, false);
  assert.equal(status.claimable, true);
});

test('status: unknown task rejected', async () => {
  await assert.rejects(() => lobsterStatus(SECRET_CRED, 'weekly-whatever', {fetchImpl: async () => jsonResponse({})}), e => e.status === 400 && e.code === 'lobster_task_unknown');
});

test('claim: already claimed today -> no POST at all (never re-claims)', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method ?? 'GET'});
    if (String(url).includes('/slot')) return jsonResponse(slotFixture);
    return jsonResponse(contextFixture(true));
  };
  const result = await lobsterClaimCheckin(SECRET_CRED, 'daily-checkin', {fetchImpl});
  assert.equal(result.submitted, false);
  assert.equal(result.alreadyClaimed, true);
  assert.ok(calls.every(c => c.method === 'GET'), 'no POST may be issued for an already-claimed day');
});

test('claim: claimable but server offers no action -> no POST', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method ?? 'GET');
    if (String(url).includes('/slot')) return jsonResponse(slotFixture);
    const ctx = contextFixture(false);
    ctx.data.actions = []; // server withholds the action
    return jsonResponse(ctx);
  };
  const result = await lobsterClaimCheckin(SECRET_CRED, 'daily-checkin', {fetchImpl});
  assert.equal(result.submitted, false);
  assert.equal(result.reason, 'not_claimable');
  assert.ok(calls.every(m => m === 'GET'));
});

test('claim: submits to whitelisted action, then proves via context re-read (no blind 200 success)', async () => {
  const posts = [];
  let contextCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/slot')) return jsonResponse(slotFixture);
    if ((init.method ?? 'GET') === 'POST') {
      posts.push({url: u, body: JSON.parse(init.body)});
      return jsonResponse({code: 0, data: {success: true}});
    }
    contextCalls += 1;
    return jsonResponse(contextFixture(contextCalls >= 2)); // before: false, recheck: true
  };
  const result = await lobsterClaimCheckin(SECRET_CRED, 'daily-checkin', {fetchImpl});
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/api/client-activities/daily-check-in-evergreen-prod-20260814/actions/check_in'));
  assert.equal(posts[0].body.configRevision, 1);
  assert.equal(posts[0].body.payload && typeof posts[0].body.payload === 'object', true);
  assert.equal(typeof posts[0].body.idempotencyKey, 'string');
  assert.equal(result.submitted, true);
  assert.equal(result.rechecked, true);
  assert.equal(result.claimed, true);
});

test('claim: business 51104 already-claimed race + context confirms -> success with recorded note', async () => {
  let contextCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/slot')) return jsonResponse(slotFixture);
    if ((init.method ?? 'GET') === 'POST') return jsonResponse({code: 51104, message: 'already claimed'});
    contextCalls += 1;
    return jsonResponse(contextFixture(contextCalls >= 2));
  };
  const result = await lobsterClaimCheckin(SECRET_CRED, 'daily-checkin', {fetchImpl});
  assert.equal(result.claimed, true);
  assert.equal(result.submitted, true);
  assert.equal(result.submittedWithError.upstreamCode, 51104);
});

test('claim: POST 200 but context unchanged -> lobster_claim_unconfirmed (no false success)', async () => {
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/slot')) return jsonResponse(slotFixture);
    if ((init.method ?? 'GET') === 'POST') return jsonResponse({code: 0, data: {success: true}});
    return jsonResponse(contextFixture(false));
  };
  await assert.rejects(() => lobsterClaimCheckin(SECRET_CRED, 'daily-checkin', {fetchImpl}), e => e.code === 'lobster_claim_unconfirmed');
});

test('claim: server actionId outside whitelist is never submitted', async () => {
  // The whitelist is enforced at both the path guard and the call site: a hostile/path-injected action fails the guard.
  const spy = async () => { throw new Error('must not be called'); };
  await assert.rejects(() => lobsterFetch(spy, `${LOBSTER_SERVER_ORIGIN}/api/client-activities/x/actions/wire_transfer`, {method: 'POST'}), e => e.code === 'lobster_endpoint_invalid');
});

// ------------------------------------------------------------------ health

test('health: full shape {balance{value,unit,parts,note,checkedIn},capabilities,status}', async () => {
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('/slot')) return jsonResponse(slotFixture);
    if (u.includes('/context')) return jsonResponse(contextFixture(true));
    if (u.includes('/quota')) return jsonResponse(quotaFixture);
    return jsonResponse(profileFixture);
  };
  const health = await lobsterHealth(SECRET_CRED, {fetchImpl});
  assert.equal(health.status, 'authenticated');
  assert.equal(health.balance.value, 399.9739);
  assert.equal(health.balance.unit, 'points');
  assert.ok(Array.isArray(health.balance.parts));
  assert.equal(typeof health.balance.note, 'string');
  assert.equal(health.balance.checkedIn, true);
  assert.deepEqual(health.capabilities, {checkin: true, inference: true});
  assert.equal(health.checkin.claimed, true);
  assert.equal(health.checkin.claimable, false);
  assert.equal(health.checkin.supported, true);
});

test('health: balance 403 does NOT invalidate a successful check-in read (independent tolerance)', async () => {
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('/quota') || u.includes('/profile-summary')) return new Response('', {status: 403});
    if (u.includes('/slot')) return jsonResponse(slotFixture);
    return jsonResponse(contextFixture(true));
  };
  const health = await lobsterHealth(SECRET_CRED, {fetchImpl});
  assert.equal(health.status, 'authenticated'); // check-in proof survives the balance failure
  assert.equal(health.balance.value, null);
  assert.equal(health.balance.errors.quota.status, 403);
  assert.equal(health.checkin.known, true);
  assert.equal(health.checkin.claimed, true);
  assert.equal(health.balance.checkedIn, true);
});

test('health: check-in read failure does NOT invalidate real balance', async () => {
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('/slot')) return new Response('', {status: 500});
    if (u.includes('/quota')) return jsonResponse(quotaFixture);
    return jsonResponse(profileFixture);
  };
  const health = await lobsterHealth(SECRET_CRED, {fetchImpl});
  assert.equal(health.status, 'authenticated');
  assert.equal(health.balance.value, 399.9739);
  assert.equal(health.balance.checkedIn, null);
  assert.equal(health.checkin.known, false);
  assert.ok(health.checkin.error);
  assert.equal(health.capabilities.checkin, true); // capability is about the SDK surface, not today's read
});

test('health: both surfaces down -> status unknown, nothing fabricated', async () => {
  const fetchImpl = async () => new Response('', {status: 503});
  const health = await lobsterHealth(SECRET_CRED, {fetchImpl});
  assert.equal(health.status, 'unknown');
  assert.equal(health.balance.value, null);
  assert.equal(health.balance.checkedIn, null);
  assert.equal(health.checkin.claimed, false);
});

// ------------------------------------------------------------------ chat / SSE

test('sseErrorOf: event:error payload -> AppError with mapped status; plain data -> null', () => {
  const err = sseErrorOf('event:error\ndata: {"error":{"code":40100,"message":"登录已过期"}}');
  assert.equal(err.status, 401);
  assert.equal(err.code, 'lobster_stream_upstream_error');
  assert.equal(err.upstreamCode, 40100);
  assert.equal(sseErrorOf('data: {"choices":[{"delta":{"content":"hi"}}]}'), null);
  assert.equal(sseErrorOf('data: [DONE]'), null);
  const limit = sseErrorOf('data: {"error":{"code":42900,"message":"rate limited"}}');
  assert.equal(limit.status, 429);
});

test('transformSse: passes records through, appends [DONE] when upstream omits it, keeps reasoning deltas incremental', async () => {
  const upstream = sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"step1 "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"step2"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好的"}}],"usage":{"completion_tokens":3}}\n\n',
  ]);
  const wrapped = transformSse(upstream.body);
  const text = await wrapped.text();
  assert.ok(text.includes('"reasoning_content":"step1 "'));
  assert.ok(text.includes('"reasoning_content":"step2"')); // delivered verbatim, consumer concatenates
  assert.ok(text.includes('"content":"好的"'));
  assert.ok(text.includes('data: [DONE]'));
});

test('transformSse: event:error inside the stream errors the transformed Response', async () => {
  const upstream = sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'event: error\ndata: {"error":{"code":42900,"message":"too many"}}\n\n']);
  const wrapped = transformSse(upstream.body);
  await assert.rejects(() => wrapped.text(), e => e.code === 'lobster_stream_upstream_error' && e.status === 429);
});

test('transformSse: long output stream is bounded (byte cap enforced)', async () => {
  const upstream = boundedSse('data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 5000); // ~220 KB > 64 KiB cap
  const wrapped = transformSse(upstream.body, undefined, {maxBytes: 64 * 1024, maxRecords: 100000});
  await assert.rejects(() => wrapped.text(), e => e.code === 'lobster_stream_too_large');
});

test('transformSse: record-count cap enforced independently of bytes', async () => {
  const records = Array.from({length: 50}, () => 'data: {"choices":[{"delta":{"content":"y"}}]}\n\n').join('');
  const upstream = boundedSse(records, 4);
  const wrapped = transformSse(upstream.body, undefined, {maxBytes: 10 * 1024 * 1024, maxRecords: 40});
  await assert.rejects(() => wrapped.text(), e => e.code === 'lobster_stream_too_large');
});

test('chat: tool definitions pass through unchanged for live validation',async()=>{
 let seen;const tools=[{type:'function',function:{name:'fixture',parameters:{type:'object',properties:{}}}}];
 const {response}=await lobsterChat(null,SECRET_CRED,{model:'deepseek-flash',messages:[],tools,stream:true},undefined,{fetchImpl:async(u,o)=>{seen=JSON.parse(o.body);return new Response('data: [DONE]\n\n');}});
 await response.text();assert.deepEqual(seen.tools,tools);
});

test('desktopCompletionLimit: cap is a ceiling, fallback is only the no-budget default', () => {
  assert.equal(desktopCompletionLimit({}, 65536, 4096), 4096);
  assert.equal(desktopCompletionLimit({max_tokens: 65536}, 65536, 4096), 65536);
  assert.equal(desktopCompletionLimit({max_completion_tokens: 32768}, 65536, 4096), 32768);
  assert.equal(desktopCompletionLimit({}, 4096), 4096); // two-argument callers keep the old contract
  assert.throws(() => desktopCompletionLimit({max_tokens: 65537}, 65536, 4096), e => e.code === 'max_tokens_invalid' && e.status === 400);
  assert.throws(() => desktopCompletionLimit({max_tokens: 4097}, 4096), e => e.code === 'max_tokens_invalid');
  assert.throws(() => desktopCompletionLimit({max_tokens: 8, max_completion_tokens: 9}, 65536, 4096), e => e.code === 'max_tokens_conflict');
});

test('chat: an explicit 65536 budget reaches the wire instead of failing the gateway cap', async () => {
  let sent;
  const {response} = await lobsterChat(null, SECRET_CRED, {model: 'deepseek-flash', messages: [{role: 'user', content: 'x'}], max_tokens: 65536}, undefined,
    {fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return new Response('data: [DONE]\n\n'); }});
  await response.text();
  assert.equal(sent.max_tokens, 65536);
  let defaulted;
  const again = await lobsterChat(null, SECRET_CRED, {model: 'deepseek-flash', messages: [{role: 'user', content: 'x'}]}, undefined,
    {fetchImpl: async (url, init) => { defaulted = JSON.parse(init.body); return new Response('data: [DONE]\n\n'); }});
  await again.response.text();
  assert.equal(defaulted.max_tokens, 4096, 'no budget supplied must keep the conservative default');
});

test('chat: missing model and missing fetch are rejected before any network', async () => {
  await assert.rejects(() => lobsterChat(null, SECRET_CRED, {messages: []}, undefined, {fetchImpl: async () => jsonResponse({})}), e => e.code === 'lobster_chat_invalid');
  await assert.rejects(() => lobsterChat(null, {}, {model: 'deepseek-flash', messages: []}, undefined, {}), e => e.code === 'lobster_credential_missing');
});

test('chat: streams bounded SSE, upstream always-streamed body normalized; HTTP 403 -> auth_failed', async () => {
  let seenBody = null;
  const fetchImpl = async (url, init) => {
    seenBody = JSON.parse(init.body);
    return sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']);
  };
  const {response} = await lobsterChat(null, SECRET_CRED, {model: 'deepseek-flash', messages: [{role: 'user', content: 'x'}], stream: false}, undefined, {fetchImpl});
  assert.equal(seenBody.stream, true); // upstream demands SSE: stream forced on
  assert.equal(seenBody.model, 'deepseek-flash');
  const text = await response.text();
  assert.ok(text.includes('"content":"hi"'));
  const auth = async () => new Response('', {status: 403});
  await assert.rejects(() => lobsterChat(null, SECRET_CRED, {model: 'deepseek-flash', messages: []}, undefined, {fetchImpl: auth}), e => e.status === 403 && e.code === 'lobster_auth_failed');
});

// ------------------------------------------------------------------ secret hygiene

test('secret hygiene: upstream message echoing the token is redacted in surfaced errors', async () => {
  // resolve() registers the token with the global redactor; simulate an upstream message that echoes it.
  const dir = await scratch();
  const dbPath = await makeFixtureDb(dir);
  const credential = await lobsterResolve({credentials: {file: dbPath}}, {});
  const fetchImpl = async () => jsonResponse({code: 9, message: `bad token ${credential.accessToken} rejected`});
  // balance() tolerates upstream failure by design: the failing read lands in balance.errors, redacted.
  const balance = await lobsterBalance(credential, {fetchImpl});
  assert.equal(balance.value, null);
  assert.ok(balance.errors.quota, 'quota failure must be recorded, not swallowed silently');
  const surfaced = JSON.stringify(balance.errors);
  assert.ok(!surfaced.includes(credential.accessToken), 'token must never appear in surfaced errors');
  // The direct path (models) must reject with a redacted message too.
  await assert.rejects(() => lobsterModels(credential, {fetchImpl}), e => !e.message.includes(credential.accessToken));
});

test('reasoning mapping uses real native levels, exact names first, never invents ultra',async()=>{
 const {lobsterReasoningMapping}=await import('../src/provider-lobster.mjs');
 assert.deepEqual(lobsterReasoningMapping(['off','high','max']),{none:'off',off:'off',minimal:'high',low:'high',medium:'high',high:'high',xhigh:'max',max:'max'});
 const precise=lobsterReasoningMapping(['off','low','medium','high','max']);assert.equal(precise.low,'low');assert.equal(precise.medium,'medium');assert.equal(precise.minimal,'low');assert.equal(precise.ultra,undefined);
 assert.deepEqual(lobsterReasoningMapping(['off']),{none:'off',off:'off'});
});

test('reasoning metadata and real request medium share the same official-options mapping',async()=>{
 const models=await lobsterModels(SECRET_CRED,{fetchImpl:async()=>jsonResponse({code:0,data:modelsFixture})});
 const flash=models.find(m=>m.id==='deepseek-flash');assert.equal(flash.reasoning,null);assert.equal(flash.reasoningDefault,'high');assert.equal(flash.reasoningEffortMapping.medium,'high');assert.equal(flash.reasoningMappingSource,'gateway_aliases_of_official_options');
 for(const [requested,expected]of Object.entries({minimal:'high',low:'high',medium:'high',none:'off',xhigh:'max'})){
  let body;const {response}=await lobsterChat(null,SECRET_CRED,{model:'deepseek-flash',messages:[{role:'user',content:'fixture'}],reasoning_effort:requested,stream:false},undefined,{fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);}});
  assert.equal((await response.json()).choices[0].message.content,'ok');assert.equal(body.lobsterai_options.thinking.level,expected);assert.equal('reasoning_effort' in body,false);
 }
});

test('explicit native options win; unknown generic effort is rejected before request',async()=>{
 let calls=0,body;const fetchImpl=async(u,o)=>{calls++;body=JSON.parse(o.body);return sseResponse(['data: [DONE]\n\n']);};
 await assert.rejects(lobsterChat(null,SECRET_CRED,{model:'deepseek-flash',messages:[],reasoning_effort:'ultra'},undefined,{fetchImpl}),{code:'lobster_reasoning_invalid'});assert.equal(calls,0);
 const options={version:1,thinking:{level:'off'}};const {response}=await lobsterChat(null,SECRET_CRED,{model:'deepseek-flash',messages:[],reasoning_effort:'medium',lobsterai_options:options},undefined,{fetchImpl});await response.text();assert.deepEqual(body.lobsterai_options,options);assert.equal('reasoning_effort' in body,false);assert.equal(calls,1);
});

test('nullable reasoning effort is omitted, keeps product default off, and preserves explicit native options',async()=>{
 for(const testCase of [
  {model:'deepseek-flash',effort:null,expected:'off'},
  {model:'deepseek-flash',effort:undefined,expected:'off'},
  {model:'deepseek-flash',effort:null,native:{version:1,thinking:{level:'high'}},expected:'high'},
  {model:'fixture-without-profile',effort:null,expected:undefined},
 ]){
  let body,calls=0;
  const {response}=await lobsterChat(null,SECRET_CRED,{model:testCase.model,messages:[{role:'user',content:'fixture'}],reasoning_effort:testCase.effort,...(testCase.native?{lobsterai_options:testCase.native}:{})},undefined,{fetchImpl:async(u,o)=>{calls++;body=JSON.parse(o.body);return sseResponse(['data: [DONE]\n\n']);}});
  await response.text();assert.equal(calls,1,'null does not trigger a catalog lookup');assert.equal('reasoning_effort' in body,false);assert.equal(body.lobsterai_options?.thinking?.level,testCase.expected);
 }
});
