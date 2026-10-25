import {AppError,errorView,hash} from './util.mjs';
import {syncWorkBuddyPools} from './workbuddy-management.mjs';
export const platformNames={qoder:'Qoder',codebuddy:'CodeBuddy',workbuddyai:'WorkBuddy AI',cline:'Cline',codearts:'CodeArts Agent',lobster:'LobsterAI',raccoon:'商汤小浣熊',loomy:'Loomy',opencode:'OpenCode Zen'};
export function importedRouteId(upstreamId,modelId){
 const raw=upstreamId+'/'+modelId;
 if(/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/.test(raw)&&!raw.includes('..'))return raw;
 // Public model IDs may contain ':free', Unicode or exceed the local identifier limit.
 // Preserve the exact target; encode only the local route identifier with a stable suffix.
 return raw.replace(/[^a-zA-Z0-9_./-]/g,'_').replace(/\.{2,}/g,'_').slice(0,115)+'-'+hash(raw).slice(0,12);
}
export async function modelDirectory(service,{refresh=false}={}) {
  const audit=service.ledger?.get?.('model-audit');
  const value=structuredClone(service.config.value),targets=new Map();
  for(const route of value.routes.filter(r=>r.enabled!==false))for(const target of route.targets){
    if(!targets.has(target.upstreamId))targets.set(target.upstreamId,new Map());
    const models=targets.get(target.upstreamId);if(!models.has(target.model))models.set(target.model,new Set());
    models.get(target.model).add(route.id);
  }
  const providers=await Promise.all(value.upstreams.filter(u=>u.enabled!==false||targets.has(u.id)).map(async u=>{
    const configured=targets.get(u.id)??new Map();let catalog=[],error;
    if(u.enabled!==false)try{catalog=await service.platforms.models(u.id,{refresh});}catch(e){error=errorView(e);}
    const models=catalog.map(m=>{
      const tested=audit?.results?.find(r=>r.upstreamId===u.id&&r.model===m.id);
      const chatVerified=tested?.status==='partial'&&tested.capabilityStatus==='chat_only'&&
        ['ordinary','stream'].every(stage=>tested.tests?.some(t=>t.stage===stage&&t.ok===true));
      return {...m,...(chatVerified?{status:'chat_verified'}:{}),audit:tested,imported:configured.has(m.id),importedRouteIds:[...(configured.get(m.id)??[])]};
    });
    for(const [id,ids]of configured)if(!catalog.some(m=>m.id===id))models.push({id,name:id,source:'configured_route',catalogStatus:u.enabled===false?'upstream_disabled':error?'unavailable':'missing',callable:false,importable:false,imported:true,importedRouteIds:[...ids],unavailableReason:u.enabled===false?'上游已停用；仅保留配置，可取消导入':error?'实时目录获取失败；仅保留配置，可取消导入':'实时目录未提供此模型；仅保留配置，可取消导入'});
    return {...u,models,...(error?{error}:{})};
  }));
  let published=null,publishedError;try{published=(await service.router.models()).data.length;}catch(e){publishedError=errorView(e);}
  return {providers,count:providers.reduce((n,p)=>n+p.models.length,0),published,...(publishedError?{publishedError}:{})};
}
// Short, per-store commit queue. Remote discovery must happen before acquiring this lock.
const mutations=new WeakMap();
export function withConfigMutation(service,operation){
  const key=service.config,previous=mutations.get(key)??Promise.resolve();
  const running=previous.catch(()=>{}).then(operation);mutations.set(key,running);
  const cleanup=()=>{if(mutations.get(key)===running)mutations.delete(key);};running.then(cleanup,cleanup);
  return running;
}
export async function exportModels(service,routeIds){
  if(!Array.isArray(routeIds)||!routeIds.length||routeIds.length>500||routeIds.some(id=>typeof id!=='string'||!id.trim())||new Set(routeIds).size!==routeIds.length)throw new AppError('Select 1–500 unique route IDs',400,'invalid_selection');
  const selectedIds=[...routeIds];
  return withConfigMutation(service,async()=>{
    const value=structuredClone(service.config.value),selected=selectedIds.map(id=>value.routes.find(r=>r.id===id));
    if(selected.some(r=>!r))throw new AppError('Selected route does not exist',400,'invalid_route');
    const disabled=selected.filter(r=>r.enabled!==false).length;
    for(const route of selected)route.enabled=false;
    if(disabled)await service.config.save(value);
    return {saved:true,selected:selected.length,disabled,alreadyDisabled:selected.length-disabled,routeIds:selectedIds,disabledRouteIds:selectedIds};
  });
}
export async function importModels(service,items,{enabled=true}={}) {
  // The directory can contain thousands of entries. Keep one atomic commit for
  // a full filtered selection rather than partially saving 500-item UI chunks.
  if(!Array.isArray(items)||items.length>5000||!items.length)throw new AppError('Select 1–5000 models',400,'invalid_selection');
  const prepared=[];
  for(const item of structuredClone(items)){
    if(!item||typeof item.upstreamId!=='string'||typeof item.model!=='string'||!item.model)throw new AppError('Invalid model selection',400,'invalid_selection');
    const selected=typeof item.enabled==='boolean'?item.enabled:enabled;
    const u=service.config.value.upstreams.find(u=>u.id===item.upstreamId&&(!selected||u.enabled!==false));
    if(!u)throw new AppError('Unknown upstream',400,'invalid_upstream');
    if(!selected){
      const ids=item.importedRouteIds;
      if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length))throw new AppError('Invalid imported route IDs',400,'invalid_selection');
      prepared.push({item,selected,upstream:JSON.stringify(u),model:{id:item.model}});continue;
    }
    const upstream=JSON.stringify(u),routes=JSON.stringify(service.config.value.routes.filter(r=>r.targets.some(t=>t.upstreamId===u.id&&t.model===item.model))),model=(await service.platforms.models(u.id)).find(m=>m.id===item.model);
    if(!model)throw new AppError('Selected model absent from catalog',400,'invalid_model');
    if(model.callable===false||model.importable===false)throw new AppError(model.unavailableReason??'Model has no callable transport',400,'model_transport_unavailable');
    prepared.push({item,selected,upstream,model,routes});
  }
  return withConfigMutation(service,async()=>{
   const value=structuredClone(service.config.value),wbImportedRoutes=new Set();
   for(const {item,selected,upstream,model,routes}of prepared){
    const u=value.upstreams.find(u=>u.id===item.upstreamId);
    if(JSON.stringify(u)!==upstream)throw new AppError('Upstream changed during model discovery; reload and retry',409,'configuration_changed');
    if(selected&&JSON.stringify(service.config.value.routes.filter(r=>r.targets.some(t=>t.upstreamId===u.id&&t.model===item.model)))!==routes)throw new AppError('Selected routes changed during model discovery; reload and retry',409,'configuration_changed');
    if(!selected&&item.importedRouteIds){
      const matches=item.importedRouteIds.map(id=>value.routes.find(r=>r.id===id&&r.targets.some(t=>t.upstreamId===u.id&&t.model===item.model)));
      if(matches.some(r=>!r))throw new AppError('Imported route no longer targets the selected model',400,'invalid_route');
      for(const route of matches)route.enabled=false;
      continue;
    }
    const found=value.routes.find(r=>r.targets.length===1&&r.targets[0].upstreamId===u.id&&r.targets[0].model===model.id);
    if(found){found.enabled=selected;if(selected&&u.kind==='workbuddy')wbImportedRoutes.add(found.id);continue;}
    if(!selected)continue;
    const id=importedRouteId(u.id,model.id);if(value.routes.some(r=>r.id===id))throw new AppError('Route ID collision',409,'route_collision');
    value.routes.push({id,name:(platformNames[u.kind]??(u.kind==='trae'?'Trae CN':u.kind==='workbuddy'?'WorkBuddy':u.kind==='qwenwork'?'千问办公':u.kind==='zcode'?'ZCode':u.kind==='bigmodel'?'智谱 BigModel':u.kind==='antigravity'?'Antigravity':u.kind==='nvidia'?'NVIDIA 官方API':'MiniMax Code'))+' · '+model.name,enabled:true,targets:[{upstreamId:u.id,model:model.id}]});
    if(u.kind==='workbuddy')wbImportedRoutes.add(id);
  }
  if(wbImportedRoutes.size)syncWorkBuddyPools(value,{routeIds:wbImportedRoutes});
  await service.config.save(value);
  return {saved:true,selected:items.length,enabled};
  });
}
