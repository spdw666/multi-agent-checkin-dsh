import {projectBrowserCookie} from './import-policy.mjs';
// Exact first-party PixVerse top-level auth key. Serialized into one bound tab.
// No localStorage/sessionStorage, networking, writes, or unrelated value export.
export function readPixverseTokenInPage(){
 try{
  if(location.origin!=='https://app.pixverse.ai'||window.top!==window)throw new Error('original_pixverse_tab_required');
  const values=[];
  for(const match of document.cookie.matchAll(/(?:^|;\s*)_ai_token=([^;]*)/g)){
   let value=match[1];if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
   try{value=value.replace(/(%[\dA-F]{2})+/gi,decodeURIComponent);}catch{throw new Error('pixverse_token_invalid');}
   if(!value)continue;
   if(new TextEncoder().encode(value).length>16384||/[\s\u0000-\u001f\u007f]/.test(value))throw new Error('pixverse_token_invalid');
   values.push(value);
  }
  const unique=[...new Set(values)];if(unique.length>1)throw new Error('pixverse_token_ambiguous');
  return unique.length?{accessToken:unique[0]}:null;
 }catch(error){return {errorCode:['original_pixverse_tab_required','pixverse_token_invalid','pixverse_token_ambiguous'].includes(error?.message)?error.message:'pixverse_page_token_unavailable'};}
}

export function validatePixversePageToken(value){
 if(value===null)return null;
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&['original_pixverse_tab_required','pixverse_token_invalid','pixverse_token_ambiguous','pixverse_page_token_unavailable'].includes(value.errorCode))throw new Error(value.errorCode);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'accessToken')||typeof value.accessToken!=='string'||!value.accessToken||new TextEncoder().encode(value.accessToken).length>16384||/[\s\u0000-\u001f\u007f]/.test(value.accessToken))throw new Error('pixverse_token_invalid');
 return {accessToken:value.accessToken};
}

// Every matching tab must map unambiguously to the same cookie store. Do not
// combine a private/other store with the extension's default execution store.
function selectOriginCookieStore(tabs,stores,origin){
 const pages=tabs.filter(tab=>{try{return new URL(tab.url).origin===origin;}catch{return false;}});
 if(!pages.length||pages.some(t=>!Number.isSafeInteger(t.id)||t.id<0))throw new Error('cookie_store_missing');
 if(!Array.isArray(stores)||stores.length>64)throw new Error('cookie_store_invalid');
 const seen=new Set();for(const s of stores){if(!s||typeof s.id!=='string'||!s.id||s.id.length>128||/[\s\u0000-\u001f\u007f]/.test(s.id)||!Array.isArray(s.tabIds)||s.tabIds.length>10000||s.tabIds.some(id=>!Number.isSafeInteger(id)||id<0)||seen.has(s.id))throw new Error('cookie_store_invalid');seen.add(s.id);}
 const ids=pages.map(tab=>{const found=stores.filter(s=>s.tabIds.includes(tab.id));if(!found.length)throw new Error('cookie_store_missing');if(found.length!==1)throw new Error('cookie_store_ambiguous');return found[0].id;});
 if(new Set(ids).size!==1)throw new Error('cookie_store_ambiguous');
 const selected=pages.filter(t=>t.active===true).sort((a,b)=>a.id-b.id)[0]??[...pages].sort((a,b)=>a.id-b.id)[0];
 return {storeId:ids[0],tabId:selected.id};
}
export const selectPixverseCookieStore=(tabs,stores)=>selectOriginCookieStore(tabs,stores,'https://app.pixverse.ai');
export const selectJimengCookieStore=(tabs,stores)=>selectOriginCookieStore(tabs,stores,'https://jimeng.jianying.com');

// Domain query intentionally covers all original Cookie Paths. Exclude other
// subdomains using metadata BEFORE reading their values. Preserve every accepted
// cookie's attributes; the fixed whoami HTTP helper still applies Path matching.
export function projectJimengDomainCookies(rows,storeId,now=Date.now()){
 if(!Array.isArray(rows)||rows.length>256)throw new Error('cookie_count_invalid');
 const host='jimeng.jianying.com',whoami='/passport/account/info/v2/',known=new Set(['sessionid','sessionid_ss','sid_guard','sid_tt']),jar=new Map();
 const metadata={platform:'jimeng',storeMatched:true,queryMode:'domain',returnedCookieCount:rows.length,acceptedCookieCount:0,excludedHostnameCount:0,expiredCookieCount:0,distinctPathCount:0,nonRootPathCookieCount:0,rootQueryCookieCount:0,whoamiCookieCount:0,knownAuthCount:0,knownAuthWhoamiCount:0};
 const applies=(path,target)=>target===path||target.startsWith(path.endsWith('/')?path:path+'/');
 for(const row of rows){
  if(row?.storeId!==storeId)throw new Error('cookie_store_mismatch');
  const raw=typeof row.domain==='string'?row.domain:'',base=raw.replace(/^\./,'');
  const domainMatch=raw===raw.toLowerCase()&&['jianying.com',host].includes(base)&&(raw.startsWith('.')?(host===base||host.endsWith('.'+base)):host===base)&&!(row.hostOnly===true&&host!==base);
  if(!domainMatch){metadata.excludedHostnameCount++;continue;}
  if(row.expirationDate!==undefined&&row.expirationDate*1000<=now){metadata.expiredCookieCount++;continue;}
  const cookie=projectBrowserCookie('jimeng',row,'https://'+host),key=cookie.name+'\0'+cookie.domain+'\0'+cookie.path,old=jar.get(key);
  if(old&&JSON.stringify(old)!==JSON.stringify(cookie))throw new Error('jimeng_cookie_ambiguous');jar.set(key,cookie);
 }
 const cookies=[...jar.values()];metadata.acceptedCookieCount=cookies.length;metadata.distinctPathCount=new Set(cookies.map(c=>c.path)).size;
 for(const c of cookies){if(c.path!=='/')metadata.nonRootPathCookieCount++;if(applies(c.path,'/'))metadata.rootQueryCookieCount++;if(applies(c.path,whoami))metadata.whoamiCookieCount++;if(known.has(c.name)&&c.value){metadata.knownAuthCount++;if(applies(c.path,whoami))metadata.knownAuthWhoamiCount++;}}
 return {cookies,metadata};
}

// Optional Jimeng SDK storage may initialize just after the tab is ready.
// Only the already approved two keys are read; at most 29 attempts / 7 seconds.
// The caller retains its independent 8-second execution timeout.
export async function readJimengSecurityWithRetryInPage(){
 const clock=()=>typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now(),deadline=clock()+7000;
 for(let attempt=0;attempt<29;attempt++){
  if(attempt>0&&clock()>=deadline)return null;
  if(location.origin!=='https://jimeng.jianying.com'||window.top!==window)throw new Error('original_jimeng_tab_required');
  let xmst,msuuid;
  try{xmst=localStorage.getItem('xmst');if(xmst)msuuid=localStorage.getItem('__msuuid__');}catch{}
  if(xmst){
   if(typeof xmst!=='string'||new TextEncoder().encode(xmst).length>16384||/[\s\u0000-\u001f\u007f]/.test(xmst)||msuuid!==undefined&&msuuid!==null&&(typeof msuuid!=='string'||msuuid.length>256||!/^[A-Za-z0-9._-]+$/.test(msuuid)))throw new Error('jimeng_security_state_invalid');
   return {xmst,...(msuuid?{msuuid}:{})};
  }
  if(attempt<28)await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(250,deadline-clock()))));
 }
 return null;
}
