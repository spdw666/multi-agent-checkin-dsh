import {createHash} from 'node:crypto';
import {AppError,rememberSecret} from './util.mjs';
// Protocol adapted from wangmingdong/workbuddy-signin (MIT).
// Account/device identifiers come from the user's local file, never the reference author's constants.
export function miniMaxRequest(credential,path,{body,now=Date.now()}={}) {
  const origin=credential.region==='intl'?'https://agent.minimax.io':'https://agent.minimax.cn';
  const seconds=Math.floor(now/1000), text=body===undefined?'':JSON.stringify(body);
  const signature=createHash('md5').update(`${seconds}I*7Cf%WZ#S&%1RlZJ&C2${text}`).digest('hex');
  const desktop=credential.authMode==='desktop-oauth';
  const params=new URLSearchParams({device_platform:desktop?'mcode':'web',biz_id:'3',app_id:'3001',version_code:'22201',unix:String(now),timezone_offset:credential.region==='intl'?'0':'28800',sys_language:'zh',lang:'zh',client:desktop?'mcode':'web',region:credential.region==='intl'?'intl':'cn',...credential.webIdentity,...(desktop?{}:{token:credential.accessToken})});
  return {url:origin+'/minimax-cloud/api/v1'+path+'?'+params,options:{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-timestamp':String(seconds),'x-signature':signature,Origin:origin,Referer:origin+'/',...(desktop?{Authorization:`Bearer ${credential.accessToken}`,'User-Agent':'MiniMaxCode'}:{})},...(body===undefined?{}:{body:text}),redirect:'error',signal:AbortSignal.timeout(30000)}};
}
export async function miniMaxApi(c,path,{body,fetchImpl=fetch,now}={}) {
  rememberSecret(c.accessToken);
  const request=miniMaxRequest(c,path,{body,now}); let response;
  try {response=await fetchImpl(request.url,request.options)}catch {throw new AppError('MiniMax request failed; local session was not logged',502,'minimax_network_error')}
  const raw=await response.json().catch(()=>null);
  if(!response.ok)throw new AppError(`MiniMax HTTP ${response.status}`,response.status,'minimax_http_error');
  if(!raw||raw.base_resp?.status_code!==0) {
    const code=raw?.base_resp?.status_code;
    throw new AppError(`MiniMax rejected session/request (${code??'invalid_response'})`,code===1004?401:502,'minimax_session_rejected');
  }
  return raw.data;
}
export async function miniMaxStatus(c,options) {
  const data=await miniMaxApi(c,'/signin/status',options);
  if(!Array.isArray(data?.days))throw new AppError('MiniMax signin response has no days array',502,'minimax_invalid_status');
  const today=data.days.find(d=>d.is_today===true||d.is_today===1);
  if(!today||![1,2,3].includes(today.status)||!Number.isFinite(today.points))throw new AppError('MiniMax today/reward state is incomplete',502,'minimax_invalid_status');
  return {known:true,active:today.status===2||today.status===3,claimed:today.status===3,credits:today.points,details:{today,claimedDays:data.days.filter(d=>d.status===3).length,cyclePoints:data.days.reduce((sum,d)=>sum+(Number(d.points)||0),0)}};
}
export async function miniMaxClaim(c,options={}) {
  const data=await miniMaxApi(c,'/signin/claim',{...options,body:{}});
  if(![1,2].includes(data?.claim_result)) {const e=new AppError('MiniMax claim response is not a confirmed receipt',502,'minimax_claim_rejected');e.definitiveRejection=true;throw e;}
  return {credit:data.points,already:data.claim_result===2};
}
export function parseMiniMaxCredential(raw) {
  const entry=(raw.origins??[]).find(o=>/^https:\/\/agent\.minimax\.(cn|io)$/.test(o.origin));
  const storage=Object.fromEntries((entry?.localStorage??[]).map(r=>[r.name,r.value]));
  let token=raw.accessToken??raw.access_token??raw._token??storage._token??storage.access_token;
  if(typeof token==='string')try{const parsed=JSON.parse(token);if(typeof parsed==='string')token=parsed;else if(parsed.access_token||parsed.token)token=parsed.access_token??parsed.token}catch{}
  if(typeof token!=='string'||!token)throw new AppError('MiniMax Code 登录态待导入本机凭据文件',401,'minimax_login_required');
  let claims;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString())}catch{claims={}}
  const principal=String(raw.principal??raw.userId??raw.user_id??claims.user_id??claims.sub??'');
  if(!principal)throw new AppError('MiniMax session has no stable account identity',401,'minimax_identity_missing');
  const region=raw.region??(entry?.origin.endsWith('.io')?'intl':'cn');
  const identity=raw.webIdentity??{};
  if(!identity.uuid||!identity.device_id)throw new AppError('MiniMax 本机会话需保存 uuid 与 device_id；使用登录导入入口',401,'minimax_device_missing');
  return {accessToken:token,principal,region,webIdentity:{...identity,user_id:principal},expiresAtMs:claims.exp?claims.exp*1000:undefined,source:'browser-local-file'};
}

export async function miniMaxMembership(c){const now=Date.now(),r=miniMaxRequest(c,'/signin/status',{body:{},now}),u=new URL(r.url);u.pathname='/matrix/api/v1/commerce/get_membership_info';const md5=x=>createHash('md5').update(x).digest('hex');r.options.headers.yy=md5(encodeURIComponent(u.pathname+u.search)+'_{}'+md5(String(now))+'ooui');const response=await fetch(u,r.options);if(!response.ok)throw new AppError('MiniMax balance HTTP '+response.status,response.status,'balance_error');const d=await response.json();if(d.base_resp?.status_code!==0)throw new AppError('MiniMax membership rejected',502,'balance_error');return d.data??d;}
