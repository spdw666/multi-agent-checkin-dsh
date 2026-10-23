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

test('every relative link in public entry docs resolves to a real file', async () => {
  const files = ['README.md', 'docs/api.md', 'docs/wb-account-pool.md', 'THIRD_PARTY_NOTICES.md'];
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
    'changexbc/workbuddy-switch',
    'tashfeenahmed/freellmapi',
    'bowenliang123/dsh-context',
    'RobbsLuo/Coding2API',
    'Jasery/opencode-lobster-auth',
    'netease-youdao/LobsterAI',
    'denysvitali/llm-proxy',
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
  assert.ok(!/\b[0-9a-f]{40}\b/.test(readme.split('\n## 许可与致谢\n')[0]), 'README must not carry commit SHAs in the body');
});

test('README is a detailed long-lived guide rather than a line-count target', async () => {
  const readme = await read('README.md');
  const sections = [
    '产品定位与架构', '快速开始', 'Windows 原生桌面', '九个页面',
    'wb帐号池详解', '同模型自动接力', '支持的平台与能力边界',
    'OpenAI 兼容客户端接入', 'DSH 与 Hermes 接入', '上下文、工具、推理与超时',
    '每日签到与自动刷新', '配置参考', '本机数据、备份与回滚',
    '诊断与常见问题', '测试、发布与贡献', '文档导航', '许可与致谢',
  ];
  for (const title of sections) {
    const header = '\n## ' + title + '\n';
    assert.ok(readme.includes(header), 'missing guide section: ' + title);
    const body = readme.split(header)[1].split(/\n## /)[0];
    assert.ok(body.trim().length >= 120, 'section must explain its contract, not be a stub: ' + title);
  }
  for (const token of ['desktop/AiCreditDesktop.cs', 'desktop/build.ps1', 'AI积分网关.exe',
    'npm ci', 'npm run build', 'npm run check', 'GATEWAY_READY', 'TOKEN',
    '/v1/models', '/v1/chat/completions', 'key_cmd', 'discover_models',
    'autoMigrateSessions', 'autoTasks', 'reservePercent', 'reserveCredits',
    'modelRequestTimeouts', 'bodyLimitBytes', 'account-deletion-backups',
    'SHA-256', '积分总览', '账号管理', '模型路由', '领取记录', '偏好设置',
    '活动洞察', 'wb帐号池', '积分剩余 / 总额']) {
    assert.ok(readme.includes(token), 'README lost user-facing setup/behaviour: ' + token);
  }
  assert.ok(await exists(join(projectRoot, 'desktop/build.ps1')), 'native build entry must be shipped');
  assert.ok(!readme.includes('原生桌面前端实现与安装包不公开'), 'obsolete native-source exclusion');
  assert.match(readme, /积分总览[^\n]*排除 WorkBuddy|排除 WorkBuddy[^\n]*积分总览/);
  assert.match(readme, /401\/403[^\n]*不等于官方封禁/);
  assert.match(readme, /manual_action_required/);
  assert.match(readme, /cloudSyncConfirmed:false/);
  assert.match(readme, /WB 模型只接 WB/);
});

test('WB detail docs retain identity, ban, package, task and API semantics', async () => {
  const wb = await read('docs/wb-account-pool.md');
  const api = await read('docs/api.md');
  for (const token of ['identity.uid', 'identity.userId', 'identity.source',
    'credential.accessExpiresAt', 'refreshExpiresAt', 'accessState', 'refreshState', 'hasAccessToken', 'hasRefreshToken',
    'auth_rejected', 'user_marked', 'official_response', 'upstreamCode',
    'knownRemaining', 'knownTotal', 'unknownAccounts', 'allAccounts',
    'packageCode', 'subProductCode', 'expiresAt', 'refreshAt', 'complete',
    'taskCode', 'taskDesc', 'rewardCredit', 'rewardEnergy', 'rewardBuddy',
    'accepted', 'qualified', 'claimed', 'locked', 'serverStatus',
    'executionStrategy', 'manual_action_required', 'serverConfirmed',
    'lastSuccessAt', 'lastFailureAt', 'stale', 'cloudSyncConfirmed:false']) {
    assert.ok(wb.includes(token), 'WB details lost field/semantic: ' + token);
  }
  for (const endpoint of ['/admin/workbuddy/summary', '/admin/workbuddy/accounts/ACCOUNT/details',
    '/admin/workbuddy/accounts/ACCOUNT/mark-status', '/admin/workbuddy/login/start',
    '/admin/workbuddy/settings', '/admin/workbuddy/tasks',
    '/admin/workbuddy/sessions/merge', '/admin/accounts/ACCOUNT']) {
    assert.ok(wb.includes(endpoint), 'WB doc lost API: ' + endpoint);
  }
  assert.match(api, /\/admin\/workbuddy\/accounts\/:id\/details/);
  assert.match(api, /\/admin\/workbuddy\/accounts\/:id\/mark-status/);
  assert.match(wb, /401\/403[^\n]*不等于账号封禁/);
  assert.match(wb, /默认.*关闭/);
  assert.match(wb, /缓存读取[^\n]*不.*轮换/);
  assert.match(wb, /源会话保留|原文[^\n]*保留/);
});

test('public entry documentation uses credential placeholders and retains license boundaries', async () => {
  for (const file of ['README.md', 'docs/api.md', 'docs/wb-account-pool.md', 'THIRD_PARTY_NOTICES.md']) {
    const text = await read(file);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), file + ': private key material');
    assert.ok(!/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/.test(text), file + ': API credential pattern');
    assert.ok(!/C:[\\/]Users[\\/]ms[\\/]/i.test(text), file + ': personal local path');
    for (const [, value] of text.matchAll(/Bearer ([A-Za-z0-9._~-]{8,})/g)) {
      assert.ok(['TOKEN', 'API_TOKEN', 'ADMIN_TOKEN', 'ACCOUNT_TOKEN'].includes(value), file + ': use a typed credential placeholder');
    }
  }
  const notices = await read('THIRD_PARTY_NOTICES.md');
  assert.ok(notices.includes('changexbc/workbuddy-switch'));
  assert.ok(notices.includes('src/workbuddy-reference-license.mjs'));
  assert.ok(notices.includes('desktop/build.ps1'));
  assert.ok(!notices.includes('不包含原生/Web前端'), 'obsolete public source statement');
});

test('all public JSON examples parse without replacing typed placeholders', async () => {
  for (const file of ['README.md', 'docs/api.md', 'docs/wb-account-pool.md']) {
    const text = await read(file);
    for (const [, example] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      assert.doesNotThrow(() => JSON.parse(example), file + ': invalid JSON example');
    }
  }
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
