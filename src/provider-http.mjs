import https from 'node:https';
import {Readable} from 'node:stream';
import {AppError} from './util.mjs';
const agents=new Map();
const hosts=new Set(['www.workbuddy.ai','www.codebuddy.ai','www.codebuddy.cn','copilot.tencent.com','openapi.qoder.sh','openapi.qoder.com.cn','api2.qoder.sh','api3.qoder.sh','gateway.qoder.com.cn']);
export function closeProviderConnections(){for(const a of agents.values())a.destroy();agents.clear()}
export function providerFetch(url,{method='GET',headers={},body,signal,proxyUrl}={}){
  const u=new URL(url);if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.port||u.username||u.password||u.hash)throw new AppError('平台官方端点校验失败',400,'provider_endpoint_invalid');
  if(proxyUrl&&!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(proxyUrl))throw new AppError('本机代理地址格式错误',400,'provider_proxy_invalid');
  const proxy=proxyUrl??'';if(!agents.has(proxy))agents.set(proxy,new https.Agent({proxyEnv:proxy?{HTTPS_PROXY:proxy}:{}}));
  const effectiveSignal=signal??AbortSignal.timeout(30000);return new Promise((resolve,reject)=>{const req=https.request(u,{method,headers:{...headers,...(body!=null?{'Content-Length':Buffer.byteLength(body)}:{})},agent:agents.get(proxy),signal:effectiveSignal},res=>{
    clearTimeout(timer);res.setTimeout(120000,()=>req.destroy(new Error('idle timeout')));try{const empty=[204,205,304].includes(res.statusCode);if(empty)res.resume();resolve(new Response(empty?null:Readable.toWeb(res),{status:res.statusCode,headers:res.headers}));}catch{res.destroy();reject(new AppError('平台响应协议异常',502,'provider_invalid_response'))}
  });const timer=setTimeout(()=>req.destroy(new Error('header timeout')),20000);timer.unref();req.on('error',()=>{clearTimeout(timer);const timedOut=effectiveSignal.reason?.name==='TimeoutError';reject(new AppError(timedOut?'平台官方连接超时':effectiveSignal.aborted?'平台请求已取消':'平台官方连接失败',timedOut?504:effectiveSignal.aborted?499:503,timedOut?'provider_timeout':effectiveSignal.aborted?'request_cancelled':'provider_network_error'))});req.end(body)});
}
export async function providerJson(url,c,{body,headers={},signal,fetchImpl=providerFetch,method=body===undefined?'GET':'POST'}={}){
  const r=await fetchImpl(url,{method,headers,signal,proxyUrl:c.proxyUrl,redirect:'error',...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  if(!r.ok){await r.body?.cancel();throw new AppError(`平台官方接口 HTTP ${r.status}`,r.status>=400?r.status:502,r.status===401||r.status===403?'provider_auth_rejected':'provider_http_error')}
  const reader=r.body?.getReader();if(!reader)throw new AppError('平台接口返回空响应',502,'provider_invalid_response');let size=0,chunks=[];
  try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>4*1024*1024)throw new AppError('平台JSON响应超过上限',502,'provider_response_too_large');chunks.push(v.value)}return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch(e){if(e instanceof AppError)throw e;throw new AppError('平台JSON响应格式错误',502,'provider_invalid_response')}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
