// Detailed local-admin account metadata. Never resolves/renews/decrypts a token.
import {readFile,stat} from 'node:fs/promises';
import {resolveCredentialFile} from './credentials.mjs';
import {AppError,errorView,rememberSecret,redact} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';

export const wbNumber=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
export function wbDate(value){if(value===null||value===undefined||value==='')return null;let n=Number(value);if(!Number.isFinite(n)){let raw=String(value);if(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw))raw=raw.replace(' ','T')+'+08:00';n=Date.parse(raw);}else if(n>0&&n<1e11)n*=1000;return n>0&&Number.isFinite(n)&&n<=8640000000000000?new Date(n).toISOString():null;}
const text=value=>typeof value==='string'||typeof value==='number'?redact(String(value)).slice(0,1000):null;
const claims=token=>{try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{return {};}};
export function workBuddyFailure(error){
  const view=errorView(error),httpStatus=Number(error.httpStatus??error.status)||view.status,upstreamCode=text(error.upstreamCode??error.businessCode??null);
  const message=String(error.message??''),code=String(error.code??'');
  const negative=/\bnot (?:banned|blocked|suspended)\b|未(?:被)?封禁|未(?:被)?封停|未(?:被)?禁用/i.test(message);
  const explicit=error.banned===true||/^(?:wb_)?(?:account|user)_(?:banned|blocked|suspended)$/.test(code)||!negative&&(/\b(?:account|user)\b.{0,35}\b(?:banned|blocked|suspended)\b|\b(?:banned|blocked|suspended)\s+(?:account|user)\b|(?:账号|帐号|用户).{0,12}(?:封禁|封停)|(?:封禁|封停).{0,8}(?:账号|帐号|用户)/i.test(message));
  const authRejected=[401,403].includes(httpStatus)||[401,403,12153].includes(Number(upstreamCode))||/^(?:credential_expired|credential_missing|invalid_credentials|wb_refresh_login_required)$/.test(code);
  return {...view,httpStatus,upstreamCode,banned:explicit,authRejected};
}
export function workBuddyUpstreamError(response,data,fallback='WB 官方查询失败'){
  const message=redact(String(data?.message??data?.msg??data?.error?.message??fallback)).slice(0,500),code=data?.code??data?.error?.code;
  const e=new AppError(message,response.ok?502:response.status,'wb_upstream_rejected');e.httpStatus=response.status;e.upstreamCode=code??null;e.banned=workBuddyFailure(e).banned;return e;
}
export async function readWorkBuddyIdentity(service,account){
  let raw={},source='saved_config',readError=null;
  try{const file=await resolveCredentialFile(account,service.config);if((await stat(file)).size>2097152)throw new AppError('WB 本机登录文件过大，身份字段待核验',413,'wb_identity_file_limit');raw=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));source=account.credentials?.kind==='desktop'?'desktop_file':'saved_session';}
  catch(e){readError=workBuddyFailure(e);}
  const auth=raw.auth??raw,profile=raw.profileRaw??raw.account??raw.profile??raw.user??{};
  for(const token of [raw.accessToken,raw.token,raw.refreshToken,auth.accessToken,auth.refreshToken])if(typeof token==='string')rememberSecret(token);
  const at=typeof auth.accessToken==='string'?auth.accessToken:typeof raw.token==='string'?raw.token:null,rt=typeof auth.refreshToken==='string'?auth.refreshToken:null;
  const atClaims=at?claims(at):{},rtClaims=rt?claims(rt):{};
  const uid=text(raw.uid??raw.userId??raw.user_id??profile.uid??profile.userId??profile.user_id??raw.principal??atClaims.sub??account.uid),nickname=text(profile.nickname??profile.nickName??profile.name??raw.nickname??account.nickname),username=text(profile.username??profile.userName??raw.username),email=text(profile.email??raw.email);
  const identity={uid,userId:text(profile.userId??profile.user_id??raw.userId??uid),nickname,username,email,domain:text(auth.domain??raw.domain),source,readError};
  const accessExpiresAt=wbDate(raw.expiresAtMs??auth.expiresAt??raw.expiresAt??atClaims.exp),refreshExpiresAt=wbDate(raw.refreshExpiresAtMs??auth.refreshExpiresAt??raw.refreshExpiresAt??rtClaims.exp),accessState=readError?'read_failed':!(auth.accessToken??raw.token)?'missing':accessExpiresAt&&Date.parse(accessExpiresAt)<=Date.now()?'expired':'configured',refreshState=!auth.refreshToken?'missing':refreshExpiresAt&&Date.parse(refreshExpiresAt)<=Date.now()?'expired':'configured';
  const credential={status:accessState,accessState,refreshState,accessExpiresAt,refreshExpiresAt,hasAccessToken:!!(auth.accessToken??raw.token),hasRefreshToken:!!auth.refreshToken,checkedAt:null};
  return {identity,profile:{nickname,username,email,avatarUrl:text(profile.avatarUrl??profile.avatar_url??profile.avatar)},credential,version:text(raw.clientVersion??profile.clientVersion??raw.version),edition:workBuddyEdition(account)};
}
export function workBuddyBan(service,accountId,balance={}){
  const manual=service.ledger?.get('wb-management-manual-status:'+accountId),known=service.ledger?.get('wb-management-official-status:'+accountId);
  if(manual?.status==='banned')return {...manual,source:'user_marked',httpStatus:null,upstreamCode:null};
  const e=balance.error;
  if(e?.banned)return {status:'banned',reason:e.message,httpStatus:e.httpStatus??e.status,upstreamCode:e.upstreamCode??null,checkedAt:balance.lastFailureAt??balance.checkedAt??null,source:'official_response'};
  if(known?.status==='banned')return known;
  if(e&&(e.authRejected||[401,403].includes(e.httpStatus??e.status)))return {status:'auth_rejected',reason:e.message,httpStatus:e.httpStatus??e.status,upstreamCode:e.upstreamCode??null,checkedAt:balance.lastFailureAt??balance.checkedAt??null,source:'official_response'};
  return {status:balance.lastSuccessAt&&!e?'clear':'unknown',reason:e?.message??null,httpStatus:e?.httpStatus??e?.status??null,upstreamCode:e?.upstreamCode??null,checkedAt:balance.lastFailureAt??balance.lastSuccessAt??balance.checkedAt??null,source:balance.lastSuccessAt?'official_response':'not_checked'};
}
export function isWorkBuddyBlocked(service,accountId){return service.ledger?.get('wb-management-manual-status:'+accountId)?.status==='banned'||service.ledger?.get('wb-management-official-status:'+accountId)?.status==='banned';}
export async function markWorkBuddyStatus(service,accountId,{status,reason,confirm}={}){
  if(!service.config.value.accounts.some(a=>a.id===accountId&&a.platform==='workbuddy'))throw new AppError('WB 帐号不存在',404,'account_not_found');
  if(confirm!==true||!['banned','clear'].includes(status)||reason!==undefined&&(typeof reason!=='string'||reason.length>500))throw new AppError('WB 状态标记需要 status=banned/clear 与 confirm=true',400,'wb_status_invalid');
  const row={status,reason:status==='banned'?redact(reason||'用户已确认此帐号被封禁').slice(0,500):null,checkedAt:new Date().toISOString(),source:'user_marked'};
  service.ledger?.set('wb-management-manual-status:'+accountId,row);return {saved:true,accountId,manualStatus:row,officialStatus:service.ledger?.get('wb-management-official-status:'+accountId)??null};
}
