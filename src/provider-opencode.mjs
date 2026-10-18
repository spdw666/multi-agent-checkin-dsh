// OpenCode Zen free-tier bridge.
//
// A 403 from the public endpoint is not proof that every free route is closed:
//   POST https://opencode.ai/inference/openai/v1/chat/completions
//   {"error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode."}}
// Verified 2026-10-17 with the stored OAuth token, and with opencode-looking
// user-agent/client/session headers — all 403. Paid tiers answer 400
// "Model is unavailable" for names that are not in the caller's plan.
//
// This adapter uses the genuine local OpenCode server. An opt-in dedicated
// network profile can isolate its connection without altering the user's
// global proxy or the official shared service. The adapter drives that server
// over its authenticated loopback API: create a session, post the prompt, poll
// the session message list, and translate the assistant message into the
// OpenAI shape the router expects.
//
// What stays true:
//  - The access token, refresh token and server password never leave this file.
//  - The upstream call happens inside OpenCode, so quota and abuse rules are
//    whatever OpenCode itself enforces. This adapter adds no evasion.
//  - Free-tier availability, model names and limits can change without notice;
//    a failure is reported as the real upstream error, never as success.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {AppError,rememberSecret,errorView} from './util.mjs';
import {resolveOpenCodeService} from './opencode-service.mjs';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
const SESSION_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 1200;

function servicePasswordPath() {
  return join(homedir(), '.config', 'opencode', 'service.json');
}
function credentialDatabasePath() {
  // The desktop app keeps opencode.db under the user profile, not AppData.
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

// Only the loopback server the desktop app already runs is accepted. A caller
// cannot point this at an arbitrary host.
function serverOrigin(value) {
  const raw = typeof value === 'string' && value ? value : '';
  const match = LOOPBACK.exec(raw);
  if (!match) throw new AppError('OpenCode 本机服务地址需为 127.0.0.1 回环地址', 400, 'opencode_endpoint_invalid');
  return raw;
}

async function readJson(file, code, message) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new AppError(message, 401, code);
    throw new AppError(message, 502, code);
  }
}

// The desktop app stores its OAuth token in opencode.db and the local server
// password in service.json. Both are read-only here; nothing is written back.
async function desktopSession(account) {
  const dbPath = account?.credentials?.file && account.credentials.file !== 'auto'
    ? account.credentials.file
    : credentialDatabasePath();
  let rows;
  try {
    const db = new DatabaseSync(dbPath, {readOnly: true});
    try {
      rows = db.prepare("SELECT json_extract(value,'$.access') AS access, json_extract(value,'$.expires') AS expires FROM credential WHERE active=1 AND integration_id='opencode' LIMIT 1").all();
    } finally { db.close(); }
  } catch (error) {
    throw new AppError('OpenCode 登录态待就绪（数据库不可读）', 401, 'opencode_login_required');
  }
  const row = rows?.[0];
  if (!row || typeof row.access !== 'string' || !row.access) {
    throw new AppError('OpenCode 尚未登录，请先在官方客户端完成登录', 401, 'opencode_login_required');
  }
  const service = await readJson(servicePasswordPath(), 'opencode_service_missing', 'OpenCode 本机服务配置待就绪');
  if (typeof service.password !== 'string' || !service.password) {
    throw new AppError('OpenCode 本机服务密码待就绪', 401, 'opencode_service_missing');
  }
  rememberSecret(row.access);
  rememberSecret(service.password);
  const expiresAtMs = Number.isFinite(Number(row.expires)) ? Number(row.expires) : null;
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    throw new AppError('OpenCode 登录态已过期，请在官方客户端续期', 401, 'opencode_login_expired');
  }
  return {accessToken: row.access, password: service.password, principal: 'opencode-desktop', expiresAtMs};
}

function authorization(credential) {
  return 'Basic ' + Buffer.from('opencode:' + credential.password, 'utf8').toString('base64');
}

async function api(service, credential, path, {method = 'GET', body, signal, timeoutMs = 20000} = {}) {
  if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
  const origin = serverOrigin(service.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay, {once: true});
  if (signal?.aborted) relay();
  try {
    if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
    const response = await fetch(origin + path, {
      method,
      headers: {authorization: authorization(credential), 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 300); } catch {}
      const status = response.status === 401 || response.status === 403 ? 401 : response.status === 404 ? 502 : 502;
      throw new AppError('OpenCode 本机服务返回 ' + response.status + (detail ? '：' + detail : ''), status, 'opencode_bridge_failed');
    }
    // 204 (session delete) carries no body; do not fail on an empty payload.
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
    if (controller.signal.aborted) throw new AppError('OpenCode 本机服务响应超时', 504, 'opencode_bridge_timeout');
    throw new AppError('OpenCode 本机服务不可达：' + (error.message ?? 'unknown'), 503, 'opencode_bridge_unreachable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

// Model list comes from the running app, so a renamed or withdrawn free model
// disappears from the directory instead of being guessed.
export async function openCodeModels(credential, upstream = {}, options = {}) {
  const service = upstream.kind === 'opencode' ? await resolveOpenCodeService(upstream, credential, options) : upstream;
  const payload = await api(service, credential, '/api/model', {signal: options.signal, timeoutMs: options.timeoutMs ?? 20000});
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter(row => row?.providerID === 'opencode')
    .filter(row => typeof row.id === 'string' && /-free$/.test(row.id))
    .map(row => ({
      id: row.id,
      name: row.name ?? row.id,
      // The gateway only treats a model as importable when both limits are
      // known positive integers; OpenCode reports them under limit.context/output.
      callable: true,
      importable: true,
      free: true,
      contextWindow: Number.isSafeInteger(row.limit?.context) ? row.limit.context : null,
      maxTokens: Number.isSafeInteger(row.limit?.output) ? row.limit.output : null,
      // The local prompt API accepts text, not caller-defined OpenAI tools or
      // image_url parts. Advertise what this bridge can preserve, not the raw
      // model's unrelated native-agent capabilities.
      tools: false,
      multimodal: false,
      note: '本机 OpenCode 文本桥接；仅单条用户纯文本，无显式生成参数；复杂请求保持原样交由兼容供应接力。额度与可用性由 OpenCode 决定',
    }));
}

// OpenCode surfaces upstream failures as a typed block. Map the ones that mean
// something to the gateway so quota/auth problems trigger cooldown or handoff
// instead of being reported as a malformed answer.
function providerError(error) {
  const status = Number(error?.status) || 0;
  const detail = typeof error?.message === 'string' && error.message ? error.message : 'unknown';
  if (status === 403 && /free tier can only be used from within OpenCode/i.test(detail)) {
    return new AppError('OpenCode 官方免费层拒绝了本次请求：' + detail + '；登录成功与免费层推理资格分别核验', 403, 'opencode_free_tier_rejected');
  }
  if (status === 403 && /not available in your country/i.test(detail)) {
    return new AppError('OpenCode 官方模型地区不可用：' + detail, 403, 'opencode_region_unavailable');
  }
  if (status === 429) return new AppError('OpenCode 免费层限流：' + detail, 429, 'opencode_free_rate_limited');
  if (status === 401 || status === 403) return new AppError('OpenCode 授权失败：' + detail, 401, 'opencode_unauthorized');
  if (status === 402) return new AppError('OpenCode 额度不足：' + detail, 402, 'opencode_quota_exhausted');
  return new AppError('OpenCode 上游错误：' + detail, 502, 'opencode_upstream_error');
}

function assistantText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const text = parts.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  const reasoning = parts.filter(part => part?.type === 'reasoning' && typeof part.text === 'string').map(part => part.text).join('');
  return {text, reasoning};
}

// Pinned public protocol: Model.Ref={providerID,id}, session.create accepts
// model; session.prompt accepts text/files/agents/skills/metadata/delivery/resume,
// but no external tool definitions, output budget or sampling controls.
// https://github.com/anomalyco/opencode/blob/c38d83c0c4f92466ff9c8e12b8a741698e811012/packages/protocol/src/groups/session.ts
// Do not stringify roles/tools into a prompt or send ignored unknown fields:
// typed incompatibility lets the router hand the original request to a capable
// same-model provider, without modifying any caller-owned messages or budget.
function bridgePrompt(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  if (input?.tools?.length || input?.functions?.length || input?.tool_choice && input.tool_choice !== 'none'
      || input?.function_call && input.function_call !== 'none'
      || messages.some(m => m?.role === 'tool' || m?.role === 'function' || m?.tool_calls?.length || m?.function_call)) {
    throw new AppError('OpenCode 本机文本桥接未提供调用者工具协议；工具及调用历史已保留供兼容供应接力', 400, 'tools_not_supported');
  }
  if (messages.some(m => Array.isArray(m?.content) && m.content.some(p => p?.type === 'image_url' || p?.type === 'input_image'))) {
    throw new AppError('OpenCode 本机文本桥接未提供调用者图像输入协议', 400, 'images_not_supported');
  }
  const unsupported = Object.keys(input ?? {}).filter(key => !['model', 'messages', 'stream', 'tools', 'tool_choice', 'functions', 'function_call'].includes(key) && input[key] !== undefined);
  if (unsupported.length) {
    throw new AppError('OpenCode 本机协议未提供本次显式生成参数：' + unsupported.join(', ') + '；原始约束已保留供兼容供应接力', 400, 'relay_capacity_incompatible');
  }
  if (messages.length !== 1 || messages[0]?.role !== 'user' || typeof messages[0]?.content !== 'string'
      || Object.keys(messages[0]).some(key => !['role', 'content'].includes(key))) {
    throw new AppError('OpenCode 本机文本桥接未提供无损多角色历史导入；原始上下文已保留供兼容供应接力', 400, 'relay_context_incompatible');
  }
  return messages[0].content;
}

function newest(rows, predicate) {
  return rows.map((row, index) => ({row, index})).filter(({row}) => predicate(row))
    .sort((a, b) => {
      const at = Number(a.row.time?.created), bt = Number(b.row.time?.created);
      return Number.isFinite(at) && Number.isFinite(bt) && at !== bt ? bt - at : a.index - b.index;
    })[0]?.row ?? null;
}

// The router contract is chat(upstream, credential, input, signal) -> {response}
// where response streams OpenAI SSE. OpenCode answers with one assembled message,
// so it is re-emitted as a single chunk followed by [DONE].
export async function openCodeChat(upstream, credential, input, signal) {
  if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
  const model = typeof input?.model === 'string' ? input.model : '';
  if (!model) throw new AppError('OpenCode 请求缺少模型 ID', 400, 'model_missing');
  const text = bridgePrompt(input);
  const service = upstream?.kind === 'opencode' ? await resolveOpenCodeService(upstream, credential, {signal}) : upstream ?? {};
  const timeoutMs = SESSION_TIMEOUT_MS;
  // Default agent is "build", which allows every tool — a forwarded chat message
  // could then edit files or run commands here. Read-only agent plus "ask" is the
  // strictest policy the free tier still accepts: community measurements report
  // that "deny" trips the same 403 gate as no session at all. Any approval the
  // model raises is refused below, so no local action ever runs.
  const created = await api(service, credential, '/api/session', {
    method: 'POST',
    // A supplied title prevents OpenCode's automatic (potentially paid) title-model request.
    body: {title: 'AI credit gateway', location: {directory: process.cwd()}, model: {providerID: 'opencode', id: model}, agent: 'plan', permissions: [{action: '*', resource: '*', effect: 'ask'}]},
    signal,
    timeoutMs: 20000,
  });
  const sessionId = created?.data?.id;
  if (typeof sessionId !== 'string' || !sessionId) throw new AppError('OpenCode 未能创建会话', 502, 'opencode_session_failed');
  try {
    await api(service, credential, '/api/session/' + encodeURIComponent(sessionId) + '/prompt', {method: 'POST', body: {text}, signal, timeoutMs: 20000});
    const deadline = Date.now() + timeoutMs;
    let assistant = null, failure = null, completed = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
      // Ask for the newest page explicitly: the default first page may contain
      // only old completed steps once a multi-step turn exceeds its page size.
      const listed = await api(service, credential, '/api/session/' + encodeURIComponent(sessionId) + '/message?order=desc&limit=200', {signal, timeoutMs: 20000});
      const rows = Array.isArray(listed?.data) ? listed.data : [];
      assistant = newest(rows, row => row?.type === 'assistant');
      failure = newest(rows, row => row?.type === 'error');
      const idle = newest(rows, row => row?.type === 'idle');
      // A failed turn carries its reason on the assistant or idle event, e.g.
      // {"type":"provider.quota","status":429,"message":"Rate limit exceeded"}.
      const turnError = assistant?.error ?? idle?.error ?? failure?.error ?? null;
      if (turnError) throw providerError(turnError);
      if (idle?.outcome === 'interrupted') throw new AppError('OpenCode 回合已中断', 502, 'opencode_turn_interrupted');
      if (failure || idle?.outcome === 'failed' || assistant?.finish === 'error') {
        throw new AppError('OpenCode 回合执行失败', 502, 'opencode_upstream_error');
      }
      // A tool-call step is not the final turn, even when its provider stream
      // completed. Inspect the newest assistant rather than the first row.
      const terminal = ['stop', 'length', 'content-filter'].includes(assistant?.finish);
      const idleAfterAssistant = idle?.outcome === 'succeeded' && (!assistant?.time?.created || !idle.time?.created || Number(idle.time.created) >= Number(assistant.time.created));
      completed = !!assistant && (terminal || idleAfterAssistant && assistant.finish !== 'tool-calls');
      if (completed) break;
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new AppError('请求取消或超时', 499, 'request_cancelled')); };
        const timer = setTimeout(done, POLL_INTERVAL_MS);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
      });
    }
    if (!completed) {
      const detail = failure?.message ?? failure?.error ?? 'unknown';
      throw new AppError('OpenCode 免费模型尚未返回完整终态：' + detail, 504, 'opencode_bridge_timeout');
    }
    if (assistant.model?.providerID !== 'opencode' || assistant.model?.id !== model) {
      throw new AppError('OpenCode 返回模型与所选模型不一致', 502, 'opencode_model_mismatch');
    }
    const shaped = assistantText(assistant);
    // OpenCode reports a failed turn as finish:"error" with empty text; surfacing
    // that as a successful empty answer would hide a real upstream failure.
    if (!shaped.text.trim()) {
      const detail = assistant?.error?.message ?? assistant?.error ?? failure?.message ?? 'empty answer';
      throw new AppError('OpenCode 免费模型未返回正文：' + detail, 502, 'opencode_empty_answer');
    }
    const usage = assistant?.tokens ? {
      prompt_tokens: assistant.tokens.input ?? 0,
      completion_tokens: assistant.tokens.output ?? 0,
      total_tokens: (assistant.tokens.input ?? 0) + (assistant.tokens.output ?? 0),
    } : null;
    const chunk = {
      id: 'chatcmpl-opencode-' + sessionId,
      object: 'chat.completion.chunk',
      model,
      choices: [{index: 0, delta: {role: 'assistant', content: shaped.text, ...(shaped.reasoning ? {reasoning_content: shaped.reasoning} : {})}, finish_reason: assistant?.finish ?? 'stop'}],
      ...(usage ? {usage} : {}),
    };
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return {response: new Response(body, {headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'}})};
  } finally {
    // Sessions are cheap but not free; drop the transcript this request created.
    await api(service, credential, '/api/session/' + encodeURIComponent(sessionId), {method: 'DELETE', timeoutMs: 8000}).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 余额与免费额度
//
// Zen 的付费余额可以从 console 的 billing 接口读到（Bearer = 客户端 OAuth token，
// 实测 200：{balanceMicroCents:"0", mode:"pay-as-you-go"}）。免费模型的每日请求
// 限额由服务端私有配置控制、没有公开接口，这里只把「本机 OpenCode 数据库里今天
// 已经发生的请求数」如实统计出来，再按社区实测的 ~200 次/天给出估算剩余，并在
// note 里注明这是估算而不是官方数字。
const BILLING_URL = 'https://opencode.ai/console/api/billing/status';
const FREE_DAILY_LIMIT_ESTIMATE = 200;

function utcDayStartMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function localDailyRequests(account) {
  const dbPath = account?.credentials?.file && account.credentials.file !== 'auto'
    ? account.credentials.file
    : credentialDatabasePath();
  try {
    const db = new DatabaseSync(dbPath, {readOnly: true});
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM session_message WHERE type='assistant' AND time_created >= ? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.model.providerID')='opencode' AND json_extract(data,'$.model.id') GLOB '*-free' ELSE 0 END"
      ).get(utcDayStartMs());
      return Number(row?.n ?? 0);
    } finally { db.close(); }
  } catch { return null; }
}

async function zenBilling(accessToken, timeoutMs = 8000) {
  if (typeof accessToken !== 'string' || !accessToken) return {ok: false, reason: 'no-token'};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(BILLING_URL, {
      headers: {authorization: 'Bearer ' + accessToken, accept: 'application/json'},
      signal: controller.signal,
    });
    if (!response.ok) return {ok: false, status: response.status};
    const data = await response.json();
    // Missing, blank and boolean fields are unknown, not an observed $0.
    const raw = data?.balanceMicroCents;
    const micro = typeof raw === 'number' || typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(micro) || micro < 0) return {ok: false, reason: 'invalid-balance'};
    return {
      ok: true,
      balanceUsd: micro / 100_000_000,
      mode: typeof data?.mode === 'string' ? data.mode : null,
      billingMode: typeof data?.billingMode === 'string' ? data.billingMode : null,
    };
  } catch {
    return {ok: false};
  } finally { clearTimeout(timer); }
}

function openCodeBalance(account) {
  const used = localDailyRequests(account);
  const parts = [];
  let note;
  let value = null;
  let unit = '次（估算）';
  if (used === null) {
    note = '本机 OpenCode 数据库不可读，无法统计今日免费请求；官方未公开免费额度上限。';
  } else {
    const remaining = Math.max(0, FREE_DAILY_LIMIT_ESTIMATE - used);
    value = remaining;
    parts.push({name: '今日免费请求', value: used, unit: '次'});
    parts.push({name: '估算每日上限', value: FREE_DAILY_LIMIT_ESTIMATE, unit: '次（社区估算）'});
    note = '免费模型按 IP 每日限流，官方未公开上限，按社区实测约 ' + FREE_DAILY_LIMIT_ESTIMATE
      + ' 次/天估算（UTC 00:00 重置）。今日已用 ' + used + ' 次，估算剩 ' + remaining + ' 次。';
  }
  return {used, value, unit, parts, note};
}

export async function openCodeHealth(credential, upstream = {}, options = {}) {
  const service = upstream?.baseUrl ? upstream : (options.upstream?.baseUrl ? options.upstream : {});
  const account = options.account ?? {};
  // Quota sources do not require the desktop inference server to be running.
  // Keep its catalog diagnostic separate; a stopped app must not erase readable
  // local usage or the independently fetched official paid balance.
  const usage = openCodeBalance(account);
  const [catalog, billing] = await Promise.all([
    openCodeModels(credential, service, {...options, timeoutMs: options.timeoutMs ?? 3000})
      .then(models => ({models, error: null}), error => ({models: null, error: errorView(error)})),
    zenBilling(credential?.accessToken, options.timeoutMs ?? 8000),
  ]);
  const models = catalog.models;
  const balanceKnown = usage.value !== null || billing.ok && billing.balanceUsd !== null;
  const balanceParts = [...usage.parts];
  const notes = [catalog.error ? '本机 OpenCode 服务未连接，模型调用待恢复；额度独立读取' : '', usage.note];
  if (billing.ok && billing.balanceUsd !== null) {
    balanceParts.unshift({name: 'Zen 付费余额', value: billing.balanceUsd, unit: 'USD'});
    notes.push('Zen 余额 $' + billing.balanceUsd.toFixed(2)
      + (billing.balanceUsd > 0 ? '，可用付费模型' : '，仅免费模型可用'));
  } else if (!billing.ok) {
    notes.push('Zen 付费余额读取失败' + (billing.status ? '（HTTP ' + billing.status + '）' : ''));
  }
  return {
    known: balanceKnown,
    balanceKnown,
    status: catalog.error ? 'bridge_unavailable' : models.length ? 'ok' : 'empty',
    // Local session presence is not proof that the inference service is live.
    credentialStatus: catalog.error ? 'failed' : 'session',
    capabilities: {checkin: false, inference: !!models?.length},
    freeModels: models?.length ?? null,
    bridge: {status: catalog.error ? 'unavailable' : models.length ? 'ready' : 'empty', ...(catalog.error ? {error: catalog.error} : {})},
    billing: {known: billing.ok, ...(billing.status ? {status: billing.status} : {}), ...(billing.reason ? {reason: billing.reason} : {})},
    authentication: {status: 'session', source: 'opencode desktop'},
    balance: {
      // 主数值回答“还能用多少”：免费额度的估算剩余次数；余额放在 note/parts 里。
      value: usage.value !== null ? usage.value : (billing.ok ? billing.balanceUsd : null),
      unit: usage.value !== null ? usage.unit : 'USD',
      parts: balanceParts,
      note: notes.filter(Boolean).join('；').replace('；；', '；').replace('。；', '。'),
    },
  };
}

export function openCodeResolve(account) {
  return desktopSession(account);
}

// Signatures match the other desktop adapters: models(credential, options) and
// health(credential, options) receive the resolved credential; chat gets the
// upstream row (which carries the loopback baseUrl) as its first argument.
export const openCodeProvider = {
  resolve: (account) => openCodeResolve(account),
  models: (credential, options = {}) => openCodeModels(credential, options.upstream ?? {}, options),
  health: (credential, options = {}) => openCodeHealth(credential, options.upstream ?? {}, options),
  chat: (upstream, credential, input, signal) => openCodeChat(upstream, credential, input, signal),
  checkinSupported: false,
  descriptor: {name: 'OpenCode Zen 免费', checkinSupported: false},
};
