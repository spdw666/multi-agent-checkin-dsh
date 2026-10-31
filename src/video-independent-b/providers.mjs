import {createHash} from 'node:crypto';
import {VIDEO_SESSION_AUTH_COOKIES,videoSessionCookieAlive} from '../video-session-vault.mjs';

// Original, offline-tested integration candidate. No browser/process/credential-file access.
// The caller supplies an explicitly authorized credential object and an encrypted-vault writer.
export class ProviderError extends Error { constructor(code){super(code);this.code=code;} }
const fail=c=>{throw new ProviderError(c);};
// 只有这些底层传输码值得重试。AppError 的业务码（video_session_expired 等）必须立刻上抛，
// 否则一次明确的登出会被当成网络抖动重放三次。
const TRANSPORT_RETRYABLE=new Set(['ECONNRESET','EPIPE','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const md5=s=>createHash('md5').update(s).digest('hex');
const sha=s=>createHash('sha256').update(s).digest('hex');
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const origins={xiaoyunque:['https://xyq.jianying.com','https://www.xiaoyunque.com'],hailuo:['https://hailuoai.com','https://hailuoai.video'],liblib:['https://www.liblib.art','https://www.liblib.tv']};
const allowedPaths={xiaoyunque:['/passport/web/account/info/','/commerce/v1/benefits/user_credit','/commerce/v1/benefits/user_credit_history','/commerce/v1/benefits/credit_receive'],hailuo:['/v1/api/user/info','/v1/api/user/renewal','/v1/api/billing/credit','/v1/api/billing/transactions','/v1/api/user/equity'],liblib:['/api/www/user/getUserInfo','/api/www/member/account','/api/www/power/translogs/management','/api/www/power/trans-sources']};
const clone=x=>structuredClone(x);
export function cookieDomainMatches(host,domain){if(typeof host!=='string'||typeof domain!=='string'||!domain)return false;const h=host.toLowerCase(),d=domain.toLowerCase();return d.startsWith('.')?(h===d.slice(1)||h.endsWith(d)):h===d;}
export function dayAt(t){const n=Number(t);if(!Number.isFinite(n)||n<=0)return null;const d=new Date(n<1e12?n*1000:n);return Number.isNaN(d.getTime())?null:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
const dayRange=now=>{const day=dayAt(now);const s=Date.parse(day+'T00:00:00+08:00')/1000;return {day,start:s,end:s+86399};};
export function xyqSign(path,now){const t=Math.floor(now/1000);return {'device-time':String(t),'sign-ver':'1',pf:'7',appvr:'5.8.0',sign:md5(`9e2c|${path.slice(-7)}|7|5.8.0|${t}||11ac`)};}
export function hailuoRequest({path,method='GET',body,query={},now,token,deviceContext={},origin='https://hailuoai.com'}){
 if(!origins.hailuo.includes(origin))fail('origin_not_allowed');
 const t=Math.floor(now/1000)*1000;
 const params={...query,device_platform:'web',app_id:'3001',version_code:'22203',biz_id:'0',unix:t,lang:origin==='https://hailuoai.video'?'en':'zh-Hans'};
 for(const [to,from] of Object.entries({uuid:'uuid',device_id:'deviceId',os_name:'osName',browser_name:'browserName',device_memory:'deviceMemory',cpu_core_num:'cpuCoreNum',browser_language:'browserLanguage',browser_platform:'browserPlatform',screen_width:'screenWidth',screen_height:'screenHeight'}))if(deviceContext[from]!==undefined)params[to]=deviceContext[from];
 const qs=new URLSearchParams();for(const [k,v] of Object.entries(params))if(k!=='client_scene'&&v!==null&&v!==undefined)qs.append(k,String(v));
 const target=path+'?'+qs.toString(), data=JSON.stringify(['POST','DELETE'].includes(method)?body??{}:{});
 return {url:origin+target,method,headers:{'Content-Type':'application/json',token,yy:md5(encodeURIComponent(target)+'_'+data+md5(String(t))+'ooui')},body:method==='GET'?undefined:data};
}
export function decodeXyq(body){if(body?.ret!=='0'||typeof body.response!=='string')fail('upstream_business_or_schema_error');let d;try{d=JSON.parse(body.response);}catch{fail('upstream_schema_error');}if(!d||typeof d!=='object')fail('upstream_schema_error');return d;}
function business(body,kind){if(kind==='hailuo'){if(body?.statusInfo?.code!==0||!body.data||typeof body.data!=='object')fail('upstream_business_or_schema_error');return body.data;}if(body?.code!==0||!body.data||typeof body.data!=='object')fail('upstream_business_or_schema_error');return body.data;}

// The official Art header reads attr.usablePower, with totalPower-usedPower
// as its legacy fallback. LibTV and model-card balances are independent buckets.
export function normalizeLiblibArtBalance(account){
 const attr=account?.attr;
 if(!attr||typeof attr!=='object'||Array.isArray(attr))fail('balance_schema_error');
 const nonnegative=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
 let value;
 if(attr.usablePower!==undefined&&attr.usablePower!==null){if(!nonnegative(attr.usablePower))fail('balance_schema_error');value=attr.usablePower;}
 else if(nonnegative(attr.totalPower)&&nonnegative(attr.usedPower))value=Math.max(0,attr.totalPower-attr.usedPower);
 else fail('balance_schema_error');
 const parts=[];for(const [key,name]of [['freeUsablePower','免费积分'],['rechargeUsablePower','充值积分']])if(nonnegative(attr[key]))parts.push({name,value:attr[key],unit:'积分'});
 return {value,unit:'积分',parts,source:'/api/www/member/account',balanceContract:'liblib_art_member_account',note:'Liblib Art 官网可用积分；LibTV 与模型卡积分独立计量'};
}

export function createProvider(input,deps={}){
 let credential=clone(input);const platform=credential.platform,origin=credential.origin;
 if(!origins[platform]?.includes(origin))fail('origin_not_allowed');
 const now=deps.now??Date.now,transport=deps.transport??jsonTransport;
 let inFlight=null,attempted=false,liblibOwnerId=null;const memoryReceipts=new Map();
 const apiOrigin=platform==='liblib'?'https://api2.liblib.art':origin;
 const cookies=(url)=>{const u=new URL(url);return (credential.cookies??[]).filter(c=>typeof c.name==='string'&&typeof c.value==='string'&&cookieDomainMatches(u.hostname,c.domain)&&(u.pathname===(c.path||'/')||u.pathname.startsWith((c.path||'/').replace(/\/$/,'')+'/'))&&(VIDEO_SESSION_AUTH_COOKIES.includes(c.name)?videoSessionCookieAlive(c):(!c.expirationDate||c.expirationDate*1000>now()))&&(!c.secure||u.protocol==='https:'));};
 const cookieValue=(names)=>{const c=cookies(origin+'/');for(const n of names){const v=c.find(x=>x.name===n)?.value;if(v){try{return decodeURIComponent(v);}catch{return v;}}}return '';};
 const cookieHeader=url=>cookies(url).map(c=>{if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name)||/[\r\n;]/.test(c.value))fail('invalid_cookie');return `${c.name}=${c.value}`;}).join('; ');
 const principalExpected=()=>typeof credential.principal==='string'?credential.principal:credential.principal?.id;
 const principalHash=id=>sha(`${platform}|${origin}|${id}`);
 const persist=async()=>{try{await deps.saveCredential?.(clone(credential));}catch{fail('vault_write_failed');}};
 const token=()=>credential.accessToken||cookieValue(platform==='hailuo'?['_token']:['liblibai_usertoken','usertoken','usertoken_online']);
 const request=async(path,method='GET',body,query={},opts={})=>{
  if(!allowedPaths[platform].includes(path))fail('path_not_allowed');
  // 传输层抖动最多 3 次尝试（15s x 3 仍在视频站 45s 预算内）；写类操作传 {retry:false}。签名/时间戳在循环内重建。
  const attempts=opts.retry===false?1:3;
  let res,lastError,req;
  for(let attempt=0;attempt<attempts;attempt++){
  if(platform==='hailuo'){
   const t=token();if(!t)fail('login_required');
   req=hailuoRequest({path,method,body,query,now:now(),token:t,deviceContext:credential.deviceContext,origin});
   const c=cookieHeader(req.url);if(c)req.headers.Cookie=c;
  }else{
   const u=new URL(path,apiOrigin);for(const [k,v] of Object.entries(query))if(v!==undefined&&v!==null)u.searchParams.append(k,String(v));
   let headers={'Content-Type':'application/json',Accept:'application/json',Origin:origin,Referer:origin+'/'};
   if(platform==='xiaoyunque'){
    const c=cookieHeader(u.href);if(!c)fail('login_required');
    headers={...headers,Cookie:c,appid:'795647','entrance-from':'web',loc:'CN',...xyqSign(path,now())};
    if(path.startsWith('/passport/')){const csrf=cookieValue(['passport_csrf_token','passport_csrf_token_default']);if(csrf)headers['x-tt-passport-csrf-token']=csrf;}
   }else{const t=token(),webid=cookieValue(['webid']);if(!t)fail('login_required');if(!webid)fail('webid_required');headers={...headers,token:t,webid};}
   req={url:u.href,method,headers,body:method==='GET'?undefined:JSON.stringify(body??null)};
  }
   try{res=await transport(req);lastError=undefined;break;}catch(e){if(e instanceof ProviderError||typeof e?.code==='string'&&!TRANSPORT_RETRYABLE.has(e.code)&&e.transient!==true)throw e;lastError=e;}
   if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)));
  }
  // 只重试「未拿到响应」；拿到响应后（含 4xx/5xx）一律按原语义判定。
  if(lastError)fail('transport_error');
  if(res?.status===401)fail('login_required');if(res?.status===403)fail('upstream_challenge_or_forbidden');
  if(!res||res.status<200||res.status>=300)fail('upstream_http_error');
  if(res.setCookies?.length&&deps.onSetCookies){const updated=await deps.onSetCookies(clone(credential),res.setCookies,req.url);if(updated){if(updated.platform!==platform||updated.origin!==origin||JSON.stringify(updated.principal)!==JSON.stringify(credential.principal))fail('credential_scope_changed');credential=clone(updated);await persist();}}
  return res.body;
 };
 // 身份查询不做缓存：每次重复调用都是为了与上一次比较（身份漂移检测、余额前后一致性），
 // 复用缓存会把两次不同答案假装成同一个，等于放行伪造的结算快照。health 层的成本在那里单独解决。
 const identity=async({bind=false}={})=>{
  let id,kind;
  if(platform==='xiaoyunque'){
   const b=await request('/passport/web/account/info/','GET',undefined,{aid:795647,is_from_ttaccountsdk:1,passport_jssdk_type:'normal',passport_jssdk_version:'4.1.5',account_sdk_source:'web'});
   const d=b?.data??b;if(b?.message!=='success'||typeof d?.user_id_str!=='string'||!d.user_id_str)fail('identity_schema_or_login_error');id=d.user_id_str;kind='user_id_str';
  }else if(platform==='hailuo'){const d=business(await request('/v1/api/user/info'),'hailuo');id=d.userInfo?.userID;kind='userID';}
  else{const d=business(await request('/api/www/user/getUserInfo','POST',null),'liblib');id=d.uuid;kind='uuid';liblibOwnerId=['string','number'].includes(typeof d.id)&&String(d.id)?String(d.id):null;}
  if(!['string','number'].includes(typeof id)||!String(id))fail('identity_schema_error');id=String(id);
  const expected=principalExpected();if(expected&&String(expected)!==id)fail('principal_mismatch');
  if(!expected&&bind){credential.principal={id,kind};await persist();}
  const value={authenticated:true,principalHash:principalHash(id),bound:!!principalExpected(),kind};
  return value;
 };
 const needIdentity=async()=>{const i=await identity();if(!i.bound)fail('principal_not_bound');return i;};
 const xyqHistory=async()=>{
  let cursor,rows=[],more=true;for(let page=0;page<4&&more;page++){
   const d=decodeXyq(await request('/commerce/v1/benefits/user_credit_history','POST',{cursor:cursor??'',count:20,history_type:1,need_with_hold:true}));
   if(!Array.isArray(d.records)||typeof d.has_more!=='boolean')fail('history_schema_error');rows.push(...d.records);more=d.has_more;
   if(more&&(!d.new_cursor||d.new_cursor===cursor))fail('history_cursor_error');cursor=d.new_cursor;
  }return {rows,complete:!more};
 };
 const hailuoHistory=async()=>{
  let cursor,rows=[],mode='cursor',more=true;for(let page=0;page<4&&more;page++){
   const d=business(await request('/v1/api/billing/transactions','GET',undefined,{page:mode==='offset'?page:0,page_size:30,transaction_type:3,pagination_mode:mode,...cursor?{cursor}:{}}),'hailuo');
   if(!Array.isArray(d.transactions)||typeof d.has_more!=='boolean'||!['cursor','offset'].includes(d.pagination_mode))fail('history_schema_error');
   if(mode==='cursor'&&d.pagination_mode==='offset'&&page===0){mode='offset';}
   else if(d.pagination_mode!==mode)fail('history_pagination_changed');
   rows.push(...d.transactions);more=d.has_more;if(mode==='cursor'&&more&&(!d.next_cursor||d.next_cursor===cursor))fail('history_cursor_error');cursor=d.next_cursor;
  }return {rows,complete:!more};
 };
 const liblibHistory=async()=>{
  const {start,end}=dayRange(now());let rows=[],total;for(let page=1;page<=4;page++){
   const d=business(await request('/api/www/power/translogs/management','POST',{page,pageSize:50,opTypeCode:1,startTime:start,endTime:end}),'liblib');
   if(!Array.isArray(d.data)||!Number.isSafeInteger(d.total)||d.total<0)fail('history_schema_error');rows.push(...d.data);total=d.total;if(rows.length>=total)return {rows,complete:true};
  }return {rows,complete:false};
 };
 const liblibDailyRows=(h,day,owner)=>{
  const end=Date.parse(day+'T00:00:00+08:00')/1000+86399;
  if(origin!=='https://www.liblib.art'||!owner)return [];
  const rows=h.rows.filter(r=>r.id&&r.status===null&&r.opTypeCode===1&&r.sourceCode===10&&r.sourceName==='每日登录赠送'&&r.transAmount===20&&String(r.userId)===owner&&dayAt(r.transTime)===day&&dayAt(r.effectStartTime)===day&&r.effectEndTime===end);
  return [...new Map(rows.map(r=>[String(r.id),r])).values()];
 };
 const xyqDailyRows=(h,day)=>[...new Map(h.rows.filter(r=>r.history_id&&r.trade_source==='FREEMIUM_RECEIVE'&&r.history_type===1&&r.status==='Checked'&&positive(r.amount)&&dayAt(r.create_time)===day&&(r.user_id===undefined||String(r.user_id)===String(principalExpected()))).map(r=>[String(r.history_id),r])).values()];
 const dailyStatus=async()=>{
  const i=await needIdentity(),day=dayAt(now());
  if(platform==='hailuo'){
   const d=business(await request('/v1/api/user/equity'),'hailuo');await needIdentity();
   return {known:true,active:false,alreadyClaimed:null,day,actualAward:0,reason:d.privilegeType===0&&d.isPaidSubscription===false?'current_free_trial_no_verified_daily':'daily_entitlement_contract_pending',equity:{privilegeType:d.privilegeType,isNewUser:d.isNewUser,isPaidSubscription:d.isPaidSubscription,totalCredits:d.totalCredits,trialExpireTime:d.trialExpireTime}};
  }
  const owner=liblibOwnerId,h=platform==='xiaoyunque'?await xyqHistory():await liblibHistory(),after=await needIdentity();
  if(!h.complete)fail('baseline_history_incomplete');if(after.principalHash!==i.principalHash||dayAt(now())!==day||platform==='liblib'&&owner!==liblibOwnerId)fail('observation_subject_or_day_changed');
  if(platform==='liblib'&&(origin!=='https://www.liblib.art'||!owner))return {known:true,active:false,alreadyClaimed:null,actualAward:0,day,reason:'daily_source_contract_pending'};
  const rows=platform==='xiaoyunque'?xyqDailyRows(h,day):liblibDailyRows(h,day,owner);
  return {known:true,active:rows.length===0,alreadyClaimed:rows.length>0,day,actualAward:0,availableCredits:rows.reduce((s,r)=>s+(platform==='xiaoyunque'?r.amount:r.transAmount),0),recordIds:rows.map(r=>String(platform==='xiaoyunque'?r.history_id:r.id)),historyComplete:true,reason:rows.length?'official_daily_credit_already_obtained':'official_daily_ledger_receipt_required'};
 };
 const claimLiblibArtDaily=()=>inFlight??=(async()=>{
  attempted=false;try{
   if(platform!=='liblib'||origin!=='https://www.liblib.art')fail('daily_source_contract_pending');
   const i=await needIdentity(),owner=liblibOwnerId,day=dayAt(now()),key=i.principalHash+':'+day;
   if(!owner)fail('identity_owner_alias_missing');
   const old=await deps.loadReceipt?.(key)??memoryReceipts.get(key);if(old?.attempted)return {status:'settlement_pending',operationAttempted:false,actualAward:0};
   const before=await liblibHistory();if(!before.complete)fail('baseline_history_incomplete');
   const existing=liblibDailyRows(before,day,owner);if(existing.length)return {status:'already_claimed',alreadyClaimed:true,operationAttempted:false,actualAward:0,availableCredits:existing.reduce((s,r)=>s+r.transAmount,0)};
   const ids=new Set(before.rows.map(r=>String(r.id)));await markAttempt(key,i,day,[...ids]);
   business(await request('/api/www/member/account','GET',undefined,{isApp:false}),'liblib');
   const after=await liblibHistory(),identityAfter=await needIdentity();
   const rows=liblibDailyRows(after,day,owner).filter(r=>!ids.has(String(r.id)));
   if(!after.complete||identityAfter.principalHash!==i.principalHash||liblibOwnerId!==owner||dayAt(now())!==day||rows.length!==1)return {status:'settlement_unknown',operationAttempted:true,actualAward:0};
   const receipt={kind:'liblib_art_daily',principalHash:i.principalHash,day,amount:20,recordIds:rows.map(r=>String(r.id)),sourceCode:10,sourceName:'每日登录赠送',effectEndTime:rows[0].effectEndTime,settled:true};
   memoryReceipts.set(key,receipt);await deps.saveReceipt?.(key,receipt);return {status:'claimed',operationAttempted:true,actualAward:20,receipt};
  }catch(e){return {status:attempted?'settlement_unknown':'precondition_failed',code:e instanceof ProviderError?e.code:'internal_error',operationAttempted:attempted,actualAward:0};}finally{inFlight=null;}
 })();
 const status=async()=>{
  const i=await needIdentity();
  if(platform==='xiaoyunque'){const d=decodeXyq(await request('/commerce/v1/benefits/user_credit','POST',{}));const credit={};for(const k of ['vip_credit','gift_credit','purchase_credit','free_credits'])if(Number.isFinite(d.credit?.[k]))credit[k]=d.credit[k];return {...i,status:'authenticated',balanceContract:'user_credit',credit,actualAward:0};}
  if(platform==='hailuo'){const d=business(await request('/v1/api/billing/credit'),'hailuo');if(!Array.isArray(d.sub_credits))fail('balance_schema_error');return {...i,status:'authenticated',totalCredit:d.total_credit,loginGiftCredit:d.sub_credits.filter(x=>x.credit_type===3).reduce((s,x)=>s+(Number.isFinite(x.credit)?x.credit:0),0),actualAward:0};}
  // The official wallet GET also performs daily login initialization. Observe it
  // only after a complete, same-owner daily receipt proves today's initialization
  // is already settled. A balance refresh must never become an unleased claim.
  const day=dayAt(now()),owner=liblibOwnerId,h=await liblibHistory();
  const base={...i,status:'authenticated',todayObtainedRows:h.rows.length,historyComplete:h.complete,actualAward:0,accountGetReservedForClaim:true};
  const pending=reason=>({...base,balanceKnown:false,balanceReason:reason});
  if(origin!=='https://www.liblib.art'||!owner)return pending('liblib_art_wallet_source_unverified');
  if(!h.complete)return pending('liblib_balance_history_incomplete');
  if(!liblibDailyRows(h,day,owner).length)return pending('liblib_balance_requires_settled_daily_receipt');
  const end=(dayRange(now()).end+1)*1000;
  if(end-now()<120000)return pending('liblib_balance_daily_boundary_pending');
  const before=await needIdentity();
  if(before.principalHash!==i.principalHash||owner!==liblibOwnerId||dayAt(now())!==day)fail('observation_subject_or_day_changed');
  if(end-now()<120000)return pending('liblib_balance_daily_boundary_pending');
  const checksum=rows=>sha(JSON.stringify(rows.map(r=>({id:r.id,status:r.status,opTypeCode:r.opTypeCode,sourceCode:r.sourceCode,sourceName:r.sourceName,transAmount:r.transAmount,userId:r.userId,transTime:r.transTime,effectStartTime:r.effectStartTime,effectEndTime:r.effectEndTime})).sort((a,b)=>String(a.id).localeCompare(String(b.id)))));
  const beforeChecksum=checksum(h.rows);
  const account=business(await request('/api/www/member/account','GET',undefined,{isApp:false}),'liblib');
  if(String(account.userId)!==owner||account.ownerUuid!==principalExpected())fail('liblib_balance_owner_mismatch');
  const after=await liblibHistory(),identityAfter=await needIdentity();
  if(!after.complete||identityAfter.principalHash!==i.principalHash||owner!==liblibOwnerId||dayAt(now())!==day||!liblibDailyRows(after,day,owner).length||beforeChecksum!==checksum(after.rows))fail('liblib_balance_snapshot_changed');
  return {...base,balanceKnown:true,balance:normalizeLiblibArtBalance(account),balanceProof:{day,sourceCode:10,receiptAlreadySettled:true,historyChecksum:beforeChecksum,historyUnchanged:true,observedAt:new Date(now()).toISOString()}};
 };
 const refresh=async()=>{
  if(platform!=='hailuo'){const i=await needIdentity();return {...i,status:'session_revalidated',rotated:false,refreshGrant:'no separate refresh endpoint verified'};}
  if(!principalExpected())fail('principal_not_bound');
  const d=business(await request('/v1/api/user/renewal','POST',{},undefined,{retry:false}),'hailuo');
  if(typeof d.token==='string'&&d.token){credential.accessToken=d.token;await persist();}
  const next=await needIdentity();return {...next,status:'session_revalidated',rotated:typeof d.token==='string'&&!!d.token};
 };
 const markAttempt=async(key,id,day,beforeIds=[])=>{const pending={kind:platform+'_daily_attempt',principalHash:id.principalHash,day,beforeIds,attempted:true,settled:false};await deps.saveReceipt?.(key,pending);memoryReceipts.set(key,pending);attempted=true;};
 const preservePositiveResponse=async(key,quota)=>{const pending={...memoryReceipts.get(key),positiveOfficialQuota:quota};memoryReceipts.set(key,pending);await deps.saveReceipt?.(key,pending);};
 const claimImpl=async()=>{
  const id=await needIdentity(),day=dayAt(now()),key=id.principalHash+':'+day;
  const old=await deps.loadReceipt?.(key)??memoryReceipts.get(key);if(old?.settled)return {status:'already_claimed',receipt:old,operationAttempted:false,actualAward:0};if(old?.attempted)return {status:'settlement_pending',operationAttempted:false,actualAward:0};
  if(platform==='xiaoyunque'){
   const before=await xyqHistory();if(!before.complete)fail('baseline_history_incomplete');const ids=new Set(before.rows.map(x=>String(x.history_id)));
   await markAttempt(key,id,day,[...ids]);let d;try{d=decodeXyq(await request('/commerce/v1/benefits/credit_receive','POST',{source:'web'},undefined,{retry:false}));}catch(e){return {status:'settlement_unknown',code:e.code,operationAttempted:true,actualAward:0};}
   if(!Number.isFinite(d.receive_quota)||d.receive_quota<0)return {status:'settlement_unknown',operationAttempted:true,actualAward:0};
   if(d.receive_quota===0)return {status:'no_new_quota',operationAttempted:true,actualAward:0};
   await preservePositiveResponse(key,d.receive_quota);
   const after=await xyqHistory(),afterId=await needIdentity();
   const rows=after.rows.filter(r=>r.history_id&&!ids.has(String(r.history_id))&&r.trade_source==='FREEMIUM_RECEIVE'&&r.history_type===1&&r.status==='Checked'&&positive(r.amount)&&dayAt(r.create_time)===day);
   const unique=[...new Map(rows.map(r=>[String(r.history_id),r])).values()];
   if(!after.complete||afterId.principalHash!==id.principalHash||dayAt(now())!==day||unique.reduce((s,r)=>s+r.amount,0)!==d.receive_quota)return {status:'settlement_unknown',operationAttempted:true,actualAward:0,positiveOfficialResponse:d.receive_quota};
   const receipt={kind:'xiaoyunque_daily',principalHash:id.principalHash,day,amount:d.receive_quota,recordIds:unique.map(r=>String(r.history_id)),settled:true};memoryReceipts.set(key,receipt);await deps.saveReceipt?.(key,receipt);return {status:'claimed',operationAttempted:true,actualAward:receipt.amount,receipt};
  }
  if(platform==='liblib'){
   const before=await liblibHistory();if(!before.complete)fail('baseline_history_incomplete');const ids=new Set(before.rows.map(x=>String(x.id)));
   await markAttempt(key,id,day,[...ids]);let d;try{d=business(await request('/api/www/member/account','GET',undefined,{isApp:false}),'liblib');}catch(e){return {status:'settlement_unknown',code:e.code,operationAttempted:true,actualAward:0};}
   if(positive(d.todaySendFreePower))await preservePositiveResponse(key,d.todaySendFreePower);
   const after=await liblibHistory(),afterId=await needIdentity();
   const rows=after.rows.filter(r=>r.id&&!ids.has(String(r.id))&&positive(r.transAmount)&&dayAt(r.transTime)===day);
   const sources=deps.verifiedDailySourceNames??[];
   const daily=rows.filter(r=>sources.includes(r.sourceName)),unique=[...new Map(daily.map(r=>[String(r.id),r])).values()];
   const amount=unique.reduce((s,r)=>s+r.transAmount,0);
   if(sources.length&&after.complete&&afterId.principalHash===id.principalHash&&dayAt(now())===day&&positive(d.todaySendFreePower)&&amount===d.todaySendFreePower){const receipt={kind:origin.endsWith('.art')?'liblib_art_daily':'libtv_daily',principalHash:id.principalHash,day,amount,recordIds:unique.map(r=>String(r.id)),settled:true};memoryReceipts.set(key,receipt);await deps.saveReceipt?.(key,receipt);return {status:'claimed',actualAward:amount,operationAttempted:true,receipt};}
   return {status:!sources.length?'daily_source_contract_pending':'no_new_daily_receipt',operationAttempted:true,actualAward:0,todaySendFreePower:d.todaySendFreePower,newObtainedRowCount:rows.length};
  }
  // Current official CN startup calls renewal. Its presence is not proof of universal daily entitlement.
  const before=await hailuoHistory();if(!before.complete)fail('baseline_history_incomplete');
  await markAttempt(key,id,day);await refresh();const after=await hailuoHistory(),afterId=await needIdentity();
  return {status:'daily_entitlement_contract_pending',operationAttempted:true,actualAward:0,renewalPerformed:true,principalUnchanged:afterId.principalHash===id.principalHash,historyBefore:before.rows.length,historyAfter:after.rows.length,historyComplete:after.complete};
 };
 const claim=()=>inFlight??=(async()=>{attempted=false;try{return await claimImpl();}catch(e){return {status:attempted?'settlement_unknown':'precondition_failed',code:e instanceof ProviderError?e.code:'internal_error',operationAttempted:attempted,actualAward:0};}finally{inFlight=null;}})();
 return {platform,origin,verifyIdentity:identity,status,dailyStatus,claimLiblibArtDaily,claim,refresh,getCredential:()=>clone(credential)};
}

export async function jsonTransport(req){
 const res=await fetch(req.url,{method:req.method,headers:req.headers,body:req.body,redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(res.status>=300&&res.status<400)fail('redirect_requires_reauthentication');
 let body;try{body=await res.json();}catch{fail('non_json_upstream_response');}
 return {status:res.status,body,setCookies:res.headers.getSetCookie?.()??[]};
}
