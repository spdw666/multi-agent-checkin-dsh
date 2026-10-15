// OAuth protocol reviewed against MIT changexbc/workbuddy-switch.
import {randomUUID} from 'node:crypto';
import {AppError,rememberSecret} from './util.mjs';
import {workBuddyOrigin,workBuddyExpiry,assertWorkBuddyDomain} from './workbuddy-auth.mjs';
import {captureWorkBuddyAccount} from './workbuddy-pool.mjs';
const sessions=new WeakMap(),flights=new WeakMap();
const stateMap=service=>{if(!sessions.has(service))sessions.set(service,new Map());return sessions.get(service);};
async function request(service,url,{body,headers}={}){const r=await(service.workbuddyRuntime?.fetchImpl??fetch)(url,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(20000)});let value;try{value=await r.json();}catch{throw new AppError('WB 登录响应格式待确认',502,'wb_login_response_invalid');}if(!r.ok)throw new AppError('WB 登录请求被服务端拒绝',r.status,'wb_login_request_failed');return value;}
export async function startWorkBuddyLogin(service,{edition='cn',label}={}){
  if(['global','intl'].includes(edition))edition='ai';
  if(!['cn','ai'].includes(edition)||label!==undefined&&(typeof label!=='string'||label.length>100))throw new AppError('WB 登录参数格式错误',400,'wb_login_parameters_invalid');
  const map=stateMap(service),now=Date.now();for(const [id,s] of map)if(s.expiresAt<now)map.delete(id);if(map.size>=20)throw new AppError('WB 登录请求较多，请先完成或取消已有登录',429,'wb_login_pending_limit');
  const base=workBuddyOrigin({edition}),envelope=await request(service,base+'/v2/plugin/auth/state?platform='+(edition==='ai'?'workbuddy-ai':'workbuddy'),{body:{}}),data=envelope.data??{};
  if(![0,200,'0','200'].includes(envelope.code??0)||typeof data.state!=='string'||!data.state)throw new AppError('WB 登录暂未返回有效登录状态',502,'wb_login_state_missing');
  const authorizationUrl=data.authUrl??data.auth_url??data.url??base+'/login?state='+encodeURIComponent(data.state);let parsed;try{parsed=new URL(authorizationUrl);}catch{throw new AppError('WB 官方登录链接格式错误',502,'wb_login_url_invalid');}
  if(parsed.protocol!=='https:'||!/(^|\.)(?:codebuddy\.(?:cn|ai)|workbuddy\.(?:cn|ai)|tencent\.com|qq\.com)$/.test(parsed.hostname))throw new AppError('WB 登录链接来源待确认',502,'wb_login_url_invalid');
  const loginId=randomUUID(),expiresAt=now+600000;map.set(loginId,{edition,label,state:data.state,expiresAt,status:'pending'});return {loginId,authorizationUrl,verificationUri:authorizationUrl,expiresAt:new Date(expiresAt).toISOString(),pollAfterMs:2000};
}
export function cancelWorkBuddyLogin(service,{loginId}={}){const removed=stateMap(service).delete(loginId);return {cancelled:removed,loginId};}
export async function pollWorkBuddyLogin(service,{loginId}={}){
  const map=stateMap(service),session=map.get(loginId);if(!session)throw new AppError('WB 登录请求不存在或已取消',404,'wb_login_not_found');if(session.status==='complete')return session.result;if(session.expiresAt<Date.now()){map.delete(loginId);return {status:'expired',loginId};}
  if(!flights.has(service))flights.set(service,new Map());const active=flights.get(service);if(active.has(loginId))return active.get(loginId);
  const flight=(async()=>{const base=workBuddyOrigin(session),envelope=await request(service,base+'/v2/plugin/auth/token?state='+encodeURIComponent(session.state)),data=envelope.data??{},accessToken=data.accessToken??data.access_token;
    if(![0,200,'0','200'].includes(envelope.code??0)||typeof accessToken!=='string'||!accessToken)return {status:'pending',loginId};
    assertWorkBuddyDomain(session.edition,data.domain);rememberSecret(accessToken);rememberSecret(data.refreshToken??data.refresh_token);
    const profileEnvelope=await request(service,base+'/v2/plugin/login/account?state='+encodeURIComponent(session.state),{headers:{Authorization:'Bearer '+accessToken,'X-Domain':data.domain??(session.edition==='ai'?'www.workbuddy.ai':'www.workbuddy.cn')}}),profile=profileEnvelope.data??{};
    assertWorkBuddyDomain(session.edition,profile.domain);if(![0,200,'0','200'].includes(profileEnvelope.code??0)||!profile.uid)throw new AppError('WB 登录尚未返回稳定帐号身份',502,'wb_login_identity_missing');
    // Cancellation during a pending HTTP call must not create a surprise account.
    if(map.get(loginId)!==session)return {status:'cancelled',loginId};
    const result=await captureWorkBuddyAccount(service,{id:'wb-'+randomUUID().slice(0,20),label:session.label??profile.nickname??'WB 帐号'},{readCurrent:async()=>({principal:String(profile.uid),uid:String(profile.uid),edition:session.edition,accessToken,refreshToken:data.refreshToken??data.refresh_token,domain:data.domain??(session.edition==='ai'?'www.workbuddy.ai':'www.workbuddy.cn'),expiresAtMs:workBuddyExpiry(data),refreshExpiresAtMs:workBuddyExpiry({expiresAt:data.refreshExpiresAt,expiresIn:data.refreshExpiresIn}),profileRaw:profile})});
    session.status='complete';session.state='';session.result={status:'complete',loginId,accountId:result.accountId,reusedExisting:result.reusedExisting};return session.result;
  })();active.set(loginId,flight);try{return await flight;}finally{active.delete(loginId);}
}
