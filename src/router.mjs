import {AppError} from './util.mjs';
import {normalizeChat,validateChat} from './openai.mjs';
import {WorkBuddyPool} from './workbuddy-pool.mjs';
import {UsageAttempt} from './usage.mjs';
import {randomUUID} from 'node:crypto';
export class Router {
  constructor(config,platforms,{ledger}={}){Object.assign(this,{config,platforms,ledger});this.pool=new WorkBuddyPool(config,ledger);}
  async routeInfo(route) {
    const targets=this.pool.candidates(route,{ignoreCooldown:true}).filter(t=>this.config.value.upstreams.some(u=>u.id===t.upstreamId&&u.enabled!==false));
    if(!targets.length)return undefined;
    const metadata=await Promise.all(targets.map(async t=>{const catalog=await this.platforms.models(t.upstreamId).catch(()=>[]);return catalog.find(m=>m.id===t.model)}));
    const selected=route.accountPool?.enabled?metadata.findIndex(m=>m&&m.callable!==false):0;
    if(selected<0||!metadata[selected])return undefined; // A configured id is not proof of a live model.
    const primary=metadata[selected];
    if(primary.callable===false)return undefined;
    const kind=this.config.value.upstreams.find(u=>u.id===targets[selected].upstreamId)?.kind;
    const efforts=kind==='trae'?primary.reasoningEfforts:kind==='workbuddy'?Object.fromEntries((primary.reasoning?.supportedEfforts??[]).map(k=>[k,k])):null;
    return {id:route.id,object:'model',created:0,owned_by:'ai-credit-gateway',name:route.name??primary.name??route.id,upstream:targets[selected].upstreamId,capabilities:{streaming:true,tools:primary.tools===true,multimodal:primary.multimodal===true},contextWindow:primary.contextWindow??32768,maxTokens:primary.maxTokens??4096,reasoning:primary.reasoning??null,reasoningEfforts:efforts??null};
  }
  async models(){const rows=await Promise.all(this.config.value.routes.filter(r=>r.enabled!==false).map(r=>this.routeInfo(r)));return {object:'list',data:rows.filter(Boolean)};}
  async * chat(raw,signal,{onTarget,source='api'}={}) {
    const request=validateChat(raw);const route=this.config.value.routes.find(r=>r.id===request.model&&r.enabled!==false);
    if(!route)throw new AppError(`Unknown route: ${request.model}`,404,'model_not_found');
    let last;const requestId=randomUUID();
    const targets=this.pool.candidates(route),selectionVersion=this.pool.version(route);
    if(!targets.length)throw new AppError('All WorkBuddy pool accounts are disabled or credits are cooling down',503,'account_pool_unavailable');
    for(let i=0;i<targets.length;i++) {
      const target=targets[i];let started=false,completed=false,failure;
      if(signal?.aborted)throw new AppError('Request cancelled',499,'request_cancelled');
      const usage=new UsageAttempt(this.ledger,this.config.value,request,target,{requestId,attempt:i+1,source});
      try {
        const catalog=await this.platforms.models(target.upstreamId,{signal});const model=catalog.find(m=>m.id===target.model);
        if(!model)throw new AppError(`Model absent from live catalog: ${target.model}`,404,'model_not_found');
        if(request.tools?.length&&request.tool_choice!=='none'&&model.tools!==true)throw new AppError('Target does not declare tools support',400,'tools_not_supported');
        const images=request.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
        if(images&&model.multimodal!==true)throw new AppError('Target does not declare image-input support',400,'images_not_supported');
        const result=await this.platforms.chat(target,request,signal);
        for await(const chunk of normalizeChat(result.response,{model:route.id,recovery:result.recovery})){usage.chunk(chunk);if(!started){onTarget?.(target,i);this.pool.success(route,target,{expectedVersion:selectionVersion});started=true;}yield chunk;}
        completed=true;
        return;
      }catch(e){failure=e;last=e;const depleted=this.pool.exhausted(route,target,e),poolModelAbsent=route.accountPool?.enabled&&e.code==='model_not_found';if(started||signal?.aborted||i===targets.length-1||(!depleted&&!poolModelAbsent&&!(route.fallbackStatuses??[408,429,500,502,503,504]).includes(e.status??502)))throw e;}
      finally{usage.finish(completed?'completed':signal?.aborted||!failure?'cancelled':'failed',failure);}
    }
    throw last??new AppError('Route has no targets',503,'no_upstream');
  }
}
