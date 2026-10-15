import {nvidiaRequestTimeout} from './nvidia.mjs';
import {AppError} from './util.mjs';
import {normalizeChat,validateChat,isContextWindowError} from './openai.mjs';
import {WorkBuddyPool} from './workbuddy-pool.mjs';
import {UsageAttempt} from './usage.mjs';
import {randomUUID} from 'node:crypto';
import {ModelRelay} from './model-relay.mjs';
import {adaptRelayReasoning} from './relay-reasoning.mjs';
import {gatewayRequestTimeout} from './request-timeouts.mjs';
const interrupted=signal=>new AppError(signal?.reason?.name==='TimeoutError'?'Gateway request deadline exceeded':'Request cancelled',signal?.reason?.name==='TimeoutError'?504:499,signal?.reason?.name==='TimeoutError'?'request_timeout':'request_cancelled');
export class Router {
  constructor(config,platforms,{ledger,relayAttemptTimeoutMs=30000,catalogTimeoutMs=20000}={}){if(!Number.isSafeInteger(relayAttemptTimeoutMs)||relayAttemptTimeoutMs<1||relayAttemptTimeoutMs>600000||!Number.isSafeInteger(catalogTimeoutMs)||catalogTimeoutMs<1||catalogTimeoutMs>60000)throw new TypeError('Relay and catalog deadlines must be positive bounded integers');Object.assign(this,{config,platforms,ledger,relayAttemptTimeoutMs,catalogTimeoutMs});this.catalogFlights=new Map();this.pool=new WorkBuddyPool(config,ledger);this.relay=new ModelRelay(config,platforms,ledger);this.relay.pool=this.pool;this.relay.catalogRead=(id,options)=>this.catalog(id,options);}
  async catalog(id,{signal}={}){
    if(signal?.aborted)throw interrupted(signal);
    const u=this.config.value.upstreams?.find(u=>u.id===id),a=this.config.value.accounts?.find(a=>a.id===u?.accountId),key=id+'\0'+JSON.stringify(u)+'\0'+JSON.stringify(a?.credentials);
    let operation=this.catalogFlights.get(key);
    if(!operation){let timer;const controller=new AbortController(),error=new AppError('Model catalogue lookup timed out',504,'model_catalog_timeout');
      operation=Promise.race([Promise.resolve().then(()=>this.platforms.models(id,{signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(error);controller.abort(error)},this.catalogTimeoutMs)})]).finally(()=>{clearTimeout(timer);if(this.catalogFlights.get(key)===operation)this.catalogFlights.delete(key)});
      this.catalogFlights.set(key,operation);
    }
    let abort;try{return await(signal?Promise.race([operation,new Promise((_,reject)=>{abort=()=>reject(interrupted(signal));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})]):operation)}finally{if(abort)signal.removeEventListener('abort',abort)}
  }
  async routeInfo(route) {
    const relay=this.relay.active(route),discovered=await this.relay.discover(route,this.pool.candidates(route,{ignoreCooldown:true}),undefined,{ignoreCooldown:true}),targets=discovered.targets.filter(t=>this.config.value.upstreams.some(u=>u.id===t.upstreamId&&u.enabled!==false));
    if(!targets.length)return undefined;
    const metadata=await Promise.all(targets.map(async t=>{const catalog=discovered.catalogs.get(t.upstreamId)??await this.catalog(t.upstreamId).catch(()=>[]);return catalog.find(m=>m.id===t.model)}));
    const selected=route.accountPool?.enabled||relay?metadata.findIndex(m=>m&&m.callable!==false):0;
    if(selected<0||!metadata[selected])return undefined; // A configured id is not proof of a live model.
    const primary=metadata[selected];
    if(primary.callable===false)return undefined;
    const kind=this.config.value.upstreams.find(u=>u.id===targets[selected].upstreamId)?.kind;
    // The public route retains its primary's live capacity. An unrelated small
    // or unknown standby must not make pi-ai reject an otherwise successful
    // million-token provider at 32K. Chat enforces the same standby contract.
    const contextWindow=primary.contextWindow??32768;
    const compatible=relay?metadata.filter(m=>m&&m.callable!==false&&(!primary.tools||m.tools===true)&&(!primary.multimodal||m.multimodal===true)&&(!Number.isSafeInteger(primary.contextWindow)||Number.isSafeInteger(m.contextWindow)&&m.contextWindow>=primary.contextWindow)):[primary];
    const maxTokens=primary.maxTokens??4096;
    if(kind==='nvidia'&&(primary.importable===false||!Number.isInteger(primary.contextWindow)||primary.contextWindow<1||!Number.isInteger(primary.maxTokens)||primary.maxTokens<1))return undefined;
    const efforts=primary.reasoningEfforts??(Array.isArray(primary.reasoning?.supportedEfforts)?Object.fromEntries(primary.reasoning.supportedEfforts.map(k=>[k,k])):null);
    return {id:route.id,object:'model',created:0,owned_by:'ai-credit-gateway',name:route.name??primary.name??route.id,upstream:targets[selected].upstreamId,...(kind==='nvidia'?{requestTimeoutMs:nvidiaRequestTimeout(primary.id)}:{}),capabilities:{streaming:true,tools:primary.tools===true,multimodal:primary.multimodal===true},contextWindow,maxTokens,...(relay?{modelRelay:{strictSameModel:true,partition:this.relay.partition(route),modelFamily:discovered.family,targetCount:compatible.length,deliveryMode:'verified_request_buffer',attemptTimeoutMs:this.relayAttemptTimeoutMs,attemptTimeoutMode:'progress_idle',requestTimeoutMs:gatewayRequestTimeout(this.config.value.server,route.id)}}:{}),reasoning:primary.reasoning??null,reasoningEfforts:efforts??null,...(primary.reasoningEffortMapping?{reasoningEffortMapping:primary.reasoningEffortMapping,reasoningMappingSource:primary.reasoningMappingSource}:{})};
  }
  async models(){const rows=await Promise.all(this.config.value.routes.filter(r=>r.enabled!==false).map(r=>this.routeInfo(r)));return {object:'list',data:rows.filter(Boolean)};}
  async * chat(raw,signal,{onTarget,source='api'}={}) {
    const request=validateChat(raw);const route=this.config.value.routes.find(r=>r.id===request.model&&r.enabled!==false);
    if(!route)throw new AppError(`Unknown route: ${request.model}`,404,'model_not_found');
    let last,lastSupplierFailure;const requestId=randomUUID(),requestStarted=Date.now(),requestBudget=gatewayRequestTimeout(this.config.value.server,route.id);
    const relayActive=this.relay.active(route,source),prepared=await this.relay.prepare(route,this.pool.candidates(route),signal,{source}),targets=prepared.targets,selectionVersion=this.pool.version(route);let previousTarget,relayTrigger;
    if(!targets.length){const retry=prepared.retryAfterSeconds,emptyCredits=relayActive&&!retry&&prepared.exhaustedTargetCount>0,error=new AppError(relayActive?(retry?`同型号供应处于额度或限流冷却；${retry}秒后可重试；模型与上下文保持不变`:emptyCredits?'已确认的同型号供应剩余额度为零；模型与上下文保持不变':'同型号当前没有已启用供应；模型与上下文保持不变'):'All WorkBuddy pool accounts are disabled or credits are cooling down',emptyCredits?402:503,relayActive?(retry?'same_model_cooldown':emptyCredits?'same_model_credits_exhausted':'same_model_unavailable'):'account_pool_unavailable');if(retry)error.retryAfterSeconds=retry;throw error;}
    let sourceModel;
    if(relayActive){try{const catalog=prepared.catalogs.get(route.targets[0].upstreamId)??await this.catalog(route.targets[0].upstreamId,{signal});sourceModel=catalog.find(m=>m.id===route.targets[0].model);}catch(e){if(signal?.aborted)throw new AppError('Request cancelled',499,'request_cancelled');}}
    for(let i=0;i<targets.length;i++) {
      const target=targets[i];let started=false,completed=false,failure,response;
      if(signal?.aborted)throw interrupted(signal);
      const remaining=Math.max(1,requestBudget-(Date.now()-requestStarted)-1000),attemptBudget=Math.max(1,Math.min(this.relayAttemptTimeoutMs,Math.floor(remaining/Math.min(2,targets.length-i))));
      const targetController=relayActive?new AbortController():null,targetSignal=relayActive?(signal?AbortSignal.any([signal,targetController.signal]):targetController.signal):signal;
      const timeoutError=new AppError('Same-model supplier made no progress within its relay idle budget',504,'relay_target_timeout');let targetTimer,targetExpired=false,rejectTarget;
      const targetDeadline=relayActive?new Promise((_,reject)=>{rejectTarget=reject;}):null;
      const progress=()=>{if(!relayActive||targetExpired)return;clearTimeout(targetTimer);const remainingWhole=Math.max(1,requestBudget-(Date.now()-requestStarted)-1000);targetTimer=setTimeout(()=>{targetExpired=true;rejectTarget(timeoutError);targetController.abort(timeoutError);},Math.min(attemptBudget,remainingWhole));};
      progress();
      const waitTarget=p=>targetDeadline?Promise.race([p,targetDeadline]):p;
      const usage=new UsageAttempt(this.ledger,this.config.value,request,target,{requestId,attempt:i+1,source});
      if(relayActive){usage.row.deliveryMode='verified_request_buffer';usage.row.relay={trigger:relayTrigger??prepared.reasons.get(route.targets[0].upstreamId+'\0'+route.targets[0].model)??'preferred_same_model',fromPlatform:this.config.value.upstreams.find(u=>u.id===(previousTarget??route.targets[0]).upstreamId)?.kind??'',toPlatform:this.config.value.upstreams.find(u=>u.id===target.upstreamId)?.kind??''};}
      try {
        const catalog=await waitTarget(this.catalog(target.upstreamId,{signal:targetSignal}));const model=catalog.find(m=>m.id===target.model);
        if(!model||model.callable===false)throw new AppError(`Model absent from live catalog: ${target.model}`,404,'model_not_found');
        if(relayActive&&sourceModel&&Number.isSafeInteger(sourceModel.contextWindow)&&sourceModel.contextWindow>0&&(!Number.isSafeInteger(model.contextWindow)||model.contextWindow<sourceModel.contextWindow))throw new AppError('Same-model standby cannot preserve this route context capacity; history was not trimmed',400,'relay_context_incompatible');
        if(request.tools?.length&&request.tool_choice!=='none'&&model.tools!==true)throw new AppError('Target does not declare tools support',400,'tools_not_supported');
        const images=request.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
        if(images&&model.multimodal!==true)throw new AppError('Target does not declare image-input support',400,'images_not_supported');
        const outputBudget=Math.max(...[request.max_tokens,request.max_completion_tokens].filter(Number.isFinite),0);
        // A configured default is a suggestion, not an official output limit.
        // In particular Qoder gmodel publishes input capacity but no output cap.
        const outputCapacity=model.maxTokensSource==='configured_default'?model.officialMaxTokens:model.maxTokens;
        if(relayActive&&Number.isFinite(outputCapacity)&&outputCapacity>0&&outputBudget>outputCapacity)throw new AppError('Same-model provider output capacity is below this request; history and output budget were not trimmed',400,'relay_capacity_incompatible');
        const kind=this.config.value.upstreams?.find(u=>u.id===target.upstreamId)?.kind;
        const adapted=adaptRelayReasoning(request,model,{kind,sourceModel,relayed:relayActive});
        if(relayActive)usage.row.reasoningPolicy=adapted.metadata;
        const result=await waitTarget(this.platforms.chat(target,adapted.request,targetSignal));response=result.response;
        const nativeAttempts=Number(response.headers?.get('x-ai-credit-trae-attempts'));if(Number.isInteger(nativeAttempts)&&nativeAttempts>0&&nativeAttempts<=2)usage.row.nativeAttempts=nativeAttempts;const nativeRetry=response.headers?.get('x-ai-credit-trae-retry-reason');if(nativeRetry==='reasoning_only_stop')usage.row.nativeRetryReason=nativeRetry;
        // During automatic handoff, no answer or proposed tool call is exposed
        // until this attempt is complete. Failed partial streams can then be
        // replayed on the same model without duplicated text or executed tools.
        if(relayActive){let bytes=0,content=false,tools=false;const pending=[];await waitTarget((async()=>{try{for await(const chunk of normalizeChat(result.response,{model:route.id,recovery:result.recovery})){if(targetSignal?.aborted)throw targetExpired?timeoutError:interrupted(signal);usage.chunk(chunk);if(chunk.choices?.some(c=>c.delta?.content||c.delta?.reasoning_content||c.delta?.reasoning||c.delta?.tool_calls?.length))progress();bytes+=Buffer.byteLength(JSON.stringify(chunk),'utf8');if(bytes>32*1048576)throw new AppError('Relay response exceeds 32 MiB',502,'response_too_large');pending.push(chunk);for(const c of chunk.choices??[]){content||=typeof c.delta?.content==='string'&&!!c.delta.content.trim();tools||=!!c.delta?.tool_calls?.length;}}}finally{if(targetSignal?.aborted&&response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}})());if(!content&&!tools)throw new AppError('Same-model provider returned no answer or tool call',502,'empty_response');onTarget?.(target,i);if(!route.accountPool?.enabled||target.accountId&&route.accountPool.accountIds.includes(target.accountId))this.pool.success(route,target,{expectedVersion:selectionVersion});if(!route.accountPool?.enabled||this.pool.version(route)===selectionVersion)this.relay.success(route,target,{requestId,trigger:usage.row.relay.trigger,from:previousTarget});started=true;for(const chunk of pending)yield chunk;}
        else for await(const chunk of normalizeChat(result.response,{model:route.id,recovery:result.recovery})){usage.chunk(chunk);if(!started){onTarget?.(target,i);if(!route.accountPool?.enabled||target.accountId&&route.accountPool.accountIds.includes(target.accountId))this.pool.success(route,target,{expectedVersion:selectionVersion});started=true;}yield chunk;}
        completed=true;
        return;
      }catch(e){
        if(signal?.aborted)e=interrupted(signal);else if(targetExpired)e=timeoutError;failure=e;last=e;
        const depleted=!signal?.aborted&&!isContextWindowError(e)&&this.pool.exhausted(route,target,e),poolModelAbsent=route.accountPool?.enabled&&e.code==='model_not_found',relayReason=signal?.aborted?null:this.relay.failure(route,target,e,{source});
        if(relayReason&&relayReason!=='capability_unavailable')lastSupplierFailure=e;
        // A final tools/image/budget mismatch must not relabel earlier supplier
        // rate limits/timeouts as a malformed caller request. Keep each attempt's
        // original error in the ledger; aggregate only the terminal public error.
        if(!started&&!signal?.aborted&&i===targets.length-1&&relayReason==='capability_unavailable'&&lastSupplierFailure){
          const unavailable=new AppError('同型号可用供应本轮均未完成请求；最后候选不支持当前请求能力；模型与上下文保持不变',503,'same_model_unavailable');
          const blocked=targets.map(t=>this.relay.cooldown(t)).filter(Boolean);
          if(blocked.length)unavailable.retryAfterSeconds=Math.max(1,Math.ceil((Math.min(...blocked.map(r=>r.until))-Date.now())/1000));
          throw unavailable;
        }
        if(started||signal?.aborted||i===targets.length-1||(!relayReason&&!depleted&&!poolModelAbsent&&!(route.fallbackStatuses??[408,429,500,502,503,504]).includes(e.status??502)))throw e;
        previousTarget=target;relayTrigger=relayReason??'upstream_unavailable';
      }
      finally{clearTimeout(targetTimer);if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});usage.finish(completed?'completed':signal?.aborted&&signal.reason?.name!=='TimeoutError'||!failure?'cancelled':'failed',failure);}
    }
    throw last??new AppError('Route has no targets',503,'no_upstream');
  }
}
