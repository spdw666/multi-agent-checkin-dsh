import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = process.env.GATEWAY_FEATURE_TEST_ROOT || process.env.CHECKIN_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url));
const {checkTarget, runClientUpdateCheck, cancelClientUpdateCheck, clientUpdatesReport, clientUpdateDue} =
  await import(pathToFileURL(resolve(root, 'src/client-updates.mjs')));
const install = await mkdtemp(join(tmpdir(), 'gateway-update-v3-'));
await writeFile(join(install, 'version.json'), JSON.stringify({version: '1.0.0'}));
after(() => rm(install, {recursive: true, force: true}));
const start = Date.parse('2026-10-23T00:00:00.000Z');
const target = (id = 'sample', latest = {type: 'feed', url: `https://update.test/${id}`}) => ({
  id, name: id, platform: id, install, version: {type: 'json', file: 'version.json', field: 'version'}, latest
});
const response = (version = '1.1.0') => new Response(`version: ${version}\n`);
const immediate = {now: () => start, random: () => 0, sleep: async () => {}};
const service = (rows = [], config = {}) => {
  const data = new Map(rows.length ? [['client-updates', {status: 'ok', checkedAt: new Date(start).toISOString(), targets: rows}]] : []);
  const history = [];
  return {config: {value: {clientUpdates: config}}, history,
    ledger: {get: key => data.get(key), set: (key, value) => {data.set(key, value); history.push(structuredClone(value));}}};
};
const oldSuccess = (id = 'sample') => ({id, status: 'current', latest: '1.0.0',
  sourceUrl: `https://update.test/${id}/latest.yml`, checkedAt: new Date(start - 10000).toISOString()});
const oldFailure = (id = 'sample', failures = 1) => ({id, status: 'error', retryable: true,
  consecutiveFailures: failures, checkedAt: new Date(start).toISOString(), retryDueAt: new Date(start + 5 * 60000).toISOString()});
const deferred = () => {let resolve; return {promise: new Promise(done => {resolve = done;}), resolve: value => resolve(value)};};
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('fixture progress did not arrive');
}

test('V3-UPDATES timeout has Chinese label, exact source and two jittered retries', async () => {
  let calls = 0; const delays = [];
  const row = await checkTarget(target(), {}, {...immediate, random: () => 0.5, sleep: async ms => delays.push(ms),
    fetchImpl: async () => {calls++; throw new DOMException('timed out', 'TimeoutError');}});
  assert.equal(calls, 3); assert.deepEqual(delays, [282, 563]);
  assert.equal(row.status, 'error'); assert.equal(row.errorCode, 'update_timeout'); assert.equal(row.errorLabel, '检查超时');
  assert.equal(row.sourceUrl, 'https://update.test/sample/latest.yml'); assert.equal(row.source, 'electron_updater_feed');
  assert.equal(row.attemptCount, 3); assert.equal(row.retryCount, 2); assert.equal(row.retryable, true);
});

for (const status of [408, 425, 429, 500, 502, 503, 504]) test(`V3-UPDATES transient HTTP ${status} recovers without changing the version comparison`, async () => {
  let calls = 0;
  const row = await checkTarget(target(), {}, {...immediate, fetchImpl: async () => ++calls === 1 ? new Response('', {status}) : response()});
  assert.equal(calls, 2); assert.equal(row.status, 'update_available'); assert.equal(row.latest, '1.1.0');
  assert.equal(row.errorCode, ''); assert.equal(row.errorDetails, ''); assert.equal(row.retryCount, 1);
});

for (const status of [400, 401, 403, 404]) test(`V3-UPDATES permanent HTTP ${status} is typed and not immediately retried`, async () => {
  let calls = 0;
  const row = await checkTarget(target(), {}, {...immediate, fetchImpl: async () => {calls++; return new Response('', {status});}});
  assert.equal(calls, 1); assert.equal(row.errorCode, `update_http_${status}`); assert.equal(row.errorLabel, `更新源 HTTP ${status}`);
  assert.equal(row.retryable, false); assert.equal(row.retryDueAt, new Date(start + 3600000).toISOString());
});

test('V3-UPDATES malformed JSON is a source-format error and never retried', async () => {
  let calls = 0;
  const row = await checkTarget(target('json', {type: 'json', url: 'https://update.test/version'}), {}, {...immediate,
    fetchImpl: async () => {calls++; return new Response('{broken');}});
  assert.equal(calls, 1); assert.equal(row.errorCode, 'update_format_changed'); assert.equal(row.errorLabel, '更新源格式变化');
  assert.ok(row.errorDetails); assert.equal(row.sourceUrl, 'https://update.test/version');
});

test('V3-UPDATES absent version field is not mistaken for a successful empty version', async () => {
  let calls = 0;
  const row = await checkTarget(target(), {}, {...immediate, fetchImpl: async () => {calls++; return new Response('files: []');}});
  assert.equal(calls, 1); assert.equal(row.errorCode, 'update_format_changed'); assert.equal(row.lastSuccessAt, null);
});

test('V3-UPDATES network errors retain the cause class and retry only twice', async () => {
  let calls = 0;
  const row = await checkTarget(target(), {}, {...immediate, fetchImpl: async () => {
    calls++; throw new TypeError('fetch failed', {cause: Object.assign(new Error('socket'), {code: 'ECONNRESET'})});
  }});
  assert.equal(calls, 3); assert.equal(row.errorCode, 'update_network_error'); assert.equal(row.retryable, true);
});

test('V3-UPDATES certificate failures do not trigger network retry', async () => {
  let calls = 0;
  const row = await checkTarget(target(), {}, {...immediate, fetchImpl: async () => {
    calls++; throw new TypeError('fetch failed', {cause: Object.assign(new Error('certificate'), {code: 'CERT_HAS_EXPIRED'})});
  }});
  assert.equal(calls, 1); assert.equal(row.errorCode, 'update_tls_error'); assert.equal(row.retryable, false);
});

test('V3-UPDATES source URL remains available for genie failures', async () => {
  const row = await checkTarget(target('genie', {type: 'genie', base: 'https://update.test', platform: 'windows'}), {},
    {...immediate, fetchImpl: async () => new Response('', {status: 403})});
  assert.equal(row.source, 'genie_update_api'); assert.match(row.sourceUrl, /platform=windows&version=1.0.0/);
});

test('V3-UPDATES Trae failure source excludes synthesized installation IDs', async () => {
  const row = await checkTarget(target('trae', {type: 'trae', url: 'https://update.test/trae', mid: 'fixture-mid', did: 'fixture-did'}), {},
    {...immediate, fetchImpl: async () => new Response('', {status: 403})});
  assert.equal(row.source, 'trae_update_api'); assert.equal(row.sourceUrl, 'https://update.test/trae');
});

test('V3-UPDATES success records fresh evidence and the next independent daily deadline', async () => {
  const row = await checkTarget(target(), {}, {...immediate, fetchImpl: async () => response()});
  assert.equal(row.lastSuccessAt, new Date(start).toISOString()); assert.equal(row.lastSuccessLatest, '1.1.0');
  assert.equal(row.stale, false); assert.equal(row.consecutiveFailures, 0); assert.equal(row.retryDueAt, null);
  assert.equal(row.nextCheckAt, new Date(start + 86400000).toISOString());
});

test('V3-UPDATES failure preserves last successful version but explicitly marks it stale', async () => {
  const previous = oldSuccess();
  const row = await checkTarget(target(), {}, {...immediate, previous, fetchImpl: async () => new Response('', {status: 403})});
  assert.equal(row.status, 'error'); assert.equal(row.latest, '1.0.0'); assert.equal(row.stale, true);
  assert.equal(row.lastSuccessAt, previous.checkedAt); assert.equal(row.lastSuccessSourceUrl, previous.sourceUrl);
  assert.equal(row.checkedAt, new Date(start).toISOString());
});

test('V3-UPDATES transient failure deadlines escalate by consecutive failed scans: 5, 15, 60 minutes', async () => {
  let previous;
  for (const [index, minutes] of [5, 15, 60, 60].entries()) {
    const row = await checkTarget(target(), {}, {...immediate, previous,
      fetchImpl: async () => {throw new DOMException('timeout', 'TimeoutError');}});
    assert.equal(row.consecutiveFailures, index + 1); assert.equal(row.retryDueAt, new Date(start + minutes * 60000).toISOString());
    previous = row;
  }
});

test('V3-UPDATES successful recovery resets stale status and consecutive failures', async () => {
  const previous = {...oldFailure(), lastSuccessAt: oldSuccess().checkedAt, lastSuccessLatest: '1.0.0', stale: true};
  const row = await checkTarget(target(), {}, {...immediate, previous, fetchImpl: async () => response('1.2.0')});
  assert.equal(row.stale, false); assert.equal(row.consecutiveFailures, 0); assert.equal(row.lastSuccessLatest, '1.2.0');
  assert.equal(row.retryDueAt, null); assert.equal(row.errorCode, '');
});

test('V3-UPDATES failed-only scan preserves successful targets byte-for-byte', async () => {
  const success = oldSuccess('good'), bad = oldFailure('bad'); const s = service([success, bad]); const calls = [];
  const report = await runClientUpdateCheck(s, {...immediate, targets: [target('good'), target('bad')], failedOnly: true,
    fetchImpl: async url => {calls.push(String(url)); return response();}});
  assert.deepEqual(calls, ['https://update.test/bad/latest.yml']); assert.equal(report.targets.length, 2);
  assert.deepEqual(report.targets[0], success); assert.equal(report.targets[1].status, 'update_available');
  assert.deepEqual(report.selectedTargetIds, ['bad']);
});

test('V3-UPDATES selected-target scan retains unselected rows and their timestamps', async () => {
  const a = oldSuccess('a'), b = oldSuccess('b'); const s = service([a, b]); const calls = [];
  const report = await runClientUpdateCheck(s, {...immediate, targets: [target('a'), target('b')], targetIds: ['b'],
    fetchImpl: async url => {calls.push(String(url)); return response('1.3.0');}});
  assert.equal(calls.length, 1); assert.deepEqual(report.targets[0], a); assert.equal(report.targets[1].latest, '1.3.0');
});

test('V3-UPDATES failed-only with no failures performs no reads and retains evidence', async () => {
  const a = oldSuccess(); const s = service([a]); let calls = 0;
  const report = await runClientUpdateCheck(s, {...immediate, targets: [target()], failedOnly: true,
    fetchImpl: async () => {calls++; return response();}});
  assert.equal(calls, 0); assert.deepEqual(report.targets, [a]); assert.equal(report.progress.total, 0);
});

test('V3-UPDATES empty targetIds is an explicit no-op selection, not an all-target scan', async () => {
  const s = service([oldSuccess()]); let calls = 0;
  const report = await runClientUpdateCheck(s, {...immediate, targets: [target()], targetIds: [], fetchImpl: async () => {calls++; return response();}});
  assert.equal(calls, 0); assert.equal(report.progress.total, 0);
});

test('V3-UPDATES unknown target ID fails before dispatch and leaves prior report intact', async () => {
  const s = service([oldSuccess()]); const before = structuredClone(s.ledger.get('client-updates'));
  await assert.rejects(runClientUpdateCheck(s, {...immediate, targets: [target()], targetIds: ['absent']}), /unknown client/);
  assert.deepEqual(s.ledger.get('client-updates'), before);
});

test('V3-UPDATES targetIds must be an array of nonempty strings', async () => {
  for (const ids of ['sample', [null], ['']]) await assert.rejects(runClientUpdateCheck(service(), {...immediate,
    targets: [target()], targetIds: ids}), /targetIds/);
});

test('V3-UPDATES running report persists independent completion before the slowest target finishes', async () => {
  const a = deferred(), b = deferred(), s = service(); let calls = 0;
  const pending = runClientUpdateCheck(s, {...immediate, targets: [target('a'), target('b')], fetchImpl: async url => {
    calls++; return String(url).includes('/a/') ? a.promise : b.promise;
  }});
  await until(() => calls === 2);
  assert.equal(s.ledger.get('client-updates').progress.running, 2);
  a.resolve(response('1.1.0')); await until(() => s.ledger.get('client-updates').progress.completed === 1);
  const interim = s.ledger.get('client-updates'); assert.equal(interim.status, 'running'); assert.equal(interim.progress.running, 1);
  assert.equal(interim.targets[0].latest, '1.1.0'); assert.equal(interim.targets[1].phase, 'checking');
  b.resolve(response('1.2.0')); const report = await pending;
  assert.deepEqual(report.progress, {total: 2, completed: 2, running: 0, queued: 0, retrying: 0});
  assert.equal(interim.status, 'running', 'persisted snapshots must not be mutated after writing');
});

test('V3-UPDATES backoff progress includes retry state and typed error', async () => {
  const s = service(); let calls = 0;
  await runClientUpdateCheck(s, {...immediate, targets: [target()], fetchImpl: async () => ++calls === 1 ? new Response('', {status: 503}) : response()});
  const retry = s.history.find(report => report.progress.retrying === 1);
  assert.ok(retry); assert.equal(retry.targets[0].errorLabel, '更新源 HTTP 503'); assert.equal(retry.targets[0].retryDelayMs, 250);
  const last = s.history.at(-1).targets[0]; assert.equal(last.errorCode, ''); assert.equal(last.phase, 'done');
});

test('V3-UPDATES force/manual and failed-only calls remain service-scoped single-flight', async () => {
  const gate = deferred(), s = service(); let calls = 0;
  const options = {...immediate, targets: [target()], fetchImpl: async () => {calls++; return gate.promise;}};
  const a = runClientUpdateCheck(s, options); await until(() => calls === 1);
  const b = runClientUpdateCheck(s, {...options, force: true, failedOnly: true});
  assert.equal(a, b); gate.resolve(response()); await a; assert.equal(calls, 1);
});

test('V3-UPDATES retry deadline, not the last batch timestamp, controls automatic due state', async () => {
  const s = service([oldSuccess('good'), oldFailure('bad')]);
  assert.equal(clientUpdateDue(s, start + 4 * 60000), false);
  assert.equal(clientUpdateDue(s, start + 5 * 60000), true);
  assert.equal(clientUpdatesReport(s).nextCheckAt, new Date(start + 5 * 60000).toISOString());
});

test('V3-UPDATES legacy persisted timeout errors gain a five-minute deadline without waiting a day', () => {
  const s = service([{id: 'sample', status: 'error', error: 'The operation was aborted due to timeout', checkedAt: new Date(start).toISOString()}]);
  assert.equal(clientUpdatesReport(s).nextCheckAt, new Date(start + 5 * 60000).toISOString());
  assert.equal(clientUpdateDue(s, start + 6 * 60000), true);
});

test('V3-UPDATES due-only scheduler scan skips fresh successful targets', async () => {
  const good = oldSuccess('good'); const s = service([good, oldFailure('bad')]); const calls = [];
  const report = await runClientUpdateCheck(s, {...immediate, now: () => start + 6 * 60000,
    dueOnly: true, targets: [target('good'), target('bad')], fetchImpl: async url => {calls.push(String(url)); return response();}});
  assert.equal(calls.length, 1); assert.match(calls[0], /bad/); assert.deepEqual(report.targets[0], good);
});

test('V3-UPDATES disabled configuration has no background deadline or network reads', async () => {
  const s = service([], {enabled: false}); let calls = 0;
  const report = await runClientUpdateCheck(s, {...immediate, targets: [target()], fetchImpl: async () => {calls++; return response();}});
  assert.equal(calls, 0); assert.equal(report.nextCheckAt, null); assert.equal(clientUpdateDue(s, start + 86400000), false);
});

test('V3-UPDATES changed successful interval recomputes from that target check, not stale nextCheckAt', () => {
  const s = service([{...oldSuccess(), checkedAt: new Date(start).toISOString(), nextCheckAt: new Date(start + 86400000).toISOString()}], {intervalHours: 6});
  assert.equal(clientUpdatesReport(s).nextCheckAt, new Date(start + 6 * 3600000).toISOString());
  assert.equal(clientUpdateDue(s, start + 7 * 3600000), true);
});

test('V3-UPDATES cancellation of backoff is immediate and dispatches no retry', async () => {
  const controller = new AbortController(); const s = service(); let calls = 0;
  const gate = deferred(); let sleeping = false;
  const pending = runClientUpdateCheck(s, {...immediate, signal: controller.signal, targets: [target()],
    sleep: () => {sleeping = true; return gate.promise;}, fetchImpl: async () => {calls++; return new Response('', {status: 503});}});
  await until(() => sleeping); controller.abort(); const report = await pending;
  assert.equal(calls, 1); assert.equal(report.status, 'cancelled'); assert.equal(report.targets[0].errorCode, 'update_cancelled');
  assert.equal(report.targets[0].retryDueAt, null); gate.resolve(); await turn(); assert.equal(calls, 1);
});

test('V3-UPDATES cancellation never dispatches queued targets or accepts late results', async () => {
  const s = service(), gate = deferred(); let calls = 0;
  const pending = runClientUpdateCheck(s, {...immediate, targets: Array.from({length: 6}, (_, index) => target(String(index))),
    fetchImpl: async () => {calls++; return gate.promise;}});
  await until(() => calls === 4); await cancelClientUpdateCheck(s); const report = await pending;
  assert.equal(report.status, 'cancelled'); assert.equal(calls, 4); assert.equal(report.targets.length, 6);
  assert.ok(report.targets.every(row => row.status === 'cancelled' && row.phase === 'done'));
  const before = JSON.stringify(s.ledger.get('client-updates')); gate.resolve(response()); await turn(); await turn();
  assert.equal(JSON.stringify(s.ledger.get('client-updates')), before);
});

test('V3-UPDATES missing local installation has explicit error but never fetches', async () => {
  let calls = 0;
  const row = await checkTarget({...target(), install: join(install, 'absent')}, {}, {...immediate,
    fetchImpl: async () => {calls++; return response();}});
  assert.equal(calls, 0); assert.equal(row.status, 'not_detected'); assert.equal(row.errorLabel, '未检测到客户端');
  assert.equal(row.sourceUrl, 'https://update.test/sample/latest.yml');
});

test('V3-UPDATES requested immediate retries remain bounded even when caller requests many', async () => {
  let calls = 0;
  const row = await checkTarget(target(), {}, {...immediate, maxRetries: 99,
    fetchImpl: async () => {calls++; return new Response('', {status: 503});}});
  assert.equal(calls, 3); assert.equal(row.retryCount, 2);
});
