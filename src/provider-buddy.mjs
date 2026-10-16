import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createDecipheriv} from 'node:crypto';
import {dpapiUnprotect} from './windows-crypto.mjs';
import {runNativeHelper} from './credentials.mjs';
import {AppError,rememberSecret} from './util.mjs';
import {selectCliModels,prepareChatBody,declaredTools} from '../vendor/workbuddy-core.mjs';
import {providerFetch,providerJson} from './provider-http.mjs';
import {buddyChatRejection} from './provider-rate-limit.mjs';

function endpoints(c){const allowed=['www.workbuddy.ai','www.codebuddy.ai','www.codebuddy.cn','www.workbuddy.cn'];if(!allowed.includes(c.domain))throw new AppError('Buddy登录区域未识别',401,'provider_region_unknown');const global=c.domain.endsWith('.ai');return {global,billing:global?'https://'+c.domain:'https://www.codebuddy.cn',chat:global?'https://'+c.domain:'https://copilot.tencent.com'}}
export function normalizeBuddyCredential(raw,{expectedDomain,filePath,proxyUrl}={}){
  const accessToken=raw.auth?.accessToken??raw.accessToken??raw.token,uid=String(raw.account?.uid??raw.uid??raw.principal??''),domain=raw.auth?.domain??raw.domain;
  if(typeof accessToken!=='string'||!accessToken||!uid)throw new AppError('Buddy登录态待解密或已退出',401,'provider_login_required');rememberSecret(accessToken);
  if(expectedDomain&&domain!==expectedDomain)throw new AppError('Buddy登录区域与账号配置不符',401,'provider_region_mismatch');
  const c={accessToken,uid,principal:uid,domain,filePath,proxyUrl,source:'desktop',billingPlatform:domain.endsWith('.cn')?'workbuddy':domain,billingPrincipal:uid,expiresAtMs:raw.auth?.expiresAt??raw.expiresAt};endpoints(c);return c;
}
async function readCodeBuddy(file,edition,localState){
  const db=new DatabaseSync(file,{readOnly:true});let value;try{value=db.prepare('SELECT value FROM ItemTable WHERE key=?').get('secret://'+JSON.stringify({extensionId:'tencent-cloud.coding-copilot',key:'planning-genie.new.accessToken'+(edition==='cn'?'cn':'')}))?.value}finally{db.close()}
  if(!value)throw new AppError('CodeBuddy当前区域尚无登录态',401,'provider_login_required');
  const bytes=Buffer.from(JSON.parse(value).data??[]);if(!['v10','v11'].includes(bytes.subarray(0,3).toString()))throw new AppError('CodeBuddy凭据格式待核验',401,'provider_storage_format');
  const state=JSON.parse(await readFile(localState)),wrapped=Buffer.from(state.os_crypt?.encrypted_key??'','base64');if(wrapped.subarray(0,5).toString()!=='DPAPI')throw new AppError('CodeBuddy密钥封装格式待核验',401,'provider_storage_format');
  const key=await dpapiUnprotect(wrapped.subarray(5));let plain;
  try{const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(3,15));d.setAuthTag(bytes.subarray(-16));plain=Buffer.concat([d.update(bytes.subarray(15,-16)),d.final()]);return JSON.parse(plain.toString())}catch{throw new AppError('CodeBuddy本机登录态解密失败',401,'provider_decrypt_failed')}finally{key.fill(0);plain?.fill(0)}
}
async function readBuddyCredential(account,config={}){
  const ai=account.platform==='workbuddyai',edition=ai?'global':account.edition;
  if(!['cn','global'].includes(edition))throw new AppError('明确选择Buddy国内或国际账号',400,'provider_region_required');
  const domain=ai?'www.workbuddy.ai':edition==='cn'?'www.codebuddy.cn':'www.codebuddy.ai';const explicit=account.credentials?.file;
  const dir=join(process.env.APPDATA??join(homedir(),'AppData/Roaming'),'CodeBuddy'+(edition==='cn'?' CN':''));
  const file=explicit&&explicit!=='auto'?(config.path?config.path(explicit):explicit):ai?join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info'):join(dir,'User/globalStorage/state.vscdb');
  let raw;if(account.credentials?.kind==='file'||ai){raw=JSON.parse(await readFile(file));if(ai&&typeof raw.auth?.accessToken==='object'){raw.auth.accessToken=await runNativeHelper(account.credentials?.executable??'D:/WorkBuddyAI/WorkBuddyAI.exe',raw.auth.accessToken)}}else raw=await readCodeBuddy(file,edition,join(dir,'Local State'));
  return normalizeBuddyCredential(raw,{expectedDomain:domain,filePath:file,proxyUrl:account.credentials?.proxyUrl});
}
export async function resolveBuddyCredential(account,config={}){try{return await readBuddyCredential(account,config)}catch(e){if(e.code==='ENOENT'||e.code==='ERR_SQLITE_ERROR')throw new AppError('Buddy本机登录文件待就绪',401,'provider_login_required');throw e}}
function headers(c){return {Authorization:'Bearer '+c.accessToken,Accept:'application/json','Content-Type':'application/json','X-User-Id':c.uid,'X-Domain':c.domain,'X-Product':'SaaS','X-Requested-With':'XMLHttpRequest','User-Agent':endpoints(c).global?'WorkBuddy/5.5.2':'CLI/2.63.2 CodeBuddy/2.63.2'}}
async function api(c,path,body,options={},surface='billing'){const data=await providerJson(endpoints(c)[surface]+path,c,{...options,body,headers:headers(c)});if(data.code!==0){const e=new AppError(`Buddy业务接口返回 ${typeof data.code==='number'?data.code:'异常'}`,502,'provider_business_error');e.upstreamCode=data.code;throw e}return data.data}
export async function buddyModels(c,options={}){const data=await api(c,'/v3/config',undefined,options,'chat');return selectCliModels(data?.models,data?.agents).map(m=>({...m,tools:m.supportsToolCall===true,multimodal:m.supportsImages===true,callable:true,source:'buddy-official-config'}))}
export async function buddyStatus(c,task='daily-checkin',options={}){
  if(task!=='daily-checkin')throw new AppError('Buddy任务未登记',400,'provider_task_unknown');const r=await api(c,'/v2/billing/meter/checkin-activity-status',{},options);
  return {known:true,active:r.active===true,supportsCheckin:r.active===true,claimable:r.active===true&&r.today_checked_in!==true,claimed:r.today_checked_in===true,principal:c.principal,day:new Date(Date.now()+8*3600000).toISOString().slice(0,10),credits:typeof r.today_credit==='number'?r.today_credit:null,details:{streakDays:r.streak_days,dailyCredit:r.daily_credit,todayCredit:r.today_credit},source:'official_checkin_status',billingIdentity:endpoints(c).billing+':'+c.principal};
}
export async function buddyCredits(c,options={}){
  const data=await api(c,'/v2/billing/meter/get-user-resource',{PageNumber:1,PageSize:100,ProductCode:'p_tcaca',Status:[0,3],PackageEndTimeRangeBegin:new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19).replace('T',' '),PackageEndTimeRangeEnd:'2126-01-01 00:00:00'},options);
  const parseDate=x=>typeof x==='number'&&x>1e12?x:typeof x==='string'?Date.parse(x):NaN;const rows=data?.Response?.Data?.Accounts;if(!Array.isArray(rows))throw new AppError('Buddy资源包响应缺失',502,'provider_invalid_response');const packages=[];for(const a of rows){const monthly=a.CapacityType===4,remain=Math.max(0,Number(monthly?a.CycleCapacityRemain:a.CapacityRemain)||0),size=Number(monthly?a.CycleCapacitySize:a.CapacitySize)||0,expiry=parseDate(a.ExpiredTime??a.CycleEndTime);if(!monthly&&(!remain||Number.isFinite(expiry)&&expiry<=Date.now()))continue;packages.push({packageName:a.PackageName??'',monthly,remain,size,expiresAtMs:monthly?null:Number.isFinite(expiry)?expiry:null,refreshAtMs:monthly&&Number.isFinite(parseDate(a.CycleEndTime))?parseDate(a.CycleEndTime)+1000:null})}return {source:'official_resource_packages',total:packages.reduce((sum,x)=>sum+x.remain,0),packages};
}
export async function buddyHealth(c,options={}){const [sr,cr]=await Promise.allSettled([buddyStatus(c,'daily-checkin',options),buddyCredits(c,options)]);if(sr.status==='rejected'&&cr.status==='rejected')throw sr.reason;const checkin=sr.status==='fulfilled'?sr.value:{known:false,claimable:false,claimed:false,error:sr.reason.code??'provider_status_failed'},credits=cr.status==='fulfilled'?cr.value:{total:null,packages:[],error:cr.reason.code??'provider_balance_failed'};return {status:'authenticated',supportsCheckin:checkin.known?checkin.supportsCheckin===true:null,checkinKnown:checkin.known===true,checkinError:checkin.known?null:checkin.error,capabilities:{checkin:checkin.known?checkin.supportsCheckin===true:null,inference:true},checkin,credits,balance:{value:credits.total,unit:'积分',parts:credits.packages.map(x=>({name:x.packageName,value:x.remain,unit:'积分',...x})),note:!checkin.known?'签到状态读取失败，未确认活动是否开启':credits.error?'余额读取失败；签到状态独立核验':checkin.supportsCheckin?'官方资源包余额':'官方签到活动未开启',checkedIn:checkin.known?checkin.claimed:null}}}
export async function buddyClaim(c,task='daily-checkin',options={}){
  const before=await buddyStatus(c,task,options);if(!before.claimable)return {...before,submitted:false,alreadyClaimed:before.claimed};let result;
  try{result=await api(c,'/v2/billing/meter/daily-checkin',{},options)}catch(e){if(e.upstreamCode!==10001)throw e;result={already:true}}
  const [after,credits]=await Promise.all([buddyStatus(c,task,options),buddyCredits(c,options)]);
  if(!after.claimed)throw new AppError('Buddy领取结果尚未得到服务端确认',502,'provider_claim_unconfirmed');
  return {...after,claimed:true,submitted:true,alreadyClaimed:result.already===true,credit:result.credit??null,credits,rechecked:true};
}
export async function buddyChat(upstream,c,input,signal,options={}){
  const request={...input,stream:true};if(request.max_completion_tokens!==undefined&&request.max_tokens===undefined)request.max_tokens=request.max_completion_tokens;delete request.max_completion_tokens;const body=prepareChatBody(JSON.stringify(request)),tools=declaredTools(body),fetchImpl=options.fetchImpl??providerFetch;
  const response=await fetchImpl(endpoints(c).chat+'/v2/chat/completions',{method:'POST',headers:headers(c),body,signal,proxyUrl:c.proxyUrl,redirect:'error',headersTimeoutMs:90000,requestTimeoutMs:180000});
  if(!response.ok)throw await buddyChatRejection(response,{signal,errorBodyMaxBytes:options.errorBodyMaxBytes,errorBodyTimeoutMs:options.errorBodyTimeoutMs});
  return {response,recovery:tools?{declaredNames:tools.names,requiredParameters:tools.requiredParameters,pinnedToolName:tools.pinnedToolName}:undefined};
}
export const codeBuddyProvider={resolve:resolveBuddyCredential,models:buddyModels,health:buddyHealth,status:buddyStatus,claim:buddyClaim,chat:buddyChat};
export const workBuddyAIProvider=codeBuddyProvider;
