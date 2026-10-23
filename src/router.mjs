import {nvidiaRequestTimeout} from './nvidia.mjs';
import {AppError} from './util.mjs';
import {normalizeChat,validateChat,isContextWindowError} from './openai.mjs';
import {WorkBuddyPool} from './workbuddy-pool.mjs';
import {UsageAttempt} from './usage.mjs';
import {captureRequestContext} from './activity-context.mjs';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ModelRelay,isRelayTransportFailure} from './model-relay.mjs';
import {adaptRelayReasoning} from './relay-reasoning.mjs';
import {gatewayRequestTimeout} from './request-timeouts.mjs';
import {RequestPlan,outputCapacity,supplierTerminal} from './request-plan.mjs';
const interrupted=signal=>new AppError(signal?.reason?.name==='TimeoutError'?'Gateway request deadline exceeded':'Request cancelled',signal?.reason?.name==='TimeoutError'?504:499,signal?.reason?.name==='TimeoutError'?'request_timeout':'request_cancelled');
export class Router {
  constructor(config,platforms,{ledger,relayAttemptTimeoutMs=30000,catalogTimeoutMs=20000,relayNetworkRetryDelayMs=250,relayPrefillTimeoutMs=240000,relayRateLimitDelay=(ms,signal)=>sleep(ms,undefined,{signal})}={}){if(!Number.isSafeInteger(relayAttemptTimeoutMs)||relayAttemptTimeoutMs<1||relayAttemptTimeoutMs>600000||!Number.isSafeInteger(catalogTimeoutMs)||catalogTimeoutMs<1||catalogTimeoutMs>60000)throw new TypeError('Relay and catalog deadlines must be positive bounded integers');if(!Number.isSafeInteger(relayNetworkRetryDelayMs)||relayNetworkRetryDelayMs<0||relayNetworkRetryDelayMs>5000)throw new TypeError('Network retry delay must be bounded');if(!Number.isSafeInteger(relayPrefillTimeoutMs)||relayPrefillTimeoutMs<1||relayPrefillTimeoutMs>600000)throw new TypeError('Prefill deadline must be bounded');if(typeof relayRateLimitDelay!=='function')throw new TypeError('Rate-limit delay must be a function');Object.assign(this,{config,platforms,ledger,relayAttemptTimeoutMs,catalogTimeoutMs,relayNetworkRetryDelayMs,relayPrefillTimeoutMs,relayRateLimitDelay});this.catalogFlights=new Map();this.pool=new WorkBuddyPool(config,ledger);this.relay=new ModelRelay(config,platforms,ledger);this.relay.pool=this.pool;this.relay.catalogRead=(id,options)=>this.catalog(id,options);}
  catalogKey(id){
    const u=this.config.value.upstreams?.find(u=>u.id===id),a=this.config.value.accounts?.find(a=>a.id===u?.accountId),source=JSON.stringify([u,a]);
    this.catalogSources??=new Map();const prior=this.catalogSources.get(id);
    if(!prior||prior.source!==source)this.catalogSources.set(id,{source,version:(prior?.version??0)+1});
    return id+'\0'+this.catalogSources.get(id).version+'\0'+source;
  }
  async catalog(id,{signal,batch}={}){
    if(signal?.aborted)throw interrupted(signal);
    const key=this.catalogKey(id);
    let operation=batch?.reads.get(key)??this.catalogFlights.get(key);
    if(!operation){let timer;const controller=new AbortController(),error=new AppError('Model catalogue lookup timed out',504,'model_catalog_timeout');
      operation=Promise.race([Promise.resolve().then(()=>this.platforms.models(id,{signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(error);controller.abort(error)},this.catalogTimeoutMs)})]).finally(()=>{clearTimeout(timer);if(this.catalogFlights.get(key)===operation)this.catalogFlights.delete(key)});
      this.catalogFlights.set(key,operation);
    }
    batch?.reads.set(key,operation);
    let abort;try{return await(signal?Promise.race([operation,new Promise((_,reject)=>{abort=()=>reject(interrupted(signal));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})]):operation)}finally{if(abort)signal.removeEventListener('abort',abort)}
  }
  directoryVersion(){
    // Disabled routes supply neither public models nor relay candidates. Exclude
    // their details, but rebuild the enabled set each time so enable/disable
    // transitions still invalidate an in-progress directory immediately.
    const value=this.config.value,routes=value.routes.filter(r=>r.enabled!==false);
    return JSON.stringify([routes,value.upstreams,value.accounts,value.modelRelay,value.server,routes.filter(r=>r.accountPool?.enabled).map(r=>{const row=this.pool.get('wb-pool-route:'+r.id);return [r.id,row?.preferredAccountId,row?.manualVersion];})]);
  }
  directoryBatch(){
    const indexes=new WeakMap();return {reads:new Map(),index:this.relay.discoveryIndex(),lookup:(rows,id)=>{let index=indexes.get(rows);if(!index){index=new Map();for(const row of rows)if(!index.has(row.id))index.set(row.id,row);indexes.set(rows,index);}return index.get(id);}};
  }
  async routeInfo(route,batch) {
    if(!batch){
      for(let attempt=0;attempt<3;attempt++){
        const before=this.directoryVersion(),current=this.config.value.routes.find(r=>r.id===route.id);
        if(!current||current.enabled===false)return undefined;
        const row=await this.routeInfo(current,this.directoryBatch());if(before===this.directoryVersion())return row;
      }
      throw new AppError('Model directory changed during lookup; refresh again',503,'model_directory_changed');
    }
    const relay=this.relay.active(route),discovered=await this.relay.discover(route,this.pool.candidates(route,{ignoreCooldown:true}),undefined,{ignoreCooldown:true,...(batch?{index:batch.index,catalogRead:(id,opts)=>this.catalog(id,{...opts,batch}),modelLookup:batch.lookup}:{})}),targets=discovered.targets.filter(t=>this.config.value.upstreams.some(u=>u.id===t.upstreamId&&u.enabled!==false)&&(this.config.value.upstreams.find(u=>u.id===t.upstreamId)?.kind!=='workbuddy'||this.relay.enabled(t)));
    if(!targets.length)return undefined;
    const metadata=await Promise.all(targets.map(async t=>{const catalog=discovered.catalogs.get(t.upstreamId)??await this.catalog(t.upstreamId,{batch}).catch(()=>[]);return batch?batch.lookup(catalog,t.model):catalog.find(m=>m.id===t.model)}));
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
    // Publish the selected primary's verified ceiling when available. A small
    // standby must not lower it, but a configured suggestion must not hide a
    // separately supplied official ceiling either.
    const maxTokens=outputCapacity(primary)??primary.maxTokens??4096;
    if(kind==='nvidia'&&(primary.importable===false||!Number.isInteger(primary.contextWindow)||primary.contextWindow<1||!Number.isInteger(primary.maxTokens)||primary.maxTokens<1))return undefined;
    const efforts=primary.reasoningEfforts??(Array.isArray(primary.reasoning?.supportedEfforts)?Object.fromEntries(primary.reasoning.supportedEfforts.map(k=>[k,k])):null);
    return {id:route.id,object:'model',created:0,owned_by:'ai-credit-gateway',name:route.name??primary.name??route.id,upstream:targets[selected].upstreamId,...(kind==='nvidia'?{requestTimeoutMs:nvidiaRequestTimeout(primary.id)}:{}),capabilities:{streaming:true,tools:primary.tools===true,multimodal:primary.multimodal===true},contextWindow,maxTokens,...(relay?{modelRelay:{strictSameModel:true,partition:this.relay.partition(route),modelFamily:discovered.family,targetCount:metadata.filter(m=>m&&m.callable!==false&&(!primary.tools||m.tools===true)&&(!primary.multimodal||m.multimodal===true)).length,fullWindowCompatibleCount:compatible.length,deliveryMode:'verified_request_buffer',attemptTimeoutMs:this.relayAttemptTimeoutMs,attemptTimeoutMode:'prefill_then_progress_idle',prefillTimeoutMs:this.relayPrefillTimeoutMs,prefillMinRequestBytes:131072,requestTimeoutMs:gatewayRequestTimeout(this.config.value.server,route.id)}}:{}),reasoning:primary.reasoning??null,reasoningEfforts:efforts??null,...(primary.reasoningEffortMapping?{reasoningEffortMapping:primary.reasoningEffortMapping,reasoningMappingSource:primary.reasoningMappingSource}:{})};
  }
  async models(){
    if(typeof this.config.load==='function')await this.config.load();
    // Completed reads are retained only for this directory batch, allowing a
    // later opaque-alias phase to reuse an earlier read without a stale TTL.
    for(let attempt=0;attempt<3;attempt++){
      const before=this.directoryVersion(),batch=this.directoryBatch();
      const rows=await Promise.all(this.config.value.routes.filter(r=>r.enabled!==false).map(r=>this.routeInfo(r,batch)));
      if(before===this.directoryVersion())return {object:'list',data:rows.filter(Boolean)};
    }
    throw new AppError('Model directory changed during lookup; refresh again',503,'model_directory_changed');
  }
  async * chat(raw,signal,{onTarget,source='api',requestId:providedRequestId,clientId,sessionId,controlLease}={}) {
    const requestId=typeof providedRequestId==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(providedRequestId)?providedRequestId:randomUUID(),requestStarted=Date.now();
    let request,route,plan,latestUsage,requestContext,requestCompleted=false,requestError;
    try{
    if(signal?.aborted)throw interrupted(signal);
    if(typeof this.config.load==='function')await this.config.load();
    if(signal?.aborted)throw interrupted(signal);
    request=validateChat(raw);requestContext=captureRequestContext(request);plan=new RequestPlan(request,this.config.value);route=this.config.value.routes.find(r=>r.id===request.model&&r.enabled!==false);
    if(!route)throw new AppError(`Unknown route: ${request.model}`,404,'model_not_found');
    let last,lastSupplierFailure,firstSupplierFailure;const requestBudget=gatewayRequestTimeout(this.config.value.server,route.id);
    const relayActive=this.relay.active(route,source),prepared=await this.relay.prepare(route,this.pool.candidates(route),signal,{source}),targets=prepared.targets,selectionVersion=this.pool.version(route);let previousTarget,relayTrigger;
    plan.catalogs=new Map(prepared.catalogs);plan.seedBlocked(prepared.blocked);
    // These snapshots are scoped to one request, not an eager pool pre-read or a
    // permanent capability cache. Discovery's signed catalog is authoritative.
    const catalogReads=new Map(),catalogFor=async(id,signal)=>{if(plan.catalogs.has(id))return plan.catalogs.get(id);if(!catalogReads.has(id))catalogReads.set(id,this.catalog(id,{signal}).then(catalog=>{plan.catalogs.set(id,catalog);return catalog;}));return catalogReads.get(id);};
    // A 1,200-turn conversation can still be under the byte threshold once tool
    // results are trimmed, but its prefill is far slower than a fresh request.
    // Gate on either real serialized bytes or message count.
    const requestBytes=plan.contract.serializedBytes;
    const longPrefill=requestBytes>=131072||request.messages.length>=128;
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
    if(relayActive){try{const catalog=await catalogFor(route.targets[0].upstreamId,signal);sourceModel=catalog.find(m=>m.id===route.targets[0].model);}catch(e){if(signal?.aborted)throw new AppError('Request cancelled',499,'request_cancelled');}}
    if(this.controls?.enabled()){
      // Policy can reorder only candidates already supplied by the incumbent
      // pool/strict-family discovery. Live capability checks remain authoritative;
      // incompatible targets are never promoted by speed or affinity scores.
      const eligible=new Set();await Promise.all(targets.map(async target=>{try{const model=(await catalogFor(target.upstreamId,signal)).find(row=>row.id===target.model);if(model&&model.callable!==false){const probe=new RequestPlan(request,this.config.value);if(!probe.inspect(model,sourceModel,{relay:relayActive}).error)eligible.add(targetKey(target));}}catch{if(signal?.aborted)throw interrupted(signal);}}));
      const ordered=this.controls.orderTargets(route,targets,{clientId,sessionId,sameModel:relayActive,eligible:target=>eligible.has(targetKey(target))});targets.splice(0,targets.length,...ordered);
    }
    for(let i=0;i<targets.length;i++) {
      const target=targets[i];let started=false,completed=false,failure,response,blockedByCircuit=false,skipped=false;
      plan.candidate();
      if(signal?.aborted)throw interrupted(signal);
      // A long prefill is one all-or-nothing attempt: halving the remaining
      // request budget guarantees that neither half reaches the real first-token
      // latency (a 240s prefill promise silently became 89.5s at 180s/2). Short
      // attempts still reserve a slice for the next candidate; the whole-request
      // deadline stays the outer bound in both cases.
      const remaining=Math.max(1,requestBudget-(Date.now()-requestStarted)-1000),prefillBudget=longPrefill?Math.max(this.relayAttemptTimeoutMs,this.relayPrefillTimeoutMs):this.relayAttemptTimeoutMs,attemptBudget=Math.max(1,Math.min(prefillBudget,longPrefill?remaining:Math.floor(remaining/Math.min(2,targets.length-i))));
      let semanticProgress=false;
      const targetController=relayActive?new AbortController():null,targetSignal=relayActive?(signal?AbortSignal.any([signal,targetController.signal]):targetController.signal):signal;
      const timeoutError=new AppError('Same-model supplier made no progress within its relay idle budget',504,'relay_target_timeout');let targetTimer,targetExpired=false,rejectTarget;
      const targetDeadline=relayActive?new Promise((_,reject)=>{rejectTarget=reject;}):null;
      const progress=()=>{if(!relayActive||targetExpired)return;clearTimeout(targetTimer);const remainingWhole=Math.max(1,requestBudget-(Date.now()-requestStarted)-1000);targetTimer=setTimeout(()=>{targetExpired=true;rejectTarget(timeoutError);targetController.abort(timeoutError);},Math.min(semanticProgress?this.relayAttemptTimeoutMs:attemptBudget,remainingWhole));};
      progress();
      const waitTarget=p=>targetDeadline?Promise.race([p,targetDeadline]):p;
      const usage=new UsageAttempt(this.ledger,this.config.value,request,target,{requestId,attempt:i+1,source,requestContext});
      latestUsage=usage;usage.row.requestContract=plan.contract;
      if(relayActive){usage.row.deliveryMode='verified_request_buffer';usage.row.relay={trigger:relayTrigger??prepared.reasons.get(route.targets[0].upstreamId+'\0'+route.targets[0].model)??'preferred_same_model',fromPlatform:this.config.value.upstreams.find(u=>u.id===(previousTarget??route.targets[0]).upstreamId)?.kind??'',toPlatform:this.config.value.upstreams.find(u=>u.id===target.upstreamId)?.kind??''};}
      const controlVersion=this.controls?.enabled()?this.controls.targetVersion(target):null;
      try {
        if(this.controls?.enabled()&&!this.relay.enabled(target))throw new AppError('Routing policy candidate is no longer enabled; no provider request sent',503,'control_target_ineligible');
        if((this.config.value.upstreams??[]).find(u=>u.id===target.upstreamId)?.kind==='workbuddy'&&!this.relay.enabled(target))throw new AppError('该 WB 帐号已停用积分调用；签到和自动任务保持不变',409,'wb_inference_disabled');
        const catalog=await waitTarget(catalogFor(target.upstreamId,targetSignal));const model=catalog.find(m=>m.id===target.model);
        const queuedRestriction=recoveryRestriction(target);if(queuedRestriction){blockedByCircuit=true;throw queuedRestriction;}
        if(!model||model.callable===false)throw new AppError(`Model absent from live catalog: ${target.model}`,404,'model_not_found');
        const kind=this.config.value.upstreams?.find(u=>u.id===target.upstreamId)?.kind;
        const adapted=adaptRelayReasoning(request,model,{kind,sourceModel,relayed:relayActive});
        if(relayActive)usage.row.reasoningPolicy=adapted.metadata;
        // Preserve the caller contract for diagnostics, but check what will
        // actually be sent. The retained tiny-budget floor may exceed either
        // output capacity or the conservative standby context bound.
        const budgetChanged=adapted.request.max_tokens!==request.max_tokens||adapted.request.max_completion_tokens!==request.max_completion_tokens;
        const candidatePlan=budgetChanged?new RequestPlan(adapted.request,this.config.value):plan;
        const planned=candidatePlan.inspect(model,sourceModel,{relay:relayActive});
        if(candidatePlan.capacityGap&&(!plan.capacityGap||candidatePlan.capacityGap.capacity>plan.capacityGap.capacity))plan.capacityGap={...candidatePlan.capacityGap};
        usage.row.candidatePlan={...planned.metadata,...(budgetChanged?{requestedOutputBudget:plan.contract.outputBudget,effectiveOutputBudget:candidatePlan.contract.outputBudget}:{})};
        if(planned.error){
          if(planned.error.code==='relay_context_incompatible'){const blocked=this.relay.candidates(route,route.targets,{ignoreCooldown:true}).map(t=>this.relay.cooldown(t)).filter(Boolean);if(blocked.length)planned.error.retryAfterSeconds=Math.max(1,Math.ceil((Math.min(...blocked.map(r=>r.until))-Date.now())/1000));}
          throw planned.error;
        }
        let result;for(let transportAttempt=1;transportAttempt<=2;transportAttempt++){
          try{let restriction=recoveryRestriction(target);if(restriction){blockedByCircuit=true;throw restriction;}
            if(recoveryCircuits.has(targetKey(target))){const balance=await waitTarget(this.relay.balance(target,targetSignal));restriction=recoveryRestriction(target);if(restriction){blockedByCircuit=true;throw restriction;}if(this.relay.exhaustedBalance(balance)){blockedByCircuit=true;throw new AppError('原供应在恢复派发前已确认剩余额度为零；本次未重复生成，模型与上下文保持不变',402,'same_model_credits_exhausted');}}
            if(controlVersion&&(!this.relay.enabled(target)||controlVersion!==this.controls.targetVersion(target)))throw new AppError('Routing policy candidate source changed before dispatch; refresh eligibility',503,'control_target_ineligible');
            controlLease?.checkTarget?.(target);
            if((this.config.value.upstreams??[]).find(u=>u.id===target.upstreamId)?.kind==='workbuddy'&&!this.relay.enabled(target))throw new AppError('该 WB 帐号已停用积分调用；签到和自动任务保持不变',409,'wb_inference_disabled');plan.dispatched(!usage.row.dispatched);usage.dispatched();result=await waitTarget(this.platforms.chat(target,adapted.request,targetSignal));break;}
          catch(e){const retryBase=this.relayNetworkRetryDelayMs,retryDelay=retryBase+Math.floor(Math.random()*retryBase/2);if(!relayActive||(!isRelayTransportFailure(e)||e.code==='relay_target_timeout')||transportAttempt===2||targetSignal?.aborted||attemptBudget<=retryDelay+100||requestBudget-(Date.now()-requestStarted)<=retryDelay+1000)throw e;
            usage.row.transportAttempts=2;usage.row.transportRetryReason=e.code;usage.row.transportRetryDelayMs=retryDelay;progress();await waitTarget(sleep(retryDelay,undefined,{signal:targetSignal}));progress();}
        }response=result.response;
        const nativeAttempts=Number(response.headers?.get('x-ai-credit-trae-attempts'));if(Number.isInteger(nativeAttempts)&&nativeAttempts>0&&nativeAttempts<=2)usage.row.nativeAttempts=nativeAttempts;const nativeRetry=response.headers?.get('x-ai-credit-trae-retry-reason');if(nativeRetry==='reasoning_only_stop')usage.row.nativeRetryReason=nativeRetry;
        // During automatic handoff, no answer or proposed tool call is exposed
        // until this attempt is complete. Failed partial streams can then be
        // replayed on the same model without duplicated text or executed tools.
        // Reasoning alone does not prove budget exhaustion: only an explicit
        // length finish is caller-budget evidence; an empty stop stays relayable.
        if(relayActive){let bytes=0,content=false,tools=false,reasoning=false,finish=null;const pending=[];await waitTarget((async()=>{try{for await(const chunk of normalizeChat(result.response,{model:route.id,recovery:result.recovery})){if(targetSignal?.aborted)throw targetExpired?timeoutError:interrupted(signal);usage.chunk(chunk);if(chunk.choices?.some(c=>c.delta?.content||c.delta?.reasoning_content||c.delta?.reasoning||c.delta?.tool_calls?.length)){semanticProgress=true;progress();}bytes+=Buffer.byteLength(JSON.stringify(chunk),'utf8');if(bytes>32*1048576)throw new AppError('Relay response exceeds 32 MiB',502,'response_too_large');pending.push(chunk);for(const c of chunk.choices??[]){content||=typeof c.delta?.content==='string'&&!!c.delta.content.trim();tools||=!!c.delta?.tool_calls?.length;const thought=typeof c.delta?.reasoning_content==='string'?c.delta.reasoning_content:typeof c.delta?.reasoning==='string'?c.delta.reasoning:'';reasoning||=!!thought.trim();if(typeof c.finish_reason==='string'&&c.finish_reason)finish=c.finish_reason;}}}finally{if(targetSignal?.aborted&&response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}})());if(!content&&!tools){if(reasoning&&finish==='length')throw new AppError('同型号供应只返回了推理、正文为空（finish='+(finish??'unknown')+'）：推理已占满本次输出预算，提高 max_tokens 或降低推理档位后重试',400,'reasoning_budget_exhausted');throw new AppError('Same-model provider returned no answer or tool call',502,'empty_response');}onTarget?.(target,i);if(!route.accountPool?.enabled||target.accountId&&route.accountPool.accountIds.includes(target.accountId))this.pool.success(route,target,{expectedVersion:selectionVersion});if(!route.accountPool?.enabled||this.pool.version(route)===selectionVersion)this.relay.success(route,target,{requestId,trigger:usage.row.relay.trigger,from:previousTarget});started=true;for(const chunk of pending)yield chunk;}
        else for await(const chunk of normalizeChat(result.response,{model:route.id,recovery:result.recovery})){usage.chunk(chunk);if(!started){onTarget?.(target,i);if(!route.accountPool?.enabled||target.accountId&&route.accountPool.accountIds.includes(target.accountId))this.pool.success(route,target,{expectedVersion:selectionVersion});started=true;}yield chunk;}
        if(recoveryCircuits.has(targetKey(target)))this.relay.clearRateLimit(target,recoveryCircuits.get(targetKey(target)).until);
        completed=true;requestCompleted=true;this.controls?.success(route,target,{clientId,sessionId});
        return;
      }catch(e){
        if(signal?.aborted)e=interrupted(signal);else if(targetExpired)e=timeoutError;failure=e;last=e;
        skipped=!usage.row.dispatched&&(['control_target_ineligible','client_credit_budget_exceeded'].includes(e.code)||relayActive&&['relay_capacity_incompatible','relay_context_incompatible','tools_not_supported','images_not_supported','reasoning_effort_not_supported','reasoning_parameter_not_supported','wb_inference_disabled'].includes(e.code));
        if(skipped)usage.row.candidatePlan={...usage.row.candidatePlan,state:'skipped',reasonCode:e.code};
        plan.failure(e,target,{skipped});
        const depleted=!blockedByCircuit&&!signal?.aborted&&!isContextWindowError(e)&&this.pool.exhausted(route,target,e),poolModelAbsent=route.accountPool?.enabled&&e.code==='model_not_found',relayReason=signal?.aborted||['control_target_ineligible','client_credit_budget_exceeded'].includes(e.code)?null:blockedByCircuit?(e.status===429?'rate_limited':null):this.relay.failure(route,target,e,{source});
        if(relayReason&&relayReason!=='capability_unavailable'){lastSupplierFailure=e;firstSupplierFailure??=e;}
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
        if(!started&&!signal?.aborted&&i===targets.length-1&&relayReason==='capability_unavailable'&&(firstSupplierFailure??plan.fallbackRoot)){
          const unavailable=supplierTerminal(firstSupplierFailure??plan.fallbackRoot);
          const blocked=targets.map(t=>this.relay.cooldown(t)).filter(Boolean);
          if(unavailable.retryAfterSeconds===undefined&&blocked.length)unavailable.retryAfterSeconds=Math.max(1,Math.ceil((Math.min(...blocked.map(r=>r.until))-Date.now())/1000));
          throw unavailable;
        }
        // Internal candidate incompatibility is a local eligibility skip, not a
        // malformed caller request. No target may rewrite the submitted budget.
        if(!started&&!signal?.aborted&&i===targets.length-1&&relayReason==='capability_unavailable'&&skipped){
          // Say which number is out of range. The error code and status stay the
          // documented pair (503 same_model_unavailable); only the message gains
          // the one actionable fact the caller needs to unblock itself.
          const gap=plan.capacityGap;
          throw new AppError(gap
            ?gap.requested>plan.contract.outputBudget
              ?`当前同型号供应均未确认支持本次完整请求；最低回复预算调整后的派发预算 ${gap.requested} 超过同类供应可承诺的上限 ${gap.capacity}，需支持该预算的同型号供应；历史、工具与调用者预算均未被裁剪`
              :`当前同型号供应均未确认支持本次完整请求；请求的输出预算 ${gap.requested} 超过同类供应可承诺的上限 ${gap.capacity}，请把 max_tokens / max_completion_tokens 降到 ${gap.capacity} 以内重试；历史、工具与输出预算均未被裁剪`
            :'当前同型号供应均未确认支持本次完整请求；历史、工具和输出预算均已保留',503,'same_model_unavailable');
        }
        if(started||signal?.aborted||i===targets.length-1||(!relayReason&&!depleted&&!poolModelAbsent&&e.code!=='wb_inference_disabled'&&!(route.fallbackStatuses??[408,429,500,502,503,504]).includes(e.status??502)))throw e;
        previousTarget=target;relayTrigger=relayReason??'upstream_unavailable';
      }
      finally{clearTimeout(targetTimer);if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});usage.row.requestOutcome=plan.summary(completed?'completed':'ongoing');usage.finish(completed?'completed':skipped?'skipped':signal?.aborted&&signal.reason?.name!=='TimeoutError'||!failure?'cancelled':'failed',failure);controlLease?.observe(usage.finishedRow);}
    }
    throw last??new AppError('Route has no targets',503,'no_upstream');
    }catch(error){plan??=new RequestPlan({model:null,messages:[]},this.config.value??{});requestError=plan.attach(error);throw requestError;}
    finally{
      const state=requestCompleted?'completed':requestError?.code==='request_cancelled'?'cancelled':requestError?'failed':'cancelled';
      if(!latestUsage&&requestError){
        // A request can fail before an upstream candidate exists (all disabled,
        // credit exhausted, cooldown, invalid route or preparation failure).
        // Count its final outcome, never a fictional supplier attempt or token.
        const terminalRequest={...(request??{messages:[]}),model:plan.contract.clientModelId??''};
        latestUsage=new UsageAttempt(this.ledger,this.config.value??{},terminalRequest,{upstreamId:'',model:''},{requestId,attempt:0,source,requestContext});
        Object.assign(latestUsage.row,{rowType:'request_outcome',platform:'gateway',upstreamId:'',accountId:'',accountLabel:'',startedAt:new Date(requestStarted).toISOString(),requestContract:plan.contract,requestOutcome:plan.summary(state)});
        latestUsage.clock-=Math.max(0,Date.now()-requestStarted);latestUsage.finish(state==='cancelled'?'cancelled':'failed',requestError);
      }
      latestUsage?.finalizeRequest(plan.summary(state),requestError?.relayFailure);
      if(latestUsage?.finishedRow)controlLease?.observe(latestUsage.finishedRow);
    }
  }
}
