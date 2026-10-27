export const BRIDGE = 'http://127.0.0.1:19422';
export const ALARM = 'ai-daily-companion-poll';
export const PLATFORM = Object.freeze({
  vidu: Object.freeze({page:'https://www.vidu.cn',api:'https://service.vidu.cn',identity:'/iam/v1/users/me',get:['/iam/v1/users/me','/credit/v1/credits/me','/iam/v1/users/every-day-credit']}),
  pixverse: Object.freeze({page:'https://app.pixverse.ai',api:'https://app-api.pixverse.ai',identity:'/creative_platform/getUserInfo',get:['/creative_platform/getUserInfo','/creative_platform/user/credits','/creative_platform/task/list']})
});
export function isMutation(job){return job.platform==='vidu'&&job.path==='/iam/v1/users/every-day-credit'||job.platform==='pixverse'&&job.path==='/creative_platform/reward/claim';}
export function validateJob(job){
  if(!job||Object.getPrototypeOf(job)!==Object.prototype||typeof job.id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(job.id))throw new Error('invalid_job');
  const spec=PLATFORM[job.platform];if(!spec)throw new Error('invalid_platform');
  if(typeof job.path!=='string'||job.path.includes('?')||job.path.includes('#')||job.path.includes('%')||job.path.includes('..'))throw new Error('invalid_path');
  const method=job.method??'GET';
  if(method==='GET'&&spec.get.includes(job.path)){if(job.body!==undefined)throw new Error('unexpected_body');}
  else if(job.platform==='pixverse'&&method==='POST'&&job.path==='/creative_platform/reward/claim'){
    if(!job.body||Object.getPrototypeOf(job.body)!==Object.prototype||Object.keys(job.body).length!==1||job.body.sub_type!==1)throw new Error('invalid_daily_claim');
  }else throw new Error('endpoint_not_allowed');
  if(job.principalHash!==undefined&&!/^[a-f0-9]{64}$/.test(job.principalHash))throw new Error('invalid_principal_hash');
  if(isMutation(job)&&!job.principalHash)throw new Error('mutation_requires_principal_hash');
  return {id:job.id,platform:job.platform,path:job.path,method,...(job.body===undefined?{}:{body:{sub_type:1}}),...(job.principalHash?{principalHash:job.principalHash}:{})};
}

// This function is serialized into one already-open, matching original-site tab.
// No closure references, remote code, arbitrary URL, raw headers or credential return.
export async function requestInPage(platform,path,method,body,fallbackToken,expectedPrincipalHash){
  if(body===null)body=undefined;
  const spec={vidu:{page:'https://www.vidu.cn',api:'https://service.vidu.cn',identity:'/iam/v1/users/me',get:['/iam/v1/users/me','/credit/v1/credits/me','/iam/v1/users/every-day-credit']},pixverse:{page:'https://app.pixverse.ai',api:'https://app-api.pixverse.ai',identity:'/creative_platform/getUserInfo',get:['/creative_platform/getUserInfo','/creative_platform/user/credits','/creative_platform/task/list']}}[platform];
  const mutation=platform==='vidu'&&path==='/iam/v1/users/every-day-credit'||platform==='pixverse'&&path==='/creative_platform/reward/claim';
  let operationAttempted=false;
  try{
    if(!spec||location.origin!==spec.page||window.top!==window)throw new Error('original_tab_required');
    if(!(method==='GET'&&spec.get.includes(path)&&body===undefined||platform==='pixverse'&&method==='POST'&&path==='/creative_platform/reward/claim'&&body&&Object.keys(body).length===1&&body.sub_type===1))throw new Error('endpoint_not_allowed');
    const headers={Accept:'application/json','Accept-Language':'zh-CN','X-Platform':platform==='vidu'?'web':'Web'};
    if(platform==='pixverse'){
      // Exact official Sp()/Df() cookie getter, top-level app only; not a cookie dump.
      const item=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('_ai_token='));
      const token=item?decodeURIComponent(item.slice('_ai_token='.length)):fallbackToken;
      if(typeof token!=='string'||!token||token.length>32768||/[\r\n]/.test(token))throw new Error('pixverse_login_required');
      headers.Token=token;headers['Workspace-Id']='0';
    }
    if(body!==undefined)headers['Content-Type']='application/json';
    // Re-check canonical identity in the exact page/request context before mutation.
    if(mutation){
      if(!/^[a-f0-9]{64}$/.test(expectedPrincipalHash??''))throw new Error('principal_mismatch');
      const identityResponse=await fetch(spec.api+spec.identity,{headers,credentials:platform==='vidu'?'include':'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!identityResponse.ok)throw new Error('identity_unverified');
      const identity=await identityResponse.json(),id=platform==='vidu'?identity?.id:identity?.ErrCode===0?(identity?.Resp?.AccountId??identity?.Resp?.account_id):null;
      if(!['string','number'].includes(typeof id)||!String(id)||String(id).length>256)throw new Error('identity_unverified');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(platform+'\0'+String(id)));
      if([...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')!==expectedPrincipalHash)throw new Error('principal_mismatch');
      if(platform==='pixverse'){
        const taskResponse=await fetch(spec.api+'/creative_platform/task/list',{headers,credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(!taskResponse.ok)throw new Error('daily_task_not_claimable');const tasks=await taskResponse.json();
        if(tasks?.ErrCode!==0||!Array.isArray(tasks.Resp)||tasks.Resp.length>500)throw new Error('daily_task_not_claimable');
        const matches=tasks.Resp.filter(t=>t?.task_type===1&&t?.sub_type===1);
        if(matches.length!==1||matches[0].progress!==2||!(typeof matches[0].reward==='number'&&Number.isFinite(matches[0].reward)&&matches[0].reward>0||typeof matches[0].reward==='string'&&/^\d+(?:\.\d+)?$/.test(matches[0].reward)&&Number(matches[0].reward)>0))throw new Error('daily_task_not_claimable');
      }
    }
    operationAttempted=mutation;
    const response=await fetch(spec.api+path,{method,headers,credentials:platform==='vidu'?'include':'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok){await response.body?.cancel();return {ok:false,status:response.status,error:{code:response.status===401||response.status===403?'official_login_required':'official_http_error',operationAttempted}};}
    const reader=response.body?.getReader();if(!reader)throw new Error('invalid_response');
    let size=0;const chunks=[];try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>1048576)throw new Error('response_too_large');chunks.push(item.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const wire=JSON.parse(new TextDecoder().decode(bytes));
    const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
    const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0||typeof x==='string'&&/^\d+(?:\.\d+)?$/.test(x)&&Number.isFinite(Number(x));
    const pick=(obj,keys)=>{if(!object(obj))throw new Error('invalid_response');const out={};for(const key of keys)if(number(obj[key]))out[key]=obj[key];return out;};
    if(path===spec.identity){
      const id=platform==='vidu'?wire?.id:wire?.ErrCode===0?(wire?.Resp?.AccountId??wire?.Resp?.account_id):null;
      if(!['string','number'].includes(typeof id)||!String(id)||String(id).length>256)throw new Error('identity_unverified');
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(platform+'\0'+String(id)));
      return {ok:true,status:response.status,data:{principalHash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')}};
    }
    if(platform==='vidu'){
      if(path==='/iam/v1/users/every-day-credit'){if(!Number.isSafeInteger(wire?.credit)||wire.credit<0)throw new Error('invalid_response');return {ok:true,status:response.status,data:{credit:wire.credit}};}
      const data=pick(wire,['credits','credits_free','credits_subscribed','credits_expire_today']);if(!('credits'in data))throw new Error('invalid_response');return {ok:true,status:response.status,data};
    }
    if(!object(wire)||!Number.isSafeInteger(wire.ErrCode))throw new Error('invalid_response');
    if(wire.ErrCode!==0)return {ok:true,status:response.status,data:{ErrCode:wire.ErrCode,Resp:null}};
    if(path==='/creative_platform/reward/claim')return {ok:true,status:response.status,data:{ErrCode:0,Resp:null}};
    if(path==='/creative_platform/user/credits'){
      const data=pick(wire.Resp,['credit_daily','credit_monthly','credit_package']);if(Object.keys(data).length!==3)throw new Error('invalid_response');return {ok:true,status:response.status,data:{ErrCode:0,Resp:data}};
    }
    if(!Array.isArray(wire.Resp)||wire.Resp.length>500)throw new Error('invalid_response');
    const list=wire.Resp.filter(t=>object(t)&&t.task_type===1&&t.sub_type===1).map(t=>{if(![1,2,3,4].includes(t.progress)||!number(t.reward))throw new Error('invalid_response');return {task_type:1,sub_type:1,progress:t.progress,reward:t.reward};});
    return {ok:true,status:response.status,data:{ErrCode:0,Resp:list}};
  }catch(e){
    const codes=new Set(['original_tab_required','endpoint_not_allowed','pixverse_login_required','invalid_response','response_too_large','identity_unverified','principal_mismatch','daily_task_not_claimable']);
    return {ok:false,status:0,error:{code:codes.has(e?.message)?e.message:operationAttempted?'official_request_uncertain':'official_request_failed',operationAttempted}};
  }
}
