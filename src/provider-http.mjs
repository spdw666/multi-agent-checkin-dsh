import https from 'node:https';
import {Readable} from 'node:stream';
import {AppError} from './util.mjs';
const agents=new Map();
const hosts=new Set(['www.workbuddy.ai','www.codebuddy.ai','www.codebuddy.cn','copilot.tencent.com','openapi.qoder.sh','openapi.qoder.com.cn','api2.qoder.sh','api3.qoder.sh','gateway.qoder.com.cn']);
const transportCodes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ABORT_ERR']);
export function closeProviderConnections(){for(const a of agents.values())a.destroy();agents.clear()}
export function providerFetch(url,{method='GET',headers={},body,signal,proxyUrl,headersTimeoutMs=20000,requestTimeoutMs=30000}={}){
  const u=new URL(url);if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.port||u.username||u.password||u.hash)throw new AppError('平台官方端点校验失败',400,'provider_endpoint_invalid');
  if(proxyUrl&&!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(proxyUrl))throw new AppError('本机代理地址格式错误',400,'provider_proxy_invalid');
  if([headersTimeoutMs,requestTimeoutMs].some(ms=>!Number.isSafeInteger(ms)||ms<1||ms>1200000))throw new AppError('平台请求期限格式错误',400,'provider_timeout_invalid');
  const proxy=proxyUrl??'';if(!agents.has(proxy))agents.set(proxy,new https.Agent({proxyEnv:proxy?{HTTPS_PROXY:proxy}:{}}));
  // The connection budget is deliberately independent of model prefill. A
  // healthy TLS connection may need much longer to produce its first header.
  const effectiveSignal=signal??AbortSignal.timeout(requestTimeoutMs);
  return new Promise((resolve,reject)=>{
    let phase='connect',settled=false,finished=false,req,res,socket,timer,lastFailure=null;
    const socketConnect=()=>{phase=socket.encrypted?'tls_handshake':'response_header';if(!socket.encrypted)beginHeaders();};
    const socketSecure=()=>beginHeaders();
    const cleanup=()=>{clearTimeout(timer);effectiveSignal.removeEventListener('abort',abort);socket?.removeListener('connect',socketConnect);socket?.removeListener('secureConnect',socketSecure);res?.setTimeout(0);};
    const fail=(cause,timeoutOrigin)=>{
      if(finished)return null;finished=true;cleanup();
      const timedOut=!!timeoutOrigin||effectiveSignal.reason?.name==='TimeoutError';
      const error=new AppError(timedOut?'平台官方连接超时':effectiveSignal.aborted?'平台请求已取消':'平台官方连接失败',timedOut?504:effectiveSignal.aborted?499:503,timedOut?'provider_timeout':effectiveSignal.aborted?'request_cancelled':'provider_network_error');lastFailure=error;
      error.networkPhase=phase;
      error.transportCode=transportCodes.has(cause?.code)?cause.code:null;
      if(timedOut)error.timeoutOrigin=timeoutOrigin??'request_deadline';
      if(!settled){settled=true;reject(error);}
      // Destroying res also ends the Response body bridged in responseHandler.
      res?.destroy();req?.destroy();
      return error;
    };
    const abort=()=>fail({code:'ABORT_ERR'});
    const deadline=(ms,origin)=>{clearTimeout(timer);timer=setTimeout(()=>fail({code:'ETIMEDOUT'},origin),ms);timer.unref?.();};
    const beginHeaders=()=>{if(finished||settled||phase==='response_body')return;phase='response_header';deadline(headersTimeoutMs,'header_deadline');};
    if(effectiveSignal.aborted){abort();return}
    effectiveSignal.addEventListener('abort',abort,{once:true});
    try{req=https.request(u,{method,headers:{...headers,...(body!=null?{'Content-Length':Buffer.byteLength(body)}:{})},agent:agents.get(proxy),signal:effectiveSignal},response=>{
      if(finished||settled){response.destroy();return}res=response;phase='response_body';clearTimeout(timer);
      res.setTimeout(120000,()=>fail({code:'ETIMEDOUT'},'body_idle'));
      res.once('error',cause=>fail(cause));
      res.once('aborted',()=>fail({code:'ECONNRESET'}));
      res.once('end',()=>{finished=true;cleanup();});
      res.once('close',()=>{if(!finished)fail({code:'ECONNRESET'});});
      try{
        const empty=[204,205,304].includes(res.statusCode);
        // Bridge the socket with an explicit reader instead of piping through a
        // PassThrough. Piping let upstream bytes reach a web controller the consumer
        // had already closed; that threw ERR_INVALID_STATE from PassThrough.onData and
        // killed the whole gateway process. Pull-driven reading also lets a transport
        // failure surface as the same bounded AppError the header stage reports.
        const reader=empty?null:res[Symbol.asyncIterator]();
        const value=new Response(empty?null:new ReadableStream({
          async pull(controller){
            try{
              const step=await reader.next();
              if(step.done){controller.close();return}
              controller.enqueue(new Uint8Array(step.value));
            }catch(cause){
              // fail() already mapped this transport cause; reuse that view.
              const mapped=lastFailure??fail(cause)??cause;
              try{controller.error(mapped)}catch{}
            }
          },
          cancel(){if(!finished){finished=true;cleanup()}res.destroy();req.destroy();}
        }),{status:res.statusCode,headers:res.headers});
        settled=true;resolve(value);if(empty)res.resume();
      }catch{finished=true;cleanup();res.destroy();req.destroy();reject(new AppError('平台响应协议异常',502,'provider_invalid_response'));}
    })}catch(cause){fail(cause);return}
    deadline(20000,'connect_deadline');
    req.on('socket',activeSocket=>{
      if(finished){activeSocket.destroy();return}socket=activeSocket;
      if(req.reusedSocket){beginHeaders();return;}
      phase=socket.encrypted?'tls_handshake':'connect';
      socket.once('connect',socketConnect);
      socket.once('secureConnect',socketSecure);
    });
    req.on('error',cause=>fail(cause));req.end(body);
  });
}
export async function providerJson(url,c,{body,headers={},signal,fetchImpl=providerFetch,method=body===undefined?'GET':'POST'}={}){
  const r=await fetchImpl(url,{method,headers,signal,proxyUrl:c.proxyUrl,redirect:'error',...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  if(!r.ok){await r.body?.cancel();throw new AppError(`平台官方接口 HTTP ${r.status}`,r.status>=400?r.status:502,r.status===401||r.status===403?'provider_auth_rejected':'provider_http_error')}
  const reader=r.body?.getReader();if(!reader)throw new AppError('平台接口返回空响应',502,'provider_invalid_response');let size=0,chunks=[];
  try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>4*1024*1024)throw new AppError('平台JSON响应超过上限',502,'provider_response_too_large');chunks.push(v.value)}return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch(e){if(e instanceof AppError)throw e;throw new AppError('平台JSON响应格式错误',502,'provider_invalid_response')}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
