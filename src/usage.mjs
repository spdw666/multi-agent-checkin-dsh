// Store only usage counters and routing metadata: never prompts, tool arguments or credentials.
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {errorView} from './util.mjs';
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
export function usageCounters(u={}) {
  const promptTokens=number(u.prompt_tokens??u.input_tokens),completionTokens=number(u.completion_tokens??u.output_tokens);
  return {promptTokens,completionTokens,totalTokens:number(u.total_tokens)??(promptTokens!==null&&completionTokens!==null?promptTokens+completionTokens:null),cachedTokens:number(u.prompt_tokens_details?.cached_tokens??u.cache_read_input_tokens),reasoningTokens:number(u.completion_tokens_details?.reasoning_tokens),credits:number(u.credits_used??u.used_credits),cost:number(u.cost),costUnit:typeof u.currency==='string'&&/^[A-Z]{3}$/.test(u.currency)?u.currency:null};
}
export class UsageAttempt {
  constructor(ledger,config,request,target,{requestId=randomUUID(),attempt=1,source='api'}={}) {
    this.ledger=ledger;this.clock=performance.now();this.firstTokenMs=null;this.usage={};
    const upstream=(config.upstreams??[]).find(u=>u.id===target.upstreamId),account=config.accounts?.find(a=>a.id===upstream?.accountId);
    this.row={requestId,attempt,source,startedAt:new Date().toISOString(),routeId:request.model,model:target.model,upstreamId:target.upstreamId,accountId:upstream?.accountId??'',accountLabel:account?.label??account?.id??'',platform:upstream?.kind??'',stream:request.stream===true,hasTools:!!request.tools?.length,...usageCounters()};
    try{this.id=ledger?.beginUsage?.(this.row)}catch(e){console.error('usage_record_write_failed',e.code??'storage_error');}
  }
  chunk(chunk){if(this.firstTokenMs===null&&(chunk.choices??[]).some(c=>c.delta?.content||c.delta?.tool_calls?.length))this.firstTokenMs=Math.round(performance.now()-this.clock);if(chunk.usage)for(const [key,value] of Object.entries(usageCounters(chunk.usage)))if(value!==null)this.usage[key]=value;}
  finish(status,error){const row={...this.row,...this.usage,status,finishedAt:new Date().toISOString(),durationMs:Math.max(0,Math.round(performance.now()-this.clock)),firstTokenMs:this.firstTokenMs,chargeSource:this.usage.credits!=null||this.usage.cost!=null?'upstream_usage':'not_reported',...(error?{error:errorView(error)}:{})};try{if(this.id!==undefined)this.ledger.finishUsage(this.id,row)}catch(e){console.error('usage_record_write_failed',e.code??'storage_error');}}
}
