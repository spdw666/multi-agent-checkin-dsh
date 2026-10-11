import {antigravityBase,localBridgeFetch} from './antigravity.mjs';
import {AppError,rememberSecret} from './util.mjs';
const unavailable=()=>new AppError('Antigravity 配额查询失败，请重新核验；调用通道状态独立显示',502,'antigravity_quota_unavailable');
// Only observed, finite fractions are percentages. Missing buckets stay unknown.
export function normalizeAntigravityQuota(data,now=new Date().toISOString()) {
 if(!Array.isArray(data?.groups))throw unavailable();
 const quotaGroups=[['gemini','Gemini 模型'],['3p','Claude / GPT 模型']].map(([id,displayName])=>({id,displayName,buckets:['weekly','5h'].map(window=>{
  const bucketId=`${id}-${window}`;
  const matches=data.groups.flatMap(g=>Array.isArray(g.buckets)?g.buckets:[]).filter(b=>b?.bucketId===bucketId&&b.window===window);
  const b=matches.length===1?matches[0]:{};
  const remainingFraction=typeof b.remainingFraction==='number'&&Number.isFinite(b.remainingFraction)&&b.remainingFraction>=0&&b.remainingFraction<=1?b.remainingFraction:null;
  const resetTime=typeof b.resetTime==='string'&&Number.isFinite(Date.parse(b.resetTime))?new Date(b.resetTime).toISOString():null;
  return {id:bucketId,displayName:window==='weekly'?'每周限额剩余':'5 小时限额剩余',window,remainingFraction,resetTime};
 })}));
 return {quotaGroups,quotaKnown:quotaGroups.some(g=>g.buckets.some(b=>b.remainingFraction!==null)),quotaFetchedAt:now,quotaStale:false,quotaError:null};
}
async function readJson(response) {
 if(!response.ok){await response.body?.cancel();throw unavailable();}
 const reader=response.body?.getReader();if(!reader)throw unavailable();let n=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>1048576)throw unavailable();chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function antigravityQuota(upstream,credential,{fetchImpl=localBridgeFetch,signal=AbortSignal.timeout(18000)}={}) {
 try{
  const origin=new URL(antigravityBase(upstream)).origin;
  if(typeof credential.managementToken!=='string'||!credential.managementToken||typeof credential.authFileName!=='string'||!credential.authFileName)throw unavailable();
  rememberSecret(credential.managementToken);
  const headers={Authorization:`Bearer ${credential.managementToken}`,'Content-Type':'application/json'};
  const catalog=await readJson(await fetchImpl(origin+'/v0/management/auth-files',{headers,signal}));
  const rows=(catalog.files??[]).filter(f=>f.name===credential.authFileName&&f.provider==='antigravity'&&f.disabled!==true);
  if(rows.length!==1||!rows[0].auth_index||typeof rows[0].project_id!=='string'||!rows[0].project_id)throw unavailable();
  const row=rows[0];
  const payload={auth_index:row.auth_index,method:'POST',url:'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',header:{Authorization:'Bearer $TOKEN$','Content-Type':'application/json','User-Agent':'antigravity/cli/1.20.5 windows/amd64'},data:JSON.stringify({project:row.project_id})};
  const wrapped=await readJson(await fetchImpl(origin+'/v0/management/api-call',{method:'POST',headers,signal,body:JSON.stringify(payload)}));
  if(wrapped.status_code!==200)throw unavailable();
  return normalizeAntigravityQuota(typeof wrapped.body==='string'?JSON.parse(wrapped.body):wrapped.body);
 }catch{throw unavailable();}
}
export async function cachedAntigravityQuota(cache,key,work) {
 const old=cache.get(key);if(old?.flight)return old.flight;
 const flight=Promise.resolve().then(work).then(value=>{cache.set(key,{value});return value;},()=>{
  const value=old?.value;cache.set(key,{value});
  return {...(value??normalizeAntigravityQuota({groups:[]},null)),quotaStale:!!value,quotaError:'配额刷新失败，请重新核验'};
 });cache.set(key,{value:old?.value,flight});return flight;
}
