// A source label is observability, never authority. Authentication and admin
// mounting remain exclusively in server.mjs; caller IDs never become our IDs.
import {randomUUID} from 'node:crypto';
const sources=new Set(['dsh','hermes']);
const platforms=new Set(['workbuddy','workbuddyai','trae','trae-cn','qoder','qoder-cn','loomy','codebuddy','codebuddy-cn','codearts','lobster','nvidia','bigmodel','freeapi','opencode','openai']);
const codes=new Set(['provider_auth_rejected','provider_http_error','provider_network_error','relay_target_timeout','opencode_unauthorized','upstream_error','upstream_http_error','invalid_upstream_response','provider_chat_rejected','provider_rate_limited','upstream_rate_limited','same_model_rate_limited','same_model_timeout','same_model_cooldown','same_model_unavailable','same_model_credits_exhausted','relay_context_incompatible','relay_capacity_incompatible','relay_attempt_timeout','relay_candidate_incompatible','request_timeout','request_deadline_exceeded','request_cancelled','account_pool_unavailable','reasoning_only_response','reasoning_budget_exhausted','empty_response','empty_chat_response','provider_empty_response','tools_not_supported','images_not_supported','reasoning_effort_not_supported','reasoning_parameter_not_supported','opencode_bridge_unreachable','opencode_request_incompatible','model_not_found','loomy_session_expired','authentication_error','provider_timeout','codearts_chat_transient','model_chat_unavailable']);
const validStatus=n=>Number.isInteger(n)&&n>=400&&n<=599;
const validCount=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000;
export const validGatewayRequestId=id=>typeof id==='string'&&/^aigw-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export function gatewayRequestContext(headers={},admin=true){return {requestId:'aigw-'+randomUUID(),source:!admin?'dsh':sources.has(headers['x-ai-credit-source'])?headers['x-ai-credit-source']:'api'};}
export function relayFailureMetadata(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const point=(v,withPlatform)=>{if(!v||typeof v!=='object'||Array.isArray(v))return;return {...(codes.has(v.code)?{code:v.code}:{}),...(validStatus(v.status)?{status:v.status}:{}),...(withPlatform&&platforms.has(v.platform)?{platform:v.platform}:{})};};
  const root=point(value.root,true),last=point(value.last,false),result={...(root&&Object.keys(root).length?{root}:{}),...(last&&Object.keys(last).length?{last}:{}),...(validCount(value.skippedCount)?{skippedCount:value.skippedCount}:{}),...(validCount(value.attemptCount)?{attemptCount:value.attemptCount}:{})};
  return Object.keys(result).length?result:undefined;
}
export function gatewayFailureContract(error,context){
  if(!context)return {};
  const relayFailure=relayFailureMetadata(error?.relayFailure);
  return {gatewayManagedRetry:true,gatewayRetryOwner:'gateway',retryable:false,gatewayRequestId:context.requestId,...(relayFailure?{relayFailure}:{})};
}
