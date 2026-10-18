// Metadata-only activity projection. Never persist prompts, arguments, result bodies or file paths.
import {AppError} from './util.mjs';
const KEYS=['system','user','assistant','toolSchemas','toolResults'];
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const count=v=>Math.floor(finite(v)??0);
const canonicalStatus=v=>v==='completed'?'success':['success','failed','running','cancelled','skipped'].includes(v)?v:'unknown';
// Legacy rows predate dispatch instrumentation. A new skipped row is a local
// candidate decision, never a chargeable upstream attempt or an unknown usage.
const wasDispatched=row=>row.rowType!=='request_outcome'&&row.status!=='skipped'&&row.dispatched!==false;
const dispatches=row=>wasDispatched(row)?Math.max(1,count(row.dispatchCount)||count(row.transportAttempts)||1):0;
const emptyComposition=()=>Object.fromEntries(KEYS.map(k=>[k,{chars:0,estimatedTokens:0}]));
const textLength=v=>{if(typeof v==='string')return v.length;if(v==null)return 0;try{return JSON.stringify(v).length}catch{return 0}};
const safeId=(v,max=160)=>typeof v==='string'&&v.length<=max&&/^[\p{L}\p{N}_.:/@+ -]+$/u.test(v)&&!/(?:[A-Za-z]:[\\/]|https?:|bearer|sk-[a-z0-9]{8}|api[_-]?key|token=|\/users\/|\/home\/)/i.test(v)?v:'';
const safeCode=v=>typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(v)&&!/(?:sk-|bearer|token|secret)/i.test(v)?v:'';
const sourceName=v=>/dsh/i.test(v??'')?'dsh':/hermes/i.test(v??'')?'hermes':/audit|test/i.test(v??'')?'audit':/schedul/i.test(v??'')?'scheduler':v==='api'?'api':'unknown';
const operation=name=>/(?:^|[._-])(read|open|cat|view)(?:$|[._-])/i.test(name)?'read':/(?:write|edit|patch|create|delete|move|rename)/i.test(name)?'write':/(?:search|find|grep|glob|list)/i.test(name)?'search':'other';
export function captureRequestContext(request={}){
  request=request??{};
  const composition=emptyComposition(),names=new Set(),fileActivity={read:0,write:0,search:0,other:0};
  const messages=Array.isArray(request.messages)?request.messages:[];
  for(const message of messages){if(!message||typeof message!=='object')continue;
    const key=message.role==='system'||message.role==='developer'?'system':message.role==='tool'?'toolResults':message.role==='assistant'?'assistant':'user';
    composition[key].chars+=textLength(message.content)+textLength(message.reasoning_content);
    for(const call of Array.isArray(message.tool_calls)?message.tool_calls:[]){const name=safeId(call?.function?.name,80);if(name){names.add(name);fileActivity[operation(name)]++;}composition[key].chars+=textLength(call?.function?.arguments);}
  }
  const tools=Array.isArray(request.tools)?request.tools:[];composition.toolSchemas.chars=textLength(tools.length?tools:null);
  for(const tool of tools){const name=safeId(tool?.function?.name??tool?.name,80);if(name)names.add(name);}
  for(const entry of Object.values(composition))entry.estimatedTokens=Math.ceil(entry.chars/4);
  return {schema:1,composition,messageCount:messages.length,toolNames:[...names].slice(0,100),fileActivity,evidence:'request_metadata_only',estimateMethod:'ceil_chars_div_4',note:'工具及文件活动仅表示请求上下文携带，不证明执行完成'};
}
function cleanContext(raw){if(!raw||raw.schema!==1)return null;const composition=emptyComposition();for(const key of KEYS){composition[key].chars=count(raw.composition?.[key]?.chars);composition[key].estimatedTokens=Math.ceil(composition[key].chars/4);}return {schema:1,composition,messageCount:count(raw.messageCount),toolNames:[...new Set((Array.isArray(raw.toolNames)?raw.toolNames:[]).map(n=>safeId(n,80)).filter(Boolean))].slice(0,100),fileActivity:Object.fromEntries(['read','write','search','other'].map(k=>[k,count(raw.fileActivity?.[k])])),evidence:'request_metadata_only',estimateMethod:'ceil_chars_div_4',note:'上下文携带，不证明工具或文件操作执行完成'};}
const sumComposition=(target,source)=>{for(const key of KEYS){target[key].chars+=count(source?.[key]?.chars);target[key].estimatedTokens+=count(source?.[key]?.estimatedTokens);}};
const estimated=c=>c?Object.values(c.composition).reduce((n,v)=>n+v.estimatedTokens,0):null;
const dateCN=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
function validTime(v){const n=Date.parse(v);return Number.isFinite(n)?n:null;}
export function buildActivityContext(service,{range='24h',limit=100,search='',source='',model='',now=Date.now()}={}){
  if(!['24h','7d','30d','all'].includes(range))throw new AppError('Invalid activity range',400,'invalid_range');
  const nowMs=typeof now==='number'?now:Date.parse(now);if(!Number.isFinite(nowMs))throw new AppError('Invalid activity time',400,'invalid_date');
  const take=Math.min(200,Math.max(1,Math.floor(Number(limit)||100))),end=new Date(nowMs).toISOString();
  // 24h/7d keep a 24h/7d KPI window over a seven-day chart; 30d widens both.
  // 'all' removes the lower bound so the chart can start at the oldest stored call.
  // 'all' has no lower bound for KPI/timeline, but the chart stays 30 daily bars:
  // one bar per day for years of history would be unreadable.
  const windowDays=range==='24h'?1:range==='7d'?7:range==='30d'?30:null,bucketDays=range==='24h'||range==='7d'?7:30;
  const cutoff=windowDays===null?-Infinity:nowMs-windowDays*86400000,scanFrom=windowDays===null?'' : new Date(nowMs-Math.max(windowDays,bucketDays)*86400000).toISOString();
  const needle=String(search).slice(0,200).toLowerCase(),wantedSource=String(source).slice(0,40),wantedModel=String(model).slice(0,160);let cursor=0,truncated=false;const usage=[];
  // 'all' has no lower bound and can be large, so it gets a wider but still bounded scan.
  const scanCap=windowDays===null?60000:10000;
  do{const page=service.ledger.usage({from:scanFrom,to:end,beforeId:cursor,limit:500});usage.push(...(page.records??[]));if(!page.nextBeforeId)break;if(page.nextBeforeId===cursor){truncated=true;break;}cursor=page.nextBeforeId;if(usage.length>=scanCap){truncated=true;break;}}while(true);
  const seen=new Set();const unique=usage.filter(r=>{if(finite(r.id)===null)return true;if(seen.has(r.id))return false;seen.add(r.id);return true;});
  const grouped=new Map();
  for(const row of unique){const time=validTime(row.startedAt);if(time===null||time>nowMs||time<Date.parse(scanFrom||'1970-01-01T00:00:00.000Z'))continue;const id=safeId(row.requestId,100)||'legacy-'+count(row.id);const group=grouped.get(id)??[];group.push(row);grouped.set(id,group);}
  const requests=[];
  for(const [id,rows] of grouped){rows.sort((a,b)=>count(a.attempt)-count(b.attempt)||count(a.id)-count(b.id));const last=rows.at(-1),first=rows[0],contexts=rows.map(r=>cleanContext(r.context));const context=contexts.findLast(c=>c!==null)??null;
    const dispatched=rows.filter(wasDispatched),outcome=last.requestOutcome?.schema===1?last.requestOutcome:null;
    const candidates=rows.filter(r=>r.rowType!=='request_outcome');
    const attempts=candidates.map((r,i)=>({attempt:count(r.attempt)||i+1,time:r.startedAt,platform:safeId(r.platform,50),model:safeId(r.model),status:canonicalStatus(r.status),dispatched:wasDispatched(r),dispatchCount:dispatches(r),durationMs:finite(r.durationMs),knownTokens:finite(r.totalTokens),errorCode:safeCode(r.error?.code),relayReason:safeCode(r.relay?.reasonCode??r.relay?.trigger),fromPlatform:safeId(r.relay?.fromPlatform,50),toPlatform:safeId(r.relay?.toPlatform,50)}));
    const status=last.status==='skipped'?(outcome?.state==='ongoing'?'running':outcome?.state==='cancelled'?'cancelled':'failed'):canonicalStatus(last.status);
    const dispatchedContexts=rows.map((r,i)=>wasDispatched(r)?contexts[i]:null);
    requests.push({id:'request:'+id,kind:'request',time:first.startedAt,finishedAt:validTime(last.finishedAt)!==null?last.finishedAt:null,source:sourceName(first.source),model:safeId(last.model),routeId:safeId(first.routeId),status,candidateCount:candidates.length,skippedCount:rows.filter(r=>r.status==='skipped').length,attemptCount:dispatched.length,dispatchCount:rows.reduce((n,r)=>n+dispatches(r),0),knownTokens:dispatched.some(r=>finite(r.totalTokens)!==null)?dispatched.reduce((n,r)=>n+(finite(r.totalTokens)??0),0):null,unknownTokenAttempts:dispatched.filter(r=>finite(r.totalTokens)===null).length,estimatedInputTokens:contexts.some(Boolean)?dispatchedContexts.reduce((n,c)=>n+(estimated(c)??0),0):null,relays:Math.max(0,dispatched.length-1)+(dispatched[0]?.relay?.fromPlatform&&dispatched[0]?.relay?.toPlatform&&dispatched[0].relay.fromPlatform!==dispatched[0].relay.toPlatform?1:0),context,attempts});
  }
  const matches=item=>(!wantedSource||item.source===wantedSource)&&(!wantedModel||item.model===wantedModel||item.routeId===wantedModel)&&(!needle||[item.model,item.routeId,item.source,item.status,item.platform,item.task,...(item.context?.toolNames??[]),...(item.attempts??[]).map(a=>a.relayReason)].join(' ').toLowerCase().includes(needle));
  const filtered=requests.filter(matches),active=filtered.filter(r=>validTime(r.time)>=cutoff);const composition=emptyComposition();const activeIds=new Set(active.map(r=>r.id));
  // Repeated contexts count actual dispatched input volume, never skipped candidates.
  for(const row of unique){if(!wasDispatched(row)||validTime(row.startedAt)<cutoff||validTime(row.startedAt)>nowMs)continue;const key='request:'+(safeId(row.requestId,100)||'legacy-'+count(row.id));if(!activeIds.has(key))continue;const c=cleanContext(row.context);if(c)sumComposition(composition,c.composition);}
  const kpis={requests:active.length,attempts:active.reduce((n,r)=>n+r.attemptCount,0),dispatches:active.reduce((n,r)=>n+r.dispatchCount,0),skippedCandidates:active.reduce((n,r)=>n+r.skippedCount,0),upstreamFailedAttempts:active.reduce((n,r)=>n+r.attempts.filter(a=>a.dispatched&&a.status==='failed').length,0),success:active.filter(r=>r.status==='success').length,failed:active.filter(r=>r.status==='failed'||r.status==='cancelled').length,relays:active.reduce((n,r)=>n+r.relays,0),knownTokens:active.reduce((n,r)=>n+(r.knownTokens??0),0),estimatedInputTokens:active.reduce((n,r)=>n+(r.estimatedInputTokens??0),0),unknownTokenAttempts:active.reduce((n,r)=>n+r.unknownTokenAttempts,0),contextKnownRequests:active.filter(r=>r.context!==null).length};
  const daily=Array.from({length:bucketDays},(_,i)=>{const date=dateCN(nowMs-(bucketDays-1-i)*86400000),rows=filtered.filter(r=>dateCN(validTime(r.time))===date);return {date,requests:rows.length,success:rows.filter(r=>r.status==='success').length,failed:rows.filter(r=>r.status==='failed'||r.status==='cancelled').length,knownTokens:rows.reduce((n,r)=>n+(r.knownTokens??0),0)}});
  const records=service.ledger.records({limit:1000});const claims=records.filter(r=>validTime(r.time)>=cutoff&&validTime(r.time)<=nowMs).map(r=>{const relay=r.task==='model-relay';const detail=r.result??{};return {id:(relay?'relay:':'claim:')+count(r.id),kind:relay?'relay':'claim',time:r.time,source:relay?'gateway':'scheduler',model:relay?safeId(detail.modelFamily):'',routeId:relay?safeId(detail.routeId):'',status:relay&&r.status==='switched'?'switched':['success','already','observed','failed','error','skipped'].includes(r.status)?r.status:'unknown',platform:safeId(r.platform,50),task:safeId(r.task,80),...(relay?{relayReason:safeCode(detail.reasonCode),fromPlatform:safeId(detail.fromPlatform,50),toPlatform:safeId(detail.toPlatform,50)}:{}),knownTokens:null,estimatedInputTokens:null,relays:relay?1:0,context:null,attempts:[]}}).filter(matches);
  const all=[...active,...claims].sort((a,b)=>validTime(b.time)-validTime(a.time));
  return {schema:1,generatedAt:end,range,bucketDays,timeZone:'Asia/Shanghai',coverage:{truncated,usageRowsScanned:usage.length,claimRowsScanned:records.length,claimsMayBeTruncated:records.length>=1000,matchingItems:all.length,returnedItems:Math.min(take,all.length),note:'仅本网关记录；已返回 Token 与字符/4输入估算分开。接力含同请求后续尝试，工具/文件仅上下文携带，不证明执行；无客户端压缩事件证据。'},kpis,daily,composition,items:all.slice(0,take),sources:[...new Set(requests.map(r=>r.source).concat(claims.map(r=>r.source)))].sort(),models:[...new Set(requests.map(r=>r.model).filter(Boolean))].sort()};
}
