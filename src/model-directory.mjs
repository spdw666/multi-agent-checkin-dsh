import {AppError,errorView} from './util.mjs';
export async function modelDirectory(service,{refresh=false}={}) {
  const audit=service.ledger?.get?.('model-audit');
  const providers=await Promise.all(service.config.value.upstreams.filter(u=>u.enabled!==false).map(async u=>{
    try {const models=await service.platforms.models(u.id,{refresh});return {...u,models:models.map(m=>({...m,audit:audit?.results?.find(r=>r.upstreamId===u.id&&r.model===m.id),imported:service.config.value.routes.some(r=>r.enabled!==false&&r.targets.some(t=>t.upstreamId===u.id&&t.model===m.id))}))};}
    catch(e){return {...u,models:[],error:errorView(e)};}
  }));
  return {providers,count:providers.reduce((n,p)=>n+p.models.length,0),published:(await service.router.models()).data.length};
}
export async function importModels(service,items,{enabled=true}={}) {
  if(!Array.isArray(items)||items.length>500||!items.length)throw new AppError('Select 1–500 models',400,'invalid_selection');
  const value=structuredClone(service.config.value);
  for(const item of items){
    const selected=typeof item.enabled==='boolean'?item.enabled:enabled;
    const u=value.upstreams.find(u=>u.id===item.upstreamId&&u.enabled!==false);
    if(!u)throw new AppError('Unknown enabled upstream',400,'invalid_upstream');
    const model=(await service.platforms.models(u.id)).find(m=>m.id===item.model);
    if(!model)throw new AppError('Selected model absent from catalog',400,'invalid_model');
    if(selected&&model.callable===false)throw new AppError(model.unavailableReason??'Model has no callable transport',400,'model_transport_unavailable');
    const found=value.routes.find(r=>r.targets.length===1&&r.targets[0].upstreamId===u.id&&r.targets[0].model===model.id);
    if(found){found.enabled=selected;continue;}
    if(!selected)continue;
    const id=u.id+'/'+model.id;if(value.routes.some(r=>r.id===id))throw new AppError('Route ID collision',409,'route_collision');
    value.routes.push({id,name:(u.kind==='trae'?'Trae CN':u.kind==='workbuddy'?'WorkBuddy':u.kind==='qwenwork'?'千问办公':u.kind==='zcode'?'ZCode':u.kind==='bigmodel'?'智谱 BigModel':'MiniMax Code')+' · '+model.name,enabled:true,targets:[{upstreamId:u.id,model:model.id}]});
  }
  await service.config.save(value);
  return {saved:true,selected:items.length,enabled};
}
