import {readFile,stat} from 'node:fs/promises';
import {AppError,rememberSecret,dayIn} from './util.mjs';
import {readVideoSessionVault,videoSessionCookieHeader,videoSessionAuthToken,verifyVideoSessionIdentity} from './video-session-vault.mjs';

// Current official web contracts, captured 2026-10-27. No generation APIs,
// account creation, welcome bonuses, guessed daily amounts or arbitrary URLs.
export const VIDEO_DAILY_KINDS=Object.freeze(['vidu','pixverse']);
export const videoDailyClaimDay=(kind,date,timezone)=>dayIn(date,kind==='pixverse'?'UTC':['jimeng','kling','xiaoyunque','hailuo','liblib'].includes(kind)?'Asia/Shanghai':timezone);
const origins=Object.freeze({vidu:'https://service.vidu.cn',pixverse:'https://app-api.pixverse.ai'});
const receipts=new WeakSet();
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))?Number(value):null;
const failure=(message,code,status=502,extra={})=>Object.assign(new AppError(message,status,code),extra);
const invalid=()=>failure('视频平台返回的积分/任务结构待核验','video_daily_response_invalid');
function token(value){return typeof value==='string'&&value.trim()&&!/[\r\n]/.test(value)&&value.length<=32768?value.trim():null;}

export async function resolveVideoDailyCredential(kind,account,config){
  if(!VIDEO_DAILY_KINDS.includes(kind)||account.platform!==kind)throw failure('视频平台账号类型不匹配','video_daily_platform_invalid',400,{beforeSubmission:true});
  const file=account.credentials?.file;
  if(account.credentials?.kind!=='file'||typeof file!=='string'||!file||file==='auto')throw failure('视频平台登录态待写入本机私有 JSON','video_daily_login_required',401,{loginRequired:true,beforeSubmission:true});
  let raw;
  try{const p=config.path(file);const info=await stat(p);if(info.size>131072)throw new Error();raw=JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));}catch{throw failure('视频平台登录态待写入本机私有 JSON','video_daily_login_required',401,{loginRequired:true,beforeSubmission:true});}
  if(raw.format==='ai-credit-gateway-video-session'){
    const session=await readVideoSessionVault(config.path(file),{platform:kind});
    const cookie=kind==='vidu'?videoSessionCookieHeader(session,'https://service.vidu.cn/iam/v1/users/me'):undefined;
    const authToken=kind==='pixverse'?videoSessionAuthToken(session,'_ai_token'):session.accessToken;
    if(!authToken&&!cookie)throw failure('视频平台会话缺少有效认证字段','video_daily_login_required',401,{loginRequired:true,beforeSubmission:true});
    return {accessToken:authToken??cookie,authToken,cookie,principal:session.principal,expiresAtMs:session.expiresAtMs,source:'windows-current-user-dpapi',filePath:config.path(file),videoSession:session};
  }
  const accessToken=token(raw.accessToken??raw.token),cookie=token(raw.cookie);
  for(const secret of [accessToken,cookie])if(secret)rememberSecret(secret);
  const principal=typeof raw.principal==='string'?raw.principal.trim():typeof raw.userId==='string'||typeof raw.userId==='number'?String(raw.userId):'';
  if(!principal||principal.length>256||!accessToken&&(kind!=='vidu'||!cookie))throw failure('视频平台登录态缺少账号标识或有效会话','video_daily_login_required',401,{loginRequired:true,beforeSubmission:true});
  if(raw.expiresAtMs!==undefined&&(!Number.isFinite(raw.expiresAtMs)||raw.expiresAtMs<=0))throw failure('视频平台会话到期时间格式待核验','video_daily_credential_invalid',401,{loginRequired:true,beforeSubmission:true});
  return {accessToken:accessToken??cookie,cookie:kind==='vidu'?cookie:undefined,authToken:accessToken,principal,expiresAtMs:raw.expiresAtMs,source:'local-video-session',filePath:config.path(file)};
}

async function boundedJson(response){
  const reader=response.body?.getReader();if(!reader)throw invalid();let count=0;const chunks=[];
  try{for(;;){const step=await reader.read();if(step.done)break;count+=step.value.length;if(count>1048576)throw failure('视频平台响应超过核验上限','video_daily_response_too_large');chunks.push(step.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch(e){if(e instanceof AppError)throw e;throw invalid();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function videoDailyJson(kind,path,credential,{method='GET',body,fetchImpl=globalThis.fetch,signal}={}){
  const permitted=kind==='vidu'?new Set(['/credit/v1/credits/me','/iam/v1/users/every-day-credit']):new Set(['/creative_platform/user/credits','/creative_platform/task/list','/creative_platform/reward/claim']);
  if(!origins[kind]||!permitted.has(path))throw failure('视频平台官方路径校验失败','video_daily_endpoint_invalid',400,{beforeSubmission:true});
  const headers={Accept:'application/json','Accept-Language':'zh-CN','X-Platform':kind==='vidu'?'web':'Web'};
  if(kind==='vidu'){
    const cookie=credential.videoSession?videoSessionCookieHeader(credential.videoSession,origins[kind]+path):credential.cookie;
    if(cookie)headers.Cookie=cookie;
    if(credential.authToken)headers.Authorization=`Token ${credential.authToken}`;
  }else{headers.Token=credential.authToken??credential.accessToken;headers['Workspace-Id']='0';}
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetchImpl(origins[kind]+path,{method,headers,redirect:'error',signal:signal??AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){await response.body?.cancel();const auth=response.status===401||response.status===403;throw failure(auth?'视频平台会话待重新登录':`视频平台官方接口 HTTP ${response.status}`,auth?'video_daily_login_required':'video_daily_http_error',auth?401:response.status>=400?response.status:502,{...(auth||response.status===429?{beforeSubmission:true}:{}),...(auth?{loginRequired:true}:{})});}
  const data=await boundedJson(response);
  if(kind==='pixverse'){
    if(!data||!Number.isSafeInteger(data.ErrCode))throw invalid();
    if(data.ErrCode!==0)throw failure('PixVerse 官方任务返回业务拒绝','video_daily_business_rejected');
    if(!Object.hasOwn(data,'Resp'))throw invalid();return data.Resp;
  }
  if(!data||typeof data!=='object'||Array.isArray(data))throw invalid();return data;
}

export function parsePixVerseLoginTask(tasks){
  if(!Array.isArray(tasks)||tasks.length>500)throw invalid();
  const matches=tasks.filter(t=>t&&t.task_type===1&&t.sub_type===1);
  if(matches.length>1)throw failure('PixVerse 每日登录任务出现重复记录','video_daily_task_ambiguous');
  if(!matches.length)return {known:true,active:false,claimed:false,reason:'daily_login_task_not_offered',details:{dailyTaskOffered:false}};
  const task=matches[0],reward=nonnegative(task.reward);
  if(![1,2,3,4].includes(task.progress)||reward===null)throw invalid();
  return {known:true,active:task.progress===2&&reward>0,claimed:task.progress===3,credits:reward,reason:task.progress===3?'official_daily_task_claimed':task.progress===2&&reward>0?'official_daily_task_claimable':task.progress===1?'daily_login_task_unfinished':task.progress===4?'daily_login_task_expired':'daily_login_task_zero_reward',details:{taskType:1,subType:1,progress:task.progress,reward}};
}

export function officialVideoDailySettlement(kind,principalHash,claim,day,timezone='Asia/Shanghai'){
  const receipt=claim?.officialDailyReceipt;
  if(kind!=='vidu'||!receipt||!receipts.has(receipt)||receipt.kind!==kind||receipt.principalHash!==principalHash||dayIn(new Date(receipt.checkedAt),timezone)!==day)return null;
  return {status:receipt.amount>0?'success':'observed',result:{serverConfirmed:true,credits:receipt.amount,claimed:receipt.amount>0,reason:receipt.amount>0?'official_daily_login_grant':'official_daily_login_zero_grant',benefitOutcome:receipt.amount>0?'newly_granted':'no_new_daily_credit',officialDailyReceipt:{source:receipt.source,day,amount:receipt.amount,checkedAt:receipt.checkedAt}}};
}

export function createVideoDailyProvider(kind,{fetchImpl=globalThis.fetch,now=()=>new Date()}={}){
  if(!VIDEO_DAILY_KINDS.includes(kind))throw failure('视频平台未注册','video_daily_platform_invalid',400);
  const request=(path,c,options={})=>videoDailyJson(kind,path,c,{fetchImpl,...options});
  const verifyPrincipal=async c=>{
    if(!c.videoSession)return;
    const identity=await verifyVideoSessionIdentity(c.videoSession,{fetchImpl});
    if(identity.principal!==c.principal)throw failure('视频平台官方主体与本机会话绑定不一致','video_session_principal_changed',409,{beforeSubmission:true});
  };
  const balance=async c=>{
    const data=await request(kind==='vidu'?'/credit/v1/credits/me':'/creative_platform/user/credits',c);
    if(kind==='vidu'){
      const value=nonnegative(data.credits);if(value===null)throw invalid();
      return {value,unit:'积分',parts:[['免费积分',data.credits_free],['订阅积分',data.credits_subscribed],['今日到期',data.credits_expire_today]].filter(([,v])=>nonnegative(v)!==null).map(([name,v])=>({name,value:nonnegative(v)})),note:'仅每日登录积分；不接视频生成或反代，实际赠送额以官方回执为准'};
    }
    if(!data||typeof data!=='object'||Array.isArray(data))throw invalid();
    const fields=['credit_daily','credit_monthly','credit_package'],values=fields.map(k=>nonnegative(data[k]));
    if(values.some(v=>v===null))throw invalid();
    return {value:values.reduce((a,b)=>a+b,0),unit:'积分',parts:values.map((value,i)=>({name:['每日积分','订阅积分','充值积分'][i],value})),note:'每日奖励依账号资格及官方任务列表；不固定承诺30/60积分，不接视频反代'};
  };
  const status=async(c,task='daily-checkin')=>{
    if(task!=='daily-checkin')throw failure('视频平台只处理每日登录领取','video_daily_task_invalid',400,{beforeSubmission:true});
    if(kind==='pixverse'){
      const date=now(),nextClaimAt=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+1)).toISOString();
      return {...parsePixVerseLoginTask(await request('/creative_platform/task/list',c)),nextClaimAt};
    }
    await balance(c);const date=now(),nextClaimAt=new Date(Date.parse(dayIn(date,'Asia/Shanghai')+'T00:00:00+08:00')+86400000).toISOString();return {known:true,active:true,claimed:null,nextClaimAt,reason:'daily_login_grant_endpoint_available',details:{confirmation:'official_daily_response_required'}};
  };
  return Object.freeze({
    supportsCheckin:true,descriptor:{id:kind,checkinSupported:true,claimOnly:true,inference:false},
    resolve:(a,config)=>resolveVideoDailyCredential(kind,a,config),models:async()=>[],
    async health(c){const [b,s]=await Promise.all([balance(c),status(c)]);return {status:'authenticated',credentialStatus:'authenticated',websiteUrl:c.videoSession?.origin??(kind==='vidu'?'https://www.vidu.cn':'https://app.pixverse.ai'),balance:b,checkin:s,capabilities:{checkin:true,inference:false,models:false,claimOnly:true}};},
    status,
    async claim(c,task='daily-checkin'){
      if(task!=='daily-checkin')throw failure('视频平台只处理每日登录领取','video_daily_task_invalid',400,{beforeSubmission:true});
      await verifyPrincipal(c);
      if(kind==='pixverse'){
        const before=await status(c,task);
        if(before.claimed)return {submitted:false,alreadyClaimed:true,claimed:true};
        if(!before.active)throw failure('PixVerse 当前没有已完成且可领取的每日登录任务','video_daily_not_claimable',409,{beforeSubmission:true});
        await request('/creative_platform/reward/claim',c,{method:'POST',body:{sub_type:1}});
        // ErrCode=0 is acknowledgement only. ClaimService must re-read task/list
        // and see DAILY+LOGIN progress=CLAIMED before recording success.
        return {submitted:true,mutation:true,claimed:true,credit:before.credits,automaticPerformed:true};
      }
      const response=await request('/iam/v1/users/every-day-credit',c);
      const amount=nonnegative(response.credit);if(amount===null||!Number.isSafeInteger(amount))throw invalid();
      if(typeof c.principalHash!=='string'||!c.principalHash)throw invalid();
      const date=now(),receipt=Object.freeze({kind,principalHash:c.principalHash,day:dayIn(date,'Asia/Shanghai'),amount,source:'/iam/v1/users/every-day-credit',checkedAt:date.toISOString()});receipts.add(receipt);
      return {submitted:true,mutation:true,automaticPerformed:true,claimed:amount>0,observed:amount===0,credit:amount,officialDailyReceipt:receipt};
    }
  });
}
export const viduDailyProvider=createVideoDailyProvider('vidu');
export const pixVerseDailyProvider=createVideoDailyProvider('pixverse');
