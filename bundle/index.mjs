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
export const name='dsh-ai-credit-gateway';
export const inject=['llm'];
export const Config=z.object({configFile:z.string().default(process.env.AI_CREDIT_CONFIG??join(projectRoot,'config.local.json'))});
const providerId='ai-credit';
const inertAuth={credentials:{async read(){},async list(){return []},async modify(){throw new Error('The provider uses only the private loopback secret')},async delete(){}},authContext:{async env(){},async fileExists(){return false}}};
const unwrap=v=>v&&typeof v.get==='function'?v.get():v;
async function diagnostic(message){try{const dir=join(process.env.LOCALAPPDATA??homedir(),'AiCreditGateway');await mkdir(dir,{recursive:true});await appendFile(join(dir,'dsh-bundle.log'),new Date().toISOString()+' '+message+'\n')}catch{}}
export function createGatewayAdapter({runtime,models,resolveAttachments}) {
  let current=models,modelFingerprint=JSON.stringify(models);
  const buildModels=()=>current.map(m=>({id:m.id,name:m.name,api:'openai-completions',provider:providerId,baseUrl:runtime.baseUrl+'/v1',input:m.capabilities.multimodal?['text','image']:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:m.contextWindow,maxTokens:m.maxTokens,...thinkingMetadata(m)}));
  const base=createProvider({id:providerId,name:'AI 积分网关',auth:{apiKey:{name:'Private gateway shim',async resolve({credential}){return credential?.key?{auth:{apiKey:credential.key},source:'loopback'}:undefined}}},models:buildModels(),api:openAICompletionsApi()});
  const provider={...base,getModels:buildModels};
  const profile={provider:providerId,displayName:'AI 积分网关',streamIdleTimeoutMs:180000,retryPolicy:resolveRetryPolicy(undefined,'ai-credit retry policy'),configuredMaxTokens:new Map(),modelErrors:new Map(),defaultContextWindow:32768,maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,piProvider:provider};
  let profiles=new Map([[providerId,profile]]);
  const adapter=new PiAiAdapter({profiles:()=>profiles,auth:inertAuth,resolveApiKey:async()=>runtime.key,...(resolveAttachments?{resolveAttachments}:{})});
  return {adapter,update(models){const next=JSON.stringify(models);if(next===modelFingerprint)return false;current=models;modelFingerprint=next;profiles=new Map([[providerId,profile]]);return true}};
}
export async function createBundleRuntime(configFile,_options={}) {
  // ELECTRON_RUN_AS_NODE can hide process.versions.electron. Never fork execPath
  // unless its filename is a real node executable.
  const candidates=[process.env.AI_CREDIT_NODE,...(/^node(?:\.exe)?$/i.test(basename(process.execPath))?[process.execPath]:[]),join(homedir(),'Desktop/AI积分网关/桌面版/runtime/node.exe'),join(homedir(),'.ai-manager/runtimes/node/24.18.0/node.exe')].filter(Boolean);
  let node;for(const candidate of candidates){try{await access(candidate);node=candidate;break}catch{}}
  if(!node)throw new Error('Set AI_CREDIT_NODE to the standalone Node 24 executable');
  void diagnostic('WORKER_START runtime='+node);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.DSH_DESKTOP_NODE_EXECUTABLE;
  const child=spawn(node,[fileURLToPath(new URL('./worker.mjs',import.meta.url)),configFile],{env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',chunk=>{void diagnostic('WORKER_STDERR '+errorView(new Error(String(chunk))).message)});
  const ready=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(new Error('Gateway worker startup timed out'))},30000);const fail=()=>{clearTimeout(timeout);reject(new Error('Gateway worker exited before ready'))};child.once('exit',fail);child.once('error',reject);child.on('message',m=>{if(m?.type==='ready'){clearTimeout(timeout);child.off('exit',fail);resolve(m)}else if(m?.type==='error'){clearTimeout(timeout);reject(new Error(m.message))}})});
  rememberSecret(ready.key);
  const runtime={baseUrl:ready.baseUrl,key:ready.key};
  const service={router:{async models({signal}={}){const r=await fetch(runtime.baseUrl+'/v1/models',{headers:{Authorization:'Bearer '+runtime.key},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Gateway models HTTP '+r.status);return r.json()}},keys:{apiKey:'not-the-private-worker-key'}};
  let closing=false;
  void diagnostic('WORKER_READY pid='+child.pid);
  return {service,runtime,workerPid:child.pid,workerExecutable:node,async close(){if(closing)return;closing=true;if(child.exitCode!==null)return;await new Promise(resolve=>{const t=setTimeout(()=>{child.kill();resolve()},5000);child.once('exit',()=>{clearTimeout(t);resolve()});if(child.connected)child.send({type:'shutdown'});else child.kill()})}};
}
export function apply(ctx,config) {
  void diagnostic('BUNDLE_APPLY');
  let stopped=false,stack,adapterHandle,directoryHandle,discoveryHandle,timer,modelRefresh;
  const settingsNs=ctx.fiber?.entry?.options?.id??name;
  ctx.inject(['settings'],child=>ctx.effect(()=>child.settings.configure({auto:true},ctx.fiber)));
  ctx.effect(()=>()=>{stopped=true;clearInterval(timer);modelRefresh?.close();discoveryHandle?.();directoryHandle?.();adapterHandle?.();void stack?.close();});
  void (async()=>{
    stack=await createBundleRuntime(unwrap(config.configFile));if(stopped){await stack.close();return;}
    const initial=(await stack.service.router.models()).data;
    const gateway=createGatewayAdapter({runtime:stack.runtime,models:initial,resolveAttachments:()=>ctx.get('attachments')});
    adapterHandle=ctx.llm.registerAdapter([providerId],gateway.adapter);
    directoryHandle=ctx.llm.registerConfigurableProviders([{provider:providerId,displayName:'AI 积分网关',settingsNs,settingsPath:[],declared:false}]);
    discoveryHandle=ctx.llm.registerModelDiscovery(settingsNs,async()=> (await stack.service.router.models()).data.map(m=>({id:m.id,name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,inputModalities:m.capabilities.multimodal?['text','image']:['text']})));
    modelRefresh=createModelRefresh({initialModels:initial,
      load:async signal=>(await stack.service.router.models({signal})).data,
      update:models=>gateway.update(models),onError:e=>ctx.logger.warn(errorView(e).message)});
    timer=setInterval(()=>{void modelRefresh.refresh();},30000);timer.unref();
    ctx.logger.info('AI credit gateway provider ready; private loopback shim '+stack.runtime.baseUrl);
  })().catch(e=>{void diagnostic('BUNDLE_ERROR '+errorView(e).message);ctx.logger.error('AI credit bundle initialization failed: '+errorView(e).message)});
}
