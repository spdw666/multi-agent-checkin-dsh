import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile,rename,unlink,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {AppError,rememberSecret} from './util.mjs';
import {withVideoVaultWriteLock} from './video-vault-lock.mjs';

export const VIDEO_SESSION_RULES=Object.freeze({
  jimeng:{origins:['https://jimeng.jianying.com'],domains:['jimeng.jianying.com','jianying.com']},
  kling:{origins:['https://klingai.kuaishou.com','https://app.klingai.com','https://klingai.com','https://www.klingai.com'],domains:['klingai.kuaishou.com','kuaishou.com','app.klingai.com','klingai.com','www.klingai.com']},
  xiaoyunque:{origins:['https://xyq.jianying.com','https://www.xiaoyunque.com'],domains:['xyq.jianying.com','jianying.com','www.xiaoyunque.com','xiaoyunque.com']},
  vidu:{origins:['https://www.vidu.cn','https://vidu.cn'],domains:['vidu.cn','www.vidu.cn','service.vidu.cn']},
  hailuo:{origins:['https://hailuoai.com','https://www.hailuoai.com','https://hailuoai.video','https://www.hailuoai.video'],domains:['hailuoai.com','www.hailuoai.com','hailuoai.video','www.hailuoai.video']},
  pixverse:{origins:['https://app.pixverse.ai'],domains:['pixverse.ai','app.pixverse.ai','app-api.pixverse.ai']},
  liblib:{origins:['https://www.liblib.art','https://liblib.art','https://www.liblib.tv','https://liblib.tv'],domains:['liblib.art','www.liblib.art','api2.liblib.art','liblib.tv','www.liblib.tv']}
});
// 认证类 cookie：令牌有效性只由上游决定，本地浏览器 expirationDate 过期不代表失效。
export const VIDEO_SESSION_AUTH_COOKIES=Object.freeze(['liblibai_usertoken','usertoken','usertoken_online','webid','_token','sessionid','sessionid_ss','_ai_token','xmst','__msuuid__']);
const fail=(code='video_session_invalid',status=400)=>new AppError('本机会话结构或主体核验未通过',status,code);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(o,allowed)=>object(o)&&Object.keys(o).every(k=>allowed.includes(k));
const text=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x1f\x7f]/.test(v);
const sha=v=>createHash('sha256').update(v).digest('hex');
const principalText=v=>(typeof v==='string'||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)&&text(String(v),256)?String(v):null;
export function validateVideoSessionImport(item){
  if(!keys(item,['platform','principal','origin','cookies','accessToken','expiresAtMs','identityEvidence','securityState']))throw fail();
  const rule=VIDEO_SESSION_RULES[item.platform];
  if(!rule||!rule.origins.includes(item.origin)||item.principal!==null||!keys(item.identityEvidence,['kind'])||item.identityEvidence.kind!=='pending-direct-verification')throw fail();
  if(!Array.isArray(item.cookies)||item.cookies.length>64)throw fail();
  const duplicate=new Set();
  const cookies=item.cookies.map(c=>{
    if(!keys(c,['name','value','domain','path','expirationDate','secure','httpOnly','sameSite']))throw fail();
    const domain=typeof c.domain==='string'?c.domain.replace(/^\./,'').toLowerCase():'';
    if(!rule.domains.includes(domain)||!text(c.name,256)||!/^[-!#$%&'*+.\^_`|~0-9A-Za-z]+$/.test(c.name)||typeof c.value!=='string'||c.value.length>16384||/[\x00-\x1f\x7f;]/.test(c.value)||!text(c.path,2048)||!c.path.startsWith('/')||typeof c.secure!=='boolean'||typeof c.httpOnly!=='boolean'||!['no_restriction','lax','strict','unspecified'].includes(c.sameSite))throw fail();
    if(c.expirationDate!==undefined&&(!Number.isFinite(c.expirationDate)||c.expirationDate<=0))throw fail();
    const id=[domain,c.path,c.name].join('\0');if(duplicate.has(id))throw fail();duplicate.add(id);
    rememberSecret(c.value);
    return {name:c.name,value:c.value,domain:c.domain,path:c.path,secure:c.secure,httpOnly:c.httpOnly,sameSite:c.sameSite,...(c.expirationDate===undefined?{}:{expirationDate:c.expirationDate})};
  });
  if(item.accessToken!==undefined&&(!text(item.accessToken,32768)||/[\r\n]/.test(item.accessToken)))throw fail();
  if(!cookies.length&&!item.accessToken)throw fail('video_session_empty');
  if(item.expiresAtMs!==undefined&&(!Number.isFinite(item.expiresAtMs)||item.expiresAtMs<=0))throw fail();
  if(item.accessToken)rememberSecret(item.accessToken);
  if(item.securityState!==undefined){
    if(item.platform!=='jimeng'||!keys(item.securityState,['xmst','msuuid'])||!text(item.securityState.xmst,16384)||/\s/.test(item.securityState.xmst)||item.securityState.msuuid!==undefined&&(!text(item.securityState.msuuid,256)||!/^[A-Za-z0-9._-]+$/.test(item.securityState.msuuid)))throw fail();
    for(const v of Object.values(item.securityState))rememberSecret(v);
  }
  return {platform:item.platform,origin:item.origin,cookies,...(item.accessToken===undefined?{}:{accessToken:item.accessToken}),...(item.expiresAtMs===undefined?{}:{expiresAtMs:item.expiresAtMs}),...(item.securityState===undefined?{}:{securityState:{...item.securityState}})};
}

// Cookie delivery is restricted to adapter-owned URLs; this helper rejects every
// unrelated host even when an imported parent-domain cookie would match it.
const targets=Object.freeze({
  vidu:['service.vidu.cn'],pixverse:['app-api.pixverse.ai'],
  jimeng:['jimeng.jianying.com'],kling:['klingai.kuaishou.com','api.klingai.com','app.klingai.com'],
  xiaoyunque:['xyq.jianying.com','commerce-api.jianying.com'],
  hailuo:['hailuoai.com','www.hailuoai.com','hailuoai.video','www.hailuoai.video'],
  liblib:['api2.liblib.art','www.liblib.art','www.liblib.tv']
});
export function videoSessionCookieHeader(session,url,{now=Date.now()}={}){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!targets[session.platform]?.includes(u.hostname))throw fail('video_session_target_invalid');
  const rows=session.cookies.filter(c=>{
    const domain=c.domain.replace(/^\./,'').toLowerCase();
    const domainMatch=c.domain.startsWith('.')?(u.hostname===domain||u.hostname.endsWith('.'+domain)):u.hostname===domain;
    const pathMatch=u.pathname===c.path||u.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/');
    return domainMatch&&pathMatch&&(VIDEO_SESSION_AUTH_COOKIES.includes(c.name)||!c.expirationDate||c.expirationDate*1000>now);
  }).sort((a,b)=>b.path.length-a.path.length);
  return rows.map(c=>`${c.name}=${c.value}`).join('; ');
}
export function videoSessionAuthToken(session,name){
  if(session.accessToken)return session.accessToken;
  const candidates=session.cookies.filter(c=>c.name===name);
  const values=[...new Set(candidates.map(c=>c.value))];
  if(values.length!==1||!values[0])throw fail('video_session_token_missing',401);
  return values[0];
}

export async function windowsVideoSessionCrypt(mode,bytes,platform){
  if(process.platform!=='win32'||!['protect','unprotect'].includes(mode)||!VIDEO_SESSION_RULES[platform])throw fail('video_session_host_invalid',401);
  const method=mode==='protect'?'Protect':'Unprotect';
  // All sensitive input/output travels through pipes, never process arguments.
  const command=`Add-Type -AssemblyName System.Security;try{$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$b=[Convert]::FromBase64String($v.data);$e=[Convert]::FromBase64String($v.entropy);$r=[Security.Cryptography.ProtectedData]::${method}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))}catch{exit 1}`;
  return new Promise((resolveCrypt,reject)=>{
    const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',settled=false;
    const stop=()=>{if(settled)return;settled=true;clearTimeout(timer);reject(fail('video_session_crypt_failed',401));};
    const timer=setTimeout(()=>{p.kill();stop();},12000);
    p.on('error',stop);p.stdin.on('error',stop);p.stderr.on('data',()=>{});
    p.stdout.on('data',b=>{out+=b;if(out.length>2097152){p.kill();stop();}});
    p.on('close',code=>{if(settled)return;if(code!==0||!out||!/^[A-Za-z0-9+/=]+$/.test(out))return stop();settled=true;clearTimeout(timer);resolveCrypt(Buffer.from(out,'base64'));});
    p.stdin.end(JSON.stringify({data:Buffer.from(bytes).toString('base64'),entropy:Buffer.from('ai-credit-gateway.video-session.v1\0'+platform).toString('base64')}));
  });
}

export async function writeVideoSessionVault(file,session,options={}){
  return withVideoVaultWriteLock(file,owned=>writeLockedVideoSessionVault(file,session,options,owned));
}
async function writeLockedVideoSessionVault(file,session,{principal=null,expectedPrincipalHash=null,expectedSourceHash,crypt=windowsVideoSessionCrypt,now=()=>new Date()}={},assertOwned){
  if(expectedSourceHash!==undefined&&expectedSourceHash!==null&&!(typeof expectedSourceHash==='string'&&/^[a-f0-9]{64}$/.test(expectedSourceHash)))throw fail('video_session_expected_hash_invalid');
  const clean=validateVideoSessionImport({...session,principal:null,identityEvidence:{kind:'pending-direct-verification'}});
  if(principal!==null&&!principalText(principal))throw fail();
  const principalHash=principal===null?null:sha(`${clean.platform}\0${principal}`);
  if(expectedPrincipalHash!==null&&principalHash!==expectedPrincipalHash)throw fail('video_session_principal_changed',409);
  let prior=null;
  try{prior=await readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(expectedSourceHash!==undefined&&(prior===null?null:sha(prior))!==expectedSourceHash)throw fail('video_session_write_conflict',409);
  if(prior){
    const priorEnvelope=JSON.parse(prior.toString('utf8'));
    if(priorEnvelope.principalHash&&(priorEnvelope.principalHash!==principalHash||priorEnvelope.origin!==clean.origin))throw fail('video_session_principal_changed',409);
  }
  const payload={version:1,...clean,principal,importedAt:now().toISOString()};
  const plain=Buffer.from(JSON.stringify(payload));let encrypted;
  try{encrypted=await crypt('protect',plain,clean.platform);}finally{plain.fill(0);}
  const envelope={format:'ai-credit-gateway-video-session',version:1,protection:'windows-current-user-dpapi',platform:clean.platform,origin:clean.origin,state:principal===null?'pending-direct-verification':'verified',principalHash,ciphertext:encrypted.toString('base64')};
  await mkdir(dirname(resolve(file)),{recursive:true,mode:0o700});
  const temp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{
    await writeFile(temp,JSON.stringify(envelope)+'\n',{flag:'wx',mode:0o600});
    let current=null;try{current=await readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if((current===null)!==(prior===null)||current&&sha(current)!==sha(prior))throw fail('video_session_write_conflict',409);
    // Ciphertext-only backups are recoverable without a plaintext sidecar.
    if(prior)await writeFile(file+'.backup-'+sha(prior).slice(0,16),prior,{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    assertOwned();await rename(temp,file);
  }finally{await unlink(temp).catch(()=>{});encrypted.fill(0);}
  return {platform:clean.platform,state:envelope.state,principalHash};
}
export async function readVideoSessionVault(file,{platform,allowPending=false,crypt=windowsVideoSessionCrypt}={}){
  const info=await stat(file);if(info.size>2097152)throw fail();
  const envelope=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
  if(!keys(envelope,['format','version','protection','platform','origin','state','principalHash','ciphertext'])||envelope.format!=='ai-credit-gateway-video-session'||envelope.version!==1||envelope.protection!=='windows-current-user-dpapi'||envelope.platform!==platform||!VIDEO_SESSION_RULES[platform]?.origins.includes(envelope.origin)||!['verified','pending-direct-verification'].includes(envelope.state)||!text(envelope.ciphertext,2097152)||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext))throw fail();
  if(!allowPending&&envelope.state!=='verified')throw fail('video_session_identity_pending',401);
  const plain=await crypt('unprotect',Buffer.from(envelope.ciphertext,'base64'),platform);let payload;
  try{payload=JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);}
  const clean=validateVideoSessionImport({platform:payload.platform,origin:payload.origin,cookies:payload.cookies,...(payload.accessToken===undefined?{}:{accessToken:payload.accessToken}),...(payload.expiresAtMs===undefined?{}:{expiresAtMs:payload.expiresAtMs}),...(payload.securityState===undefined?{}:{securityState:payload.securityState}),principal:null,identityEvidence:{kind:'pending-direct-verification'}});
  // Pass an exact import shape, not arbitrary decrypted properties.
  return finishRead(clean,payload,envelope,platform);
}
function finishRead(clean,payload,envelope,platform){
  if(payload.version!==1||payload.platform!==platform||payload.origin!==envelope.origin||typeof payload.importedAt!=='string')throw fail();
  const principal=payload.principal===null?null:principalText(payload.principal);
  if(envelope.state==='verified'&&(!principal||sha(`${platform}\0${principal}`)!==envelope.principalHash))throw fail('video_session_principal_changed',409);
  if(envelope.state==='pending-direct-verification'&&(principal!==null||envelope.principalHash!==null))throw fail();
  return {...clean,principal,principalHash:envelope.principalHash,source:'windows-current-user-dpapi',importedAt:payload.importedAt};
}

async function identityJson(url,headers,fetchImpl){
  const r=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json',...headers},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok){await r.body?.cancel();throw fail('video_session_official_auth_rejected',401);}
  const reader=r.body?.getReader();if(!reader)throw fail('video_session_identity_invalid',502);let count=0;const chunks=[];
  try{for(;;){const s=await reader.read();if(s.done)break;count+=s.value.length;if(count>1048576)throw fail();chunks.push(s.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function verifyVideoSessionIdentity(session,{fetchImpl=globalThis.fetch}={}){
  let id;
  if(session.platform==='vidu'){
    const url='https://service.vidu.cn/iam/v1/users/me';
    const cookie=videoSessionCookieHeader(session,url);
    if(!cookie&&!session.accessToken)throw fail('video_session_token_missing',401);
    const data=await identityJson(url,{...(cookie?{Cookie:cookie}:{}),...(session.accessToken?{Authorization:`Token ${session.accessToken}`}:{})},fetchImpl);
    id=data?.id;
  }else if(session.platform==='pixverse'){
    const data=await identityJson('https://app-api.pixverse.ai/creative_platform/getUserInfo',{Token:videoSessionAuthToken(session,'_ai_token'),'Workspace-Id':'0','X-Platform':'Web'},fetchImpl);
    if(data?.ErrCode!==0||!object(data.Resp))throw fail('video_session_identity_invalid',502);
    const a=data.Resp.AccountId,b=data.Resp.account_id;
    if(a!==undefined&&b!==undefined&&String(a)!==String(b))throw fail('video_session_identity_ambiguous',502);
    id=a??b;
  }else throw fail('video_session_identity_contract_pending',409);
  const principal=principalText(id);if(!principal)throw fail('video_session_identity_invalid',502);
  return {principal,principalHash:sha(`${session.platform}\0${principal}`)};
}
