// Bounded transport metadata only. Never preserve error prose, addresses,
// request URLs, headers, credentials or sockets in errors/history/diagnostics.
const codes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_SSL_WRONG_VERSION_NUMBER','ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR','ABORT_ERR']);
// Connection-layer resets observed BEFORE the response is handed over are the
// one class this file can call transient. `chatStream` returns status 0 only
// from its own `fetch` catch: once fetch resolves, a broken body throws from the
// caller's `for await`, so it never reaches this view. The client therefore has
// zero bytes of that attempt, which is what makes a resend free of duplicated
// text. Everything ambiguous (missing code, TLS, DNS rejection, timeouts, an
// observed response body) stays non-retryable on purpose.
const retryableTransient=new Set(['ECONNRESET','EPIPE','UND_ERR_SOCKET']);
const phases=new Set(['connect','tls_handshake','response_header','response_body']);
const origins=new Set(['connect_deadline','header_deadline','body_idle','request_deadline']);
const value=(object,key)=>{try{return object?.[key];}catch{return undefined;}};
export function transportFailureMetadata(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
  const phase=value(raw,'networkPhase')??value(raw,'phase'),code=value(raw,'transportCode')??value(raw,'code'),origin=value(raw,'timeoutOrigin');
  const out={phase:phases.has(phase)?phase:null,code:codes.has(code)?code:null,timeoutOrigin:origins.has(origin)?origin:null};
  return Object.values(out).some(x=>x!==null)?out:undefined;
}
export function captureFetchTransportFailure(error,signal){
  if(signal?.aborted)return {phase:null,code:'ABORT_ERR',timeoutOrigin:signal.reason?.name==='TimeoutError'?'request_deadline':null};
  const pending=[error],seen=new Set();let native=null;
  for(let i=0;i<pending.length&&i<16;i++){
    const item=pending[i];if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);
    const code=value(item,'code');if(codes.has(code)){native=code;break;}
    const cause=value(item,'cause');if(cause&&typeof cause==='object')pending.push(cause);
    const aggregate=value(item,'errors');if(Array.isArray(aggregate))pending.push(...aggregate.slice(0,8));
  }
  let phase=null,timeoutOrigin=null;
  if(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(native))phase='connect';
  if(native==='UND_ERR_CONNECT_TIMEOUT')timeoutOrigin='connect_deadline';
  if(native==='UND_ERR_HEADERS_TIMEOUT'){phase='response_header';timeoutOrigin='header_deadline';}
  if(native==='UND_ERR_BODY_TIMEOUT'){phase='response_body';timeoutOrigin='body_idle';}
  if(['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_SSL_WRONG_VERSION_NUMBER','ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'].includes(native))phase='tls_handshake';
  return {phase,code:native,timeoutOrigin};
}
export function fetchTransportErrorView(raw,signal){
  const supplied=transportFailureMetadata(raw);
  const inferred=captureFetchTransportFailure({code:supplied?.code});
  const prior=supplied?{phase:supplied.phase??inferred.phase,code:supplied.code,timeoutOrigin:supplied.timeoutOrigin??inferred.timeoutOrigin}:undefined;
  const meta=signal?.aborted?{...captureFetchTransportFailure(undefined,signal),phase:prior?.phase??null}:(prior??{phase:null,code:null,timeoutOrigin:null});
  const cancelled=signal?.aborted&&signal.reason?.name!=='TimeoutError';
  const requestDeadline=signal?.aborted&&signal.reason?.name==='TimeoutError';
  const timeout=requestDeadline||['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT'].includes(meta.code);
  const code=cancelled?'request_cancelled':requestDeadline?'request_timeout':timeout?'provider_timeout':'provider_network_error';
  const received=meta.phase==='response_body';
  const message=cancelled?'WorkBuddy 请求已取消':requestDeadline?'WorkBuddy 请求总期限已到':received?(timeout?'WorkBuddy 响应流传输超时':'WorkBuddy 响应流传输中断'):timeout?'WorkBuddy 网络传输超时，尚未取得上游 HTTP 响应':'WorkBuddy 网络传输失败，尚未取得上游 HTTP 响应';
  // A connection reset before the response exists is the only case where a
  // resend cannot duplicate text, cannot re-run a tool call and cannot re-bill a
  // generation the client already saw: nothing was ever handed to the caller.
  // Cancellation, the request deadline and any response-stage failure stay
  // explicitly non-retryable, so the 2026-10-28 rule still holds for the cases
  // it was written for.
  const transportRetryable=!cancelled&&!requestDeadline&&!received&&retryableTransient.has(meta.code);
  return {code,status:cancelled?499:timeout?504:503,message,networkPhase:meta.phase,transportCode:meta.code,timeoutOrigin:meta.timeoutOrigin,upstreamResponseReceived:received,transportRetryable};
}
