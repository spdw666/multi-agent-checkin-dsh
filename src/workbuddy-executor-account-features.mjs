// Genuine account feature operations, checked against installed WorkBuddy 5.8.2
// CloudAppearanceRepo/mapSelectionDTO and the official Buddy application entry.
// This module never calls growth telemetry or claims rewards.
import {rememberSecret} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';

const base='https://www.workbuddy.cn';
const hpTheme='theme-tkmw7j';
const domains=new Set(['www.workbuddy.cn','workbuddy.cn','www.codebuddy.cn','codebuddy.cn','copilot.tencent.com']);
const key=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)?value:null;
const result=(status,reason,operationId,evidence={},completedActions=0)=>({status,reason,operationId,completedActions,evidence});
const validSelection=(item,resource)=>item?.kind==='theme'&&item.resource_key===resource&&typeof item.updated_at==='string'&&Number.isFinite(Date.parse(item.updated_at));
function datesPermit(resource,now){
  if(resource.validity_type!==undefined&&resource.validity_type!=='limited')return false;
  // Official validity fields are local date strings, interpreted by this module
  // in the Chinese product's timezone instead of an arbitrary UTC midnight.
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  for(const name of ['valid_from','valid_to'])if(resource[name]!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(resource[name])||!Number.isFinite(Date.parse(resource[name]))))return false;
  return !(resource.valid_from&&date<resource.valid_from||resource.valid_to&&date>resource.valid_to);
}
class AccountFeatureClient {
  constructor(credential,{fetchImpl,signal,check}){Object.assign(this,{credential,fetchImpl,signal,check});}
  async request(path,{body,host=base,raw=false}={}){
    this.check();this.signal?.throwIfAborted();const c=this.credential,timeout=new AbortController(),signal=this.signal?AbortSignal.any([this.signal,timeout.signal]):timeout.signal;
    const timer=setTimeout(()=>timeout.abort(new DOMException('Official feature request timed out','TimeoutError')),20000);timer.unref?.();
    try{
    const response=await this.fetchImpl(host+path,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+c.accessToken,'X-User-Id':String(c.uid??c.principal),'X-Domain':c.domain??'www.workbuddy.cn'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal,redirect:'error'});
    this.check();this.signal?.throwIfAborted();let envelope;try{envelope=await response.json();}catch{throw Error('official_feature_response_unconfirmed');}
    if(raw){if(!response.ok||!envelope||typeof envelope!=='object'||envelope.code!==undefined&&envelope.code!==0)throw Error('official_feature_request_unconfirmed');return envelope.code===0?envelope.data:envelope;}
    if(!response.ok||envelope?.code!==0||!envelope.data||typeof envelope.data!=='object')throw Error('official_feature_request_unconfirmed');
    return envelope.data;
    }finally{clearTimeout(timer);}
  }
}
async function appearance(api,{operationId,action,signal,check,markSubmitted,now}){
  const evidence={feature:'appearance',resourceVerified:false},resource=key(action.resourceKey??hpTheme);let submitted=false;
  if(!resource)return result('unsupported','official_theme_identity_required',operationId,evidence);
  // Hp_Appearance is the specific collaboration theme, not any random theme.
  if(action.taskCode==='Hp_Appearance'&&resource!==hpTheme)return result('unsupported','official_task_theme_mismatch',operationId,evidence);
  evidence.resourceKey=resource;
  try{
    const before=await api.request('/v2/user-asset/appearance/get');
    if(!Array.isArray(before.items))return result('deferred','appearance_selection_schema_unconfirmed',operationId,evidence);
    const current=before.items.find(item=>validSelection(item,resource));
    if(current)return result('completed','official_theme_selection_already_verified',operationId,{...evidence,resourceVerified:true,updatedAt:current.updated_at},0);
    if(action.submitted===true)return result('pending','previous_theme_submission_unconfirmed',operationId,evidence);
    const version=action.productVersion??'5.8.2';
    if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?$/.test(version))return result('unsupported','official_product_version_required',operationId,evidence);
    const catalog=await api.request('/v2/operation-platform/appearance/resources',{body:{platform:'client',kind:'theme',version,lang:'zh'}});
    if(!Array.isArray(catalog.resources))return result('deferred','appearance_catalog_schema_unconfirmed',operationId,evidence);
    const theme=catalog.resources.find(item=>item?.id===resource&&item.kind==='theme');
    if(!theme||!datesPermit(theme,now))return result('deferred','official_theme_unavailable_or_expired',operationId,evidence);
    if(theme.vip_level!=='free')return result('deferred','official_free_theme_not_confirmed',operationId,evidence);
    if(typeof markSubmitted!=='function')return result('deferred','submission_persistence_required',operationId,evidence);
    check();signal?.throwIfAborted();await markSubmitted({feature:'appearance',operationId,resourceKey:resource});check();signal?.throwIfAborted();submitted=true;
    const applied=await api.request('/v2/user-asset/appearance/set',{body:{kind:'theme',resource_key:resource}});
    if(!validSelection(applied,resource))return result('pending','theme_application_reply_unconfirmed',operationId,evidence);
    const after=await api.request('/v2/user-asset/appearance/get');
    const confirmed=Array.isArray(after.items)&&after.items.find(item=>validSelection(item,resource));
    if(!confirmed)return result('pending','theme_application_readback_unconfirmed',operationId,evidence);
    return result('completed','official_theme_applied_and_read_back',operationId,{...evidence,resourceVerified:true,updatedAt:confirmed.updated_at},1);
  }catch(error){check();signal?.throwIfAborted();if(error?.name==='AbortError')throw error;return result(submitted?'pending':'deferred',submitted?'theme_submission_unconfirmed':'official_theme_query_unconfirmed',operationId,evidence);}
}
async function buddyApplication(api,{operationId,action,check,signal}){
  const evidence={feature:'buddy_app',resourceVerified:false},applicationId=key(action.applicationId);
  if(!applicationId)return result('deferred','official_buddy_application_required',operationId,evidence);
  try{
    // This observes authorization only. A returned authorization code, consent
    // receipt, or asset usage report is deliberately not used as app execution.
    const state=await api.request('/workbuddyopen/v1/authorize/status?application_id='+encodeURIComponent(applicationId),{raw:true});
    if(typeof state.authorized!=='boolean'||state.application?.id!==applicationId)return result('deferred','buddy_application_status_schema_unconfirmed',operationId,evidence);
    return result('deferred',state.authorized?'official_buddy_app_runtime_required':'official_buddy_app_consent_required',operationId,{...evidence,applicationId,authorizationVerified:true,authorized:state.authorized});
  }catch(error){check();signal?.throwIfAborted();if(error?.name==='AbortError')throw error;return result('deferred','official_buddy_app_status_unconfirmed',operationId,evidence);}
}
export async function executeWorkBuddyAccountFeature({service,accountId,task,signal,check=()=>{},operationId,action={},markSubmitted,now=new Date()}={}){
  check();signal?.throwIfAborted();action=typeof action==='string'?{kind:action}:action??{};
  const kind=action.kind??task?.taskCode,isAppearance=['appearance','Hp_Appearance'].includes(kind),isBuddy=['buddy_app','Buddy_App','Buddy_App-00'].includes(kind);
  if(!isAppearance&&!isBuddy)return result('unsupported','official_account_feature_unavailable',operationId);
  if(typeof operationId!=='string'||!operationId)return result('unsupported','operation_identity_required',operationId);
  const account=service.config.value.accounts.find(item=>item.id===accountId&&item.platform==='workbuddy'&&item.enabled!==false);
  if(!account)return result('deferred','workbuddy_account_unavailable',operationId);
  const credential=await service.credentials.resolve(accountId);check();signal?.throwIfAborted();
  if(workBuddyEdition(credential)!=='cn')return result('unsupported','official_cn_feature_unavailable',operationId);
  if(!credential.accessToken||!domains.has(credential.domain??'www.workbuddy.cn'))return result('deferred','official_credential_domain_unconfirmed',operationId);
  rememberSecret(credential.accessToken);
  const api=new AccountFeatureClient(credential,{fetchImpl:service.workbuddyRuntime?.fetchImpl??fetch,signal,check});
  return isAppearance?appearance(api,{operationId,action:{...action,taskCode:task?.taskCode},signal,check,markSubmitted,now}):buddyApplication(api,{operationId,action,check,signal});
}
