import {desktopSseResponse} from './provider-sse.mjs';
// provider-loomy.mjs — Loomy (讯飞) provider adapter, unified-contract edition. NOT Loom/openloomi.
// Evidence (read-only; local install D:/Loomy + app.asar.unpacked source):
//  - electron/auth/auth-session-runtime.js: electron-store `name:'auth-session'`, cwd = userDataPath,
//    fields {session, userid, phone, updatedAt}; session runtime reads it on app start; login controller
//    writes it via update(session, userid, phone).
//  - electron/config-path.js: on win32 the userData path is
//      C:\Users\Public\Loomy\<sha256(username)[0:12]>\userData   (NOT %APPDATA%/Loomy)
//    → the auth-session file is <that>/auth-session.json. This is the REAL user session store.
//  - electron/points-service.js endpoints (token header, envelope {code:'000000'|desc|data}):
//      GET  /api/v1/user/identity, /api/v1/user/team-assets
//      GET  /api/v1/pet-work              (daily pet-work snapshot — 宠物打工)
//      POST /api/v1/pet-work/rewards      (body: businessDate/configVersion/reachedTierId ONLY)
//      POST /api/v1/points/first-login    (one-time), POST /api/v1/points/activation
//      GET  /api/v1/points/records, /api/v2/points/records, /api/v1/team-points/balance
//      POST /api/v1/points/redemption-codes/redeem
//    Live probe 2026-10-11: the local session file exists (session/userid present) but the server
//    answered `{"code":"100002","desc":"登录已失效"}` on every read — a STALE session. This module
//    reports that honestly; it never fabricates a login and never treats .env.prod as a session.
//  - opencode provider "imodel": @ai-sdk/openai-compatible, baseURL <origin>/loomy/integration/api/v1,
//    useSessionAuth — the app-runtime chat path. NOT live-verified here (stale session); the chat
//    surface is implemented conservatively and marked unverified_live.
import {AppError, redact, hash, rememberSecret, dayIn} from './util.mjs';
import {readFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const LOOMY_POINTS_ORIGIN = 'https://ossptest.voicecloud.cn';
export const LOOMY_API_PREFIX = '/loomy/integration/';
export const LOOMY_SUCCESS_CODES = ['000000', 0];
const JSON_LIMIT = 1024 * 1024;
const SSE_LIMIT = 8 * 1024 * 1024;
const SSE_MAX_RECORDS = 200000;

export const descriptor = Object.freeze({
  id: 'loomy',
  name: 'Loomy (讯飞)',
  authKind: 'session_token',
  checkinSupported: true, // daily mechanic = pet-work (宠物打工) snapshot + rewards; confirmed in shipped source
  checkinKind: 'pet_work',
  checkinTasks: ['pet-work', 'daily-checkin'],
  claimSupported: true, // guarded: submits only official preconditions and re-verifies the snapshot
  underlyingProvider: 'xfyun imodel gateway via voicecloud.cn integration proxy (openai-compatible, session-auth)',
  billing: 'official_points',
  byok: false,
  origin: LOOMY_POINTS_ORIGIN,
  sourceUrls: ['https://loomy.xunfei.cn/', 'https://loomy.xunfei.cn/docs/introduction'],
});

export const LOOMY_MODEL_FAMILIES = ['讯飞星火', 'DeepSeek', '通义千问', '豆包', 'Kimi', 'MiniMax'];

// ------------------------------------------------------------------ paths

/** Enumerate real userData dirs: C:\Users\Public\Loomy\<hash>\userData (win32) or explicit override. */
export async function findLoomyAuthSessionFiles({root = 'C:/Users/Public/Loomy'} = {}) {
  const found = [];
  if (process.env.LOOMY_AUTH_SESSION_FILE) found.push(process.env.LOOMY_AUTH_SESSION_FILE.replace(/\\/g, '/'));
  if (process.platform === 'win32' || process.env.LOOMY_SCAN_PUBLIC === '1') {
    try {
      for (const dir of await readdir(root)) {
        const candidate = `${root}/${dir}/userData/auth-session.json`;
        if (existsSync(candidate)) found.push(candidate);
      }
    } catch { /* root missing: fall through */ }
  }
  const appData = (process.env.APPDATA ?? '').replace(/\\/g, '/');
  if (appData) {
    const legacy = `${appData}/Loomy/auth-session.json`;
    if (existsSync(legacy)) found.push(legacy);
  }
  return [...new Set(found)];
}

export async function defaultLoomyAuthSessionPath() {
  const files = await findLoomyAuthSessionFiles();
  return files[0] ?? '';
}

// Legacy surface kept for compatibility: the encrypted envelope is never decrypted here.
export function defaultLoomyEnvPath() { return 'D:/Loomy/resources/.env.prod'; }

export async function loomyEnvPresence({envFilePath = defaultLoomyEnvPath(), readFileImpl = (p) => readFile(p, 'utf8')} = {}) {
  try {
    const text = await readFileImpl(envFilePath);
    return {present: true, encryptedEnvelope: text.startsWith('LOOMYENC1:'), plaintextReadable: !text.startsWith('LOOMYENC1:'), bytes: Buffer.byteLength(text, 'utf8'), note: '加密封装由应用密钥解密；本模块不读取解密后的任何凭据'};
  } catch { return {present: false, encryptedEnvelope: null, plaintextReadable: null, bytes: null, note: '未找到 Loomy 环境文件'}; }
}

// ------------------------------------------------------------------ credential

const stableHash = value => `sha256:${hash('loomy:' + String(value)).slice(0, 24)}`;

/**
 * Read the REAL user session from the electron-store auth-session file. Read-only; every call re-reads.
 * `userid` is consumed in memory only to derive the stable principal — it never leaves this function.
 */
export async function readLoomySession({file, readFileImpl} = {}) {
  const path = file ?? await defaultLoomyAuthSessionPath();
  if (!path) throw new AppError('未找到 Loomy auth-session.json（用户数据目录不存在）', 401, 'loomy_credential_missing');
  const read = readFileImpl ?? (async p => (await readFile(p, 'utf8')));
  let raw;
  try { raw = await read(path); } catch { throw new AppError('Loomy auth-session.json 不可读', 401, 'loomy_credential_missing'); }
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw; } catch { throw new AppError('Loomy auth-session.json 解析失败', 401, 'loomy_session_parse'); }
  const accessToken = typeof data?.session === 'string' ? data.session.trim() : '';
  const userid = typeof data?.userid === 'string' ? data.userid.trim() : '';
  if (!accessToken) throw new AppError('Loomy 本地会话为空（未登录）', 401, 'loomy_credential_missing');
  const principal = userid ? stableHash(userid) : stableHash('session:' + hash(accessToken).slice(0, 24)); // no raw id leaves here
  return {
    accessToken,
    principal,
    principalField: userid ? 'userid' : 'session_fingerprint',
    phonePresent: typeof data?.phone === 'string' && data.phone.trim().length > 0,
    updatedAt: Number.isFinite(data?.updatedAt) ? new Date(data.updatedAt).toISOString() : null,
    source: 'electron_store_auth_session',
    filePath: path,
  };
}

/** Public view: presence + stable principal only. No session token, no userid/phone. */
export function loomyCredentialView(secret) {
  if (!secret?.accessToken) return {present: false, status: 'credential_missing', principal: null};
  return {
    present: true,
    authKind: 'session_token',
    principal: secret.principal,
    principalField: secret.principalField,
    phonePresent: secret.phonePresent === true,
    updatedAt: secret.updatedAt ?? null,
    source: secret.source,
  };
}

/**
 * Contract `resolve(account, config) -> private credential`.
 * Honors `account.credentials.file|path`: direct auth-session.json path, or a settings json
 * (`{loomy:{authSessionFile}}`). Missing file → 401 credential_missing (status:'credential_missing'
 * in health) — a login is never fabricated and .env.prod is never treated as the user session.
 */
export async function loomyResolve(account, config = {}) {
  const ref = account?.credentials?.file ?? account?.credentials?.path ?? null;
  const refPath = ref && ref !== 'auto' ? (typeof config?.path === 'function' ? config.path(ref) : ref) : null;
  let file = refPath ?? null;
  let baseUrl = null;
  if (refPath) {
    try {
      const parsed = JSON.parse((await readFile(refPath, 'utf8')).replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && typeof parsed.session !== 'string' && parsed?.loomy) {
        file = parsed.loomy.authSessionFile ?? null;
        baseUrl = typeof parsed.loomy.baseUrl === 'string' ? parsed.loomy.baseUrl : null;
        if (file && typeof config?.path === 'function') file = config.path(file);
      }
    } catch (error) {
      // Not JSON or unreadable: fall back to treating the reference itself as the session file path.
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new AppError('Loomy 凭据配置不可读', 401, 'loomy_credential_file_unavailable');
      if (error?.code === 'ENOENT') throw new AppError('Loomy 凭据配置未找到（按路径引用）', 401, 'loomy_credential_file_unavailable');
    }
  }
  const secret = await readLoomySession({file: file ?? undefined});
  rememberSecret(secret.accessToken);
  return {...secret, credential: loomyCredentialView(secret), baseUrl: baseUrl ?? config?.baseUrl ?? LOOMY_POINTS_ORIGIN};
}

// ------------------------------------------------------------------ transport

function loomyHeaders(secret, {json = false} = {}) {
  const headers = {accept: 'application/json', token: secret.accessToken};
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

export async function loomyFetch(fetchImpl, path, {method = 'GET', token, body, timeoutMs = 30000, signal} = {}) {
  const url = new URL(LOOMY_POINTS_ORIGIN + path);
  if (url.origin !== LOOMY_POINTS_ORIGIN || url.username || url.password || !url.pathname.startsWith(LOOMY_API_PREFIX))
    throw new AppError('Loomy 适配器仅连接官方固定端点', 400, 'loomy_endpoint_invalid');
  if (typeof fetchImpl !== 'function') throw new AppError('Loomy 网络请求需要显式注入 fetchImpl', 400, 'loomy_fetch_not_injected');
  if (token) rememberSecret(token);
  const headers = {accept: 'application/json'};
  if (token) headers.token = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const activeSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url.href, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: activeSignal});
  } catch (e) {
    if (activeSignal.aborted || e?.name === 'AbortError') throw new AppError('Loomy 请求已取消或超时', 499, 'request_cancelled');
    throw new AppError('Loomy 官方接口连接失败或超时', 503, 'loomy_network_error');
  }
}

async function boundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new AppError('Loomy 上游返回空响应', 502, 'loomy_empty_response');
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > JSON_LIMIT) throw new AppError('Loomy 响应超过大小上限', 502, 'loomy_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Loomy 上游 JSON 格式错误', 502, 'loomy_invalid_json'); }
}

// Envelope {code, desc, trace_id, data}; '000000' = success. 100002 = session stale — a first-class state.
function unwrap(data) {
  const code = data?.code;
  if (code !== undefined && !LOOMY_SUCCESS_CODES.includes(code)) {
    const message = redact(String(data?.desc ?? data?.message ?? '')).slice(0, 200);
    if (String(code) === '100002') throw new AppError(`Loomy 登录已失效（本地会话过期）: ${message}`, 401, 'loomy_session_expired');
    const error = new AppError(`Loomy 业务接口返回 ${code}${message ? `: ${message}` : ''}`, 502, 'loomy_business_error');
    error.upstreamCode = code;
    throw error;
  }
  return data;
}

export async function loomyRequest(secret, {method = 'GET', path, query, body, fetchImpl = globalThis.fetch, timeoutMs = 30000, signal} = {}) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
  const response = await loomyFetch(fetchImpl, path + (qs ? `?${qs}` : ''), {method, token: secret?.accessToken, body, timeoutMs, signal});
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(`Loomy 官方接口请求失败 (HTTP ${response.status})`, response.status, response.status === 401 || response.status === 403 ? 'loomy_auth_failed' : 'loomy_upstream_error');
  }
  return unwrap(await boundedJson(response));
}

// ------------------------------------------------------------------ reads

/** Identity check. Presence booleans only — no names/ids are surfaced. */
export async function loomyIdentity(secret, options = {}) {
  const data = await loomyRequest(secret, {path: '/loomy/integration/api/v1/user/identity', ...options});
  const d = data?.data ?? {};
  return {present: Object.keys(d).length > 0 || data?.code === '000000', fieldNames: Object.keys(d).slice(0, 20)};
}

/**
 * Pet-work (宠物打工) daily snapshot. Field extraction is defensive: unknown shapes are reported,
 * never guessed. `keys` carries the top-level names for diagnostics.
 */
export async function loomyPetWork(secret, options = {}) {
  const data = await loomyRequest(secret, {path: '/loomy/integration/api/v1/pet-work', ...options});
  const d = data?.data ?? {};
  const claimMarkers = ['claimedToday', 'todayRewardClaimed', 'rewarded', 'claimed'].filter(k => typeof d?.[k] === 'boolean');
  const claimed = claimMarkers.length ? claimMarkers.some(k => d[k] === true) : null;
  const tiers = Array.isArray(d?.tiers) ? d.tiers.slice(0, 50).map(t => ({
    id: typeof t?.id === 'string' || typeof t?.id === 'number' ? t.id : (typeof t?.tierId === 'string' || typeof t?.tierId === 'number' ? t.tierId : null),
    label: typeof t?.label === 'string' ? redact(t.label).slice(0, 60) : (typeof t?.name === 'string' ? redact(t.name).slice(0, 60) : null),
    points: Number.isFinite(t?.points) ? t.points : null,
  })) : [];
  return {
    businessDate: typeof d?.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.businessDate) ? d.businessDate : null,
    configVersion: typeof d?.configVersion === 'string' || Number.isFinite(d?.configVersion) ? d.configVersion : null,
    reachedTierId: typeof d?.reachedTierId === 'string' || Number.isFinite(d?.reachedTierId) ? d.reachedTierId : null,
    tiers,
    claimMarkers,
    claimed,
    balanceCandidate: Number.isFinite(d?.currentBalance) ? d.currentBalance : (Number.isFinite(d?.balance) ? d.balance : null),
    keys: Object.keys(d ?? {}).slice(0, 30),
  };
}

/** Records read (read-only). Kept as a helper; balance is NOT derived from records. */
export async function loomyPointsRecords(secret, {version = 1, query = {}, ...options} = {}) {
  const v = version === 2 ? 'v2' : 'v1';
  const data = await loomyRequest(secret, {path: `/loomy/integration/api/${v}/points/records`, query, ...options});
  return data;
}

// ------------------------------------------------------------------ status / claim (pet-work)

function normalizeTask(task) {
  if (task === 'pet-work' || task === 'daily-checkin') return 'pet-work';
  throw new AppError('Loomy 任务未登记', 400, 'loomy_task_unknown');
}

/** Contract `status`: real snapshot state; claimable only on an explicit server-side marker. */
export async function loomyStatus(secret, task = 'pet-work', options = {}) {
  normalizeTask(task);
  const snapshot = await loomyPetWork(secret, options);
  const claimable = snapshot.claimed === false && snapshot.reachedTierId !== null && snapshot.businessDate !== null && snapshot.configVersion !== null;
  return {
    known: true,
    task: 'pet-work',
    businessDate: snapshot.businessDate,
    configVersion: snapshot.configVersion,
    reachedTierId: snapshot.reachedTierId,
    tiers: snapshot.tiers.length,
    claimed: snapshot.claimed,
    claimable,
    ...(snapshot.claimed === null ? {claimableReason: 'snapshot_claim_marker_unverified'} : {}),
    day: dayIn(new Date(), 'Asia/Shanghai'),
    source: '/api/v1/pet-work',
  };
}

/**
 * Contract `claim`: submits ONLY the three server-defined fields with values taken from the live
 * snapshot (or explicit caller values), then re-reads the snapshot. If the fresh snapshot does not
 * carry a recognized claimed-marker, the result is reported as submitted-but-unconfirmed — HTTP 200
 * is never converted into a success claim.
 */
export async function loomyClaim(secret, task = 'pet-work', options = {}) {
  normalizeTask(task);
  const before = await loomyStatus(secret, task, options);
  if (before.claimed === true) return {...before, submitted: false, alreadyClaimed: true};
  const businessDate = options.businessDate ?? before.businessDate;
  const configVersion = options.configVersion ?? before.configVersion;
  const reachedTierId = options.reachedTierId ?? before.reachedTierId;
  if (businessDate === null || configVersion === null || reachedTierId === null)
    return {...before, submitted: false, reason: 'preconditions_missing', note: '需要服务端快照提供 businessDate/configVersion/reachedTierId'};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate)))
    return {...before, submitted: false, reason: 'business_date_invalid'};
  const body = {businessDate, configVersion, reachedTierId}; // exactly the three official fields
  let failure = null;
  try {
    await loomyRequest(secret, {path: '/loomy/integration/api/v1/pet-work/rewards', method: 'POST', body, ...options});
  } catch (error) {
    failure = {code: error.code ?? 'loomy_claim_error', status: error.status ?? 502, message: redact(error.message ?? '').slice(0, 200)};
  }
  const after = await loomyStatus(secret, task, options).catch(() => null);
  if (after?.claimed === true) return {...after, submitted: true, rechecked: true};
  if (failure) {
    const error = new AppError(`Loomy 打工奖励未获服务端确认: ${failure.message}`, failure.status, failure.code);
    error.failure = failure; error.after = after;
    throw error;
  }
  return {...(after ?? before), submitted: true, rechecked: true, confirmed: false, reason: 'snapshot_claim_marker_unverified'};
}

// ------------------------------------------------------------------ health

function errorView(error) {
  return {code: error?.code ?? 'loomy_error', status: error?.status ?? 502, message: redact(error?.message ?? '').slice(0, 200)};
}

/**
 * Contract `health`: {balance:{value,unit,parts,note,checkedIn}, capabilities:{checkin,inference}, status}.
 * Identity failure and pet-work failure are independent; a stale session (100002) is reported as
 * 'rejected' with the real reason — nothing is fabricated.
 */
export async function loomyHealth(secret, options = {}) {
  const base = {
    balance: {value: null, unit: 'points', parts: [], note: '官方未提供个人余额只读端点（个人侧余额未证实；团队 balance 端点不等价）', checkedIn: null},
    capabilities: {checkin: true, inference: false},
  };
  if (!secret?.accessToken) {
    return {...base, status: 'credential_missing', credential: loomyCredentialView(secret), services: {identity: null, petWork: null}};
  }
  let identity = null; let identityError = null;
  try { identity = await loomyIdentity(secret, options); } catch (error) { identityError = errorView(error); }
  let pet = null; let petError = null;
  try { pet = await loomyPetWork(secret, options); } catch (error) { petError = errorView(error); }
  const rejected = [identityError, petError].filter(Boolean);
  const expired = rejected.some(e => e.code === 'loomy_session_expired');
  const status = identity === null && pet === null
    ? (expired ? 'session_expired' : 'unknown')
    : (identityError === null ? 'authenticated' : 'degraded');
  if (pet?.claimed === true) base.balance.checkedIn = true;
  else if (pet?.claimed === false) base.balance.checkedIn = false;
  if (pet?.balanceCandidate !== null && pet?.balanceCandidate !== undefined) {
    base.balance.value = pet.balanceCandidate;
    base.balance.parts = [{kind: 'snapshot', label: 'pet-work 快照余额', value: pet.balanceCandidate}];
    base.balance.note = '来自官方 pet-work 快照的余额字段';
  }
  return {
    ...base,
    status,
    credential: loomyCredentialView(secret),
    checkin: {supported: true, kind: 'pet_work', known: pet !== null, claimed: pet?.claimed ?? null, businessDate: pet?.businessDate ?? null, ...(petError ? {error: petError} : {})},
    services: {identity: identity ? 'ok' : identityError?.code ?? null, petWork: pet ? 'ok' : petError?.code ?? null},
    errors: rejected.length ? {identity: identityError, petWork: petError} : null,
    note: expired ? '本地 auth-session 会话已被服务端拒绝（100002 登录已失效）；请在 Loomy 客户端重新登录' : undefined,
  };
}

// ------------------------------------------------------------------ models

/** Catalog from official app-runtime model families. Capacity unverified → null, callable:false. */
export function loomyModels() { return []; } // No verified model IDs: branding families are not API model IDs.

// ------------------------------------------------------------------ chat

/**
 * App-runtime chat path (openai-compatible via voicecloud integration proxy with the session token).
 * NOT live-verified (the local session is stale): implemented conservatively; a JSON envelope error
 * becomes an AppError, an SSE body is passed through with bounds, and the live status is documented
 * as unverified_live. Only servers whose response is OpenAI-shaped are accepted.
 */
export async function loomyChat(upstream, secret, input, signal, options = {}) {
  if(!secret?.accessToken) throw new AppError('登录凭据未就绪',401,'loomy_credential_missing');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new AppError('Loomy 网络请求需要显式注入 fetchImpl', 400, 'loomy_fetch_not_injected');
  const model = typeof input?.model === 'string' && input.model ? input.model : null;
  if (!model) throw new AppError('Loomy 聊天请求缺少 model', 400, 'loomy_chat_invalid');
  const body = {...input, model, stream: input?.stream !== false ? true : false};
  const response = await loomyFetch(fetchImpl, '/loomy/integration/api/v1/chat/completions', {method: 'POST', token: secret?.accessToken, body, timeoutMs: options.timeoutMs ?? 300000, signal});
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(`Loomy 聊天接口 HTTP ${response.status}`, response.status, response.status === 401 || response.status === 403 ? 'loomy_auth_failed' : 'loomy_chat_rejected');
  }
  const ctype = response.headers?.get?.('content-type') ?? '';
  if (ctype.includes('text/event-stream')) return {response: await desktopSseResponse(response,{stream:input.stream===true,model,signal,prefix:'loomy'}), model, verified:'unverified_live'};
  // Non-SSE: the JSON envelope must be checked for business errors before it is returned.
  const data = await boundedJson(response);
  unwrap(data);
  return {response: new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}}), model, verified: 'unverified_live'};
}

export function transformLoomySse(body, signal, limits = {}) {
  const maxBytes = limits.maxBytes ?? SSE_LIMIT;
  const maxRecords = limits.maxRecords ?? SSE_MAX_RECORDS;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader = null; let pending = ''; let finished = false; let seenDone = false; let records = 0; let bytes = 0;
  const fail = (controller, error) => { finished = true; controller.error(error); void reader?.cancel().catch(() => {}); };
  const emit = (controller, record) => {
    // Loomy JSON envelopes inside SSE carry business codes; convert failures to AppError.
    for (const line of record.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { seenDone = true; continue; }
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.code !== undefined && !LOOMY_SUCCESS_CODES.includes(parsed.code)) { fail(controller, Object.assign(new AppError(`Loomy 聊天流业务错误 ${parsed.code}`, String(parsed.code) === '100002' ? 401 : 502, String(parsed.code) === '100002' ? 'loomy_session_expired' : 'loomy_business_error'), {upstreamCode: parsed.code})); return false; }
      } catch { /* non-JSON chunk: pass through */ }
    }
    records += 1;
    if (records > maxRecords) { fail(controller, new AppError('Loomy 聊天流事件过多', 502, 'loomy_stream_too_large')); return false; }
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
          if (bytes > maxBytes) { fail(controller, new AppError('Loomy 聊天流超过缓冲上限', 502, 'loomy_stream_too_large')); return; }
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
          if (progressed) return;
        }
      } catch (error) {
        fail(controller, error instanceof AppError ? error : new AppError('Loomy 聊天流转换失败', 502, 'loomy_stream_error'));
      }
    },
    cancel(reason) { void reader?.cancel(reason).catch(() => {}); },
  });
  return new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'}});
}

// ------------------------------------------------------------------ provider export

export const loomyProvider = {
  descriptor,
  resolve: loomyResolve,
  models: loomyModels,
  health: loomyHealth,
  status: loomyStatus,
  claim: loomyClaim,
  chat: loomyChat,
  // read-only extras
  credentialView: loomyCredentialView,
  identity: loomyIdentity,
  petWork: loomyPetWork,
  findAuthSessionFiles: findLoomyAuthSessionFiles,
};
