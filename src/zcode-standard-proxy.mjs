import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {AppError} from './util.mjs';
import {sseEvents} from './openai.mjs';
const starting=new Map();
export async function ensureZcodeProxy(runtime,{fetchImpl=fetch,spawnImpl=spawn,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!runtime.launch)return;
 if(starting.has(runtime.baseUrl))return starting.get(runtime.baseUrl);
 const task=(async()=>{
  const health=new URL('/health',runtime.baseUrl);
  const ready=async()=>{try{const r=await fetchImpl(health,{headers:{authorization:'Bearer '+runtime.localKey},signal:AbortSignal.timeout(1000),redirect:'error'});return r.ok&&(await r.json()).ready===true;}catch{return false;}};
  if(await ready())return;
  const {command,script}=runtime.launch;
  if(!isAbsolute(command??'')||!isAbsolute(script??''))throw new AppError('ZCode proxy launch paths must be absolute',503,'zcode_proxy_config');
  let error;const child=spawnImpl(command,[script],{detached:true,windowsHide:true,stdio:'ignore'});child.once('error',e=>{error=e;});child.unref();
  // One loopback owner wins the bind even if separate gateway processes start together.
  for(let i=0;i<40;i++){if(await ready())return;if(error)break;await sleep(250);}
  throw new AppError('ZCode local proxy did not become ready',503,'zcode_proxy_start_failed');
 })();
 starting.set(runtime.baseUrl,task);try{await task;}finally{starting.delete(runtime.baseUrl);}
}
export async function zcodeStandardProxy(c,request,signal,{fetchImpl=fetch,readRuntime=()=>readFile(new URL('./zcode-standard-proxy.runtime.json',import.meta.url),'utf8')}={}){
 let runtime;try{runtime=JSON.parse(await readRuntime());}catch(error){if(error.code==='ENOENT')return null;throw new AppError('ZCode standard proxy runtime configuration invalid',503,'zcode_proxy_config');}
 if(runtime.enabled!==true)return null;
 const url=new URL(runtime.baseUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/v1/chat/completions'||typeof runtime.localKey!=='string'||runtime.localKey.length<32)throw new AppError('ZCode standard proxy endpoint must be the configured loopback route',503,'zcode_proxy_config');
 if(!c.accessToken||!c.identity?.deviceId)throw new AppError('ZCode standard proxy requires the existing native account session',401,'zcode_proxy_auth');
 await ensureZcodeProxy(runtime,{fetchImpl});signal?.throwIfAborted();
 const response=await fetchImpl(url.href,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+runtime.localKey,'x-gateway-upstream-token':c.accessToken,'x-gateway-device-id':c.identity.deviceId},body:JSON.stringify(request),signal,redirect:'error'});
 return {response,upstreamStatus:Number(response.headers.get('x-gateway-upstream-status'))||response.status,upstreamCode:Number(response.headers.get('x-gateway-upstream-code'))||null};
}
export function zcodeStandardStream(response,onBusinessError){
 const events=sseEvents(response.body)[Symbol.asyncIterator](),encoder=new TextEncoder();
 return new Response(new ReadableStream({async pull(c){try{const n=await events.next();if(n.done){c.close();return;}if(n.value.data!=='[DONE]'){const d=JSON.parse(n.value.data),code=Number(d.upstreamCode??d.error?.upstreamCode??d.error?.code??d.code);if(Number.isSafeInteger(code)&&![0,200].includes(code))throw onBusinessError(code,Number(d.upstreamStatus??d.error?.upstreamStatus)||response.status);if(d.error)throw new AppError('ZCode standard proxy returned a streaming error',502,'zcode_proxy_stream_error');}c.enqueue(encoder.encode((n.value.event?'event: '+n.value.event+'\n':'')+'data: '+n.value.data+'\n\n'));}catch(error){c.error(error);}},async cancel(reason){await events.return?.(reason);}}),{status:response.status,headers:{'content-type':'text/event-stream'}});
}
