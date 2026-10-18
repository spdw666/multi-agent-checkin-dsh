import {AppError} from './util.mjs';
import {withConfigMutation} from './model-directory.mjs';

// Reorder exactly the existing targets. Editing a stale window must never
// overwrite a newly added account, route, target field or concurrent choice.
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const multiset=rows=>rows.map(canonical).sort();
export async function reorderRouteTargets(service,routeId,body){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['targets','expectedTargets'].includes(k))||!Array.isArray(body.targets)||!Array.isArray(body.expectedTargets)||body.targets.length<1||body.targets.length>500)throw new AppError('Expected an existing target permutation and the original target snapshot',400,'invalid_target_order');
  return withConfigMutation(service,async()=>{
    const snapshot=typeof service.config.snapshot==='function'?await service.config.snapshot():null;
    if(!snapshot&&typeof service.config.load==='function')await service.config.load();
    const current=snapshot?.value??service.config.value,route=current.routes.find(r=>r.id===routeId);
    if(!route)throw new AppError('Unknown route',404,'model_not_found');
    if(canonical(route.targets)!==canonical(body.expectedTargets))throw new AppError('Route targets changed; reload the current order before saving',409,'configuration_changed');
    if(canonical(multiset(route.targets))!==canonical(multiset(body.targets)))throw new AppError('Target order must preserve every existing target and field exactly',400,'invalid_target_order');
    const changed=canonical(route.targets)!==canonical(body.targets);
    if(changed){const next=structuredClone(current);next.routes.find(r=>r.id===routeId).targets=structuredClone(body.targets);await service.config.save(next,snapshot?{expectedSha256:snapshot.sha256}:{});}
    return {saved:true,routeId,changed,targets:structuredClone(body.targets)};
  });
}
