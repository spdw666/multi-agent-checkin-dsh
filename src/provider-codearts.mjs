import {desktopSseResponse,desktopCompletionLimit} from './provider-sse.mjs';
import {join,dirname} from 'node:path';
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {createHash,createHmac,createDecipheriv,createPrivateKey,sign,randomBytes} from 'node:crypto';
import {dpapiUnprotect} from './windows-crypto.mjs';
import {redact,rememberSecret,AppError,dayIn} from './util.mjs';

// Huawei Cloud CodeArts Agent (码道) adapter, now with the real IAM request signing.
//
// Endpoint/auth facts are double-sourced:
//   (a) installed IDE — product.json `snapApigDomain` + kernel logs (`GET /v1/model/builtin`);
//   (b) a working third-party implementation, MIT, (c) RobbsLuo/Coding2API
//       src/provider/codearts/{signer,client,events,credential}.py — LOCAL COPY at
//       work/platform-expansion/peer-review/references/codearts-*.py, license at
//       .../references/codearts-LICENSE. The signer in this module is a line-by-line
//       translation of that file; the endpoint list is taken from its constants.
//   (c) official signing spec: https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html
// Everything below was additionally verified live on this machine (2026-10-11) — see
// docs/provider-codearts.md §2.
export const CODEARTS_ORIGIN = 'https://snap-access.cn-north-4.myhuaweicloud.com';
const MAX_BODY = 1024 * 1024;
const SESSION_KEY = 'huaweicloud.codearts-snap';
const AGENT_TYPE = 'PromptCenter';
const OPS_CHANNEL = 'IDE';
// 「每日签到领1000 积分」的活动 ID；delivery 同时返回推荐码(3)/新用户(4)/学生认证(2)。
const DAILY_CAMPAIGN_ID = 1;

// Route table: the ONLY method+path(+exact query) pairs this adapter will sign. The query
// participates in the signature, so it is part of the key rather than a free-form argument.
const ROUTES = new Map([
  ['GET /v1/model/builtin', {agentType: AGENT_TYPE}],
  ['GET /snap-manager/v1/statistics/plugin', {}],
  ['GET /snap-manager/v1/current/user', {}],
  [`GET /v1/ops/delivery?channel=${OPS_CHANNEL}`, {agentType: AGENT_TYPE}],
  ['POST /v1/ops/claim', {agentType: AGENT_TYPE}],
  ['POST /v1/ops/confirm', {agentType: AGENT_TYPE}],
  ['POST /api/v2/chat/completions', {agentType: null}],
]);
export const codeartsDescriptor = Object.freeze({
  id: 'codearts',
  name: '华为云码道 CodeArts Agent',
  authKind: 'iam_aksk_hmac',
  checkinSupported: true,
  underlyingProvider: 'huaweicloud-snap-access',
  billing: 'official_points',
  byok: false,
  origin: CODEARTS_ORIGIN,
  checkinSource: 'https://support.huaweicloud.com/price-codeartsagent/codeartsagent_billing_0029.html',
  signingSource: 'https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html',
});

// Credited to the snap business-credit ledger only. The legacy opengw token pool
// (`opengw.developer.huaweicloud.com/api/v1/user/tokens/balance`) is a SEPARATE account
// and is deliberately never read here: mixing the two would double-count the same account.
export const CODEARTS_BALANCE_SOURCE = Object.freeze({
  endpoint: '/snap-manager/v1/statistics/plugin', unit: 'CREDIT', ledger: 'snap-business-credits',
  excludes: 'opengw-token-pool',
});

export const codeartsCheckinSource = Object.freeze({
  endpoint: `/v1/ops/delivery?channel=${OPS_CHANNEL}`, campaignId: DAILY_CAMPAIGN_ID,
  claimEndpoint: '/v1/ops/claim', confirmEndpoint: '/v1/ops/confirm', unit: 'CREDIT',
});

// Native tool calls are confirmed; forced tool-choice and complete roundtrips are separate capabilities.
export const CODEARTS_CHAT_PATH = '/api/v2/chat/completions';

/** Fields the snap v2 engine accepts verbatim. `tool_choice` is deliberately NOT here — see above. */
export const CODEARTS_PASSTHROUGH = Object.freeze([
  'temperature', 'top_p', 'max_tokens', 'reasoning_effort', 'tools',
  'stop', 'presence_penalty', 'frequency_penalty', 'response_format',
]);

/** Distinct upstream failures: do not retry expired IAM credentials as transport noise. */
export const CODEARTS_TRANSIENT_CODES = Object.freeze({
  APIG: {code: 'APIG.0301', meaning: 'IAM 认证失败；检查临时凭据有效期，不自动重试过期凭据', retryable: false},
  CONCURRENCY: {code: 'TM.00001041', meaning: '账号并发会话数上限（3）已满，HTTP 400', retryable: true},
  TOOL_CHOICE: {code: 'InferHub.001001005.400', meaning: '引擎拒绝 tool_choice 参数（HTTP 200 流内业务错误）', retryable: false},
});

/**
 * Model ids that a LIVE probe observed returning genuine native `tool_calls`.
 * Only entries on this list may be published as `tools:true`; the evidence column is the
 * scratch file a reviewer can re-read. Models absent from this list stay `tools:false`
 * (unproven ≠ unsupported).
 */
export const CODEARTS_TOOLS_VERIFIED = Object.freeze({
  'GLM-5.2': 'dsh-codearts-model-tools.jsonl',
  'Qwen3-VL-235B': 'dsh-codearts-model-tools.jsonl',
  'kimi-k2.6-vl': 'dsh-codearts-model-tools.jsonl',
  'glm-5.2-sft-harmony': 'dsh-codearts-model-tools.jsonl',
});

/** Models with observed native output; callability still requires a declared local capacity. */
export const CODEARTS_CHAT_VERIFIED = Object.freeze({
  'GLM-5.2': 'codearts-four-links.json 普通/SSE 通过 + dsh-codearts-tools-probe.jsonl',
  'Qwen3-VL-235B': 'dsh-codearts-model-tools.jsonl (HTTP 200 + tool_calls)',
  'kimi-k2.6-vl': 'dsh-codearts-model-tools.jsonl (HTTP 200 + tool_calls)',
  'glm-5.2-sft-harmony': 'dsh-codearts-model-tools.jsonl (HTTP 200 + tool_calls)',
});

export const defaultCodeArtsStateDb = () => join(process.env.APPDATA ?? '', 'codearts-agent', 'User', 'globalStorage', 'state.vscdb');

// ------------------------------------------------------------------ signature

const SIGNING_ALGORITHM = 'SDK-HMAC-SHA256';
const sha256Hex = payload => createHash('sha256').update(payload).digest('hex');
const hmacSha256Hex = (key, message) => createHmac('sha256', key).update(message, 'utf8').digest('hex');
// encodeURIComponent leaves !'()* unescaped; RFC3986 (and the Python reference's quote(safe=""))
// escapes them. Huawei Cloud paths never contain them, but match exactly rather than by luck.
const rfc3986 = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** `X-Sdk-Date` format: UTC `YYYYMMDDTHHMMSSZ`. */
export const sdkDate = (now = Date.now()) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** Canonical URI: each segment percent-encoded, trailing `/` appended. Missing the slash → APIG.0301. */
export function canonicalUri(path) {
  const joined = String(path || '/').split('/').map(rfc3986).join('/');
  return joined.endsWith('/') ? joined : `${joined}/`;
}

/** Canonical query: key and value both quoted, pairs sorted, `k=v` joined by `&`. */
export function canonicalQuery(rawQuery) {
  if (!rawQuery) return '';
  const pairs = [];
  for (const part of String(rawQuery).split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    const key = index < 0 ? part : part.slice(0, index);
    const value = index < 0 ? '' : part.slice(index + 1);
    pairs.push([rfc3986(key), rfc3986(value)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

// Header values are stripped and CR/LF-removed before signing: the canonical request is
// newline-delimited, so an embedded newline would change its structure.
const cleanHeaderValue = value => String(value).replace(/[\r\n]/g, '').trim();

/**
 * Build the canonical request (and its intermediate values) for one request.
 * Exported so the official worked example can be asserted step by step:
 * https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html
 * (it publishes GET /v1/{project_id}/vpcs/ + limit/marker and the HashedCanonicalRequest).
 */
export function buildCanonicalRequest({method, path, rawQuery = '', headers = {}, payload = Buffer.alloc(0), xSdkDate}) {
  if (typeof xSdkDate !== 'string' || !xSdkDate) throw new AppError('CodeArts 签名缺少 X-Sdk-Date', 500, 'codearts_sign_invalid');
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const payloadHash = sha256Hex(body);
  const lowered = {};
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = cleanHeaderValue(value);
  // X-Sdk-Date is always part of the signed set (idempotent when the caller already merged it in).
  lowered['x-sdk-date'] = cleanHeaderValue(xSdkDate);
  const keys = Object.keys(lowered).sort();
  const canonicalHeaderText = keys.map(key => `${key}:${lowered[key]}\n`).join('');
  const signedHeaders = keys.join(';');
  const canonicalRequest = [String(method).toUpperCase(), canonicalUri(path), canonicalQuery(rawQuery), canonicalHeaderText, signedHeaders, payloadHash].join('\n');
  return {canonicalRequest, canonicalUri: canonicalUri(path), canonicalQuery: canonicalQuery(rawQuery), canonicalHeaderText, signedHeaders, payloadHash, hashedCanonicalRequest: sha256Hex(Buffer.from(canonicalRequest, 'utf8'))};
}

/**
 * Sign one request and return the COMPLETE header set (input is not mutated).
 * Pure function: no wall-clock reads, so fixed vectors reproduce exactly.
 */
export function signCodeArtsRequest(credential, {method, path, rawQuery = '', headers = {}, payload = Buffer.alloc(0), xSdkDate} = {}) {
  if (!credential?.accessKey || !credential?.secretKey) throw new AppError('CodeArts 临时 AK/SK 不可用', 401, 'codearts_credential_missing');
  const merged = {};
  for (const [key, value] of Object.entries(headers)) merged[key] = String(value);
  merged['X-Sdk-Date'] = xSdkDate;
  if (credential.securityToken) merged['X-Security-Token'] = credential.securityToken;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  merged['X-Sdk-Content-Sha256'] = sha256Hex(body);

  const {signedHeaders, hashedCanonicalRequest} = buildCanonicalRequest({method, path, rawQuery, headers: merged, payload: body, xSdkDate});
  const stringToSign = [SIGNING_ALGORITHM, xSdkDate, hashedCanonicalRequest].join('\n');
  const signature = hmacSha256Hex(credential.secretKey, stringToSign);
  merged.Authorization = `${SIGNING_ALGORITHM} Access=${credential.accessKey}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return merged;
}

// ------------------------------------------------------------------ credential

/**
 * Read the local IDE session. The IAM temporary AK/SK/securityToken are the real credential —
 * `securityToken` is NOT an `x-auth-token` (that is what produced APIG.0301 in the earlier probe).
 * Returns a PRIVATE object; only `codeartsCredentialView` may leave the process.
 */
export async function readCodeArtsLocalSession({file = defaultCodeArtsStateDb()} = {}) {
  const {DatabaseSync} = await import('node:sqlite');
  let db;
  try { db = new DatabaseSync(file, {readOnly: true}); }
  catch (error) { throw new AppError(error.code === 'ENOENT' ? '未找到本机 CodeArts Agent 配置' : 'CodeArts 会话库无法只读打开', 401, 'codearts_state_unavailable'); }
  try {
    const row = db.prepare('select value from ItemTable where key=?').get(SESSION_KEY);
    if (!row) throw new AppError('本机 CodeArts Agent 无登录会话', 401, 'codearts_session_missing');
    const snap = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
    const origin = snap?.userInfoKey?.originData;
    const accessKey = typeof origin?.accessKey === 'string' ? origin.accessKey.trim() : '';
    const secretKey = typeof origin?.secretKey === 'string' ? origin.secretKey.trim() : '';
    const securityToken = typeof origin?.securityToken === 'string' ? origin.securityToken.trim() : '';
    if (!accessKey || !secretKey || !securityToken) throw new AppError('本机 CodeArts Agent 会话缺少临时 AK/SK', 401, 'codearts_session_missing');
    rememberSecret(accessKey); rememberSecret(secretKey); rememberSecret(securityToken);
    const expiresAt = Number.isFinite(Date.parse(origin?.expiresAt)) ? new Date(Date.parse(origin.expiresAt)).toISOString() : null;
    return {
      accessKey, secretKey, securityToken, expiresAt,
      accessToken:securityToken, principal:"codearts:"+sha256Hex(Buffer.from(String(origin?.id ?? origin?.account ?? origin?.domainId ?? snap?.userInfoKey?.id))).slice(0,24),
      loginType: snap?.userInfoKey?.loginType ?? null, stationType: origin?.stationType ?? null,
      domainId: typeof origin?.domainId === 'string' ? origin.domainId : null,
      hasStaticAccessToken: typeof origin?.accessToken === 'string' && origin.accessToken.length > 0,
      scopesEmpty: Array.isArray(origin?.scopes) && origin.scopes.length === 0,
      source: 'ide_state_vscdb',
    };
  } finally { db.close(); }
}

export const CODEARTS_TOKEN_URL='https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
const codeartsRefreshFlights=new Map();
export function codeartsDpop(auth,now=Date.now()) {
 const pair=auth?.loginContext?.dpopKeyPair;
 if(!pair?.privateKeyJwk?.d || !pair?.publicKeyJwk)throw new AppError('CodeArts 官方续期上下文缺失',401,'codearts_refresh_context_missing');
 const {kty,crv,x,y}=pair.publicKeyJwk;
 if(kty!=='EC'||crv!=='P-256'||typeof x!=='string'||typeof y!=='string')throw new AppError('CodeArts DPoP 公钥格式错误',401,'codearts_refresh_context_missing');
 const header=Buffer.from(JSON.stringify({alg:'ES256',typ:'dpop+jwt',jwk:{kty,crv,x,y}})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({htm:'POST',htu:CODEARTS_TOKEN_URL,iat:Math.floor(now/1000),jti:randomBytes(32).toString('hex')})).toString('base64url');
 const content=header+'.'+payload;
 return content+'.'+sign('sha256',Buffer.from(content),{key:createPrivateKey({key:pair.privateKeyJwk,format:'jwk'}),dsaEncoding:'ieee-p1363'}).toString('base64url');
}

// Same official PKCE + DPoP refresh request as the installed huaweicloud.authentication extension.
// Refresh tokens rotate once; no automatic network retry or fallback to a previously consumed token.
export async function refreshCodeArtsAuth(auth,{fetchImpl=fetch,now=Date.now(),signal}={}) {
 const verifier=auth?.loginContext?.pkcePair?.codeVerifier;
 if(!auth?.refresh_token || typeof verifier!=='string' || !verifier)throw new AppError('CodeArts 官方续期上下文缺失',401,'codearts_refresh_context_missing');
 for(const s of [auth.refresh_token,verifier,auth.loginContext?.dpopKeyPair?.privateKeyJwk?.d])rememberSecret(s);
 let response;
 try {response=await fetchImpl(CODEARTS_TOKEN_URL,{method:'POST',redirect:'error',signal:signal??AbortSignal.timeout(30000),
  headers:{DPoP:codeartsDpop(auth,now),'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({client_id:'codearts-agent',code_verifier:verifier,grant_type:'refresh_token',refresh_token:auth.refresh_token}).toString()});}
 catch {throw new AppError('CodeArts 续期请求未确认；未自动重试',503,'codearts_refresh_unconfirmed');}
 const text=await readBoundedText(response,signal);let data;try{data=JSON.parse(text)}catch{throw new AppError('CodeArts 续期响应格式错误',502,'codearts_refresh_invalid');}
 if(!response.ok){const error=new AppError('CodeArts 官方续期失败',response.status,'codearts_refresh_failed');error.upstreamCode=typeof data?.error_code==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(data.error_code)?data.error_code:null;
  const terminal=data?.error==='invalid_grant'||/ExpiredRefreshToken/.test(error.upstreamCode??'');
  if(!terminal&&(response.status===429||/InvalidDPoPHeader/.test(error.upstreamCode??''))){error.retryable=true;error.retryAt=now+600000;}
  throw error;}
 const c=data?.credentials;
 if(!c||![c.access_key_id,c.secret_access_key,c.security_token,data.refresh_token].every(v=>typeof v==='string'&&v.length>0)||!(Date.parse(c.expiration)>now))
  throw new AppError('CodeArts 续期响应缺少有效凭据',502,'codearts_refresh_invalid');
 for(const s of [c.access_key_id,c.secret_access_key,c.security_token,data.refresh_token])rememberSecret(s);
 return {...auth,accessKey:c.access_key_id,secretKey:c.secret_access_key,securitytoken:c.security_token,expires_at:c.expiration,refresh_token:data.refresh_token};
}

async function nativeCodeArtsStored(file) {
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
 try {const value=db.prepare('select value from ItemTable where key=?').get('secret://'+JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'}))?.value;
  if(!value)return null;const text=typeof value==='string'?value:Buffer.from(value).toString('utf8');return {text,sourceHash:sha256Hex(Buffer.from(text))};
 }finally{db.close();}
}
async function decryptCodeArtsAuth(stored,localState) {
 const bytes=Buffer.from(JSON.parse(stored.text)?.data??[]),wrapped=Buffer.from(JSON.parse(await readFile(localState,'utf8'))?.os_crypt?.encrypted_key??'','base64');
 if(!['v10','v11'].includes(bytes.subarray(0,3).toString())||wrapped.subarray(0,5).toString()!=='DPAPI')throw new AppError('CodeArts 本机凭据封装未识别',401,'codearts_storage_format');
 const key=await dpapiUnprotect(wrapped.subarray(5));let plain;
 try{const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(3,15));d.setAuthTag(bytes.subarray(-16));plain=Buffer.concat([d.update(bytes.subarray(15,-16)),d.final()]);return JSON.parse(plain.toString('utf8'));}
 catch{throw new AppError('CodeArts 本机凭据解密失败',401,'codearts_decrypt_failed');}
 finally{key.fill(0);plain?.fill(0);}
}
function credentialFromCodeArtsAuth(base,auth,source) {
 if(![auth?.accessKey,auth?.secretKey,auth?.securitytoken].every(v=>typeof v==='string'&&v))throw new AppError('CodeArts 凭据格式错误',401,'codearts_refresh_invalid');
 for(const s of [auth.accessKey,auth.secretKey,auth.securitytoken])rememberSecret(s);
 return {...base,accessKey:auth.accessKey,secretKey:auth.secretKey,securityToken:auth.securitytoken,accessToken:auth.securitytoken,expiresAt:auth.expires_at,source};
}
async function publishCodeArtsCache(file,data){const temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';await writeFile(temp,JSON.stringify(data),{mode:0o600});await rename(temp,file);}
async function resolveCodeArtsFresh(base,file,options={}) {
 const stored=await nativeCodeArtsStored(file);if(!stored)return base;
 const cacheFile=options.cacheFile??join(process.env.LOCALAPPDATA??dirname(file),'AI Credit Gateway','private-cache','codearts-'+sha256Hex(Buffer.from(file)).slice(0,16)+'.json');
 const now=options.now??Date.now();
 const localState=options.localState??join(dirname(dirname(dirname(file))),'Local State');
 const original=await (options.decryptAuthImpl??decryptCodeArtsAuth)(stored,localState);
 const sourceCredentialHash=sha256Hex(Buffer.from(JSON.stringify([base.principal,original.refresh_token??null,original.loginContext?.pkcePair?.codeVerifier??null,['kty','crv','x','y'].map(k=>original.loginContext?.dpopKeyPair?.publicKeyJwk?.[k]??null)])));
 const matches=value=>value?.sourceCredentialHash?value.sourceCredentialHash===sourceCredentialHash:value?.sourceHash===stored.sourceHash;
 let cached;
 try{cached=JSON.parse(await readFile(cacheFile,'utf8'));if(!matches(cached))cached=null;}catch(error){if(error.code==='ENOENT')cached=null;else throw new AppError('CodeArts 私有续期缓存需核验',409,'codearts_refresh_cache_invalid');}
 if(Date.parse(original.expires_at)>now+60000&&cached?.auth?.accessKey!==original.accessKey)return credentialFromCodeArtsAuth(base,original,'ide_secret_storage');
 if(cached?.retryAt&&now<cached.retryAt)throw Object.assign(new AppError('CodeArts 续期暂缓，稍后自动重试',429,'codearts_refresh_deferred'),{retryAt:cached.retryAt});
 if(cached?.refreshFailure&&(!cached.retryAt||now<cached.retryAt))throw new AppError('CodeArts 上次续期未确认；等待本机登录态更新',401,'codearts_refresh_needs_login');
 if(cached?.auth && Date.parse(cached.auth.expires_at)>now+60000)return credentialFromCodeArtsAuth(base,cached.auth,'gateway_private_refresh_cache');
 let auth=cached?.auth??original;
 if(Date.parse(auth.expires_at)>now+60000)return credentialFromCodeArtsAuth(base,auth,'ide_secret_storage');
 if(!auth.refresh_token||!auth.loginContext)return base;
 await mkdir(dirname(cacheFile),{recursive:true});let lock;
 try{lock=await open(cacheFile+'.lock','wx',0o600);}catch{throw new AppError('CodeArts 续期正在处理或需核对上次结果',409,'codearts_refresh_pending');}
 try{
  // Re-read while holding the cross-process lock before consuming a rotating token.
  let latest;try{latest=JSON.parse(await readFile(cacheFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new AppError('CodeArts 私有续期缓存需核验',409,'codearts_refresh_cache_invalid');}
  if(matches(latest)){
   if(latest.retryAt&&now<latest.retryAt)throw Object.assign(new AppError('CodeArts 续期暂缓，稍后自动重试',429,'codearts_refresh_deferred'),{retryAt:latest.retryAt});
   if(latest.refreshFailure&&(!latest.retryAt||now<latest.retryAt))throw new AppError('CodeArts 上次续期未确认；等待本机登录态更新',401,'codearts_refresh_needs_login');
   if(latest.auth)auth=latest.auth;
   if(Date.parse(auth.expires_at)>now+60000)return credentialFromCodeArtsAuth(base,auth,'gateway_private_refresh_cache');
  }
  if((await nativeCodeArtsStored(file))?.sourceHash!==stored.sourceHash)throw new AppError('CodeArts 原生会话已更新，将重新读取后续期',409,'codearts_refresh_source_changed');
  let refreshed;
  await publishCodeArtsCache(cacheFile,{sourceHash:stored.sourceHash,sourceCredentialHash,auth,refreshFailure:'codearts_refresh_pending'});
  try{refreshed=await refreshCodeArtsAuth(auth,options);}catch(error){
   // Keep a marker tied to the source login so polling does not replay a rotating token.
   await publishCodeArtsCache(cacheFile,{sourceHash:stored.sourceHash,sourceCredentialHash,auth,refreshFailure:error.code??'codearts_refresh_unconfirmed',...(error.retryable?{retryAt:error.retryAt}:{})});throw error;
  }
  await publishCodeArtsCache(cacheFile,{sourceHash:stored.sourceHash,sourceCredentialHash,auth:refreshed});
  return credentialFromCodeArtsAuth(base,refreshed,'gateway_private_refresh_cache');
 }finally{await lock.close();await unlink(cacheFile+'.lock').catch(()=>{});}
}
export async function resolveCodeArtsCredential(account={},config={},options={}) {
 const ref=account?.credentials?.file??account?.credentials?.path??account.file;
 const file=ref&&ref!=='auto'?(typeof config.path==='function'?config.path(ref):ref):defaultCodeArtsStateDb();
 if(codeartsRefreshFlights.has(file))return codeartsRefreshFlights.get(file);
 const pending=(async()=>resolveCodeArtsFresh(await readCodeArtsLocalSession({file}),file,options))();codeartsRefreshFlights.set(file,pending);
 try{return await pending}finally{codeartsRefreshFlights.delete(file);}
}

/** Public view: no AK/SK/securityToken, no account identity. */
export function codeartsCredentialView(credential, now = Date.now()) {
  return {
    present: true, authKind: 'iam_aksk_hmac', loginType: credential.loginType, stationType: credential.stationType,
    expiresAt: credential.expiresAt,
    expired: credential.expiresAt === null ? null : Date.parse(credential.expiresAt) <= now,
    hasAccessKey: true, hasSecretKey: true, hasSecurityToken: credential.securityToken.length > 0,
    hasStaticAccessToken: credential.hasStaticAccessToken, scopesEmpty: credential.scopesEmpty,
    signing: SIGNING_ALGORITHM, source: credential.source,
  };
}

/** Back-compat alias for the previous public-view name. */
export const codeartsSessionView = (session, now = Date.now()) => codeartsCredentialView(session, now);

// ------------------------------------------------------------------ transport

/**
 * Signed request against the fixed official origin. Only route-table entries are accepted,
 * so a caller cannot sign an arbitrary path or query.
 */
export async function codeartsRequest(credential, {method = 'GET', path, rawQuery = '', body, fetchImpl = fetch, signal, timeoutMs = 30000, now} = {}) {
  const route = ROUTES.get(`${method} ${path}${rawQuery ? `?${rawQuery}` : ''}`);
  if (!route) throw new AppError('CodeArts 适配器仅连接已确证的官方端点', 400, 'codearts_endpoint_invalid');
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {'Content-Type': 'application/json', 'X-Language': 'zh-cn'};
  if (route.agentType) headers['Agent-Type'] = route.agentType;
  const signed = signCodeArtsRequest(credential, {method, path, rawQuery, headers, payload, xSdkDate: sdkDate(now)});
  const activeSignal = signal ?? AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${CODEARTS_ORIGIN}${path}${rawQuery ? `?${rawQuery}` : ''}`, {
      method, redirect: 'error', signal: activeSignal, headers: signed,
      ...(body === undefined ? {} : {body: payload}),
    });
  } catch (error) {
    if (activeSignal.aborted || error?.name === 'AbortError') throw new AppError('CodeArts 请求已取消或超时', 499, 'request_cancelled');
    throw new AppError('CodeArts 官方接口连接失败', 503, 'codearts_network_error');
  }
  const text = await readBoundedText(response, activeSignal);
  if (!response.ok) {
    let upstreamCode = null;
    try { upstreamCode = JSON.parse(text)?.error_code ?? null; } catch { upstreamCode = null; }
    const auth = response.status === 401 || response.status === 403;
    throw Object.assign(new AppError(`CodeArts 官方接口请求失败 (HTTP ${response.status})`, response.status, auth ? 'codearts_auth_failed' : 'codearts_upstream_error'), {upstreamCode});
  }
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new AppError('CodeArts 官方接口响应 JSON 格式错误', 502, 'codearts_invalid_response'); }
  // Snap ops endpoints answer HTTP 200 with a business `code`; 0 is success.
  if (data && typeof data.code === 'number' && data.code !== 0) {
    const error = new AppError(`CodeArts 业务接口返回 ${data.code}`, 502, 'codearts_business_error');
    error.upstreamCode = data.code; error.upstreamMessage = String(data.message ?? '');
    throw error;
  }
  return data;
}

async function readBoundedText(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once: true});
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      if (signal?.aborted) throw new AppError('CodeArts 请求已取消或超时', 499, 'request_cancelled');
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) throw new AppError('CodeArts 响应超过大小上限', 502, 'codearts_response_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// ------------------------------------------------------------------ read surfaces

const optInt = value => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const firstNumber = (object, key) => (Number.isFinite(object?.[key]) ? object[key] : null);
const metricValue = (metrics, name) => (Array.isArray(metrics) ? metrics.find(row => row?.name === name) ?? null : null);
const parseRatio = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = typeof value === 'string' ? /^([0-9]+(?:\.[0-9]+)?)x?$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
};

/** `GET /snap-manager/v1/statistics/plugin` → real snap credit balance (unit: CREDIT). */
export async function codeartsCredits(credential, options = {}) {
  const data = await codeartsRequest(credential, {method: 'GET', path: '/snap-manager/v1/statistics/plugin', ...options});
  const metrics = Array.isArray(data?.metrics) ? data.metrics : null;
  if (!metrics) throw new AppError('CodeArts 积分账本格式错误', 502, 'codearts_balance_schema');
  const total = metricValue(metrics, 'usageTotalPackageCredit');
  const basic = metricValue(metrics, 'usageBasicPackageCredit');
  const bonus = metricValue(metrics, 'usageBonusPackageCredit');
  const onDemand = metricValue(metrics, 'usageOnDemandPackageCredit');
  const tokens = metricValue(metrics, 'usageTokenChatMessages');
  return {
    status: 'available', unit: 'CREDIT', ledger: 'snap-business-credits', source: CODEARTS_BALANCE_SOURCE.endpoint,
    remaining: firstNumber(total, 'package_credit_remain'),
    totalGranted: firstNumber(total, 'package_credit_amount'),
    used: firstNumber(total, 'package_credit_used'),
    expiring: firstNumber(total, 'package_credit_expiring_amount'),
    components: {
      basic: firstNumber(basic, 'package_credit_remain'), bonus: firstNumber(bonus, 'package_credit_remain'),
      onDemand: firstNumber(onDemand, 'package_credit_remain'), tokenPackRemaining: firstNumber(tokens, 'package_token_amount'),
    },
    package: data?.package ? {specCode: data.package.spec_code ?? null, name: data.package.package_name_cn ?? null, status: data.package.status ?? null, creditPackage: data.package.is_credit_package === true} : null,
    period: {start: data?.start_date ?? null, end: data?.end_date ?? null},
    observedAt: new Date().toISOString(),
  };
}

/** `GET /snap-manager/v1/current/user` → identity present without publishing the account id or name. */
export async function codeartsIdentity(credential, options = {}) {
  const data = await codeartsRequest(credential, {method: 'GET', path: '/snap-manager/v1/current/user', ...options});
  return {present: typeof data?.user_id === 'string' && data.user_id.length > 0, userType: typeof data?.user_type === 'string' ? data.user_type : null, appTypes: Array.isArray(data?.app_types) ? data.app_types.length : null};
}

/**
 * `GET /v1/model/builtin` (Agent-Type: PromptCenter) → official catalog.
 * Contract rule: capacity is unknown here (the upstream catalog has no context/token fields),
 * so unknown model capacities stay null; the tested GLM keeps explicit configured limits. `enabled` carries the
 * upstream fact separately instead of being folded into callability.
 */
export async function codeartsModels(credential, {limit = 500, ...options} = {}) {
  if (!credential?.accessKey) throw new AppError('CodeArts 凭据不可用', 401, 'codearts_credential_missing');
  const data = await codeartsRequest(credential, {method: 'GET', path: '/v1/model/builtin', ...options});
  const rows = data?.builtinModels;
  if (!Array.isArray(rows)) throw new AppError('CodeArts 模型目录格式错误', 502, 'codearts_catalog_schema');
  if (rows.length > limit) throw new AppError('CodeArts 模型目录超过条目上限', 502, 'codearts_catalog_too_large');
  const models = [];
  for (const row of rows) {
    const id = typeof row?.model_id === 'string' && row.model_id ? row.model_id : typeof row?.id === 'string' && row.id ? row.id : null;
    if (!id) continue;
    const enabled = row?.enable === true;
    const toolsVerified = CODEARTS_TOOLS_VERIFIED[id] !== undefined;
    const chatVerified = CODEARTS_CHAT_VERIFIED[id] !== undefined;
    models.push({
      id,
      name: typeof row?.model_name === 'string' && row.model_name ? row.model_name : id,
      // The upstream catalog carries NO context/output fields (verified: the raw row set has no
      // length keys); GLM uses conservative configured limits, other capacities remain null.
      contextWindow: id === 'GLM-5.2' ? 16384 : null, contextWindowSource: id === 'GLM-5.2' ? 'configured_limit' : 'not_published_by_catalog', officialContextWindow: null,
      maxTokens: id === 'GLM-5.2' ? 2048 : null, maxTokensSource: id === 'GLM-5.2' ? 'configured_limit' : 'not_published_by_catalog', officialMaxTokens: null,
      tools: toolsVerified,
      toolsSource: toolsVerified ? 'live_tool_calls_verified' : 'unproven',
      toolChoiceModes: ['auto','none'], auditToolChoice: 'auto', toolRoundtripVerified: id === 'GLM-5.2',
      multimodal: row?.supports_images === true,
      callable: enabled && chatVerified && id === 'GLM-5.2',
      callableReason: !enabled ? 'disabled_upstream' : id === 'GLM-5.2' ? null : 'context_window_unknown',
      enabled,
      displayEnabled: row?.display_enabled === true,
      category: typeof row?.model_category === 'string' ? row.model_category : null,
      creditRate: parseRatio(Array.isArray(row?.credit) && row.credit[0] ? row.credit[0].ratio_display : null),
      verification: 'official_catalog',
    });
  }
  return models;
}

/** `GET /v1/ops/delivery?channel=IDE` → the campaign list (read-only). */
export async function codeartsCampaigns(credential, options = {}) {
  const data = await codeartsRequest(credential, {method: 'GET', path: '/v1/ops/delivery', rawQuery: `channel=${OPS_CHANNEL}`, ...options});
  const items = data?.data?.items;
  return {items: Array.isArray(items) ? items : [], serverTime: firstNumber(data?.data, 'serverTime'), ended: Array.isArray(data?.data?.endedCampaigns) ? data.data.endedCampaigns.length : 0};
}

export const findDailyCampaign = items => (Array.isArray(items) ? items.find(item => item?.campaignId === DAILY_CAMPAIGN_ID) ?? null : null);

/** Contract `status`: real service state, never inferred from HTTP status alone. */
export async function codeartsStatus(credential, task = 'daily-checkin', options = {}) {
  if (task !== 'daily-checkin') throw new AppError('CodeArts 任务未登记', 400, 'codearts_task_unknown');
  const {items} = await codeartsCampaigns(credential, options);
  const campaign = findDailyCampaign(items);
  const status = typeof campaign?.status === 'string' ? campaign.status : null;
  const claimable = campaign?.claimable === true;
  const claimed = status === 'CONFIRMED' || status === 'CONSUMED';
  return {
    known: campaign !== null,
    task, campaignId: DAILY_CAMPAIGN_ID,
    title: typeof campaign?.title === 'string' ? campaign.title : null,
    status, claimable, claimed, pendingConfirmation:status==='CLAIMED', active:claimable||status==='CLAIMED', credits:firstNumber(campaign,'benefitAmount'), confirmed:status === "CONFIRMED" || status === "CONSUMED",
    pendingAmount: firstNumber(campaign, 'pendingTotalAmount'),
    credit: firstNumber(campaign, 'benefitAmount'),
    unit: typeof campaign?.benefitUnit === 'string' ? campaign.benefitUnit : null,
    endsAt: typeof campaign?.extra?.endTime === 'string' ? campaign.extra.endTime : null,
    day: dayIn(new Date(), 'Asia/Shanghai'),
    source: codeartsCheckinSource.endpoint,
  };
}

/** Contract `claim`: submit, then re-read delivery and require the server to have moved the state. */
export async function codeartsClaim(credential, task = 'daily-checkin', options = {}) {
  const before = await codeartsStatus(credential, task, options);
  if (options.confirmOnly === true && !before.claimed && !(before.known && before.pendingConfirmation))
    return {...before, submitted: false, reason: 'pending_confirmation_changed'};
  if (!before.known) return {...before, submitted: false, reason: 'campaign_absent'};
  if (before.claimed) return {...before, submitted: false, alreadyClaimed: true};
  if (!before.claimable && !before.pendingConfirmation) return {...before, submitted: false, reason: 'not_claimable'};
  const body = {campaignId: DAILY_CAMPAIGN_ID, idempotentKey: `claim_${DAILY_CAMPAIGN_ID}_${Date.now()}`, channel: OPS_CHANNEL};
  if(!before.pendingConfirmation)await codeartsRequest(credential, {method: 'POST', path: '/v1/ops/claim', body, ...options});
  // claim alone is not a receipt: the upstream has a CLAIMED (claimed-but-unconfirmed) state,
  // and only /v1/ops/confirm pushes it to CONFIRMED.
  let confirmed = false;
  try { await codeartsRequest(credential, {method: 'POST', path: '/v1/ops/confirm', body: {campaignId: DAILY_CAMPAIGN_ID}, ...options}); confirmed = true; }
  catch { confirmed = false; }
  const after = await codeartsStatus(credential, task, options);
  const settled = after.status === 'CONFIRMED' || after.status === 'CONSUMED';
  if (!settled) throw new AppError('CodeArts 领取结果尚未得到服务端确认', 502, 'codearts_claim_unconfirmed');
  return {...after, submitted: true, confirmed:confirmed && after.confirmed === true, rechecked: true};
}

/** Contract `health`: live identity + real credit balance + real campaign state (all read-only). */
export async function codeartsHealth(credential, options = {}) {
 if (!credential?.accessKey) throw new AppError('CodeArts 凭据不可用',401,'codearts_credential_missing');
 const identity=await codeartsIdentity(credential,options);
 const [cr,st,mo]=await Promise.allSettled([codeartsCredits(credential,options),codeartsStatus(credential,'daily-checkin',options),codeartsModels(credential,options)]);
 const credits=cr.status==='fulfilled'?cr.value:null;
 const checkin=st.status==='fulfilled'?st.value:{known:false,claimed:false,claimable:false,error:{code:st.reason?.code??'codearts_checkin_error',status:st.reason?.status??502}};
 const parts=credits?Object.entries(credits.components).filter(([k,v])=>k!=='tokenPackRemaining'&&typeof v==='number').map(([kind,value])=>({kind,label:kind,value,unit:'CREDIT'})):[];
 return {status:identity.present?'authenticated':'unknown',descriptor:codeartsDescriptor,credential:codeartsCredentialView(credential,options.now??Date.now()),identity,
 balance:{...(credits??{}),value:credits?.remaining??null,unit:'CREDIT',parts,note:credits?'官方 snap-business-credits 账本；Token 配额独立列示':'余额服务暂未返回，身份与签到单独核验',checkedIn:checkin.known?checkin.claimed:null},
 checkin,checkinSupported:true,capabilities:{checkin:true,inference:identity.present},modelCount:mo.status==='fulfilled'?mo.value.length:null};
}

/**
 * Preserve native tools and supported auto semantics. none removes tool definitions, while
 * forced modes fail explicitly rather than being silently downgraded or prompt-emulated.
 */
export function buildCodeArtsChatBody(input, model, chatId) {
  const body = {model, stream: true, messages: Array.isArray(input?.messages) ? input.messages : [],
    chat_id: chatId, prompt_cache_key: chatId, tool_stream: true};
  for (const key of CODEARTS_PASSTHROUGH) if (input?.[key] !== undefined) body[key] = input[key];
  const choice=input?.tool_choice;
  if(choice!==undefined && choice!==null && choice!=='auto' && choice!=='none')
    throw new AppError('CodeArts 已验证的 tool_choice 为 auto/none；强制工具选择尚未验证',400,'codearts_tool_choice_unsupported');
  if(choice==='none') delete body.tools;
  else if(choice==='auto') body.tool_choice='auto';
  if (Array.isArray(body.tools) && body.tools.length === 0) delete body.tools;
  body.max_tokens = desktopCompletionLimit(input, 2048);
  return body;
}

const codeartsToolSessions=new Map();
function chatSessionKey(credential,model,id){return `${credential.principal??credential.accessKey}:${model}:${id}`;}
export function codeartsChatId(input,credential,model) {
 const explicit=input.conversationId??input.sessionId??input.conversation_id??input.session_id??input.metadata?.conversation_id??input.metadata?.session_id;
 if(typeof explicit==='string'&&explicit.length>0&&explicit.length<=512)return sha256Hex(Buffer.from(chatSessionKey(credential,model,explicit))).slice(0,32);
 const now=Date.now();for(const [key,value] of codeartsToolSessions)if(value.until<now)codeartsToolSessions.delete(key);
 for(const message of [...(input.messages??[])].reverse())if(message.role==='tool'&&typeof message.tool_call_id==='string'){
  const remembered=codeartsToolSessions.get(chatSessionKey(credential,model,message.tool_call_id));if(remembered)return remembered.id;
 }
 // Identical initial greetings can be independent concurrent sessions; never merge them by content.
 return randomBytes(16).toString('hex');
}
async function trackCodeArtsTools(response,credential,model,chatId,stream) {
 const record=row=>{for(const choice of row?.choices??[])for(const t of (choice.delta??choice.message)?.tool_calls??[])if(typeof t.id==='string'&&t.id.length<=512){
  codeartsToolSessions.set(chatSessionKey(credential,model,t.id),{id:chatId,until:Date.now()+600000});
  while(codeartsToolSessions.size>512)codeartsToolSessions.delete(codeartsToolSessions.keys().next().value);
 }};
 if(!stream){record(await response.clone().json());return response;}
 const decoder=new TextDecoder();let pending='';
 return new Response(response.body.pipeThrough(new TransformStream({transform(chunk,controller){
  pending+=decoder.decode(chunk,{stream:true});let index;
  while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(line.startsWith('data:')){try{record(JSON.parse(line.slice(5)))}catch{}}}
  if(pending.length>1048576)throw new AppError('CodeArts 关联帧过大',502,'codearts_frame_too_large');controller.enqueue(chunk);
 }})),{status:response.status,headers:response.headers});
}

/** Contract `chat`: native OpenAI-shaped SSE passthrough against the snap engine. */
export async function codeartsChat(upstream, credential, input, signal, options = {}) {
  const model = typeof input?.model === 'string' && input.model ? input.model : null;
  if (!model) throw new AppError('CodeArts 聊天请求缺少 model', 400, 'codearts_chat_invalid');
  if (!credential?.accessKey) throw new AppError('CodeArts 凭据不可用', 401, 'codearts_credential_missing');
  const {fetchImpl = fetch, now, traceId} = options;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const chatId = codeartsChatId(input,credential,model);
  const body = buildCodeArtsChatBody(input, model, chatId);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Language': 'zh-cn',
    'x-auth-token': credential.securityToken,
    'x-snap-traceid': traceId ?? createHash('sha256').update(`${chatId}:${now ?? Date.now()}`).digest('hex').slice(0, 32),
    'app-id': 'CodeAgent3.0', is_confidential: 'false',
  };
  const signed = signCodeArtsRequest(credential, {method: 'POST', path: CODEARTS_CHAT_PATH, rawQuery: '', headers, payload, xSdkDate: sdkDate(now)});
  const response = await fetchImpl(`${CODEARTS_ORIGIN}${CODEARTS_CHAT_PATH}`, {method: 'POST', redirect: 'error', headers: signed, body: payload, signal:signal??AbortSignal.timeout(120000)});
  if (!response.ok) throw await codeartsChatFailure(response,signal);
  const normalized=await desktopSseResponse(response,{stream:input.stream===true,model,signal,prefix:"codearts",legacyText:true});
  return {response:await trackCodeArtsTools(normalized,credential,model,chatId,input.stream===true),chatId};
}

/**
 * Turn a non-2xx chat response into an error that CARRIES the upstream business code.
 * The previous version discarded the body, which is exactly why the tools 400 could not be
 * diagnosed from the gateway; `APIG.0301` and `TM.00001041` are now visible to the caller.
 */
async function codeartsChatFailure(response,signal) {
  let text = '';
  text = await readBoundedText(response,signal);
  let upstreamCode = null, upstreamMessage = '';
  try { const parsed = JSON.parse(text); upstreamCode = parsed?.error_code ?? parsed?.code ?? null; upstreamMessage = String(parsed?.error_msg ?? parsed?.message ?? ''); }
  catch { upstreamMessage = text.slice(0, 300); }
  const transient = response.status === 400 && upstreamCode === CODEARTS_TRANSIENT_CODES.CONCURRENCY.code;
  const auth = response.status === 401 || response.status === 403;
  const code = auth ? 'codearts_auth_failed' : transient ? 'codearts_chat_transient' : 'codearts_chat_rejected';
  const error = new AppError(`CodeArts 聊天接口 HTTP ${response.status}${upstreamCode ? ` (${upstreamCode})` : ''}`, transient ? 429 : response.status, code);
  error.upstreamStatus = response.status;
  error.upstreamCode = upstreamCode;
  error.upstreamMessage = redact(upstreamMessage).slice(0, 300);
  error.retryable = transient;
  return error;
}

/** Back-compat: the previous no-credential stubs now report the confirmed real surfaces. */
export const codeartsBalance = () => ({status: 'available', ...CODEARTS_BALANCE_SOURCE});
export const codeartsCheckin = () => ({status: 'available', checkinSupported: true, ...codeartsCheckinSource, source: codeartsDescriptor.checkinSource});

export const codeartsProvider = {
  resolve: resolveCodeArtsCredential, supportsCheckin:true, descriptor:codeartsDescriptor, models: codeartsModels, health: codeartsHealth,
  status: codeartsStatus, claim: codeartsClaim, chat: codeartsChat,
};

export function codeartsErrorView(error) { return {code: error?.code ?? 'codearts_error', message: redact(error?.message ?? String(error)).slice(0, 300), status: error?.status ?? 502}; }
