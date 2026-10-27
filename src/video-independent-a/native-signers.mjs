import { Worker } from 'node:worker_threads';
// One stable application UA, not an imported browser fingerprint. The exact
// same value is used by host HTTP requests and each offline signing worker.
export const NATIVE_USER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36';
const error=code=>Object.assign(new Error(code),{code,beforeSubmission:true});
export function signNativeRequest(kind,input){
 if(!['jimeng','kling'].includes(kind))throw error('native_signer_kind_invalid');
 if(kind==='jimeng'&&(!input?.securityState?.xmst||typeof input.securityState.xmst!=='string'))throw error('native_signer_state_required');
 return new Promise((resolve,reject)=>{
  const w=new Worker(new URL(kind+'-official-offline-probe.mjs',import.meta.url),{workerData:{...input,userAgent:NATIVE_USER_AGENT},execArgv:[],stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:128}});
  const done=(e,value)=>{clearTimeout(timer);void w.terminate();e?reject(error(e)):resolve(value);};
  const timer=setTimeout(()=>done('native_signer_timeout'),10000);timer.unref?.();
  w.once('message',v=>v?.ok===true&&typeof v.url==='string'&&v.userAgent===NATIVE_USER_AGENT?done(null,v):done('native_signer_failed'));
  w.once('error',()=>done('native_signer_failed'));w.once('exit',code=>{if(code!==0)done('native_signer_failed');});
  // Never forward SDK diagnostics or request state to gateway logs.
  w.stdout.resume();w.stderr.resume();
 });
}
