import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AppError,dayIn} from './util.mjs';
import {readVideoSessionVault,writeVideoSessionVault,validateVideoSessionImport} from './video-session-vault.mjs';
import {createIndependentDailyProvider,cookieHeaderFor} from './video-independent-a/independent-daily-provider.mjs';
import {createProvider as createBProvider} from './video-independent-b/providers.mjs';
import {applyOfficialSetCookies} from './official-set-cookies.mjs';

export const INDEPENDENT_VIDEO_KINDS=Object.freeze(['jimeng','kling','xiaoyunque','hailuo','liblib']);
const origins={jimeng:['https://jimeng.jianying.com'],kling:['https://klingai.com','https://klingai.kuaishou.com'],xiaoyunque:['https://xyq.jianying.com','https://www.xiaoyunque.com'],hailuo:['https://hailuoai.com','https://hailuoai.video'],liblib:['https://www.liblib.art','https://www.liblib.tv']};
const sources={jimeng:'/commerce/v1/benefits/credit_receive',kling:'/api/pay/reward/v2',xiaoyunque:'/commerce/v1/benefits/credit_receive',liblib:'/api/www/member/account'};
const bPaths={xiaoyunque:new Set(['/passport/web/account/info/','/commerce/v1/benefits/user_credit','/commerce/v1/benefits/user_credit_history','/commerce/v1/benefits/credit_receive']),hailuo:new Set(['/v1/api/user/info','/v1/api/user/renewal','/v1/api/billing/credit','/v1/api/billing/transactions','/v1/api/user/equity']),liblib:new Set(['/api/www/user/getUserInfo','/api/www/member/account','/api/www/power/translogs/management','/api/www/power/trans-sources'])};
const aPaths={jimeng:new Set(['/passport/account/info/v2/','/commerce/v1/benefits/user_credit','/commerce/v1/benefits/user_credit_history','/commerce/v1/benefits/credit_receive']),kling:new Set(['/api/user/profile_and_features','/api/account/pointAndTicket','/api/account/contract','/api/account/trade','/api/pay/reward/v2'])};
const grants=new WeakSet();
const sha=v=>createHash('sha256').update(v).digest('hex');
const failure=(code,beforeSubmission=true,status=502)=>Object.assign(new AppError('视频每日权益合同待核验',status,code),{beforeSubmission,...(/login|identity_pending|credential|vault/.test(code)?{loginRequired:true}:{})});
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const frozen=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;};
const receiptKey=(kind,origin,principal,day)=>[kind,origin,principal,day].join('\0');
const nextWindow=date=>new Date(Date.parse(dayIn(date,'Asia/Shanghai')+'T00:00:00+08:00')+86400000).toISOString();
const checkTask=task=>{if(task!=='daily-checkin')throw failure('video_daily_task_invalid',true,400);};
async function fileHash(file){const s=await stat(file);if(s.size>2097152)throw failure('video_vault_size_invalid');return sha(await readFile(file));}
function proofView(r){return {kind:r.kind,origin:r.origin,principalHash:r.principalHash,day:r.day,amount:r.amount,source:r.source,checkedAt:r.checkedAt,recordIds:[...r.recordIds],proofVersion:1};}

// Only an in-process receipt minted AFTER the frozen adapter's official result
// and a fresh identity/source/day check may establish a new gateway settlement.
export function independentVideoSettlement(kind,principalHash,claim,day){
 const r=claim?.officialDailyReceipt;
 if(!INDEPENDENT_VIDEO_KINDS.includes(kind)||!r||!grants.has(r)||r.kind!==kind||r.principalHash!==principalHash||r.day!==day||dayIn(new Date(r.checkedAt),'Asia/Shanghai')!==day||!finite(r.amount))return null;
 return {status:r.amount>0?'success':'observed',result:{serverConfirmed:true,claimed:r.amount>0,credits:r.amount,benefitOutcome:r.amount>0?'newly_granted':'no_new_daily_credit',reason:r.amount>0?'official_independent_daily_ledger':'official_independent_daily_zero',officialDailyReceipt:proofView(r)}};
}
// A durable, previously verified receipt may suppress another write, but never
// be turned back into a new WeakSet-branded grant or a new automatic reward.
export function retainIndependentVideoReceipt(kind,principalHash,prior,day){
 const r=prior?.officialDailyReceipt;
 if(!['jimeng','kling','xiaoyunque','liblib'].includes(kind)||kind==='liblib'&&r?.origin!=='https://www.liblib.art'||prior?.serverConfirmed!==true||!r||r.proofVersion!==1||r.kind!==kind||r.principalHash!==principalHash||!origins[kind].includes(r.origin)||r.source!==sources[kind]||r.day!==day||!finite(r.amount)||prior.credits!==r.amount||!Array.isArray(r.recordIds)||r.amount>0&&(!r.recordIds.length||!r.recordIds.every(text)||new Set(r.recordIds).size!==r.recordIds.length)||!Number.isFinite(Date.parse(r.checkedAt))||Date.parse(r.checkedAt)>Date.now()||dayIn(new Date(r.checkedAt),'Asia/Shanghai')!==day)return null;
 return {reason:'official_independent_daily_receipt_retained',credits:r.amount,claimed:r.amount>0,observed:r.amount===0,serverConfirmed:true,benefitOutcome:'available_before_run',retainedOfficialReceipt:true,submitted:false,mutation:false,automaticPerformed:false,officialDailyReceipt:{...r,recordIds:[...r.recordIds]}};
}

export function createGatewayVideoProvider(kind,{readVault=readVideoSessionVault,writeVault=writeVideoSessionVault,fetchImpl=(...args)=>globalThis.fetch(...args),signer,transport,now=()=>new Date(),makeA=createIndependentDailyProvider,makeB=createBProvider}={}){
 if(!INDEPENDENT_VIDEO_KINDS.includes(kind))throw failure('video_daily_platform_invalid');
 const certified=new WeakMap(),receiptsByDay=new Map(),attempts=new Map();
 async function resolve(account,config){
  if(account.platform!==kind||account.credentials?.kind!=='file'||typeof account.credentials.file!=='string'||!account.credentials.file||account.credentials.file==='auto')throw failure('video_daily_credentials_invalid',true,401);
  const file=config.path(account.credentials.file);let before,session;
  let coherent=false;
  for(let round=0;round<3;round++){
   try{before=await fileHash(file);session=await readVault(file,{platform:kind});if(await fileHash(file)===before){coherent=true;break;}}catch(e){if(e.code==='ENOENT')throw failure('video_session_identity_pending',true,401);throw e;}
  }
  if(!coherent)throw failure('video_session_source_changed',true,409);
  if(session.source!=='windows-current-user-dpapi'||session.platform!==kind||!text(session.principal)||session.principalHash!==sha(kind+'\0'+session.principal)||!origins[kind].includes(session.origin))throw failure('video_vault_source_or_subject_invalid',true,401);
  if(session.expiresAtMs!==undefined&&(!Number.isFinite(session.expiresAtMs)||session.expiresAtMs<=now().getTime()))throw failure('video_session_expired',true,401);
  frozen(session);certified.set(session,{kind,file,hash:before,origin:session.origin,principal:session.principal,principalHash:session.principalHash,currentSession:session,writeFlight:null,revoked:false});
  return {accessToken:'dpapi-session:'+session.principalHash,principal:session.principal,principalHash:session.principalHash,expiresAtMs:session.expiresAtMs,filePath:file,source:'windows-current-user-dpapi',videoSession:session};
 }
 async function context(c){
  const capability=c?.videoSession,cert=certified.get(capability),isA=['jimeng','kling'].includes(kind);
  const unchanged=async()=>{try{return await fileHash(cert.file)===cert.hash;}catch{return false;}};
  if(!cert||cert.kind!==kind||c.source!=='windows-current-user-dpapi'||c.filePath!==cert.file||c.principal!==cert.principal||c.principalHash!==cert.principalHash||capability.origin!==cert.origin||!await unchanged())throw failure('video_session_source_changed',true,409);
  const live=()=>{if(cert.revoked||cert.currentSession.expiresAtMs!==undefined&&cert.currentSession.expiresAtMs<=now().getTime())throw failure('video_session_expired',true,401);return cert.currentSession;};
  live();
  const cleanOf=next=>{
   if(next.platform!==kind||next.origin!==cert.origin||(typeof next.principal==='string'?next.principal:next.principal?.id)!==cert.principal)throw failure('video_official_principal_changed',true,409);
   return validateVideoSessionImport({platform:kind,origin:next.origin,cookies:next.cookies,...(next.accessToken===undefined?{}:{accessToken:next.accessToken}),...(next.expiresAtMs===undefined?{}:{expiresAtMs:next.expiresAtMs}),...(next.securityState===undefined?{}:{securityState:next.securityState}),principal:null,identityEvidence:{kind:'pending-direct-verification'}});
  };
  const serial=fn=>{const active=(cert.writeFlight??Promise.resolve()).catch(()=>{}).then(fn);cert.writeFlight=active;return active.finally(()=>{if(cert.writeFlight===active)cert.writeFlight=null;});};
  const assertIdentity=i=>{if(isA?i.canonicalPrincipal!==cert.principal:i.authenticated!==true||i.bound!==true||i.principalHash!==sha(kind+'|'+cert.origin+'|'+cert.principal))throw failure('video_official_principal_changed',true,409);return i;};
  const endpoint=url=>{
   const u=new URL(url),target=kind==='liblib'?'https://api2.liblib.art':cert.origin;
   if(u.origin!==target||u.username||u.password||u.port||!(isA?aPaths:bPaths)[kind]?.has(u.pathname))throw failure('video_daily_endpoint_invalid');
   return u;
  };
  // liblib 成功响应实测 0.3~1.5s，变慢只发生在死连接上：10s 足够一次尝试，
 // 重试换新连接就能拿到响应，也不必让一次 health 的串行请求吃穿外层预算。
 const rawFetch=async(url,opt)=>{endpoint(url);return fetchImpl(url,{...opt,redirect:'error',signal:AbortSignal.timeout(10000)});};
  const boundedTransport=async(req,fetcher=rawFetch)=>{
   const u=new URL(req.url),target=kind==='liblib'?'https://api2.liblib.art':cert.origin;
   if(u.origin!==target||u.username||u.password||u.port||!bPaths[kind]?.has(u.pathname))throw failure('video_daily_endpoint_invalid');
   // A missing response is a transport fact, not a verdict: mark it transient so the
 // retry loop replays it instead of surfacing one unlucky attempt as the contract.
 let response;try{response=await fetcher(req.url,{method:req.method,headers:req.headers,body:req.body});}catch(error){throw Object.assign(failure('video_daily_transport_unknown',false),{transient:true,transportCode:error?.code??error?.name??'unknown'});}
   const reader=response.body?.getReader();if(!reader)throw failure('video_daily_response_invalid',false);let count=0;const chunks=[];
   try{for(;;){const step=await reader.read();if(step.done)break;count+=step.value.length;if(count>1048576)throw failure('video_daily_response_too_large',false);chunks.push(step.value);}return {status:response.status,body:JSON.parse(Buffer.concat(chunks).toString('utf8')),setCookies:response.headers.getSetCookie?.()??[]};}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  };
  const writeCurrent=async next=>{
   const clean=cleanOf(next);if(!await unchanged())throw failure('video_session_source_changed',true,409);
   if(JSON.stringify(clean)===JSON.stringify(cleanOf(cert.currentSession)))return cert.currentSession;
   await writeVault(cert.file,clean,{principal:cert.principal,expectedPrincipalHash:cert.principalHash,expectedSourceHash:cert.hash});
   const after=await fileHash(cert.file),read=await readVault(cert.file,{platform:kind});
   if(await fileHash(cert.file)!==after||read.source!=='windows-current-user-dpapi'||read.principalHash!==cert.principalHash||JSON.stringify(cleanOf(read))!==JSON.stringify(clean))throw failure('video_session_write_conflict',false,409);
   // Commit both together. The original immutable WeakMap capability is never replaced.
   cert.currentSession=frozen(read);cert.hash=after;return cert.currentSession;
  };
  // Only the observed api2.liblib.art traffic cookie may rotate without
  // recertifying unchanged authentication material; every other change is strict.
  const wafOnly=(before,after,names)=>kind==='liblib'&&names.length>0&&names.every(n=>n==='acw_tc')&&
   JSON.stringify({...before,cookies:before.cookies.filter(c=>c.name!=='acw_tc')})===JSON.stringify({...after,cookies:after.cookies.filter(c=>c.name!=='acw_tc')})&&
   after.cookies.filter(c=>c.name==='acw_tc').every(c=>c.domain==='api2.liblib.art'&&c.path==='/'&&c.httpOnly===true);
  // The global site rotates these two observed traffic cookies on every GET.
  // Retain them in this request context, not as a new login/vault generation.
  // Every auth field, subject, source and non-traffic cookie remains byte-equal.
  const hailuoTrafficOnly=(before,after,names)=>{
   if(kind!=='hailuo'||cert.origin!=='https://hailuoai.video'||names.length===0||!names.every(n=>n==='_abck'||n==='ak_bmsc'))return false;
   const traffic=c=>c.name==='_abck'||c.name==='ak_bmsc';
   const strip=value=>({...value,cookies:value.cookies.filter(c=>!traffic(c))});
   if(JSON.stringify(strip(before))!==JSON.stringify(strip(after)))return false;
   for(const name of names){
    const old=before.cookies.filter(c=>c.name===name),next=after.cookies.filter(c=>c.name===name);
    if(old.length!==1||next.length!==1)return false; // additions/deletions still recertify
    const valid=c=>c.domain==='.hailuoai.video'&&c.path==='/'&&c.secure===true&&c.sameSite==='no_restriction'&&c.httpOnly===(name==='ak_bmsc');
    if(!valid(old[0])||!valid(next[0])||!next[0].value||!Number.isFinite(next[0].expirationDate)||next[0].expirationDate*1000<=now().getTime())return false;
    const stable=c=>{const {value,expirationDate,...rest}=c;return rest;};
    if(JSON.stringify(stable(old[0]))!==JSON.stringify(stable(next[0])))return false;
   }
   return true;
  };
  const verifyCandidate=async candidate=>{
   // Every newly issued auth value must itself authenticate as the bound user.
   // A server that rotates forever is not silently certified from a predecessor.
   for(let round=0;round<3;round++){
    const issued=[];
    const captureFetch=async(url,opt)=>{const u=endpoint(url);if(u.pathname!==(kind==='jimeng'?'/passport/account/info/v2/':'/api/user/profile_and_features'))throw failure('video_identity_endpoint_invalid');const r=await rawFetch(url,opt);issued.push({headers:r.headers.getSetCookie?.()??[],url});return r;};
    const captureTransport=async req=>{endpoint(req.url);const expected={xiaoyunque:'/passport/web/account/info/',hailuo:'/v1/api/user/info',liblib:'/api/www/user/getUserInfo'}[kind];if(new URL(req.url).pathname!==expected)throw failure('video_identity_endpoint_invalid');const r=await (transport??boundedTransport)(req);issued.push({headers:r.setCookies??[],url:req.url});return {...r,setCookies:[]};};
    const verifier=isA?makeA(kind,{fetchImpl:captureFetch,...(signer?{signer}:{}),now}):makeB(candidate,{transport:captureTransport,now:()=>now().getTime()});
    let identityError;try{assertIdentity(isA?await verifier.verifyIdentity(candidate):await verifier.verifyIdentity());}catch(e){identityError=e;}
    let result=candidate,names=[];for(const item of issued){const merged=applyOfficialSetCookies(result,item.headers,item.url,{now:now().getTime()});if(merged.logout)return invalidate(merged.session);names.push(...merged.changedNames);result=merged.session;}
    if(identityError)throw identityError;
    cleanOf(result);if(JSON.stringify(result)===JSON.stringify(candidate)||wafOnly(candidate,result,names)||hailuoTrafficOnly(candidate,result,names))return result;candidate=result;
   }
   throw failure('video_session_rotation_unstable',true,409);
  };
  const invalidate=async next=>{
   const dead=structuredClone(next);delete dead.accessToken;dead.expiresAtMs=1;
   // An expired, unsendable tombstone lets the existing strict vault represent logout,
   // including deletion of the sole auth cookie, without retaining an active fallback.
   if(!dead.cookies.length)dead.cookies=cert.currentSession.cookies.map(cookie=>({...cookie,expirationDate:1}));
   try{await writeCurrent(dead);}finally{cert.revoked=true;}
   throw failure('video_session_expired',true,401);
  };
  const onSetCookies=async(_snapshot,headers,url)=>serial(async()=>{
   const current=live();if(!await unchanged())throw failure('video_session_source_changed',true,409);
   const merged=applyOfficialSetCookies(current,headers,url,{now:now().getTime()});if(merged.logout)return invalidate(merged.session);
   // Liblib sends token/webid headers, not cookies. Its per-response acw_tc
   // traffic cookie does not change authentication and must not churn the shared
   // credential file across consumers. All auth/non-WAF changes remain strict.
   if(!merged.changed||wafOnly(current,merged.session,merged.changedNames))return null;
   if(hailuoTrafficOnly(current,merged.session,merged.changedNames)){
    cert.currentSession=frozen(merged.session);
    return structuredClone(cert.currentSession);
   }
   return structuredClone(await writeCurrent(await verifyCandidate(merged.session)));
  });
  const saveCredential=async next=>serial(async()=>{
   live();const clean=cleanOf(next);
   if(JSON.stringify(clean)===JSON.stringify(cleanOf(cert.currentSession))){if(!await unchanged())throw failure('video_session_source_changed',true,409);return;}
   // Parallel B readers may try to persist an older traffic-only response after
   // another reader advanced the in-memory jar. Keep the latest jar, never
   // roll traffic back or turn that benign race into an authentication error.
   const trafficNames=['_abck','ak_bmsc'].filter(name=>JSON.stringify(next.cookies.filter(c=>c.name===name))!==JSON.stringify(cert.currentSession.cookies.filter(c=>c.name===name)));
   if(hailuoTrafficOnly(next,cert.currentSession,trafficNames)){if(!await unchanged())throw failure('video_session_source_changed',true,409);return;}
   // A stale B instance may not roll newer cookies back while renewing a token.
   if(JSON.stringify(next.cookies)!==JSON.stringify(cert.currentSession.cookies))throw failure('video_session_snapshot_changed',true,409);
   await writeCurrent(await verifyCandidate(next));
  });
  const rotatingFetch=async(url,opt)=>{
   endpoint(url);const headers=new Headers(opt.headers),cookie=cookieHeaderFor(url,live().cookies,now().getTime());if(!cookie)throw failure('video_session_token_missing',true,401);headers.set('Cookie',cookie);
   const r=await rawFetch(url,{...opt,headers});try{const values=r.headers.getSetCookie?.()??[];if(values.length)await onSetCookies(live(),values,url);}catch(e){await r.body?.cancel();throw e;}return r;
  };
  const rotatingTransport=async req=>{
   const r=await (transport??boundedTransport)(req);
   // B normally invokes onSetCookies after a 2xx check. A rejected response may
   // also revoke a token; retain that official deletion instead of reusing it.
   if(r?.setCookies?.length&&(r.status<200||r.status>=300)){await onSetCookies(live(),r.setCookies,req.url);return {...r,setCookies:[]};}
   return r;
  };
  // A reads properties for every request; proxy them to the latest verified snapshot.
  const s=isA?new Proxy({}, {get:(_target,key)=>live()[key]}):live();
  const provider=isA?makeA(kind,{fetchImpl:rotatingFetch,...(signer?{signer}:{}),now}):makeB(s,{transport:rotatingTransport,now:()=>now().getTime(),saveCredential,onSetCookies});
  const identity=async()=>{
   let i;try{i=assertIdentity(isA?await provider.verifyIdentity(s):await provider.verifyIdentity());}catch(e){if(cert.revoked)throw failure('video_session_expired',true,401);throw e;}
   if(!await unchanged())throw failure('video_session_source_changed',true,409);
   return i;
  };
  return {s,cert,provider,identity};
 }
 async function status(c,task='daily-checkin'){
  // dailyStatus() 自己做 needIdentity + after 比较，这里再读一次身份纯属重复请求
  // （liblib 一次 health 已串行 12 次上游调用，全压在这条链上）。
  checkTask(task);const x=await context(c);const date=now(),day=dayIn(date,'Asia/Shanghai'),window=nextWindow(date),key=receiptKey(kind,x.cert.origin,x.cert.principal,day),cached=receiptsByDay.get(key);
  if(cached)return {known:true,active:false,claimed:cached.amount>0,observed:cached.amount===0,day,credits:cached.amount,nextClaimAt:window,reason:'official_independent_daily_receipt_cached'};
  if(['hailuo','liblib','xiaoyunque'].includes(kind)){
   const observed=await x.provider.dailyStatus();
   return {known:observed.known===true,active:observed.active===true,claimed:observed.alreadyClaimed===true?true:null,day,nextClaimAt:window,credits:observed.availableCredits??null,reason:observed.reason,details:{authenticated:true,claimOnly:true,historyComplete:observed.historyComplete,equity:observed.equity,observedExistingCredit:observed.alreadyClaimed===true}};
  }
  const r=await x.provider.status(x.s);return {...r,claimed:r.claimed===true?true:null,nextClaimAt:window};
 }
 async function claim(c,task='daily-checkin'){
  checkTask(task);let x;const start=now(),day=dayIn(start,'Asia/Shanghai');
  // ClaimService has reserved/marked its durable slot before calling us, but
  // these are still identity/file reads, not dispatch of the daily operation.
  try{x=await context(c);await x.identity();}catch(e){e.beforeSubmission=true;throw e;}
  if(kind==='hailuo'||kind==='liblib'&&x.cert.origin!=='https://www.liblib.art')throw failure(kind==='hailuo'?'daily_entitlement_contract_pending':'daily_source_contract_pending',true,409);
  if(kind==='xiaoyunque'){const observed=await x.provider.dailyStatus();if(observed.alreadyClaimed===true)return {submitted:false,alreadyClaimed:true,claimed:true,mutation:false,automaticPerformed:false};}
  const key=receiptKey(kind,x.cert.origin,x.cert.principal,day),prior=attempts.get(key);
  if(prior)throw failure('video_daily_previous_submission_pending',false,409);
  attempts.set(key,true);let r,mayHaveSubmitted=false;
  try{
   r=['jimeng','kling'].includes(kind)?await x.provider.claim(x.s):kind==='liblib'?await x.provider.claimLiblibArtDaily():await x.provider.claim();mayHaveSubmitted=r?.operationAttempted===true||r?.submitted===true;
   if(r?.status==='precondition_failed'&&r.operationAttempted===false){attempts.delete(key);throw failure(r.code??'video_daily_precondition_failed',true);}
   if(r?.status==='settlement_pending'||r?.status==='settlement_unknown')throw failure('video_daily_receipt_unconfirmed',false);
   if(r?.operationAttempted===false||r?.submitted===false){attempts.delete(key);return {submitted:false,alreadyClaimed:r.alreadyClaimed===true,claimed:r.claimed===true,mutation:false,automaticPerformed:false};}
   let amount,ids,source=sources[kind];
   if(kind==='xiaoyunque'){
    if(r?.status==='no_new_quota'&&r.actualAward===0){amount=0;ids=[];}
    else {const p=r?.receipt;if(r?.status!=='claimed'||!p||p.settled!==true||p.kind!=='xiaoyunque_daily'||p.principalHash!==sha(kind+'|'+x.cert.origin+'|'+x.cert.principal)||p.day!==day||!finite(p.amount)||p.amount<=0||r.actualAward!==p.amount)throw failure('video_daily_receipt_unconfirmed',false);amount=p.amount;ids=p.recordIds;}
   }else if(kind==='liblib'){
    const p=r?.receipt,end=Date.parse(day+'T00:00:00+08:00')/1000+86399;
    if(r?.status!=='claimed'||r.actualAward!==20||!p||p.kind!=='liblib_art_daily'||p.settled!==true||p.principalHash!==sha(kind+'|'+x.cert.origin+'|'+x.cert.principal)||p.day!==day||p.amount!==20||p.sourceCode!==10||p.sourceName!=='每日登录赠送'||p.effectEndTime!==end)throw failure('video_daily_receipt_unconfirmed',false);
    amount=p.amount;ids=p.recordIds;
   }else{
    const p=r?.receipt;if(!p||r.serverConfirmed!==true||r.canonicalPrincipal!==x.cert.principal||p.day!==day||p.source!==source||r.submitted!==true||r.mutation!==true)throw failure('video_daily_receipt_unconfirmed',false);
    amount=kind==='kling'?p.pointsRaw/100:p.amount;ids=p.historyId?[p.historyId]:[];
    if(!finite(amount)||r.credit!==amount||amount>0&&(r.rewardConfirmed!==true||r.claimed!==true))throw failure('video_daily_receipt_unconfirmed',false);
   }
   if(!Array.isArray(ids)||!ids.every(text)||new Set(ids).size!==ids.length||amount>0&&!ids.length)throw failure('video_daily_ledger_proof_missing',false);
   await x.identity();if(dayIn(now(),'Asia/Shanghai')!==day)throw failure('video_daily_cycle_changed',false);
   const receipt=frozen({kind,origin:x.cert.origin,principalHash:c.principalHash,day,amount,source,checkedAt:now().toISOString(),recordIds:[...ids],proofVersion:1});grants.add(receipt);receiptsByDay.set(key,receipt);
   return {submitted:true,mutation:true,automaticPerformed:true,claimed:amount>0,observed:amount===0,credit:amount,officialDailyReceipt:receipt};
  }catch(e){if(mayHaveSubmitted)e.beforeSubmission=false;if(e.beforeSubmission===true)attempts.delete(key);else e.beforeSubmission=false;throw e;}
 }
 return Object.freeze({supportsCheckin:true,descriptor:{id:kind,checkinSupported:true,claimOnly:true,inference:false},resolve,models:async()=>[],status,claim,// status() 自己会做身份核对，这里不再重复请求：一次 health 已经是串行的 5 次上游调用。
 async health(c){const x=await context(c);let h;if(['jimeng','kling'].includes(kind))h=await x.provider.health(x.s);else{const r=await x.provider.status();let value=null;if(kind==='xiaoyunque'){const values=Object.values(r.credit??{});if(values.length&&values.every(finite))value=values.reduce((a,b)=>a+b,0);}else if(kind==='hailuo'&&finite(r.totalCredit))value=r.totalCredit;
    let balance={value,unit:'积分'};
    if(kind==='liblib'){
     if(r.balanceKnown===true){if(!r.balance||!finite(r.balance.value))throw new AppError('Liblib 官网余额返回格式待核验',502,'video_balance_schema_error');balance={...r.balance,value:r.balance.value,unit:'积分'};}
     else {const notes={liblib_balance_requires_settled_daily_receipt:'今日领取回执未核实，核实后同步官网余额',liblib_balance_daily_boundary_pending:'接近积分日切换，稍后重新核验官网余额',liblib_balance_history_incomplete:'官方账单尚未完整返回，暂不触发钱包初始化',liblib_art_wallet_source_unverified:'当前站点尚未核实官网余额来源'};balance={value:null,unit:'积分',note:notes[r.balanceReason]??'官网余额尚未满足只读核验条件'};}
    }
    h={status:'authenticated',balance};}// 余额已经从上一次成功读取拿到时，签到状态读不到不该把整张卡片变成错误：
 // liblib 的上游抖动会让 12 次串行请求里的任意一次超时，余额仍应显示。
 let checkin;try{checkin=await status(c);}catch(error){if(!h||h.status!=='authenticated')throw error;checkin={known:false,active:false,claimed:null,day:dayIn(now(),'Asia/Shanghai'),nextClaimAt:nextWindow(now()),credits:null,reason:'official_status_unavailable'};}
 return {status:h.status,credentialStatus:'authenticated',websiteUrl:x.cert.origin,balance:h.balance,checkin,capabilities:{checkin:true,inference:false,models:false,claimOnly:true}};}});
}
export const jimengDailyProvider=createGatewayVideoProvider('jimeng');
export const klingDailyProvider=createGatewayVideoProvider('kling');
export const xiaoyunqueDailyProvider=createGatewayVideoProvider('xiaoyunque');
export const hailuoDailyProvider=createGatewayVideoProvider('hailuo');
export const liblibDailyProvider=createGatewayVideoProvider('liblib');
