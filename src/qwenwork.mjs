import {AppError,jsonFetch} from './util.mjs';
import {randomUUID} from 'node:crypto';
export const qwenRequest=(url,options)=>jsonFetch(url,{...options,successCodes:[0,'0',200,'200','ok']});
// Observed in QwenWorkCN 1.2.5 desktop's account.getContext, not Qwen Code CLI.
export const QWENWORK_ACCOUNT_CONTEXT='/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing';
export function qwenHeaders(credential) {return {Authorization:`Bearer ${credential.accessToken}`,'User-Agent':'qoderwork/1.2.5','X-Request-Id':randomUUID(),'X-QwenWork-Version':'1.2.5','X-QwenWork-Release-Version':'1.2.5-26092902','X-QwenWork-Build':'26092902','X-QwenWork-Platform':'win32','X-QwenWork-Arch':'x64','X-QwenWork-Channel':'stable'};}
export async function refreshQwenSession(raw,{request=qwenRequest}={}) {
 if(!raw.refreshToken)throw new AppError('千问办公登录态待在客户端重新登录',401,'qwenwork_login_required');
 const headers=qwenHeaders({});delete headers.Authorization;
 const body={refresh_token:raw.refreshToken,target:'c',...(raw.oauthClientId&&raw.oauthRedirectUri?{client_id:raw.oauthClientId,redirect_uri:raw.oauthRedirectUri}:{})};
 const response=await request('https://gateway.qwenwork.cn/api/v1/deviceToken/refresh',{headers,body});
 const d=response.data??response,token=d.device_token??d.token;
 if(typeof token!=='string'||!token||typeof d.refresh_token!=='string')throw new AppError('QwenWork refresh response is incomplete',401,'qwenwork_refresh_failed');
 return {...raw,token,refreshToken:d.refresh_token,expiresAt:d.expires_at??new Date(Date.now()+(d.expires_in??3600)*1000).toISOString()};
}
export async function qwenWorkContext(credential,{fetchContext}={}) {
  if(credential.user?.isBiz!==false)throw new AppError('Personal QwenWork context is required',409,'qwenwork_personal_scope_required');
  const request=fetchContext??qwenRequest;
  const raw=await request('https://gateway.qwenwork.cn'+QWENWORK_ACCOUNT_CONTEXT,{headers:qwenHeaders(credential)});
  const data=raw.data??raw;const quota=data.quota??data.account?.quota;const user=data.user??{};const plan=data.plan??{};
  if(user.isBiz===true||user.is_biz===true||user.orgType==='enterprise'||user.org_type==='enterprise'||plan.planId==='qwen-office-enterprise')throw new AppError('Server returned enterprise context; personal team must be selected',409,'qwenwork_personal_scope_required');
  if(!quota||typeof quota!=='object')throw new AppError('QwenWork returned no personal quota object',502,'qwenwork_invalid_context');
  let wallets;
  if(!fetchContext){const w=await request('https://gateway.qwenwork.cn/api/v1/adapter/user/wallets',{headers:qwenHeaders(credential)});const d=w.data??w;wallets={dailyBalance:d.daily_credits?.total_balance??null,monthlyBalance:d.monthly_credits?.total_balance??null,longtermBalance:d.longterm_credits?.total_balance??null,activeWallets:(d.active_wallets?.wallets??[]).map(w=>({balance:w.balance,validTo:w.valid_to}))};}
  return {source:'QwenWork desktop personal account-context',userType:'personal',plan,quota,...(wallets?{wallets}:{}),grantMode:'server_automatic_daily_reset'};
}
