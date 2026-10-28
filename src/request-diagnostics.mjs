// Read-only, metadata-only request diagnostics. The ledger is evidence, not an
// instruction source. Explicit projections prevent old/raw detail fields from
// turning into an accidental prompt, credential, account or filesystem export.
import {createHash} from 'node:crypto';
import {AppError} from './util.mjs';
import {rateLimitMetadata} from './rate-limit-metadata.mjs';
import {workBuddyChannelMetadata} from './client-contract.mjs';

const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const count=v=>Math.floor(number(v)??0);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const code=v=>typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(v)&&!/(?:bearer|secret|token|sk-)/i.test(v)?v:null;
const http=v=>Number.isInteger(v)&&v>=100&&v<=599?v:null;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const state=v=>v==='completed'?'success':['success','failed','running','cancelled','skipped'].includes(v)?v:'unknown';
const source=v=>/dsh/i.test(v??'')?'dsh':/hermes/i.test(v??'')?'hermes':/audit|test/i.test(v??'')?'audit':/schedul/i.test(v??'')?'scheduler':v==='api'?'api':'unknown';
const dispatched=row=>row.rowType!=='request_outcome'&&row.status!=='skipped'&&row.dispatched!==false;
const dispatchCount=row=>dispatched(row)?Math.max(1,count(row.dispatchCount)||count(row.transportAttempts)):0;
const identity=v=>typeof v==='string'&&v?createHash('sha256').update(v).digest('hex').slice(0,10):null;
export const diagnosticAccountRef=v=>{const id=identity(v);return id?'account-'+id:null;};

function sensitiveValues(config={}){
  const values=new Set(),seen=new Set();
  const visit=(value,secret=false)=>{
    if(typeof value==='string'){if(secret&&value)values.add(value);return;}
    if(typeof value==='number'){if(secret&&Number.isFinite(value))values.add(String(value));return;}
    if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
    for(const [key,item]of Object.entries(value))visit(item,secret||key==='credentials'||/^(?:id|uid|user_?id|account_?id|principal|email|username|device_?id|access_?token|refresh_?token|api_?key|token|secret|password|cookie|authorization)$/i.test(key));
  };
  visit(Array.isArray(config.accounts)?config.accounts:[]);
  for(const u of config.upstreams??[])if(typeof u.accountId==='string'&&u.accountId)values.add(u.accountId);
  visit(config.__diagnosticSecrets,true);
  return [...values].sort((a,b)=>b.length-a.length);
}
const textAllowed=value=>typeof value==='string'&&value.length<=200&&!!value&&/^[-\p{L}\p{N}_.:/@+ ]+$/u.test(value)
  &&!/(?:[A-Za-z]:[\\/]|https?:|bearer|sk-[a-z0-9]{8}|api[_-]?key|token=|\/(?:users|home)\/)/i.test(value);
// Prepared only for this synchronous projection. No cross-call cache: a later
// call must see additions, removals and in-place edits to mutable configuration.
function prepareDiagnosticContext(config){
  const accounts=Array.isArray(config.accounts)?config.accounts:[],ids=[...new Set(accounts.map(a=>a?.id).filter(v=>typeof v==='string'&&v))];
  // Codes are rejected rather than masked; public route/model identifiers may
  // retain a pseudonymous account component. Other credential/UID content is
  // rejected even when it happens to look like an innocent machine code.
  const values=sensitiveValues(config),idSet=new Set(ids),codeSecrets=values.map(s=>s.toLowerCase()),textSecrets=values.filter(s=>!idSet.has(s)).map(s=>s.toLowerCase()),refs=new Map();
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=ids.length?new RegExp(ids.sort((a,b)=>b.length-a.length).map(escape).join('|'),'g'):null;
  const accountRef=id=>{if(!refs.has(id))refs.set(id,diagnosticAccountRef(id));return refs.get(id);};
  const safeCode=value=>{const safe=code(value);if(!safe)return null;const lower=safe.toLowerCase();return codeSecrets.some(s=>lower.includes(s))?null:safe;};
  const safeText=value=>{if(!textAllowed(value))return null;const lower=value.toLowerCase();if(textSecrets.some(s=>lower.includes(s)))return null;return pattern?value.replace(pattern,accountRef):value;};
  return {safeCode,safeText,accountRef};
}
export function diagnosticCode(value,config={}){
  return code(value)?prepareDiagnosticContext(config).safeCode(value):null;
}
export function diagnosticText(value,config={}){
  return textAllowed(value)?prepareDiagnosticContext(config).safeText(value):null;
}
const capabilities=raw=>({tools:typeof raw?.tools==='boolean'?raw.tools:null,multimodal:typeof raw?.multimodal==='boolean'?raw.multimodal:null,contextWindow:Number.isSafeInteger(raw?.contextWindow)&&raw.contextWindow>0?raw.contextWindow:null,outputCapacity:Number.isSafeInteger(raw?.outputCapacity)&&raw.outputCapacity>0?raw.outputCapacity:null});
const reason=(raw,platform,rate,safeCode=code)=>{const value=record(raw)?safeCode(raw.code??raw.reasonCode):null;return value?{code:value,status:http(raw.status),platform:safeCode(platform??raw.platform)??'unknown',...rateLimitMetadata(rate??raw),...workBuddyChannelMetadata({code:value})}:null;};
const transport=raw=>({phase:['connect','tls_handshake','response_header','response_body'].includes(raw?.phase)?raw.phase:null,code:['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ABORT_ERR'].includes(raw?.code)?raw.code:null,timeoutOrigin:['connect_deadline','header_deadline','body_idle','request_deadline'].includes(raw?.timeoutOrigin)?raw.timeoutOrigin:null});
// Both counters come from the same UsageAttempt performance clock. This split
// is a gateway observation, not provider generation or client delivery timing.
function observedOutputTiming(row){
  const duration=number(row?.durationMs),first=number(row?.firstTokenMs);
  return duration!==null&&first!==null&&first<=duration?{preFirstOutputMs:first,postFirstOutputMs:duration-first}:{preFirstOutputMs:null,postFirstOutputMs:null};
}

export function diagnoseRequestRows(rows,config={}){
  if(!Array.isArray(rows)||!rows.length)return null;
  rows=[...rows].sort((a,b)=>count(a.attempt)-count(b.attempt)||count(a.id)-count(b.id));
  config={...config,accounts:[...(Array.isArray(config.accounts)?config.accounts:[]),...rows.filter(r=>typeof r.accountId==='string'&&r.accountId).map(r=>({id:r.accountId}))]};
  const {safeCode,safeText,accountRef}=prepareDiagnosticContext(config);
  const first=rows[0],last=rows.at(-1),suppliers=rows.filter(r=>r.rowType!=='request_outcome'),sent=suppliers.filter(dispatched);
  const requestId=safeText(first.requestId)??'legacy-'+count(first.id);
  const terminal=rows.findLast(r=>r.requestOutcome?.schema===1)?.requestOutcome;
  const relayFailure=rows.findLast(r=>record(r.relayFailure))?.relayFailure;
  const firstFailure=sent.find(r=>reason(r.error))??rows.find(r=>reason(r.error));
  const lastFailure=rows.findLast(r=>reason(r.error));
  const start=time(first.startedAt),finished=time(last.finishedAt);
  const totalMs=start&&finished?Math.max(0,Date.parse(finished)-Date.parse(start)):null;
  const requestStatus=terminal?.state==='completed'?'success':terminal?.state==='ongoing'?'running':terminal?.state==='cancelled'?'cancelled':terminal?.state==='failed'?'failed':last.status==='skipped'?'failed':state(last.status);
  const candidates=suppliers.map((row,index)=>({position:index+1,attempt:count(row.attempt)||index+1,platform:safeCode(row.platform)??'unknown',model:safeText(row.model),accountRef:accountRef(row.accountId),status:state(row.status),dispatched:dispatched(row),dispatchCount:dispatchCount(row),startedAt:time(row.startedAt),finishedAt:time(row.finishedAt),durationMs:number(row.durationMs),firstTokenMs:number(row.firstTokenMs),...observedOutputTiming(row),reasonCode:safeCode(row.candidatePlan?.reasonCode??row.error?.code??row.relay?.reasonCode??row.relay?.trigger),plan:record(row.candidatePlan)?{state:['eligible','unknown','skipped'].includes(row.candidatePlan.state)?row.candidatePlan.state:'unknown',reasonCode:safeCode(row.candidatePlan.reasonCode),capabilities:capabilities(row.candidatePlan.capabilities)}:null,transportFailure:record(row.transportFailure)?transport(row.transportFailure):null,rateLimit:record(row.rateLimit)?rateLimitMetadata(row.rateLimit):null,knownTokens:number(row.totalTokens)}));
  const supplies=new Map();
  for(const row of sent){const item={platform:safeCode(row.platform)??'unknown',model:safeText(row.model),accountRef:accountRef(row.accountId)};supplies.set(JSON.stringify(item),item);}
  const knownContract=rows.findLast(r=>r.requestContract?.schema===1)?.requestContract;
  const contract=knownContract?{messageCount:count(knownContract.messageCount),toolCount:count(knownContract.toolCount),requiresTools:knownContract.requiresTools===true,hasImages:knownContract.hasImages===true,hasToolHistory:knownContract.hasToolHistory===true,serializedBytes:number(knownContract.serializedBytes),outputBudget:number(knownContract.outputBudget),contextEstimate:{method:knownContract.contextEstimate?.method==='utf8_bytes_plus_overhead'?'utf8_bytes_plus_overhead':'unknown',tokenCount:null,upperBound:number(knownContract.contextEstimate?.upperBound)},evidence:'request_metadata_only'}:null;
  const split=sent.length===1?observedOutputTiming(sent[0]):observedOutputTiming(null);
  return {requestId,id:requestId,source:source(first.source),requestedRoute:safeText(first.routeId),model:safeText(sent.at(-1)?.model??last.model),status:requestStatus,startedAt:start,finishedAt:finished,candidateCount:suppliers.length,skippedCount:suppliers.filter(r=>r.status==='skipped').length,attemptCount:sent.length,dispatchCount:sent.reduce((n,r)=>n+dispatchCount(r),0),firstReason:reason(relayFailure?.root,undefined,firstFailure?.rateLimit,safeCode)??reason(firstFailure?.error,safeCode(firstFailure?.platform),firstFailure?.rateLimit,safeCode),lastReason:reason(relayFailure?.last,safeCode(lastFailure?.platform),lastFailure?.rateLimit,safeCode)??reason(lastFailure?.error,safeCode(lastFailure?.platform),lastFailure?.rateLimit,safeCode),actualSupplies:[...supplies.values()],completion:{gatewayRequest:requestStatus,toolExecution:'unknown',clientTurn:'unknown',evidence:'gateway_ledger_only'},timing:{totalMs,firstTokenMs:sent.length===1?number(sent[0].firstTokenMs):null,...split,outputTimingScope:sent.length===1?'single_dispatched_attempt':'per_candidate_only',connectMs:null,tlsMs:null,responseHeaderMs:null,generationMs:null,evidence:'gateway_attempt_observation_not_provider_generation_or_client_delivery'},contract,candidates};
}

export function buildRequestDiagnostics(service,{requestId='',range='24h',source:wantedSource='',model='',search='',limit=100,now=Date.now()}={}){
  if(!['24h','7d','30d','all'].includes(range))throw new AppError('Invalid diagnostics range',400,'invalid_range');
  if(typeof requestId!=='string'||requestId.length>100||requestId&&!/^[a-zA-Z0-9_.:-]+$/.test(requestId))throw new AppError('Invalid request ID',400,'invalid_request_id');
  for(const value of [wantedSource,model,search])if(typeof value!=='string'||value.length>200)throw new AppError('Invalid diagnostics filter',400,'invalid_diagnostics_filter');
  if(!['','api','dsh','hermes','audit','scheduler','unknown'].includes(wantedSource))throw new AppError('Invalid source',400,'invalid_diagnostics_source');
  const limitValue=typeof limit==='string'&&/^\d+$/.test(limit)?Number(limit):limit;
  if(!Number.isInteger(limitValue)||limitValue<1||limitValue>200)throw new AppError('Diagnostics limit must be 1–200',400,'invalid_diagnostics_limit');
  const nowMs=typeof now==='number'?now:Date.parse(now);
  if(!Number.isFinite(nowMs)||!Number.isFinite(new Date(nowMs).getTime()))throw new AppError('Invalid diagnostics time',400,'invalid_date');
  const from=requestId||range==='all'?'':new Date(nowMs-({ '24h':1,'7d':7,'30d':30 }[range])*86400000).toISOString(),to=new Date(nowMs).toISOString(),cap=requestId||range==='all'?60000:10000;
  const all=[],seen=new Set(),cursors=new Set([0]);let cursor=0,truncated=false;
  do{
    const page=service.ledger.usage({from,to,beforeId:cursor,limit:500,includeTotal:false}),records=Array.isArray(page.records)?page.records:[];
    for(const row of records){if(!record(row)||number(row.id)!==null&&seen.has(row.id))continue;if(number(row.id)!==null)seen.add(row.id);all.push(row);}
    if(!page.nextBeforeId)break;
    if(!Number.isSafeInteger(page.nextBeforeId)||page.nextBeforeId<1||cursors.has(page.nextBeforeId)||all.length>=cap){truncated=true;break;}
    cursors.add(page.nextBeforeId);
    cursor=page.nextBeforeId;
  }while(true);
  const groups=new Map(),config={...(service.config?.value??{}),__diagnosticSecrets:service.keys};
  for(const row of all){const at=time(row.startedAt);if(!at||Date.parse(at)>nowMs||from&&at<from)continue;const raw=typeof row.requestId==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(row.requestId)?row.requestId:'legacy-'+count(row.id);if(requestId&&raw!==requestId)continue;const group=groups.get(raw)??[];group.push(row);groups.set(raw,group);}
  const needle=search.toLowerCase(),wantedModel=diagnosticText(model,config)??model;
  const matches=r=>(!wantedSource||r.source===wantedSource)&&(!wantedModel||r.model===wantedModel||r.requestedRoute===wantedModel)&&(!needle||[r.requestId,r.requestedRoute,r.model,r.source,r.status,r.firstReason?.code,r.lastReason?.code,...r.candidates.flatMap(c=>[c.platform,c.model,c.reasonCode])].join(' ').toLowerCase().includes(needle));
  const filtered=[...groups.values()].map(rows=>diagnoseRequestRows(rows,config)).filter(matches).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt));
  const items=filtered.slice(0,limitValue);
  return {schema:1,generatedAt:to,range,coverage:{truncated,usageRowsScanned:all.length,matchingItems:filtered.length,returnedItems:items.length,note:'仅本网关已保存的元数据；工具执行和客户端整轮完成尚无客户端回执证据；未知阶段耗时保留为空。'},items,...(requestId?{request:items[0]??null}:{})};
}
