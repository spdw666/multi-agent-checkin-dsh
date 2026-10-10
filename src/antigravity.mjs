import http from 'node:http';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname} from 'node:path';
import {AppError,hash} from './util.mjs';

// This adapter talks only to an account-isolated local Antigravity bridge.
// It is not a configurable third-party API relay. OAuth stays in the bridge.
export function antigravityBase(upstream) {
  let url;
  try {url=new URL(upstream.sidecarBaseUrl??'http://127.0.0.1:19431/v1');}
  catch {throw new AppError('Invalid Antigravity local bridge URL',400,'invalid_antigravity_bridge');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||!['/v1','/v1/'].includes(url.pathname))
    throw new AppError('Antigravity bridge must use http://127.0.0.1:PORT/v1',400,'invalid_antigravity_bridge');
  return url.href.replace(/\/$/,'');
}

export function localBridgeFetch(url,{method='GET',headers={},body,signal}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method,headers,signal},res=>{
      clearTimeout(timer);
      res.setTimeout(180000,()=>res.destroy(new Error('Antigravity bridge stream idle timeout')));
      resolve(new Response(Readable.toWeb(res),{status:res.statusCode,headers:res.headers}));
    });
    const timer=setTimeout(()=>req.destroy(Object.assign(new Error('Antigravity bridge header timeout'),{code:'ETIMEDOUT'})),180000);timer.unref();
    req.once('error',e=>{clearTimeout(timer);reject(e);});req.end(body);
  });
}
const starts=new Map();
async function launch(upstream,config) {
  const settings=upstream.sidecar;
  if(!settings?.autoStart||!settings.executable||!settings.configFile||!/^[a-f0-9]{64}$/i.test(settings.sha256??''))return false;
  const executable=config.path(settings.executable),file=config.path(settings.configFile);
  if(!starts.has(executable))starts.set(executable,(async()=>{
    if(hash(await readFile(executable))!==settings.sha256.toLowerCase())throw new AppError('Antigravity bridge executable hash changed; verify the update first',503,'antigravity_bridge_hash_changed');
    await readFile(file); // Fail before spawn if the private bridge configuration is absent.
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,['-config',file,'--local-model'],{cwd:dirname(file),windowsHide:true,detached:true,stdio:'ignore'});
      child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
    });
    return true;
  })().finally(()=>{const timer=setTimeout(()=>starts.delete(executable),7000);timer.unref();}));
  return starts.get(executable);
}
function failure(status,data) {
  const message=String(data?.error?.message??data?.message??'');
  if(/location is not supported|unsupported.{0,20}(region|location)|(?:country|region).{0,20}not supported|not available in your country/i.test(message))
    return new AppError('Antigravity 上游拒绝当前出口地区；请切换美国节点后重新测试。',status,'antigravity_region_unsupported');
  if(status===401)return new AppError('Antigravity bridge authentication failed; recheck the account-specific local credential',401,'antigravity_auth_failed');
  if(status===429)return new AppError('Antigravity model quota or rate limit reached; retry after the upstream reset',429,'antigravity_rate_limited');
  // Do not reflect provider responses, account email, URLs or token material to clients.
  return new AppError(`Antigravity upstream request failed (HTTP ${status})`,status>=400?status:502,'antigravity_upstream_error');
}
async function boundedJson(response,limit) {
  const reader=response.body?.getReader();if(!reader)throw new AppError('Antigravity bridge returned an empty body',502,'invalid_upstream_response');
  let length=0;const chunks=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw new AppError('Antigravity bridge JSON exceeds size limit',502,'antigravity_response_too_large');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function antigravityRequest(upstream,credential,path,{body,signal,config,fetchImpl=localBridgeFetch}={}) {
  const url=antigravityBase(upstream)+path;
  const options={method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential.accessToken}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal};
  let response;
  try {response=await fetchImpl(url,options);}catch(e){
    if(options.signal?.aborted)throw new AppError('Antigravity request cancelled or timed out',499,'request_cancelled');
    if(e.code==='ETIMEDOUT')throw new AppError('Antigravity upstream response timed out; retry this model later',504,'antigravity_timeout');
    if(e.code==='ECONNREFUSED'&&config&&await launch(upstream,config)){
      for(let i=0;i<30;i++){
        if(signal?.aborted)throw new AppError('Antigravity request cancelled',499,'request_cancelled');
        await new Promise(resolve=>setTimeout(resolve,200));
        try {response=await fetchImpl(url,options);break;}catch(next){if(next.code!=='ECONNREFUSED')throw new AppError('Antigravity local bridge connection failed',503,'antigravity_bridge_unavailable');}
      }
    }
    if(!response)throw new AppError('Antigravity local bridge is not running; start the account bridge and retry',503,'antigravity_bridge_unavailable');
  }
  if(response.status>=300){let data;try{data=await boundedJson(response,65536);}catch{}throw failure(response.status,data);}
  return response;
}
export async function antigravityModels(upstream,credential,options={}) {
  const signal=options.signal??AbortSignal.timeout(30000);let data;
  // A freshly started bridge binds its port before its OAuth catalog is ready.
  // Retry only empty GET catalogs, never a submitted generation request.
  for(let attempt=0;attempt<=20;attempt++){
    const response=await antigravityRequest(upstream,credential,'/models',{...options,signal});
    try{data=await boundedJson(response,4*1024*1024);}catch(e){if(e.code==='antigravity_response_too_large')throw e;throw new AppError('Antigravity bridge returned invalid model data',502,'invalid_upstream_response');}
    if(!Array.isArray(data.data)||data.data.length>2000)throw new AppError('Antigravity bridge model list is invalid',502,'invalid_upstream_response');
    if(data.data.length||attempt===20)break;
    if(signal.aborted)throw new AppError('Antigravity catalog request cancelled',499,'request_cancelled');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  const seen=new Set();
  return data.data.filter(m=>typeof m?.id==='string'&&m.id.length>0&&m.id.length<=128&&!seen.has(m.id)&&seen.add(m.id)).map(m=>({
    id:m.id,name:m.name??m.id,tools:true,multimodal:false,
    ...(/(?:^|[-_])image(?:[-_]|$)/i.test(m.id)?{callable:false,unavailableReason:'当前专用适配器只发布聊天模型；图片生成接口尚未接入'}:{}),
    // A catalog entry is discovery, not a successful generation or an image-input test.
    source:'antigravity-local-bridge',verification:'unverified',
    ...(Number.isInteger(m.context_length)&&m.context_length>0?{contextWindow:m.context_length}:{}),
  }));
}
export async function antigravityChat(upstream,credential,input,signal,config) {
  const body={...input};if(body.reasoning_effort===null)delete body.reasoning_effort;
  return {response:await antigravityRequest(upstream,credential,'/chat/completions',{body,signal,config})};
}
