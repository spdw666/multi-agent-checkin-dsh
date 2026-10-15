// Protocol reviewed against changexbc/workbuddy-switch, MIT, commit
// 22b318c1f44b335c2222e444abcc2d0f74e160f7. Independent Node implementation.
import {AppError,rememberSecret} from './util.mjs';

export function workBuddyEdition(value={}) {return ['ai','intl','global'].includes(value.edition??value.variant)||/^(?:[a-z0-9-]+\.)*workbuddy\.ai$/i.test(value.domain??'')?'ai':'cn';}
export function workBuddyOrigin(value={}) {return workBuddyEdition(value)==='ai'?'https://www.workbuddy.ai':'https://www.codebuddy.cn';}
export function workBuddyExpiry(data,now=Date.now()) {
  const raw=data.expiresAtMs??data.expiresAt??data.expires_at;
  if(raw!==null&&raw!==undefined){const n=Number(raw);if(Number.isFinite(n)&&n>0)return n<1e11?n*1000:n;const date=Date.parse(raw);if(Number.isFinite(date))return date;}
  return Number.isFinite(Number(data.expiresIn))?now+Number(data.expiresIn)*1000:undefined;
}
export function assertWorkBuddyDomain(edition,domain) {if(domain&&workBuddyEdition({domain})!==edition)throw new AppError('WorkBuddy 登录响应档位不一致',502,'wb_login_domain_mismatch');}

// One rotation only. The caller persists the outcome before any later retry.
export async function refreshWorkBuddyCredential(credential,{fetchImpl=fetch,signal,now=Date.now()}={}) {
  if(typeof now==='function')now=now();
  if(typeof credential.refreshToken!=='string'||!credential.refreshToken){const e=new AppError('WorkBuddy 已保存登录缺少续期凭据，请重新登录该帐号',401,'wb_refresh_login_required');e.loginRequired=true;throw e;}
  rememberSecret(credential.refreshToken);rememberSecret(credential.accessToken);
  let response,data;
  try {response=await fetchImpl(workBuddyOrigin(credential)+'/v2/plugin/auth/token/refresh',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+credential.accessToken,'X-Domain':credential.domain??(workBuddyEdition(credential)==='ai'?'www.workbuddy.ai':'www.workbuddy.cn'),'X-Refresh-Token':credential.refreshToken,'X-Auth-Refresh-Source':'plugin'},body:'{}',signal:signal??AbortSignal.timeout(20000),redirect:'error'});}catch{throw new AppError('WorkBuddy 续期提交结果待确认，请重新登录后恢复',503,'wb_refresh_unconfirmed');}
  try{data=await response.json();}catch{throw new AppError('WorkBuddy 续期响应待确认，请重新登录后恢复',503,'wb_refresh_unconfirmed');}
  const code=Number(data?.code??0),message=String(data?.message??data?.msg??'');
  if(response.status===429||code===429){const e=new AppError('WorkBuddy 续期限流，稍后重试',429,'wb_refresh_rate_limited');e.retryable=true;e.beforeSubmission=true;e.retryAfterSeconds=Math.min(3600,Math.max(1,Number(response.headers?.get('retry-after'))||60));e.retryAt=now+e.retryAfterSeconds*1000;throw e;}
  if([401,403].includes(response.status)||[401,403,12153].includes(code)||(!response.ok||![0,200].includes(code))&&/invalid_grant|refresh.?token.*(?:expired|invalid)|会话.*失效|登录.*过期/i.test(message)){const e=new AppError('WorkBuddy 续期凭据已失效，请重新登录该帐号',401,'wb_refresh_login_required');e.loginRequired=true;throw e;}
  if(!response.ok||![0,200].includes(code))throw new AppError('WorkBuddy 续期结果待确认，请重新登录后恢复',503,'wb_refresh_unconfirmed');
  const raw=data.data??{},accessToken=raw.accessToken??raw.access_token,refreshToken=raw.refreshToken??raw.refresh_token??credential.refreshToken;
  if(typeof accessToken!=='string'||!accessToken)throw new AppError('WorkBuddy 续期结果缺少登录态，请重新登录后恢复',503,'wb_refresh_unconfirmed');
  assertWorkBuddyDomain(workBuddyEdition(credential),raw.domain);
  rememberSecret(accessToken);rememberSecret(refreshToken);
  return {...credential,accessToken,refreshToken,domain:raw.domain??credential.domain,expiresAtMs:workBuddyExpiry(raw,now),refreshExpiresAtMs:workBuddyExpiry({expiresAt:raw.refreshExpiresAt,expiresIn:raw.refreshExpiresIn},now),principal:credential.principal,refreshedAt:new Date(now).toISOString()};
}
