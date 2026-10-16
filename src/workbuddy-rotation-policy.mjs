// Independent gateway policy; CLI urgency rules reviewed against MIT
// changexbc/workbuddy-switch 22b318c1f44b335c2222e444abcc2d0f74e160f7.
import {AppError} from './util.mjs';
export const workBuddyRotationDefaults=Object.freeze({enabled:false,target:'gateway',strategy:'expiry',intervalMinutes:5,cooldownMinutes:120,minUrgencyHours:72,minRemainingCredits:0,minGapHours:6,edition:'cn'});
const limits={intervalMinutes:[1,1440],cooldownMinutes:[0,10080],minUrgencyHours:[0,8760],minRemainingCredits:[0,1000000],minGapHours:[0,8760]};
export function validateWorkBuddyRotation(value,{partial=false}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(workBuddyRotationDefaults,k)))throw new AppError('轮换设置字段无效',400,'invalid_wb_rotation');
  const v=partial?value:{...workBuddyRotationDefaults,...value};
  if('enabled'in v&&typeof v.enabled!=='boolean'||'target'in v&&!['gateway','codebuddy-cli','both'].includes(v.target)||'strategy'in v&&!['expiry','round_robin'].includes(v.strategy)||'edition'in v&&!['cn','ai'].includes(v.edition))throw new AppError('轮换开关、目标、策略或版本无效',400,'invalid_wb_rotation');
  for(const [k,[min,max]]of Object.entries(limits))if(k in v&&(!Number.isFinite(v[k])||v[k]<min||v[k]>max||k!=='minRemainingCredits'&&!Number.isInteger(v[k])))throw new AppError('轮换数值超出有效范围',400,'invalid_wb_rotation');
  return v;
}
export const workBuddyRotationSettings=service=>validateWorkBuddyRotation(service.config.value.workbuddy?.rotation??{});
export function chooseWorkBuddyRotation(candidates,currentId,settings,{now=Date.now(),lastRotatedAt=0}={}) {
  if(!candidates.length)return {status:'skipped',reason:'no_eligible_account'};
  if(now-lastRotatedAt<settings.cooldownMinutes*60000)return {status:'skipped',reason:'cooldown'};
  let target;
  if(settings.strategy==='round_robin'){
    const at=candidates.findIndex(a=>a.accountId===currentId);target=candidates[(at+1)%candidates.length];
  }else{
    const finite=candidates.filter(a=>Number.isFinite(a.nearestExpiryMs)&&a.nearestExpiryMs>now).sort((a,b)=>a.nearestExpiryMs-b.nearestExpiryMs||a.accountId.localeCompare(b.accountId));
    target=finite[0];if(!target)return {status:'skipped',reason:'expiry_unknown'};
    if(target.nearestExpiryMs-now>settings.minUrgencyHours*3600000)return {status:'skipped',reason:'not_urgent'};
    const current=finite.find(a=>a.accountId===currentId);
    if(current&&current.accountId!==target.accountId&&current.nearestExpiryMs-target.nearestExpiryMs<settings.minGapHours*3600000)return {status:'skipped',reason:'gap_too_small'};
  }
  if(target.accountId===currentId)return {status:'skipped',reason:'already_preferred',accountId:target.accountId};
  return {status:'planned',accountId:target.accountId,remaining:target.remaining,nearestExpiryMs:target.nearestExpiryMs};
}
