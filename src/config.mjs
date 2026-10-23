import {desktopProviderKinds} from './provider-registry.mjs';
import {relayDefaults,validateRelay} from './model-relay.mjs';
import {validateWorkBuddyRotation} from './workbuddy-rotation-policy.mjs';
import {getFreeProvider} from './free-providers.mjs';
import {dirname, join} from 'node:path';
import {readFile, copyFile, mkdir, open, unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {AppError, atomicJson, localPath} from './util.mjs';
import {antigravityBase} from './antigravity.mjs';
export const projectRoot = fileURLToPath(new URL('../',import.meta.url));
const allowedPlatforms=['workbuddy','trae','qwenwork','zcode','minimax','bigmodel','antigravity','nvidia','freeapi',...desktopProviderKinds];
// One malformed account used to fail the whole file, and every chat request re-reads
// the file: a single unknown platform turned the entire gateway into 400s until a
// restart. Loading now degrades per object (the bad one is dropped and reported);
// saving stays strict so a broken edit can never be written back.
function accountProblem(a){
  if(!allowedPlatforms.includes(a.platform)||!a.credentials)return new AppError(`Account ${a.id}: invalid platform/credentials`,400,'invalid_config');
  if(a.platform==='workbuddy'&&a.inferenceEnabled!==undefined&&typeof a.inferenceEnabled!=='boolean')return new AppError(`Account ${a.id}: inferenceEnabled must be boolean`,400,'invalid_config');
  if(a.platform==='freeapi'){try{getFreeProvider(a.freeProviderId)}catch(e){return e instanceof AppError?e:new AppError(`Account ${a.id}: unknown free provider`,400,'invalid_config')}}
  return null;
}
export function validateConfig(c,{lenient=false}={}) {
  const skipped=[];
  const drop=(kind,id,problem)=>{if(!lenient)throw problem;skipped.push({kind,id,reason:problem.message});};
  const rejectInlineSecrets=(node)=>{if(!node||typeof node!=='object')return;for(const [k,v]of Object.entries(node)){if(/^(accessToken|refreshToken|apiKey|adminKey|accessKey|secretKey|securityToken|machineToken|clientSecret|privateKey|secretAccessKey|sessionToken|bearerToken|idToken|token|secret|password|cookie|authorization)$/i.test(k))throw new AppError('Store credentials in an account-specific local file, not the management config',400,'inline_credentials');rejectInlineSecrets(v);}};rejectInlineSecrets(c);
  if(c.schemaVersion!==1)throw new AppError('schemaVersion must be 1',400,'invalid_config');
  for(const field of ['accounts','upstreams','routes']){
    if(!Array.isArray(c[field]))throw new AppError(`${field} must be an array`,400,'invalid_config');
    const ids=new Set();for(const item of c[field]){
      if(!/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/.test(item.id??'')||item.id.includes('..')||ids.has(item.id))throw new AppError(`${field}: invalid/duplicate id`,400,'invalid_config');
      ids.add(item.id);
    }
  }
  const droppedAccounts=new Set();
  for(const a of c.accounts){const problem=accountProblem(a);if(!problem)continue;drop('account',a.id,problem);droppedAccounts.add(a.id);}
  if(droppedAccounts.size)c.accounts=c.accounts.filter(a=>!droppedAccounts.has(a.id));
  const accountById=new Map(c.accounts.map(a=>[a.id,a]));
  const droppedUpstreams=new Set();
  for(const u of c.upstreams){
    const problem=(()=>{
      if(!allowedPlatforms.includes(u.kind))return new AppError(`Unknown upstream kind: ${u.kind}`,400,'invalid_config');
      if(u.kind==='freeapi'&&['baseUrl','url','endpoint','proxyUrl'].some(k=>u[k]!==undefined))return new AppError('Free providers use registered fixed endpoints',400,'invalid_free_provider_endpoint');
      if(u.kind==='antigravity'){try{antigravityBase(u)}catch(e){return e instanceof AppError?e:new AppError(`Upstream ${u.id}: invalid bridge URL`,400,'invalid_antigravity_bridge')}}
      if(u.kind==='nvidia'&&['baseUrl','sidecarBaseUrl','url','endpoint','proxyUrl'].some(k=>u[k]!==undefined))return new AppError('NVIDIA uses its dedicated official endpoint; keep local proxy settings in its credential file',400,'invalid_nvidia_endpoint');
      if(u.kind==='nvidia'&&u.localLimits!==undefined){const l=u.localLimits;if(!l||!Number.isInteger(l.maxConcurrent)||l.maxConcurrent<1||l.maxConcurrent>8||!Number.isInteger(l.minIntervalMs)||l.minIntervalMs<0||l.minIntervalMs>60000)return new AppError('NVIDIA localLimits needs maxConcurrent 1-8 and minIntervalMs 0-60000',400,'invalid_nvidia_local_limits');}
      if(u.relayStandby!==undefined&&typeof u.relayStandby!=='boolean')return new AppError(`Upstream ${u.id}: relayStandby must be boolean`,400,'invalid_config');
      if(accountById.get(u.accountId)?.platform!==u.kind)return new AppError(`Upstream ${u.id}: account/platform mismatch`,400,'invalid_config');
      return null;
    })();
    if(!problem)continue;drop('upstream',u.id,problem);droppedUpstreams.add(u.id);
  }
  if(droppedUpstreams.size)c.upstreams=c.upstreams.filter(u=>!droppedUpstreams.has(u.id));
  const upstreamById=new Map(c.upstreams.map(u=>[u.id,u]));
  const droppedRoutes=new Set();
  for(const r of c.routes){
    const problem=(()=>{
      if(r.relay!==undefined&&typeof r.relay!=='boolean')return new AppError('Route relay must be boolean',400,'invalid_config');
      if(!Array.isArray(r.targets)||!r.targets.length||r.targets.some(t=>typeof t.model!=='string'||!t.model||!upstreamById.has(t.upstreamId)))return new AppError(`Route ${r.id}: invalid targets`,400,'invalid_config');
      const pool=r.accountPool;
      if(pool&&(!Array.isArray(pool.accountIds)||!pool.accountIds.length||new Set(pool.accountIds).size!==pool.accountIds.length||pool.accountIds.some(id=>accountById.get(id)?.platform!=='workbuddy')||upstreamById.get(r.targets[0].upstreamId)?.kind!=='workbuddy'||pool.cooldownSeconds!==undefined&&(!Number.isInteger(pool.cooldownSeconds)||pool.cooldownSeconds<60||pool.cooldownSeconds>86400)))return new AppError(`Route ${r.id}: invalid WorkBuddy account pool`,400,'invalid_config');
      return null;
    })();
    if(!problem)continue;drop('route',r.id,problem);droppedRoutes.add(r.id);
  }
  if(droppedRoutes.size)c.routes=c.routes.filter(r=>!droppedRoutes.has(r.id));
  if(c.modelRelay!==undefined)validateRelay({...relayDefaults,...c.modelRelay});
  if(c.workbuddy!==undefined){if(!c.workbuddy||typeof c.workbuddy!=='object'||Array.isArray(c.workbuddy)||Object.entries(c.workbuddy).some(([k,v])=>!['autoMigrateSessions','autoTasks','rotation'].includes(k)||k!=='rotation'&&typeof v!=='boolean'))throw new AppError('Invalid WorkBuddy settings',400,'invalid_config');if(c.workbuddy.rotation!==undefined)validateWorkBuddyRotation(c.workbuddy.rotation);}
  if(!c.server||!Number.isInteger(c.server.port)||c.server.port<0||c.server.port>65535)throw new AppError('Invalid server port',400,'invalid_config');
  if(c.server.requestTimeoutMs!==undefined&&(!Number.isInteger(c.server.requestTimeoutMs)||c.server.requestTimeoutMs<1000||c.server.requestTimeoutMs>1200000))throw new AppError('server.requestTimeoutMs must be integer milliseconds 1000..1200000',400,'invalid_config');
  if(c.server.modelRequestTimeouts!==undefined){const map=c.server.modelRequestTimeouts;if(!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).length>500||Object.entries(map).some(([id,v])=>!id||id.length>512||!Number.isInteger(v)||v<1000||v>1200000))throw new AppError('server.modelRequestTimeouts must map route IDs to integer milliseconds 1000..1200000',400,'invalid_config');}
  if(c.server.bodyLimitBytes!==undefined&&(!Number.isInteger(c.server.bodyLimitBytes)||c.server.bodyLimitBytes<1024||c.server.bodyLimitBytes>67108864))throw new AppError('server.bodyLimitBytes must be an integer from 1024 to 67108864 (64 MiB)',400,'invalid_config');
  if(!['127.0.0.1','::1','localhost'].includes(c.server.host)&&!c.server.allowRemote)throw new AppError('Non-loopback listening needs server.allowRemote=true',400,'invalid_config');
  const s=c.scheduler;
  if(!s||!Number.isInteger(s.hour)||s.hour<0||s.hour>23||!Number.isInteger(s.minute)||s.minute<0||s.minute>59||!Number.isInteger(s.jitterSeconds)||s.jitterSeconds<0||s.jitterSeconds>86400)throw new AppError('Invalid scheduler settings',400,'invalid_config');
  if(s.retryMinutes!==undefined&&(!Number.isFinite(s.retryMinutes)||s.retryMinutes<1))throw new AppError('retryMinutes must be at least 1',400,'invalid_config');
  const cu=c.clientUpdates;
  if(cu!==undefined){
    if(!cu||typeof cu!=='object'||Array.isArray(cu))throw new AppError('clientUpdates must be an object',400,'invalid_config');
    if(cu.enabled!==undefined&&typeof cu.enabled!=='boolean')throw new AppError('clientUpdates.enabled must be boolean',400,'invalid_config');
    if(cu.intervalHours!==undefined&&(!Number.isFinite(cu.intervalHours)||cu.intervalHours<1||cu.intervalHours>720))throw new AppError('clientUpdates.intervalHours must be 1-720',400,'invalid_config');
    if(cu.timeoutMs!==undefined&&(!Number.isInteger(cu.timeoutMs)||cu.timeoutMs<1000||cu.timeoutMs>120000))throw new AppError('clientUpdates.timeoutMs must be 1000-120000',400,'invalid_config');
    if(cu.targets!==undefined){
      if(!cu.targets||typeof cu.targets!=='object'||Array.isArray(cu.targets))throw new AppError('clientUpdates.targets must be an object',400,'invalid_config');
      for(const [id,override]of Object.entries(cu.targets)){
        if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)||!override||typeof override!=='object'||Array.isArray(override))throw new AppError(`clientUpdates.targets.${id} is invalid`,400,'invalid_config');
        if(override.enabled!==undefined&&typeof override.enabled!=='boolean')throw new AppError(`clientUpdates.targets.${id}.enabled must be boolean`,400,'invalid_config');
        if(override.latestUrl!==undefined&&(typeof override.latestUrl!=='string'||!/^https?:\/\//.test(override.latestUrl)))throw new AppError(`clientUpdates.targets.${id}.latestUrl must be http(s)`,400,'invalid_config');
        if(override.latestType!==undefined&&!['feed','json','github','genie'].includes(override.latestType))throw new AppError(`clientUpdates.targets.${id}.latestType is unsupported`,400,'invalid_config');
      }
    }
  }
  try{new Intl.DateTimeFormat('en',{timeZone:s.timezone}).format(new Date())}catch{throw new AppError('Invalid scheduler timezone',400,'invalid_config')}
  if(lenient&&skipped.length)Object.defineProperty(c,'skipped',{value:skipped,enumerable:false});
  return c;
}
export async function initConfig(file) {
  await mkdir(dirname(file),{recursive:true});
  await copyFile(join(projectRoot,'config.example.json'),file,1).catch(e=>{if(e.code!=='EEXIST')throw e});
  return file;
}
// Content-addressed validation reuse, not a file-stat/TTL or mutable result
// cache. Each gate still reads the file. Cache only one successfully validated
// text per store, then parse a fresh object and replay its lenient omissions.
// Parsing the original text also preserves JSON -0 and ordinary property order.
const validatedReads=new WeakMap();
async function readValidatedConfig(store){
 const text=await readFile(store.file,'utf8'),cached=validatedReads.get(store);
 if(cached?.text===text){
   const value=JSON.parse(text.replace(/^\uFEFF/,''));
   for(const [field,ids]of cached.dropped)if(ids.size)value[field]=value[field].filter(item=>!ids.has(item.id));
   if(cached.skippedText)Object.defineProperty(value,'skipped',{value:JSON.parse(cached.skippedText),enumerable:false});
   return value;
 }
 const value=validateConfig(JSON.parse(text.replace(/^\uFEFF/,'')),{lenient:true});
 const skipped=Object.getOwnPropertyDescriptor(value,'skipped')?.enumerable===false?value.skipped:[],dropped=['account','upstream','route'].map(kind=>[kind+'s',new Set(skipped.filter(item=>item.kind===kind).map(item=>item.id))]);
 validatedReads.set(store,{text,dropped,skippedText:skipped.length?JSON.stringify(skipped):null});
 return value;
}
export class ConfigStore {
  constructor(file) {this.file=localPath(file,process.cwd());this.base=dirname(this.file);}
  async load() {
    this.value=await readValidatedConfig(this);
    const skipped=this.value.skipped??[];
    // Report once per distinct shape: this runs on every request.
    const signature=skipped.map(s=>s.kind+':'+s.id).join('|');
    if(signature!==this.skippedSignature){this.skippedSignature=signature;if(skipped.length)console.warn('CONFIG_DEGRADED '+JSON.stringify(skipped));}
    this.dataDir=localPath(this.value.dataDir??'./data',this.base);
    return this.value;
  }
  // Workers otherwise reload on a timer. A final read-only gate prevents a
  // prepared/credential-refreshing request from spending a newly stopped account.
  async workBuddyInferenceAllowed(accountId) {const value=await readValidatedConfig(this),a=value.accounts.find(a=>a.id===accountId&&a.platform==='workbuddy');return !!a&&a.enabled!==false&&a.inferenceEnabled!==false;}
  path(value) {return localPath(value,this.base);}
  async snapshot() {const bytes=await readFile(this.file);return {value:validateConfig(JSON.parse(bytes)),sha256:createHash('sha256').update(bytes).digest('hex')};}
  async save(value,{expectedSha256}={}) {
    validateConfig(value);
    const lockFile=this.file+'.write-lock',until=Date.now()+2000;let lock;
    while(!lock){try{lock=await open(lockFile,'wx');}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>=until)throw new AppError('Configuration is being saved by another process; reload and retry',409,'configuration_busy');await delay(20);}}
    try{
      const before=await readFile(this.file),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
      if(expectedSha256&&hash(before)!==expectedSha256)throw new AppError('Configuration changed before commit; reload and retry',409,'configuration_changed');
      await atomicJson(this.file+'.backup.json',JSON.parse(before));
      // New ConfigStore writers share this lock. The second check also detects
      // direct file edits or an older writer during backup preparation.
      if(expectedSha256&&hash(await readFile(this.file))!==expectedSha256)throw new AppError('Configuration changed before commit; reload and retry',409,'configuration_changed');
      await atomicJson(this.file,value);await this.load();
    }finally{await lock.close();await unlink(lockFile);}
  }
}
