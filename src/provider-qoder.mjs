import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir,hostname} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createCipheriv,publicEncrypt,constants,createHash,randomUUID} from 'node:crypto';
import {decryptElectronJson} from './windows-crypto.mjs';
import {AppError,rememberSecret} from './util.mjs';
import {providerFetch,providerJson} from './provider-http.mjs';
// COSY wire format adapted from jsongo/buddy-proxy, MIT (2026 Mayer).
// The desktop's real runtime-info identity is retained; no synthetic machine identifiers.
const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const STD='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',CUSTOM='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
const VERSION='1.1.75-hotfix.1',catalogCache=new Map();
function region(c){if(!['cn','global'].includes(c.edition))throw new AppError('Qoder区域未配置',400,'provider_region_required');return c.edition==='cn'?{openapi:'https://openapi.qoder.com.cn',infer:'https://gateway.qoder.com.cn'}:{openapi:'https://openapi.qoder.sh',infer:'https://api2.qoder.sh'}}
const identityCache=new Map();
export function readQoderNativeIdentity(helper,uid,{authMtimeMs,now=Date.now(),spawnImpl=spawnSync}={}){
 const key=JSON.stringify([helper,uid,authMtimeMs]),cached=identityCache.get(key);if(cached&&now>=cached.at&&now-cached.at<300000)return structuredClone(cached.identity);
 // A local helper read failure is not an upstream credential rejection. Leave
 // recovery to the scheduler's durable backoff: never block on an extra spawn
 // here, expose raw output, cache failures, or substitute an expired identity.
 const failure=kind=>Object.assign(new AppError(`Qoder本机身份读取暂不可用 (${kind})`,503,'provider_identity_missing'),{retryable:true,beforeSubmission:true,identityReadFailure:kind,...(kind==='helper_missing'?{actionRequired:true}:{})});
 const spawnFailure=error=>failure(error?.code==='ENOENT'?'helper_missing':error?.code==='ETIMEDOUT'?'timeout':'spawn_failed');
 let r,identity;
 try{r=spawnImpl(helper,['stable','--account-stdin'],{input:JSON.stringify({account:uid})+'\n',encoding:'utf8',windowsHide:true,timeout:12000,maxBuffer:1024*1024});}catch(error){throw spawnFailure(error)}
 if(!r||typeof r!=='object')throw failure('spawn_failed');
 if(r.error)throw spawnFailure(r.error);
 if(r.status!==0)throw failure('nonzero');
 try{identity=JSON.parse(r.stdout.trim().replace(/^\uFEFF/,'').split('\n')[0]);}catch{throw failure('invalid_json')}
 if(!identity||typeof identity.machineToken!=='string'||!identity.machineToken||typeof identity.machineCode!=='string'||!identity.machineCode||!['number','string'].includes(typeof identity.machineType))throw failure('incomplete');
 if(identityCache.size>=32)identityCache.delete(identityCache.keys().next().value);identityCache.set(key,{at:now,identity:structuredClone(identity)});return identity;
}
async function readQoderCredential(account,config={}){
 const edition=account.edition;region({edition});const dir=join(process.env.APPDATA??join(homedir(),'AppData/Roaming'),edition==='cn'?'com.qodercn.app.stable':'com.qoder.app.stable');
 const ref=account.credentials?.file;const file=ref&&ref!=='auto'?(config.path?config.path(ref):ref):join(dir,'auth.v1.dat');
 let c;if(account.credentials?.kind==='file'){c=JSON.parse(await readFile(file));if(c.edition!==edition)throw new AppError('Qoder文件区域不匹配',401,'provider_region_mismatch')}
 else {const raw=await decryptElectronJson(file,join(dir,'Local State'));const helper=account.credentials?.executable??(edition==='cn'?'D:/Qoder CN':'D:/Qoder')+'/resources/umid/runtime-info.exe';const identity=readQoderNativeIdentity(helper,raw.user?.id,{authMtimeMs:(await stat(file)).mtimeMs});c={edition,accessToken:raw.token,uid:raw.user?.id,principal:raw.user?.id,expiresAt:raw.expiresAt,machineId:(await readFile(join(dir,'auth.machine-id'),'utf8')).trim(),identity}}
 if(!c.accessToken||!c.uid||!c.machineId||!c.identity?.machineToken||!c.identity?.machineCode)throw new AppError('Qoder本机登录与身份信息不完整',401,'provider_login_required');rememberSecret(c.accessToken);rememberSecret(c.identity.machineToken);return {...c,proxyUrl:account.credentials?.proxyUrl??c.proxyUrl,filePath:file,source:'desktop'};
}
export async function resolveQoderCredential(account,config={}){try{return await readQoderCredential(account,config)}catch(e){if(e.code==='ENOENT')throw new AppError('Qoder本机登录文件待就绪',401,'provider_login_required');throw e}}
function bearer(c){return {Authorization:'Bearer '+c.accessToken,Accept:'application/json','Content-Type':'application/json','User-Agent':'Qoder','Cosy-ClientType':'10','Cosy-MachineId':c.machineId,'Cosy-MachineToken':c.identity.machineToken,'Cosy-MachineCode':c.identity.machineCode,'Cosy-MachineType':String(c.identity.machineType),'Cosy-MachineOS':'win32','Cosy-MachineHostname':hostname()}}
export function encodeQoderBody(plain){const b=Buffer.from(plain).toString('base64').split('').map(c=>CUSTOM[STD.indexOf(c)]).join(''),a=Math.floor(b.length/3);return b.slice(b.length-a)+b.slice(a,b.length-a)+b.slice(0,a)}
export function signQoder(url,plain,c,{model,encode=true}={}){
 const key=Buffer.from(randomUUID().replaceAll('-','').slice(0,16));const aes=createCipheriv('aes-128-cbc',key,key);const info=Buffer.concat([aes.update(JSON.stringify({uid:c.uid,security_oauth_token:c.accessToken,name:'',aid:'',email:''})),aes.final()]).toString('base64');const cosyKey=publicEncrypt({key:PUBLIC_KEY,padding:constants.RSA_PKCS1_PADDING},key).toString('base64');key.fill(0);
 const payload=Buffer.from(JSON.stringify({version:'v1',requestId:randomUUID(),info,cosyVersion:VERSION,ideVersion:''})).toString('base64'),ts=String(Math.floor(Date.now()/1000)),body=encode?encodeQoderBody(plain):'',path=new URL(url).pathname.replace(/^\/algo/,'');const signature=createHash('md5').update([payload,cosyKey,ts,body,path].join('\n')).digest('hex');
 return {body,headers:{...bearer(c),Authorization:`Bearer COSY.${payload}.${signature}`,'Cosy-Version':VERSION,'Cosy-ClientType':'5','Cosy-Data-Policy':'agree','Cosy-Date':ts,'Cosy-Key':cosyKey,'Cosy-Scene':'assistant','Cosy-User':c.uid,'Cosy-Business-Product':'cli','Cosy-Business-Type':'agent','Login-Version':'v2',...(model?{'X-Model-Key':model,'X-Model-Source':'system'}:{})}};
}
function cacheKey(c){return c.edition+':'+c.uid}
function qoderNativeParameters(model){
 const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const entries=value=>record(value)?Object.entries(value):[];
 const singleDefault=options=>{const defaults=options.filter(option=>option.isDefault);return defaults.length===1?defaults[0]:null};
 const contextOptions=entries(model.context_config).filter(([,value])=>record(value)&&Number.isSafeInteger(value.token_count)&&value.token_count>0).map(([id,value])=>({id,tokenCount:value.token_count,isDefault:value.is_default===true}));
 const thinkingModes=entries(model.thinking_config).filter(([,value])=>record(value)).map(([id,value])=>({id,isDefault:value.is_default===true}));
 const efforts=entries(record(model.thinking_config?.enabled)?model.thinking_config.enabled.efforts:null).filter(([,value])=>record(value)).map(([id,value])=>({id,isDefault:value.is_default===true}));
 if(!contextOptions.length&&!thinkingModes.length)return null;
 // Preserve the native declaration, not a guessed OpenAI wire mapping. A
 // context selector includes reserves and is not max_input_tokens; unknown
 // or ambiguous defaults must never make a previously uncallable row callable.
 return {source:'qoder-official-signed-catalog',wireVerified:false,
  context:contextOptions.length?{source:'context_config',options:contextOptions,defaultTokenCount:singleDefault(contextOptions)?.tokenCount??null}:null,
  thinking:thinkingModes.length?{source:'thinking_config',modes:thinkingModes,defaultMode:singleDefault(thinkingModes)?.id??null,efforts,defaultEffort:singleDefault(efforts)?.id??null}:null};
}
export function parseQoderModels(data){const seen=new Map();for(const scene of ['chat','developer','assistant','app'])for(const m of Array.isArray(data?.[scene])?data[scene]:[]){if(!m?.key||m.enable===false||seen.has(m.key)||(m.source&&m.source!=='system'))continue;const ctx=Number.isSafeInteger(m.max_input_tokens)&&m.max_input_tokens>0?m.max_input_tokens:null,out=Number.isSafeInteger(m.max_output_tokens)&&m.max_output_tokens>0?m.max_output_tokens:1024,native=qoderNativeParameters(m);seen.set(m.key,{id:m.key,name:m.display_name??m.key,contextWindow:ctx,maxTokens:out,maxTokensSource:m.max_output_tokens>0?'official_catalog':'configured_default',officialMaxTokens:m.max_output_tokens>0?m.max_output_tokens:null,tools:true,multimodal:m.is_vl===true,reasoning:null,isReasoning:m.is_reasoning===true,callable:!!ctx,source:'qoder-official-signed-catalog',priceFactor:m.price_factor??null,...(native?{qoderNativeParameters:native}:{})})}return [...seen.values()]}
export async function qoderModels(c,options={}){const cached=catalogCache.get(cacheKey(c));if(!options.force&&!options.refresh&&cached&&Date.now()-cached.at<300000)return cached.models;const url=region(c).infer+'/algo/api/v2/model/list?Encode=1',s=signQoder(url,'',c,{encode:false}),data=await providerJson(url,c,{...options,headers:s.headers});const models=parseQoderModels(data);if(!models.length)throw new AppError('Qoder官方目录未返回可核验模型',502,'provider_catalog_empty');catalogCache.set(cacheKey(c),{at:Date.now(),models});return models}
async function openapi(c,path,options={}){return providerJson(region(c).openapi+path,c,{...options,headers:bearer(c)})}
export function qoderCampaignStatus(data,c,now=Date.now()){
 if(!Array.isArray(data?.campaigns))throw new AppError('Qoder活动响应缺失目录',502,'provider_invalid_response');const campaigns=data.campaigns.filter(x=>x.actionType==='CLAIM_BENEFIT'&&x.benefit?.kind==='CREDITS').map(x=>({id:x.campaignId,key:x.campaignKey,status:x.claimStatus,amount:x.benefit.amount,startAt:x.startAt,endAt:x.endAt,claimable:x.claimStatus==='CLAIMABLE',claimed:x.claimStatus==='CLAIMED'}));const active=campaigns.filter(x=>(!x.startAt||x.startAt*1000<=now)&&(!x.endAt||x.endAt*1000>=now));return {known:true,active:active.length>0,credits:active.reduce((sum,x)=>sum+(Number(x.amount)||0),0),supportsCheckin:active.length>0,claimable:active.some(x=>x.claimable),claimed:active.length>0&&active.every(x=>x.claimed),principal:c.principal,day:new Date(now-2*3600000).toISOString().slice(0,10),campaignWindowId:active.map(x=>x.id).sort().join('|')||null,nextClaimAt:new Date(Date.parse(new Date(now-2*3600000).toISOString().slice(0,10)+'T02:00:00Z')+86400000).toISOString(),resetTime:'10:00 Asia/Shanghai',campaigns:active,source:'official_campaigns',billingIdentity:'qoder:'+c.edition+':'+c.principal};
}
export async function qoderStatus(c,task='daily-checkin',options={}){if(task!=='daily-checkin')throw new AppError('Qoder任务未登记',400,'provider_task_unknown');return qoderCampaignStatus(await openapi(c,'/sash/api/v1/me/campaigns',options),c)}
export function normalizeQoderQuota(q){const clean=x=>x&&typeof x==='object'?Object.fromEntries(['total','used','remaining','percentage','unit'].filter(k=>typeof x[k]==='number'||k==='unit'&&typeof x[k]==='string').map(k=>[k,x[k]])):null;const userQuota=clean(q.userQuota),addOnQuota=clean(q.addOnQuota);return {source:'official_quota_usage',unit:'credits',total:userQuota?.remaining!=null&&addOnQuota?.remaining!=null?userQuota.remaining+addOnQuota.remaining:null,userQuota,addOnQuota,expiresAt:q.expiresAt??null,isQuotaExceeded:q.isQuotaExceeded===true}}
export async function qoderHealth(c,options={}){const [sr,qr]=await Promise.allSettled([qoderStatus(c,'daily-checkin',options),openapi(c,'/api/v2/quota/usage',options)]);if(sr.status==='rejected'&&qr.status==='rejected')throw sr.reason;const checkin=sr.status==='fulfilled'?sr.value:{known:false,active:false,claimable:false,claimed:false,error:sr.reason.code??'provider_status_failed'},credits=qr.status==='fulfilled'?normalizeQoderQuota(qr.value):{total:null,error:qr.reason.code??'provider_balance_failed'};return {status:'authenticated',supportsCheckin:checkin.known?checkin.supportsCheckin===true:null,checkinKnown:checkin.known===true,checkinError:checkin.known?null:checkin.error,checkin,credits,balance:{value:credits.total,unit:'Credits',parts:[{name:'套餐',value:credits.userQuota?.remaining??null,unit:'Credits'},{name:'加购',value:credits.addOnQuota?.remaining??null,unit:'Credits'}],note:!checkin.known?'签到状态读取失败，未确认活动是否开启':credits.error?'余额读取失败；签到独立核验':'官方额度；活动每日10:00(UTC+8)刷新',checkedIn:checkin.known?checkin.claimed:null},capabilities:{checkin:checkin.known?checkin.supportsCheckin===true:null,inference:true}}}
export async function qoderClaim(c,task='daily-checkin',options={}){const before=await qoderStatus(c,task,options),eligible=before.campaigns.filter(x=>x.claimable);if(!eligible.length)return {...before,submitted:false,alreadyClaimed:before.claimed};const results=[];for(const item of eligible){if(!/^[\w-]+$/.test(item.id))throw new AppError('Qoder活动标识无效',502,'provider_invalid_response');const path='/sash/api/v1/me/campaigns/'+item.id;const receipt=await openapi(c,path+'/claim',{...options,body:{}});const reward=await openapi(c,path+'/reward',options);results.push({id:item.id,status:receipt.status,replayed:receipt.replayed===true,rewardStatus:reward.status??reward.claimStatus??null,amount:item.amount})}const after=await qoderStatus(c,task,options);if(results.some(x=>!after.campaigns.some(y=>y.id===x.id&&y.claimed)))throw new AppError('Qoder领取后状态尚未确认',502,'provider_claim_unconfirmed');const credits=normalizeQoderQuota(await openapi(c,'/api/v2/quota/usage',options));return {...after,submitted:true,rechecked:true,alreadyClaimed:results.every(x=>x.replayed),results,credit:results.filter(x=>!x.replayed).reduce((sum,x)=>sum+(Number(x.amount)||0),0),quota:credits}}
const qoderBusinessCodes=new Set(['invalid_request','invalid_request_error','model_not_found','permission_denied','unauthorized','rate_limit','rate_limited','quota_exceeded','insufficient_quota','resource_exhausted','overloaded','server_error','context_length_exceeded']);
const qoderStreamFailures=new WeakSet(),qoderQueueContexts=new WeakMap();
const qoderQueueKey=value=>typeof value==='string'&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(value)?value:undefined;
function qoderInnerDiagnostics(root,safeCode,privateQueue){
 // Diagnostic-only: inspect explicit message JSON, never free text or unknown
 // fields. Four levels/16KiB total bound work; no raw content is retained.
 const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),queue={};let current=record(root.error)?root.error:root,innerBusinessCode,bytes=0;
 for(let depth=0;depth<4;depth++){
  let next=current.message;
  if(typeof next==='string'){const size=Buffer.byteLength(next);if(size>4096||(bytes+=size)>16384)break;try{next=JSON.parse(next)}catch{break}}
  if(!record(next))break;current=record(next.error)?next.error:next;
  const code=safeCode(current.code);if(code!==undefined)innerBusinessCode=code;
  // Server-selected keys (notably auto's actual queue key) stay in a WeakMap,
  // never in errors, errorView, logs or the ledger's public queue diagnostics.
  if(typeof current.isQueued==='boolean'||typeof current.serviceAvailable==='boolean'){
   if(current.modelKey!==undefined){const key=qoderQueueKey(current.modelKey);if(!key||privateQueue.modelKey&&privateQueue.modelKey!==key)privateQueue.invalid=true;else privateQueue.modelKey=key;}
   if(current.queueType!==undefined){const type=qoderQueueKey(current.queueType);if(type)privateQueue.queueType=type;else privateQueue.invalid=true;}
  }
  for(const key of ['isQueued','serviceAvailable'])if(typeof current[key]==='boolean')queue[key]=current[key];
  for(const key of ['queueCount','retryAfterSeconds','waitTime']){const value=current[key],max=key==='queueCount'?1000000:86400;if(Number.isSafeInteger(value)&&value>=0&&value<=max)queue[key]=value;}
  // Only publicly observed machine labels; arbitrary token-shaped text is omitted.
  if(['slow','p3'].includes(current.queueType))queue.queueType=current.queueType;
 }
 return{...(innerBusinessCode!==undefined?{innerBusinessCode}:{}),...(Object.keys(queue).length?{qoderQueue:queue}:{})};
}
function qoderStreamError(reason,packet){
 // Never retain raw frame/message/header/body/exception text. Numeric business
 // codes and a closed machine-code set survive; arbitrary text is not a code.
 const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),root=record(packet)?packet:{},error=record(root.error)?root.error:{};
 const safeCode=value=>Number.isSafeInteger(value)&&Math.abs(value)<=999999999999?value:typeof value==='string'&&/^\d{1,12}$/.test(value)?value:typeof value==='string'&&qoderBusinessCodes.has(value.toLowerCase())?value.toLowerCase():undefined;
 const safeStatus=value=>{const n=typeof value==='string'&&/^\d{3}$/.test(value)?Number(value):value;return Number.isInteger(n)&&n>=100&&n<=599?n:undefined};
 const code=safeCode(error.code)??safeCode(root.code),status=[root.statusCodeValue,root.status,error.status,root.status_code,error.status_code].map(safeStatus).find(value=>value!==undefined);
 const privateQueue={},diagnostics=qoderInnerDiagnostics(root,safeCode,privateQueue),inner=diagnostics.innerBusinessCode,queue=Object.entries(diagnostics.qoderQueue??{}).map(([key,value])=>`; queue.${key}=${value}`).join('');
 const e=new AppError(`Qoder响应失败 [reason=${reason}${code!==undefined?`; upstreamCode=${code}`:''}${status!==undefined?`; upstreamStatus=${status}`:''}${inner!==undefined?`; innerBusinessCode=${inner}`:''}${queue}]`,502,'provider_stream_error');
 e.qoderFailureReason=reason;if(code!==undefined)e.upstreamCode=code;if(status!==undefined)e.upstreamStatus=status;Object.assign(e,diagnostics);qoderStreamFailures.add(e);qoderQueueContexts.set(e,privateQueue);return e;
}
export function unwrapQoderSSE(body){
 const reader=body.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='',finished=false,done=false,released=false,nativeWrapperSeen=false,modelPayloadSeen=false,pendingParseFailure,lastControl;
 const release=()=>{if(!released){released=true;reader.releaseLock()}};
 const marker=text=>text==='[DONE]'||text==='[NOT_EXCEED_QUOTA]'||text.startsWith('[EXCEED_QUOTA]')||text.startsWith('[NOTIFICATIONS]');
 const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const payloadSeen=packet=>{const d=packet.choices?.[0]?.delta??packet.choices?.[0]?.message;return typeof d?.content==='string'&&d.content.length>0||typeof d?.reasoning_content==='string'&&d.reasoning_content.length>0||d?.reasoning_item!==undefined||!!d?.responses_reasoning_update?.encrypted_content||!!d?.tool_calls?.some(call=>(call?.id?.length??0)>0||(call?.function?.name?.length??0)>0||(call?.function?.arguments?.length??0)>0)};
 const stream=new ReadableStream({async pull(ctrl){try{for(;;){
  const n=await reader.read();if(n.done){done=true;buffer+=decoder.decode();if(buffer.trim())throw qoderStreamError('incomplete_frame');if(pendingParseFailure&&!modelPayloadSeen)throw pendingParseFailure;if(!finished&&!(nativeWrapperSeen&&modelPayloadSeen))throw lastControl??qoderStreamError('missing_finish');ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));ctrl.close();release();return}
  buffer=(buffer+decoder.decode(n.value,{stream:true})).replaceAll('\r\n','\n');if(buffer.length>4*1024*1024)throw qoderStreamError('frame_limit');let i;let emitted=false;
  while((i=buffer.indexOf('\n\n'))>=0){
   const frame=buffer.slice(0,i);buffer=buffer.slice(i+2);const lines=frame.split('\n'),line=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n').trim(),event=lines.find(x=>x.startsWith('event:'))?.slice(6).trim();if(!line)continue;if(line==='[DONE]'){finished=true;continue}if(marker(line))continue;if(event==='finish')finished=true;
   let parsed;
   try{
    try{parsed=JSON.parse(line)}catch{throw qoderStreamError('invalid_frame_json')}
    if(parsed===null)continue;if(!record(parsed))throw qoderStreamError('invalid_frame_shape');
    const wrapper=parsed.statusCodeValue!==undefined&&parsed.body!==undefined;
    if(wrapper){
     nativeWrapperSeen=true;const envelope=parsed;
     // Current native $2 checks wrapper status BEFORE unwrapping. A plain
     // code (including '0') is not the packet HTTP-success discriminator.
     if(envelope.statusCodeValue!==200&&event!=='finish'){
      let detail={};if(typeof envelope.body==='string'){try{const value=JSON.parse(envelope.body);if(record(value))detail=value}catch{}}
      throw qoderStreamError('upstream_packet_status',{...detail,statusCodeValue:envelope.statusCodeValue});
     }
     if(envelope.body==null)continue;if(typeof envelope.body!=='string')throw qoderStreamError('invalid_wrapper_body',envelope);
     const inner=envelope.body.trim();if(!inner||marker(inner)){if(inner==='[DONE]')finished=true;continue}
     try{parsed=JSON.parse(inner)}catch{throw qoderStreamError('invalid_body_json',envelope)}
    }else{
     if(parsed.error)throw qoderStreamError('upstream_business_error',parsed);
     // Preserve the preexisting body-only envelope for older gateways/tests.
     if(typeof parsed.body==='string'){const inner=parsed.body.trim();if(marker(inner)){if(inner==='[DONE]')finished=true;continue}try{parsed=JSON.parse(inner)}catch{throw qoderStreamError('invalid_body_json',parsed)}}else if(record(parsed.body))parsed=parsed.body;
    }
    if(parsed===null)continue;if(!record(parsed))throw qoderStreamError('invalid_body_shape');
    if(parsed.error)throw qoderStreamError('upstream_business_error',parsed);
    if(parsed.choices==null){if(parsed.usage)parsed={...parsed,choices:[]};else{lastControl=qoderStreamError('missing_finish',parsed);continue}}
    if(!Array.isArray(parsed.choices)||parsed.choices.some(choice=>!record(choice)))throw qoderStreamError('invalid_choices');
   }catch(error){
    if(qoderStreamFailures.has(error)&&!['upstream_business_error','upstream_packet_status'].includes(error.qoderFailureReason)){pendingParseFailure=error;continue}throw error;
   }
   if(payloadSeen(parsed))modelPayloadSeen=true;if(parsed.choices.some(x=>x.finish_reason!=null))finished=true;ctrl.enqueue(encoder.encode('data: '+JSON.stringify(parsed)+'\n\n'));emitted=true;
  }if(emitted)return
 }}catch(error){done=true;await reader.cancel().catch(()=>{});release();ctrl.error(qoderStreamFailures.has(error)?error:qoderStreamError('transport_error'))}},async cancel(reason){if(!done){done=true;try{await reader.cancel(reason)}finally{release()}}}});return stream;
}
function qoderQueueResponse(body,{url,credential,requestBody,signal,options}){
 const stats={inferencePosts:1,replayPosts:0,queueStatusGets:0,queueWaitMs:0,state:'streaming',outcome:'ongoing'},controller=new AbortController(),deadline=options.requestDeadlineAt,clock=options.queueNow??Date.now;
 const activeSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let reader=unwrapQoderSSE(body).getReader(),ended=false,delivered=false,waiting=false,waitStarted,deadlineTimer;
 const abortError=()=>activeSignal.reason?.status?activeSignal.reason:new AppError(activeSignal.reason?.name==='TimeoutError'?'Qoder request deadline exceeded':'Request cancelled',activeSignal.reason?.name==='TimeoutError'?504:499,activeSignal.reason?.name==='TimeoutError'?'request_timeout':'request_cancelled');
 const check=()=>{if(activeSignal.aborted)throw abortError();if(ended)throw new AppError('Request cancelled',499,'request_cancelled');if(Number.isFinite(deadline)&&clock()>=deadline)throw new AppError('Qoder request deadline exceeded',504,'request_timeout');};
 const state=value=>{if(value&&!waiting)waitStarted=clock();if(!value&&waiting){stats.queueWaitMs+=Math.max(0,clock()-waitStarted);waitStarted=undefined;}waiting=value;if(!ended)stats.state=value?'queued':'streaming';options.onQueueState?.(value);};
 const closeReader=cancel=>{const old=reader;reader=null;if(!old)return;if(cancel)void old.cancel().catch(()=>{});try{old.releaseLock()}catch{}};
 const finish=outcome=>{if(ended)return;ended=true;clearTimeout(deadlineTimer);if(waiting){stats.queueWaitMs+=Math.max(0,clock()-waitStarted);waiting=false;waitStarted=undefined;try{options.onQueueState?.(false)}catch{}}stats.outcome=outcome;stats.state='finished';Object.freeze(stats);controller.abort();closeReader(outcome!=='completed');};
 const guard=async(promise,guardedSignal=activeSignal)=>{check();let listener;const cancelled=new Promise((_,reject)=>{listener=()=>reject(activeSignal.aborted?abortError():fail('status_timeout'));guardedSignal.addEventListener('abort',listener,{once:true});if(guardedSignal.aborted)listener();});try{return await Promise.race([promise,cancelled])}finally{guardedSignal.removeEventListener('abort',listener)}};
 const fetchGuarded=async(target,init,beforeSend)=>{check();const pending=Promise.resolve().then(()=>{check();beforeSend?.(init);check();return(options.fetchImpl??providerFetch)(target,init)});pending.then(response=>{if(ended||init.signal?.aborted)void response?.body?.cancel().catch(()=>{})}).catch(()=>{});return guard(pending,init.signal??activeSignal);};
 const fail=(reason,original)=>{const error=qoderStreamFailures.has(original)||original instanceof AppError?original:new AppError(`Qoder queue recovery ended [reason=${reason}; innerBusinessCode=10605]`,502,'qoder_queue_recovery_failed');error.qoderQueueRecoveryTerminal=true;error.qoderQueueRecoveryReason??=reason;error.retryable=false;error.qoderQueueTelemetry=stats;return error;};
 const queued=error=>qoderStreamFailures.has(error)&&String(error.innerBusinessCode??error.upstreamCode)==='10605'&&error.qoderQueue&&(error.qoderQueue.isQueued===true||error.qoderQueue.serviceAvailable===false);
 const wait=async ms=>{check();if(clock()+ms>=deadline)throw new AppError('Qoder request deadline exceeded',504,'request_timeout');if(options.queueDelayImpl)await guard(Promise.resolve().then(()=>options.queueDelayImpl(ms,activeSignal)));else{let timer;try{await guard(new Promise(resolve=>{timer=setTimeout(resolve,ms)}))}finally{clearTimeout(timer)}}check();};
 const poll=async queue=>{
  check();const target=new URL(region(credential).infer+'/algo/api/v2/service/ask/queue/status');target.searchParams.set('requestSetId',requestBody.request_set_id);target.searchParams.set('modelKey',queue.modelKey);if(queue.queueType)target.searchParams.set('queueType',queue.queueType);
  const auth=signQoder(target.href,'',credential,{encode:false}),pollController=new AbortController(),remaining=Math.min(30000,deadline-clock()),timer=setTimeout(()=>pollController.abort(new DOMException('Queue status deadline','TimeoutError')),remaining),pollSignal=AbortSignal.any([activeSignal,pollController.signal]);let pollReader;
  try{const response=await fetchGuarded(target.href,{method:'GET',headers:{...auth.headers,Accept:'application/json','X-Request-ID':requestBody.request_id,'X-Session-ID':requestBody.session_id},signal:pollSignal,proxyUrl:credential.proxyUrl,redirect:'error'},()=>stats.queueStatusGets++);check();if(!response.ok){void response.body?.cancel().catch(()=>{});throw fail('status_http_'+response.status)}
   pollReader=response.body?.getReader();if(!pollReader)throw fail('status_empty_body');let bytes=0,text='',decoder=new TextDecoder();
   for(;;){const part=await guard(pollReader.read(),pollSignal);check();if(part.done){text+=decoder.decode();break}bytes+=part.value.byteLength;if(bytes>65536)throw fail('status_body_limit');text+=decoder.decode(part.value,{stream:true});}
   let value;try{value=JSON.parse(text)}catch{throw fail('status_invalid_json')}const nodes=[{value,depth:0}];for(let visited=0;nodes.length&&visited<16;visited++){const node=nodes.shift(),value=node.value;if(!value||typeof value!=='object'||Array.isArray(value))continue;
    if(typeof value.isQueued==='boolean'||typeof value.serviceAvailable==='boolean'){if(value.modelKey!==undefined&&!qoderQueueKey(value.modelKey)||value.queueType!==undefined&&!qoderQueueKey(value.queueType))throw fail('status_invalid_identity');return{...(typeof value.isQueued==='boolean'?{isQueued:value.isQueued}:{}),...(typeof value.serviceAvailable==='boolean'?{serviceAvailable:value.serviceAvailable}:{}),...(Number.isSafeInteger(value.retryAfterSeconds)&&value.retryAfterSeconds>=0&&value.retryAfterSeconds<=86400?{retryAfterSeconds:value.retryAfterSeconds}:{}),modelKey:value.modelKey??queue.modelKey,...(value.queueType??queue.queueType?{queueType:value.queueType??queue.queueType}:{})};}
    if(node.depth<4)for(const key of ['data','result','message','body']){let child=value[key];try{if(typeof child==='string')child=JSON.parse(child)}catch{continue}if(child&&typeof child==='object'&&!Array.isArray(child))nodes.push({value:child,depth:node.depth+1});}
   }throw fail('status_invalid_shape');
  }finally{clearTimeout(timer);if(pollReader){void pollReader.cancel().catch(()=>{});try{pollReader.releaseLock()}catch{}}}
 };
 const recover=async error=>{
  if(delivered||stats.replayPosts)return fail(delivered?'payload_already_delivered':'replay_exhausted',error);
  if(!Number.isFinite(deadline)||typeof options.beforeQueueReplay!=='function')return fail('admitted_deadline_or_fence_missing',error);
  const context=qoderQueueContexts.get(error),modelKey=context?.modelKey??(requestBody.model_config.key!=='auto'?qoderQueueKey(requestBody.model_config.key):undefined);if(context?.invalid||!modelKey)return fail('queue_model_key_unverified',error);
  state(true);let queue={...error.qoderQueue,...context,modelKey};
  try{for(;;){check();const status=await poll(queue);check();if(status.isQueued===false){if(status.retryAfterSeconds>0)await wait(Math.min(30000,Math.max(500,status.retryAfterSeconds*1000)));state(false);const response=await fetchGuarded(url,{method:'POST',signal:activeSignal,proxyUrl:credential.proxyUrl,redirect:'error'},init=>{options.beforeQueueReplay();check();
   // Current worker queue-ready path calls pho(chatAsk) before opening a new
   // BYi/nYi request: only these attempt IDs change; set/session and is_retry
   // stay intact. Re-prepare the signature instead of replaying a duplicate ID.
   const requestId=randomUUID(),body={...requestBody,request_id:requestId,chat_record_id:requestId},fresh=signQoder(url,JSON.stringify(body),credential,{model:body.model_config.key});Object.assign(init,fresh,{headers:{...fresh.headers,Accept:'text/event-stream'}});stats.inferencePosts++;stats.replayPosts++;});check();if(!response.ok){void response.body?.cancel().catch(()=>{});throw fail('replay_http_'+response.status)}if(!response.body)throw fail('replay_empty_body');reader=unwrapQoderSSE(response.body).getReader();return null;}if(status.isQueued!==true&&status.serviceAvailable!==false)throw fail('status_invalid_state');queue=status;const seconds=queue.retryAfterSeconds??30;await wait(Math.min(30000,Math.max(500,seconds*1000)));}}
  catch(error){throw error?.code==='request_cancelled'||error?.code==='request_timeout'?error:fail('poll_or_replay_failed',error)}
  finally{if(waiting)state(false)}
 };
 if(Number.isFinite(deadline)){deadlineTimer=setTimeout(()=>controller.abort(new DOMException('Qoder request deadline','TimeoutError')),Math.max(0,deadline-clock()));deadlineTimer.unref?.();}
 const responseBody=new ReadableStream({async pull(ctrl){try{for(;;){check();let part;try{part=await guard(reader.read())}catch(error){closeReader(true);if(!queued(error))throw error;const terminal=await recover(error);if(terminal)throw terminal;continue}check();if(part.done){finish('completed');ctrl.close();return}delivered=true;ctrl.enqueue(part.value);return}}catch(error){if(ended)return;const outcome=error?.code==='request_cancelled'?'cancelled':'failed';if(stats.queueStatusGets||queued(error)){error.qoderQueueTelemetry=stats;if(error?.code!=='request_cancelled')error.qoderQueueRecoveryTerminal=true;}finish(outcome);ctrl.error(error)}},cancel(){finish('cancelled')}});
 return{body:responseBody,telemetry:stats,finalize:finish};
}
function qoderRequestParameters(input,model,max){
 // Current 0.4.11 worker l3e/Qtt puts generation controls in parameters;
 // its FKl separately preserves the original model max_input_tokens.
 const parameters={max_tokens:max};for(const key of ['temperature','top_p','tool_choice'])if(input[key]!==undefined)parameters[key]=input[key];
 if(input.reasoning_effort!==undefined){
  const effort=typeof input.reasoning_effort==='string'?input.reasoning_effort.trim().toLowerCase():'';
  if(!['none','low','medium','high','xhigh','max'].includes(effort))throw new AppError('Qoder思考档格式无效',400,'reasoning_effort_not_supported');
  const declared=model.qoderNativeParameters?.thinking;
  if(declared&&(effort==='none'?!declared.modes.some(mode=>mode.id==='disabled'):declared.efforts.length&&!declared.efforts.some(option=>option.id===effort)))throw new AppError('Qoder当前型号未声明该思考档',400,'reasoning_effort_not_supported');
  parameters.reasoning_effort=effort;parameters.enable_thinking=effort!=='none';
 }
 if(input.contextWindow!==undefined){
  const context=input.contextWindow,options=model.qoderNativeParameters?.context?.options;
  if(!Number.isSafeInteger(context)||context<=0||(options?.length?!options.some(option=>option.tokenCount===context):context>model.contextWindow))throw new AppError('Qoder当前型号未声明该上下文选项',400,'provider_context_option_invalid');
  parameters.context_length=context;
 }
 return parameters;
}
export function normalizeQoderMessages(messages){return messages.map(m=>{let out={...m};if(out.tool_calls&&out.content==null)out.content='';if(out.role==='developer'){out.role='system';delete out.tool_calls}return out})}
export async function qoderChat(upstream,c,input,signal,options={}){
 const models=await qoderModels(c,{...options,signal}),m=models.find(x=>x.id===input.model);if(!m?.callable)throw new AppError('Qoder模型缺失已核验容量',400,'provider_model_unverified');const max=input.max_tokens??input.max_completion_tokens??m.maxTokens;if(!Number.isSafeInteger(max)||max<=0||max>m.maxTokens)throw new AppError('Qoder输出超过配置上限',400,'provider_output_limit');
 const request=randomUUID(),set=randomUUID(),session=randomUUID(),messages=input.messages??[],text=messages.filter(x=>x.role==='user').at(-1)?.content??'',prompt=typeof text==='string'?text:'';let p={model:m.id,stream:true,stream_options:{include_usage:true},max_tokens:max};for(const k of ['messages','tools','tool_choice','temperature','top_p','stop','presence_penalty','frequency_penalty','reasoning_effort'])if(input[k]!==undefined)p[k]=input[k];p.messages=normalizeQoderMessages(messages);p={...p,request_id:request,request_set_id:set,chat_record_id:request,session_id:session,chat_task:'FREE_INPUT',chat_context:{text:prompt,features:[],extra:{context:[],modelConfig:{key:m.id,is_reasoning:m.isReasoning===true},originalContent:prompt},chatPrompt:'',imageUrls:null},is_reply:true,is_retry:false,source:1,version:'3',agent_id:'agent_common',task_id:'common',session_type:'qoderclicn',aliyun_user_type:'',model_config:{key:m.id,display_name:m.name,model:'',format:'openai',is_vl:m.multimodal,is_reasoning:m.isReasoning===true,api_key:'',url:'',source:'system',max_input_tokens:m.contextWindow},business:{product:'cli',version:VERSION,type:'agent',id:set,name:prompt.slice(0,10),begin_at:Date.now(),stage:'processing'}};
 p.parameters=qoderRequestParameters(input,m,max);if(p.parameters.enable_thinking===false){p.model_config.is_reasoning=false;p.chat_context.extra.modelConfig.is_reasoning=false;}
 const credential={...c,...(c.identity?{identity:{...c.identity}}:{})},url=region(credential).infer+'/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',signed=signQoder(url,JSON.stringify(p),credential,{model:m.id}),r=await(options.fetchImpl??providerFetch)(url,{method:'POST',...signed,headers:{...signed.headers,Accept:'text/event-stream'},signal,proxyUrl:credential.proxyUrl,redirect:'error'});if(!r.ok){await r.body?.cancel();throw new AppError(`Qoder聊天 HTTP ${r.status}`,r.status,'provider_chat_rejected')}if(!r.body)throw qoderStreamError('empty_body');const recovery=qoderQueueResponse(r.body,{url,credential,requestBody:p,signal,options});return {response:new Response(recovery.body,{status:200,headers:{'Content-Type':'text/event-stream'}}),qoderQueueTelemetry:recovery.telemetry,finalizeQoderQueue:recovery.finalize};
}
export const qoderProvider={resolve:resolveQoderCredential,models:qoderModels,health:qoderHealth,status:qoderStatus,claim:qoderClaim,chat:qoderChat};
