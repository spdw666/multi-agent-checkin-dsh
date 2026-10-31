import {desktopSseResponse} from './provider-sse.mjs';
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {AppError,dayIn,hash,redact,rememberSecret} from './util.mjs';

// Cline account API adapter (read + faithful OpenAI-compatible chat passthrough).
// Chat path and auth scheme are quoted from the official docs, not guessed:
//   https://docs.cline.bot/api/chat-completions  "POST https://api.cline.bot/api/v1/chat/completions"
//   https://docs.cline.bot/api/authentication    "Authorization: Bearer YOUR_TOKEN" (API key or account auth token)
// mirror: https://raw.githubusercontent.com/cline/cline/main/docs/api/chat-completions.mdx (Apache-2.0)
// Other verified facts (model catalog, no check-in concept) are recorded in docs/provider-cline.md.
export const CLINE_API_ORIGIN = 'https://api.cline.bot';
export const CLINE_CHAT_PATH = '/api/v1/chat/completions';
const CLINE_PATHS = new Set(['/api/v1/users/me', '/api/v1/plans', '/api/v1/ai/cline/models', CLINE_CHAT_PATH]);
const MAX_BODY = 1024 * 1024;
// Only documented OpenAI Chat Completions request fields are forwarded; anything else is dropped.
const CHAT_FIELDS = ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens',
  'temperature', 'top_p', 'n', 'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs',
  'top_logprobs', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'seed', 'service_tier',
  'user', 'reasoning_effort'];

export const clineDescriptor = Object.freeze({
  id: 'cline',
  name: 'Cline',
  authKind: 'oauth_bearer',
  checkinSupported: false,
  chatSupported: true,
  chatPath: CLINE_CHAT_PATH,
  underlyingProvider: 'cline-api',
  billing: 'official_hosted_credits',
  byok: true,
  origin: CLINE_API_ORIGIN,
  docs: 'https://docs.cline.bot/api/chat-completions',
});

export const defaultClineCredentialFile = () => join(homedir(), '.cline', 'data', 'settings', 'providers.json');
export const CLINE_REFRESH_URL=CLINE_API_ORIGIN+'/api/v1/auth/refresh';
const clineRefreshFlights=new Map();
// A transient network blip must never lock the account forever. Mirror the retryAt cooldown that
// codearts/raccoon already publish: only credential failures (no retryAt) keep the permanent block.
const CLINE_RETRY_COOLDOWN=60000;
const clineBlockedRefresh=cached=>new AppError(cached?.retryAt?'Cline 续期遇到临时故障；稍后自动重试':'Cline 上次续期未确认；等待本机登录态更新',cached?.retryAt?503:401,'cline_refresh_needs_login');
const clineExpiry=value=>typeof value==='number'&&Number.isFinite(value)?(value<1e12?value*1000:value):typeof value==='string'?Date.parse(value):NaN;
function clineClaims(token){try{return JSON.parse(Buffer.from(String(token).replace(/^workos:/i,'').split('.')[1],'base64url').toString('utf8'));}catch{return {};}}

export async function refreshClineAuth(auth,{fetchImpl=fetch,signal,now=Date.now()}={}) {
 if(typeof auth?.refreshToken!=='string'||!auth.refreshToken)throw new AppError('Cline 续期凭据缺失',401,'cline_refresh_missing');
 rememberSecret(auth.refreshToken);const active=signal??AbortSignal.timeout(30000);let response;
 try{response=await fetchImpl(CLINE_REFRESH_URL,{method:'POST',redirect:'error',signal:active,headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:auth.refreshToken,grantType:'refresh_token'})});}
 catch{throw Object.assign(new AppError('Cline 续期请求未确认；未自动重试',503,'cline_refresh_unconfirmed'),{retryable:true});}
 const data=await readBoundedJson(response,active);
 if(!response.ok)throw Object.assign(new AppError(`Cline 官方续期失败 (HTTP ${response.status})`,response.status,'cline_refresh_failed'),response.status>=500||response.status===429?{retryable:true}:{});
 const d=data?.data;let token=d?.accessToken;
 if(data?.success!==true||typeof token!=='string'||!token||/[\r\n]/.test(token))throw new AppError('Cline 续期响应格式错误',502,'cline_refresh_invalid');
 if(String(auth.accessToken).startsWith('workos:')&&!token.startsWith('workos:'))token='workos:'+token;
 const oldSub=clineClaims(auth.accessToken).sub,newSub=clineClaims(token).sub;
 if(oldSub&&newSub&&oldSub!==newSub)throw new AppError('Cline 续期身份不一致',401,'cline_refresh_identity_mismatch');
 let expiresAt=clineExpiry(d.expiresAt);if(!Number.isFinite(expiresAt)){const exp=clineClaims(token).exp;if(typeof exp==='number'&&Number.isFinite(exp))expiresAt=exp*1000;}
 const refreshToken=d.refreshToken??auth.refreshToken;
 if(!(expiresAt>now)||typeof refreshToken!=='string'||!refreshToken)throw new AppError('Cline 续期响应缺少有效期限',502,'cline_refresh_invalid');
 rememberSecret(token);rememberSecret(refreshToken);
 return {...auth,accessToken:token,refreshToken,expiresAt};
}

async function cachedClineAuth(file,original,sourceHash,options={}) {
 const cacheFile=options.cacheFile??join(process.env.LOCALAPPDATA??homedir(),'AI Credit Gateway','private-cache',file===defaultClineCredentialFile()?'cline-oauth.json':'cline-'+hash(file).slice(0,16)+'.json');
 let cache;
 try{cache=JSON.parse(await readFile(cacheFile,'utf8'));if(cache.sourceHash!==sourceHash)cache=null;}catch(error){if(error.code==='ENOENT')cache=null;else throw new AppError('Cline 私有续期缓存需核验',409,'cline_refresh_cache_invalid');}
 const now=options.now??Date.now();let auth=cache?.accessToken?{...original,...cache}:original;
 if(!options.allowRefresh)return clineExpiry(auth?.expiresAt)>now?auth:original;
 if(cache?.refreshFailure&&(!cache.retryAt||now<cache.retryAt))throw clineBlockedRefresh(cache);
 if(clineExpiry(auth?.expiresAt)>now+60000||!auth?.refreshToken)return auth;
 await mkdir(dirname(cacheFile),{recursive:true});let lock;
 try{lock=await open(cacheFile+'.lock','wx',0o600);}catch{throw new AppError('Cline 续期正在处理或需核对上次结果',409,'cline_refresh_pending');}
 try{
  // A different process can publish between the initial cache read and lock acquisition.
  let latest;try{latest=JSON.parse(await readFile(cacheFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new AppError('Cline 私有续期缓存需核验',409,'cline_refresh_cache_invalid');}
  if(latest?.sourceHash===sourceHash){
   if(latest.refreshFailure&&(!latest.retryAt||now<latest.retryAt))throw clineBlockedRefresh(latest);
   if(latest.accessToken)auth={...original,...latest};
   if(clineExpiry(auth?.expiresAt)>now+60000)return auth;
  }
  let refreshed;try{refreshed=await refreshClineAuth(auth,options);}catch(error){await writeFile(cacheFile,JSON.stringify({...auth,sourceHash,refreshFailure:error.code??'cline_refresh_unconfirmed',failedAt:now,...(error.retryable?{retryAt:now+CLINE_RETRY_COOLDOWN}:{})}),{mode:0o600});throw error;}
  // Identity/expiry validation precedes publication. Original application credentials remain untouched.
  // A successful renewal must clear the failure markers inherited from the poisoned cache read,
  // otherwise the account stays "待检查" even after a valid token was obtained.
  const published={...refreshed,sourceHash};delete published.refreshFailure;delete published.retryAt;delete published.failedAt;
  const temp=cacheFile+'.'+randomBytes(6).toString('hex')+'.tmp';await writeFile(temp,JSON.stringify(published),{mode:0o600});await rename(temp,cacheFile);return published;
 }finally{await lock.close();await unlink(cacheFile+'.lock').catch(()=>{});}
}

async function loadClineSecret(file,options={}) {
  let data,source;
  try { source=await readFile(file,'utf8');data = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch (error) { throw new AppError(error.code === 'ENOENT' ? '未找到本机 Cline 登录配置' : 'Cline 本机配置无法解析', 401, 'cline_credential_unavailable'); }
  let auth = data?.providers?.cline?.settings?.auth ?? (data?.accessToken ? data : null);
  auth=await cachedClineAuth(file,auth,hash(source),options);
  const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : '';
  if (!token || /[\r\n]/.test(token)) throw new AppError('本机 Cline 未登录或凭据不可用', 401, 'cline_credential_missing');
  rememberSecret(token);
  const jwtToken=token.replace(/^workos:/i,''); rememberSecret(jwtToken);
  const segmentCount = jwtToken.split('.').length;
  let issuer = null; let subject = null;
  if (segmentCount === 3) { try { const claims = JSON.parse(Buffer.from(jwtToken.split('.')[1], 'base64url').toString('utf8')); issuer = claims.iss ?? null; subject = typeof claims.sub === 'string' ? claims.sub : null; } catch { issuer = null; } }
  const expiry=clineExpiry(auth?.expiresAt);
  const expiresAt = Number.isFinite(expiry) ? new Date(expiry).toISOString() : null;
  // Private credential: carries the token plus non-secret metadata. principal is a one-way digest of the
  // stable subject, so a re-issued token keeps the same binding and no account id ever leaves memory.
  return {
    token, accessToken: token, principal: 'cline:' + hash(subject ?? auth?.accountId ?? token).slice(0, 16),
    segmentCount, issuer, tokenType: auth?.metadata?.tokenType ?? null,
    expiresAt, expiresAtMs: expiresAt === null ? undefined : Date.parse(expiresAt),
    refreshTokenPresent: typeof auth?.refreshToken === 'string' && auth.refreshToken.length > 0,
    provider: data?.providers?.cline?.settings?.provider ?? null,
    tokenSource: data?.providers?.cline?.tokenSource ?? null,
  };
}

// Public view never carries the token; only presence and non-secret facts leave the process.
export function clineCredentialView(secret, now = Date.now()) {
  return {
    present: true, authKind: 'oauth_bearer', tokenType: secret.tokenType, issuer: secret.issuer,
    tokenSegments: secret.segmentCount, expiresAt: secret.expiresAt,
    expired: secret.expiresAt === null ? null : Date.parse(secret.expiresAt) <= now,
    refreshTokenPresent: secret.refreshTokenPresent, provider: secret.provider, tokenSource: secret.tokenSource,
  };
}

export async function readClineLocalCredential({file = defaultClineCredentialFile(), now = Date.now()} = {}) {
  return clineCredentialView(await loadClineSecret(file), now);
}

// Contract entry point: the private credential stays in memory and is handed to health/models/chat.
export async function resolveClineCredential(account = {}, config = {}, options={}) {
  const explicit = account?.credentials?.file;
  const file = explicit && explicit !== 'auto' ? (typeof config?.path === 'function' ? config.path(explicit) : explicit) : defaultClineCredentialFile();
  if(clineRefreshFlights.has(file))return clineRefreshFlights.get(file);
  const pending=loadClineSecret(file,{...options,allowRefresh:options.refresh!==false});clineRefreshFlights.set(file,pending);
  try{return await pending}finally{clineRefreshFlights.delete(file);}
}

// Both call styles work: contract style models(credential, options) and the legacy options bag {credentialFile}.
async function credentialOf(first, options) {
  if (typeof first?.token === 'string' && first.token) return {secret: first, options: {...options}};
  const {credentialFile, credential, ...rest} = first ?? {};
  return {secret: credential ?? await loadClineSecret(credentialFile ?? defaultClineCredentialFile()), options: {...rest, ...options}};
}

function clineEndpoint(url) {
  const target = new URL(url);
  const balancePath = /^\/api\/v1\/users\/[A-Za-z0-9_-]{1,160}\/balance$/.test(target.pathname);
  if (target.origin !== CLINE_API_ORIGIN || target.username || target.password || target.search || target.hash || (!CLINE_PATHS.has(target.pathname) && !balancePath))
    throw new AppError('Cline 适配器仅连接官方固定端点', 400, 'cline_endpoint_invalid');
  return target;
}

export async function clineFetch(url, {fetchImpl = fetch, method = 'GET', token, signal, timeoutMs = 30000} = {}) {
  const target = clineEndpoint(url);
  const activeSignal = signal ?? AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(target.href, {method, redirect: 'error', signal: activeSignal, headers: {Accept: 'application/json', Authorization: `Bearer ${token}`}});
  } catch (error) {
    if (activeSignal.aborted || error?.name === 'AbortError') throw new AppError('Cline 请求已取消或超时', 499, 'request_cancelled');
    throw new AppError('Cline 官方接口连接失败', 503, 'cline_network_error');
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new AppError(`Cline 官方接口请求失败 (HTTP ${response.status})`, response.status, response.status === 401 || response.status === 403 ? 'cline_auth_failed' : 'cline_upstream_error'); }
  return readBoundedJson(response, activeSignal);
}

async function readBoundedJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('Cline 官方接口返回空响应', 502, 'cline_invalid_response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once: true});
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      if (signal?.aborted) throw new AppError('Cline 请求已取消或超时', 499, 'request_cancelled');
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) throw new AppError('Cline 响应超过大小上限', 502, 'cline_response_too_large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError('Cline 官方接口响应 JSON 格式错误', 502, 'cline_invalid_response'); }
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Official VSCode display pipeline: getUserCredits divides raw balance by 100;
// StyledCreditDisplay -> formatCreditsBalance divides that result by 10,000.
// This is account credits, not USD, daily rewards, or subscription usage remaining.
export function clineBalance(data, userId) {
  const base = {value:null,unit:'credits',parts:[],status:'unknown',reason:'balance_not_fetched',
    note:'账号余额待获取；未估算剩余',source:'https://api.cline.bot/api/v1/users/{authenticated-user-id}/balance'};
  if (data === undefined) return base;
  const row = data?.data;
  if (data?.success !== true || !row || row.userId !== userId || typeof row.balance !== 'number' || !Number.isFinite(row.balance))
    throw new AppError('Cline 余额响应格式或账号关联不符',502,'cline_balance_schema');
  return {...base,value:row.balance / 1000000,status:'known',reason:null,
    rawValue:row.balance,rawUnit:'api_balance',displayDivisor:1000000,
    note:'官方账号 credits；按官方客户端完整显示链换算，不是每日签到奖励或订阅剩余量'};
}

// Cline has no sign-in reward concept in the official docs or the shipped client.
export function clineCheckin() {
  return {status: 'unsupported', reason: 'no_checkin_concept'};
}

export async function clineHealth(first, options = {}) {
  const {secret, options: rest} = await credentialOf(first, options);
  const view = clineCredentialView(secret, rest.now);
  const base = {
    descriptor: clineDescriptor,
    credential: view,
    accountPresent: false,
    checkinSupported: false,
    supportsCheckin: false,
    capabilities: {checkin: false, inference: true, balance: true},
    checkin: clineCheckin(),
    balance: clineBalance(),
    billingIdentity: 'cline:' + secret.principal,
  };
  // Report an already-expired local token explicitly; never infer authentication from the public catalog.
  if (view.expired === true) return {...base, status: 'credential_expired', reason: 'credential_expired'};
  const data = await clineFetch(`${CLINE_API_ORIGIN}/api/v1/users/me`, {token: secret.token, ...rest});
  const authenticated = data?.success === true && typeof data?.data?.id === 'string' && Boolean(data.data.id);
  let balance = base.balance;
  if (authenticated) {
    try {
      const id = data.data.id;
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new AppError('Cline 账号关联格式错误',502,'cline_balance_schema');
      const payload = await clineFetch(`${CLINE_API_ORIGIN}/api/v1/users/${encodeURIComponent(id)}/balance`, {token:secret.token,...rest});
      balance = clineBalance(payload,id);
    } catch (error) {
      if (error?.code === 'request_cancelled') throw error;
      balance = {...base.balance,reason:error?.code ?? 'cline_balance_unavailable',
        note:'账号已认证；余额接口本次未返回可验证结果',httpStatus:Number.isInteger(error?.status)?error.status:null};
    }
  }
  return {
    ...base,
    balance,
    status: authenticated ? 'authenticated' : 'unknown',
    accountPresent: authenticated,
  };
}

function catalogRow(row) {
  const contextWindow = Number.isSafeInteger(row?.context_length) && row.context_length > 0 ? row.context_length : null;
  const maxTokens = Number.isSafeInteger(row?.top_provider?.max_completion_tokens) && row.top_provider.max_completion_tokens > 0 ? row.top_provider.max_completion_tokens : null;
  const inputModalities = Array.isArray(row?.architecture?.input_modalities) ? row.architecture.input_modalities : [];
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    name: typeof row?.name === 'string' ? row.name : null,
    contextWindow,
    maxTokens,
    tools: Array.isArray(row?.supported_parameters) && row.supported_parameters.includes('tools'),
    multimodal: inputModalities.some(modality => modality !== 'text'),
    // Unknown capacity stays null/unpublished. Catalog declaration and observed generation remain separate.
    callable: contextWindow !== null && maxTokens !== null,
    verification: 'official_catalog',
    generationVerified: row?.id === 'liquid/lfm-2.5-2.6b:free',
    metadataSource: 'https://api.cline.bot/api/v1/ai/cline/models',
    inputModalities,
  };
}

export async function clineModels(first, options = {}) {
  const {secret, options: rest} = await credentialOf(first, options);
  const {limit = 5000, ...fetchOptions} = rest;
  const data = await clineFetch(`${CLINE_API_ORIGIN}/api/v1/ai/cline/models`, {token: secret.token, ...fetchOptions});
  if (!Array.isArray(data?.data)) throw new AppError('Cline 模型目录格式错误', 502, 'cline_catalog_schema');
  if (data.data.length > limit) throw new AppError('Cline 模型目录超过条目上限', 502, 'cline_catalog_too_large');
  return data.data.map(catalogRow).filter(row => row.id !== null);
}

// Cline has no check-in concept: report it honestly instead of inventing a balance or a claim.
export function clineStatus(credential, task = 'daily-checkin') {
  const expiresAt = credential?.expiresAt ?? (Number.isFinite(credential?.expiresAtMs) ? new Date(credential.expiresAtMs).toISOString() : null);
  const expired = expiresAt === null ? null : Date.parse(expiresAt) <= Date.now();
  return {
    known: true, active: false, supportsCheckin: false, claimable: false, claimed: false,
    task, day: dayIn(), principal: credential?.principal ?? null,
    credentialExpired: expired, credentialExpiresAt: expiresAt,
    reason: 'no_checkin_concept', source: 'no_official_checkin_endpoint',
  };
}

export function clineClaim(credential, task = 'daily-checkin') {
  return {...clineStatus(credential, task), submitted: false, refused: true, reason: 'no_checkin_concept'};
}

export function clineChatBody(input = {}, fallbackModel) {
  const source = {...input};
  if (source.model === undefined) source.model = fallbackModel;
  if (typeof source.model !== 'string' || !source.model.trim()) throw new AppError('Cline 聊天请求缺少 model', 400, 'cline_chat_request_invalid');
  if (!Array.isArray(source.messages) || source.messages.length === 0) throw new AppError('Cline 聊天请求缺少 messages', 400, 'cline_chat_request_invalid');
  const body = {};
  for (const key of CHAT_FIELDS) if (source[key] !== undefined) body[key] = source[key];
  return body;
}

// Faithful passthrough: the upstream Response (SSE body stream or JSON) is returned verbatim.
export async function clineChat(upstream, credential, input, signal, options = {}) {
  const token = typeof credential?.token === 'string' ? credential.token.trim() : '';
  if (!token) throw new AppError('Cline 登录态待就绪', 401, 'cline_credential_missing');
  rememberSecret(token);
  const target = clineEndpoint(`${CLINE_API_ORIGIN}${CLINE_CHAT_PATH}`);
  const body = JSON.stringify(clineChatBody(input, upstream?.model));
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  // The documented default is stream:true/SSE, so Accept tracks what was actually requested.
  const accept = input.stream === false ? 'application/json' : 'text/event-stream';
  try {
    response = await fetchImpl(target.href, {
      method: 'POST', redirect: 'error',
      // ponytail: one overall cap when the caller supplies no signal; the caller's signal always wins.
      signal: signal ?? AbortSignal.timeout(options.timeoutMs ?? 900000),
      headers: {Accept: accept, 'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body,
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new AppError('Cline 请求已取消或超时', 499, 'request_cancelled');
    throw new AppError('Cline 官方接口连接失败', 503, 'cline_network_error');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(`Cline 聊天接口请求失败 (HTTP ${response.status})`, response.status, response.status === 401 || response.status === 403 ? 'cline_auth_failed' : 'cline_upstream_error');
  }
  if((response.headers.get('content-type')??'').includes('text/event-stream'))return {response:await desktopSseResponse(response,{stream:input.stream===true,model:input.model,signal,prefix:'cline'})};
  const json=await readBoundedJson(response,signal);const completion=json?.data??json;
  if(json?.success===false||completion?.error)throw new AppError('Cline 返回业务错误',502,'cline_business_error');
  if(!Array.isArray(completion?.choices))throw new AppError('Cline 完成响应格式错误',502,'cline_completion_schema');
  return {response:Response.json(completion)};
}

export function clineErrorView(error) { return {code: error?.code ?? 'cline_error', message: redact(error?.message ?? String(error)).slice(0, 300), status: error?.status ?? 502}; }

export const clineProvider = {resolve: resolveClineCredential, models: clineModels, health: clineHealth, status: clineStatus, claim: clineClaim, chat: clineChat, descriptor: clineDescriptor, supportsCheckin: false};
