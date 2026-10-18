import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  compareVersions, parseLatestYml, fieldValue, normalizeClientUpdates,
  readInstalledVersion, fetchLatestVersion, checkTarget, runClientUpdateCheck,
  clientUpdateDue, mergeTargets
} from '../src/client-updates.mjs';

test('compareVersions treats build suffixes as the same release', () => {
  assert.equal(compareVersions('5.8.3', '5.8.3.41334564'), 'same');
  assert.equal(compareVersions('4.12.1', '4.12.2.41207131'), 'newer');
  assert.equal(compareVersions('5.8.4.41366630', '5.8.4'), 'same');
  assert.equal(compareVersions('1.0.38', '1.0.31'), 'older');
  assert.equal(compareVersions('2026.10.13', '2026.10.16'), 'newer');
  assert.equal(compareVersions('0.9.38', '0.9.39'), 'newer');
  assert.equal(compareVersions('', '1.0.0'), 'unknown');
  assert.equal(compareVersions('desktop-v0.0.45', '0.0.48'), 'newer');
});

test('parseLatestYml reads the version line only', () => {
  assert.equal(parseLatestYml("version: 0.4.8\nfiles:\n  - url: x\n"), '0.4.8');
  assert.equal(parseLatestYml("version: '1.2.3'\npath: y"), '1.2.3');
  assert.equal(parseLatestYml('files: []'), '');
});

test('fieldValue supports dotted paths', () => {
  assert.equal(fieldValue({a: {b: {c: '9.9.9'}}}, 'a.b.c'), '9.9.9');
  assert.equal(fieldValue({version: '1'}, 'version'), '1');
  assert.equal(fieldValue({}, 'x.y'), undefined);
});

test('normalizeClientUpdates tolerates partial config', () => {
  assert.deepEqual(normalizeClientUpdates(undefined), {enabled: true, intervalHours: 24, timeoutMs: 15000, targets: {}});
  assert.equal(normalizeClientUpdates({enabled: false, intervalHours: 6}).intervalHours, 6);
  assert.equal(normalizeClientUpdates({enabled: 'yes'}).enabled, true);
});

test('mergeTargets applies per-client overrides without dropping defaults', () => {
  const targets = mergeTargets({trae: {enabled: false}, qoder: {latestUrl: 'https://example.test/latest.yml'}});
  const trae = targets.find((t) => t.id === 'trae');
  const qoder = targets.find((t) => t.id === 'qoder');
  assert.equal(trae.enabled, false);
  assert.equal(qoder.latest.type, 'feed');
  assert.equal(qoder.latest.url, 'https://example.test/latest.yml');
  assert.ok(targets.length >= 15);
});

function syntheticAsar(pkg) {
  const data = Buffer.from(JSON.stringify(pkg));
  const header = Buffer.from(JSON.stringify({files: {'package.json': {size: data.length, offset: 0}}}));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(header.length + 8, 4);
  head.writeUInt32LE(header.length + 4, 8);
  head.writeUInt32LE(header.length, 12);
  return Buffer.concat([head, header, data]);
}

test('readInstalledVersion supports json, asar and asarUnpacked layouts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'client-updates-'));
  try {
    await mkdir(join(root, 'json-app', 'resources'), {recursive: true});
    await writeFile(join(root, 'json-app', 'resources', 'install-manifest.json'), JSON.stringify({appVersion: '5.8.3'}));
    const fromJson = await readInstalledVersion({
      install: join(root, 'json-app'),
      version: {type: 'json', file: 'resources/install-manifest.json', field: 'appVersion'}
    });
    assert.equal(fromJson.installed, '5.8.3');

    await mkdir(join(root, 'asar-app', 'resources'), {recursive: true});
    await writeFile(join(root, 'asar-app', 'resources', 'app.asar'), syntheticAsar({name: 'qoder', version: '0.4.4'}));
    const fromAsar = await readInstalledVersion({install: join(root, 'asar-app'), version: {type: 'asar'}});
    assert.equal(fromAsar.installed, '0.4.4');

    await mkdir(join(root, 'unpacked-app', 'resources', 'app.asar.unpacked'), {recursive: true});
    await writeFile(join(root, 'unpacked-app', 'resources', 'app.asar.unpacked', 'package.json'), JSON.stringify({version: '0.9.38'}));
    const fromUnpacked = await readInstalledVersion({install: join(root, 'unpacked-app'), version: {type: 'asarUnpacked'}});
    assert.equal(fromUnpacked.installed, '0.9.38');

    const missing = await readInstalledVersion({install: join(root, 'nope'), version: {type: 'asar'}});
    assert.equal(missing.installed, '');
    assert.match(missing.error, /ENOENT|not found/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

const okJson = (body, status = 200) => async () => new Response(JSON.stringify(body), {status});
const textResp = (body, status = 200) => async () => new Response(body, {status});

test('fetchLatestVersion reads genie update API and treats 204 as current', async () => {
  const target = {latest: {type: 'genie', base: 'https://www.workbuddy.cn', platform: 'workbuddy-win32-x64-user'}};
  const found = await fetchLatestVersion(target, {
    installed: '5.8.3', apiVersion: '5.8.3',
    fetchImpl: okJson({version: '5.8.3.41334564', url: 'https://download.example/WorkBuddy.exe'})
  });
  assert.equal(found.latest, '5.8.3.41334564');
  assert.equal(found.source, 'genie_update_api');
  assert.equal(found.downloadUrl, 'https://download.example/WorkBuddy.exe');

  const current = await fetchLatestVersion(target, {
    installed: '4.12.1', apiVersion: '4.12.1',
    fetchImpl: async () => new Response(null, {status: 204})
  });
  assert.equal(current.latest, '4.12.1');

  await assert.rejects(fetchLatestVersion(target, {
    installed: '5.8.3', fetchImpl: async () => new Response('busy', {status: 500})
  }), /HTTP 500/);
});

test('fetchLatestVersion reads feeds, JSON APIs and GitHub tags with prefixes', async () => {
  const feed = await fetchLatestVersion(
    {latest: {type: 'feed', url: 'https://static.example/loomy/win/'}},
    {installed: '0.9.38', fetchImpl: textResp("version: 0.9.39\nfiles: []\n")}
  );
  assert.equal(feed.latest, '0.9.39');
  assert.equal(feed.source, 'electron_updater_feed');

  const json = await fetchLatestVersion(
    {latest: {type: 'json', url: 'https://opencode.test/latest', field: 'version'}},
    {installed: '2.0.31', fetchImpl: okJson({version: '2.0.32'})}
  );
  assert.equal(json.latest, '2.0.32');

  const github = await fetchLatestVersion(
    {latest: {type: 'github', repo: 'cline/cline', prefix: 'desktop-v'}},
    {installed: '0.0.45', fetchImpl: okJson({tag_name: 'desktop-v0.0.48', html_url: 'https://github.com/x'})}
  );
  assert.equal(github.latest, '0.0.48');
  assert.equal(github.source, 'github_releases');

  const none = await fetchLatestVersion({latest: {type: 'none'}}, {installed: '1.0.0'});
  assert.deepEqual(none, {latest: '', source: 'none'});
});

test('fetchLatestVersion reads official page patterns and the Trae manifest', async () => {
  const page = await fetchLatestVersion(
    {latest: {type: 'text', url: 'https://zcode.test/changelog', regex: 'font-mono text-sm">([0-9]+[.][0-9]+[.][0-9]+)</span>'}},
    {installed: '3.15.3', fetchImpl: textResp('<span class="font-mono text-sm">3.15.4</span>')}
  );
  assert.equal(page.latest, '3.15.4');
  assert.equal(page.source, 'official_page');

  const trae = await fetchLatestVersion(
    {latest: {type: 'trae', url: 'https://api.trae.test/check_update'}},
    {installed: '3.4.3', fetchImpl: okJson({data: {manifest: {win32: {version: '2.3.92182'}}}})}
  );
  assert.equal(trae.latest, '2.3.92182');
  assert.equal(trae.source, 'trae_update_api');

  await assert.rejects(fetchLatestVersion(
    {latest: {type: 'text', url: 'https://z.test', regex: 'v([0-9]+)'}},
    {installed: '1', fetchImpl: textResp('nothing here')}
  ), /pattern not found/);
});

test('checkTarget reports update/current/ahead/no_source/not_detected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'client-target-'));
  try {
    const app = join(root, 'app');
    await mkdir(join(app, 'resources'), {recursive: true});
    await writeFile(join(app, 'resources', 'app.asar'), syntheticAsar({version: '0.4.4'}));
    const base = {enabled: true};
    const target = {
      id: 'qoder', name: 'Qoder', platform: 'qoder', install: app,
      version: {type: 'asar'}, latest: {type: 'feed', url: 'https://static.example/qoder'}
    };
    const updated = await checkTarget(target, base, {fetchImpl: textResp('version: 0.4.8\n')});
    assert.equal(updated.status, 'update_available');
    assert.equal(updated.installed, '0.4.4');
    assert.equal(updated.latest, '0.4.8');

    const same = await checkTarget(target, base, {fetchImpl: textResp('version: 0.4.4\n')});
    assert.equal(same.status, 'current');

    const ahead = await checkTarget(target, base, {fetchImpl: textResp('version: 0.4.1\n')});
    assert.equal(ahead.status, 'ahead');

    const noSource = await checkTarget({...target, latest: {type: 'none'}}, base, {fetchImpl: textResp('')});
    assert.equal(noSource.status, 'no_source');

    const failed = await checkTarget(target, base, {fetchImpl: async () => new Response('boom', {status: 503})});
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /HTTP 503/);

    const missing = await checkTarget({...target, install: join(root, 'missing')}, base, {fetchImpl: textResp('')});
    assert.equal(missing.status, 'not_detected');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('runClientUpdateCheck persists a summary and obeys the interval gate', async () => {
  const values = new Map();
  const service = {
    config: {value: {clientUpdates: {enabled: true, intervalHours: 24}}},
    ledger: {get: (k) => values.get(k), set: (k, v) => values.set(k, v)}
  };
  const root = await mkdtemp(join(tmpdir(), 'client-run-'));
  try {
    const app = join(root, 'app');
    await mkdir(join(app, 'resources'), {recursive: true});
    await writeFile(join(app, 'resources', 'app.asar'), syntheticAsar({version: '1.0.0'}));
    const targets = [
      {id: 'a', name: 'A', platform: 'a', install: app, version: {type: 'asar'}, latest: {type: 'feed', url: 'https://x.test/a'}},
      {id: 'b', name: 'B', platform: 'b', install: join(root, 'absent'), version: {type: 'asar'}, latest: {type: 'none'}},
      {id: 'c', name: 'C', platform: 'c', install: app, version: {type: 'asar'}, latest: {type: 'none'}, enabled: false}
    ];
    assert.equal(clientUpdateDue(service), true);
    const report = await runClientUpdateCheck(service, {
      targets,
      fetchImpl: textResp('version: 1.2.0\n')
    });
    assert.equal(report.status, 'ok');
    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.update_available, 1);
    assert.equal(report.summary.not_detected, 1);
    assert.equal(report.summary.disabled, 1);
    assert.equal(values.get('client-updates').summary.update_available, 1);
    assert.equal(clientUpdateDue(service), false, 'fresh check must not run again inside the interval');
    assert.equal(clientUpdateDue(service, Date.now() + 25 * 3600000), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('official changelog HTML and client update logs provide a latest version', async () => {
  const zcode = await fetchLatestVersion(
    {latest: {type: 'html', url: 'https://zcode.test/changelog', regex: 'font-mono[^>]*> *([0-9]+[.][0-9]+[.][0-9]+)'}},
    {installed: '3.15.1', fetchImpl: textResp('<span class="font-mono text-sm">3.15.3</span> 发布于 2026年10月13日')}
  );
  assert.equal(zcode.latest, '3.15.3');
  assert.equal(zcode.source, 'official_changelog');

  const dir = await mkdtemp(join(tmpdir(), 'client-log-'));
  try {
    const log = join(dir, 'main.log');
    await writeFile(log, [
      'Update for version 2.22.0 is not available (latest version: 2.22.0, downgrade is allowed).',
      'Update for version 2.24.0 is not available (latest version: 2.24.0, downgrade is allowed).'
    ].join('\n'));
    const antigravity = await fetchLatestVersion(
      {latest: {type: 'log', file: log, regex: 'latest version: ([0-9]+[.][0-9]+[.][0-9]+)'}},
      {installed: '2.24.0'}
    );
    assert.equal(antigravity.latest, '2.24.0', 'must take the newest (last) log entry');
    assert.equal(antigravity.source, 'client_update_log');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('trae and codearts use their official update APIs', async () => {
  let seen = '';
  const trae = await fetchLatestVersion(
    {latest: {type: 'trae', url: 'https://api.trae.test/check_update', mid: 'm1', did: '1', branch: 'b', versionCode: '20250325', pid: 'p1', iid: 'i1'}},
    {installed: '3.4.3', apiVersion: '2.3.92182', fetchImpl: async (url) => { seen = String(url); return new Response(JSON.stringify({
      err_code: 0, data: {needUpdate: true, manifest: {win32: {version: '2.3.99999', urls: [{region: 'cn', url: 'https://cdn.test/win32', x64: 'https://cdn.test/setup.exe'}]}}}
    }), {status: 200}); }}
  );
  assert.match(seen, /appVersion=3\.4\.3/);
  assert.match(seen, /buildVersion=2\.3\.92182/);
  assert.equal(trae.latest, '2.3.99999');
  assert.equal(trae.source, 'trae_update_api');

  const codearts = await fetchLatestVersion(
    {latest: {type: 'codearts', url: 'https://ide.test/v1/release-info/latest', subProduct: 'ai', osType: 'windows'}},
    {installed: '26.9.902', fetchImpl: okJson({result: {version: '26.10.1', url: 'https://download.test/agent.exe'}})}
  );
  assert.equal(codearts.latest, '26.10.1');
  assert.equal(codearts.source, 'codearts_release_api');
});
