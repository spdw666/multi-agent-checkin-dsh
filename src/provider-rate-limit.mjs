import {AppError} from './util.mjs';

// Official installed Buddy CLI BusinessErrorCode / transient-rate-limit sets.
// Neither an arbitrary upstream message nor an undocumented policy is trusted.
const transientCodes=new Set([6001,6002,6005,6006,14003]);
const longWindowCodes=new Set([6003,6004,6007,6008]);
const usageCodes=new Set([14001,14012,14013,14014,14015,14016,14017,14018,14019]);
const knownCodes=new Set([6000,...transientCodes,...longWindowCodes,...usageCodes,14002,10105,15001,11115]);
const MAX_ERROR_BYTES=16384,MAX_ERROR_TIME_MS=500,MAX_RETRY_SECONDS=86400;
const stopped=Symbol('bounded-error-read-stopped');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>record(value)&&Object.hasOwn(value,key)?value[key]:undefined;
const boundedOption=(value,limit)=>Number.isSafeInteger(value)&&value>0?Math.min(value,limit):limit;

function numericCode(value){
  const number=typeof value==='number'?value:typeof value==='string'&&/^\d{4,6}$/.test(value)?Number(value):NaN;
  return Number.isSafeInteger(number)&&number>=1000&&number<=999999?number:undefined;
}
function businessDiagnosticCode(value){
  if(!record(value))return;
  const error=own(value,'error'),data=own(value,'data'),errorData=own(error,'data'),dataError=own(data,'error');
  // The official 429 mapper gives error.data.code precedence over wrappers.
  // Only these documented structural containers are inspected, never text.
  const candidates=[own(errorData,'code'),own(error,'code'),own(value,'code'),own(own(dataError,'data'),'code'),own(dataError,'code'),own(data,'code')];
  for(const candidate of candidates){const code=numericCode(candidate);if(code!==undefined)return code}
}
function officialBusinessCode(value){
  const code=businessDiagnosticCode(value);return knownCodes.has(code)?code:undefined;
}

// 业务码 → 限流类别。WorkBuddy 平台原先没有走这套分类：它把 vendor 给的
// kind 字符串（如 "soft_rate"）直接当错误码抛出，于是 6004 明明是长窗口
// 限流，对外却是 rateLimitKind=unknown。这里把分类单独导出，让所有复用同
// 一套官方业务码的适配器都能落在同一张表上。
export function businessRateLimitKind(code){
  if(!Number.isSafeInteger(code))return undefined;
  if(transientCodes.has(code))return 'transient';
  if(longWindowCodes.has(code))return 'long_window';
  if(usageCodes.has(code))return 'usage_limit';
  return knownCodes.has(code)?'unknown':undefined;
}
// 上游把恢复时刻写在自然语言里，例如：
//   您的使用量已超出频率限制，将在 2026-11-18 14:35:43 UTC+8 重置
// 只认「YYYY-MM-DD HH:MM:SS UTC+8」这一种带明确时区的绝对时刻。别的写法
// 一律返回 undefined —— 宁可退化为本地冷却并如实说明，也不从一个不认识的
// 句子里猜一个时刻给调用方。
const RESET_DEADLINE=/[^0-9]([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})\s*UTC\+8/;
export function parseResetDeadline(value,now=Date.now()){
  if(typeof value!=='string'||value.length>512||!Number.isFinite(now))return;
  const match=RESET_DEADLINE.exec(value);
  if(!match)return;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]);
  if(month<1||month>12||day<1||day>31||hour>23||minute>59||second>59)return;
  // UTC+8 是固定偏移，直接换算成 UTC 毫秒，不依赖运行机器的时区设置。
  const at=Date.UTC(year,month-1,day,hour-8,minute,second);
  if(!Number.isFinite(at))return;
  const seconds=Math.ceil((at-now)/1000);
  if(!Number.isSafeInteger(seconds)||seconds<0||seconds>MAX_RETRY_SECONDS)return;
  return {seconds,at};
}
export function parseBuddyRetryAfter(value,now=Date.now()){
  if(typeof value!=='string'||value.length>80||!Number.isFinite(now))return;
  const text=value.trim();let seconds;
  if(/^\d+$/.test(text))seconds=Number(text);
  else if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)){
    const date=Date.parse(text);if(Number.isFinite(date))seconds=Math.max(0,Math.ceil((date-now)/1000));
  }
  if(Number.isSafeInteger(seconds)&&seconds>=0&&seconds<=MAX_RETRY_SECONDS)return seconds;
}

async function boundedErrorJson(response,{signal,maxBytes,timeoutMs}){
  let reader,timer,stop,completed=false,size=0;const chunks=[];
  try{
    reader=response.body?.getReader();if(!reader)return;
    const interruption=new Promise(resolve=>{stop=()=>resolve(stopped)});
    timer=setTimeout(stop,timeoutMs);
    signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)return;
    for(;;){
      const part=await Promise.race([reader.read(),interruption]);
      if(part===stopped||signal?.aborted)return;
      if(part.done){completed=true;break}
      if(!(part.value instanceof Uint8Array)||size+part.value.byteLength>maxBytes)return;
      size+=part.value.byteLength;chunks.push(part.value);
    }
    if(!completed||!size)return;
    return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
  }catch{
    // Body/parser/abort diagnostics can contain credentials; discard entirely.
    return;
  }finally{
    clearTimeout(timer);if(stop)signal?.removeEventListener('abort',stop);
    if(reader){
      // Cancellation itself may never settle. Initiate it but do not allow an
      // untrusted response stream to extend the bounded rejection deadline.
      try{Promise.resolve(reader.cancel()).catch(()=>{})}catch{}
      try{reader.releaseLock()}catch{}
    }
  }
}

// 把「这个 429 是谁限的、属于哪一类、什么时候恢复」一次性贴到错误对象上。
// 官方业务码决定类别；displayMsg 里的绝对时刻决定恢复时间。任何一项解析不出来
// 就不设那一项 —— 上层会退化为本地冷却，并如实标注它不代表官方恢复时间。
export function applyRateLimitEvidence(error,{status,detail,now=Date.now()}={}){
  if(!error||status!==429)return error;
  const code=detail?.upstreamCode,kind=businessRateLimitKind(code);
  if(kind!==undefined){error.upstreamCode=code;error.rateLimitKind=kind;error.rateLimitRetryable=kind==='transient';}
  const reset=parseResetDeadline(detail?.displayMsg,now);
  if(reset){error.retryAfterSeconds=reset.seconds;error.retryAfterSource='official_body';}
  return error;
}
export async function buddyChatRejection(response,{signal,errorBodyMaxBytes,errorBodyTimeoutMs}={}){
  const now=Date.now();let retryAfterSeconds;
  try{retryAfterSeconds=parseBuddyRetryAfter(response.headers?.get('retry-after'),now)}catch{}
  const data=await boundedErrorJson(response,{signal,maxBytes:boundedOption(errorBodyMaxBytes,MAX_ERROR_BYTES),timeoutMs:boundedOption(errorBodyTimeoutMs,MAX_ERROR_TIME_MS)});
  const upstreamCode=officialBusinessCode(data),diagnosticCode=businessDiagnosticCode(data);
  const rateLimitKind=transientCodes.has(upstreamCode)?'transient':longWindowCodes.has(upstreamCode)?'long_window':usageCodes.has(upstreamCode)?'usage_limit':'unknown';
  const rateLimitRetryable=response.status===429&&rateLimitKind==='transient';
  const labels={transient:'官方短窗口限流',long_window:'官方长窗口限流',usage_limit:'官方用量或订阅条件限制',unknown:'官方请求受限，具体原因待确认'};
  // The finite numeric diagnostic survives errorView without retaining raw
  // messages. It is NOT an allowlist/policy decision; unknown codes stay unknown.
  const error=new AppError(`Buddy聊天接口 HTTP ${response.status}${response.status===429?'：'+labels[rateLimitKind]:''}${diagnosticCode!==undefined?` [businessCode=${diagnosticCode}]`:''}`,response.status,'provider_chat_rejected');
  if(upstreamCode!==undefined)error.upstreamCode=upstreamCode;
  error.rateLimitKind=rateLimitKind;error.rateLimitRetryable=rateLimitRetryable;
  if(retryAfterSeconds!==undefined){error.retryAfterSeconds=retryAfterSeconds;error.retryAfterSource='official_header'}
  return error;
}
