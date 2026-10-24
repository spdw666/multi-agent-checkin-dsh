// DSH lifecycle/provider assembly follows dingminhua/dsh-connect-trae (MIT).
import z from '@deepseek-ai/schemastery';
import {createProvider} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {resolveRetryPolicy} from '@deepseek-ai/dsh-llm';
import {PiAiAdapter} from '@deepseek-ai/dsh-llm-pi-ai';
import {join,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {access,appendFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {projectRoot} from '../src/config.mjs';
import {rememberSecret,errorView} from '../src/util.mjs';
import {thinkingMetadata} from '../src/reasoning.mjs';
import {createModelRefresh} from './model-refresh.mjs';
import {gatewayRequestPolicy,gatewayModelHeaders} from './request-policy.mjs';
import {wrapGatewayRetryMetadata,registerGatewayRetryRecovery} from './retry-metadata.mjs';
export const name='dsh-ai-credit-gateway';
export const inject=['llm'];
export const Config=z.object({configFile:z.string().default(process.env.AI_CREDIT_CONFIG??join(projectRoot,'config.local.json'))});
const providerId='ai-credit';
const inertAuth={credentials:{async read(){},async list(){return []},async modify(){throw new Error('The provider uses only the private loopback secret')},async delete(){}},authContext:{async env(){},async fileExists(){return false}}};
const unwrap=v=>v&&typeof v.get==='function'?v.get():v;
async function diagnostic(message){try{const dir=join(process.env.LOCALAPPDATA??homedir(),'AiCreditGateway');await mkdir(dir,{recursive:true});await appendFile(join(dir,'dsh-bundle.log'),new Date().toISOString()+' '+message+'\n')}catch{}}
export function createGatewayAdapter({runtime,models,resolveAttachments}) {
  let current=structuredClone(models),modelFingerprint=JSON.stringify(models);
  // A gateway request already owns the bounded complete same-model relay pool.
  // Five additional harness retries multiplied an exhausted pool's latency.
  const retryPolicy=()=>resolveRetryPolicy({mode:'normal',maxRetries:1},'ai-credit retry policy');
  const buildProfile=rows=>{
    const policy=gatewayRequestPolicy(runtime,rows);
    // Companion middleware's async ModelInfo lookup can race its first request.
    // Carry the SAME negotiated model-specific default on that request, without
    // rewriting its output budget or relying on an unrelated model registry.
    const defaultHeaders=m=>gatewayModelHeaders(m,policy);
    const buildModels=()=>rows.map(m=>({id:m.id,name:m.name,api:'openai-completions',provider:providerId,baseUrl:runtime.baseUrl+'/v1',headers:{'X-AI-Credit-Source':'dsh',...defaultHeaders(m)},input:m.capabilities.multimodal?['text','image']:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:m.contextWindow,maxTokens:m.maxTokens,...thinkingMetadata(m)}));
    const base=createProvider({id:providerId,name:'AI网关',auth:{apiKey:{name:'Private gateway shim',async resolve({credential}){return credential?.key?{auth:{apiKey:credential.key},source:'loopback'}:undefined}}},models:buildModels(),api:openAICompletionsApi()});
    const provider={...base,getModels:buildModels};
    const profile={provider:providerId,displayName:'AI网关',...policy,retryPolicy:retryPolicy(),modelErrors:new Map(),defaultContextWindow:32768,maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,piProvider:provider};
    return profile;
  };
  let profiles=new Map([[providerId,buildProfile(current)]]);
  const adapter=wrapGatewayRetryMetadata(new PiAiAdapter({profiles:()=>profiles,auth:inertAuth,resolveApiKey:async()=>runtime.key,...(resolveAttachments?{resolveAttachments}:{})}),{models:()=>current,ownedGateway:true});
  return {adapter,update(models){const next=JSON.stringify(models);if(next===modelFingerprint)return false;const detached=structuredClone(models),profile=buildProfile(detached);current=detached;modelFingerprint=next;profiles=new Map([[providerId,profile]]);return true}};
}
export async function createBundleRuntime(configFile,_options={}) {
  // ELECTRON_RUN_AS_NODE can hide process.versions.electron. Never fork execPath
  // unless its filename is a real node executable.
  const candidates=[process.env.AI_CREDIT_NODE,...(/^node(?:\.exe)?$/i.test(basename(process.execPath))?[process.execPath]:[]),join(homedir(),'Desktop/AI积分网关/桌面版/runtime/node.exe'),join(homedir(),'.ai-manager/runtimes/node/24.18.0/node.exe')].filter(Boolean);
  let node;for(const candidate of candidates){try{await access(candidate);node=candidate;break}catch{}}
  if(!node)throw new Error('Set AI_CREDIT_NODE to the standalone Node 24 executable');
  void diagnostic('WORKER_START runtime='+node);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.DSH_DESKTOP_NODE_EXECUTABLE;
  // The worker owns a private listener on an ephemeral port. A native crash in the
  // child used to leave runtime.baseUrl pointing at a dead port for the rest of the
  // session, which surfaced as an unexplained 502 from every later turn. Supervise
  // the child here and repoint the same runtime object, so the provider, model
  // discovery and request policy all follow the replacement without a rebuild.
  const runtime={baseUrl:'',key:''};
  let child,restarts=0,closing=false;
  const start=async()=>{
    const proc=spawn(node,[fileURLToPath(new URL('./worker.mjs',import.meta.url)),configFile],{env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
    child=proc;
    proc.stderr.on('data',chunk=>{void diagnostic('WORKER_STDERR '+errorView(new Error(String(chunk))).message)});
    const ready=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{proc.kill();reject(new Error('Gateway worker startup timed out'))},30000);const fail=()=>{clearTimeout(timeout);reject(new Error('Gateway worker exited before ready'))};proc.once('exit',fail);proc.once('error',reject);proc.on('message',m=>{if(m?.type==='ready'){clearTimeout(timeout);proc.off('exit',fail);resolve(m)}else if(m?.type==='error'){clearTimeout(timeout);reject(new Error(m.message))}})});
    rememberSecret(ready.key);
    runtime.baseUrl=ready.baseUrl;runtime.key=ready.key;
    const readyAt=Date.now();
    proc.once('exit',(code,signal)=>{if(closing||proc!==child)return;
      // A ready IPC message proves startup, not stable service. Keep failures
      // across rapid ready/crash loops and forgive them only after healthy uptime.
      if(Date.now()-readyAt>=60000)restarts=0;
      void diagnostic('WORKER_EXIT pid='+proc.pid+' code='+code+' signal='+signal);void restart()});
    void diagnostic('WORKER_READY pid='+proc.pid);
    return ready;
  };
  const restart=async()=>{
    if(closing)return;
    await new Promise(resolve=>setTimeout(resolve,Math.min(30000,500*2**restarts++)));
    if(closing)return;
    try{await start();void diagnostic('WORKER_RESTARTED pid='+child.pid)}catch(e){void diagnostic('WORKER_RESTART_FAILED '+errorView(e).message);void restart()}
  };
  await start();
  const service={router:{async models({signal}={}){const r=await fetch(runtime.baseUrl+'/v1/models',{headers:{Authorization:'Bearer '+runtime.key},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Gateway models HTTP '+r.status);return r.json()}},keys:{apiKey:'not-the-private-worker-key'}};
  return {service,runtime,get workerPid(){return child?.pid},workerExecutable:node,async close(){if(closing)return;closing=true;const proc=child;if(!proc||proc.exitCode!==null)return;await new Promise(resolve=>{const t=setTimeout(()=>{proc.kill();resolve()},5000);proc.once('exit',()=>{clearTimeout(t);resolve()});if(proc.connected)proc.send({type:'shutdown'});else proc.kill()})}};
}
export function apply(ctx,config) {
  void diagnostic('BUNDLE_APPLY');
  registerGatewayRetryRecovery(ctx);
  let stopped=false,stack,adapterHandle,directoryHandle,discoveryHandle,timer,modelRefresh;
  const settingsNs=ctx.fiber?.entry?.options?.id??name;
  ctx.inject(['settings'],child=>ctx.effect(()=>child.settings.configure({auto:true},ctx.fiber)));
  ctx.effect(()=>()=>{stopped=true;clearInterval(timer);modelRefresh?.close();discoveryHandle?.();directoryHandle?.();adapterHandle?.();void stack?.close();});
  void (async()=>{
    stack=await createBundleRuntime(unwrap(config.configFile));if(stopped){await stack.close();return;}
    const initial=(await stack.service.router.models()).data;
    const gateway=createGatewayAdapter({runtime:stack.runtime,models:initial,resolveAttachments:()=>ctx.get('attachments')});
    adapterHandle=ctx.llm.registerAdapter([providerId],gateway.adapter);
    directoryHandle=ctx.llm.registerConfigurableProviders([{provider:providerId,displayName:'AI网关',settingsNs,settingsPath:[],declared:false}]);
    discoveryHandle=ctx.llm.registerModelDiscovery(settingsNs,async()=> (await stack.service.router.models()).data.map(m=>({id:m.id,name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,inputModalities:m.capabilities.multimodal?['text','image']:['text']})));
    modelRefresh=createModelRefresh({initialModels:initial,
      load:async signal=>(await stack.service.router.models({signal})).data,
      update:models=>gateway.update(models),onError:e=>ctx.logger.warn(errorView(e).message)});
    timer=setInterval(()=>{void modelRefresh.refresh();},30000);timer.unref();
    ctx.logger.info('AI credit gateway provider ready; private loopback shim '+stack.runtime.baseUrl);
  })().catch(e=>{void diagnostic('BUNDLE_ERROR '+errorView(e).message);ctx.logger.error('AI credit bundle initialization failed: '+errorView(e).message)});
}
