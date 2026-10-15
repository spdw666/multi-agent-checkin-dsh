// Official four-section auth format reviewed against MIT workbuddy-switch.
// Writes only while the official client is closed. Never terminates a process.
import {join} from 'node:path';
import {homedir} from 'node:os';
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {AppError,atomicJson,readJson,hash} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {workBuddyClientRunning} from './workbuddy-sessions.mjs';

export function workBuddyClientAuthFile(service,account){return service.workbuddyRuntime?.authFile?.(account)??join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'CodeBuddyExtension','Data','Public','auth',workBuddyEdition(account)==='ai'?'workbuddy-desktop-ai.info':'workbuddy-desktop.info');}
export async function prepareWorkBuddyClientSwitch(service,account,credential){
  if(await workBuddyClientRunning(service))throw new AppError('请先结束 WorkBuddy 客户端的当前任务并关闭客户端，再切换帐号；当前帐号保持不变',409,'wb_session_client_running');
  const file=workBuddyClientAuthFile(service,account),source=await readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  let existing;try{existing=source?JSON.parse(source):{};}catch{throw new AppError('WorkBuddy 原登录文件格式待确认，当前帐号保持不变',409,'wb_client_auth_invalid');}
  let owned={};if(account.credentials?.kind==='file')owned=await readJson(service.config.path(account.credentials.file));
  const uid=String(credential.uid??credential.principal??''),edition=workBuddyEdition(account);if(!uid||!credential.accessToken)throw new AppError('WB 帐号登录态尚未就绪',409,'wb_client_identity_missing');
  const profile={...(owned.profileRaw??credential.profileRaw??{}),uid,nickname:owned.profileRaw?.nickname??account.label??account.id};
  const accountDefaults={type:'personal',accountType:'',idp:'',oneidAccountId:'',areaInfoComplete:false,isCurrentOneIdEnterprise:false,isCurrentOneIdPersonal:false,isFirstLogin:false,isCreator:false,isAdmin:false,uin:'',phoneNumber:'',lastLogin:true,pluginEnabled:true,deployStatus:{statusCode:0,statusMsg:'',detailMsg:''},sso:{domain:'',domainModifiedTimes:0}};for(const [k,v]of Object.entries(accountDefaults))profile[k]??=v;
  const now=Date.now(),auth={accessToken:credential.accessToken,refreshToken:credential.refreshToken??owned.refreshToken??'',tokenType:'Bearer',domain:credential.domain??(edition==='ai'?'www.workbuddy.ai':'www.workbuddy.cn'),lastRefreshTime:now,scope:'openid profile offline_access email',notBeforePolicy:0,sessionState:''};
  if(Number.isFinite(credential.expiresAtMs)){auth.expiresAt=credential.expiresAtMs;auth.expiresIn=Math.max(0,Math.floor((auth.expiresAt-now)/1000));}else auth.expiresIn=0;
  const refreshExpiry=credential.refreshExpiresAtMs??owned.refreshExpiresAtMs;if(Number.isFinite(refreshExpiry)){auth.refreshExpiresAt=refreshExpiry;auth.refreshExpiresIn=Math.max(0,Math.floor((refreshExpiry-now)/1000));}else auth.refreshExpiresIn=0;
  const list=(Array.isArray(existing.allAccounts)?existing.allAccounts:Array.isArray(existing.accounts)?existing.accounts:[]).filter(a=>String(a.uid??a.id??'')!==uid);list.push(profile);
  const next={...existing,account:profile,auth,accounts:list,allAccounts:list},backupRoot=join(service.config.dataDir,'workbuddy-client-backups');await mkdir(backupRoot,{recursive:true,mode:0o700});const backupFile=join(backupRoot,Date.now()+'-'+randomUUID()+'.json');
  // Backup includes a missing-file marker, so rollback also handles first login.
  await atomicJson(backupFile,{version:1,file,existed:source!==null,original:source?.toString('base64')??null,originalSha256:source?hash(source):null,createdAt:new Date().toISOString()});
  const saved=await readJson(backupFile);if(saved.originalSha256!==(source?hash(Buffer.from(saved.original,'base64')):null))throw new AppError('WorkBuddy 登录备份校验失败，当前帐号保持不变',500,'wb_client_backup_failed');
  let wrote=false;
  const rollback=async()=>{if(!wrote)return;if(source)await writeFile(file,source,{mode:0o600});else await rm(file,{force:true});const restored=await readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if((source?hash(source):null)!==(restored?hash(restored):null))throw new AppError('WorkBuddy 登录还原校验待确认',500,'wb_client_rollback_failed');wrote=false;};
  return {backupFile,async commit(){
    if(await workBuddyClientRunning(service))throw new AppError('WorkBuddy 客户端已启动，当前帐号保持不变',409,'wb_session_client_running');
    const current=await readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if((current?hash(current):null)!==(source?hash(source):null))throw new AppError('WorkBuddy 登录态已更新，请重新切换；当前帐号保持不变',409,'wb_client_auth_changed');
    try{wrote=true;await atomicJson(file,next);const verify=await readJson(file);if(verify.account?.uid!==uid||verify.auth?.accessToken!==credential.accessToken||!verify.allAccounts.some(a=>a.uid===uid))throw new AppError('WorkBuddy 登录写后校验失败',500,'wb_client_auth_verify_failed');return {clientSwitched:true,clientRestartRequired:true,backupFile,cloudSyncConfirmed:false};}catch(e){await rollback();throw e;}
  },rollback};
}
