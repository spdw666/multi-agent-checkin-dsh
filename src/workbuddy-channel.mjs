// Only a structured WorkBuddy business error is a channel diagnosis. Request
// text, message substrings and another provider's identical number are not.
import {AppError} from './util.mjs';
import {regionOf,globalBase} from '../vendor/workbuddy-core.mjs';
export const isWorkBuddyChannel=value=>value==='ai'||value==='codebuddy-ai'||value==='cn';
export function workBuddyTransportChannel(credential={}){
  // The transport routes by domain, not by account/credential edition labels.
  // Reuse its own routing functions and keep the two global brands independent.
  if(typeof credential.domain!=='string')return;
  if(regionOf(credential.domain)!=='global')return 'cn';
  return globalBase(credential.domain)==='https://www.codebuddy.ai'?'codebuddy-ai':'ai';
}
export function workBuddyChannelError(body,{status=400,upstreamStatus=status,channel}={}) {
  if(status!==400)return;
  let value=body;
  if(typeof value==='string'){
    if(value.length>32768)return;
    try{value=JSON.parse(value);}catch{return;}
  }
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const detail=value.error&&typeof value.error==='object'&&!Array.isArray(value.error)?value.error:value;
  if(detail.code!==11128&&detail.code!=='11128')return;
  for(const row of [value,detail])if(row.status!==undefined&&row.status!==400&&row.status!=='400')return;
  const error=new AppError('WorkBuddy 渠道校验失败（11128）；本次请求被上游渠道校验拒绝，未判定为账号封禁或额度耗尽；网关仅按已启用的同型号策略选择其他渠道',400,'workbuddy_channel_rejected');
  // The public normalized error is400, but SSE/business errors can arrive over
  // a successful HTTP200 transport. Retain that observed wire status separately.
  Object.assign(error,{upstreamCode:11128,...(Number.isInteger(upstreamStatus)&&upstreamStatus>=100&&upstreamStatus<=599?{upstreamStatus}:{}),...(isWorkBuddyChannel(channel)?{workBuddyChannel:channel}:{})});
  return error;
}
export function workBuddyChannelSkipped(channel){
  return Object.assign(new AppError('本次请求已确认该 WorkBuddy 渠道校验拒绝；同渠道候选已跳过，本次未发送上游',400,'workbuddy_channel_skipped'),{upstreamRequestSent:false,...(isWorkBuddyChannel(channel)?{workBuddyChannel:channel}:{})});
}
