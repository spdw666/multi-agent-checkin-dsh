// Pure one-response merge. No I/O, vault writer, browser APIs or implicit refresh.
export const VIDEO_SESSION_RULES=Object.freeze({
 jimeng:{origins:['https://jimeng.jianying.com'],domains:['jimeng.jianying.com','jianying.com'],hosts:['jimeng.jianying.com'],paths:['/passport/account/info/v2/','/commerce/v1/benefits/user_credit','/commerce/v1/benefits/user_credit_history','/commerce/v1/benefits/credit_receive']},
 kling:{origins:['https://klingai.kuaishou.com','https://app.klingai.com','https://klingai.com','https://www.klingai.com'],domains:['klingai.kuaishou.com','kuaishou.com','app.klingai.com','klingai.com','www.klingai.com'],hosts:['klingai.kuaishou.com','app.klingai.com','klingai.com','www.klingai.com','api.klingai.com'],paths:['/api/user/profile_and_features','/api/account/pointAndTicket','/api/account/contract','/api/account/trade','/api/pay/reward/v2']},
 xiaoyunque:{origins:['https://xyq.jianying.com','https://www.xiaoyunque.com'],domains:['xyq.jianying.com','jianying.com','www.xiaoyunque.com','xiaoyunque.com'],hosts:['xyq.jianying.com','www.xiaoyunque.com'],paths:['/passport/web/account/info/','/commerce/v1/benefits/user_credit','/commerce/v1/benefits/user_credit_history','/commerce/v1/benefits/credit_receive']},
 vidu:{origins:['https://www.vidu.cn','https://vidu.cn'],domains:['vidu.cn','www.vidu.cn','service.vidu.cn'],hosts:['service.vidu.cn'],paths:['/iam/v1/users/me','/iam/v1/users/every-day-credit','/credit/v1/credits/me']},
 hailuo:{origins:['https://hailuoai.com','https://www.hailuoai.com','https://hailuoai.video','https://www.hailuoai.video'],domains:['hailuoai.com','www.hailuoai.com','hailuoai.video','www.hailuoai.video'],hosts:['hailuoai.com','www.hailuoai.com','hailuoai.video','www.hailuoai.video'],paths:['/v1/api/user/info','/v1/api/user/renewal','/v1/api/billing/credit','/v1/api/billing/transactions','/v1/api/user/equity']},
 pixverse:{origins:['https://app.pixverse.ai'],domains:['pixverse.ai','app.pixverse.ai','app-api.pixverse.ai'],hosts:['app-api.pixverse.ai'],paths:['/creative_platform/getUserInfo','/creative_platform/user/credits','/creative_platform/task/list','/creative_platform/reward/claim']},
 liblib:{origins:['https://www.liblib.art','https://liblib.art','https://www.liblib.tv','https://liblib.tv'],domains:['liblib.art','www.liblib.art','api2.liblib.art','liblib.tv','www.liblib.tv'],hosts:['api2.liblib.art'],paths:['/api/www/user/getUserInfo','/api/www/member/account','/api/www/power/translogs/management','/api/www/power/trans-sources']}
});
export class OfficialCookieError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new OfficialCookieError(code);};
const clone=x=>structuredClone(x),domain=d=>typeof d==='string'?d.replace(/^\./,'').toLowerCase():'';
const key=c=>[c.name,domain(c.domain),c.path].join('\0');
const matches=(host,d)=>host===d||host.endsWith('.'+d);
const pathMatches=(target,p)=>target===p||target.startsWith(p.endsWith('/')?p:p+'/');
const auth={jimeng:['sessionid','sessionid_ss'],xiaoyunque:['sessionid','sessionid_ss'],hailuo:['_token'],pixverse:['_ai_token'],liblib:['liblibai_usertoken','usertoken','usertoken_online']};
function defaultPath(p){const i=p.lastIndexOf('/');return i<=0?'/':p.slice(0,i);}
function timeNow(now){const v=typeof now==='function'?now():now;const n=v instanceof Date?v.getTime():v;if(!Number.isFinite(n)||n<=0)fail('cookie_now_invalid');return n;}
function parse(raw,u,rule,now){
 if(typeof raw!=='string'||!raw||raw.length>32768||/[\x00-\x1f\x7f]/.test(raw))fail('set_cookie_invalid');
 const parts=raw.split(';'),pair=parts.shift(),eq=pair.indexOf('=');if(eq<=0)fail('set_cookie_invalid');
 const name=pair.slice(0,eq).trim();let value=pair.slice(eq+1).trim();if(!/^[-!#$%&'*+.^_`|~0-9A-Za-z]{1,256}$/.test(name))fail('cookie_name_invalid');
 if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
 if(value.length>16384||/[\x00-\x20\x22\x2c\x3b\x5c\x7f]/.test(value))fail('cookie_value_invalid');
 const attrs=new Map();
 for(const p of parts){const i=p.indexOf('='),a=(i<0?p:p.slice(0,i)).trim().toLowerCase(),v=i<0?null:p.slice(i+1).trim();if(!a)continue;if(['domain','path','max-age','expires','secure','httponly','samesite','partitioned'].includes(a)){if(attrs.has(a))fail('cookie_attribute_duplicate');attrs.set(a,v);}}
 if(attrs.has('partitioned'))fail('cookie_partitioned_unsupported');
 let d=u.hostname;if(attrs.has('domain')){const rawDomain=attrs.get('domain');if(!rawDomain||!/^\.?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(rawDomain))fail('cookie_domain_invalid');d=domain(rawDomain);if(!rule.domains.includes(d)||!matches(u.hostname,d))fail('cookie_domain_scope');}
 if(!rule.domains.includes(d))fail('cookie_domain_scope');
 const p=attrs.has('path')?attrs.get('path'):defaultPath(u.pathname);if(typeof p!=='string'||!p.startsWith('/')||p.length>2048||!pathMatches(u.pathname,p))fail('cookie_path_scope');
 const secure=attrs.has('secure'),httpOnly=attrs.has('httponly');if(secure&&attrs.get('secure')!==null||httpOnly&&attrs.get('httponly')!==null)fail('cookie_flag_invalid');
 const ss=attrs.has('samesite')?attrs.get('samesite')?.toLowerCase():'unspecified',sameSite=ss==='none'?'no_restriction':ss;if(!['lax','strict','no_restriction','unspecified'].includes(sameSite)||sameSite==='no_restriction'&&!secure)fail('cookie_samesite_invalid');
 if(name.startsWith('__Secure-')&&!secure||name.startsWith('__Host-')&&(!secure||attrs.has('domain')||p!=='/'))fail('cookie_prefix_invalid');
 let expiry;
 if(attrs.has('max-age')){const rawAge=attrs.get('max-age');if(!/^-?\d{1,15}$/.test(rawAge??''))fail('cookie_expiration_invalid');const age=Number(rawAge);if(!Number.isSafeInteger(age))fail('cookie_expiration_invalid');expiry=age<=0?0:Math.min(253402300799,Math.floor(now/1000)+age);}
 else if(attrs.has('expires')){const n=Date.parse(attrs.get('expires')??'');if(!Number.isFinite(n))fail('cookie_expiration_invalid');expiry=Math.floor(n/1000);}
 const cookie={name,value,domain:attrs.has('domain')?'.'+d:d,path:p,secure,httpOnly,sameSite,...(expiry===undefined?{}:{expirationDate:expiry})};
 return{cookie,deleted:expiry!==undefined&&expiry*1000<=now||!!auth[u.__platform]?.includes(name)&&value===''};
}
export function applyOfficialSetCookies(session,rawHeaders,requestUrl,{now=Date.now()}={}){
 if(!session||typeof session!=='object'||!Object.hasOwn(VIDEO_SESSION_RULES,session.platform))fail('cookie_platform_invalid');const rule=VIDEO_SESSION_RULES[session.platform];
 if(!rule.origins.includes(session.origin)||!Array.isArray(session.cookies)||session.cookies.length>64)fail('cookie_session_invalid');
 let u;try{u=new URL(requestUrl);}catch{fail('cookie_request_scope');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!rule.hosts.includes(u.hostname)||!rule.paths.includes(u.pathname))fail('cookie_request_scope');u.__platform=session.platform;
 const tick=timeNow(now);if(!Array.isArray(rawHeaders)||rawHeaders.length>64||rawHeaders.reduce((n,s)=>n+(typeof s==='string'?s.length:32769),0)>262144)fail('set_cookie_headers_invalid');
 const next=clone(session),jar=new Map();
 for(const c of next.cookies){if(!c||typeof c.name!=='string'||typeof c.value!=='string'||!rule.domains.includes(domain(c.domain))||typeof c.path!=='string'||!c.path.startsWith('/'))fail('cookie_session_invalid');const k=key(c);if(jar.has(k))fail('cookie_existing_duplicate');jar.set(k,c);}
 const seen=new Set(),changedNames=new Set(),deletedNames=new Set();let logout=false,authTouched=false;
 for(const raw of rawHeaders){const {cookie,deleted}=parse(raw,u,rule,tick),k=key(cookie);if(seen.has(k))fail('cookie_response_duplicate');seen.add(k);const old=jar.get(k);if(auth[session.platform]?.includes(cookie.name))authTouched=true;
  if(deleted){if(old){jar.delete(k);changedNames.add(cookie.name);}deletedNames.add(cookie.name);}
  else if(JSON.stringify(old)!==JSON.stringify(cookie)){jar.set(k,cookie);changedNames.add(cookie.name);}
 }
 if(jar.size>64)fail('cookie_count_invalid');next.cookies=[...jar.values()];
 const tokenName=session.platform==='hailuo'?'_token':session.platform==='pixverse'?'_ai_token':null;
 const applies=c=>{const d=domain(c.domain);return(c.domain.startsWith('.')?matches(u.hostname,d):u.hostname===d)&&pathMatches(u.pathname,c.path)&&(!c.secure||u.protocol==='https:')&&(!c.expirationDate||c.expirationDate*1000>tick)&&c.value!=='';};
 const usableAuth=next.cookies.filter(c=>auth[session.platform]?.includes(c.name)&&applies(c));
 if(authTouched)logout=usableAuth.length===0;
 if(tokenName&&authTouched){
  const tokens=usableAuth.filter(c=>c.name===tokenName);const values=[...new Set(tokens.map(c=>c.value).filter(Boolean))];
  if(values.length>1)fail('cookie_token_ambiguous');
  if(values.length===1&&!logout){let value;try{value=decodeURIComponent(values[0]);}catch{value=values[0];}if(!value||value.length>32768||/[\s\x00-\x1f\x7f]/.test(value))fail('cookie_token_invalid');next.accessToken=value;const expiry=tokens.filter(c=>c.value===values[0]).map(c=>c.expirationDate).filter(Number.isFinite);if(expiry.length)next.expiresAtMs=Math.min(...expiry)*1000;else delete next.expiresAtMs;}
  else{logout=true;delete next.accessToken;delete next.expiresAtMs;}
 }
 if(logout){delete next.accessToken;delete next.expiresAtMs;}
 if(next.platform!==session.platform||next.origin!==session.origin||JSON.stringify(next.principal)!==JSON.stringify(session.principal)||next.principalHash!==session.principalHash)fail('cookie_subject_changed');
 const changed=JSON.stringify(next)!==JSON.stringify(session),revalidationRequired=changed||authTouched;
 return{session:next,changed,logout,changedNames:[...changedNames],deletedNames:[...deletedNames],revalidationRequired,reason:logout?'auth_cookie_unavailable':revalidationRequired?'revalidation_required':'unchanged'};
}
