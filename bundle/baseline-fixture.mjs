// DSH lifecycle/provider assembly follows dingminhua/dsh-connect-trae (MIT).
import z from '@deepseek-ai/schemastery';
import {createProvider} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {resolveRetryPolicy} from '@deepseek-ai/dsh-llm';
import {PiAiAdapter} from '@deepseek-ai/dsh-llm-pi-ai';
import {join} from 'node:path';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {projectRoot} from '../src/config.mjs';
import {secret,rememberSecret,errorView} from '../src/util.mjs';
export const name='dsh-ai-credit-gateway';
export const inject=['llm'];
export const Config=z.object({configFile:z.string().default(process.env.AI_CREDIT_CONFIG??join(projectRoot,'config.local.json'))});
const providerId='ai-credit';
const inertAuth={credentials:{async read(){},async list(){return []},async modify(){throw new Error('The provider uses only the private loopback secret')},async delete(){}},authContext:{async env(){},async fileExists(){return false}}};
const unwrap=v=>v&&typeof v.get==='function'?v.get():v;
export function createGatewayAdapter({runtime,models,resolveAttachments}) {
  let current=models;
  const buildModels=()=>current.map(m=>({id:m.id,name:m.name,api:'openai-completions',provider:providerId,baseUrl:runtime.baseUrl+'/v1',input:m.capabilities.multimodal?['text','image']:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:!!m.reasoning,contextWindow:m.contextWindow,maxTokens:m.maxTokens,compat:{supportsReasoningEffort:!!m.reasoning},...(m.reasoning?{thinkingLevelMap:{off:null,minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:'max'}}:{})}));
  const base=createProvider({id:providerId,name:'AI 积分网关',auth:{apiKey:{name:'Private gateway shim',async resolve({credential}){return credential?.key?{auth:{apiKey:credential.key},source:'loopback'}:undefined}}},models:buildModels(),api:openAICompletionsApi()});
  const provider={...base,getModels:buildModels};
  const profile={provider:providerId,displayName:'AI 积分网关',streamIdleTimeoutMs:180000,retryPolicy:resolveRetryPolicy(undefined,'ai-credit retry policy'),configuredMaxTokens:new Map(),modelErrors:new Map(),defaultContextWindow:32768,maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,piProvider:provider};
  let profiles=new Map([[providerId,profile]]);
  const adapter=new PiAiAdapter({profiles:()=>profiles,auth:inertAuth,resolveApiKey:async()=>runtime.key,...(resolveAttachments?{resolveAttachments}:{})});
  return {adapter,update(models){current=models;profiles=new Map([[providerId,profile]])}};
}
export async function createBundleRuntime(configFile,{schedule=true}={}) {
  const service=await createService(configFile);const key=rememberSecret(secret());
  const runtime=await startServer(service,{host:'127.0.0.1',port:0,key,admin:false});
  if(schedule)service.scheduler.start();
  return {service,runtime,async close(){service.scheduler.stop();await runtime.close();await service.close()}};
}
export function apply(ctx,config) {
  let stopped=false,stack,adapterHandle,directoryHandle,discoveryHandle,timer;
  const settingsNs=ctx.fiber?.entry?.options?.id??name;
  ctx.inject(['settings'],child=>ctx.effect(()=>child.settings.configure({auto:true},ctx.fiber)));
  ctx.effect(()=>()=>{stopped=true;clearInterval(timer);discoveryHandle?.();directoryHandle?.();adapterHandle?.();void stack?.close();});
  void (async()=>{
    stack=await createBundleRuntime(unwrap(config.configFile));if(stopped){await stack.close();return;}
    const initial=(await stack.service.router.models()).data;
    const gateway=createGatewayAdapter({runtime:stack.runtime,models:initial,resolveAttachments:()=>ctx.get('attachments')});
    adapterHandle=ctx.llm.registerAdapter([providerId],gateway.adapter);
    directoryHandle=ctx.llm.registerConfigurableProviders([{provider:providerId,displayName:'AI 积分网关',settingsNs,settingsPath:[],declared:false}]);
    discoveryHandle=ctx.llm.registerModelDiscovery(settingsNs,async()=> (await stack.service.router.models()).data.map(m=>({id:m.id,name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,inputModalities:m.capabilities.multimodal?['text','image']:['text']})));
    timer=setInterval(()=>{void(async()=>{const previous=JSON.stringify(stack.service.config.value);await stack.service.config.load();if(previous!==JSON.stringify(stack.service.config.value)){stack.service.platforms.catalogs.clear();stack.service.credentials.cache.clear();}gateway.update((await stack.service.router.models()).data)})().catch(e=>ctx.logger.warn(errorView(e).message));},30000);timer.unref();
    ctx.logger.info('AI credit gateway provider ready; private loopback shim '+stack.runtime.baseUrl);
  })().catch(e=>ctx.logger.error('AI credit bundle initialization failed: '+errorView(e).message));
}
