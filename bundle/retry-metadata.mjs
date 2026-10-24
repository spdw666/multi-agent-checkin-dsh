// The official pi-ai bridge currently retains only message/code on HTTP errors.
// Restore our own gateway's typed fields, never interpret another provider's text.
import {randomUUID,createHash} from 'node:crypto';
import {rateLimitMetadata} from '../src/rate-limit-metadata.mjs';
import {relayFailureMetadata,validGatewayRequestId} from '../src/client-contract.mjs';
const gatewayCodes=new Set(['zcode_upstream_blocked','provider_chat_rejected','provider_rate_limited','upstream_rate_limited','same_model_rate_limited','same_model_timeout','same_model_cooldown','same_model_unavailable','same_model_credits_exhausted','relay_context_incompatible','relay_attempt_timeout','request_timeout','request_deadline_exceeded','account_pool_unavailable']);
// The official AssistantStreamAccumulator deliberately JSON-detaches chunks.
// A bounded, random, locally minted label survives that copy; a private Symbol
// or WeakMap alone does not. No timers, request bodies or credentials are held.
const controls=new Map();
const fingerprint=f=>createHash('sha256').update(JSON.stringify([f.code,f.status,f.providerRetryAfterMs,f.message,f.gatewayCode,f.gatewayRequestId,f.relayFailure])).digest('hex');
function markFailure(failure){
  const now=Date.now();for(const [id,entry]of controls){if(entry.until<=now||controls.size>=2048)controls.delete(id);else break;}
  const marked={...failure,gatewayFailureId:'aigw-'+randomUUID()};controls.set(marked.gatewayFailureId,{until:now+300000,fingerprint:fingerprint(marked)});return marked;
}
const validStatus=n=>Number.isInteger(n)&&n>=400&&n<=599;

export function parseGatewayRetryMetadata(message){
  if(typeof message!=='string'||message.length>32768)return;
  let status;
  function visit(value,depth){
    if(depth>6)return;
    if(typeof value==='string'){
      const prefixed=value.match(/^\s*(?:Error:\s*)?(\d{3}):\s*([\s\S]+)$/);
      if(prefixed){const n=Number(prefixed[1]);if(validStatus(n))status??=n;value=prefixed[2];}
      try{return visit(JSON.parse(value),depth+1)}catch{return}
    }
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const owned=value.gatewayManagedRetry===true&&value.gatewayRetryOwner==='gateway'&&validGatewayRequestId(value.gatewayRequestId);
    if((gatewayCodes.has(value.code)||owned)&&(!value.type||value.type===value.code)){
      const relayFailure=relayFailureMetadata(value.relayFailure);
      const meta={gatewayCode:gatewayCodes.has(value.code)?value.code:'gateway_terminal_error',...validStatus(status)?{status}:{},...(owned?{gatewayManagedRetry:true,gatewayRetryOwner:'gateway',gatewayRequestId:value.gatewayRequestId}:{}),...(relayFailure?{relayFailure}:{})};
      // Share the server's numeric business-code whitelist and public schema.
      Object.assign(meta,rateLimitMetadata(value));
      if(meta.gatewayCode==='zcode_upstream_blocked'){
        meta.upstreamCode=3012;
        if(typeof value.upstreamRequestSent==='boolean')meta.upstreamRequestSent=value.upstreamRequestSent;
        if(Number.isInteger(value.upstreamStatus)&&value.upstreamStatus>=100&&value.upstreamStatus<=599)meta.upstreamStatus=value.upstreamStatus;
      }
      return meta;
    }
    for(const key of ['error','message','body']){const result=visit(value[key],depth+1);if(result)return result;}
  }
  return visit(message,0);
}

export function enrichGatewayFailure(failure,{ownedRelay=false,partial=false,aborted=false}={}){
  const meta=parseGatewayRetryMetadata(failure?.message);
  if(!meta)return failure&&typeof failure==='object'&&(ownedRelay||partial||aborted)?markFailure(failure):failure;
  const official=meta.retryAfterSource==='official_header'&&meta.retryAfterSeconds!==undefined;
  const transient=meta.rateLimitKind==='transient'&&meta.rateLimitRetryable===true&&official&&meta.retryAfterSeconds>0;
  // No untrusted upstream prose/body survives into durable client history.
  const message=[`${meta.status??failure.status??'HTTP'}: 网关请求失败（${meta.gatewayCode}）`,meta.gatewayCode==='zcode_upstream_blocked'?(meta.upstreamRequestSent===false?`本地冷却拦截，本次未请求官方；此前官方返回 3012；此转发请求被拒绝，不代表账号整体封禁；原生客户端正常时需核查转发兼容性及官方通道支持`:`ZCode 官方拒绝本次转发请求（3012），不代表账号整体封禁；原生客户端正常时需核查转发兼容性及官方通道支持；本次未自动重发`):null,meta.gatewayCode==='zcode_upstream_blocked'&&meta.retryAfterSeconds!==undefined?`本地冷却剩余 ${meta.retryAfterSeconds} 秒（不代表官方解封时间）`:null,meta.upstreamCode!==undefined?`上游代码 ${meta.upstreamCode}`:null,meta.rateLimitKind?`限流类别 ${meta.rateLimitKind}`:null,meta.relayFailure?.root?`主因 ${meta.relayFailure.root.platform??'upstream'}/${meta.relayFailure.root.code??'upstream_error'} HTTP ${meta.relayFailure.root.status??'unknown'}`:null,meta.relayFailure?`已发出 ${meta.relayFailure.attemptCount??0} 次；跳过 ${meta.relayFailure.skippedCount??0} 个不适用候选`:null,meta.gatewayRequestId?`请求 ${meta.gatewayRequestId}`:null,official?`官方等待 ${meta.retryAfterSeconds} 秒`:null].filter(Boolean).join('；');
  const enriched={...failure,...meta,message};
  // Zero is valid protocol metadata, but DSH's LlmFailure only admits positive ms.
  if(official&&meta.retryAfterSeconds>0)enriched.providerRetryAfterMs=meta.retryAfterSeconds*1000;
  // A local cooldown is not an official provider Retry-After instruction.
  const classified=meta.rateLimitKind!==undefined||meta.rateLimitRetryable!==undefined;
  const block=ownedRelay||meta.gatewayManagedRetry===true||partial||aborted||((meta.status??failure.status)===429&&!transient)||(classified&&!transient);
  return block?markFailure(enriched):enriched;
}

export function gatewayRetryRecovery(payload,next){
  if(payload.provider==='ai-credit'&&payload.failure&&typeof payload.failure==='object'){
    const entry=controls.get(payload.failure.gatewayFailureId);
    if(entry&&entry.until>Date.now()&&entry.fingerprint===fingerprint(payload.failure))return Promise.resolve(undefined);
  }
  return next();
}

export function registerGatewayRetryRecovery(ctx){
  // Cordis true == prepend: terminate the waterfall before llm-retry schedules
  // an additional whole gateway pool. effect owns listener disposal/HMR cleanup.
  return ctx.effect(()=>ctx.on('agent/request-error',gatewayRetryRecovery,true));
}

export function wrapGatewayRetryMetadata(adapter,{models,ownedGateway=false}){
  const stream=adapter.streamWithSnapshot;
  adapter.streamWithSnapshot=async function*(options,snapshot){
    const ownedRelay=ownedGateway||models().find(m=>m.id===options.model)?.modelRelay?.deliveryMode==='verified_request_buffer';
    let partial=false;
    for await(const chunk of stream.call(this,options,snapshot)){
      if(chunk.type==='finish'&&chunk.reason?.failure){
        const failure=enrichGatewayFailure(chunk.reason.failure,{ownedRelay,partial,aborted:options.signal?.aborted===true||chunk.reason.kind==='aborted'});
        yield failure===chunk.reason.failure?chunk:{...chunk,reason:{...chunk.reason,failure}};
      }else {
        if(['text-delta','reasoning-delta','tool-call-delta','block-start','block-end'].includes(chunk.type))partial=true;
        yield chunk;
      }
    }
  };
  return adapter;
}
