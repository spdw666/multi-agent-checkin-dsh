// Deliberately exclude provider messages, headers, URLs and request identifiers.
// Only these bounded fields may cross the public HTTP or usage-ledger boundary.
const businessCodes=new Set([6000,6001,6002,6003,6004,6005,6006,6007,6008,10105,11115,14001,14002,14003,14012,14013,14014,14015,14016,14017,14018,14019,15001]);
const kinds=new Set(['transient','long_window','usage_limit','unknown']);
const transientCodes=new Set([6001,6002,6005,6006,14003]);
const sources=new Set(['official_header','official_body','local_default']);
export function rateLimitMetadata(error){
  if(!error||typeof error!=='object')return {};
  const result={};
  if(error.gatewayManagedRetry===true)result.gatewayManagedRetry=true;
  if(businessCodes.has(error.upstreamCode))result.upstreamCode=error.upstreamCode;
  if(kinds.has(error.rateLimitKind)){
    result.rateLimitKind=error.rateLimitKind;
    if(typeof error.rateLimitRetryable==='boolean')result.rateLimitRetryable=error.rateLimitKind==='transient'&&transientCodes.has(error.upstreamCode)&&error.rateLimitRetryable;
  }
  if(typeof error.retryAfterSeconds==='number'&&Number.isFinite(error.retryAfterSeconds)&&error.retryAfterSeconds>=0&&error.retryAfterSeconds<=86400){
    result.retryAfterSeconds=error.retryAfterSeconds;
    if(sources.has(error.retryAfterSource))result.retryAfterSource=error.retryAfterSource;
  }
  return result;
}
