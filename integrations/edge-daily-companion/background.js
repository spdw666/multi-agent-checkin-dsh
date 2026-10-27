import {BROKER,CONSENT,POLICY,MAX_BODY,projectBrowserCookie,validateEnvelope,validateImportKey,validateImportSession,sanitizeReceipt,readJimengSecurityInPage,validateSecurityState} from './import-policy.mjs';
import {withTimeout} from './timeout.mjs';
import {selectPixverseCookieStore,selectJimengCookieStore,projectJimengDomainCookies,readPixverseTokenInPage,validatePixversePageToken,readJimengSecurityWithRetryInPage} from './page-session-fragments.mjs';
export const IMPORT_TIMEOUTS=Object.freeze({total:30000,cleanup:2000,api:5000,jimeng:8000,post:20000});
const SAFE_CODES=new Set(['cookies_permission_required','invalid_import_key','ambiguous_platform_origin','no_site_tab','no_site_sessions','invalid_import_receipt','import_size_exceeded','partitioned_session_not_supported','cookie_domain_not_allowed','invalid_cookie_secret','invalid_cookie_metadata','cookie_source_mismatch','cookie_count_invalid','access_token_not_allowed','import_total_timeout','permissions_check_timeout','permissions_check_failed','permissions_revoke_timeout','permissions_revoke_failed','import_post_timeout','local_import_rejected','tabs_query_timeout','tabs_query_failed','cookies_query_timeout','cookies_query_failed','jimeng_security_state_timeout','jimeng_security_state_unavailable','import_connection_not_armed','import_connection_expired','import_session_timeout','import_session_failed','import_session_rejected','invalid_import_session','import_session_origin_mismatch','local_import_already_used','local_import_confirmation_required','local_import_authorization_invalid','local_import_origin_invalid','local_import_host_invalid','local_import_json_required','local_import_schema_invalid','local_import_method_invalid']);
for(const code of ['cookie_store_query_timeout','cookie_store_query_failed','cookie_store_missing','cookie_store_ambiguous','cookie_store_invalid','cookie_store_mismatch','pixverse_page_token_timeout','pixverse_page_token_failed','pixverse_page_token_missing','pixverse_page_token_unavailable','pixverse_token_invalid','pixverse_token_ambiguous','original_pixverse_tab_required'])SAFE_CODES.add(code);
SAFE_CODES.add('jimeng_cookie_ambiguous');
export function createImportController(api,{fetchImpl=(...args)=>fetch(...args),timeouts=IMPORT_TIMEOUTS}={}){
  let inFlight=null,progress={running:false,phase:'idle'},readMetadata=[];
  const safe=error=>SAFE_CODES.has(error?.message)?error.message:'local_import_failed';
  const step=async(action,ms,code,signal)=>{try{return await withTimeout(action,ms,code,signal);}catch(error){if(error?.message===code||error?.message==='import_total_timeout')throw error;throw new Error(code.replace(/_timeout$/,'_failed'));}};
  async function responseError(response,signal,timeoutCode,fallback){
    let body;try{const text=await step(()=>response.text(),timeouts.api,timeoutCode,signal);if(text.length>MAX_BODY)throw new Error();body=JSON.parse(text);}catch(error){if(error?.message===timeoutCode||error?.message==='import_total_timeout')throw error;throw new Error(fallback);}
    if(body?.code==='local_import_already_used')throw Object.assign(new Error('local_import_already_used'),{priorReceipt:sanitizeReceipt({...body,ok:true})});
    throw new Error(SAFE_CODES.has(body?.code)?body.code:fallback);
  }
  async function collect(signal,warnings){
    const imports=[];
    for(const [platform,policy]of Object.entries(POLICY)){
      if(signal.aborted)throw new Error('import_total_timeout');progress={running:true,phase:'query_tabs',platform};
      const pages=policy.origins.filter(o=>!new URL(o).hostname.startsWith('api2.')&&!new URL(o).hostname.startsWith('service.')&&!new URL(o).hostname.startsWith('app-api.'));
      let tabs;try{tabs=await step(()=>api.tabs.query({url:pages.map(o=>o+'/*')}),timeouts.api,'tabs_query_timeout',signal);}catch(error){if(signal.aborted)throw error;warnings.push({platform,code:safe(error)});continue;}
      const actual=[...new Set(tabs.map(t=>{try{return new URL(t.url).origin;}catch{return null;}}).filter(o=>pages.includes(o)))];
      if(!actual.length){warnings.push({platform,code:'no_site_tab'});continue;}if(actual.length!==1){warnings.push({platform,code:'ambiguous_platform_origin'});continue;}
      const origin=actual[0],host=new URL(origin).hostname,related=policy.origins.filter(o=>{const h=new URL(o).hostname;return h===host||h.split('.').slice(-2).join('.')===host.split('.').slice(-2).join('.')||platform==='liblib'&&h==='api2.liblib.art';});
      const jar=new Map();let securityState,pageAccessToken,pixverseBinding,jimengBinding,pixverseQueryFailed=false,pixverseStoreInvalid=false;
      if(platform==='pixverse'||platform==='jimeng'){
        progress={running:true,phase:'query_cookie_stores',platform};
        try{const stores=await step(()=>api.cookies.getAllCookieStores(),timeouts.api,'cookie_store_query_timeout',signal);if(platform==='jimeng')jimengBinding=selectJimengCookieStore(tabs,stores);else pixverseBinding=selectPixverseCookieStore(tabs,stores);}
        catch(error){if(signal.aborted)throw error;warnings.push({platform,code:safe(error)});if(platform==='jimeng')readMetadata.push({platform,storeMatched:false,code:safe(error)});continue;}
      }
      if(platform==='jimeng'){
        progress={running:true,phase:'optional_jimeng_security',platform};const tab={id:jimengBinding.tabId};
        try{const result=await step(()=>api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'MAIN',injectImmediately:true,func:readJimengSecurityWithRetryInPage}),timeouts.jimeng,'jimeng_security_state_timeout',signal);if(result.length!==1||result[0].result===null)throw new Error('jimeng_security_state_unavailable');securityState=validateSecurityState(result[0].result);}
        catch(error){if(signal.aborted)throw error;warnings.push({platform,code:error?.message==='jimeng_security_state_timeout'?'jimeng_security_state_timeout':'jimeng_security_state_unavailable'});}
      }
      if(platform==='jimeng'){
        progress={running:true,phase:'query_domain_cookies',platform};
        try{const rows=await step(()=>api.cookies.getAll({domain:'jianying.com',storeId:jimengBinding.storeId}),timeouts.api,'cookies_query_timeout',signal);const projected=projectJimengDomainCookies(rows,jimengBinding.storeId);for(const c of projected.cookies)jar.set(c.name+'\0'+c.domain+'\0'+c.path,c);readMetadata.push({...projected.metadata,matchedTabCount:tabs.filter(t=>{try{return new URL(t.url).origin===origin;}catch{return false;}}).length});}
        catch(error){if(signal.aborted)throw error;warnings.push({platform,code:safe(error)});readMetadata.push({platform,storeMatched:true,queryMode:'domain',code:safe(error)});continue;}
      }else for(const sourceOrigin of related){
        progress={running:true,phase:'query_cookies',platform};let rows;
        try{rows=await step(()=>api.cookies.getAll({url:sourceOrigin+'/',...(pixverseBinding?{storeId:pixverseBinding.storeId}:{})}),timeouts.api,'cookies_query_timeout',signal);}catch(error){if(signal.aborted)throw error;warnings.push({platform,code:safe(error)});if(platform==='pixverse')pixverseQueryFailed=true;continue;}
        if(!Array.isArray(rows)||rows.length>256)throw new Error('cookie_count_invalid');
        for(const row of rows){if(pixverseBinding&&row.storeId!==pixverseBinding.storeId){warnings.push({platform,code:'cookie_store_mismatch'});pixverseStoreInvalid=true;break;}if(row.expirationDate!==undefined&&row.expirationDate*1000<=Date.now())continue;const cookie=projectBrowserCookie(platform,row,sourceOrigin);const key=cookie.name+'\0'+cookie.domain+'\0'+cookie.path,old=jar.get(key);if(platform==='pixverse'&&cookie.name==='_ai_token'&&old&&old.value!==cookie.value){warnings.push({platform,code:'pixverse_token_ambiguous'});pixverseStoreInvalid=true;break;}jar.set(key,cookie);}
        if(pixverseStoreInvalid)break;
      }
      if(platform==='pixverse'&&pixverseStoreInvalid)continue;
      if(platform==='pixverse'&&!jar.size&&!pixverseQueryFailed){
        progress={running:true,phase:'optional_pixverse_page_token',platform};
        try{const result=await step(()=>api.scripting.executeScript({target:{tabId:pixverseBinding.tabId,frameIds:[0]},world:'MAIN',injectImmediately:true,func:readPixverseTokenInPage}),timeouts.jimeng,'pixverse_page_token_timeout',signal);if(!Array.isArray(result)||result.length!==1||result[0].frameId!==0)throw new Error('pixverse_token_invalid');const token=validatePixversePageToken(result[0].result);if(!token)throw new Error('pixverse_page_token_missing');pageAccessToken=token.accessToken;}
        catch(error){if(signal.aborted)throw error;warnings.push({platform,code:safe(error)});}
      }
      if(!jar.size&&!securityState&&!pageAccessToken){if(!warnings.some(w=>w.platform===platform&&(platform==='pixverse'||['cookies_query_timeout','cookies_query_failed'].includes(w.code))))warnings.push({platform,code:'no_site_sessions'});continue;}
      const cookies=[...jar.values()],tokens=policy.tokenCookie?cookies.filter(c=>c.name===policy.tokenCookie&&c.value):[];
      if(tokens.length>1&&new Set(tokens.map(c=>c.value)).size>1){if(platform==='pixverse'){warnings.push({platform,code:'pixverse_token_ambiguous'});continue;}throw new Error('ambiguous_session_token');}const selected=tokens[0];
      imports.push({platform,principal:null,origin,...(cookies.length||platform==='pixverse'&&pageAccessToken?{cookies}:{}),...(selected?{accessToken:selected.value,...(selected.expirationDate===undefined?{}:{expiresAtMs:Math.floor(selected.expirationDate*1000)})}:pageAccessToken?{accessToken:pageAccessToken}:{}),...(securityState?{securityState}:{}),identityEvidence:{kind:'pending-direct-verification'}});
    }
    if(!imports.length)throw new Error(warnings[0]?.code??'no_site_sessions');return validateEnvelope({version:1,imports});
  }
  async function perform(providedKey){
    const controller=new AbortController(),warnings=[];readMetadata=[];let payload=null,importKey=null,sessionExpiresAtMs=null,output,cleanupCode;
    const deadline=setTimeout(()=>controller.abort(),Math.max(1,timeouts.total-timeouts.cleanup));
    try{
      progress={running:true,phase:'check_permissions'};
      if(!await step(()=>api.permissions.contains({permissions:['cookies','scripting']}),timeouts.api,'permissions_check_timeout',controller.signal))throw new Error('cookies_permission_required');
      if(providedKey===undefined||providedKey===null||typeof providedKey==='string'&&!providedKey.trim()){
        progress={running:true,phase:'local_import_session'};
        const sessionResponse=await step(()=>fetchImpl(BROKER+'/v1/import-session',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-Edge-Daily-Extension':api.runtime.id},body:'{}',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal}),timeouts.api,'import_session_timeout',controller.signal);
        if(sessionResponse.url&&sessionResponse.url!==BROKER+'/v1/import-session')throw new Error('import_session_origin_mismatch');
        if(!sessionResponse.ok)await responseError(sessionResponse,controller.signal,'import_session_timeout',[401,403,409].includes(sessionResponse.status)?'import_connection_not_armed':'import_session_rejected');
        const sessionText=await step(()=>sessionResponse.text(),timeouts.api,'import_session_timeout',controller.signal);if(sessionText.length>2048)throw new Error('invalid_import_session');
        let session;try{session=validateImportSession(JSON.parse(sessionText),api.runtime.id);}catch{throw new Error('invalid_import_session');}
        importKey=session.importKey;sessionExpiresAtMs=session.expiresAtMs;
      }else importKey=validateImportKey(typeof providedKey==='string'?providedKey.trim():providedKey);
      payload=await collect(controller.signal,warnings);progress={running:true,phase:'local_vault_post'};
      if(sessionExpiresAtMs!==null&&sessionExpiresAtMs<=Date.now())throw new Error('import_connection_expired');
      const response=await step(()=>fetchImpl(BROKER+'/v1/imports',{method:'POST',headers:{Accept:'application/json','X-Edge-Daily-Extension':api.runtime.id,Authorization:'Bearer '+importKey,'Content-Type':'application/json'},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,body:JSON.stringify(payload)}),timeouts.post,'import_post_timeout',controller.signal);
      if(!response.ok)await responseError(response,controller.signal,'import_post_timeout','local_import_rejected');const text=await step(()=>response.text(),timeouts.post,'import_post_timeout',controller.signal);if(text.length>MAX_BODY)throw new Error('invalid_import_receipt');output=sanitizeReceipt(JSON.parse(text));
      for(const warning of warnings){const found=output.results.find(r=>r.platform===warning.platform);if(found){found.code=warning.code;if(warning.platform==='jimeng'&&warning.code.startsWith('jimeng_security_state_'))found.status='pending';}else output.results.push({platform:warning.platform,status:'pending',code:warning.code});}
    }catch(error){output=error?.message==='local_import_already_used'&&error.priorReceipt?{...error.priorReceipt,alreadyImported:true,code:'local_import_already_used'}:{ok:false,error:safe(error)};}
    finally{
      clearTimeout(deadline);controller.abort();payload=null;importKey=null;progress={running:true,phase:'revoke_permissions'};
      try{await step(()=>api.permissions.remove({permissions:['cookies','scripting']}),timeouts.cleanup,'permissions_revoke_timeout');}catch(error){cleanupCode=safe(error);}progress={running:false,phase:'idle',...(cleanupCode?{code:cleanupCode}:{})};
    }
    if(cleanupCode)return {ok:false,error:cleanupCode};return {...output,...(readMetadata.length?{readMetadata:readMetadata.map(item=>({...item}))}:{})};
  }
  return {start(key){if(inFlight)return inFlight;inFlight=perform(key).finally(()=>{inFlight=null;});return inFlight;},progress(){return {...progress,...(readMetadata.length?{readMetadata:readMetadata.map(item=>({...item}))}:{})};},async revoke(){try{await step(()=>api.permissions.remove({permissions:['cookies','scripting']}),timeouts.cleanup,'permissions_revoke_timeout');}catch{}}};
}
const controller=createImportController(chrome);
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return false;
  if(message?.action==='import-progress'){reply(controller.progress());return false;}
  if(message?.action!=='import-once'||message?.consent!==CONSENT)return false;
  void controller.start(message.importKey).then(reply,()=>reply({ok:false,error:'local_import_failed'}));return true;
});
for(const event of [chrome.runtime.onStartup,chrome.runtime.onInstalled])event.addListener(()=>{void controller.revoke();});
