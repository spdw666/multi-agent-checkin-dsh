import {antigravityModels,antigravityChat} from './antigravity.mjs';
import {bigModelModels,bigModelHealth,bigModelChat} from './bigmodel.mjs';
import {zcodeModels,zcodeChat} from './zcode-models.mjs';
import {qwenWorkModels,qwenWorkChat} from './qwenwork-models.mjs';
import {miniMaxModels,miniMaxChat} from './minimax-models.mjs';
import {WorkBuddyUpstreamClient, prepareChatBody, declaredTools} from '../vendor/workbuddy-core.mjs';
import {TraeSoloUpstreamClient,TraeSoloBridge,TraeSoloRemoteCatalogClient,mergeTraeModelSources,TraeUsageClient,regionOfCredential} from '../vendor/trae-core.mjs';
import {AppError,jsonFetch} from './util.mjs';
import {qwenWorkContext} from './qwenwork.mjs';
import {zcodePreview,zcodeStatus,zcodeClaim} from './zcode.mjs';
import {miniMaxStatus,miniMaxClaim,miniMaxMembership} from './minimax.mjs';
export class Platforms {
  constructor(config,credentials){this.config=config;this.credentials=credentials;this.wb=new WorkBuddyUpstreamClient();this.catalogs=new Map();this.catalogFlights=new Map();this.trae=new Map();}
  account(id){return this.credentials.account(id);}
  async qwenContext(id,c) {
    try{return await qwenWorkContext(c)}catch(e){if(e.status!==401)throw e;const newer=await this.credentials.refreshQwen(id);return qwenWorkContext(newer);}
  }
  upstream(id){const u=this.config.value.upstreams.find(u=>u.id===id);if(!u||u.enabled===false)throw new AppError(`Upstream ${id} disabled`,503,'upstream_disabled');return u;}
  traeStack(id) {
    if(this.trae.has(id))return this.trae.get(id);
    const credential=()=>this.credentials.resolve(id);
    const solo=new TraeSoloUpstreamClient({credential,identity:async()=>(await credential()).identity});
    const remote=new TraeSoloRemoteCatalogClient({credential});
    const wire=new Map();const bridge=new TraeSoloBridge(solo,{current:()=>[...wire].map(([id,m])=>({id,wireConfigName:m.configName,wireFunction:m.function,reasoningEfforts:m.reasoningEfforts}))},name=>wire.get(name));
    const usage=new TraeUsageClient({credential,deviceId:async()=>(await credential()).identity.deviceId});
    const stack={solo,remote,wire,bridge,usage};this.trae.set(id,stack);return stack;
  }
  async models(upstreamId,{refresh=false,signal}={}) {
    if(signal?.aborted)throw new AppError('Request cancelled',499,'request_cancelled');
    if(!refresh&&this.catalogs.has(upstreamId))return this.catalogs.get(upstreamId);
    if(this.catalogFlights.has(upstreamId))return this.catalogFlights.get(upstreamId);
    // A directory fetch is shared across routes and UI refreshes, not tied to one caller.
    const flight=this.fetchModels(upstreamId,{refresh,signal:AbortSignal.timeout(45000)});
    this.catalogFlights.set(upstreamId,flight);
    try{return await flight;}finally{if(this.catalogFlights.get(upstreamId)===flight)this.catalogFlights.delete(upstreamId);}
  }
  async fetchModels(upstreamId,{refresh=false,signal}={}) {
    const u=this.upstream(upstreamId);const cached=this.catalogs.get(upstreamId);
    if(!refresh&&cached)return cached;
    let list;
    if(u.kind==='workbuddy'){list=(await this.wb.fetchModels(await this.credentials.resolve(u.accountId),signal)).map(m=>({...m,multimodal:m.supportsImages===true,tools:m.supportsToolCall===true}));}
    else if(u.kind==='trae') {
      const stack=this.traeStack(u.accountId);const wire=await stack.solo.fetchModels(signal??AbortSignal.timeout(60000));
      const remote=await stack.remote.fetchModels(signal).catch(()=>[]);
      list=mergeTraeModelSources(remote,wire).map(m=>({...m,tools:true,multimodal:m.multimodal===true,callable:!!(m.wireFunction||wire.some(w=>w.id===m.id)),...(!(m.wireFunction||wire.some(w=>w.id===m.id))?{unavailableReason:'当前 SOLO 调用目录未提供该模型；仅发现展示目录条目'}:{})}));
      for(const m of list){if(m.callable)stack.wire.set(m.id,{configName:m.wireConfigName??m.id,function:m.wireFunction??wire.find(w=>w.id===m.id)?.function,reasoningEfforts:m.reasoningEfforts});}
      // Retain direct wire mapping even if the remote directory is temporarily absent.
      for(const m of wire){if(m.id&&!stack.wire.has(m.id))stack.wire.set(m.id,{configName:m.id,function:m.wireFunction??m.function});}
    }else if(u.kind==='antigravity'){list=await antigravityModels(u,await this.credentials.resolve(u.accountId),{signal,config:this.config});}else if(u.kind==='bigmodel'){list=await bigModelModels(await this.credentials.resolve(u.accountId),{signal});}else if(u.kind==='qwenwork'){list=await qwenWorkModels(await this.credentials.resolve(u.accountId));}else if(u.kind==='zcode'){list=await zcodeModels(await this.credentials.resolve(u.accountId));}else if(u.kind==='minimax'){list=await miniMaxModels(await this.credentials.resolve(u.accountId));}else throw new AppError(`${u.kind}: model transport not yet live-verified`,501,'platform_protocol_pending');
    if(!Array.isArray(list)||!list.length)throw new AppError(`Upstream ${u.id} returned an empty catalog`,502,'empty_catalog');
    this.catalogs.set(upstreamId,list);return list;
  }
  async health(id) {
    const a=this.account(id);const credential=await this.credentials.resolve(id,{force:true});
    if(a.platform==='workbuddy'){const [checkin,credits]=await Promise.all([this.wb.fetchCheckinStatus(credential),this.wb.fetchCredits(credential)]);return {status:'authenticated',checkin,credits};}
    if(a.platform==='trae') {
      const usage=this.traeStack(id).usage;
      if(regionOfCredential(credential)!=='cn')return {status:'authenticated',subscription:await usage.payStatus(),checkin:{supported:false}};
      const [checkin,snapshot]=await Promise.all([usage.checkinStatus(),usage.snapshot()]);return {status:'authenticated',checkin,snapshot};
    }
    if(a.platform==='antigravity'){const u=this.config.value.upstreams.find(u=>u.kind==='antigravity'&&u.accountId===id&&u.enabled!==false);if(!u)throw new AppError('Antigravity bridge disabled',503,'upstream_disabled');const models=await antigravityModels(u,credential,{config:this.config});return {status:'bridge_ready',models:models.length,quotaKnown:false};}
    if(a.platform==='bigmodel')return bigModelHealth(credential);
    if(a.platform==='zcode')return {status:'authenticated',...await zcodePreview(credential)};
    if(a.platform==='qwenwork')return {status:'authenticated',...await this.qwenContext(id,credential)};
    if(a.platform==='minimax')return {status:'authenticated',checkin:await miniMaxStatus(credential),membership:await miniMaxMembership(credential)};
    throw new AppError('Credential read succeeded; platform health protocol awaits verification',501,'platform_protocol_pending');
  }
  async status(accountId,taskId) {
    const a=this.account(accountId);const credential=await this.credentials.resolve(accountId);
    if(a.platform==='workbuddy'&&taskId==='daily-checkin') {const s=await this.wb.fetchCheckinStatus(credential);return {known:true,active:s.active,claimed:s.todayCheckedIn,credits:s.todayCredit,details:s};}
    if(a.platform==='trae'&&taskId==='daily-checkin') {
      if(regionOfCredential(credential)!=='cn')return {known:true,active:false,reason:'international_subscription_no_checkin'};
      const s=await this.traeStack(accountId).usage.checkinStatus();return {known:true,active:s.enabled,claimed:s.checkedIn,deviceOccupied:s.didCheckedIn&&!s.checkedIn,credits:s.credits,deviceId:credential.identity.deviceId,details:s};
    }
    if(a.platform==='zcode'&&taskId==='activity-preview'){return {known:true,active:true,observed:true,details:await zcodePreview(credential),reason:'activity_preview_read_only'};}
    if(a.platform==='zcode'&&taskId==='free-plan-claim')return zcodeStatus(credential,{ledger:this.credentials.ledger,accountId});
    if(a.platform==='minimax'&&taskId==='daily-checkin')return miniMaxStatus(credential);
    // Automatic resets are observations, not a fabricated claim endpoint.
    if(a.platform==='qwenwork'&&taskId==='daily-quota') {const context=await this.qwenContext(accountId,credential);return {known:true,active:true,observed:true,details:context,reason:'automatic_daily_quota_read_only'};}
    if(taskId==='daily-quota')throw new AppError('Daily quota observation needs a verified personal-account endpoint',501,'quota_protocol_pending');
    const custom=(a.tasks??[]).find(t=>t.id===taskId);
    if(custom?.kind==='http'&&custom.enabled&&custom.statusUrl){
      const data=await jsonFetch(custom.statusUrl,{headers:{Authorization:`Bearer ${credential.accessToken}`},method:custom.statusMethod??'GET'});
      const claimed=data?.[custom.claimedField];if(typeof claimed!=='boolean')throw new AppError('Task status response has no boolean claimedField',502,'invalid_task_status');
      return {known:true,active:true,claimed};
    }
    throw new AppError(`${a.platform}/${taskId}: task adapter awaits verified protocol`,501,'task_protocol_pending');
  }
  async claim(accountId,taskId) {
    const a=this.account(accountId);const c=await this.credentials.resolve(accountId);
    if(a.platform==='workbuddy'&&taskId==='daily-checkin')return this.wb.claimDailyCheckin(c);
    if(a.platform==='minimax'&&taskId==='daily-checkin')return miniMaxClaim(c);
    if(a.platform==='zcode'&&taskId==='free-plan-claim')return zcodeClaim(c,{ledger:this.credentials.ledger,accountId,profileDir:this.config.path(`./data/accounts/${accountId}/captcha-browser`)});
    if(a.platform==='trae'&&taskId==='daily-checkin'){const r=await this.traeStack(accountId).usage.claimCheckin();if(!r.claimed){const retryable=Number(r.code)===9074;const error=new AppError(`Trae claim rejected: ${r.code} ${r.message??''}`.trim(),retryable?503:502,retryable?'claim_temporarily_busy':'claim_rejected');error.definitiveRejection=!retryable;error.beforeSubmission=retryable;error.retryable=retryable;throw error;}return r;}
    const custom=(a.tasks??[]).find(t=>t.id===taskId);
    if(custom?.enabled&&custom.kind==='http'&&custom.claimUrl)return jsonFetch(custom.claimUrl,{headers:{Authorization:`Bearer ${c.accessToken}`},body:custom.body??{}});
    throw new AppError('No verified claim adapter for this task',501,'task_protocol_pending');
  }
  async chat(target,request,signal) {
    const u=this.upstream(target.upstreamId);const input={...request,model:target.model,stream:true};
    if(u.kind==='workbuddy') {
      const body=prepareChatBody(JSON.stringify(input));const tools=declaredTools(body);
      let c=await this.credentials.resolve(u.accountId);let result=await this.wb.chatStream(c,body,signal);
      if(!result.ok&&result.status===401){const newer=await this.credentials.resolve(u.accountId,{force:true});if(newer.accessToken!==c.accessToken)result=await this.wb.chatStream(newer,body,signal);}
      if(!result.ok)throw new AppError(`WorkBuddy ${result.kind}: ${result.message}`,result.status||502,result.kind);
      return {response:result.response,recovery:tools?{declaredNames:tools.names,requiredParameters:tools.requiredParameters,pinnedToolName:tools.pinnedToolName}:undefined};
    }
    if(u.kind==='trae') {
      if(!this.catalogs.has(u.id))await this.models(u.id,{signal});
      const model=this.catalogs.get(u.id).find(m=>m.id===target.model);
      if(model?.callable===false)throw new AppError('Trae 当前 SOLO 通道未提供 '+target.model+'；该条目仅存在于展示目录，请选择标记为可调用的模型',400,'model_transport_unavailable');
      const efforts=model?.reasoningEfforts;
      if(input.reasoning_effort!=null&&efforts){const effort=efforts[input.reasoning_effort]??(Object.values(efforts).includes(input.reasoning_effort)?input.reasoning_effort:null);if(!effort)throw new AppError('Unsupported reasoning effort for this Trae model',400,'reasoning_effort_not_supported');input.reasoning_effort=effort;}
      const result=await this.traeStack(u.accountId).bridge.chatStream(JSON.stringify(input),signal);
      if(!result.ok)throw new AppError(`Trae ${result.kind}: ${result.message}`,result.status||502,result.kind);
      return {response:result.response};
    }
    if(u.kind==='antigravity')return antigravityChat(u,await this.credentials.resolve(u.accountId),input,signal,this.config);
    if(u.kind==='bigmodel')return bigModelChat(await this.credentials.resolve(u.accountId),input,signal);
    if(u.kind==='zcode')return zcodeChat(await this.credentials.resolve(u.accountId),input,signal,this.credentials.ledger);
    if(u.kind==='qwenwork')return qwenWorkChat(await this.credentials.resolve(u.accountId),input,signal);
    if(u.kind==='minimax'){const models=await this.models(u.id);return miniMaxChat(await this.credentials.resolve(u.accountId),input,models.find(m=>m.id===target.model),signal);}
    throw new AppError(`${u.kind}: chat protocol awaits verification`,501,'platform_protocol_pending');
  }
}
