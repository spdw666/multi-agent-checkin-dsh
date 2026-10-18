import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = process.env.GATEWAY_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url));
const updates = await import(pathToFileURL(resolve(root, 'src/client-updates.mjs')));
const {Scheduler} = await import(pathToFileURL(resolve(root, 'src/scheduler.mjs')));
const {readInstalledVersion, checkTarget, mergeTargets, fetchLatestVersion, compareVersions,
  clientUpdatesReport, runClientUpdateCheck, clientUpdateDue, DEFAULT_TARGETS} = updates;
const scratch = await mkdtemp(join(tmpdir(), 'SAMPLE-repair-client-updates-'));
after(() => rm(scratch, {recursive: true, force: true}));
const jsonVersion = {type: 'json', file: 'version.json', field: 'version'};
async function fixture(name, version = '1.0.0') {
  const install = join(scratch, name);
  await mkdir(install, {recursive: true});
  await writeFile(join(install, 'version.json'), JSON.stringify({version}));
  return install;
}
function service(clientUpdates = {}) {
  const rows = new Map();
  return {config: {value: {clientUpdates}}, ledger: {get: k => rows.get(k), set: (k, v) => rows.set(k, v)}};
}
function target(install, id = 'SAMPLE') {
  return {id, install, version: jsonVersion, latest: {type: 'feed', url: 'https://sample.test/' + id}};
}
const later = () => new Promise(resolve => setTimeout(resolve, 15));

test('control: normal genie display versions remain compatible with numeric channel builds', async () => {
  assert.equal(compareVersions('5.8.3', '5.8.3.41334564'), 'same');
  assert.equal(compareVersions('5.8.3.41334564', '5.8.3'), 'same');
  assert.equal(compareVersions('4.12.1', '4.12.2.41207131'), 'newer');
  const install = await fixture('ordinary');
  const row = await checkTarget(target(install), {enabled: true}, {fetchImpl: async () => new Response('version: 1.1.0\n')});
  assert.equal(row.status, 'update_available');
});

test('CLIENT-F1: Qoder chooses the newest manifest/ready directory, not the oldest', async () => {
  const install = await fixture('qoder');
  for (const version of ['0.4.8', '0.4.9']) {
    const resources = join(install, '.qoder-versions', version, 'resources');
    await mkdir(resources, {recursive: true});
    await writeFile(join(resources, 'build-manifest.json'), JSON.stringify({productVersion: version}));
    if (version === '0.4.9') await writeFile(join(install, '.qoder-versions', version + '.qoder-update-ready.json'), '{}');
  }
  const row = await readInstalledVersion({install, version: {type: 'qoderVersions'}});
  assert.equal(row.installed, '0.4.9');
  assert.equal(row.pendingRestart, true);
});

test('CLIENT-F2: a same-base final release upgrades an installed release candidate', async () => {
  const install = await fixture('dsh-rc', '0.2.1-rc.2');
  const row = await checkTarget(target(install), {enabled: true}, {fetchImpl: async () => new Response('version: 0.2.1\n')});
  assert.equal(row.status, 'update_available');
  assert.equal(compareVersions('0.2.1', '0.2.1-rc.2'), 'older');
});

test('CLIENT-F2: prerelease identifiers use numeric SemVer precedence and ignore metadata', () => {
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.10'), 'newer');
  assert.equal(compareVersions('0.2.1-rc.10', '0.2.1-rc.2'), 'older');
  assert.equal(compareVersions('1.2.3-beta', '1.2.3-rc.1'), 'newer');
  assert.equal(compareVersions('1.2.3+build.999', '1.2.3+build.1'), 'same');
});

test('CLIENT-F2 control: QwenWork numeric channel build matches its official display release', async () => {
  const install = await fixture('qwenwork-build', '1.3.1-26101419');
  const qwenwork = DEFAULT_TARGETS.find(t => t.id === 'qwenwork');
  const row = await checkTarget({...qwenwork, install, version: jsonVersion}, {enabled: true}, {
    fetchImpl: async () => new Response('update-description">千问办公 1.3.1')
  });
  assert.equal(row.installed, '1.3.1-26101419');
  assert.equal(row.latest, '1.3.1');
  assert.equal(row.status, 'current');
});

test('CLIENT-F2: QwenWork explicit build policy still upgrades a true rc prerelease', async () => {
  const install = await fixture('qwenwork-rc', '1.3.1-rc.2');
  const qwenwork = DEFAULT_TARGETS.find(t => t.id === 'qwenwork');
  const row = await checkTarget({...qwenwork, install, version: jsonVersion}, {enabled: true}, {
    fetchImpl: async () => new Response('update-description">千问办公 1.3.1')
  });
  assert.equal(row.status, 'update_available');
});

test('CLIENT-F2: an ordinary numeric SemVer prerelease is not globally treated as a build suffix', () => {
  assert.equal(compareVersions('1.3.1-26101419', '1.3.1'), 'newer');
  assert.equal(compareVersions('1.3.1', '1.3.1-26101419'), 'older');
});

test('CLIENT-F3: genie URL override retains required channel platform', async () => {
  const picked = mergeTargets({'workbuddy-cn': {latestType: 'genie', latestUrl: 'https://sample.test'}}).find(t => t.id === 'workbuddy-cn');
  let requested;
  await fetchLatestVersion(picked, {installed: '5.8.3', apiVersion: '5.8.3', fetchImpl: async url => {requested = new URL(url); return new Response(null, {status: 204});}});
  assert.equal(requested.origin, 'https://sample.test');
  assert.equal(requested.searchParams.get('platform'), 'workbuddy-win32-x64-user');
});

test('CLIENT-F3: github URL override is the endpoint, with the original tag prefix retained', async () => {
  const picked = mergeTargets({cline: {latestType: 'github', latestUrl: 'https://sample.test/releases/latest'}}).find(t => t.id === 'cline');
  let requested, authorization;
  const row = await fetchLatestVersion(picked, {fetchImpl: async (url, options) => {requested = String(url); authorization = options.headers.authorization; return new Response(JSON.stringify({tag_name: 'desktop-v1.2.3'}));}});
  assert.equal(requested, 'https://sample.test/releases/latest');
  assert.equal(authorization, undefined);
  assert.equal(row.latest, '1.2.3');
});

test('CLIENT-F3: a type change without its required channel fields fails before network dispatch', async () => {
  let calls = 0;
  await assert.rejects(async () => {
    const picked = mergeTargets({qoder: {latestType: 'genie', latestUrl: 'https://sample.test'}}).find(t => t.id === 'qoder');
    await fetchLatestVersion(picked, {fetchImpl: async () => {calls++; return new Response(null, {status: 204});}});
  }, /platform/i);
  assert.equal(calls, 0);
});

test('CLIENT-F3: same-type feed/json overrides retain latest file and selected JSON field', async () => {
  const picked = mergeTargets({dsh: {latestUrl: 'https://sample.test/dsh'}}).find(t => t.id === 'dsh');
  let requested;
  await fetchLatestVersion(picked, {fetchImpl: async url => {requested = String(url); return new Response('version: 1.2.3\n');}});
  assert.equal(requested, 'https://sample.test/dsh/nightly.yml');
  const json = mergeTargets({opencode: {latestType: 'json', latestUrl: 'https://sample.test/opencode', latestField: 'result.version'}}).find(t => t.id === 'opencode');
  const row = await fetchLatestVersion(json, {fetchImpl: async () => new Response(JSON.stringify({result: {version: '1.2.4'}}))});
  assert.equal(row.latest, '1.2.4');
});

test('CLIENT-F4: cached report reflects saved enabled/interval without erasing check evidence', () => {
  const prior = {status: 'ok', enabled: true, intervalHours: 24, checkedAt: '2026-10-17T00:00:00.000Z', targets: [{id: 'SAMPLE'}]};
  const s = service({enabled: false, intervalHours: 6});
  s.ledger.set('client-updates', prior);
  const report = clientUpdatesReport(s);
  assert.equal(report.enabled, false);
  assert.equal(report.intervalHours, 6);
  assert.equal(report.checkedAt, prior.checkedAt);
  assert.deepEqual(report.targets, prior.targets);
});

test('CLIENT-F5: a scan still running after 60 seconds remains single-flight, including force', async () => {
  const s = service({enabled: true, timeoutMs: 120000});
  const t = target(await fixture('single-flight'));
  let calls = 0, started;
  const begun = new Promise(resolve => started = resolve), pending = [];
  const fetchImpl = async () => {calls++; started(); return new Promise(resolve => pending.push(resolve));};
  const first = runClientUpdateCheck(s, {targets: [t], fetchImpl});
  await begun;
  const originalNow = Date.now, at = originalNow();
  let second, third, due;
  try {
    Date.now = () => at + 61000;
    due = clientUpdateDue(s);
    second = runClientUpdateCheck(s, {targets: [t], fetchImpl});
    third = runClientUpdateCheck(s, {force: true, targets: [t], fetchImpl});
    await later();
  } finally {
    Date.now = originalNow;
    for (const release of pending) release(new Response('version: 1.1.0\n'));
    await Promise.all([first, second, third]);
  }
  assert.equal(calls, 1);
  assert.equal(due, false);
});

test('CLIENT-F5: a stale persisted running record after process restart does not suppress a new scan', async () => {
  const s = service();
  s.ledger.set('client-updates', {status: 'running', startedAt: new Date().toISOString()});
  let calls = 0;
  const row = await runClientUpdateCheck(s, {targets: [target(await fixture('stale-record'))], fetchImpl: async () => {calls++; return new Response('version: 1.1.0\n');}});
  assert.equal(calls, 1);
  assert.equal(row.status, 'ok');
});

test('CLIENT-F6: scheduler stop aborts active requests immediately and never starts queued targets', async () => {
  const install = await fixture('stop');
  const targets = Array.from({length: 5}, (_, i) => target(install, 'sample-' + i));
  const previous = DEFAULT_TARGETS.slice(), realFetch = globalThis.fetch;
  const s = service();
  s.config.value.scheduler = {enabled: false, startup: false};
  s.config.value.accounts = [];
  const scheduler = new Scheduler(s.config, {all: async () => {throw new Error('unexpected claims');}}, s.ledger);
  scheduler.service = s; scheduler.stopped = false;
  let calls = 0, started;
  const firstFour = new Promise(resolve => started = resolve), pending = [], signals = [];
  try {
    DEFAULT_TARGETS.splice(0, DEFAULT_TARGETS.length, ...targets);
    globalThis.fetch = async (_url, options) => {
      calls++; signals.push(options.signal);
      if (calls === 4) started();
      if (calls > 4) return new Response('version: 1.1.0\n');
      // Deliberately ignores abort: shutdown must stop awaiting a non-cooperative fetch.
      return new Promise(resolve => pending.push(resolve));
    };
    await scheduler.tick(); await firstFour;
    const stopping = scheduler.stop();
    const immediatelyAborted = signals.filter(signal => signal.aborted).length;
    const settled = await Promise.race([stopping.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    for (const release of pending) release(new Response('version: 1.1.0\n'));
    await stopping;
    assert.equal(immediatelyAborted, 4);
    assert.equal(calls, 4);
    assert.equal(settled, true, 'shutdown must not wait for the configured network timeout or the next batch');
  } finally {
    DEFAULT_TARGETS.splice(0, DEFAULT_TARGETS.length, ...previous); globalThis.fetch = realFetch;
    for (const release of pending) release(new Response('version: 1.1.0\n'));
    await scheduler.stop();
  }
});

test('CLIENT-F6: direct manual scan supports already-aborted signals without dispatch', async () => {
  const s = service();
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const row = await runClientUpdateCheck(s, {targets: [target(await fixture('preaborted'))], signal: controller.signal,
    fetchImpl: async () => {calls++; return new Response('version: 1.1.0\n');}});
  assert.equal(calls, 0);
  assert.equal(row.status, 'cancelled');
});

test('CLIENT-F3: overrides validate JSON/feed fields and retain the historic generic feed override', () => {
  assert.throws(() => mergeTargets({qoder: {latestType: 'feed', latestUrl: 'https://sample.test', latestFile: {}}}), /latestFile/);
  assert.throws(() => mergeTargets({opencode: {latestField: 123}}), /latestField/);
  const picked = mergeTargets({trae: {latestUrl: 'https://sample.test/feed'}}).find(t => t.id === 'trae');
  assert.equal(picked.latest.type, 'feed');
  assert.equal(picked.latest.url, 'https://sample.test/feed');
});

test('CLIENT-F4: interval changes recompute next check and tolerate an invalid cached timestamp', () => {
  const s = service({intervalHours: 6});
  s.ledger.set('client-updates', {checkedAt: '2026-10-17T00:00:00.000Z', nextCheckAt: '2026-10-18T00:00:00.000Z'});
  assert.equal(clientUpdatesReport(s).nextCheckAt, '2026-10-17T06:00:00.000Z');
  s.ledger.set('client-updates', {checkedAt: 'SAMPLE_BAD_DATE'});
  assert.equal(clientUpdatesReport(s).nextCheckAt, null);
});

test('CLIENT-F6: stopping also waits for an untracked manual scan to finish cancellation', async () => {
  const s = service();
  const scheduler = new Scheduler(s.config, {}, s.ledger); scheduler.service = s;
  let started;
  const begun = new Promise(resolve => started = resolve), pending = [];
  const checking = runClientUpdateCheck(s, {targets: [target(await fixture('manual-shutdown'))], fetchImpl: async () => {
    started(); return new Promise(resolve => pending.push(resolve));
  }});
  await begun;
  const stopping = scheduler.stop();
  const settled = await Promise.race([stopping.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
  for (const release of pending) release(new Response('version: 1.1.0\n'));
  await stopping;
  const row = await checking;
  assert.equal(settled, true);
  assert.equal(row.status, 'cancelled');
  assert.equal(s.ledger.get('client-updates').status, 'cancelled');
});

test('CLIENT-F6: stop cancels stalled response bodies, not only connection/header waits', async () => {
  const s = service();
  const scheduler = new Scheduler(s.config, {}, s.ledger); scheduler.service = s;
  let started;
  const begun = new Promise(resolve => started = resolve), pending = [];
  const checking = runClientUpdateCheck(s, {targets: [target(await fixture('body-shutdown'))], fetchImpl: async () => ({status: 200, text() {
    started(); return new Promise(resolve => pending.push(resolve));
  }})});
  await begun;
  const stopping = scheduler.stop();
  const settled = await Promise.race([stopping.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
  for (const release of pending) release('version: 1.1.0\n');
  await stopping;
  assert.equal(settled, true);
  assert.equal((await checking).status, 'cancelled');
});
