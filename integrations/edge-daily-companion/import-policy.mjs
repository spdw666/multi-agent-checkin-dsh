export const BROKER='http://127.0.0.1:19422';
export const CONSENT='local-encrypted-seven-site-session-import-v1';
export const MAX_BODY=524288;
export const POLICY=Object.freeze({
  jimeng:{origins:['https://jimeng.jianying.com'],domains:['jimeng.jianying.com','jianying.com']},
  kling:{origins:['https://klingai.kuaishou.com','https://klingai.com','https://www.klingai.com'],domains:['klingai.kuaishou.com','kuaishou.com','klingai.com','www.klingai.com']},
  xiaoyunque:{origins:['https://xyq.jianying.com','https://www.xiaoyunque.com'],domains:['xyq.jianying.com','jianying.com','xiaoyunque.com','www.xiaoyunque.com']},
  vidu:{origins:['https://www.vidu.cn','https://service.vidu.cn'],domains:['vidu.cn','www.vidu.cn','service.vidu.cn']},
  hailuo:{origins:['https://hailuoai.com','https://www.hailuoai.com','https://hailuoai.video','https://www.hailuoai.video'],domains:['hailuoai.com','www.hailuoai.com','hailuoai.video','www.hailuoai.video'],tokenCookie:'_token'},
  pixverse:{origins:['https://app.pixverse.ai','https://app-api.pixverse.ai'],domains:['pixverse.ai','app.pixverse.ai','app-api.pixverse.ai'],tokenCookie:'_ai_token'},
  liblib:{origins:['https://www.liblib.art','https://www.liblib.tv','https://api2.liblib.art'],domains:['liblib.tv','www.liblib.tv','liblib.art','www.liblib.art','api2.liblib.art']}
});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
function keys(value,allowed,required=[]){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw new Error('unexpected_fields');}
function bounded(value,max,{empty=false}={}){return typeof value==='string'&&(empty||value.length>0)&&new TextEncoder().encode(value).length<=max&&!/[\u0000-\u001f\u007f]/.test(value);}
export function validateCookie(platform,cookie){
  const policy=Object.hasOwn(POLICY,platform)?POLICY[platform]:null;if(!policy)throw new Error('platform_not_allowed');
  keys(cookie,['name','value','domain','path','expirationDate','secure','httpOnly','sameSite'],['name','value','domain','path','secure','httpOnly','sameSite']);
  if(!bounded(cookie.name,128)||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(cookie.name)||!bounded(cookie.value,16384,{empty:true}))throw new Error('invalid_cookie_secret');
  if(!bounded(cookie.domain,253)||cookie.domain!==cookie.domain.toLowerCase()||!/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(cookie.domain)||!policy.domains.includes(cookie.domain.replace(/^\./,'')))throw new Error('cookie_domain_not_allowed');
  if(!bounded(cookie.path,2048)||!cookie.path.startsWith('/')||typeof cookie.secure!=='boolean'||typeof cookie.httpOnly!=='boolean'||!['no_restriction','lax','strict','unspecified'].includes(cookie.sameSite))throw new Error('invalid_cookie_metadata');
  if(cookie.expirationDate!==undefined&&(!Number.isFinite(cookie.expirationDate)||cookie.expirationDate<0||cookie.expirationDate>253402300799))throw new Error('invalid_cookie_expiration');
  return {...cookie};
}
export function validateImport(item){
  keys(item,['platform','principal','origin','cookies','accessToken','expiresAtMs','identityEvidence','securityState'],['platform','principal','origin','identityEvidence']);
  if(!Object.hasOwn(POLICY,item.platform)||!POLICY[item.platform].origins.includes(item.origin))throw new Error('origin_not_allowed');
  if(item.principal!==null)throw new Error('principal_requires_direct_verification');
  keys(item.identityEvidence,['kind'],['kind']);if(item.identityEvidence.kind!=='pending-direct-verification')throw new Error('identity_evidence_not_allowed');
  if(item.cookies!==undefined&&(!Array.isArray(item.cookies)||item.cookies.length>64||item.cookies.length<1&&!(item.platform==='pixverse'&&item.accessToken!==undefined)))throw new Error('cookie_count_invalid');
  const cookies=item.cookies?.map(c=>validateCookie(item.platform,c));
  if(cookies&&new Set(cookies.map(c=>c.name+'\0'+c.domain+'\0'+c.path)).size!==cookies.length)throw new Error('duplicate_cookie');
  if(item.accessToken!==undefined&&(!POLICY[item.platform].tokenCookie||!bounded(item.accessToken,16384)||/\s/.test(item.accessToken)))throw new Error('access_token_not_allowed');
  if(item.expiresAtMs!==undefined&&(!Number.isSafeInteger(item.expiresAtMs)||item.expiresAtMs<1||item.expiresAtMs>253402300799000))throw new Error('invalid_expiration');
  if(item.securityState!==undefined){if(item.platform!=='jimeng')throw new Error('security_state_not_allowed');validateSecurityState(item.securityState);}
  if(!cookies?.length&&!item.accessToken&&!item.securityState)throw new Error('empty_session');
  return {...item,...(cookies?{cookies}:{}),identityEvidence:{kind:'pending-direct-verification'}};
}
export function validateSecurityState(value){keys(value,['xmst','msuuid'],['xmst']);if(!bounded(value.xmst,16384)||/\s/.test(value.xmst)||value.msuuid!==undefined&&(!bounded(value.msuuid,256)||!/^[A-Za-z0-9._-]+$/.test(value.msuuid)))throw new Error('jimeng_security_state_invalid');return {...value};}
// Serialized only into the fixed, consented Jimeng top-level page; no caller key.
export function readJimengSecurityInPage(){
  if(location.origin!=='https://jimeng.jianying.com'||window.top!==window)throw new Error('original_jimeng_tab_required');
  const xmst=localStorage.getItem('xmst'),msuuid=localStorage.getItem('__msuuid__');
  if(!xmst)return null;
  if(typeof xmst!=='string'||new TextEncoder().encode(xmst).length>16384||/[\s\u0000-\u001f\u007f]/.test(xmst)||msuuid!==null&&(typeof msuuid!=='string'||msuuid.length>256||!/^[A-Za-z0-9._-]+$/.test(msuuid)))throw new Error('jimeng_security_state_invalid');
  return {xmst,...(msuuid?{msuuid}:{})};
}
export function validateEnvelope(payload){
  keys(payload,['version','imports'],['version','imports']);if(payload.version!==1||!Array.isArray(payload.imports)||payload.imports.length<1||payload.imports.length>7)throw new Error('invalid_import_envelope');
  const imports=payload.imports.map(validateImport);if(new Set(imports.map(i=>i.platform)).size!==imports.length)throw new Error('duplicate_platform');
  const result={version:1,imports};if(new TextEncoder().encode(JSON.stringify(result)).length>MAX_BODY)throw new Error('import_size_exceeded');return result;
}
export function projectBrowserCookie(platform,cookie,sourceOrigin){
  if(!Object.hasOwn(POLICY,platform)||!POLICY[platform].origins.includes(sourceOrigin))throw new Error('origin_not_allowed');
  if(cookie?.partitionKey)throw new Error('partitioned_session_not_supported');
  const result={name:cookie?.name,value:cookie?.value,domain:cookie?.domain,path:cookie?.path,secure:cookie?.secure,httpOnly:cookie?.httpOnly,sameSite:cookie?.sameSite,...(cookie?.expirationDate===undefined?{}:{expirationDate:cookie.expirationDate})};
  validateCookie(platform,result);const host=new URL(sourceOrigin).hostname,domain=result.domain.replace(/^\./,'');
  if(host!==domain&&!host.endsWith('.'+domain))throw new Error('cookie_source_mismatch');
  if(cookie.hostOnly===true&&host!==domain)throw new Error('cookie_source_mismatch');return result;
}
export function validateImportSession(value,extensionId,now=Date.now()){
  keys(value,['importKey','expiresAtMs','extensionId'],['importKey','expiresAtMs','extensionId']);
  if(typeof value.importKey!=='string'||!/^[A-Za-z0-9_-]{43,256}$/.test(value.importKey)||value.extensionId!==extensionId||!Number.isSafeInteger(value.expiresAtMs)||value.expiresAtMs<=now||value.expiresAtMs>now+300000)throw new Error('invalid_import_session');return value;
}
export function validateImportKey(key){if(typeof key!=='string'||!/^[A-Za-z0-9_-]{43,256}$/.test(key))throw new Error('invalid_import_key');return key;}
export function sanitizeReceipt(value){
  if(!object(value)||value.ok!==true||!Array.isArray(value.results)||value.results.length>7)throw new Error('invalid_import_receipt');
  return {ok:true,results:value.results.map(item=>{if(!object(item)||!Object.hasOwn(POLICY,item.platform)||!['verified','pending','rejected'].includes(item.status))throw new Error('invalid_import_receipt');const out={platform:item.platform,status:item.status};if(item.code!==undefined){if(typeof item.code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(item.code))throw new Error('invalid_import_receipt');out.code=item.code;}if(item.principalHash!==undefined){if(!/^[a-f0-9]{64}$/.test(item.principalHash))throw new Error('invalid_import_receipt');out.principalHash=item.principalHash;}return out;})};
}
