import {AppError,hash,rememberSecret} from './util.mjs';
import https from 'node:https';
import {Readable} from 'node:stream';
import {nvidiaFreeCatalog,mergeNvidiaCatalog,nvidiaModelMetadata} from './nvidia-catalog.mjs';

export const NVIDIA_API_BASE='https://integrate.api.nvidia.com/v1';
const quotaCache=new Map(),authHistory=new Map(),proxyAgents=new Map(),cooldowns=new Map(),TTL=300000;
function key(c){
  const value=(typeof c?.accessToken==='string'?c.accessToken:typeof c?.apiKey==='string'?c.apiKey:'').trim();
  if(!value||/[\r\n]/.test(value))throw new AppError('请在本机 NVIDIA 凭据文件填写 API Key',401,'nvidia_key_missing');
  rememberSecret(value);return value;
}
const emptyQuota=()=>({mode:'rate_limited_free',dailyLimit:null,remaining:null,requestLimit:null,requestRemaining:null,
  tokenLimit:null,tokenRemaining:null,resetAt:null,retryAfterSeconds:null,observedAt:null,
  source:'official_policy',credentialStatus:'unverified',balanceApplicability:'not_applicable',
  policySource:'https://forums.developer.nvidia.com/t/unable-to-view-my-account-credit/328471',
  lastAuthenticatedAt:null,lastDirectoryAt:null,lastAuthErrorAt:null,last429At:null,cooldownUntil:null,observationStatus:'not_observed'});
export const emptyNvidiaQuota=emptyQuota;
export function nvidiaQuota(c,{now=Date.now()}={}){
  const id=hash(key(c)),entry=quotaCache.get(id),history=authHistory.get(id)??{},fresh=entry&&now-entry.time<=TTL;
  const quota=fresh?structuredClone(entry.quota):emptyQuota();
  if(!fresh&&entry){quota.source=entry.quota.source;quota.observedAt=entry.quota.observedAt;quota.observationStatus='expired';}
  Object.assign(quota,history);
  const until=cooldowns.get(id);quota.cooldownUntil=until?new Date(until).toISOString():null;
  return quota;
}
function numberHeader(headers,name){const s=headers.get(name);if(s===null||!/^\d+$/.test(s.trim()))return null;const n=Number(s);return Number.isSafeInteger(n)&&n>=0?n:null;}
function retrySeconds(value,now){
  if(value===null)return null;
  if(/^\d+(?:\.\d+)?$/.test(value.trim())){const n=Number(value);return Number.isFinite(n)&&n<=Number.MAX_SAFE_INTEGER?n:null;}
  const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,Math.ceil((date-now)/1000)):null;
}
function resetTime(value,now){
  if(!value)return null;
  let ms;
  if(/^\d+(?:\.\d+)?$/.test(value)){const n=Number(value);ms=n>=1e12?n:n>=1e9?n*1000:now+n*1000;}
  else if(/^(?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?$/.test(value)){
    const parts=[...value.matchAll(/(\d+(?:\.\d+)?)([hms])/g)];ms=now+parts.reduce((n,m)=>n+Number(m[1])*({h:3600000,m:60000,s:1000}[m[2]]),0);
  }else ms=Date.parse(value);
  return Number.isFinite(ms)&&Math.abs(ms)<=8.64e15?new Date(ms).toISOString():null;
}
function observe(c,response,isChat,now){
  const id=hash(key(c)),old=quotaCache.get(id),prior=nvidiaQuota(c,{now});
  const history={...(authHistory.get(id)??{credentialStatus:'unverified',lastAuthenticatedAt:null,lastDirectoryAt:null,lastAuthErrorAt:null,last429At:null})};
  const timestamp=new Date(now).toISOString();
  if(response.status===401||response.status===403){history.credentialStatus='rejected';history.lastAuthErrorAt=timestamp;}
  else if(response.ok&&isChat){history.credentialStatus='authenticated';history.lastAuthenticatedAt=timestamp;}
  else if(response.ok){history.lastDirectoryAt=timestamp;if(history.credentialStatus==='unverified')history.credentialStatus='catalog_verified';}
  if(response.status===429)history.last429At=timestamp;
  if(authHistory.size>=128&&!authHistory.has(id))authHistory.delete(authHistory.keys().next().value);authHistory.set(id,history);
  const h=response.headers;
  const observed={requestLimit:numberHeader(h,'x-ratelimit-limit-requests'),requestRemaining:numberHeader(h,'x-ratelimit-remaining-requests'),
    tokenLimit:numberHeader(h,'x-ratelimit-limit-tokens'),tokenRemaining:numberHeader(h,'x-ratelimit-remaining-tokens'),
    resetAt:resetTime(h.get('x-ratelimit-reset-requests')??h.get('x-ratelimit-reset-tokens'),now),retryAfterSeconds:retrySeconds(h.get('retry-after'),now)};
  const present=Object.values(observed).some(v=>v!==null);
  const quota=present?{...emptyQuota(),...observed,observedAt:new Date(now).toISOString(),source:'official_response_headers',observationStatus:'fresh'}:{...prior};
  Object.assign(quota,history);
  if(response.status===401||response.status===403){Object.assign(quota,emptyQuota(),history);}
  if(quotaCache.size>=128&&!quotaCache.has(id))quotaCache.delete(quotaCache.keys().next().value);
  quotaCache.set(id,{time:present||!old||now-old.time>TTL?now:old.time,quota});
}
function checkedProxy(proxyUrl){
  if(!proxyUrl)return '';
  let url;try{url=new URL(proxyUrl)}catch{throw new AppError('NVIDIA 本机代理地址格式错误',400,'nvidia_proxy_invalid');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new AppError('NVIDIA 代理仅支持 http://127.0.0.1:PORT',400,'nvidia_proxy_invalid');
  return url.href;
}
function agentFor(proxyUrl){
  const address=checkedProxy(proxyUrl);
  if(!proxyAgents.has(address)){
    if(proxyAgents.size>=8)throw new AppError('NVIDIA 本机代理数量超过上限',400,'nvidia_proxy_limit');
    // Node >=24.5 supports per-agent proxyEnv. Do not modify global proxy state.
    proxyAgents.set(address,new https.Agent({proxyEnv:address?{HTTPS_PROXY:address}:{}}));
  }
  return proxyAgents.get(address);
}
export async function closeNvidiaConnections(){for(const agent of proxyAgents.values())agent.destroy();proxyAgents.clear();}
export function nvidiaFetch(url,{method='GET',headers={},body,signal,nvidiaProxyUrl}={}){
  const target=new URL(url);
  if(target.origin!=='https://integrate.api.nvidia.com'||target.username||target.password||!['/v1/models','/v1/chat/completions'].includes(target.pathname)||target.search||target.hash)
    throw new AppError('NVIDIA 适配器仅连接官方固定端点',400,'nvidia_endpoint_invalid');
  const agent=agentFor(nvidiaProxyUrl);
  return new Promise((resolve,reject)=>{
    const request=https.request(target,{method,headers,signal,agent},response=>{
      clearTimeout(timer);response.setTimeout(180000,()=>response.destroy(new AppError('NVIDIA 响应流等待超时',504,'nvidia_timeout')));
      try{
        const noBody=[204,205,304].includes(response.statusCode);if(noBody)response.resume();
        resolve(new Response(noBody?null:Readable.toWeb(response),{status:response.statusCode,headers:response.headers}));
      }catch{response.destroy();reject(new AppError('NVIDIA 官方接口响应格式错误',502,'nvidia_invalid_response'));}
    });
    const timer=setTimeout(()=>request.destroy(new AppError('NVIDIA 响应首包等待超时',504,'nvidia_timeout')),body===undefined?30000:180000);timer.unref();
    request.once('error',e=>{clearTimeout(timer);reject(e)});request.end(body);
  });
}
function failure(status,retryAfterSeconds=null){
  const code=status===401||status===403?'nvidia_auth_failed':status===429?'nvidia_rate_limited':status===402?'nvidia_quota_or_payment_required':status>=300&&status<400?'nvidia_redirect_rejected':'nvidia_upstream_error';
  const message=status===429?'NVIDIA 官方接口限流；'+(retryAfterSeconds!==null?`请在 ${retryAfterSeconds} 秒后重试`:'按服务端 Retry-After 重试'):`NVIDIA 官方接口请求失败 (HTTP ${status})`;
  const e=new AppError(message,status>=400?status:502,code);if(status===429&&retryAfterSeconds!==null)e.retryAfterSeconds=retryAfterSeconds;return e;
}
function normalizeError(error,signal){
  if(error instanceof AppError)return error;
  if(signal?.aborted||error?.name==='AbortError')return new AppError('NVIDIA 请求已取消或超时',499,'request_cancelled');
  return new AppError('NVIDIA 官方接口连接失败',503,'nvidia_network_error');
}
async function request(c,path,{body,signal,fetchImpl=nvidiaFetch,now=Date.now()}={}){
  const token=key(c),activeSignal=signal??AbortSignal.timeout(body===undefined?30000:180000);
  if(activeSignal.aborted)throw normalizeError(null,activeSignal);
  const cooldown=cooldowns.get(hash(token));if(body&&cooldown>now)throw failure(429,Math.ceil((cooldown-now)/1000));
  let response;
  try{
    const nvidiaProxyUrl=checkedProxy(c.proxyUrl);
    response=await fetchImpl(NVIDIA_API_BASE+path,{method:body===undefined?'GET':'POST',redirect:'error',
      headers:{Authorization:`Bearer ${token}`,Accept:body?.stream?'text/event-stream':'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:activeSignal,...(nvidiaProxyUrl?{nvidiaProxyUrl}:{})});
  }catch(error){throw normalizeError(error,activeSignal);}
  observe(c,response,path==='/chat/completions',now);
  if(!response.ok){const retry=response.status===429?retrySeconds(response.headers.get('retry-after'),now):null;if(retry!==null){if(cooldowns.size>=128)cooldowns.delete(cooldowns.keys().next().value);cooldowns.set(hash(token),now+retry*1000);}await response.body?.cancel().catch(()=>{});throw failure(response.status,retry);}
  return {response,signal:activeSignal};
}
async function boundedJson(response,limit,signal){
  const reader=response.body?.getReader();if(!reader)throw new AppError('NVIDIA 官方接口返回空响应',502,'nvidia_invalid_response');
  let size=0;const chunks=[];
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  try{
    for(;;){if(signal?.aborted)throw normalizeError(null,signal);const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new AppError('NVIDIA JSON 响应超过大小上限',502,'nvidia_response_too_large');chunks.push(value);}
    if(signal?.aborted)throw normalizeError(null,signal);
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new AppError('NVIDIA 官方接口 JSON 格式错误',502,'nvidia_invalid_response');}return data;
  }catch(e){throw normalizeError(e,signal);}finally{signal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function nvidiaModels(c,options={}){
  const {response,signal}=await request(c,'/models',options),data=await boundedJson(response,4*1024*1024,signal);
  if(!Array.isArray(data?.data)||data.data.length>5000)throw new AppError('NVIDIA 模型目录格式错误',502,'nvidia_catalog_schema');
  const catalog=await nvidiaFreeCatalog({...options,proxyUrl:c.proxyUrl,offline:options.offlineCatalog??(Boolean(options.fetchImpl)&&!options.buildFetchImpl)});
  return mergeNvidiaCatalog(data.data,catalog);
}
export async function nvidiaHealth(c,options={}){
  const models=await nvidiaModels(c,options),quota=nvidiaQuota(c,options);
  return {status:quota.credentialStatus==='authenticated'?'authenticated':'catalog_reachable',models,quota};
}
export async function nvidiaChat(upstream,c,input,signal,options={}){
  const known=nvidiaModelMetadata(input?.model);
  if(!known?.freeEndpoint||!known.chat||!Number.isSafeInteger(known.contextWindow)||!Number.isSafeInteger(known.maxTokens))throw new AppError('NVIDIA 模型容量或聊天能力尚未核验',400,'nvidia_model_metadata_unknown');
  if(Array.isArray(input.tools)&&input.tools.length&&!known.tools)throw new AppError('NVIDIA 当前型号未声明工具调用支持',400,'nvidia_tools_not_supported');
  const body={};for(const field of ['model','messages','stream','tools','tool_choice','parallel_tool_calls','max_tokens','temperature','top_p','stop','seed','stream_options','response_format'])if(input[field]!==undefined)body[field]=input[field];
  if(input.max_completion_tokens!==undefined){
    if(body.max_tokens!==undefined&&body.max_tokens!==input.max_completion_tokens)throw new AppError('NVIDIA 两个输出上限字段相互冲突',400,'nvidia_max_tokens_conflict');
    body.max_tokens=input.max_completion_tokens;
  }
  if(body.max_tokens!==undefined&&(!Number.isSafeInteger(body.max_tokens)||body.max_tokens<1||body.max_tokens>known.maxTokens))throw new AppError('NVIDIA 最大输出参数超过该模型输出配置上限',400,'nvidia_max_tokens_invalid');
  if(input.reasoning_effort!==undefined&&input.reasoning_effort!==null){
    if(input.model==='moonshotai/kimi-k3'&&['low','high','max'].includes(input.reasoning_effort))body.reasoning_effort=input.reasoning_effort;
    else if(input.model==='nvidia/nemotron-3-super-120b-a12b'&&['none','low','high'].includes(input.reasoning_effort))body.chat_template_kwargs={enable_thinking:input.reasoning_effort!=='none',...(input.reasoning_effort==='low'?{low_effort:true}:{}),force_nonempty_content:true};
    else throw new AppError('NVIDIA 当前型号尚未声明此推理强度',400,'reasoning_effort_not_supported');
  }
  const fetched=await request(c,'/chat/completions',{...options,body,signal});
  if(body.stream)return {response:fetched.response,input:body};
  const data=await boundedJson(fetched.response,32*1024*1024,fetched.signal);
  if(!Array.isArray(data?.choices))throw new AppError('NVIDIA 聊天响应格式错误',502,'nvidia_invalid_response');
  return {response:Response.json(data,{status:fetched.response.status,headers:{'Content-Type':'application/json'}}),input:body};
}
