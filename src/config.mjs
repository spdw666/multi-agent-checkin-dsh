import {dirname, join} from 'node:path';
import {readFile, copyFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AppError, atomicJson, localPath, readJson} from './util.mjs';
export const projectRoot = fileURLToPath(new URL('../',import.meta.url));
export function validateConfig(c) {
  const rejectInlineSecrets=(node)=>{if(!node||typeof node!=='object')return;for(const [k,v]of Object.entries(node)){if(/^(accessToken|refreshToken|apiKey|adminKey|password|cookie|authorization)$/i.test(k))throw new AppError('Store credentials in an account-specific local file, not the management config',400,'inline_credentials');rejectInlineSecrets(v);}};rejectInlineSecrets(c);
  if(c.schemaVersion!==1)throw new AppError('schemaVersion must be 1',400,'invalid_config');
  for(const field of ['accounts','upstreams','routes']){
    if(!Array.isArray(c[field]))throw new AppError(`${field} must be an array`,400,'invalid_config');
    const ids=new Set();for(const item of c[field]){
      if(!/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/.test(item.id??'')||item.id.includes('..')||ids.has(item.id))throw new AppError(`${field}: invalid/duplicate id`,400,'invalid_config');
      ids.add(item.id);
    }
  }
  for(const a of c.accounts)if(!['workbuddy','trae','qwenwork','zcode','minimax','bigmodel'].includes(a.platform)||!a.credentials)throw new AppError(`Account ${a.id}: invalid platform/credentials`,400,'invalid_config');
  for(const u of c.upstreams){
    if(!['workbuddy','trae','qwenwork','zcode','minimax','bigmodel'].includes(u.kind))throw new AppError(`Unknown upstream kind: ${u.kind}`,400,'invalid_config');
    if(!c.accounts.some(a=>a.id===u.accountId&&a.platform===u.kind))throw new AppError(`Upstream ${u.id}: account/platform mismatch`,400,'invalid_config');
  }
  for(const r of c.routes){
    if(!Array.isArray(r.targets)||!r.targets.length||r.targets.some(t=>typeof t.model!=='string'||!t.model||!c.upstreams.some(u=>u.id===t.upstreamId)))throw new AppError(`Route ${r.id}: invalid targets`,400,'invalid_config');
    const pool=r.accountPool;
    if(pool&&(!Array.isArray(pool.accountIds)||!pool.accountIds.length||new Set(pool.accountIds).size!==pool.accountIds.length||pool.accountIds.some(id=>!c.accounts.some(a=>a.id===id&&a.platform==='workbuddy'))||c.upstreams.find(u=>u.id===r.targets[0].upstreamId)?.kind!=='workbuddy'||pool.cooldownSeconds!==undefined&&(!Number.isInteger(pool.cooldownSeconds)||pool.cooldownSeconds<60||pool.cooldownSeconds>86400)))throw new AppError(`Route ${r.id}: invalid WorkBuddy account pool`,400,'invalid_config');
  }
  if(!c.server||!Number.isInteger(c.server.port)||c.server.port<0||c.server.port>65535)throw new AppError('Invalid server port',400,'invalid_config');
  if(c.server.bodyLimitBytes!==undefined&&(!Number.isInteger(c.server.bodyLimitBytes)||c.server.bodyLimitBytes<1024||c.server.bodyLimitBytes>67108864))throw new AppError('server.bodyLimitBytes must be an integer from 1024 to 67108864 (64 MiB)',400,'invalid_config');
  if(!['127.0.0.1','::1','localhost'].includes(c.server.host)&&!c.server.allowRemote)throw new AppError('Non-loopback listening needs server.allowRemote=true',400,'invalid_config');
  const s=c.scheduler;
  if(!s||!Number.isInteger(s.hour)||s.hour<0||s.hour>23||!Number.isInteger(s.minute)||s.minute<0||s.minute>59||!Number.isInteger(s.jitterSeconds)||s.jitterSeconds<0||s.jitterSeconds>86400)throw new AppError('Invalid scheduler settings',400,'invalid_config');
  if(s.retryMinutes!==undefined&&(!Number.isFinite(s.retryMinutes)||s.retryMinutes<1))throw new AppError('retryMinutes must be at least 1',400,'invalid_config');
  try{new Intl.DateTimeFormat('en',{timeZone:s.timezone}).format(new Date())}catch{throw new AppError('Invalid scheduler timezone',400,'invalid_config')}
  return c;
}
export async function initConfig(file) {
  await mkdir(dirname(file),{recursive:true});
  await copyFile(join(projectRoot,'config.example.json'),file,1).catch(e=>{if(e.code!=='EEXIST')throw e});
  return file;
}
export class ConfigStore {
  constructor(file) {this.file=localPath(file,process.cwd());this.base=dirname(this.file);}
  async load() {this.value=validateConfig(await readJson(this.file));this.dataDir=localPath(this.value.dataDir??'./data',this.base);return this.value;}
  path(value) {return localPath(value,this.base);}
  async save(value) {validateConfig(value);const before=await readFile(this.file);await atomicJson(this.file+'.backup.json',JSON.parse(before));await atomicJson(this.file,value);await this.load();}
}
