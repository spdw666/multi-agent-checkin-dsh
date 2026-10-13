import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {projectRoot} from '../src/config.mjs';
import {gatewayRequestTimeout} from '../src/server.mjs';

const normalizeMarkdown = text => text.replace(/\r\n?/g, '\n');
const read = name => readFile(join(projectRoot, name), 'utf8').then(normalizeMarkdown);
const exists = p => access(p).then(() => true, () => false);

test('Markdown contract parsing is invariant across LF CRLF and CR checkouts', () => {
  const source = '# contract\n\n```json\n{"modelRequestTimeouts":{"sample/model":600000}}\n```\n';
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = normalizeMarkdown(source.replaceAll('\n', newline));
    assert.equal(text, source);
    assert.equal(text.split('\n').filter(Boolean).length, 4);
    const block = [...text.matchAll(/```json\n([\s\S]*?)```/g)][0]?.[1];
    assert.equal(JSON.parse(block).modelRequestTimeouts['sample/model'], 600000);
  }
});

test('docs/api.md keeps the core management contract sections', async () => {
  const api = await read('docs/api.md');
  assert.ok(api.split('\n').length > 100, 'api.md must be the restored full contract, not a stub');
  const required = [
    // 鉴权分离
    'apiKey', 'adminKey', 'authentication_error', 'timingSafeEqual',
    // Host / Origin 防护
    'origin_rejected', 'host_rejected', 'Referrer-Policy',
    // 请求体上限
    '67108864', '4194304', 'body_too_large', '413',
    // 超时
    'modelRequestTimeouts', 'gatewayRequestTimeout', 'requestTimeoutMs', '180000', 'Retry-After',
    // 体检语义
    'invalid_audit_scope', 'invalid_audit_selection', 'audit_in_progress', 'queuedScope',
    'jobKeys', 'previousAttempts', 'unsupported', 'auditToolChoice',
    'passed', 'partial', 'uncertain', 'unavailable', 'failed',
    // 领取语义
    'observed', 'already', 'busy', 'action_required', 'device_occupied',
    'not_available', 'success', 'serverConfirmed',
    // 余额语义
    'stale', 'quotaKnown', 'rate_limited_free', 'official_response_headers', 'balance_timeout',
    // 用量语义
    'beforeId', 'nextBeforeId', 'invalid_date', 'balanceChanges', 'requestId',
  ];
  const missing = required.filter(token => !api.includes(token));
  assert.deepEqual(missing, [], 'api.md lost contract tokens: ' + missing.join(', '));
  assert.match(api, /只表示任务已开始/);
  assert.match(api, /202/);
  assert.ok(api.includes('不存在 `submitted` 与 `failed` 顶层状态'), 'api.md must document the real claim status set');
  assert.ok(!/queuedScope[^。]*默认/.test(api), 'queuedScope must not be described as a queue-of-scopes default');
});

test('every relative link in README and docs/api.md resolves to a real file', async () => {
  const files = ['README.md', 'docs/api.md'];
  const broken = [];
  for (const file of files) {
    const text = await read(file);
    const base = dirname(join(projectRoot, file));
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = decodeURIComponent(target.split('#')[0]);
      if (!clean) continue;
      if (!(await exists(resolve(base, clean)))) broken.push(file + ' -> ' + target);
    }
  }
  assert.deepEqual(broken, [], 'broken documentation links: ' + broken.join(', '));
});

test('README keeps the full attribution set, including new references', async () => {
  const readme = await read('README.md');
  const lines = readme.split('\n').filter(Boolean);
  assert.ok(lines.length >= 120 && lines.length <= 200, 'README must stay in the 120-200 line band, got ' + lines.length);
  const attributions = [
    'dingminhua/dsh-connect-workbuddy',
    'dingminhua/dsh-connect-trae',
    'hawklithm/workbuddy2api',
    'spirodelazz/ide-daily-checkin',
    '88lin/workbuddy-auto-signin',
    'TriDefender/zcode-api',
    'wicm84266964/Buddy2api',
    'linguo2625469/workbuddy2api-panel',
    'wangmingdong/workbuddy-signin',
    'Shuffle-1992/TraeSign',
    'MiniMax-AI/minimax-code',
    'deepseek-ai/deepseek-harness',
    'router-for-me/CLIProxyAPI',
    'NousResearch/hermes-agent',
    'hucuyuu/zhipu-balance',
    'ZlaxeyX/workbuddy-auto-checkin',
    'cmochance/codex-app-transfer',
    '0xgetz/minimax-agent-automation',
    'jsongo/buddy-proxy',
    'xxhhlk/raccoon2api',
    'Patrick130306/loomy2api',
    'rockswang/wild-work',
    'Ebony-Vinyl/dsh-our-free-model',
  ];
  const missing = attributions.filter(project => !readme.includes(project));
  assert.deepEqual(missing, [], 'README dropped upstream attributions: ' + missing.join(', '));
  assert.ok(readme.includes('THIRD_PARTY_NOTICES.md'), 'notices must stay linked');
  assert.match(readme, /\[MIT\]\(LICENSE\)/);
  for (const uiRef of ['BeUI', 'shadcn', 'Transitions']) {
    assert.ok(readme.includes(uiRef), 'UI reference missing from README: ' + uiRef);
  }
  const uiSection = readme.slice(readme.indexOf('BeUI') - 200);
  assert.match(uiSection, /未复制实现/, 'UI references must not claim code reuse');
  assert.ok(!/\b[0-9a-f]{7,40}\b/.test(readme.split('许可与致谢')[0]), 'README must not carry commit SHAs in the body');
});

test('the documented timeout example is valid and matches gatewayRequestTimeout behaviour', async () => {
  const api = await read('docs/api.md');
  const blocks = [...api.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]);
  const example = blocks.find(block => block.includes('modelRequestTimeouts'));
  assert.ok(example, 'docs/api.md must ship a modelRequestTimeouts example');
  const parsed = JSON.parse(example);
  const policy = parsed.server;
  assert.ok(Number.isInteger(policy.requestTimeoutMs) && policy.requestTimeoutMs > 0);
  const entries = Object.entries(policy.modelRequestTimeouts);
  assert.ok(entries.length > 0);
  for (const [routeId, ms] of entries) {
    assert.ok(routeId.includes('/'), 'route IDs carry a slash: ' + routeId);
    assert.ok(Number.isInteger(ms) && ms >= 1000 && ms <= 1200000, 'deadline out of band: ' + ms);
    assert.equal(gatewayRequestTimeout(policy, routeId), ms);
  }
  assert.equal(gatewayRequestTimeout(policy, 'not-listed/route'), policy.requestTimeoutMs);
  assert.equal(gatewayRequestTimeout({}, 'any/route'), 180000);
  assert.equal(gatewayRequestTimeout({modelRequestTimeouts: {'a/b': 0}}, 'a/b'), 0, 'explicit values win even when falsy');
});
