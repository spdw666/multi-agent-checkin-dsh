import {nvidiaRequestTimeout} from './nvidia.mjs';
import {AppError} from './util.mjs';
import {normalizeChat,validateChat,isContextWindowError} from './openai.mjs';
import {WorkBuddyPool} from './workbuddy-pool.mjs';
import {UsageAttempt} from './usage.mjs';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ModelRelay,isRelayTransportFailure} from './model-relay.mjs';
import {adaptRelayReasoning} from './relay-reasoning.mjs';
import {gatewayRequestTimeout} from './request-timeouts.mjs';
// A smaller standby need not reproduce the source's entire advertised window.
// Only prove a specific textual request fits using a conservative byte ceiling;
// chars/4 activity statistics are not token counts. Image cost is unknown here.
function relayContextFits(request,source,target){
  const sourceWindow=source?.contextWindow,targetWindow=target?.contextWindow;
  if(!Number.isSafeInteger(sourceWindow)||sourceWindow<1||!Number.isSafeInteger(targetWindow)||targetWindow<1||targetWindow>=sourceWindow)return true;
  if(request.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')))return false;
  const bytes=Buffer.byteLength(JSON.stringify(request),'utf8'),overhead=4096+128*request.messages.length+512*(request.tools?.length??0),output=Math.max(...[request.max_tokens,request.max_completion_tokens].filter(Number.isFinite),0);
  return bytes+overhead+output<=targetWindow;
}
const interrupted=signal=>new AppError(signal?.reason?.name==='TimeoutError'?'Gateway request deadline exceeded':'Request cancelled',signal?.reason?.name==='TimeoutError'?504:499,signal?.reason?.name==='TimeoutError'?'request_timeout':'request_cancelled');
export class Router {
  constructor(config,platforms,{ledger,relayAttemptTimeoutMs=30000,catalogTimeoutMs=20000,relayNetworkRetryDelayMs=250,relayPrefillTimeoutMs=90000,relayRateLimitDelay=(ms,signal)=>sleep(ms,undefined,{signal})}={}){if(!Number.isSafeInteger(relayAttemptTimeoutMs)||relayAttemptTimeoutMs<1||relayAttemptTimeoutMs>600000||!Number.isSafeInteger(catalogTimeoutMs)||catalogTimeoutMs<1||catalogTimeoutMs>60000)throw new TypeError('Relay and catalog deadlines must be positive bounded integers');if(!Number.isSafeInteger(relayNetworkRetryDelayMs)||relayNetworkRetryDelayMs<0||relayNetworkRetryDelayMs>5000)throw new TypeError('Network retry delay must be bounded');if(!Number.isSafeInteger(relayPrefillTimeoutMs)||relayPrefillTimeoutMs<1||relayPrefillTimeoutMs>600000)throw new TypeError('Prefill deadline must be bounded');if(typeof relayRateLimitDelay!=='function')throw new TypeError('Rate-limit delay must be a function');Object.assign(this,{config,platforms,ledger,relayAttemptTimeoutMs,catalogTimeoutMs,relayNetworkRetryDelayMs,relayPrefillTimeoutMs,relayRateLimitDelay});this.catalogFlights=new Map();this.pool=new WorkBuddyPool(config,ledger);this.relay=new ModelRelay(config,platforms,ledger);this.relay.pool=this.pool;this.relay.catalogRead=(id,options)=>this.catalog(id,options);}
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
    const relay=this.relay.active(route),discovered=await this.relay.discover(route,this.pool.candidates(route,{ignoreCooldown:true}),undefined,{ignoreCooldown:true}),targets=discovered.targets.filter(t=>this.config.value.upstreams.some(u=>u.id===t.upstreamId&&u.enabled!==false)&&(this.config.value.upstreams.find(u=>u.id===t.upstreamId)?.kind!=='workbuddy'||this.relay.enabled(t)));
    if(!targets.length)return undefined;
    const metadata=await Promise.all(targets.map(async t=>{const catalog=discovered.catalogs.get(t.upstreamId)??await this.catalog(t.upstreamId).catch(()=>[]);return catalog.find(m=>m.id===t.model)}));
    for(let i=0;i<targets.length;i++)if((this.config.value.upstreams??[]).find(u=>u.id===targets[i].upstreamId)?.kind==='workbuddy'&&!this.relay.enabled(targets[i]))metadata[i]=undefined;
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
    return {id:route.id,object:'model',created:0,owned_by:'ai-credit-gateway',name:route.name??primary.name??route.id,upstream:targets[selected].upstreamId,...(kind==='nvidia'?{requestTimeoutMs:nvidiaRequestTimeout(primary.id)}:{}),capabilities:{streaming:true,tools:primary.tools===true,multimodal:primary.multimodal===true},contextWindow,maxTokens,...(relay?{modelRelay:{strictSameModel:true,partition:this.relay.partition(route),modelFamily:discovered.family,targetCount:metadata.filter(m=>m&&m.callable!==false&&(!primary.tools||m.tools===true)&&(!primary.multimodal||m.multimodal===true)).length,fullWindowCompatibleCount:compatible.length,deliveryMode:'verified_request_buffer',attemptTimeoutMs:this.relayAttemptTimeoutMs,attemptTimeoutMode:'prefill_then_progress_idle',prefillTimeoutMs:this.relayPrefillTimeoutMs,prefillMinRequestBytes:131072,requestTimeoutMs:gatewayRequestTimeout(this.config.value.server,route.id)}}:{}),reasoning:primary.reasoning??null,reasoningEfforts:efforts??null,...(primary.reasoningEffortMapping?{reasoningEffortMapping:primary.reasoningEffortMapping,reasoningMappingSource:primary.reasoningMappingSource}:{})};
  }
  async models(){if(typeof this.config.load==='function')await this.config.load();const rows=await Promise.all(this.config.value.routes.filter(r=>r.enabled!==false).map(r=>this.routeInfo(r)));return {object:'list',data:rows.filter(Boolean)};}
  async * chat(raw,signal,{onTarget,source='api'}={}) {
    if(signal?.aborted)throw interrupted(signal);
    if(typeof this.config.load==='function')await this.config.load();
    if(signal?.aborted)throw interrupted(signal);
    const request=validateChat(raw);const route=this.config.value.routes.find(r=>r.id===request.model&&r.enabled!==false);
    if(!route)throw new AppError(`Unknown route: ${request.model}`,404,'model_not_found');
    let last,lastSupplierFailure;const requestId=randomUUID(),requestStarted=Date.now(),requestBudget=gatewayRequestTimeout(this.config.value.server,route.id);
    const relayActive=this.relay.active(route,source),prepared=await this.relay.prepare(route,this.pool.candidates(route),signal,{source}),targets=prepared.targets,selectionVersion=this.pool.version(route);let previousTarget,relayTrigger;
    const longPrefill=Buffer.byteLength(JSON.stringify(request),'utf8')>=131072||request.messages.length>=128;
    const targetKey=t=>t.upstreamId+'\0'+t.model,rateBlocked=new Map((prepared.blocked??[]).filter(r=>r.reasonCode==='rate_limited').map(r=>[targetKey(r.target),r])),recoveryCircuits=new Map();let recoveredRateLimit=false;
    const rememberRateLimit=target=>{const row=this.relay.blockedTarget(target,this.relay.get('relay-cooldown:'+targetKey(target)));if(row?.reasonCode==='rate_limited')rateBlocked.set(targetKey(target),row);};
    const sameRateCircuit=(current,expected)=>current.reasonCode==='rate_limited'&&['until','upstreamCode','rateLimitKind','rateLimitRetryable','retryAfterSource'].every(key=>current[key]===expected[key]);
    const unchangedRateCircuit=(target,expected)=>{const current=this.relay.cooldown(target);if(current&&!sameRateCircuit(current,expected)){rememberRateLimit(target);return false;}return true;};
    const recoveryRestriction=target=>{
      const expected=recoveryCircuits.get(targetKey(target));if(!expected)return null;
      const current=this.relay.cooldown(target);
      if(current&&!sameRateCircuit(current,expected)){
        rememberRateLimit(target);
        if(current.reasonCode==='rate_limited')return this.relay.rateLimitError([this.relay.blockedTarget(target,current)]);
        const status=current.reasonCode==='authentication_unavailable'?401:current.reasonCode==='credits_exhausted'||current.reason==='credits_exhausted'?402:503;
        const error=new AppError('原供应在恢复排队期间进入新的限制状态；本次未重复生成，模型与上下文保持不变',status,status===401?'provider_auth_rejected':status===402?'same_model_credits_exhausted':'same_model_cooldown');error.retryAfterSeconds=Math.max(0,Math.ceil((current.until-Date.now())/1000));return error;
      }
      return this.relay.enabled(target)?null:new AppError('原供应在恢复排队期间已停用；本次未重复生成，模型与上下文保持不变',503,'same_model_unavailable');
    };
    // Only an explicitly identified short-window rate limit may wait and replay.
    // The original whole-request clock, signal, history and output budget remain
    // authoritative; a Retry-After alone does not classify an unknown 429.
    const recoverRateLimit=async()=>{
      if(recoveredRateLimit||signal?.aborted)return false;
      for(const row of [...rateBlocked.values()].sort((a,b)=>a.until-b.until)){
        if(row.rateLimitKind!=='transient'||row.rateLimitRetryable!==true||!['official_header','official_body'].includes(row.retryAfterSource)||!this.relay.enabled(row.target))continue;
        if(!unchangedRateCircuit(row.target,row))continue;
        const delay=Math.max(0,row.until-Date.now())+25,needed=longPrefill?Math.max(this.relayAttemptTimeoutMs,this.relayPrefillTimeoutMs):this.relayAttemptTimeoutMs;
        if(delay>60025||requestBudget-(Date.now()-requestStarted)<=delay+needed+1000)continue;
        if(this.relay.exhaustedBalance(await this.relay.balance(row.target,signal)))continue;
        if(signal?.aborted)throw interrupted(signal);
        if(!this.relay.enabled(row.target)||!unchangedRateCircuit(row.target,row))continue;
        if(requestBudget-(Date.now()-requestStarted)<=delay+needed+1000)continue;
        recoveredRateLimit=true;
        try{await this.relayRateLimitDelay(delay,signal);}catch(e){if(signal?.aborted)throw interrupted(signal);throw e;}
        if(signal?.aborted)throw interrupted(signal);
        if(requestBudget-(Date.now()-requestStarted)<=needed+1000)return false;
        if(!unchangedRateCircuit(row.target,row))return false;
        // A concurrent balance refresh or manual disable wins over recovery.
        if(!this.relay.enabled(row.target)||this.relay.exhaustedBalance(await this.relay.balance(row.target,signal)))return false;
        if(signal?.aborted)throw interrupted(signal);
        if(!this.relay.enabled(row.target)||!unchangedRateCircuit(row.target,row))return false;
        if(requestBudget-(Date.now()-requestStarted)<=needed+1000)return false;
        targets.push({...row.target});recoveryCircuits.set(targetKey(row.target),row);relayTrigger='rate_limit_recovery';return true;
      }
      return false;
    };
    if(signal?.aborted)throw interrupted(signal);
    if(!targets.length&&!await recoverRateLimit()){
      const rate=relayActive&&this.relay.rateLimitError([...rateBlocked.values()]);if(rate)throw rate;
      const retry=prepared.retryAfterSeconds,emptyCredits=relayActive&&!retry&&prepared.exhaustedTargetCount>0,error=new AppError(relayActive?(retry?`同型号供应处于额度或限流冷却；${retry}秒后可重试；模型与上下文保持不变`:emptyCredits?'已确认的同型号供应剩余额度为零；模型与上下文保持不变':'同型号当前没有已启用供应；模型与上下文保持不变'):'All WorkBuddy pool accounts are disabled or credits are cooling down',emptyCredits?402:503,relayActive?(retry?'same_model_cooldown':emptyCredits?'same_model_credits_exhausted':'same_model_unavailable'):'account_pool_unavailable');if(retry)error.retryAfterSeconds=retry;throw error;
    }
    let sourceModel,recoveredPrimary=false;
    if(relayActive){try{const catalog=prepared.catalogs.get(route.targets[0].upstreamId)??await this.catalog(route.targets[0].upstreamId,{signal});sourceModel=catalog.find(m=>m.id===route.targets[0].model);}catch(e){if(signal?.aborted)throw new AppError('Request cancelled',499,'request_cancelled');}}
    for(let i=0;i<targets.length;i++) {
      const target=targets[i];let started=false,completed=false,failure,response,blockedByCircuit=false;
      if(signal?.aborted)throw interrupted(signal);
      const remaining=Math.max(1,requestBudget-(Date.now()-requestStarted)-1000),prefillBudget=longPrefill?Math.max(this.relayAttemptTimeoutMs,this.relayPrefillTimeoutMs):this.relayAttemptTimeoutMs,attemptBudget=Math.max(1,Math.min(prefillBudget,Math.floor(remaining/Math.min(2,targets.length-i))));
      let semanticProgress=false;
      const targetController=relayActive?new AbortController():null,targetSignal=relayActive?(signal?AbortSignal.any([signal,targetController.signal]):targetController.signal):signal;
      const timeoutError=new AppError('Same-model supplier made no progress within its relay idle budget',504,'relay_target_timeout');let targetTimer,targetExpired=false,rejectTarget;
      const targetDeadline=relayActive?new Promise((_,reject)=>{rejectTarget=reject;}):null;
      const progress=()=>{if(!relayActive||targetExpired)return;clearTimeout(targetTimer);const remainingWhole=Math.max(1,requestBudget-(Date.now()-requestStarted)-1000);targetTimer=setTimeout(()=>{targetExpired=true;rejectTarget(timeoutError);targetController.abort(timeoutError);},Math.min(semanticProgress?this.relayAttemptTimeoutMs:attemptBudget,remainingWhole));};
      progress();
      const waitTarget=p=>targetDeadline?Promise.race([p,targetDeadline]):p;
      const usage=new UsageAttempt(this.ledger,this.config.value,request,target,{requestId,attempt:i+1,source});
      if(relayActive){usage.row.deliveryMode='verified_request_buffer';usage.row.relay={trigger:relayTrigger??prepared.reasons.get(route.targets[0].upstreamId+'\0'+route.targets[0].model)??'preferred_same_model',fromPlatform:this.config.value.upstreams.find(u=>u.id===(previousTarget??route.targets[0]).upstreamId)?.kind??'',toPlatform:this.config.value.upstreams.find(u=>u.id===target.upstreamId)?.kind??''};}
      try {
        if((this.config.value.upstreams??[]).find(u=>u.id===target.upstreamId)?.kind==='workbuddy'&&!this.relay.enabled(target))throw new AppError('该 WB 帐号已停用积分调用；签到和自动任务保持不变',409,'wb_inference_disabled');
        const catalog=await waitTarget(this.catalog(target.upstreamId,{signal:targetSignal}));const model=catalog.find(m=>m.id===target.model);
        const queuedRestriction=recoveryRestriction(target);if(queuedRestriction){blockedByCircuit=true;throw queuedRestriction;}
        if(!model||model.callable===false)throw new AppError(`Model absent from live catalog: ${target.model}`,404,'model_not_found');
        if(relayActive&&!relayContextFits(request,sourceModel,model)){
          const e=new AppError('当前同型号备用尚未确认可完整承接本次长上下文；原始历史、工具和输出预算已保留，等待原供应恢复',503,'relay_context_incompatible');
          const blocked=this.relay.candidates(route,route.targets,{ignoreCooldown:true}).map(t=>this.relay.cooldown(t)).filter(Boolean);if(blocked.length)e.retryAfterSeconds=Math.max(1,Math.ceil((Math.min(...blocked.map(r=>r.until))-Date.now())/1000));throw e;
        }
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
        let result;for(let transportAttempt=1;transportAttempt<=2;transportAttempt++){
          try{const restriction=recoveryRestriction(target);if(restriction){blockedByCircuit=true;throw restriction;}if((this.config.value.upstreams??[]).find(u=>u.id===target.upstreamId)?.kind==='workbuddy'&&!this.relay.enabled(target))throw new AppError('该 WB 帐号已停用积分调用；签到和自动任务保持不变',409,'wb_inference_disabled');result=await waitTarget(this.platforms.chat(target,adapted.request,targetSignal));break;}
          catch(e){if(!relayActive||(!isRelayTransportFailure(e)||e.code==='relay_target_timeout')||transportAttempt===2||targetSignal?.aborted||attemptBudget<=this.relayNetworkRetryDelayMs+100||requestBudget-(Date.now()-requestStarted)<=this.relayNetworkRetryDelayMs+1000)throw e;
            usage.row.transportAttempts=2;usage.row.transportRetryReason=e.code;progress();await waitTarget(sleep(this.relayNetworkRetryDelayMs,undefined,{signal:targetSignal}));progress();}
        }response=result.response;
        const nativeAttempts=Number(response.headers?.get('x-ai-credit-trae-attempts'));if(Number.isInteger(nativeAttempts)&&nativeAttempts>0&&nativeAttempts<=2)usage.row.nativeAttempts=nativeAttempts;const nativeRetry=response.headers?.get('x-ai-credit-trae-retry-reason');if(nativeRetry==='reasoning_only_stop')usage.row.nativeRetryReason=nativeRetry;
        // During automatic handoff, no answer or proposed tool call is exposed
        // until this attempt is complete. Failed partial streams can then be
        // replayed on the same model without duplicated text or executed tools.
        if(relayActive){let bytes=0,content=false,tools=false;const pending=[];await waitTarget((async()=>{try{for await(const chunk of normalizeChat(result.response,{model:route.id,recovery:result.recovery})){if(targetSignal?.aborted)throw targetExpired?timeoutError:interrupted(signal);usage.chunk(chunk);if(chunk.choices?.some(c=>c.delta?.content||c.delta?.reasoning_content||c.delta?.reasoning||c.delta?.tool_calls?.length)){semanticProgress=true;progress();}bytes+=Buffer.byteLength(JSON.stringify(chunk),'utf8');if(bytes>32*1048576)throw new AppError('Relay response exceeds 32 MiB',502,'response_too_large');pending.push(chunk);for(const c of chunk.choices??[]){content||=typeof c.delta?.content==='string'&&!!c.delta.content.trim();tools||=!!c.delta?.tool_calls?.length;}}}finally{if(targetSignal?.aborted&&response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}})());if(!content&&!tools)throw new AppError('Same-model provider returned no answer or tool call',502,'empty_response');onTarget?.(target,i);if(!route.accountPool?.enabled||target.accountId&&route.accountPool.accountIds.includes(target.accountId))this.pool.success(route,target,{expectedVersion:selectionVersion});if(!route.accountPool?.enabled||this.pool.version(route)===selectionVersion)this.relay.success(route,target,{requestId,trigger:usage.row.relay.trigger,from:previousTarget});started=true;for(const chunk of pending)yield chunk;}
        else for await(const chunk of normalizeChat(result.response,{model:route.id,recovery:result.recovery})){usage.chunk(chunk);if(!started){onTarget?.(target,i);if(!route.accountPool?.enabled||target.accountId&&route.accountPool.accountIds.includes(target.accountId))this.pool.success(route,target,{expectedVersion:selectionVersion});started=true;}yield chunk;}
        if(recoveryCircuits.has(targetKey(target)))this.relay.clearRateLimit(target,recoveryCircuits.get(targetKey(target)).until);
        completed=true;
        return;
      }catch(e){
        if(signal?.aborted)e=interrupted(signal);else if(targetExpired)e=timeoutError;failure=e;last=e;
        const depleted=!blockedByCircuit&&!signal?.aborted&&!isContextWindowError(e)&&this.pool.exhausted(route,target,e),poolModelAbsent=route.accountPool?.enabled&&e.code==='model_not_found',relayReason=signal?.aborted?null:blockedByCircuit?(e.status===429?'rate_limited':null):this.relay.failure(route,target,e,{source});
        if(relayReason&&relayReason!=='capability_unavailable')lastSupplierFailure=e;
        if(relayReason==='rate_limited')rememberRateLimit(target);
        if(!started&&!signal?.aborted&&i===targets.length-1&&['rate_limited','capability_unavailable'].includes(relayReason)&&rateBlocked.size){
          if(await recoverRateLimit()){previousTarget=target;continue;}
          const rate=this.relay.rateLimitError([...rateBlocked.values()],{capability:relayReason==='capability_unavailable'});if(rate)throw rate;
        }
        // A long conversation can outgrow every currently available standby.
        // Wait for a short connection-only circuit to reopen and recover the
        // original supplier once, rather than return an invalid-request 400.
        if(!started&&!signal?.aborted&&i===targets.length-1&&e.code==='relay_context_incompatible'&&!recoveredPrimary){
          const primary=route.targets[0],circuit=this.relay.cooldown(primary),delay=circuit?Math.max(0,circuit.until-Date.now())+25:0;
          if(circuit?.reasonCode==='upstream_unavailable'&&isRelayTransportFailure({code:circuit.errorCode})&&delay<=5100&&requestBudget-(Date.now()-requestStarted)>delay+1000&&this.relay.enabled(primary)){
            const balance=await this.relay.balance(primary,signal);if(!this.relay.exhaustedBalance(balance)){recoveredPrimary=true;await sleep(delay,undefined,{signal});if(signal?.aborted)throw interrupted(signal);targets.push({...primary});previousTarget=target;relayTrigger='connection_recovery';continue;}
          }
        }
        if(!started&&!signal?.aborted&&i===targets.length-1&&relayReason==='capability_unavailable'&&e.code==='relay_context_incompatible'){
          const causeCode=lastSupplierFailure?.code??this.relay.cooldown(route.targets[0])?.errorCode;
          if(['provider_timeout','relay_target_timeout'].includes(causeCode)){
            const timeout=new AppError('原同型号供应等待响应超时；当前备用不足以完整承接本次上下文；历史、工具和输出预算均已保留',504,'same_model_timeout');
            const circuit=this.relay.cooldown(route.targets[0]);if(circuit)timeout.retryAfterSeconds=Math.max(1,Math.ceil((circuit.until-Date.now())/1000));throw timeout;
          }
        }
        // A final tools/image/budget mismatch must not relabel earlier supplier
        // rate limits/timeouts as a malformed caller request. Keep each attempt's
        // original error in the ledger; aggregate only the terminal public error.
        if(!started&&!signal?.aborted&&i===targets.length-1&&relayReason==='capability_unavailable'&&lastSupplierFailure){
          const unavailable=new AppError('同型号可用供应本轮均未完成请求；最后候选不支持当前请求能力；模型与上下文保持不变',503,'same_model_unavailable');
          const blocked=targets.map(t=>this.relay.cooldown(t)).filter(Boolean);
          if(blocked.length)unavailable.retryAfterSeconds=Math.max(1,Math.ceil((Math.min(...blocked.map(r=>r.until))-Date.now())/1000));
          throw unavailable;
        }
        if(started||signal?.aborted||i===targets.length-1||(!relayReason&&!depleted&&!poolModelAbsent&&e.code!=='wb_inference_disabled'&&!(route.fallbackStatuses??[408,429,500,502,503,504]).includes(e.status??502)))throw e;
        previousTarget=target;relayTrigger=relayReason??'upstream_unavailable';
      }
      finally{clearTimeout(targetTimer);if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});usage.finish(completed?'completed':signal?.aborted&&signal.reason?.name!=='TimeoutError'||!failure?'cancelled':'failed',failure);}
    }
    throw last??new AppError('Route has no targets',503,'no_upstream');
  }
}
