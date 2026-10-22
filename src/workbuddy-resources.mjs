// Adapted from workbuddy2api-panel (MIT), internal/upstream/client.go,
// CreditPackages/packageRemainUsed, commit 6b31db6d045e985042620c819c3a938002e7b0b1.
// Copyright and full permission notice: workbuddy-reference-license.mjs.
import {AppError,rememberSecret} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {wbNumber,wbDate,workBuddyUpstreamError} from './workbuddy-status.mjs';

export function normalizeWorkBuddyPackage(raw,index=0,now=Date.now()){
  const cycle=(wbNumber(raw.CycleCapacitySize)??0)>0||raw.monthly===true,size=wbNumber(cycle?raw.CycleCapacitySize??raw.size:raw.CapacitySize??raw.size??raw.total),rawRemain=wbNumber(cycle?raw.CycleCapacityRemain??raw.remain:raw.CapacityRemain??raw.remain??raw.remaining??raw.balance);
  const reportedUsed=wbNumber(cycle?raw.CycleCapacityUsed??raw.consumed:raw.CapacityUsed??raw.consumed),consumed=size!==null&&rawRemain!==null?Math.max(reportedUsed??0,size-rawRemain):reportedUsed;
  const remaining=size!==null&&consumed!==null?Math.max(0,Math.min(size,size-consumed)):rawRemain;
  const expiresAt=[raw.DeductionEndTime,raw.ExpiredTime,raw.PackageEndTime,raw.expiresAtMs,raw.expiresAt,raw.CycleEndTime].map(wbDate).find(Boolean)??null,refreshAt=wbDate(raw.refreshAtMs??raw.refreshAt??(cycle?raw.CycleEndTime:null));
  const id=raw.AccountId??raw.ResourceId??raw.PackageId??raw.Id??raw.id??null,name=String(raw.PackageName??raw.packageName??raw.name??'(未命名积分包)');
  return {id:id===null?null:String(id),rowKey:index,name,packageName:name,packageCode:raw.PackageCode??raw.packageCode??null,subProductCode:raw.SubProductCode??raw.subProductCode??null,subProductName:raw.SubProductName??raw.subProductName??null,total:size,size,remaining,balance:remaining,remain:remaining,consumed,cycle,monthly:cycle,expiresAt,expiresAtMs:expiresAt?Date.parse(expiresAt):null,createdAt:wbDate(raw.CreateTime??raw.createdAt),refreshAt,status:expiresAt&&Date.parse(expiresAt)<=now?'expired':remaining===0?'exhausted':remaining===null?'unknown':'available',upstreamStatus:raw.upstreamStatus??raw.Status??raw.status??null};
}
const format=(ms)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(ms).replace(',','');
export async function fetchWorkBuddyCreditDetails(credential,{fetchImpl=fetch,signal,maxPages=20,pageSize=100,now=Date.now()}={}){
  rememberSecret(credential.accessToken);const edition=workBuddyEdition(credential),base=edition==='ai'?'https://www.workbuddy.ai':'https://www.codebuddy.cn',path=edition==='ai'?'/billing/meter/get-user-resource':'/v2/billing/meter/get-user-resource';
  const headers={Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+credential.accessToken,'X-User-Id':String(credential.uid??credential.principal),'X-Domain':credential.domain??(edition==='ai'?'www.workbuddy.ai':'www.workbuddy.cn'),...(credential.enterpriseId?{'X-Enterprise-Id':credential.enterpriseId,'X-Tenant-Id':credential.enterpriseId}:{})};
  // Ask for historical end times as well as active ones. Status [0,3] is the
  // observed official protocol scope, not a promise of all historical statuses.
  const queryScope={endTimeBegin:'2000-01-01 00:00:00',endTimeEnd:format(now+365*101*86400000),statuses:[0,3],allHistoricalStatuses:false};
  const packages=[],seen=new Set(),pages=new Set();let complete=false,totalCount=null;
  for(let page=1;page<=maxPages;page++){
    const r=await fetchImpl(base+path,{method:'POST',headers,body:JSON.stringify({PageNumber:page,PageSize:pageSize,ProductCode:'p_tcaca',Status:queryScope.statuses,PackageEndTimeRangeBegin:queryScope.endTimeBegin,PackageEndTimeRangeEnd:queryScope.endTimeEnd}),signal:signal??AbortSignal.timeout(20000),redirect:'error'});
    let data;try{data=await r.json();}catch{
      const auth=[401,403].includes(r.status),limited=r.status===429;
      const message=r.ok?`WB 积分包响应结构待确认（HTTP ${r.status}，JSON 解析失败）`:`WB 积分包接口返回 HTTP ${r.status}${auth?r.status===401?'，当前登录态被拒绝':'，当前访问被拒绝':limited?'，暂时限流':''}；上游返回非 JSON 响应`;
      const error=new AppError(message,r.ok?502:r.status,r.ok?'wb_resource_response_invalid':auth?'wb_resource_http_auth_rejected':limited?'wb_resource_http_rate_limited':'wb_resource_http_rejected');
      error.httpStatus=r.status;
      // Retain only a media type, not parameters, the upstream body or parser
      // exception text (any of those may contain account/session material).
      const media=String(r.headers?.get?.('content-type')??'').split(';',1)[0].trim().toLowerCase();
      error.contentType=media.length<=100&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(media)?media:null;
      error.banned=false;
      if(limited)error.retryable=true;
      throw error;
    }
    if(!r.ok||data.code!==undefined&&![0,200,'0','200'].includes(data.code))throw workBuddyUpstreamError(r,data);
    const inner=data.data?.Response?.Data??data.Response?.Data??data.data??data,raw=inner.Accounts??inner.accounts;
    if(!Array.isArray(raw))throw new AppError('WB 积分包列表结构待确认',502,'wb_resource_schema_invalid');
    totalCount=wbNumber(inner.TotalCount??inner.Total??inner.total_count??data.data?.Response?.TotalCount)??totalCount;
    const pageKey=JSON.stringify(raw);if(pages.has(pageKey))break;pages.add(pageKey);
    let added=0;for(const p of raw){if(!p||typeof p!=='object')continue;const id=p.AccountId??p.ResourceId??p.PackageId??p.Id??p.id;if(id!==null&&id!==undefined){const key=String(id);if(seen.has(key))continue;seen.add(key);}packages.push(normalizeWorkBuddyPackage(p,packages.length,now));added++;}
    if(raw.length<pageSize||totalCount!==null&&packages.length>=totalCount){complete=true;break;}
    if(!added)break;
  }
  const active=packages.filter(p=>p.status!=='expired'),known=field=>complete&&active.every(p=>p[field]!==null)?active.reduce((sum,p)=>sum+p[field],0):null;
  return {total:known('remaining'),capacityTotal:known('total'),consumed:known('consumed'),packages,complete,queryScope,totalCount,packageCount:packages.length,source:'official_resource_packages',nearestExpiryMs:active.map(p=>p.expiresAtMs).filter(v=>v!==null).sort((a,b)=>a-b)[0]??null};
}
