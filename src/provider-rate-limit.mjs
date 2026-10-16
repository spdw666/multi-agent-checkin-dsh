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
function officialBusinessCode(value){
  if(!record(value))return;
  const error=own(value,'error'),data=own(value,'data'),errorData=own(error,'data'),dataError=own(data,'error');
  // The official 429 mapper gives error.data.code precedence over wrappers.
  // Only these documented structural containers are inspected, never text.
  const candidates=[own(errorData,'code'),own(error,'code'),own(value,'code'),own(own(dataError,'data'),'code'),own(dataError,'code'),own(data,'code')];
  for(const candidate of candidates){const code=numericCode(candidate);if(code!==undefined)return knownCodes.has(code)?code:undefined}
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

export async function buddyChatRejection(response,{signal,errorBodyMaxBytes,errorBodyTimeoutMs}={}){
  const now=Date.now();let retryAfterSeconds;
  try{retryAfterSeconds=parseBuddyRetryAfter(response.headers?.get('retry-after'),now)}catch{}
  const data=await boundedErrorJson(response,{signal,maxBytes:boundedOption(errorBodyMaxBytes,MAX_ERROR_BYTES),timeoutMs:boundedOption(errorBodyTimeoutMs,MAX_ERROR_TIME_MS)});
  const upstreamCode=officialBusinessCode(data);
  const rateLimitKind=transientCodes.has(upstreamCode)?'transient':longWindowCodes.has(upstreamCode)?'long_window':usageCodes.has(upstreamCode)?'usage_limit':'unknown';
  const rateLimitRetryable=response.status===429&&rateLimitKind==='transient';
  const labels={transient:'官方短窗口限流',long_window:'官方长窗口限流',usage_limit:'官方用量或订阅条件限制',unknown:'官方请求受限，具体原因待确认'};
  const error=new AppError(`Buddy聊天接口 HTTP ${response.status}${response.status===429?'：'+labels[rateLimitKind]:''}`,response.status,'provider_chat_rejected');
  if(upstreamCode!==undefined)error.upstreamCode=upstreamCode;
  error.rateLimitKind=rateLimitKind;error.rateLimitRetryable=rateLimitRetryable;
  if(retryAfterSeconds!==undefined){error.retryAfterSeconds=retryAfterSeconds;error.retryAfterSource='official_header'}
  return error;
}
