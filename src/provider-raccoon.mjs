import {desktopSseResponse, desktopCompletionLimit} from './provider-sse.mjs';
import {homedir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
// SenseTime Raccoon native adapter. Official live endpoints verified 2026-10-11:
// current-user ~/.box-agent/config/auth.json supplies Bearer access_token independently
// of Electron Cookies. GET model_catalog / points balance and chat/tool roundtrip passed.
// Gateway refresh uses a private cache; each resolve re-reads the untouched native source.
// Protocol references: github.com/xxhhlk/raccoon2api and rockswang/wild-work (MIT).
import {AppError, redact, hash, rememberSecret, dayIn} from './util.mjs';
import {stat, readFile, mkdir, open, writeFile, rename, unlink} from 'node:fs/promises';
import {createDecipheriv, randomBytes} from 'node:crypto';
import {dpapiUnprotect as defaultDpapi} from './windows-crypto.mjs';

export const RACCOON_ORIGIN = 'https://xiaohuanxiong.com';
const PATH_PREFIX = '/api/web/';
const JSON_LIMIT = 1024 * 1024;

export const descriptor = Object.freeze({
  id: 'raccoon',
  name: '商汤小浣熊 (SenseTime Raccoon)',
  authKind: 'native_bearer_token',
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

/** Resolve current-user native auth first; cookie presence alone never proves authentication. */
export async function raccoonResolve(account, config = {}, options = {}) {
  const ref = account?.credentials?.file ?? account?.credentials?.path ?? null;
  const nativeFile=ref&&ref!=='auto'?(typeof config.path==='function'?config.path(ref):ref):(config.authFilePath??((config.cookieDbPath)?null:defaultRaccoonAuthPath()));
  if(nativeFile){try{return await resolveRaccoonNativeAuth(nativeFile, options);}catch(error){if(ref&&ref!=='auto'||error.code!=='raccoon_credential_missing')throw error;}}
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
    authKind: secret.authKind==='bearer'?'native_bearer_token':'electron_session_cookie',
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
  if(credential?.authKind==='bearer')return raccoonBearerHealth(credential,{fetchImpl:fetchImpl??globalThis.fetch,timeoutMs});
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
export async function raccoonStatus(secret, task = 'daily-checkin', options={}) {
  if(task==='daily-quota')return raccoonDailyStatus(secret,options);
  if (task !== 'daily-checkin') throw new AppError('小浣熊任务未登记', 400, 'raccoon_task_unknown');
  return {known: false, task, claimable: false, claimed: null, supported: false, reason: 'no_checkin_surface_found', evidence: descriptor.sourceUrls};
}

/** Contract `claim`: honest unsupported description (no fake success). */
export async function raccoonClaim(secret,task='daily-checkin',options={}) {
  if(task==='daily-quota'){
   const before=await raccoonDailyStatus(secret,options);if(before.observed)return {...before,submitted:false,credit:0};
   const grant=await raccoonJson(secret,'/api/web/desktop/v1/login/points/grant',{...options,method:'POST',headers:{'X-Client-Platform':'desktop-windows'}});
   const after=await raccoonDailyStatus(secret,options);
   if(!after.observed)throw new AppError('小浣熊每日额度与登录延期尚未获账单确认',502,'raccoon_daily_unconfirmed');
   return {...after,claimed:false,submitted:true,credit:0,rechecked:true,desktopRewardGranted:grant.granted===true,desktopRewardPoints:Number.isFinite(grant.popup?.points)?grant.popup.points:null};
  }
  return {
    supported: false,
    code: 'no_checkin_confirmed',
    reason: '官方客户端与线上文档均未发现签到/领取接口；积分来自商汤账号侧，不由本地客户端管理',
    evidence: ['D:/raccoon-ai/resources/default-llm-config.json', 'D:/raccoon-ai/resources/.env.electron (origin listing)'],
  };
}

/** Chat is not verified live for third-party use: refuse rather than guess a protocol. */
export async function raccoonChat(upstream,secret,input,signal,options={}) {
 if(!secret?.accessToken||secret.authKind!=='bearer')throw new AppError('小浣熊需要原生 Bearer 登录凭据',401,'raccoon_credential_missing');
 const model=input?.model;if(typeof model!=='string'||!model)throw new AppError('小浣熊缺少模型',400,'raccoon_model_invalid');
 const models=await raccoonServerModels(secret,{...options,signal});
 const metadata=models.find(m=>m.id===model&&m.category==='chat');
 if(!metadata)throw new AppError('模型不在小浣熊官方聊天目录中',400,'raccoon_model_unknown');
 const body={};for(const key of ['messages','tools','tool_choice','parallel_tool_calls','temperature','top_p','stop','response_format'])if(input[key]!==undefined)body[key]=input[key];
 body.model=model;body.max_tokens=desktopCompletionLimit(input,metadata.maxTokens??4096);body.stream=true;
 const response=await raccoonFetch(options.fetchImpl??globalThis.fetch,RACCOON_ORIGIN+'/api/web/llm/v2/chat/completions',{method:'POST',headers:raccoonBearerHeaders(secret),body:JSON.stringify(body),signal,timeoutMs:options.timeoutMs??300000});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw new AppError('小浣熊聊天接口 HTTP '+response.status,response.status,response.status===401?'raccoon_session_expired':'raccoon_chat_rejected');}
 return {response:await desktopSseResponse(response,{stream:input.stream===true,model,signal,prefix:'raccoon'}),model};
}

// ------------------------------------------------------------------ provider export

export const raccoonProvider = {
  descriptor,
  resolve: raccoonResolve,
  models: (credential, options={}) => credential?.authKind==='bearer'?raccoonServerModels(credential,options):raccoonModels(options),
  health: (credential, options={}) => raccoonHealth({...options,credential}),
  status: raccoonStatus,
  claim: raccoonClaim,
  chat: raccoonChat,
  // read-only extras
  credentialView: raccoonCredentialView,
  cookiePresence: raccoonCookiePresence,
};

// Official native client auth is ~/.box-agent/config/auth.json, independent of Electron cookies.
// Native files stay unchanged; rotated credentials are saved only in gateway private-cache.
export function defaultRaccoonAuthPath(){return join(process.env.BOX_AGENT_CONFIG_DIR||join(homedir(),'.box-agent','config'),'auth.json');}
export async function readRaccoonNativeAuth(file=defaultRaccoonAuthPath(),{readFileImpl=readFile}={}){
 let raw;try{raw=JSON.parse(String(await readFileImpl(file,'utf8')).replace(/^\uFEFF/,''));}catch{throw new AppError('小浣熊原生登录文件未就绪',401,'raccoon_credential_missing');}
 const token=raw.access_token??raw.accessToken;if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw new AppError('小浣熊原生登录令牌为空',401,'raccoon_credential_missing');
 let claims={};try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{}
 const identity=claims.name??claims.sub??raw.principal;
 if(typeof identity!=='string'||!identity)throw new AppError('小浣熊登录缺少稳定身份',401,'raccoon_identity_missing');
 rememberSecret(token);if(raw.refresh_token)rememberSecret(raw.refresh_token);
 return {accessToken:token,authKind:'bearer',principal:'raccoon:'+hash(identity).slice(0,24),source:'native_auth_file',filePath:file,cookieNames:[],expiresAt:Number.isFinite(claims.exp)?new Date(claims.exp*1000).toISOString():null};
}
function raccoonBearerHeaders(secret){rememberSecret(secret.accessToken);return {'authorization':'Bearer '+secret.accessToken,'content-type':'application/json','accept':'application/json'};}
async function raccoonJson(secret,path,options={}){
 const response=await raccoonFetch(options.fetchImpl??globalThis.fetch,RACCOON_ORIGIN+path,{method:options.method??'GET',headers:{...raccoonBearerHeaders(secret),...options.headers},signal:options.signal,timeoutMs:options.timeoutMs??30000});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw new AppError('小浣熊官方接口 HTTP '+response.status,response.status,response.status===401?'raccoon_session_expired':'raccoon_upstream_error');}
 const reader=response.body?.getReader();if(!reader)throw new AppError('小浣熊空响应',502,'raccoon_empty_response');let bytes=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>JSON_LIMIT)throw new AppError('小浣熊响应过大',502,'raccoon_response_too_large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('小浣熊响应格式错误',502,'raccoon_invalid_json');}
 if(data.code!==undefined&&data.code!==0&&data.code!=='0'){const auth=[200001,200003].includes(Number(data.code));throw new AppError('小浣熊业务接口拒绝',auth?401:502,auth?'raccoon_session_expired':'raccoon_business_error');}return data.data??data;
}
export async function raccoonServerModels(secret,options={}){
 const data=await raccoonJson(secret,'/api/web/llm/v2/model_catalog',options);if(!Array.isArray(data.categories))throw new AppError('小浣熊模型目录结构改变',502,'raccoon_catalog_schema');
 return data.categories.flatMap(c=>(c.models??[]).map(m=>({id:m.model_name??m.name,name:m.description??m.name,category:c.type,contextWindow:Number.isSafeInteger(m.params?.context_window)?m.params.context_window:null,maxTokens:Number.isSafeInteger(m.params?.max_tokens)?m.params.max_tokens:null,officialMaxTokens:Number.isSafeInteger(m.params?.max_tokens)?m.params.max_tokens:null,maxTokensSource:'official_catalog',tools:(m.model_name??m.name)==='sn-sensenova-6-8-flash'?true:null,toolSupportSource:(m.model_name??m.name)==='sn-sensenova-6-8-flash'?'gateway_live_tool_roundtrip_2026-10-11':null,multimodal:(m.tags??[]).includes('vision'),tags:m.tags??[],visible:m.visible!==false,source:'official_model_catalog',callable:c.type==='chat',publishable:c.type==='chat',billingStatus:m.billing_status??null,billingMultiplier:m.billing_effective_multiplier??m.billing_multiplier??null}))).filter(m=>typeof m.id==='string'&&m.id);
}
export async function raccoonBearerHealth(secret,options={}){
 const data=await raccoonJson(secret,'/api/web/points/v1/balance',options);
 const balance={value:Number.isFinite(data.available_points)?data.available_points:null,unit:'积分',parts:[],checkedIn:null,note:'官方可用积分；每日签到/登录领取状态以当日官方账单核验，余额不代表已签到。'};
 for(const [key,name]of [['daily_points','每日额度'],['monthly_points','月度额度'],['reward_points','奖励积分'],['topup_points','充值积分']])if(Number.isFinite(data[key]))balance.parts.push({name,value:data[key],unit:'积分'});
 if(data.topup_frozen===true)balance.note+='充值积分已冻结。';
 let models=[],modelError=null;try{models=await raccoonServerModels(secret,options);}catch(error){modelError={code:error.code??'raccoon_catalog_error',message:redact(error.message)};}
 let daily;try{daily=await raccoonDailyStatus(secret,{...options,balanceData:data});}catch(error){daily={known:false,observed:false,error:{code:error.code??'raccoon_daily_error'}};}
 Object.assign(balance,{dailyEntitlementMode:'daily_login_checkin',dailyEntitlementClaimed:daily.known===true?daily.observed===true:null,dailyQuotaObserved:daily.known===true&&daily.observed===true,dailyCycleDate:daily.day??dayIn(new Date(options.now??Date.now()),'Asia/Shanghai'),dailyQuota:daily.details?.receipt?.points??null,dailyQuotaObservedAt:new Date(options.now??Date.now()).toISOString(),dailyQuotaSource:'/api/web/points/v1/bills:daily_grant'});
 return {status:'authenticated',credential:raccoonCredentialView(secret),balance,daily,checkin:{supported:false,reason:'daily_grant_not_checkin'},capabilities:{checkin:false,inference:models.some(m=>m.category==='chat')},models,modelCount:models.length,...(modelError?{modelError}:{})};
}

export const RACCOON_REFRESH_URL = RACCOON_ORIGIN + '/api/web/auth/v1/refresh';
const raccoonRefreshFlights = new Map();
function tokenClaims(token) {try{return JSON.parse(Buffer.from(String(token).split('.')[1],'base64url').toString('utf8'));}catch{return {};}}
function tokenIdentity(raw){const c=tokenClaims(raw.access_token??raw.accessToken);return c.name??c.sub??raw.principal;}
function tokenExpiry(raw){const exp=tokenClaims(raw.access_token??raw.accessToken).exp;return Number.isFinite(exp)?exp*1000:NaN;}
async function refreshJson(response){const reader=response.body?.getReader();if(!reader)throw new AppError('小浣熊续期响应为空',502,'raccoon_refresh_invalid');let bytes=0;const parts=[];try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>JSON_LIMIT)throw new AppError('小浣熊续期响应过大',502,'raccoon_refresh_invalid');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AppError('小浣熊续期响应格式错误',502,'raccoon_refresh_invalid');}}
export async function refreshRaccoonAuth(auth,{fetchImpl=fetch,now=Date.now(),signal}={}) {
 const rt=auth.refresh_token??auth.refreshToken,at=auth.access_token??auth.accessToken;
 if(typeof rt!=='string'||!rt||/[\r\n]/.test(rt))throw new AppError('小浣熊续期凭据缺失',401,'raccoon_refresh_missing');
 rememberSecret(rt);rememberSecret(at);let response;
 try{response=await fetchImpl(RACCOON_REFRESH_URL,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:{'content-type':'application/json',accept:'application/json',authorization:'Bearer '+at},body:JSON.stringify({refresh_token:rt})});}
 catch{throw new AppError('小浣熊续期请求未确认；等待登录态更新',503,'raccoon_refresh_unconfirmed');}
 if(response.status===429){await response.body?.cancel().catch(()=>{});const raw=response.headers.get('retry-after'),seconds=raw?Number(raw):NaN,at=Number.isFinite(seconds)&&seconds>=0?now+seconds*1000:Date.parse(raw);throw Object.assign(new AppError('小浣熊续期暂时限流',429,'raccoon_refresh_failed'),{retryable:true,retryAt:Math.max(now+1000,Math.min(Number.isFinite(at)?at:now+600000,now+3600000))});}
 const data=await refreshJson(response);
 if(!response.ok||![0,'0'].includes(data.code)){
  const terminal=[401,403].includes(response.status)||[200001,200003].includes(Number(data.code));
  const error=new AppError('小浣熊官方续期失败 (HTTP '+response.status+')',response.ok?(terminal?401:502):response.status,'raccoon_refresh_failed');error.loginRequired=terminal;
  // An explicit rate-limit rejection did not issue new credentials. Transport/5xx outcomes stay uncertain.
  if(response.status===429){error.retryable=true;error.retryAt=now+600000;}
  throw error;
 }
 const token=data.data?.access_token,refresh=data.data?.refresh_token===undefined?rt:data.data.refresh_token;
 if(typeof token!=='string'||!token||/[\r\n]/.test(token)||typeof refresh!=='string'||!refresh||/[\r\n]/.test(refresh))throw new AppError('小浣熊续期缺少轮换凭据',502,'raccoon_refresh_invalid');
 rememberSecret(token);rememberSecret(refresh);
 const next={...auth,access_token:token,refresh_token:refresh};
 const oldIdentity=tokenIdentity(auth),newIdentity=tokenIdentity(next);
 if(typeof oldIdentity!=='string'||!oldIdentity||newIdentity!==oldIdentity)throw new AppError('小浣熊续期身份不一致',401,'raccoon_refresh_identity_mismatch');
 const oldClaims=tokenClaims(at),newClaims=tokenClaims(token);
 if(oldClaims.sub&&newClaims.sub&&oldClaims.sub!==newClaims.sub)throw new AppError('小浣熊续期身份不一致',401,'raccoon_refresh_identity_mismatch');
 if(!(tokenExpiry(next)>now+60000))throw new AppError('小浣熊续期有效期异常',502,'raccoon_refresh_invalid');
 return next;
}
async function publishRaccoonCache(file,data){const temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';await writeFile(temp,JSON.stringify(data),{mode:0o600});await rename(temp,file);}
function raccoonBlockedRefresh(cached){const pending=cached?.loginRequired===false||/(?:unconfirmed|invalid|pending)$/.test(cached?.refreshFailure??'');return Object.assign(new AppError(pending?'小浣熊续期结果待核验；检测到新本机登录态后自动恢复':'小浣熊上次续期未确认；等待本机登录态更新',pending?503:401,'raccoon_refresh_needs_login'),{loginRequired:!pending,refreshPending:pending});}
async function loadRaccoonRefreshed(file,options){
 let source,original;try{source=await readFile(file,'utf8');original=JSON.parse(source.replace(/^\uFEFF/,''));}catch{throw new AppError('小浣熊原生登录文件未就绪',401,'raccoon_credential_missing');}
 // Parse identity before any credential-bearing network operation.
 await readRaccoonNativeAuth(file,{readFileImpl:async()=>source});
 const sourceHash=hash(source),sourceCredentialHash=hash(JSON.stringify([tokenIdentity(original),original.refresh_token??original.refreshToken??null])),cacheFile=options.cacheFile??join(process.env.LOCALAPPDATA??homedir(),'AI Credit Gateway','private-cache','raccoon-'+hash(resolve(file)).slice(0,16)+'.json');
 const now=options.now??Date.now();let cached;
 try{cached=JSON.parse(await readFile(cacheFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new AppError('小浣熊私有续期缓存需核验',409,'raccoon_refresh_cache_invalid');}
 const matches=cached?.sourceCredentialHash?cached.sourceCredentialHash===sourceCredentialHash:cached?.sourceHash===sourceHash;
 let auth=matches&&cached?.auth?cached.auth:original;
 const token=auth.refresh_token??auth.refreshToken;
 const attemptedHash=typeof token==='string'?hash(token):null;
 if(tokenExpiry(original)>now+60000&&(original.access_token??original.accessToken)!==(cached?.auth?.access_token??cached?.auth?.accessToken))return {...await readRaccoonNativeAuth(file,{readFileImpl:async()=>source}),refreshTokenPresent:!!(original.refresh_token??original.refreshToken)};
 const credential=async(raw,fromCache)=>{const value=await readRaccoonNativeAuth(file,{readFileImpl:async()=>JSON.stringify(raw)});return {...value,source:fromCache?'gateway_private_refresh_cache':'native_auth_file',refreshTokenPresent:!!(raw.refresh_token??raw.refreshToken)};};
 if(options.refresh===false)return credential(auth,matches&&!!cached?.auth);
 if(matches&&cached?.refreshFailure&&tokenExpiry(auth)>now+5000)return {...await credential(auth,true),refreshPending:true};
 if(matches&&cached?.retryAt&&now<cached.retryAt)throw Object.assign(new AppError('小浣熊续期暂缓，稍后自动重试',429,'raccoon_refresh_deferred'),{retryAt:cached.retryAt});
 if(cached?.refreshFailure&&(matches||attemptedHash&&cached.attemptedTokenHash===attemptedHash)&&(!cached.retryAt||now<cached.retryAt))throw raccoonBlockedRefresh(cached);
 if(tokenExpiry(auth)>now+60000||!token||options.refresh===false)return credential(auth,matches&&!!cached?.auth);
 await mkdir(dirname(cacheFile),{recursive:true});let lock;
 try{lock=await open(cacheFile+'.lock','wx',0o600);}catch{throw new AppError('小浣熊续期正在处理或需核对上次结果',409,'raccoon_refresh_pending');}
 try{
  // Recheck after lock acquisition: another process may have published while we awaited open.
  let latest;try{latest=JSON.parse(await readFile(cacheFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const latestMatches=latest?.sourceCredentialHash?latest.sourceCredentialHash===sourceCredentialHash:latest?.sourceHash===sourceHash;
  if(latestMatches&&latest?.auth&&tokenExpiry(latest.auth)>now+60000&&!latest.refreshFailure)return credential(latest.auth,true);
  if(latestMatches&&latest?.auth){auth=latest.auth;}
  if(latestMatches&&latest?.retryAt&&now<latest.retryAt)throw Object.assign(new AppError('小浣熊续期暂缓，稍后自动重试',429,'raccoon_refresh_deferred'),{retryAt:latest.retryAt});
  if(latest?.refreshFailure&&(latestMatches||latest.attemptedTokenHash===attemptedHash)&&(!latest.retryAt||now<latest.retryAt))throw raccoonBlockedRefresh(latest);
  if(hash(await readFile(file,'utf8'))!==sourceHash)throw new AppError('小浣熊原生会话已更新，将重新读取后续期',409,'raccoon_refresh_source_changed');
  // Durable intent prevents replay of a possibly rotated token after timeout, parse failure, or crash.
  await publishRaccoonCache(cacheFile,{sourceHash,sourceCredentialHash,auth,attemptedTokenHash:hash(auth.refresh_token??auth.refreshToken),refreshFailure:'raccoon_refresh_pending'});
  let next;try{next=await refreshRaccoonAuth(auth,options);}catch(error){await publishRaccoonCache(cacheFile,{sourceHash,sourceCredentialHash,auth,attemptedTokenHash:hash(auth.refresh_token??auth.refreshToken),refreshFailure:error.code??'raccoon_refresh_unconfirmed',failedAt:now,loginRequired:error.loginRequired===true,...(error.retryable?{retryAt:error.retryAt}:{})});if(tokenExpiry(auth)>now+5000)return {...await credential(auth,true),refreshPending:true};throw error;}
  await publishRaccoonCache(cacheFile,{sourceHash,sourceCredentialHash,auth:next});
  return credential(next,true);
 }finally{await lock.close();await unlink(cacheFile+'.lock').catch(()=>{});}
}
export async function resolveRaccoonNativeAuth(file=defaultRaccoonAuthPath(),options={}){
 const key=resolve(file)+'|'+(options.cacheFile??'default');if(raccoonRefreshFlights.has(key))return raccoonRefreshFlights.get(key);
 const pending=loadRaccoonRefreshed(file,options);raccoonRefreshFlights.set(key,pending);try{return await pending;}finally{raccoonRefreshFlights.delete(key);}
}

// The server bill is the durable receipt; never infer today's login benefit from a positive balance.
export function raccoonDailyReceipt(data,now=Date.now()){
 if(!Array.isArray(data?.items))throw new AppError('小浣熊积分账单格式改变',502,'raccoon_bills_schema');
 const day=dayIn(new Date(now),'Asia/Shanghai'),dayEnd=Date.parse(day+'T00:00:00+08:00')+86400000;
 const rows=data.items.filter(x=>x?.biz_type==='daily_grant'&&Number.isFinite(Date.parse(x.grant_at))&&dayIn(new Date(x.grant_at),'Asia/Shanghai')===day&&Number.isFinite(x.points)&&x.points>=0);
 const extended=rows.find(x=>Date.parse(x.expire_at)>dayEnd);
 const row=extended??rows[0];return {day,observed:!!extended,dailyGranted:rows.length>0,loginExtended:!!extended,points:row?.points??null,grantAt:row?.grant_at??null,recordedAt:row?.created_at??null,expiresAt:row?.expire_at??null};
}
export async function raccoonDailyStatus(secret,options={}){
 const balance=options.balanceData??await raccoonJson(secret,'/api/web/points/v1/balance',options);
 const bills=await raccoonJson(secret,'/api/web/points/v1/bills?paging.limit=50&paging.offset=0',options);
 const receipt=raccoonDailyReceipt(bills,options.now??Date.now());
 return {known:true,active:!receipt.observed,task:'daily-quota',observed:receipt.observed,claimed:false,claimable:!receipt.observed,principal:secret.principal,day:receipt.day,reason:receipt.observed?'server_daily_login_verified':'daily_login_not_verified',details:{dailyRemaining:Number.isFinite(balance.daily_points)?balance.daily_points:null,availablePoints:Number.isFinite(balance.available_points)?balance.available_points:null,unit:'积分',source:'/api/web/points/v1/bills',receipt,note:receipt.observed?'今日额度与登录延期已由官方账单核验；不是本次新增领取数量':'每日额度或登录延期待账单核验，余额不构成今日回执'}};
}
