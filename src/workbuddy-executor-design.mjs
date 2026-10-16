import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AppError,rememberSecret} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';

// Official 5.8.2 ArdotManager + fetchArdotAccessToken contract. Ardot is an
// independent connector: the WorkBuddy bearer is used only at the WB origin.
// The exchanged ticket lives only in the isolated subprocess environment.
const host='https://www.workbuddy.cn';
const oauth='/as/connector/oauth/ardot';
const allowedDomains=new Set(['www.workbuddy.cn','workbuddy.cn','www.codebuddy.cn','codebuddy.cn','copilot.tencent.com']);
export async function prepareWorkBuddyDesign({service,accountId,signal,check=()=>{},root,env}={}){
  const active=()=>{check();signal?.throwIfAborted();};active();
  if(typeof root!=='string'||!root||!env||typeof env!=='object')throw new AppError('设计执行工作区未就绪',409,'wb_design_workspace_required');
  const credential=await service.credentials.resolve(accountId);active();
  if(workBuddyEdition(credential)!=='cn'||!credential.accessToken||!allowedDomains.has(credential.domain??'www.workbuddy.cn'))throw new AppError('设计服务账号环境待确认',409,'wb_design_account_unconfirmed');
  rememberSecret(credential.accessToken);
  const fetchImpl=service.workbuddyRuntime?.fetchImpl??fetch;
  const request=async(path,{method='GET',alreadyConnected=false}={})=>{
    active();const timeout=new AbortController(),combined=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
    const timer=setTimeout(()=>timeout.abort(new DOMException('Design authorization request timed out','TimeoutError')),20000);timer.unref?.();
    try{
      const response=await fetchImpl(host+path,{method,headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+credential.accessToken,'X-Domain':credential.domain??'www.workbuddy.cn','X-User-Id':String(credential.uid??credential.principal)},...(method==='POST'?{body:'{}'}:{}),redirect:'manual',signal:combined});active();
      // Official shadow-account connect can respond with a non-JSON OAuth
      // callback redirect. Observe its identity, never navigate/follow it or
      // transfer WB headers. Redirect alone is not authorization confirmation.
      if(alreadyConnected&&response.status>=300&&response.status<400){
        let callback;try{callback=new URL(response.headers.get('location')??'',host);}catch{}
        if(!callback||callback.protocol!=='https:'||callback.username||callback.password||callback.port||!['www.codebuddy.cn','codebuddy.cn','www.workbuddy.cn','workbuddy.cn'].includes(callback.hostname)||callback.pathname!=='/agents/callback')throw new AppError('设计服务授权回调待确认',502,'wb_design_redirect_unconfirmed');
        const callbackStatus=callback.searchParams.get('httpstatus');
        if(/^\d{3}$/.test(callbackStatus??'')&&Number(callbackStatus)>=400){const error=new AppError('设计服务官方授权未就绪',409,'wb_design_auth_rejected');error.callbackRejected=true;throw error;}
        return {code:-302,redirected:true};
      }
      let row;try{row=await response.json();}catch{active();throw new AppError('设计服务授权响应待确认',502,'wb_design_auth_response_invalid');}active();
      if(!response.ok||!row||typeof row!=='object'||row.code!==0&&!(alreadyConnected&&(row.code===302||row.code===-302)))throw new AppError('设计服务授权未就绪',response.ok?502:response.status,'wb_design_auth_rejected');
      return row;
    }finally{clearTimeout(timer);}
  };
  const status=await request('/v2'+oauth+'/status');
  // The official payload uses data.status === "connected". The legacy boolean
  // is retained for compatible fixtures, but is not required of modern clients.
  if(status.data?.status!=='connected'&&status.data?.connected!==true){
    let connected;
    try{connected=await request('/v2'+oauth+'/connect?code=shadow_account_grant',{method:'POST',alreadyConnected:true});}
    catch(error){active();if(error?.name==='AbortError'||error?.callbackRejected===true)throw error;connected=await request('/console'+oauth+'/connect?code=shadow_account_grant',{method:'POST',alreadyConnected:true});}
    // Independent server readback follows the normal OAuth redirect. A valid
    // subsequent connector ticket, rather than 302, is the readiness proof.
    if(connected.redirected)await request('/v2'+oauth+'/status');
  }
  let ticket;
  try{ticket=await request('/v2'+oauth+'/accesstoken');}
  catch(error){active();if(error?.name==='AbortError')throw error;ticket=await request('/console'+oauth+'/accesstoken');}
  active();const token=ticket.data?.access_token??ticket.data?.token;
  if(typeof token!=='string'||!token.trim())throw new AppError('设计服务未返回执行凭据',502,'wb_design_token_missing');
  rememberSecret(token);
  const file=join(root,'ardot-mcp.json');
  await writeFile(file,JSON.stringify({mcpServers:{ardot:{type:'http',url:'https://ardot.tencent.com/mcp',headers:{Authorization:'Bearer ${WB_EXECUTOR_ARDOT_TOKEN}'}}}}),{mode:0o600});active();
  env.WB_EXECUTOR_ARDOT_TOKEN=token;
  return {args:['--mcp-config',file,'--strict-mcp-config']};
}
