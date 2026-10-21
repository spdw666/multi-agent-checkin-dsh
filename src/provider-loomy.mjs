import {desktopSseResponse,desktopCompletionLimit} from './provider-sse.mjs';
// Loomy (iFlytek) production native-session adapter.
// Actual current-user auth-session works at https://loomyad.xunfei.cn/api/v1.
// Historical ossptest.voicecloud.cn responses were from the wrong environment;
// their 100002 response did not prove that the production account session had expired.
// Official production catalog, personal points and chat/tool roundtrip verified.
// References: Patrick130306/loomy2api (MIT) and shipped official electron source.
import {AppError, redact, hash, rememberSecret, dayIn} from './util.mjs';
import {readFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {userInfo,homedir} from 'node:os';

export const LOOMY_POINTS_ORIGIN = 'https://loomyad.xunfei.cn';
export const LOOMY_API_PREFIX = '/api/';
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
  checkinTasks: ['pet-work', 'daily-quota'],
  // Native completeFirstLogin is repeatable: the official server returns an
  // alreadyProcessed receipt. This exception never covers pet-work rewards.
  dailyReconciliationTasks: Object.freeze(['daily-quota']),
  dailyReconciliationMode: 'idempotent-first-login',
  claimSupported: true, // guarded: submits only official preconditions and re-verifies the snapshot
  underlyingProvider: 'xfyun imodel production gateway (openai-compatible, session-auth)',
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
      const dir=createHash('sha256').update(userInfo().username).digest('hex').slice(0,12);
      const candidate=join(root,dir,'userData','auth-session.json');
      if(existsSync(candidate))found.push(candidate);
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
  if (token) {headers.token=token;headers.authorization='Bearer '+token;}
  headers['traceparent']='00-'+randomUUID().replaceAll('-','')+'-'+randomUUID().replaceAll('-','').slice(0,16)+'-01';
  headers['loomy-version']='0.9.38';
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
  const data = await loomyRequest(secret, {path: '/api/v1/user/identity', ...options});
  const d = data?.data ?? {};
  return {present: Object.keys(d).length > 0 || data?.code === '000000', fieldNames: Object.keys(d).slice(0, 20)};
}

/**
 * Pet-work (宠物打工) daily snapshot. Field extraction is defensive: unknown shapes are reported,
 * never guessed. `keys` carries the top-level names for diagnostics.
 */
export async function loomyPetWork(secret, options = {}) {
  const data = await loomyRequest(secret, {path: '/api/v1/pet-work', ...options});
  const d = data?.data ?? {};
  const claimMarkers = ['claimedToday', 'todayRewardClaimed', 'rewarded', 'claimed'].filter(k => typeof d?.[k] === 'boolean');
  const claimed = claimMarkers.length ? claimMarkers.some(k => d[k] === true) : null;
  const native=d.status&&typeof d.status==='object'?d.status:null;
  const tierData=d.tiers??d.config?.tiers;
  const tiers = Array.isArray(tierData) ? tierData.slice(0, 50).map(t => ({
    id: typeof t?.id === 'string' || typeof t?.id === 'number' ? t.id : (typeof t?.tierId === 'string' || typeof t?.tierId === 'number' ? t.tierId : null),
    label: typeof t?.label === 'string' ? redact(t.label).slice(0, 60) : (typeof t?.name === 'string' ? redact(t.name).slice(0, 60) : null),
    points: Number.isFinite(t?.points) ? t.points : null,
  })) : [];
  return {
    businessDate: typeof d?.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.businessDate) ? d.businessDate : null,
    earnedPointsToday:Number.isFinite(native?.earnedPointsToday)?native.earnedPointsToday:null,
    rewardedTierIds:Array.isArray(native?.rewardedTierIds)?native.rewardedTierIds.filter(x=>typeof x==='string'):null,
    nativeStatusKnown:!!native,
    configVersion: typeof d?.configVersion === 'string' || Number.isFinite(d?.configVersion) ? d.configVersion : (d.config?.version??null),
    reachedTierId: typeof d?.reachedTierId === 'string' || Number.isFinite(d?.reachedTierId) ? d.reachedTierId : null,
    tiers,
    claimMarkers,
    claimed:claimed??(Array.isArray(native?.rewardedTierIds)?native.rewardedTierIds.length>0:null),
    balanceCandidate: Number.isFinite(d?.currentBalance) ? d.currentBalance : (Number.isFinite(d?.balance) ? d.balance : null),
    keys: Object.keys(d ?? {}).slice(0, 30),
  };
}

/** Records read (read-only). Kept as a helper; balance is NOT derived from records. */
export async function loomyPointsRecords(secret, {version = 1, query = {}, ...options} = {}) {
  const v = version === 2 ? 'v2' : 'v1';
  const data = await loomyRequest(secret, {path: `/api/${v}/points/records`, query, ...options});
  return data;
}

// ------------------------------------------------------------------ status / claim (pet-work)

function normalizeTask(task) {
  if (task === 'pet-work') return 'pet-work';
  throw new AppError('Loomy 任务未登记', 400, 'loomy_task_unknown');
}

// Tri-state reward eligibility: null is an incomplete/failed snapshot, never a claim invitation.
function petWorkClaimable(snapshot) {
  if (!snapshot) return null;
  if (snapshot.claimed === true) return false;
  const progressKnown = snapshot.claimed === false || Number.isFinite(snapshot.earnedPointsToday) || Array.isArray(snapshot.rewardedTierIds);
  if (!progressKnown) return null;
  if (snapshot.reachedTierId === null) return false;
  return snapshot.claimed === false && snapshot.businessDate !== null && snapshot.configVersion !== null ? true : null;
}
/** Contract `status`: real snapshot state; claimable only on an explicit server-side marker. */
export async function loomyStatus(secret, task = 'pet-work', options = {}) {
  if(task==='daily-quota'||task==='daily-checkin'){task='daily-quota';const balance=await loomyPointBalance(secret,options);const observed=balance.dailyQuotaObserved===true;return {known:true,active:!observed,observed,task,claimed:false,claimable:!observed,reason:observed?'server_auto_daily_quota':'daily_quota_receipt_unverified',day:dayIn(new Date(options.now??Date.now()),'Asia/Shanghai'),details:balance};}
  normalizeTask(task);
  const snapshot = await loomyPetWork(secret, options);
  const claimable = petWorkClaimable(snapshot) === true;
  return {
    known: true,
    observed:snapshot.nativeStatusKnown&&snapshot.reachedTierId===null,
    reason:snapshot.nativeStatusKnown&&snapshot.reachedTierId===null?'pet_work_progress_observed':undefined,
    details:{earnedPointsToday:snapshot.earnedPointsToday,rewardedTierIds:snapshot.rewardedTierIds,source:'/api/v1/pet-work'},
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
 * snapshot, never caller-supplied progress, then re-reads the snapshot. If the fresh snapshot does not
 * carry a recognized claimed-marker, the result is reported as submitted-but-unconfirmed — HTTP 200
 * is never converted into a success claim.
 */
export async function loomyClaim(secret, task = 'pet-work', options = {}) {
  if(task==='daily-quota'||task==='daily-checkin')return loomyRefreshDailyQuota(secret,options);
  normalizeTask(task);
  const before = await loomyStatus(secret, task, options);
  if (before.claimed === true) return {...before, submitted: false, alreadyClaimed: true};
  const businessDate = before.businessDate;
  const configVersion = before.configVersion;
  const reachedTierId = before.reachedTierId;
  if (businessDate === null || configVersion === null || reachedTierId === null)
    return {...before, submitted: false, reason: 'preconditions_missing', note: '需要服务端快照提供 businessDate/configVersion/reachedTierId'};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate)))
    return {...before, submitted: false, reason: 'business_date_invalid'};
  if (!before.claimable) return {...before, submitted:false, reason:'server_eligibility_unverified'};
  const body = {businessDate, configVersion, reachedTierId}; // exactly the three official fields
  let failure = null;
  try {
    await loomyRequest(secret, {...options, path: '/api/v1/pet-work/rewards', method: 'POST', body});
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
export function loomyHealthProbeBudget(limit,timeoutMs){return Number.isFinite(timeoutMs)&&timeoutMs>=0?Math.max(1,Math.min(limit,Math.floor(timeoutMs))):limit;}
export async function loomyHealth(secret, options = {}) {
  const base = {
    balance: {value: null, unit: 'points', parts: [], note: '个人积分待官方接口返回；不使用团队余额替代', checkedIn: null},
    capabilities: {checkin: true, inference: false},
  };
  if (!secret?.accessToken) {
    return {...base, status: 'credential_missing', credential: loomyCredentialView(secret), services: {identity: null, petWork: null}};
  }
  // Independent GET probes run together. Auxiliary metadata cannot multiply the
  // balance deadline; every probe also honors a shorter caller timeout/signal.
  const probe = async (fn,limit) => {
    const budget=loomyHealthProbeBudget(limit,options.timeoutMs);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),budget);
    const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    try{return {value:await fn(secret,{...options,timeoutMs:budget,signal}),error:null};}
    catch(error){return {value:null,error:errorView(error)};}
    finally{clearTimeout(timer);}
  };
  const [identityRead,petRead,quotaRead,modelsRead]=await Promise.all([
    probe(loomyIdentity,8000),probe(loomyPetWork,8000),probe(loomyPointBalance,20000),probe(loomyModels,8000),
  ]);
  const identity=identityRead.value,identityError=identityRead.error;
  const pet=petRead.value,petError=petRead.error;
  const quota=quotaRead.value,quotaError=quotaRead.error;
  const models=modelsRead.value??[],modelsError=modelsRead.error;
  const rejected = [identityError, petError].filter(Boolean);
  const expired = rejected.some(e => e.code === 'loomy_session_expired');
  const status = identity === null && pet === null
    ? (expired ? 'session_expired' : 'unknown')
    : (identityError === null ? 'authenticated' : 'degraded');
  // Pet-work is not an authoritative personal balance fallback.
  if(quota)base.balance={...quota,checkedIn:null};
  base.capabilities.inference=models.some(m=>m.category==='chat');
  return {
    ...base,
    models,modelCount:models.length,petWork:pet,
    ...(quotaError?{balanceError:quotaError}:{}),...(modelsError?{modelsError}:{}),
    status:quota?'authenticated':status,
    credential: loomyCredentialView(secret),
    checkin: {supported: true, kind: 'pet_work', known: pet !== null, claimable: petWorkClaimable(pet), claimed: pet?.claimed ?? null, businessDate: pet?.businessDate ?? null, ...(petError ? {error: petError} : {})},
    services: {identity: identity ? 'ok' : identityError?.code ?? null, petWork: pet ? 'ok' : petError?.code ?? null},
    errors: rejected.length ? {identity: identityError, petWork: petError} : null,
    note: expired&&!quota ? '本地 auth-session 会话已被服务端拒绝（100002 登录已失效）；请在 Loomy 客户端重新登录' : undefined,
  };
}

// ------------------------------------------------------------------ models

/** Read official production catalog; missing credentials never invent model IDs. */
export function loomyModels(secret,options={}) {if(!secret?.accessToken)return [];return loomyServerModels(secret,options);}
export async function loomyServerModels(secret,options={}){
 const payload=await loomyRequest(secret,{path:'/api/v1/models',...options});const rows=Array.isArray(payload?.data)?payload.data:[];
 return rows.filter(m=>typeof m.id==='string').map(m=>({id:m.id,name:m.name??m.id,category:m.type??'chat',protocol:m.protocol??null,contextWindow:Number.isSafeInteger(m.context_length)?m.context_length:null,maxTokens:Number.isSafeInteger(m.max_output_tokens)?m.max_output_tokens:null,officialMaxTokens:Number.isSafeInteger(m.max_output_tokens)?m.max_output_tokens:null,maxTokensSource:'official_catalog',tools:typeof m.capabilities?.function_calling==='boolean'?m.capabilities.function_calling:null,multimodal:typeof m.capabilities?.vision==='boolean'?m.capabilities.vision:null,reasoning:{supportedEfforts:Array.isArray(m.reasoning_efforts)?m.reasoning_efforts:[],defaultEffort:m.default_reasoning_effort??null},source:'official_model_catalog',callable:(m.type??'chat')==='chat',publishable:(m.type??'chat')==='chat'}));
}
// A receipt is account/session-bound and expires at the Shanghai day boundary.
// A balance GET alone carries no cycle date and never proves today's automatic quota.
const dailyQuotaReceipts = new Map();
const dailyReceiptKey = secret => createHash('sha256').update(String(secret?.principal??'')+'|'+String(secret?.accessToken??'')).digest('hex');
function dailyQuotaEvidence(secret,options={}) {
  const receipt=dailyQuotaReceipts.get(dailyReceiptKey(secret));
  const today=dayIn(new Date(options.now??Date.now()),'Asia/Shanghai');
  const current=!!receipt&&receipt.dailyCycleDate===today;
  return {dailyQuotaObserved:current,dailyCycleDate:receipt?.dailyCycleDate??null,dailyQuota:receipt?.dailyQuota??null,dailyQuotaObservedAt:receipt?.dailyQuotaObservedAt??null,dailyQuotaSource:receipt?.dailyQuotaSource??null,dailyQuotaAlreadyProcessed:current?receipt.alreadyProcessed:null,dailyQuotaGrantOutcome:current?receipt.grantOutcome:'unknown'};
}
export async function loomyRefreshDailyQuota(secret,options={}) {
  const key=dailyReceiptKey(secret); dailyQuotaReceipts.delete(key);
  const reply=await loomyRequest(secret,{...options,path:'/api/v1/points/first-login',method:'POST',body:{}});
  const d=reply?.data??{};
  const balance=await loomyPointBalance(secret,options);
  const date=typeof d.dailyCycleDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d.dailyCycleDate)?d.dailyCycleDate:null;
  if(date&&Number.isFinite(d.dailyQuota)&&d.dailyQuota>=0&&Number.isFinite(d.dailyBalance)&&Number.isFinite(d.currentBalance)&&balance.parts[1]?.value===d.dailyBalance&&balance.value===d.currentBalance) {
    const alreadyProcessed=typeof d.alreadyProcessed==='boolean'?d.alreadyProcessed:null;
    dailyQuotaReceipts.set(key,{dailyCycleDate:date,dailyQuota:d.dailyQuota,dailyQuotaObservedAt:new Date(options.now??Date.now()).toISOString(),dailyQuotaSource:'/api/v1/points/first-login',alreadyProcessed,grantOutcome:alreadyProcessed===false?'newly_processed':alreadyProcessed===true?'already_processed':'unknown'});
    if(dailyQuotaReceipts.size>500)dailyQuotaReceipts.delete(dailyQuotaReceipts.keys().next().value);
  }
  const evidence=dailyQuotaEvidence(secret,options);
  const verified=evidence.dailyQuotaObserved===true;
  return {task:'daily-quota',known:true,observed:verified,claimed:false,submitted:true,rechecked:true,confirmed:verified,reason:verified?'server_auto_daily_quota':'daily_quota_receipt_unverified',alreadyProcessed:typeof d.alreadyProcessed==='boolean'?d.alreadyProcessed:null,registerReward:Number.isFinite(d.registerReward)?d.registerReward:null,...evidence,details:{...balance,...evidence},note:'官方登录额度刷新及余额复核；不是宠物打工奖励或人工签到。'};
}

export async function loomyPointBalance(secret,options={}){
 const result=await loomyPointsRecords(secret,{query:{recordType:'all',pageNo:1,pageSize:1},...options});const d=result.data??{};
 return {...dailyQuotaEvidence(secret,options),value:Number.isFinite(d.availableBalance)?d.availableBalance:null,unit:'积分',parts:[{name:'长期积分',value:Number.isFinite(d.balance)?d.balance:null,unit:'积分'},{name:'每日积分',value:Number.isFinite(d.dailyBalance)?d.dailyBalance:null,unit:'积分'}],note:'官方个人积分账户；可用总额来自 availableBalance，每日积分与宠物奖励分开。'};
}

// ------------------------------------------------------------------ chat

/** Production session-auth chat. Validate official model metadata, preserve tools,
 * normalize true SSE and fail closed on upstream business errors. */
export async function loomyChat(upstream, secret, input, signal, options = {}) {
  if(!secret?.accessToken) throw new AppError('登录凭据未就绪',401,'loomy_credential_missing');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new AppError('Loomy 网络请求需要显式注入 fetchImpl', 400, 'loomy_fetch_not_injected');
  const model = typeof input?.model === 'string' && input.model ? input.model : null;
  if (!model) throw new AppError('Loomy 聊天请求缺少 model', 400, 'loomy_chat_invalid');
  const catalog=await loomyModels(secret,{...options,signal});const metadata=catalog.find(m=>m.id===model&&m.category==='chat');if(!metadata)throw new AppError('模型不在 Loomy 官方聊天目录',400,'loomy_model_unknown');
  const body={};for(const key of ['messages','tools','tool_choice','parallel_tool_calls','temperature','top_p','stop','response_format','reasoning_effort'])if(input[key]!==undefined&&input[key]!==null)body[key]=input[key];body.model=model;body.max_tokens=desktopCompletionLimit(input,metadata.maxTokens??4096);body.stream=true;
  const response = await loomyFetch(fetchImpl, '/api/v1/chat/completions', {method: 'POST', token: secret?.accessToken, body, timeoutMs: options.timeoutMs ?? 300000, signal});
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(`Loomy 聊天接口 HTTP ${response.status}`, response.status, response.status === 401 || response.status === 403 ? 'loomy_auth_failed' : 'loomy_chat_rejected');
  }
  const ctype = response.headers?.get?.('content-type') ?? '';
  if (ctype.includes('text/event-stream')) return {response: await desktopSseResponse(transformLoomySse(response.body,signal),{stream:input.stream===true,model,signal,prefix:'loomy'}), model, verified:'official_production_protocol'};
  // Non-SSE: the JSON envelope must be checked for business errors before it is returned.
  const data = await boundedJson(response);
  unwrap(data);
  if(!Array.isArray(data?.choices))throw new AppError('Loomy 聊天响应缺少 choices',502,'loomy_chat_schema');
  return {response: new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}}), model, verified: 'official_production_protocol'};
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
