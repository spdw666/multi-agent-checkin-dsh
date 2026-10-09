import {zcodeBalance,zcodeHeaders} from './zcode.mjs';
import {AppError,hash} from './util.mjs';
import {anthropicBody,openaiResponse} from './anthropic.mjs';
import {buildStartPlanSystem,buildContextPrefixMessage} from '../vendor/zcode-context/system-prompt.mjs';
import {buildLlmIdentityHeaders,resolveEnvPromptInfo} from '../vendor/zcode-context/identity.mjs';
export function zcodeBody(request){const body=anthropicBody(request);body.system=buildStartPlanSystem(body.system,body.model,resolveEnvPromptInfo(),'zai');body.messages.unshift(buildContextPrefixMessage());return body;}
export async function zcodeModels(c,{fetchBalance=zcodeBalance,now=Date.now()}={}){
 const b=await fetchBalance(c);
 if(!b||!Array.isArray(b.balances))throw new AppError('ZCode 余额响应缺少 balances 数组，待复核服务端格式',502,'zcode_balance_schema');
 const active=b.balances.filter(b=>b.available_units>0&&(!b.expires_at||b.expires_at*1000>now));
 if(!active.length)throw new AppError('ZCode 当前账号没有未过期的可用模型额度；服务端未返回有效权益，需在客户端核对套餐与额度后复测',402,'zcode_no_active_entitlement');
 const models=[...new Set(active.flatMap(b=>b.capabilities??[]).filter(x=>typeof x==='string'&&x.startsWith('model:')&&x.length>6).map(x=>x.slice(6)))].map(id=>({id,name:id,tools:true,multimodal:false,transportVerified:id==='glm-5.3-flash'}));
 if(!models.length)throw new AppError('ZCode 有余额但权益未声明 model capability，待复核服务端模型权限',502,'zcode_model_capability_missing');
 return models;
}
export async function zcodeChat(c,request,signal,ledger){const key='proxy-block/zcode/'+hash(c.principal),block=ledger.get(key);if(block?.until>Date.now())throw new AppError('ZCode 上游 3012：异常活动拦截；冷却至 '+new Date(block.until).toISOString(),503,'zcode_upstream_blocked');const r=await fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',{method:'POST',headers:{...zcodeHeaders(c),...buildLlmIdentityHeaders({appVersion:'3.14.4',deviceMid:c.identity.deviceId}),'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify(zcodeBody(request)),signal,redirect:'error'});if(!r.ok){const d=await r.json().catch(()=>({}));if(d.code===3012){ledger.set(key,{until:Date.now()+900000,code:3012,http:r.status});throw new AppError('ZCode 上游返回 3012：'+d.msg,r.status,'zcode_upstream_blocked');}throw new AppError('ZCode model HTTP '+r.status,r.status,'zcode_model_error');}ledger.set(key,{until:0});return {response:openaiResponse(r)};}
