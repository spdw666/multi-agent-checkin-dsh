import {desktopSseResponse,desktopCompletionLimit} from './provider-sse.mjs';
// provider-lobster.mjs — LobsterAI (网易有道龙虾) provider adapter, unified-contract edition.
// Evidence (read-only; official GitHub netease-youdao/LobsterAI + local install D:/LobsterAI + live probe 2026-10-11):
//  - Server origin https://lobsterai-server.youdao.com (dist-electron/main/libs/endpoints.js).
//  - Auth lives in %APPDATA%/LobsterAI/lobsterai.sqlite, table `kv`, keys `auth_tokens` (accessToken/refreshToken)
//    and `auth_user`. The token is re-read from the DB on EVERY resolve — never cached, never written to disk.
//  - Model catalog: GET /api/models/available → 30 entries (verified live, HTTP 200).
//  - Balance: GET /api/user/quota + /api/user/profile-summary → free 300 + daily-login 100 ≈ 400 total (verified live).
//  - Daily check-in (CONFIRMED — the earlier "no daily check-in" conclusion is superseded):
//      GET  /api/client-activities/slot?placement=desktop_sidebar&clientVersion=…&containerApiVersion=2&platform=win32
//      GET  /api/client-activities/{activityCode}/context?configRevision=N
//      POST /api/client-activities/{activityCode}/actions/{actionId}  body {configRevision,idempotencyKey,payload:{}}
//    The activity is DISCOVERED from the slot at call time (never hard-coded); error codes 51100..51106 are
//    the official client's ActivityServerErrorCode.
//  - Chat: POST /api/proxy/v1/chat/completions. Upstream answers SSE even for stream:false; failures arrive as
//    `event:error` with HTTP 200 (converted to AppError here); delta.reasoning_content is INCREMENTAL.
import {AppError, redact, hash, rememberSecret, dayIn} from './util.mjs';
import {readFile} from 'node:fs/promises';

const thinkingProfiles = new Map();
const REASONING_LEVEL_ORDER = ['minimal','low','medium','high','xhigh','max'];
const REASONING_INPUTS = new Set(['none','off',...REASONING_LEVEL_ORDER]);
// Compatibility names are gateway aliases, never new native model capabilities.
export function lobsterReasoningMapping(options = []) {
  const available = new Set(options);
  const lowest = REASONING_LEVEL_ORDER.find(level => available.has(level));
  const mapping = {};
  for (const requested of REASONING_INPUTS) {
    if (available.has(requested)) mapping[requested] = requested;
    else if (requested === 'none' && available.has('off')) mapping[requested] = 'off';
    else if (requested === 'xhigh' && available.has('max')) mapping[requested] = 'max';
    else if (['minimal','low','medium'].includes(requested) && lowest) mapping[requested] = lowest;
  }
  return mapping;
}
export const LOBSTER_SERVER_ORIGIN = 'https://lobsterai-server.youdao.com';
export const LOBSTER_LOCAL_GATEWAY = 'http://127.0.0.1:55647';
export const LOBSTER_CLIENT_VERSION = '2026.9.23';
export const LOBSTER_CLIENT_CAPABILITIES = 'kimi-k3-agentic-v1,thinking-level-control-v1';
// Conservative UI fallback. NOT an official limit: the catalog carries no output cap, so officialMaxTokens
// stays null and this value is tagged maxTokensSource:'configured_default' — never presented as official.
const CONFIGURED_OUTPUT_TOKENS = 4096;
const JSON_LIMIT = 1024 * 1024;
const SSE_LIMIT = 8 * 1024 * 1024; // a long model output can never buffer unboundedly
const SSE_MAX_RECORDS = 200000;
// Official check-in action whitelist (from the desktop client). Nothing else may ever be submitted.
const CHECKIN_ACTION_WHITELIST = new Set(['check_in']);
// ActivityServerErrorCode from the official client.
const ACTIVITY_ERROR = {51100: 'not_found', 51101: 'not_active', 51102: 'login_required', 51103: 'action_invalid', 51104: 'already_claimed', 51105: 'config_invalid', 51106: 'revision_mismatch'};

const READ_PATHS = new Set(['/api/models/available', '/api/user/quota', '/api/user/profile-summary', '/api/client-activities/slot', '/api/proxy/v1/chat/completions']);
const ACTIVITY_CODE_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export const descriptor = Object.freeze({
  id: 'lobster',
  name: 'LobsterAI (网易有道龙虾)',
  authKind: 'account_credits',
  checkinSupported: true, // confirmed: official client-activities slot/context/actions + live state
  claimSupported: true,
  underlyingProvider: 'lobsterai-server.youdao.com (netease-youdao model broker; local 55647 /v1 gateway)',
  billing: 'official_credits',
  byok: false,
  origin: LOBSTER_SERVER_ORIGIN,
  checkinSource: '/api/client-activities/slot + context + actions',
  sourceUrls: ['https://github.com/netease-youdao/LobsterAI', 'https://lobsterai.youdao.com/'],
});

// ------------------------------------------------------------------ credential

export function defaultLobsterDbPath() {
  const base = process.env.APPDATA ?? '';
  return base ? `${base.replace(/\\/g, '/')}/LobsterAI/lobsterai.sqlite` : '';
}

const stableHash = value => `sha256:${hash('lobster:' + String(value)).slice(0, 24)}`;

/** exp (ms) from an unverified JWT payload — used only to expose expiry, never to trust identity claims. */
function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

/**
 * Read the real access token from the desktop app's SQLite store. READ-ONLY, re-read on every call
 * (the running desktop app may rotate tokens at any time). `auth_user` is parsed in memory only to
 * derive the stable principal; no personal field (yid/phone/nickname/email) ever leaves this function.
 */
export async function readLobsterToken({dbFile = defaultLobsterDbPath(), openSqlite} = {}) {
  if (!dbFile) throw new AppError('未找到 LobsterAI 数据目录 (APPDATA)', 401, 'lobster_db_path_missing');
  const {DatabaseSync} = openSqlite ? {DatabaseSync: openSqlite} : await import('node:sqlite');
  let db;
  try { db = new DatabaseSync(dbFile, {readOnly: true}); }
  catch (error) { throw new AppError(error.code === 'ENOENT' ? '未找到本机 LobsterAI 数据（桌面端未安装或不可读）' : 'LobsterAI 数据库无法只读打开', 401, 'lobster_db_unavailable'); }
  try {
    const rows = db.prepare("SELECT key, value FROM kv WHERE key IN ('auth_tokens','auth_user')").all();
    const byKey = Object.fromEntries(rows.map(row => [row.key, row.value]));
    let tokens = null; let user = null;
    try { tokens = JSON.parse(byKey.auth_tokens ?? 'null'); } catch { tokens = null; }
    try { user = JSON.parse(byKey.auth_user ?? 'null'); } catch { user = null; }
    const accessToken = typeof tokens?.accessToken === 'string' ? tokens.accessToken.trim() : '';
    const refreshToken = typeof tokens?.refreshToken === 'string' ? tokens.refreshToken.trim() : '';
    const principalField = ['yid', 'id', 'userId', 'uid', 'accountId'].find(field => user?.[field] !== undefined && user[field] !== null && String(user[field]) !== '') ?? null;
    const principal = principalField ? stableHash(user[principalField]) : null; // raw ID consumed in memory only
    return {
      accessToken,
      refreshTokenPresent: refreshToken.length > 0,
      principal,
      principalField,
      accountMode: typeof user?.accountMode === 'string' ? user.accountMode : null,
      expiresAtMs: accessToken ? jwtExp(accessToken) : null,
      source: 'desktop_sqlite_kv',
    };
  } finally { try { db.close(); } catch { /* already closed */ } }
}

/** Public view: presence + stable principal only. No token, no yid/phone/nickname/email. */
export function lobsterCredentialView(secret) {
  if (!secret?.accessToken) return {present: false, principal: null, authKind: 'account_credits', source: null};
  return {
    present: true,
    authKind: 'account_credits',
    principal: secret.principal ?? null,
    principalField: secret.principalField ?? null,
    accountMode: secret.accountMode ?? null,
    refreshTokenPresent: secret.refreshTokenPresent === true,
    expiresAt: secret.expiresAtMs ? new Date(secret.expiresAtMs).toISOString() : null,
    source: secret.source ?? 'desktop_sqlite_kv',
  };
}

/**
 * Contract `resolve(account, config) -> private credential`.
 * Honors `account.credentials.file|path`: a *.json settings file (`{lobster:{dbFile, clientVersion, capabilities}}`)
 * or a direct *.sqlite path. The DB is re-read on every call; no inline secret is ever accepted.
 */
export async function lobsterResolve(account, config = {}) {
  const ref = account?.credentials?.file ?? account?.credentials?.path ?? null;
  const refPath = ref && ref !== 'auto' ? (typeof config?.path === 'function' ? config.path(ref) : ref) : null;
  let settings = {};
  if (refPath && !/\.(sqlite|sqlite3|db)$/i.test(refPath)) {
    try {
      const parsed = JSON.parse((await readFile(refPath, 'utf8')).replace(/^\uFEFF/, ''));
      settings = parsed?.lobster ?? parsed ?? {};
    } catch (error) { throw new AppError(error.code === 'ENOENT' ? 'LobsterAI 凭据配置未找到（按路径引用）' : 'LobsterAI 凭据配置无法解析', 401, 'lobster_credential_file_unavailable'); }
  }
  const dbFile = (refPath && /\.(sqlite|sqlite3|db)$/i.test(refPath) ? refPath : null) ?? settings.dbFile ?? config?.dbFile ?? defaultLobsterDbPath();
  const secret = await readLobsterToken({dbFile});
  if (!secret.accessToken) throw new AppError('本机 LobsterAI 未登录（auth_tokens 缺少 accessToken）', 401, 'lobster_credential_missing');
  rememberSecret(secret.accessToken); // register for redaction before any upstream message can echo it
  return {
    ...secret,
    credential: lobsterCredentialView(secret),
    clientVersion: settings.clientVersion ?? config?.clientVersion ?? LOBSTER_CLIENT_VERSION,
    capabilitiesHeader: settings.capabilities ?? config?.capabilities ?? LOBSTER_CLIENT_CAPABILITIES,
  };
}

// ------------------------------------------------------------------ legacy local-state surface (openclaw.json)

export function defaultLobsterStatePath() {
  const base = process.env.APPDATA ?? '';
  return base ? `${base.replace(/\\/g, '/')}/LobsterAI/openclaw/state/openclaw.json` : '';
}

// Parse openclaw.json state WITHOUT surfacing secrets. Only whitelisted non-secret fields leave this fn.
export function parseLobsterState(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw; } catch { throw new AppError('LobsterAI 状态文件 JSON 解析失败', 502, 'lobster_state_parse'); }
  if (!data || typeof data !== 'object') throw new AppError('LobsterAI 状态文件结构错误', 502, 'lobster_state_schema');
  const providers = [];
  for (const [key, p] of Object.entries(data?.models?.providers ?? {})) {
    if (!p || typeof p !== 'object') continue;
    providers.push({
      key,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : null,
      api: typeof p.api === 'string' ? p.api : null,
      models: Array.isArray(p.models) ? p.models.map(m => ({
        id: typeof m?.id === 'string' ? m.id : null,
        name: typeof m?.name === 'string' ? m.name : null,
        contextWindow: Number.isSafeInteger(m?.contextWindow) ? m.contextWindow : null,
        reasoning: m?.reasoning === true
      })).filter(m => m.id) : []
    });
  }
  const gateway = data?.gateway ?? {};
  return {
    mode: typeof data?.models?.mode === 'string' ? data.models.mode : null,
    providers,
    secretPresence: {
      gatewayAuthToken: typeof gateway?.auth?.token === 'string' && gateway.auth.token.length > 0,
      gatewayAuthMode: typeof gateway?.auth?.mode === 'string' ? gateway.auth.mode : null,
      providerApiKey: Object.values(data?.models?.providers ?? {}).some(p => typeof p?.apiKey === 'string' && p.apiKey.length > 0)
    }
  };
}

export async function loadLobsterState({stateFilePath = defaultLobsterStatePath(), readFileImpl} = {}) {
  if (!stateFilePath) throw new AppError('未指定 LobsterAI 状态文件路径', 400, 'lobster_state_path');
  const read = readFileImpl ?? (async p => (await readFile(p, 'utf8')));
  let raw;
  try { raw = await read(stateFilePath); } catch (e) { throw new AppError('无法读取 LobsterAI 状态文件（仅按路径引用）', 404, 'lobster_state_missing'); }
  return parseLobsterState(raw);
}

// ------------------------------------------------------------------ transport

function lobsterHeaders(secret, {json = false} = {}) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${secret.accessToken}`,
    'X-LobsterAI-Client-Version': secret.clientVersion ?? LOBSTER_CLIENT_VERSION,
    'X-LobsterAI-Client-Capabilities': secret.capabilitiesHeader ?? secret.capabilities ?? LOBSTER_CLIENT_CAPABILITIES,
    'cache-control': 'no-store',
  };
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

/**
 * Guarded transport: fixed official origin, allow-listed paths, injected fetch, timeout, redirect:error.
 * `fetchImpl` must be provided by the caller (tests inject a mock; the platform layer passes the real fetch).
 */
export async function lobsterFetch(fetchImpl, url, {method = 'GET', headers = {}, body, timeoutMs = 30000, signal} = {}) {
  const target = new URL(url);
  if (target.origin !== LOBSTER_SERVER_ORIGIN || target.username || target.password || !allowedPath(target.pathname))
    throw new AppError('LobsterAI 适配器仅连接官方固定端点', 400, 'lobster_endpoint_invalid');
  if (typeof fetchImpl !== 'function') throw new AppError('LobsterAI 网络请求需要显式注入 fetchImpl', 400, 'lobster_fetch_not_injected');
  const activeSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url, {method, headers, body, redirect: 'error', signal: activeSignal});
  } catch (e) {
    if (activeSignal.aborted || e?.name === 'AbortError') throw new AppError('LobsterAI 请求已取消或超时', 499, 'request_cancelled');
    throw new AppError('LobsterAI 官方接口连接失败或超时', 503, 'lobster_network_error');
  }
}

function allowedPath(pathname) {
  if (READ_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/api/client-activities/')) {
    const parts = pathname.split('/').filter(Boolean); // ['api','client-activities',code,…]
    if (parts.length === 3 && parts[2] === 'slot') return true;
    if (!ACTIVITY_CODE_RE.test(parts[2] ?? '')) return false;
    if (parts.length === 4 && parts[3] === 'context') return true;
    return parts.length === 5 && parts[3] === 'actions' && CHECKIN_ACTION_WHITELIST.has(parts[4]);
  }
  return false;
}

async function boundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new AppError('LobsterAI 上游返回空响应', 502, 'lobster_empty_response');
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > JSON_LIMIT) throw new AppError('LobsterAI 响应超过大小上限', 502, 'lobster_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new AppError('LobsterAI 上游 JSON 格式错误', 502, 'lobster_invalid_json'); }
}

// Official envelope {code,message,data}; code 0 = success. Activity error codes map to stable errors.
function unwrap(data) {
  if (typeof data?.code === 'number' && data.code !== 0) {
    const mapping = ACTIVITY_ERROR[data.code] ?? null;
    const error = new AppError(`LobsterAI 业务接口返回 ${data.code}${data.message ? `: ${redact(String(data.message)).slice(0, 120)}` : ''}`, mapping === 'login_required' ? 401 : 502, mapping ? `lobster_${mapping}` : 'lobster_business_error');
    error.upstreamCode = data.code;
    throw error;
  }
  return data?.data ?? data;
}

async function lobsterRequest(secret, {method = 'GET', path, query, body, fetchImpl = globalThis.fetch, timeoutMs = 30000, signal} = {}) {
  if (typeof fetchImpl !== 'function') throw new AppError('LobsterAI 网络请求需要显式注入 fetchImpl', 400, 'lobster_fetch_not_injected');
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
  const url = LOBSTER_SERVER_ORIGIN + path + (qs ? `?${qs}` : '');
  const response = await lobsterFetch(fetchImpl, url, {method, headers: lobsterHeaders(secret, {json: body !== undefined}), body: body === undefined ? undefined : JSON.stringify(body), timeoutMs, signal});
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const authFailure = response.status === 401 || response.status === 403;
    throw new AppError(`LobsterAI 官方接口请求失败 (HTTP ${response.status})`, response.status, authFailure ? 'lobster_auth_failed' : 'lobster_upstream_error');
  }
  return unwrap(await boundedJson(response));
}

// ------------------------------------------------------------------ models

/**
 * Contract `models(credential, options)`: dynamic catalog from GET /api/models/available.
 * The upstream catalog publishes NO output limit: `officialMaxTokens` stays null and the adapter exposes
 * a conservative `maxTokens` marked `maxTokensSource:'configured_default'` (never claimed as official).
 * `supportsToolCalling` is null upstream on every observed entry → tools:false rather than a guess.
 */
export async function lobsterModels(secret, {fetchImpl = globalThis.fetch, signal, timeoutMs = 30000} = {}) {
  if (typeof fetchImpl !== 'function') throw new AppError('LobsterAI 网络请求需要显式注入 fetchImpl', 400, 'lobster_fetch_not_injected');
  if (!secret?.accessToken) throw new AppError('LobsterAI 凭据不可用', 401, 'lobster_credential_missing');
  const data = await lobsterRequest(secret, {path: '/api/models/available', fetchImpl, signal, timeoutMs});
  const list = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : null;
  if (!list) throw new AppError('LobsterAI 模型目录格式错误', 502, 'lobster_catalog_schema');
  if (list.length > 200) throw new AppError('LobsterAI 模型目录超过条目上限', 502, 'lobster_catalog_too_large');
  return list.map(entry => {
    const id = typeof entry?.modelId === 'string' && entry.modelId ? entry.modelId : null;
    if (!id) return null;
    const contextWindow = Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : null; // official fact when present
    const thinkingOptions = Array.isArray(entry?.thinkingConfig?.options) ? entry.thinkingConfig.options.map(o => o?.level).filter(v => typeof v === 'string') : [];
    thinkingProfiles.set(id,thinkingOptions);
    const accessible = entry?.accessible !== false;
    return {
      id,
      name: typeof entry?.modelName === 'string' && entry.modelName ? entry.modelName : id,
      contextWindow,
      maxTokens: CONFIGURED_OUTPUT_TOKENS,
      maxTokensSource: 'configured_default',
      officialMaxTokens: null,
      tools: id === 'deepseek-flash' || entry?.supportsToolCalling === true,
      toolsSource:id === 'deepseek-flash'?'live_four_link_verified':'official_catalog',
      toolsField: id==='deepseek-flash'?'live_verified':entry?.supportsToolCalling === null || entry?.supportsToolCalling === undefined ? 'unproven' : (entry.supportsToolCalling === true ? 'true' : 'false'),
      multimodal: entry?.supportsImage === true,
      reasoning: null, isReasoning:entry?.supportsThinking===true,
      reasoningOptions: thinkingOptions,
      reasoningEffortMapping: lobsterReasoningMapping(thinkingOptions),
      reasoningMappingSource: "gateway_aliases_of_official_options",
      reasoningDefault: typeof entry?.thinkingConfig?.defaultLevel === 'string' ? entry.thinkingConfig.defaultLevel : null,
      costMultiplier: Number.isFinite(entry?.costMultiplier) ? entry.costMultiplier : null,
      accessible,
      callable: accessible && contextWindow !== null,
      callableReason: accessible ? (contextWindow === null ? 'context_window_unknown' : null) : 'upstream_restricted',
      restrictionHint: typeof entry?.restrictionHint === 'string' ? redact(entry.restrictionHint).slice(0, 200) : null,
      apiFormat: typeof entry?.apiFormat === 'string' ? entry.apiFormat : null,
      verification: 'official_catalog',
    };
  }).filter(Boolean);
}

// ------------------------------------------------------------------ balance

/**
 * Balance read: quota (free pool) + profile-summary (total). Two independent reads — either may fail
 * (e.g. a 403) without invalidating the other, and neither is allowed to invalidate the check-in
 * surface (see lobsterHealth).
 */
export async function lobsterBalance(secret, {fetchImpl = globalThis.fetch, signal, timeoutMs = 30000} = {}) {
  const parts = [];
  let quotaError = null; let profileError = null;
  try {
    const quota = await lobsterRequest(secret, {path: '/api/user/quota', fetchImpl, signal, timeoutMs});
    if (Number.isFinite(quota?.freeCreditsRemaining)) parts.push({kind: 'free', label: '免费额度', value: quota.freeCreditsRemaining, total: Number.isFinite(quota.freeCreditsTotal) ? quota.freeCreditsTotal : null, expiresAt: typeof quota.freeCreditsExpiresAt === 'string' ? quota.freeCreditsExpiresAt : null});
  } catch (error) { quotaError = {code: error.code ?? 'lobster_balance_error', status: error.status ?? 502, message: redact(error.message ?? '').slice(0, 200)}; }
  try {
    const profile = await lobsterRequest(secret, {path: '/api/user/profile-summary', fetchImpl, signal, timeoutMs});
    if (Array.isArray(profile?.creditItems)) for (const item of profile.creditItems) {
      if (typeof item?.label !== 'string' || !Number.isFinite(item?.creditsRemaining)) continue;
      // The free-pool row is already covered by the quota read; skip it here to avoid double counting.
      if (item.type === 'free') continue;
      parts.push({kind: typeof item.type === 'string' ? item.type : 'credit', label: redact(item.label).slice(0, 60), value: item.creditsRemaining, expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt : null});
    }
  } catch (error) { profileError = {code: error.code ?? 'lobster_balance_error', status: error.status ?? 502, message: redact(error.message ?? '').slice(0, 200)}; }
  const values = parts.map(p => p.value).filter(Number.isFinite);
  const value = values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 10000) / 10000 : null;
  return {
    value,
    unit: 'points',
    parts,
    note: value === null ? '官方额度接口均不可用，未估算' : '来自官方 quota/profile-summary（免费额度与奖励积分分别列示）',
    checkedIn: null, // filled by lobsterHealth once the real check-in state is known
    observedAt: new Date().toISOString(),
    services: {quota: quotaError ? quotaError.status : 200, profileSummary: profileError ? profileError.status : 200},
    errors: quotaError || profileError ? {quota: quotaError, profileSummary: profileError} : null,
  };
}

// ------------------------------------------------------------------ daily check-in

const slotQuery = secret => ({
  placement: 'desktop_sidebar',
  clientVersion: secret.clientVersion ?? LOBSTER_CLIENT_VERSION,
  containerApiVersion: '2',
  platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
});

/** Discover the activity from the official slot (the activity code is never hard-coded). */
export async function lobsterActivitySlot(secret, {fetchImpl = globalThis.fetch, signal, timeoutMs = 20000} = {}) {
  const data = await lobsterRequest(secret, {path: '/api/client-activities/slot', query: slotQuery(secret), fetchImpl, signal, timeoutMs});
  const activity = data?.activity ?? null;
  const code = typeof activity?.activityCode === 'string' ? activity.activityCode : null;
  return {
    present: code !== null,
    slotState: typeof data?.slotState === 'string' ? data.slotState : null,
    serverTime: typeof data?.serverTime === 'string' ? data.serverTime : null,
    activity: code ? {
      activityCode: code,
      configRevision: Number.isSafeInteger(activity.configRevision) ? activity.configRevision : null,
      activityType: typeof activity.activityType === 'string' ? activity.activityType : null,
      cardTitle: typeof activity.cardTitle === 'string' ? redact(activity.cardTitle).slice(0, 60) : null,
      timezone: typeof activity.timezone === 'string' ? activity.timezone : null,
      loginRequired: activity.loginRequired === true,
    } : null,
  };
}

/** Real state from the official context endpoint. */
export async function lobsterCheckinContext(secret, {activityCode, configRevision, fetchImpl, signal, timeoutMs = 20000} = {}) {
  const data = await lobsterRequest(secret, {path: `/api/client-activities/${encodeURIComponent(activityCode)}/context`, query: {configRevision}, fetchImpl, signal, timeoutMs});
  const state = data?.state ?? null;
  return {
    activityCode: typeof data?.activityCode === 'string' ? data.activityCode : activityCode,
    configRevision: Number.isSafeInteger(data?.configRevision) ? data.configRevision : configRevision,
    lifecycleState: typeof data?.lifecycleState === 'string' ? data.lifecycleState : null,
    authenticated: data?.authenticated === true,
    loginRequired: data?.loginRequired === true,
    state: state ? {
      claimedToday: state.claimedToday === true,
      completed: state.completed === true,
      claimedDays: Number.isSafeInteger(state.claimedDays) ? state.claimedDays : null,
      rewardCredits: Number.isFinite(state.rewardCredits) ? state.rewardCredits : null,
      claimedCredits: Number.isFinite(state.claimedCredits) ? state.claimedCredits : null,
      timezone: typeof state.timezone === 'string' ? state.timezone : null,
    } : null,
    actions: Array.isArray(data?.actions) ? data.actions.filter(a => typeof a === 'string') : [],
    serverTime: typeof data?.serverTime === 'string' ? data.serverTime : null,
  };
}

/** Discover activity + read its live context in one step. */
export async function lobsterCheckinState(secret, options = {}) {
  const slot = await lobsterActivitySlot(secret, options);
  if (!slot.present) return {slot, context: null, known: false};
  const context = await lobsterCheckinContext(secret, {...options, activityCode: slot.activity.activityCode, configRevision: slot.activity.configRevision});
  return {slot, context, known: true};
}

function isClaimable(context) {
  return context.lifecycleState === 'active' && context.authenticated === true &&
    context.state?.claimedToday === false && context.state?.completed === false &&
    context.actions.includes('check_in');
}

/** Contract `status`: real server state. Read-only — a claimed entry is reported as-is, no POST. */
export async function lobsterStatus(secret, task = 'daily-checkin', options = {}) {
  if (task !== 'daily-checkin') throw new AppError('LobsterAI 任务未登记', 400, 'lobster_task_unknown');
  const {slot, context, known} = await lobsterCheckinState(secret, options);
  return {
    known,
    task,
    activityCode: slot.present ? slot.activity.activityCode : null,
    configRevision: slot.present ? slot.activity.configRevision : null,
    lifecycleState: context?.lifecycleState ?? null,
    authenticated: context?.authenticated ?? null,
    claimable: known && isClaimable(context),
    claimed: context?.state?.claimedToday === true || context?.state?.completed === true,
    claimedToday: context?.state?.claimedToday ?? null,
    claimedDays: context?.state?.claimedDays ?? null,
    rewardCredits: context?.state?.rewardCredits ?? null,
    claimedCredits: context?.state?.claimedCredits ?? null,
    actionsOffered: context?.actions ?? [],
    day: dayIn(new Date(), 'Asia/Shanghai'),
    source: '/api/client-activities/slot+context',
  };
}

function idempotencyKey(activityCode) {
  const suffix = Math.random().toString(16).slice(2).padEnd(16, '0');
  return `ai-credit-${activityCode}-${Date.now().toString(36)}-${suffix}`.slice(0, 80);
}

/**
 * Contract `claim`: submit only from live server state. Already-claimed / not-claimable states return
 * WITHOUT any POST. A submitted claim is always re-verified against the context afterwards —
 * HTTP 200 alone is never reported as success. Only the official action whitelist may be submitted.
 */
export async function lobsterClaimCheckin(secret, task = 'daily-checkin', options = {}) {
  if (task !== 'daily-checkin') throw new AppError('LobsterAI 任务未登记', 400, 'lobster_task_unknown');
  const {fetchImpl} = options;
  const before = await lobsterStatus(secret, task, options);
  if (!before.known) return {...before, submitted: false, reason: 'activity_absent'};
  if (before.claimed) return {...before, submitted: false, alreadyClaimed: true};
  if (!before.claimable) return {...before, submitted: false, reason: before.authenticated === false ? 'login_required' : 'not_claimable'};
  const actionId = 'check_in';
  if (!CHECKIN_ACTION_WHITELIST.has(actionId)) throw new AppError('LobsterAI 动作不在官方白名单内', 400, 'lobster_action_rejected');
  // Fresh slot read for configRevision — never trust a stale caller-supplied revision.
  const fresh = before.configRevision === null ? await lobsterActivitySlot(secret, options) : null;
  const configRevision = before.configRevision ?? fresh?.activity?.configRevision ?? null;
  if (!Number.isSafeInteger(configRevision)) throw new AppError('LobsterAI 活动版本号未知，拒绝提交', 502, 'lobster_revision_unknown');
  const body = {configRevision, idempotencyKey: idempotencyKey(before.activityCode), payload: {}};
  let failure = null;
  try {
    await lobsterRequest(secret, {path: `/api/client-activities/${encodeURIComponent(before.activityCode)}/actions/${encodeURIComponent(actionId)}`, method: 'POST', body, fetchImpl, timeoutMs: options.timeoutMs ?? 20000, signal: options.signal});
  } catch (error) {
    failure = {code: error.code ?? 'lobster_claim_error', status: error.status ?? 502, upstreamCode: error.upstreamCode ?? null, message: redact(error.message ?? '').slice(0, 200)};
  }
  // Always re-verify against the context: the POST response is not a receipt.
  const after = await lobsterStatus(secret, task, options);
  if (after.claimed) return {...after, submitted: true, rechecked: true, actionId, idempotencyKey: body.idempotencyKey, ...(failure ? {submittedWithError: failure} : {})};
  if (failure) {
    const error = new AppError(`LobsterAI 签到未获服务端确认: ${failure.message}`, failure.status, failure.code);
    error.failure = failure; error.after = after;
    throw error;
  }
  throw new AppError('LobsterAI 签到提交后服务端状态未变化', 502, 'lobster_claim_unconfirmed');
}

// ------------------------------------------------------------------ health

/**
 * Contract `health(credential, options)`: balance {value,unit,parts,note,checkedIn},
 * capabilities {checkin,inference}, status. Balance failure and check-in failure are independent:
 * a quota/profile 403 never invalidates a successful check-in read, and vice versa.
 */
export async function lobsterHealth(secret, options = {}) {
  const [balance, checkin] = await Promise.all([
    lobsterBalance(secret, options),
    lobsterCheckinState(secret, options).then(({slot, context, known}) => ({
      known, slot, context,
      claimable: known && isClaimable(context),
      claimed: context?.state?.claimedToday === true || context?.state?.completed === true,
      error: null,
    })).catch(error => ({known: false, slot: null, context: null, claimable: false, claimed: false, error: {code: error.code ?? 'lobster_checkin_error', status: error.status ?? 502, message: redact(error.message ?? '').slice(0, 200)}})),
  ]);
  balance.checkedIn = checkin.claimed === true ? true : checkin.known ? false : null;
  const balanceFailed = balance.value === null && balance.errors !== null;
  const checkinFailed = checkin.error !== null || checkin.known !== true;
  return {
    status: balanceFailed && checkinFailed ? 'unknown' : 'authenticated',
    balance,
    checkin: {
      supported: true,
      known: checkin.known === true,
      claimed: checkin.claimed === true,
      claimable: checkin.claimable === true,
      activityCode: checkin.slot?.activity?.activityCode ?? null,
      lifecycleState: checkin.context?.lifecycleState ?? null,
      claimedDays: checkin.context?.state?.claimedDays ?? null,
      rewardCredits: checkin.context?.state?.rewardCredits ?? null,
      day: dayIn(new Date(), 'Asia/Shanghai'),
      ...(checkin.error ? {error: checkin.error} : {}),
    },
    capabilities: {checkin: true, inference: Boolean(secret?.accessToken)},
    credential: lobsterCredentialView(secret),
    descriptor,
  };
}

// ------------------------------------------------------------------ chat (OpenAI + SSE)

const CHAT_PASSTHROUGH = ['lobsterai_options','tools', 'temperature', 'top_p', 'max_tokens', 'reasoning', 'reasoning_effort', 'tool_choice', 'stop', 'presence_penalty', 'frequency_penalty', 'response_format', 'thinking'];

/**
 * Contract `chat(upstream, credential, input, signal) -> {response}`.
 * Upstream always streams; `event:error` (HTTP 200) is converted to AppError BEFORE anything is returned;
 * `delta.reasoning_content` is INCREMENTAL and passes through untouched; the transformed stream is
 * bounded (bytes + records) so a long generation can never buffer without bound.
 */
export async function lobsterChat(upstream, secret, input, signal, options = {}) {
  if(!secret?.accessToken) throw new AppError('登录凭据未就绪',401,'lobster_credential_missing');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new AppError('LobsterAI 网络请求需要显式注入 fetchImpl', 400, 'lobster_fetch_not_injected');
  const model = typeof input?.model === 'string' && input.model ? input.model : null;
  if (!model) throw new AppError('LobsterAI 聊天请求缺少 model', 400, 'lobster_chat_invalid');
  const body = {};
  for (const key of CHAT_PASSTHROUGH) if (input?.[key] !== undefined) body[key] = input[key];
  if(input.reasoning_effort == null) delete body.reasoning_effort; // JSON null is an omitted optional field.
  if(body.lobsterai_options!==undefined) {
   delete body.reasoning_effort; // Explicit native options take precedence, without a conflicting generic field.
  } else if(input.reasoning_effort != null) {
   if(!REASONING_INPUTS.has(input.reasoning_effort))throw new AppError('未知的通用推理档位',400,'lobster_reasoning_invalid');
   if(!thinkingProfiles.has(model))await lobsterModels(secret,{fetchImpl,signal});
   const choices=thinkingProfiles.get(model)??[];
   if(choices.length){
    const level=lobsterReasoningMapping(choices)[input.reasoning_effort];
    if(!level)throw new AppError('该模型未声明可映射的推理档位',400,'lobster_reasoning_invalid');
    body.lobsterai_options={version:1,thinking:{level}};delete body.reasoning_effort;
   }
  }
  if(model==='deepseek-flash' && input.reasoning_effort == null && !body.lobsterai_options)body.lobsterai_options={version:1,thinking:{level:'off'}}; // Verified gateway runtime default; explicit user settings win.
  body.max_tokens = desktopCompletionLimit(input,4096);
  body.model = model;
  body.messages = Array.isArray(input?.messages) ? input.messages : [];
  body.stream = true;
  const response = await lobsterFetch(fetchImpl, `${LOBSTER_SERVER_ORIGIN}/api/proxy/v1/chat/completions`, {method: 'POST', headers: lobsterHeaders(secret, {json: true}), body: JSON.stringify(body), timeoutMs: options.timeoutMs ?? 300000, signal});
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const authFailure = response.status === 401 || response.status === 403;
    throw new AppError(`LobsterAI 聊天接口 HTTP ${response.status}`, response.status, authFailure ? 'lobster_auth_failed' : 'lobster_chat_rejected');
  }
  if (!response.body) throw new AppError('LobsterAI 聊天接口返回空响应', 502, 'lobster_empty_response');
  return {response: await desktopSseResponse(response,{stream:input.stream===true,model,signal,prefix:"lobster"}), model};
}

/** Detect an upstream `event:error` record (the HTTP status was 200 — the payload carries the failure). */
export function sseErrorOf(record, redactMessage = redact) {
  const lines = record.split('\n');
  const events = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim());
  const dataLines = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  const event = events.length ? events[events.length - 1] : null;
  if (dataLines.length === 0) return event === 'error' ? new AppError('LobsterAI 聊天流 error 事件缺少数据', 502, 'lobster_stream_upstream_error') : null;
  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return null;
  let parsed = null;
  try { parsed = JSON.parse(payload); } catch { parsed = null; }
  const hasError = event === 'error' || parsed?.error !== undefined;
  if (!hasError) return null;
  const code = Number(parsed?.error?.code ?? parsed?.code ?? 0) || 0;
  const message = String(parsed?.error?.message ?? parsed?.message ?? '').slice(0, 200);
  const status = code === 40100 ? 401 : code === 40300 ? 403 : code === 42900 ? 429 : 502;
  return Object.assign(new AppError(`LobsterAI 聊天流错误${code ? ` ${code}` : ''}${message ? `: ${redactMessage(message)}` : ''}`, status, 'lobster_stream_upstream_error'), {upstreamCode: code || null});
}

/** Convert the upstream byte stream into OpenAI-compatible SSE. Bounded; event:error → stream error. */
export function transformSse(body, signal, limits = {}) {
  const maxBytes = limits.maxBytes ?? SSE_LIMIT;
  const maxRecords = limits.maxRecords ?? SSE_MAX_RECORDS;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader = null; let pending = ''; let finished = false; let seenDone = false; let records = 0; let bytes = 0;
  const fail = (controller, error) => { finished = true; controller.error(error); void reader?.cancel().catch(() => {}); };
  const emit = (controller, record) => {
    const error = sseErrorOf(record);
    if (error) { fail(controller, error); return false; }
    for (const line of record.split('\n')) if (line.startsWith('data:') && line.slice(5).trim() === '[DONE]') seenDone = true;
    records += 1;
    if (records > maxRecords) { fail(controller, new AppError('LobsterAI 聊天流事件过多', 502, 'lobster_stream_too_large')); return false; }
    controller.enqueue(encoder.encode(record + '\n\n'));
    return true;
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (finished) { controller.close(); return; }
          if (!reader) reader = body.getReader();
          const {done, value} = await reader.read();
          if (done) {
            if (pending.trim() && !emit(controller, pending.trim())) return;
            pending = '';
            if (!seenDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            finished = true; controller.close(); return;
          }
          bytes += value.length;
          if (bytes > maxBytes) { fail(controller, new AppError('LobsterAI 聊天流超过缓冲上限', 502, 'lobster_stream_too_large')); return; }
          pending += decoder.decode(value, {stream: true});
          let progressed = false;
          for (;;) {
            const match = /\r?\n\r?\n/.exec(pending);
            if (!match) break;
            const record = pending.slice(0, match.index);
            pending = pending.slice(match.index + match[0].length);
            progressed = true;
            if (record.trim() && !emit(controller, record.trim())) return;
          }
          if (progressed) return; // hand control back to the consumer between upstream chunks
        }
      } catch (error) {
        if (error instanceof AppError) fail(controller, error);
        else fail(controller, new AppError('LobsterAI 聊天流转换失败', 502, 'lobster_stream_error'));
      }
    },
    cancel(reason) { void reader?.cancel(reason).catch(() => {}); },
  });
  return new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'}});
}

// ------------------------------------------------------------------ provider export

export const lobsterProvider = {
  descriptor,
  resolve: lobsterResolve,
  models: lobsterModels,
  health: lobsterHealth,
  status: lobsterStatus,
  claim: lobsterClaimCheckin,
  chat: lobsterChat,
  // read-only extras
  credentialView: lobsterCredentialView,
  balance: lobsterBalance,
  activitySlot: lobsterActivitySlot,
  checkinState: lobsterCheckinState,
};
