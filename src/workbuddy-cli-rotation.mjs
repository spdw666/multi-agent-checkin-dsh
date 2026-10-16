// Windows settings protocol independently implemented after MIT reference review.
// This bridge never terminates or starts a CLI. It only prepares the next launch.
import {join} from 'node:path';
import {homedir} from 'node:os';
import {readFile,readdir,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {AppError,atomicJson,hash,rememberSecret} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
const exec=promisify(execFile),ENV='entry_3bab4ce61838088127d444e4cc042d6d.info',ENDPOINT='entry_933d5543e80177622c17a73869c0fad7.info',PRODUCT='entry_604f48c944053e01d9546675443286c1.info';
export const workBuddyCliHome=service=>service.workbuddyRuntime?.cliHome??join(homedir(),'.codebuddy');
const bytes=async file=>readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const same=(a,b)=>(a===null&&b===null)||(a!==null&&b!==null&&a.equals(b));
export async function workBuddyCliBusy(service,now=Date.now()) {
  const runtime=service.workbuddyRuntime??{};let entries;
  try{entries=await readdir(join(workBuddyCliHome(service),'sessions'),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')entries=[];else return {busy:true,reason:'cli_session_registry_unreadable'};}
  for(const entry of entries){if(!entry.isFile()||! /^(?:\d+|manual-.+)\.json$/.test(entry.name))continue;
    let d;try{d=JSON.parse(await readFile(join(workBuddyCliHome(service),'sessions',entry.name),'utf8'));}catch{return {busy:true,reason:'cli_session_registry_invalid'};}
    if(Number.isInteger(d.lastHeartbeat)&&now-d.lastHeartbeat<=120000)return {busy:true,reason:'cli_session_running'};
  }
  if(typeof runtime.cliProcessRunning==='function')return await runtime.cliProcessRunning()?{busy:true,reason:'cli_process_running'}:{busy:false};
  try{
    let output;
    if(process.platform==='win32')({stdout:output}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$_.Name -match '^(node|codebuddy|cbc-prewarm)(\\.exe)?$' -and $_.CommandLine -match '@tencent-ai[\\\\/]codebuddy-code|codebuddy-code[\\\\/](dist-server|bin)[\\\\/]|[\\\\/]bin[\\\\/]codebuddy|codebuddy\\.cmd|cbc-prewarm'}; if($p){'BUSY'}else{'IDLE'}"],{windowsHide:true,timeout:7000,maxBuffer:1024}));
    else ({stdout:output}=await exec('ps',['-eo','args='],{timeout:5000,maxBuffer:1024*1024}));
    if(process.platform==='win32')return output.trim()==='IDLE'?{busy:false}:{busy:true,reason:'cli_process_running'};
    return /@tencent-ai[\/]codebuddy-code|codebuddy-code[\/](?:dist-server|bin)[\/]|[\/]bin[\/]codebuddy(?:\s|$)|cbc-prewarm/.test(output)?{busy:true,reason:'cli_process_running'}:{busy:false};
  }catch{return {busy:true,reason:'cli_process_status_unknown'};}
}
export function assertWorkBuddyCliEnvironment(service,edition) {
  const env=service.workbuddyRuntime?.cliEnvironment??process.env;
  if(String(env.CODEBUDDY_AUTH_TOKEN??'').trim())throw new AppError('CLI 进程环境令牌覆盖本机设置，本次轮换跳过',409,'cli_environment_override');
  const region=String(env.CODEBUDDY_INTERNET_ENVIRONMENT??'').trim().toLowerCase();
  if(region&&!(edition==='cn'?['internal','ioa']:['public','external']).includes(region))throw new AppError('CLI 进程环境地区与账号版本不一致，本次轮换跳过',409,'cli_region_override');
  if(String(env.CODEBUDDY_BASE_URL??'').trim())throw new AppError('CLI 进程环境接口覆盖本机设置，本次轮换跳过',409,'cli_endpoint_override');
}
export async function prepareWorkBuddyCliRotation(service,account,credential,{now=Date.now(),canCommit=async()=>true}={}) {
  const edition=workBuddyEdition(account);assertWorkBuddyCliEnvironment(service,edition);
  if(credential.domain&&workBuddyEdition(credential)!==edition)throw new AppError('CLI 登录态版本与账号不一致',409,'cli_credential_edition_mismatch');
  if((await workBuddyCliBusy(service,now)).busy)throw new AppError('CLI 会话仍运行，本次轮换跳过',409,'cli_session_running');
  let token=String(credential.accessToken??'').trim().replace(/^Bearer\s+/i,'');if(!token)throw new AppError('CLI 登录态缺失',409,'cli_credential_missing');rememberSecret(token);
  const home=workBuddyCliHome(service),settings=join(home,'settings.json'),files=[settings,join(home,'local_storage',ENV),join(home,'local_storage',ENDPOINT),join(home,'local_storage',PRODUCT)];
  const originals=await Promise.all(files.map(bytes));let value;
  try{value=originals[0]?JSON.parse(originals[0].toString('utf8').replace(/^\uFEFF/,'')):{};}catch{throw new AppError('CLI 设置格式待确认，未修改',409,'cli_settings_invalid');}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.env!==undefined&&(!value.env||typeof value.env!=='object'||Array.isArray(value.env)))throw new AppError('CLI 设置结构待确认，未修改',409,'cli_settings_invalid');
  if(value.apiKeyHelper)throw new AppError('CLI 已配置凭据 helper，保留原设置并跳过轮换',409,'cli_helper_configured');
  const next=structuredClone(value);next.env={...next.env,CODEBUDDY_AUTH_TOKEN:token,CODEBUDDY_INTERNET_ENVIRONMENT:edition==='cn'?'internal':'public'};
  if(edition==='cn')delete next.env.CODEBUDDY_BASE_URL;else next.env.CODEBUDDY_BASE_URL='https://www.codebuddy.ai/v2';
  const outputs=[Buffer.from(JSON.stringify(next,null,2)+'\n'),Buffer.from(JSON.stringify(edition==='cn'?'internal':'public')),Buffer.from(JSON.stringify(edition==='cn'?'https://copilot.tencent.com':'https://www.codebuddy.ai')),null];
  const backupId=randomUUID(),backup=join(service.config.dataDir,'workbuddy-cli-backups',backupId+'.json');
  await mkdir(join(service.config.dataDir,'workbuddy-cli-backups'),{recursive:true,mode:0o700});
  await atomicJson(backup,{version:1,createdAt:new Date(now).toISOString(),files:files.map((file,i)=>({file,existed:originals[i]!==null,sha256:originals[i]&&hash(originals[i]),original:originals[i]?.toString('base64')??null}))});
  const written=[];
  async function put(file,content,phase){await service.workbuddyRuntime?.cliBeforeWrite?.(file,content,phase);if(content===null){await rm(file,{force:true});return;}await mkdir(join(file,'..'),{recursive:true,mode:0o700});const tmp=file+'.gateway-'+randomUUID()+'.tmp';try{await writeFile(tmp,content,{mode:0o600});await rename(tmp,file);}finally{await rm(tmp,{force:true}).catch(()=>{});}}
  async function rollback(){const failed=[];for(const i of [...written].reverse()){try{const current=await bytes(files[i]);if(same(current,originals[i]))continue;if(!same(current,outputs[i])){failed.push(i);continue;}await put(files[i],originals[i],'rollback');}catch{failed.push(i);}}written.length=0;if(failed.length)throw new AppError('CLI 还原存在并发更新或写入失败，较新文件已保留',409,'cli_rollback_conflict');}
  return {backupId,async commit(){
    if(!await canCommit()||(await workBuddyCliBusy(service,Date.now())).busy)throw new AppError('轮换前状态已变，未修改CLI',409,'cli_rotation_changed');
    assertWorkBuddyCliEnvironment(service,edition);
    for(let i=0;i<files.length;i++)if(!same(await bytes(files[i]),originals[i]))throw new AppError('CLI 设置已有并发更新，未修改',409,'cli_settings_changed');
    try{
      for(let i=0;i<files.length;i++){written.push(i);await put(files[i],outputs[i],'commit');}
      for(let i=0;i<files.length;i++)if(!same(await bytes(files[i]),outputs[i]))throw new AppError('CLI 设置写后校验失败',500,'cli_write_verify_failed');
      return {accountId:account.id,backupId,cliSettingsWritten:true,processRestarted:false,effective:'cli_next_launch'};
    }catch(e){await rollback();throw e;}
  },rollback};
}
