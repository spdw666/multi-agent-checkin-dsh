import {zcodeStandardProxy,zcodeStandardStream} from './zcode-standard-proxy.mjs';
import {zcodeBalance,zcodeHeaders} from './zcode.mjs';
import {AppError,hash} from './util.mjs';
import {anthropicBody,openaiResponse} from './anthropic.mjs';
import {buildStartPlanSystem,buildContextPrefixMessage} from '../vendor/zcode-context/system-prompt.mjs';
import {buildLlmIdentityHeaders,resolveEnvPromptInfo} from '../vendor/zcode-context/identity.mjs';
// Verified 2026-10-23 against the exact official model pages and the native
// ZCode builtin:zai-start-plan catalogue (limit.context=1000000/output=128000).
// Entitlements still come exclusively from the live balance response. Do not
// infer capacities for future model IDs, aliases or adjacent model families.
function zcodeModelMetadata(id){
 const page=id==='glm-5.3'?'https://docs.z.ai/guides/llm/glm-5.3':id==='glm-5.3-flash'?'https://docs.z.ai/guides/vlm/glm-5.3-flash':null;
 if(!page)return {};
 return {contextWindow:1000000,maxTokens:128000,officialMaxTokens:128000,defaultMaxTokens:128000,
  defaultMaxTokensSource:'official_docs_snapshot_2026-10-23',
  contextWindowSource:'official_docs_snapshot_2026-10-23',maxTokensSource:'official_docs_snapshot_2026-10-23',
  metadataSources:[page,'https://zcode.z.ai/cn/docs/welcome'],multimodal:id==='glm-5.3-flash',
  reasoning:{supportedEfforts:['low','high','max'],control:'thinking+effort',alwaysEnabled:true,canDisableThinking:false},
  reasoningEfforts:{low:'low',high:'high',max:'max'},
  reasoningSource:'https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/config/provider/zcode-builtin.json'};
}
export function zcodeBody(request){
 const body=anthropicBody(request),declared=zcodeModelMetadata(request.model).reasoning;
 // Public native Anthropic mapping, not the public OpenAI wire field. The
 // provider default is max; no undocumented levels or thinking-off alias.
 if(declared){
  const effort=request.reasoning_effort??'max';
  if(!declared.supportedEfforts.includes(effort)||request.thinking?.type==='disabled')throw new AppError('ZCode 该型号仅支持 low / high / max，且要求开启思考',400,'reasoning_effort_not_supported');
  body.thinking={type:'enabled'};body.output_config={effort};
 }
 body.system=buildStartPlanSystem(body.system,body.model,resolveEnvPromptInfo(),'zai');body.messages.unshift(buildContextPrefixMessage());return body;
}
export async function zcodeModels(c,{fetchBalance=zcodeBalance,now=Date.now()}={}){
 const b=await fetchBalance(c);
 if(!b||!Array.isArray(b.balances))throw new AppError('ZCode 余额响应缺少 balances 数组，待复核服务端格式',502,'zcode_balance_schema');
 const active=b.balances.filter(b=>b.available_units>0&&(!b.expires_at||b.expires_at*1000>now));
 if(!active.length)throw new AppError('ZCode 当前账号没有未过期的可用模型额度；服务端未返回有效权益，需在客户端核对套餐与额度后复测',402,'zcode_no_active_entitlement');
 const models=[...new Set(active.flatMap(b=>b.capabilities??[]).filter(x=>typeof x==='string'&&x.startsWith('model:')&&x.length>6).map(x=>x.slice(6)))].map(id=>({id,name:id,tools:true,multimodal:false,transportVerified:['glm-5.3-flash','glm-5.3'].includes(id),...zcodeModelMetadata(id)}));
 if(!models.length)throw new AppError('ZCode 有余额但权益未声明 model capability，待复核服务端模型权限',502,'zcode_model_capability_missing');
 return models;
}
// This request-channel denial is not proof of a globally banned account.
// Keep the official status; never replay through another account or expose text.
function zcodeBlocked(block,now,source='official_response'){
 const error=new AppError((source==='local_cooldown'?'ZCode 本地冷却拦截，本次未请求官方；此前官方返回 3012':'ZCode 官方本次返回 3012')+'（异常活动拦截，原 HTTP '+block.http+'）；此转发请求被拒绝，不代表账号整体封禁；原生客户端正常时需核查转发兼容性及官方通道支持。本次不自动重发；本地冷却至 '+new Date(block.until).toISOString(),503,'zcode_upstream_blocked');
 return Object.assign(error,{upstreamRequestSent:source==='official_response',upstreamStatus:block.http,upstreamCode:3012,retryable:false,actionRequired:true,retryAfterSeconds:Math.max(0,Math.ceil((block.until-now)/1000)),retryAfterSource:'local_default'});
}
export async function zcodeChat(c,request,signal,ledger){
 const key='proxy-block/zcode/'+hash(c.principal),now=Date.now(),block=ledger.get(key);
 if(block?.until>now)throw zcodeBlocked({...block,http:Number.isInteger(block.http)?block.http:405},now,'local_cooldown');
 const standard=await zcodeStandardProxy(c,request,signal);
 if(standard){
  const {response,upstreamStatus,upstreamCode}=standard;
  const businessError=(code,http)=>{if(code===3012){const observed=Date.now(),next={until:observed+900000,code:3012,http};ledger.set(key,next);return zcodeBlocked(next,observed);}return Object.assign(new AppError('ZCode standard proxy upstream business error',502,'upstream_business_error'),{upstreamCode:code,upstreamStatus:http});};
  if(upstreamCode===3012){await response.body?.cancel();throw businessError(3012,upstreamStatus);}
  if(!response.ok){await response.body?.cancel();throw Object.assign(new AppError('ZCode standard proxy HTTP '+upstreamStatus,upstreamStatus,'zcode_model_error'),{upstreamStatus});}
  ledger.set(key,{until:0});return {response:zcodeStandardStream(response,businessError)};
 }

 const r=await fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',{method:'POST',headers:{...zcodeHeaders(c),...buildLlmIdentityHeaders({appVersion:'3.17.1',deviceMid:c.identity.deviceId}),'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify(zcodeBody(request)),signal,redirect:'error'});
 if(!r.ok){
  const d=await r.json().catch(()=>({}));
  if(d?.code===3012||d?.code==='3012'){
   const observed=Date.now(),next={until:observed+900000,code:3012,http:r.status};ledger.set(key,next);throw zcodeBlocked(next,observed);
  }
  throw new AppError('ZCode model HTTP '+r.status,r.status,'zcode_model_error');
 }
 ledger.set(key,{until:0});return {response:openaiResponse(r,{mapError:error=>{
  // A business error may arrive after HTTP200. Preserve its code and suppress
  // replay exactly as for an initial HTTP error; HTTP200 is not generation.
  if(Number(error.upstreamCode)===3012){const observed=Date.now(),next={until:observed+900000,code:3012,http:r.status};ledger.set(key,next);return zcodeBlocked(next,observed);}
  return error;
 }})};
}
