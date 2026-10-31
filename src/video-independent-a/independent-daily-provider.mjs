import {createHash} from 'node:crypto';
import {signNativeRequest,NATIVE_USER_AGENT} from './native-signers.mjs';
import {VIDEO_SESSION_AUTH_COOKIES,videoSessionCookieAlive} from '../video-session-vault.mjs';
const origins={jimeng:'https://jimeng.jianying.com',kling:'https://klingai.com'};
const allowedOrigins=['https://jimeng.jianying.com','https://klingai.com','https://klingai.kuaishou.com'];
const paths={jimeng:{identity:'/passport/account/info/v2/?account_sdk_source=web',balance:'/commerce/v1/benefits/user_credit',history:'/commerce/v1/benefits/user_credit_history',claim:'/commerce/v1/benefits/credit_receive'},kling:{identity:'/api/user/profile_and_features',balance:'/api/account/pointAndTicket',membership:'/api/account/contract',history:'/api/account/trade',claim:'/api/pay/reward/v2'}};
const err=(code,beforeSubmission=true)=>Object.assign(new Error(code),{code,beforeSubmission});
const scalar=v=>typeof v==='string'&&v.length>0&&v.length<=32768&&!/[\r\n]/.test(v);
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v)&&Number.isFinite(Number(v))?Number(v):null;
const day=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const principal=v=>typeof v==='string'&&v.length>0&&v.length<=256?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):null;
export function cookieHeaderFor(url,cookies,now=Date.now()){
 const u=new URL(url);if(!allowedOrigins.includes(u.origin)||!Array.isArray(cookies))throw err('credential_cookie_scope_invalid');
 return cookies.filter(c=>{if(!scalar(c?.name)||!scalar(c?.value)||/[;=\s]/.test(c.name)||/[;\x00-\x1f\x7f]/.test(c.value))return false;const rawDomain=String(c.domain||'').toLowerCase(),domain=rawDomain.replace(/^\./,'');if(!domain.includes('.')||!(u.hostname===domain||rawDomain.startsWith('.')&&c.hostOnly!==true&&u.hostname.endsWith('.'+domain)))return false;const p=typeof c.path==='string'?c.path:'/';if(!u.pathname.startsWith(p)||u.pathname.length>p.length&&!p.endsWith('/')&&u.pathname[p.length]!=='/')return false;if(c.secure===true&&u.protocol!=='https:')return false;return VIDEO_SESSION_AUTH_COOKIES.includes(c.name)?videoSessionCookieAlive(c):c.expirationDate==null||Number.isFinite(c.expirationDate)&&c.expirationDate*1000>now;}).sort((a,b)=>(b.path?.length||1)-(a.path?.length||1)).map(c=>c.name+'='+c.value).join('; ');
}
async function bounded(response){const reader=response.body?.getReader();if(!reader)throw err('response_shape_unknown',false);let size=0;const chunks=[];try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1048576)throw err('response_limit',false);chunks.push(r.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(e){if(e.code)throw e;throw err('response_shape_unknown',false);}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
export function createIndependentDailyProvider(kind,{fetchImpl=globalThis.fetch,signer=signNativeRequest,now=()=>new Date()}={}){
 if(!origins[kind])throw err('platform_invalid');
 const request=async(op,c,body)=>{
  if(c?.platform!==kind||!(kind==='kling'?['https://klingai.com','https://klingai.kuaishou.com']:['https://jimeng.jianying.com']).includes(c?.origin))throw err('credential_origin_mismatch');
  const endpoint=c.origin;
  const pathname=paths[kind][op];if(!pathname)throw err('operation_invalid');const action=op==='claim';
  let url=new URL(pathname,endpoint),method=kind==='jimeng'&&op!=='identity'?'POST':'GET';let payload=body;
  const headers={Accept:'application/json','Content-Type':'application/json','Accept-Language':'zh-CN','User-Agent':NATIVE_USER_AGENT,Origin:endpoint,Referer:endpoint+(kind==='jimeng'?'/ai-tool/image/generate':'/')};
  if(kind==='kling'){
   if(op!=='identity'){
    const query=op==='balance'||op==='membership'?{scope:'PERSONAL'}:op==='history'?{scope:'PERSONAL',pageNum:1,pageSize:20,types:'membership,plan,reward,refund',startTime:0,endTime:now().getTime(),sceneType:0}:{};
    if(action){method='POST';payload={verifyType:-1};}
    const signed=await signer(kind,{origin:endpoint,path:pathname,query,body:payload,userAgent:NATIVE_USER_AGENT});url=new URL(signed.url);
    if(url.origin!==endpoint||url.pathname!==pathname||!url.searchParams.get('__NS_hxfalcon')||!url.searchParams.has('caver'))throw err('native_signature_invalid');
   }
  }else{
   payload=op==='history'?{count:20,cursor:'0'}:action?{time_zone:'Asia/Shanghai'}:{};
   const deviceTime=Math.floor(now().getTime()/1000),tdid=scalar(c.tdid)?c.tdid:'';
   if(op==='identity'){url.searchParams.set('aid','513695');url.searchParams.set('sdk_version','2.1.10-tiktok');}
   else Object.assign(headers,{appid:'513695',appvr:'8.4.0',pf:'7','sign-ver':'1','device-time':String(deviceTime),tdid,lan:'zh-Hans',loc:'cn',sign:createHash('md5').update(`9e2c|${url.pathname.slice(-7)}|7|8.4.0|${deviceTime}|${tdid}|11ac`).digest('hex')});
   if(action){url.searchParams.set('aid','513695');url.searchParams.set('device_platform','web');url.searchParams.set('region','cn');const xmst=c.securityState?.xmst;if(!scalar(xmst))throw err('native_signer_state_required');const signed=await signer(kind,{url:url.href,securityState:{xmst,...(scalar(c.securityState?.msuuid)?{msuuid:c.securityState.msuuid}:{})},userAgent:NATIVE_USER_AGENT});url=new URL(signed.url);if(url.origin!==origins[kind]||url.pathname!==pathname||!url.searchParams.get('msToken')||!url.searchParams.get('a_bogus'))throw err('native_signature_invalid');}
  }
  const cookie=cookieHeaderFor(url,c.cookies,now().getTime());if(!cookie)throw err('credential_cookie_missing');headers.Cookie=cookie;
  let response;try{response=await fetchImpl(url.href,{method,headers,redirect:'error',signal:AbortSignal.timeout(20000),...(method==='POST'?{body:JSON.stringify(payload??{})}:{})});}catch{throw err(action?'claim_transport_unknown':'read_transport_failed',!action);}
  if(!response.ok){await response.body?.cancel();throw err('official_http_'+response.status,!action||[401,403,429].includes(response.status));}
  const envelope=await bounded(response);
  if(kind==='kling'){if(envelope?.status!==200||envelope.error||!envelope.data)throw err('official_business_unknown',!action);return envelope.data;}
  if(op==='identity'){if(envelope?.message!=='success'||!envelope.data||envelope.data.error_code)throw err('login_required');return envelope.data;}
  if(String(envelope?.ret)!=='0'||!envelope.data)throw err('official_business_unknown',!action);return envelope.data;
 };
 const verifyIdentity=async c=>{const data=await request('identity',c),id=kind==='jimeng'?principal(data.user_id??data.uid):data.login===true?principal(data.userProfile?.userId):null;if(!id)throw err('canonical_identity_unknown');if(c.principal!=null&&String(c.principal)!==id)throw err('canonical_identity_mismatch');return {canonicalPrincipal:id};};
 const history=async c=>{
  const data=await request('history',c),rows=kind==='kling'?data:data.records;
  if(!Array.isArray(rows)||rows.length>100)throw err('history_shape_unknown');
  return rows.map(r=>kind==='kling'?{
   historyId:principal(r.orderId),amount:number(r.amount),createTime:number(r.createTime),
   title:typeof r.message==='string'?r.message.slice(0,256):'',
   userId:principal(r.userId),userIdPresent:Object.hasOwn(r,'userId'),historyType:r.type,
   // First-party payment UI maps extendedType = type, then extends consume
   // categories. It is not a proven required raw API field. Explicit contrary
   // wire evidence must nevertheless never be normalized away.
   extendedType:Object.hasOwn(r,'extendedType')?r.extendedType:r.type,
   subType:typeof r.subType==='string'?r.subType:null
  }:{
   historyId:principal(r.history_id),amount:number(r.amount),createTime:number(r.create_time),
   title:typeof r.title==='string'?r.title.slice(0,256):'',
   tradeSource:typeof r.trade_source==='string'?r.trade_source:'',
   userId:principal(r.user_id),userIdPresent:Object.hasOwn(r,'user_id'),historyType:r.history_type,status:r.status
  });
 };
 const typedDailyGrant=r=>kind==='jimeng'
  ?r.status==='Checked'&&r.historyType===1&&r.tradeSource==='FREEMIUM_RECEIVE'
  :r.historyType==='reward'&&r.extendedType==='reward'
   &&!/(退款|消费|到期|清零|refund|consume|expire)/i.test(r.title)
   &&/(?:每日|每天|daily)[^\n]{0,20}(?:登录|登入|login|log[- ]?in)|签到|check[- ]?in/i.test(r.title);
 // A daily-looking display title or a matching amount alone cannot establish
 // settlement. Missing or contradictory typed grant evidence fails closed.
 const todayRows=(rows,id)=>rows.filter(r=>r.historyId&&r.amount>0&&r.createTime>0
  &&(!r.userIdPresent||r.userId===id)&&typedDailyGrant(r)
  &&(r.createTime<1e12?r.createTime*1000:r.createTime)<=now().getTime()+60000
  &&day(new Date(r.createTime<1e12?r.createTime*1000:r.createTime))===day(now()));
 const status=async c=>{
  const identity=await verifyIdentity(c);
  if(kind==='jimeng'){const rows=todayRows(await history(c),identity.canonicalPrincipal);return {...identity,known:true,active:rows.length===0,claimed:rows.length>0,day:day(now()),details:{dailyHistory:rows,eligibility:'official_claim_response_required'}};}
  const membership=await request('membership',c);if(!Array.isArray(membership.membership)||membership.membership.length&&typeof membership.membership[0]?.type!=='string')throw err('membership_shape_unknown');const hasMembership=membership.membership.length>0&&membership.membership[0].type!=='none',rows=hasMembership?todayRows(await history(c),identity.canonicalPrincipal):[];return {...identity,known:true,active:hasMembership&&rows.length===0,claimed:rows.length>0,day:day(now()),reason:rows.length?'official_daily_history_present':hasMembership?'membership_daily_receipt_required':'membership_required',details:{hasMembership,dailyHistory:rows}};
 };
 const health=async c=>{const identity=await verifyIdentity(c),data=await request('balance',c);let value;if(kind==='kling'){value=number(data.total);if(value!==null)value/=100;}else{const credit=data.credit,values=['gift_credit','purchase_credit','vip_credit'].map(k=>number(credit?.[k]));if(values.every(v=>v!==null))value=values.reduce((a,b)=>a+b,0);}if(value==null)throw err('balance_shape_unknown');return {...identity,status:'authenticated',balance:{value,unit:'积分'},capabilities:{claimOnly:true,inference:false}};};
 const claim=async c=>{
  const before=await status(c);if(before.claimed)return {...before,submitted:false,alreadyClaimed:true,operationAttempted:false};if(!before.active)throw err('daily_not_available');
  let returnedReceipt=false;
  try{
  const startedAt=now().toISOString(),receipt=await request('claim',c);returnedReceipt=true;const afterIdentity=await verifyIdentity(c);if(afterIdentity.canonicalPrincipal!==before.canonicalPrincipal)throw err('canonical_identity_changed_after_claim',false);
  if(kind==='kling'){
   if(receipt.status!=='SUCCESS')throw err('daily_receipt_unconfirmed',false);const raw=number(receipt.rewardDetail?.pointPackage?.[0]?.points);if(raw===null)throw err('daily_receipt_shape_unknown',false);const rows=todayRows(await history(c),before.canonicalPrincipal),ids=new Set(before.details.dailyHistory.map(r=>r.historyId)),added=rows.filter(r=>!ids.has(r.historyId)&&r.amount===raw);if(raw>0&&added.length!==1)throw err('daily_history_unconfirmed',false);
   return {...afterIdentity,submitted:true,mutation:true,operationAttempted:true,automaticPerformed:true,serverConfirmed:true,claimed:raw>0,observed:raw===0,credit:raw/100,receipt:{source:paths.kling.claim,status:'SUCCESS',day:day(now()),checkedAt:now().toISOString(),pointsRaw:raw,historyId:added[0]?.historyId??null},rewardConfirmed:raw>0};
  }
  const quota=number(receipt.receive_quota);if(quota===null)throw err('daily_receipt_shape_unknown',false);const afterRows=todayRows(await history(c),before.canonicalPrincipal),ids=new Set(before.details.dailyHistory.map(r=>r.historyId)),newRows=afterRows.filter(r=>!ids.has(r.historyId)&&r.amount===quota);
  if(quota>0&&newRows.length!==1)throw err('daily_history_unconfirmed',false);
  return {...afterIdentity,submitted:true,mutation:true,operationAttempted:true,automaticPerformed:true,serverConfirmed:true,claimed:quota>0,rewardConfirmed:quota>0,credit:quota,observed:quota===0,receipt:{source:paths.jimeng.claim,day:day(now()),startedAt,checkedAt:now().toISOString(),amount:quota,historyId:newRows[0]?.historyId??null}};
  }catch(e){if(returnedReceipt)e.beforeSubmission=false;throw e;}
 };
 return Object.freeze({kind,claimOnly:true,inference:false,verifyIdentity,health,status,claim});
}
