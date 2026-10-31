// Per-request capability planning. No payload, model reply, tool ID or credential
// is retained here: catalogue snapshots live only for the current invocation.
import {AppError} from './util.mjs';
import {rateLimitMetadata} from './rate-limit-metadata.mjs';
import {transportFailureMetadata} from './transport-failure.mjs';

const positive=v=>Number.isSafeInteger(v)&&v>0?v:null;
const capability=v=>typeof v==='boolean'?v:null;
const code=v=>typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(v)&&!/(?:bearer|sk-|secret|token=)/i.test(v)?v:'upstream_error';
const platform=v=>typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,40}$/.test(v)?v:'unknown';
const status=v=>Number.isInteger(v)&&v>=400&&v<=599?v:502;
const routeId=v=>typeof v==='string'&&v.length<=160&&!/(?:https?:|[A-Za-z]:[\\/]|bearer|sk-[a-z0-9]{8}|token=)/i.test(v)?v:null;

export function outputCapacity(model={}){
  // A configured suggestion never proves an upstream output ceiling.
  return positive(model.maxTokensSource==='configured_default'?model.officialMaxTokens:model.maxTokens);
}
export function requestContract(request){
  const messages=request.messages??[],tools=request.tools??[],serializedBytes=Buffer.byteLength(JSON.stringify(request),'utf8');
  const maxTokens=positive(request.max_tokens),maxCompletionTokens=positive(request.max_completion_tokens),outputBudget=Math.max(maxTokens??0,maxCompletionTokens??0);
  return {schema:1,clientModelId:routeId(request.model),messageCount:messages.length,toolCount:tools.length,
    requiresTools:tools.length>0&&request.tool_choice!=='none',hasImages:messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')),
    hasToolHistory:messages.some(m=>m.role==='tool'||Array.isArray(m.tool_calls)&&m.tool_calls.length>0),
    serializedBytes,outputBudget,maxTokens,maxCompletionTokens,
    contextEstimate:{method:'utf8_bytes_plus_overhead',tokenCount:null,upperBound:serializedBytes+4096+128*messages.length+512*tools.length+outputBudget},
    evidence:'request_metadata_only'};
}

export function supplierTerminal(cause){
  const terminal=new AppError('同型号供应未完成本次请求（'+code(cause?.code)+'，'+(transportFailureMetadata(cause)||typeof cause?.upstreamResponseReceived==='boolean'?'网关状态 ':'HTTP ')+status(cause?.status)+'）；其余候选不支持本次完整请求，历史、工具和输出预算均已保留',status(cause?.status),code(cause?.code));
  Object.assign(terminal,rateLimitMetadata(cause));
  if(cause?.code==='workbuddy_channel_rejected')terminal.upstreamCode=11128;
  if(Number.isInteger(cause?.upstreamStatus)&&cause.upstreamStatus>=400&&cause.upstreamStatus<=599)terminal.upstreamStatus=cause.upstreamStatus;
  const transport=transportFailureMetadata(cause);if(transport)Object.assign(terminal,{networkPhase:transport.phase,transportCode:transport.code,timeoutOrigin:transport.timeoutOrigin});
  if(typeof cause?.upstreamResponseReceived==='boolean')terminal.upstreamResponseReceived=cause.upstreamResponseReceived;
  return terminal;
}

export class RequestPlan{
  constructor(request,config,catalogs=new Map()){
    this.contract=requestContract(request);this.config=config;this.catalogs=new Map(catalogs);
    this.candidateCount=0;this.skippedCount=0;this.attemptCount=0;this.dispatchCount=0;
    this.root=null;this.fallbackRoot=null;this.last=null;this.capacityGap=null;
  }
  platform(target){return platform(this.config.upstreams?.find(u=>u.id===target?.upstreamId)?.kind);}
  candidate(){this.candidateCount++;}
  dispatched(first){this.dispatchCount++;if(first)this.attemptCount++;}
  retractUnsentDispatch(){if(this.dispatchCount<1||this.attemptCount<1)return false;this.dispatchCount--;this.attemptCount--;return true;}
  seedBlocked(rows=[]){
    const row=rows.find(r=>Number.isInteger(r.status)&&(r.errorCode||r.reasonCode));if(row)this.fallbackRoot={code:code(row.errorCode??row.reasonCode),status:status(row.status),platform:this.platform(row.target)};
  }
  inspect(model,sourceModel,{relay=false}={}){
    const c=this.contract,capabilities={tools:capability(model.tools),multimodal:capability(model.multimodal),contextWindow:positive(model.contextWindow),outputCapacity:outputCapacity(model)};
    const result={state:Object.values(capabilities).some(v=>v===null)?'unknown':'eligible',capabilities};
    let reasonCode,message,errorStatus=400;
    if(relay&&capabilities.contextWindow!==null&&positive(sourceModel?.contextWindow)!==null&&capabilities.contextWindow<sourceModel.contextWindow&&(c.hasImages||c.contextEstimate.upperBound>capabilities.contextWindow)){
      // This is a conservative sufficient-fit bound, never an exact tokenizer.
      // Failure to prove fit skips this standby without trimming the request.
      reasonCode='relay_context_incompatible';errorStatus=503;message='当前同型号备用尚未确认可完整承接本次长上下文；原始历史、工具和输出预算已保留，等待原供应恢复';
    // Keep the existing non-relay conservative capability gate. Relay planning
    // treats omitted metadata as unknown, not a fabricated unsupported claim.
    }else if(c.requiresTools&&(model.tools===false||!relay&&model.tools!==true)){reasonCode='tools_not_supported';message='Target does not declare tools support';}
    else if(c.hasImages&&(model.multimodal===false||!relay&&model.multimodal!==true)){reasonCode='images_not_supported';message='Target does not declare image-input support';}
    else if(relay&&capabilities.outputCapacity!==null&&c.outputBudget>capabilities.outputCapacity){
      // Record the widest ceiling any candidate offered: it is the one number that
      // tells the caller what to lower max_tokens to. Never shrink the request.
      if(this.capacityGap===null||capabilities.outputCapacity>this.capacityGap.capacity)this.capacityGap={requested:c.outputBudget,capacity:capabilities.outputCapacity};
      reasonCode='relay_capacity_incompatible';message='Same-model provider output capacity is below this request; history and output budget were not trimmed';
    }
    if(reasonCode)return {metadata:{...result,state:'skipped',reasonCode},error:new AppError(message,errorStatus,reasonCode)};
    return {metadata:result,error:null};
  }
  failure(error,target,{skipped=false}={}){
    const diagnosis={code:code(error?.code),status:status(error?.status),platform:this.platform(target)};
    this.last=diagnosis;
    if(skipped)this.skippedCount++;else if(!this.root)this.root=diagnosis;
  }
  summary(state='ongoing'){return {schema:1,state,candidateCount:this.candidateCount,skippedCount:this.skippedCount,attemptCount:this.attemptCount,dispatchCount:this.dispatchCount};}
  attach(error){
    const last=this.last??{code:code(error?.code),status:status(error?.status),platform:'unknown'},root=this.root??this.fallbackRoot??last;
    error.relayFailure={root:{...root},last:{code:last.code,status:last.status},skippedCount:this.skippedCount,attemptCount:this.attemptCount,...(this.capacityGap?{capacityGap:{...this.capacityGap}}:{})};
    return error;
  }
}
