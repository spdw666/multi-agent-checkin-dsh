import {desktopSseResponse} from './provider-sse.mjs';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
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

async function loadClineSecret(file) {
  let data;
  try { data = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { throw new AppError(error.code === 'ENOENT' ? '未找到本机 Cline 登录配置' : 'Cline 本机配置无法解析', 401, 'cline_credential_unavailable'); }
  let auth = data?.providers?.cline?.settings?.auth ?? (data?.accessToken ? data : null);
  if(file === defaultClineCredentialFile()) {
   try { const cache=JSON.parse(await readFile(join(process.env.LOCALAPPDATA??homedir(),'AI Credit Gateway','private-cache','cline-oauth.json'),'utf8'));
    const sourceHash=hash(await readFile(file,'utf8'));
    if(cache.sourceHash===sourceHash && cache.expiresAt>Date.now() && cache.accessToken)auth={...auth,...cache};
   } catch { /* no matching gateway-owned cache: preserve source credential */ }
  }
  const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : '';
  if (!token || /[\r\n]/.test(token)) throw new AppError('本机 Cline 未登录或凭据不可用', 401, 'cline_credential_missing');
  rememberSecret(token);
  const jwtToken=token.replace(/^workos:/i,''); rememberSecret(jwtToken);
  const segmentCount = jwtToken.split('.').length;
  let issuer = null; let subject = null;
  if (segmentCount === 3) { try { const claims = JSON.parse(Buffer.from(jwtToken.split('.')[1], 'base64url').toString('utf8')); issuer = claims.iss ?? null; subject = typeof claims.sub === 'string' ? claims.sub : null; } catch { issuer = null; } }
  const expiresAt = Number.isFinite(auth?.expiresAt) ? new Date(auth.expiresAt).toISOString() : null;
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
export async function resolveClineCredential(account = {}, config = {}) {
  const explicit = account?.credentials?.file;
  const file = explicit && explicit !== 'auto' ? (typeof config?.path === 'function' ? config.path(explicit) : explicit) : defaultClineCredentialFile();
  return loadClineSecret(file);
}

// Both call styles work: contract style models(credential, options) and the legacy options bag {credentialFile}.
async function credentialOf(first, options) {
  if (typeof first?.token === 'string' && first.token) return {secret: first, options: {...options}};
  const {credentialFile, credential, ...rest} = first ?? {};
  return {secret: credential ?? await loadClineSecret(credentialFile ?? defaultClineCredentialFile()), options: {...rest, ...options}};
}

function clineEndpoint(url) {
  const target = new URL(url);
  if (target.origin !== CLINE_API_ORIGIN || target.username || target.password || target.search || target.hash || !CLINE_PATHS.has(target.pathname))
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

// Balance/credits are rendered by app.cline.bot; no callable endpoint was confirmed, so nothing is invented.
export function clineBalance() {
  return {value:null,unit:'credits',parts:[],note:'已认证 users/me 未返回额度字段；未估算余额',status:'unknown',reason:'identity_response_has_no_credits',source:'https://api.cline.bot/api/v1/users/me'};
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
    capabilities: {checkin: false, inference: true, balance: false},
    checkin: clineCheckin(),
    balance: clineBalance(),
    billingIdentity: 'cline:' + secret.principal,
  };
  // An already-expired local token is reported as such instead of being dressed up as 'authenticated'.
  // Live evidence: this account's WorkOS access token expired 2026-10-11T05:08:01Z and every authenticated
  // call then answered HTTP 401 (see docs/provider-cline.md); no doomed round trip is attempted here.
  if (view.expired === true) return {...base, status: 'credential_expired', reason: 'credential_expired'};
  const data = await clineFetch(`${CLINE_API_ORIGIN}/api/v1/users/me`, {token: secret.token, ...rest});
  return {
    ...base,
    status: data?.success === true ? 'authenticated' : 'unknown',
    accountPresent: Boolean(data?.data?.id),
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
    // Verified capacity only: an unconfirmed window/max keeps null and stays uncallable. No generation has
    // been completed from this module yet (live attempt answered 401, expired local token), so callable means
    // "capacity is officially declared and the transport is implemented" - not "observed working".
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
