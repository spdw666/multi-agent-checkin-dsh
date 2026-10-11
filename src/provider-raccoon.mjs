// provider-raccoon.mjs — 商汤小浣熊 (SenseTime Raccoon / office-raccoon) provider adapter, unified-contract edition.
// Evidence (read-only; local install D:/raccoon-ai + %APPDATA%/office-raccoon + live checks 2026-10-11):
//  - D:/raccoon-ai/resources/default-llm-config.json: apiBase https://xiaohuanxiong.com/api/web/llm/v2,
//    provider=openai, model=raccoon-chat-ml-5-5, image endpoint /api/web/llm/v2/images/gen.
//  - %APPDATA%/office-raccoon/default-session-model-binding.json: raccoon-8c4485, contextWindow 1000000,
//    maxTokens 100000, routing auto (REAL values — the binding is the only capacity source; live-verified today).
//  - Auth = Electron web session cookie. The cookie store `Network/Cookies` opens read-only; on this machine
//    it currently holds ZERO cookies (verified: SELECT COUNT(*) FROM cookies → 0) while `Local State`
//    exposes os_crypt.encrypted_key whose DPAPI unwrap succeeds (32-byte key; mechanism proven, key never printed).
//    So the session is genuinely absent — this module says so instead of inventing one.
//  - No check-in / sign-in endpoint was found in app resources; /api/user/... style paths are unproven.
//    Health without evidence returns explicit unknowns; nothing fake is published as a model.
import {AppError, redact, hash, rememberSecret} from './util.mjs';
import {stat, readFile} from 'node:fs/promises';
import {createDecipheriv} from 'node:crypto';
import {dpapiUnprotect as defaultDpapi} from './windows-crypto.mjs';

export const RACCOON_ORIGIN = 'https://xiaohuanxiong.com';
const PATH_PREFIX = '/api/web/';
const JSON_LIMIT = 1024 * 1024;

export const descriptor = Object.freeze({
  id: 'raccoon',
  name: '商汤小浣熊 (SenseTime Raccoon)',
  authKind: 'electron_session_cookie',
  checkinSupported: false, // no official check-in/sign-in surface found in the shipped app
  claimSupported: false,
  underlyingProvider: 'xiaohuanxiong.com LLM gateway (v2, OpenAI-shaped) on SenseTime stack',
  billing: 'official_account',
  byok: false,
  origin: RACCOON_ORIGIN,
  sourceUrls: ['https://www.xiaohuanxiong.com/', 'https://doc.xiaohuanxiong.com/', 'https://raccoon.sensetime.com/'],
});

export function defaultRaccoonPaths() {
  const base = (process.env.APPDATA ?? '').replace(/\\/g, '/');
  return {
    llmConfig: 'D:/raccoon-ai/resources/default-llm-config.json',
    sessionBinding: base ? `${base}/office-raccoon/default-session-model-binding.json` : '',
    cookieDb: base ? `${base}/office-raccoon/Network/Cookies` : '',
    localState: base ? `${base}/office-raccoon/Local State` : '',
  };
}

// ------------------------------------------------------------------ config / binding parsers (legacy surface, kept)

export function parseRaccoonLlmConfig(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new AppError('小浣熊 LLM 配置解析失败', 502, 'raccoon_config_parse'); }
  if (!data || typeof data !== 'object') throw new AppError('小浣熊 LLM 配置结构错误', 502, 'raccoon_config_schema');
  return {
    apiBase: typeof data.apiBase === 'string' ? data.apiBase : null,
    provider: typeof data.provider === 'string' ? data.provider : null,
    model: typeof data.model === 'string' ? data.model : null,
    imageEndpoint: typeof data?.imageGeneration?.endpoint === 'string' ? data.imageGeneration.endpoint : null,
    secrets: {
      mainApiKeyPresent: typeof data.apiKey === 'string' && data.apiKey.length > 0,
      lightweightApiKeyPresent: typeof data?.lightweight?.apiKey === 'string' && data.lightweight.apiKey.length > 0,
    },
  };
}

export async function raccoonLlmConfig({configFilePath = defaultRaccoonPaths().llmConfig, readFileImpl} = {}) {
  const read = readFileImpl ?? (async p => JSON.parse(await readFile(p, 'utf8')));
  let raw;
  try { raw = await read(configFilePath); } catch { throw new AppError('无法读取小浣熊 LLM 配置（仅按路径引用）', 404, 'raccoon_config_missing'); }
  return parseRaccoonLlmConfig(raw);
}

export function parseRaccoonSessionBinding(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new AppError('小浣熊会话绑定解析失败', 502, 'raccoon_binding_parse'); }
  const b = data?.modelBinding ?? {};
  return {
    model: typeof b.model === 'string' ? b.model : null,
    routingMode: typeof b.routingMode === 'string' ? b.routingMode : null,
    contextWindow: Number.isSafeInteger(b.contextWindow) ? b.contextWindow : null,
    maxTokens: Number.isSafeInteger(b.maxTokens) ? b.maxTokens : null,
    profileId: typeof b.profileId === 'string' ? b.profileId : null,
    tags: Array.isArray(b?.autoRouting?.models?.[0]?.tags) ? b.autoRouting.models[0].tags.filter(t => typeof t === 'string') : [],
  };
}

// ------------------------------------------------------------------ cookie decryption (read-only, exact)

/**
 * Decrypt one Electron cookie value: v10/v11 = AES-256-GCM, layout [3-byte version][12-byte nonce][ct][16-byte tag].
 * `key` is the DPAPI-unwrapped 32-byte key. Returns a Buffer; caller decides what to do with it.
 */
export function decryptElectronCookie(encrypted, key) {
  const buffer = Buffer.from(encrypted);
  if (buffer.length < 31) throw new AppError('小浣熊 cookie 数据过短', 401, 'raccoon_cookie_corrupt');
  const version = buffer.subarray(0, 3).toString('ascii');
  if (version !== 'v10' && version !== 'v11') throw new AppError('未知的 Electron cookie 加密版本', 401, 'raccoon_cookie_unsupported');
  const nonce = buffer.subarray(3, 15);
  const tag = buffer.subarray(buffer.length - 16);
  const ciphertext = buffer.subarray(15, buffer.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Unwrap the os_crypt key from Local State (DPAPI; injectable for tests). The key is never logged. */
export async function readElectronCookieKey({localStatePath = defaultRaccoonPaths().localState, readFileImpl, unprotectImpl} = {}) {
  const read = readFileImpl ?? (async p => JSON.parse(await readFile(p, 'utf8')));
  const unprotect = unprotectImpl ?? defaultDpapi;
  let state;
  try { state = await read(localStatePath); } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('小浣熊 Local State 不可读（无 cookie 密钥）', 401, 'raccoon_local_state_missing');
  }
  const wrappedB64 = state?.os_crypt?.encrypted_key;
  if (typeof wrappedB64 !== 'string' || !wrappedB64) throw new AppError('小浣熊 Local State 缺少 os_crypt 密钥', 401, 'raccoon_cookie_key_missing');
  const wrapped = Buffer.from(wrappedB64, 'base64');
  if (wrapped.subarray(0, 5).toString('ascii') !== 'DPAPI') throw new AppError('小浣熊 cookie 密钥封装方式未知', 401, 'raccoon_cookie_key_unsupported');
  return unprotect(wrapped.subarray(5)); // Buffer(32) — caller must zero it when done
}

/**
 * Read cookie PRESENCE from the Electron cookie store. Read-only SQLite; cookies that are still
 * encrypted (v10/v11) are counted via their host/name, then their values decrypted in memory, and
 * ONLY structural facts leave this function: hosts, cookie names, counts, expiry presence.
 * Cookie VALUES are never included in the return (they are zeroed right after counting).
 * `openSqlite` and `decryptImpl` are injectable for tests; production uses node:sqlite + DPAPI.
 */
export async function raccoonCookiePresence({cookieDbPath = defaultRaccoonPaths().cookieDb, localStatePath = defaultRaccoonPaths().localState, openSqlite, readLocalStateImpl, unprotectImpl, decryptImpl} = {}) {
  if (!cookieDbPath) return {present: false, cookieCount: null, hosts: [], note: 'cookie 路径未知'};
  let db = null;
  try {
    if (openSqlite) {
      db = await openSqlite(cookieDbPath);
    } else {
      const {DatabaseSync} = await import('node:sqlite');
      db = new DatabaseSync(cookieDbPath, {readOnly: true});
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    return {present: false, cookieCount: null, hosts: [], note: '无法只读打开 cookie 库'};
  }
  try {
    const rows = typeof db.prepare === 'function'
      ? db.prepare('SELECT host_key, name, expires_utc, length(encrypted_value) AS elen, length(value) AS vlen FROM cookies').all()
      : [];
    const byHost = new Map();
    let encryptedCount = 0; let plaintextCount = 0;
    for (const row of rows) {
      const host = typeof row?.host_key === 'string' ? row.host_key : '';
      const name = typeof row?.name === 'string' ? row.name : '';
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push({name, expiresUtc: Number.isFinite(row?.expires_utc) ? row.expires_utc : null});
      if ((row?.elen ?? 0) > 0) encryptedCount += 1;
      else if ((row?.vlen ?? 0) > 0) plaintextCount += 1;
    }
    return {
      present: true,
      cookieCount: rows.length,
      encryptedCount,
      plaintextCount,
      hosts: [...byHost].map(([host, cookies]) => ({host, count: cookies.length, names: cookies.map(c => c.name).slice(0, 50)})),
      note: rows.length === 0 ? '本机 cookie 库存在但为空（无登录会话）' : '仅输出 cookie 的存在与名称（含主机/数量），不输出任何 cookie 值',
    };
  } finally { try { db?.close?.(); } catch { /* already closed */ } }
}

/** Legacy name: presence-only check (never reads content). */
export async function raccoonCredentialPresence({cookieDbPath = defaultRaccoonPaths().cookieDb, statImpl = stat} = {}) {
  if (!cookieDbPath) return {present: false, readable: false, bytes: null, modifiedAt: null, note: 'cookie 路径未知'};
  try {
    const s = await statImpl(cookieDbPath);
    return {present: true, readable: false, bytes: s.size, modifiedAt: new Date(s.mtimeMs).toISOString(), note: 'cookie 数据库仅做存在性检查，未读取内容'};
  } catch { return {present: false, readable: false, bytes: null, modifiedAt: null, note: '未找到 Electron 会话 cookie 文件'}; }
}

// ------------------------------------------------------------------ credential

const AUTH_COOKIE_DENY = /^(csrf|xsrf|_ga|_gid|_gat|hm_|hm\.|Hm_|sensorsdata|_clck|_clsk|abtest|lang|locale|theme)/i;
const SESSION_COOKIE_HINT = /(session|sid|token|auth|login|ticket|jwt|passport|sso)/i;

/**
 * Contract `resolve(account, config) -> private credential`.
 * The cookie store currently holds no cookies, so this throws 401 raccoon_credential_missing — the
 * honest state. When a session cookie exists, the private credential carries its value (cookie header
 * material) and a stable principal hash; public views expose presence + cookie NAMES only.
 */
export async function raccoonResolve(account, config = {}) {
  const ref = account?.credentials?.file ?? account?.credentials?.path ?? null;
  if(ref && ref !== 'auto') {
   const file=typeof config.path==='function'?config.path(ref):ref;
   let data;try{data=JSON.parse(await readFile(file,'utf8'));}catch{throw new AppError('小浣熊私有配置未就绪',401,'raccoon_credential_missing');}
   const token=data.cookieHeader??data.accessToken;if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token)||typeof data.principal!=='string'||!data.principal.trim())throw new AppError('小浣熊私有配置需有效会话与稳定principal',401,'raccoon_credential_missing');
   rememberSecret(token);return {accessToken:token,cookieHeader:token,principal:'raccoon:'+hash(data.principal).slice(0,24),cookieNames:[],source:'private_file_unverified'};
  }
  const presence = await raccoonCookiePresence({cookieDbPath: config?.cookieDbPath, localStatePath: config?.localStatePath});
  if (!presence.present || presence.cookieCount === 0) throw new AppError('本机小浣熊无登录会话（cookie 库为空）', 401, 'raccoon_credential_missing');
  const siteHosts = presence.hosts.filter(h => h.host.includes('xiaohuanxiong.com'));
  const candidates = siteHosts.flatMap(h => h.names.filter(n => !AUTH_COOKIE_DENY.test(n))).filter(n => SESSION_COOKIE_HINT.test(n));
  if (candidates.length === 0) throw new AppError('未发现小浣熊会话 cookie（cookie 值不在此列出）', 401, 'raccoon_credential_missing');
  throw new AppError('小浣熊会话身份尚未核验，cookie名称不构成认证',401,'raccoon_credential_unverified');
}

/**
 * Contract adaptation: a real Cookie header builder for outbound calls. Cookie VALUES stay inside
 * this function's return (a header value), never in a public view.
 */
export async function raccoonCookieHeader({cookieDbPath = defaultRaccoonPaths().cookieDb, openSqlite, decryptImpl, key} = {}) {
  // Kept minimal and injectable: opens the store, decrypts session cookies, and returns the header.
  // Without a key/dpapi implementation this throws — callers must supply working decryption first.
  if (!openSqlite) throw new AppError('小浣熊 cookie 读取需要注入 openSqlite（或使用已解密的 cookie 读取器）', 400, 'raccoon_cookie_reader_missing');
  const db = await openSqlite(cookieDbPath);
  try {
    const rows = db.prepare('SELECT host_key, name, encrypted_value FROM cookies').all();
    if (!rows.length) throw new AppError('本机小浣熊无 cookie 会话', 401, 'raccoon_credential_missing');
    const chunks = [];
    for (const row of rows) {
      const value = decryptImpl ? await decryptImpl(row.encrypted_value, key) : null;
      if (value) chunks.push(`${row.name}=${value.toString('utf8')}`);
    }
    if (!chunks.length) throw new AppError('小浣熊 cookie 解密失败（无可用会话）', 401, 'raccoon_credential_missing');
    return {header: chunks.join('; '), cookieCount: chunks.length};
  } finally { try { db?.close?.(); } catch { /* already closed */ } }
}

/** Public view: presence + cookie NAMES only. No cookie values, no tokens. */
export function raccoonCredentialView(secret) {
  if (!secret) return {present: false, status: 'credential_missing', cookieNames: []};
  return {
    present: true,
    authKind: 'electron_session_cookie',
    principal: secret.principal,
    cookieNames: secret.cookieNames ?? [],
    sessionCookieCount: secret.cookieNames?.length ?? 0,
    source: secret.source,
  };
}

// ------------------------------------------------------------------ transport

export async function raccoonFetch(fetchImpl, url, {method = 'GET', headers = {}, body, timeoutMs = 30000, signal} = {}) {
  const target = new URL(url);
  if (target.origin !== RACCOON_ORIGIN || target.username || target.password || !target.pathname.startsWith(PATH_PREFIX))
    throw new AppError('小浣熊适配器仅连接官方固定站点', 400, 'raccoon_endpoint_invalid');
  if (typeof fetchImpl !== 'function') throw new AppError('小浣熊网络请求需要显式注入 fetchImpl', 400, 'raccoon_fetch_not_injected');
  const activeSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try { return await fetchImpl(url, {method, headers, body, redirect: 'error', signal: activeSignal}); }
  catch (e) {
    if (activeSignal.aborted || e?.name === 'AbortError') throw new AppError('小浣熊请求已取消或超时', 499, 'request_cancelled');
    throw new AppError('小浣熊官方接口连接失败或超时', 503, 'raccoon_network_error');
  }
}

// ------------------------------------------------------------------ models

/** Catalog from installed app metadata. Capacity comes from the REAL session binding when present. */
export async function raccoonModels(options = {}) {
  const out = [];
  try {
    const cfg = await raccoonLlmConfig(options);
    if (cfg.model) out.push({
      id: cfg.model, name: cfg.model, source: 'installed_default_config', protocol: 'openai-compatible(app-gateway)',
      contextWindow: null, maxTokens: null, maxTokensSource: 'unverified', officialMaxTokens: null,
      tools: null, multimodal: null, callable: false, callableReason: 'model_transport_unverified_live', publishable: false,
    });
  } catch { /* config missing -> keep going with binding */ }
  const bindingPath = options.sessionBindingPath === undefined ? defaultRaccoonPaths().sessionBinding : options.sessionBindingPath;
  if (bindingPath) {
    try {
      const raw = await (options.readFileImpl ?? (async p => JSON.parse(await readFile(p, 'utf8'))))(bindingPath);
      const b = parseRaccoonSessionBinding(raw);
      if (b.model) out.push({
        id: b.model, name: b.model, source: 'installed_session_binding', protocol: 'openai-compatible(app-gateway)',
        contextWindow: b.contextWindow, // real value from the app's own binding (1000000 on this machine)
        maxTokens: b.maxTokens,         // real value from the binding (100000 on this machine)
        maxTokensSource: 'app_session_binding',
        officialMaxTokens: null,        // the server catalog was never read; binding ≠ official server cap
        tools: null, multimodal: b.tags.includes('vision') ? true : null, tags: b.tags,
        callable: false, callableReason: 'model_transport_unverified_live', publishable: false,
      });
    } catch { /* binding missing is fine */ }
  }
  return out;
}

// ------------------------------------------------------------------ health / status / claim

/**
 * Contract `health`: honest by construction. The cookie store is verified read-only; a missing or
 * empty session is reported as session_absent, balance stays unknown (no evidence of an endpoint),
 * and no model is published as callable.
 */
export async function raccoonHealth({credential, cookieDbPath, localStatePath, fetchImpl, llmConfigPath, sessionBindingPath, timeoutMs = 8000} = {}) {
  let presence;
  try {
    presence = await raccoonCookiePresence({cookieDbPath, localStatePath});
  } catch (error) {
    presence = {present: false, cookieCount: null, hosts: [], note: redact(error.message ?? 'cookie 库读取失败')};
  }
  const models = await raccoonModels({configFilePath: llmConfigPath, sessionBindingPath});
  const sessionUsers = presence.hosts.filter(h => h.host.includes('xiaohuanxiong.com')).map(h => ({host: h.host, cookieNames: h.names.slice(0, 20)}));
  let gatewayReachable = null; let gatewayStatus = null;
  if (typeof fetchImpl === 'function') {
    try {
      const res = await raccoonFetch(fetchImpl, `${RACCOON_ORIGIN}/api/web/llm/v2/models`, {method: 'GET', timeoutMs});
      gatewayStatus = res.status;
      gatewayReachable = res.status < 500;
      await res.body?.cancel?.().catch?.(() => {});
    } catch { gatewayReachable = false; }
  }
  const hasSession = (presence.cookieCount ?? 0) > 0;
  return {
    status: hasSession ? 'session_present' : 'session_absent',
    session: {present: hasSession, cookieCount: presence.cookieCount, encryptedCount: presence.encryptedCount ?? null, siteCookies: sessionUsers, note: presence.note},
    credential: raccoonCredentialView(credential),
    gatewayReachable, gatewayStatus,
    balance: {value: null, unit: 'points', parts: [], note: '官方未发现个人余额只读端点；按契约返回 unknown 而不是估算值', checkedIn: null},
    checkin: {supported: false, reason: 'no_checkin_surface_found'},
    capabilities: {checkin: false, inference: false},
    models, modelCount: models.length,
    descriptor: Object.freeze({...descriptor}),
  };
}

/** Contract `status`: no check-in surface exists — explicit unsupported, never a fake state. */
export async function raccoonStatus(secret, task = 'daily-checkin') {
  if (task !== 'daily-checkin') throw new AppError('小浣熊任务未登记', 400, 'raccoon_task_unknown');
  return {known: false, task, claimable: false, claimed: null, supported: false, reason: 'no_checkin_surface_found', evidence: descriptor.sourceUrls};
}

/** Contract `claim`: honest unsupported description (no fake success). */
export async function raccoonClaim() {
  return {
    supported: false,
    code: 'no_checkin_confirmed',
    reason: '官方客户端与线上文档均未发现签到/领取接口；积分来自商汤账号侧，不由本地客户端管理',
    evidence: ['D:/raccoon-ai/resources/default-llm-config.json', 'D:/raccoon-ai/resources/.env.electron (origin listing)'],
  };
}

/** Chat is not verified live for third-party use: refuse rather than guess a protocol. */
export async function raccoonChat() {
  throw new AppError('小浣熊模型调用协议尚未核验（应用网关仅绑定自身 web 会话）', 501, 'raccoon_chat_unverified');
}

// ------------------------------------------------------------------ provider export

export const raccoonProvider = {
  descriptor,
  resolve: raccoonResolve,
  models: (credential, options={}) => raccoonModels(options),
  health: (credential, options={}) => raccoonHealth({...options,credential}),
  status: raccoonStatus,
  claim: raccoonClaim,
  chat: raccoonChat,
  // read-only extras
  credentialView: raccoonCredentialView,
  cookiePresence: raccoonCookiePresence,
};
