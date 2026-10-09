import {AppError,errorView,rememberSecret,redact} from './util.mjs';
const API='https://open.bigmodel.cn/api/paas/v4';
const BIZ='https://open.bigmodel.cn/api/biz';
export function bigModelCredential(raw,accountId){
  const accessToken=typeof raw.apiKey==='string'?raw.apiKey.trim():'';
  if(!accessToken)throw new AppError('请在本机智谱配置文件填写 apiKey',401,'bigmodel_key_missing');
  for(const k of ['apiKey','consoleAuthorization','consoleCookie'])rememberSecret(raw[k]);
  // API keys do not expose a verified user id. Bind the configured key owner explicitly.
  return {accessToken,principal:'bigmodel:'+accountId,consoleAuthorization:raw.consoleAuthorization??'',consoleCookie:raw.consoleCookie??'',source:'official-api-key'};
}
async function request(url,c,{body,signal,consoleAuth=false,fetcher=fetch}={}){
  const authorization=consoleAuth?c.consoleAuthorization:`Bearer ${c.accessToken}`;
  const response=await fetcher(url,{method:body?'POST':'GET',redirect:'error',headers:{Accept:'application/json',...(authorization?{Authorization:authorization}:{}),...(consoleAuth&&c.consoleCookie?{Cookie:c.consoleCookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:signal??AbortSignal.timeout(15000)});
  if(!response.ok){let d={};try{d=await response.json()}catch{}throw new AppError('智谱 HTTP '+response.status+': '+redact(d.error?.message??d.msg??'请求被拒绝'),response.status,'bigmodel_http_error');}
  return response;
}
async function json(url,c,options){const d=await (await request(url,c,options)).json();if(d.code!==undefined&&Number(d.code)!==200&&Number(d.code)!==0)throw new AppError('智谱业务 '+d.code+': '+redact(d.msg??'请求被拒绝'),Number(d.code)===401?401:502,'bigmodel_business_error');return d;}
export async function bigModelModels(c,options){
  const d=await json(API+'/models',c,options);if(!Array.isArray(d.data))throw new AppError('智谱模型目录格式变化',502,'bigmodel_catalog_schema');
  // Official /models omits this vision model despite successful real chat/tool probes.
  const rows=d.data.filter(m=>typeof m.id==='string');if(!rows.some(m=>m.id==='glm-4.6v'))rows.push({id:'glm-4.6v',source:'live-verified-supplement'});
  return rows.map(m=>{const chat=/^glm-(?:4|5)/i.test(m.id)&&!/(?:voice|image|video|embedding)/i.test(m.id);return {...m,name:m.id,tools:chat,multimodal:/^glm-4\.(?:6|5)v(?:$|-)|^glm-5\.3-flash$/i.test(m.id),callable:chat,...(!chat?{unavailableReason:'当前仅适配聊天模型；其他任务不发布到聊天接口'}:{})};});
}
export function normalizePackage(p){
  const value=Number(p.availableBalance);if(!Number.isFinite(value))throw new AppError('智谱资源包缺少可用余额',502,'bigmodel_package_schema');
  return {name:p.resourcePackageName??'资源包',value,total:p.tokenBalance,unit:p.consumeType==='TIMES'?'次':p.consumeType==='TOKENS'?'Token':String(p.consumeType??'未知单位'),scope:p.suitableScene??'',status:p.displayStatusDesc??p.displayStatus??'',expiresAt:p.packageExpirationTime??null};
}
export async function bigModelPackages(c,{fetcher=fetch,signal}={}){
  if(!c.consoleAuthorization&&!c.consoleCookie)throw new AppError('资源包需要智谱控制台登录态；API Key 已可用于模型调用和现金余额',401,'bigmodel_console_login_required');
  const rows=[];for(let pageNum=1;pageNum<=50;pageNum++){
    const d=await json(BIZ+'/tokenAccounts/list/my?pageNum='+pageNum+'&pageSize=100&filterEnabled=false',c,{fetcher,signal,consoleAuth:true});
    if(!Array.isArray(d.rows))throw new AppError('智谱资源包响应格式变化',502,'bigmodel_package_schema');
    rows.push(...d.rows.map(normalizePackage));if(d.rows.length<100||rows.length>=Number(d.total))return rows;
  }throw new AppError('资源包分页超过查询上限',502,'bigmodel_package_limit');
}
export async function bigModelHealth(c,options={}){
  const [cash,packages]=await Promise.allSettled([json(BIZ+'/account/query-customer-account-report',c,options),bigModelPackages(c,options)]);
  if(cash.status==='rejected'&&packages.status==='rejected')throw cash.reason;
  return {status:'authenticated',cash:cash.status==='fulfilled'?cash.value.data:null,cashError:cash.status==='rejected'?errorView(cash.reason):null,packages:packages.status==='fulfilled'?packages.value:[],packagesError:packages.status==='rejected'?errorView(packages.reason):null};
}
export async function bigModelChat(c,input,signal,{fetcher=fetch}={}){
  const body={};for(const k of ['model','messages','stream','tools','tool_choice','max_tokens','temperature','top_p','stop','thinking'])if(input[k]!==undefined)body[k]=input[k];
  if(input.reasoning_effort!==undefined){if(!['none','off','on'].includes(input.reasoning_effort))throw new AppError('智谱支持思考开关，不声明任意推理强度',400,'reasoning_effort_not_supported');body.thinking={type:['none','off'].includes(input.reasoning_effort)?'disabled':'enabled'};}
  return {response:await request(API+'/chat/completions',c,{body,signal,fetcher})};
}
