// WorkBuddy 5.x local format reviewed against MIT changexbc/workbuddy-switch.
// This module copies local conversations additively. It does not claim cloud sync.
import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,writeFile,readdir,mkdir,open,rm,chmod,lstat,realpath} from 'node:fs/promises';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {AppError,atomicJson,readJson,hash} from './util.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {resolveCredentialFile} from './credentials.mjs';

const run=promisify(execFile),quote=s=>'"'+String(s).replaceAll('"','""')+'"';
async function defaultRunning() {
  if(process.platform==='win32'){const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-Process -Name WorkBuddy,WorkBuddyAI -ErrorAction SilentlyContinue).Count"],{windowsHide:true,timeout:8000});return Number(stdout.trim())>0;}
  try{const {stdout}=await run('pgrep',['-x','workbuddy'],{timeout:8000});return !!stdout.trim();}catch(e){if(e.code===1)return false;throw new AppError('WorkBuddy 运行状态待确认，尚未写入会话',409,'wb_session_process_unknown');}
}
const paths=(service,account)=>{const root=service.workbuddyRuntime?.sessionRoot?.(account)??join(homedir(),workBuddyEdition(account)==='ai'?'.workbuddy-ai':'.workbuddy');return {root,db:join(root,'workbuddy.db'),projects:join(root,'projects')};};
const running=service=>service.workbuddyRuntime?.isRunning??defaultRunning;
export const workBuddyClientRunning=service=>running(service)();
function columns(db){return db.prepare('pragma table_info(sessions)').all().map(r=>r.name);}
function ensureSchema(db){const names=columns(db);if(!['id','user_id','deleted_at'].every(k=>names.includes(k)))throw new AppError('本机 WorkBuddy 会话结构待适配，未写入会话',409,'wb_session_schema_unrecognized');return names;}
async function normalPath(file){const info=await lstat(file);if(info.isSymbolicLink())throw new AppError('会话路径包含链接，未写入会话',409,'wb_session_path_changed');return info;}
async function contained(canonicalRoot,file){const actual=await realpath(file),rel=relative(canonicalRoot,actual);if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new AppError('WB 会话路径离开原数据目录，未写入会话',409,'wb_session_path_changed');return actual;}
async function findBody(projects,id){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new AppError('WorkBuddy 会话标识格式错误',409,'wb_session_id_invalid');await normalPath(projects);const direct=join(projects,id+'.jsonl');try{if((await normalPath(direct)).isFile())return direct;}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const entry of await readdir(projects,{withFileTypes:true})){if(entry.isSymbolicLink())continue;if(!entry.isDirectory())continue;const file=join(projects,entry.name,id+'.jsonl');try{if((await normalPath(file)).isFile())return file;}catch(e){if(e.code!=='ENOENT')throw e;}}
  throw new AppError('本机缺少该会话正文；原会话保持不变',409,'wb_session_body_missing');
}
function transformBody(raw,sourceId,targetId){const rewrite=value=>{if(!value||typeof value!=='object')return value;if(Array.isArray(value))return value.map(rewrite);return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,['sessionId','conversationId','session_id','conversation_id'].includes(k)&&v===sourceId?targetId:rewrite(v)]));};
  return raw.split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.stringify(rewrite(JSON.parse(line)))}catch{throw new AppError('本机会话正文存在未完成记录；稍后重试，未覆盖原文',409,'wb_session_body_incomplete');}}).join('\n')+'\n';}
function normalizedBody(raw,id){return transformBody(raw,id,'WB_SESSION_ID');}
function liveRows(db,uid){return db.prepare('select * from sessions where user_id=? and deleted_at is null').all(uid);}
async function identity(service,account){try{return await service.credentials.resolve(account.id);}catch(e){if(!['credential_expired','account_disabled','wb_refresh_login_required','wb_refresh_unconfirmed'].includes(e.code))throw e;
  // Historical conversation ownership does not expire with a login. Read only
  // the stored stable UID, never rotate or expose the expired token here.
  const file=await resolveCredentialFile(account,service.config),raw=await readJson(file),uid=String(raw.uid??raw.principal??raw.account?.uid??'');
  if(!uid)throw e;const bound=service.ledger?.principalHash?.(account.id);if(bound&&bound!==hash('workbuddy\0'+uid))throw new AppError('WB 历史会话帐号身份不一致',409,'wb_session_identity_changed');return {uid,principal:uid};
}}

export async function workBuddySessionCapabilities(service) {
  const editions=[...new Set(service.config.value.accounts.filter(a=>a.platform==='workbuddy').map(workBuddyEdition))],stores=[];
  for(const edition of editions){const account={edition},p=paths(service,account);let supported=false,reason;try{await normalPath(p.db);await normalPath(p.projects);const db=new DatabaseSync(p.db,{readOnly:true});try{ensureSchema(db);supported=true;}finally{db.close();}}catch(e){reason=e.code??'store_unavailable';}stores.push({edition,supported,reason});}
  return {mode:'local_additive_copy',cloudSyncConfirmed:false,sourceConversationsPreserved:true,requiresClientClosed:true,stores};
}
export async function mergeWorkBuddySessions(service,{targetAccountId,sourceAccountIds}={}) {
  targetAccountId??=service.ledger?.get('wb-management-current')?.accountId??service.config.value.upstreams.find(u=>u.kind==='workbuddy'&&u.enabled!==false)?.accountId;
  const accounts=service.config.value.accounts.filter(a=>a.platform==='workbuddy'),target=accounts.find(a=>a.id===targetAccountId);
  if(!target)throw new AppError('请选择合并到的 WB 帐号',400,'wb_session_target_required');
  if(sourceAccountIds!==undefined&&(!Array.isArray(sourceAccountIds)||sourceAccountIds.some(id=>!accounts.some(a=>a.id===id))))throw new AppError('来源 WB 帐号不存在',400,'wb_session_source_invalid');
  const sources=accounts.filter(a=>a.id!==target.id&&(sourceAccountIds??accounts.map(a=>a.id)).includes(a.id));
  if(await running(service)())throw new AppError('请先结束 WorkBuddy 客户端的当前任务并关闭客户端，再合并本机会话；帐号尚未切换',409,'wb_session_client_running');
  const root=join(service.config.dataDir,'workbuddy-session-management');await mkdir(root,{recursive:true,mode:0o700});const lock=join(root,'merge.lock');let handle;
  try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new AppError('另一次会话合并正在进行；帐号尚未切换',409,'wb_session_merge_busy');throw e;}
  const copied=[],alreadyPresent=[],skipped=[];let journalFile,db,transaction=false;
  try{
    if(await running(service)())throw new AppError('WorkBuddy 客户端仍在运行；帐号尚未切换',409,'wb_session_client_running');
    const targetCredential=await identity(service,target),targetUid=String(targetCredential.uid??targetCredential.principal??'');if(!targetUid)throw new AppError('WB 目标帐号缺少稳定身份',409,'wb_session_identity_missing');
    const targetPaths=paths(service,target),targetCanonicalRoot=await realpath(targetPaths.root);await normalPath(targetPaths.db);await normalPath(targetPaths.projects);await contained(targetCanonicalRoot,targetPaths.db);await contained(targetCanonicalRoot,targetPaths.projects);
    const linkFile=join(root,'links.json'),links=await readJson(linkFile).catch(e=>{if(e.code==='ENOENT')return {version:1,groups:{},copies:{}};throw e;});
    const plan=[];for(const source of sources){const credential=await identity(service,source),uid=String(credential.uid??credential.principal??'');if(!uid)throw new AppError('WB 来源帐号缺少稳定身份',409,'wb_session_identity_missing');if(uid===targetUid&&workBuddyEdition(source)===workBuddyEdition(target))continue;
      const sourcePaths=paths(service,source),sourceCanonicalRoot=await realpath(sourcePaths.root);await normalPath(sourcePaths.db);await contained(sourceCanonicalRoot,sourcePaths.db);await contained(sourceCanonicalRoot,sourcePaths.projects);const read=new DatabaseSync(sourcePaths.db,{readOnly:true});try{ensureSchema(read);for(const row of liveRows(read,uid)){if(String(row.cwd??'').includes('claw')){skipped.push({accountId:source.id,sessionId:row.id,reason:'account_bound_workspace'});continue;}
        const file=await findBody(sourcePaths.projects,row.id);await contained(sourceCanonicalRoot,file);const raw=await readFile(file,'utf8'),digest=hash(normalizedBody(raw,row.id)),sourceKey=workBuddyEdition(source)+':'+row.id,group=links.groups[sourceKey]??hash(sourceKey),copyKey=group+':'+workBuddyEdition(target)+':'+hash(targetUid)+':'+digest;
        if(links.copies[copyKey]){const prior=links.copies[copyKey],readTarget=new DatabaseSync(targetPaths.db,{readOnly:true});try{const old=readTarget.prepare('select user_id from sessions where id=? and deleted_at is null').get(prior.targetId);if(old?.user_id===targetUid){const previous=await readFile(prior.targetFile,'utf8');if(hash(previous)===prior.bodyHash){alreadyPresent.push({accountId:source.id,sessionId:row.id,targetSessionId:prior.targetId});continue;}}}finally{readTarget.close();}}
        plan.push({sourceAccountId:source.id,sourceId:row.id,sourceKey,sourceFile:file,sourceRoot:sourcePaths.root,sourceCanonicalRoot,sourceHash:hash(raw),sourceDb:sourcePaths.db,row,group,copyKey,digest,relativeDirectory:relative(sourcePaths.projects,dirname(file))});
      }}finally{read.close();}}
    // Deduplicate aliases and copied chains, without merging distinct conversations.
    const unique=[...new Map(plan.map(p=>[p.copyKey,p])).values()];if(!unique.length)return {merged:true,targetAccountId:target.id,copied,alreadyPresent,skipped,cloudSyncConfirmed:false,mode:'local_additive_copy'};
    const journalId=hash(target.id+'\0'+unique.map(p=>p.copyKey).sort().join('\0')),operationsDir=join(root,'operations');await mkdir(operationsDir,{recursive:true,mode:0o700});journalFile=join(operationsDir,journalId+'.json');
    let journal=await readJson(journalFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!journal){journal={version:1,status:'prepared',targetAccountId:target.id,createdAt:new Date().toISOString(),items:unique.map(p=>({copyKey:p.copyKey,targetId:randomUUID()}))};await atomicJson(journalFile,journal);}
    const backupRoot=join(root,'backups',journalId);await mkdir(backupRoot,{recursive:true,mode:0o700});
    db=new DatabaseSync(targetPaths.db);db.exec('pragma busy_timeout=5000;pragma synchronous=FULL');const names=ensureSchema(db),backupFile=join(backupRoot,'workbuddy-before.db');
    try{await normalPath(backupFile);}catch(e){if(e.code!=='ENOENT')throw e;await backup(db,backupFile);await chmod(backupFile,0o600);}
    const copy=new DatabaseSync(backupFile,{readOnly:true});try{if(copy.prepare('pragma quick_check').get().quick_check!=='ok')throw new AppError('WB 会话备份校验失败，未写入会话',500,'wb_session_backup_failed');}finally{copy.close();}
    journal.backupFile=backupFile;journal.backupHash=hash(await readFile(backupFile));await atomicJson(journalFile,journal);
    // All source rows/bodies were validated before the first business write.
    if(await running(service)())throw new AppError('WorkBuddy 客户端已启动；帐号尚未切换',409,'wb_session_client_running');
    db.exec('BEGIN IMMEDIATE');transaction=true;
    for(const item of unique){if(await realpath(targetPaths.root)!==targetCanonicalRoot||await realpath(item.sourceRoot)!==item.sourceCanonicalRoot)throw new AppError('WB 会话数据根目录已更新，未写入会话',409,'wb_session_path_changed');await contained(item.sourceCanonicalRoot,item.sourceFile);if(hash(await readFile(item.sourceFile))!==item.sourceHash)throw new AppError('来源会话已更新，请重新合并；帐号尚未切换',409,'wb_session_source_changed');
      const targetId=journal.items.find(p=>p.copyKey===item.copyKey)?.targetId;if(!targetId)throw new AppError('WB 合并日志与来源不一致',409,'wb_session_journal_changed');
      const raw=await readFile(item.sourceFile,'utf8'),body=transformBody(raw,item.sourceId,targetId),folder=resolve(targetPaths.projects,item.relativeDirectory),rel=relative(targetPaths.projects,folder);if(rel.startsWith('..')||rel.includes(':'))throw new AppError('WB 会话目录格式异常',409,'wb_session_path_changed');await mkdir(folder,{recursive:true,mode:0o700});await normalPath(folder);await contained(targetCanonicalRoot,folder);
      const targetFile=join(folder,targetId+'.jsonl');try{await writeFile(targetFile,body,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(await readFile(targetFile,'utf8')!==body)throw new AppError('目标副本已被修改，保留副本且暂停合并',409,'wb_session_target_changed');}
      const existing=db.prepare('select user_id from sessions where id=?').get(targetId);if(existing){if(existing.user_id!==targetUid)throw new AppError('目标副本身份发生变化，暂停合并',409,'wb_session_target_changed');}else{
        const cols=names.filter(k=>Object.hasOwn(item.row,k)),values=cols.map(k=>k==='id'?targetId:k==='user_id'?targetUid:k==='deleted_at'?null:['created_at','updated_at'].includes(k)?Date.now():item.row[k]);db.prepare('insert into sessions ('+cols.map(quote).join(',')+') values ('+cols.map(()=>'?').join(',')+')').run(...values);
      }
      if(hash(await readFile(targetFile))!==hash(body))throw new AppError('WB 副本写后校验失败',500,'wb_session_verify_failed');
      links.groups[item.sourceKey]=item.group;links.groups[workBuddyEdition(target)+':'+targetId]=item.group;
      const sourceEdition=item.sourceKey.slice(0,item.sourceKey.indexOf(':'));links.copies[item.group+':'+sourceEdition+':'+hash(String(item.row.user_id))+':'+item.digest]={targetId:item.sourceId,targetFile:item.sourceFile,bodyHash:item.sourceHash};
      links.copies[item.copyKey]={targetId,targetFile,bodyHash:hash(body)};copied.push({accountId:item.sourceAccountId,sessionId:item.sourceId,targetSessionId:targetId});
    }
    db.exec('COMMIT');transaction=false;await atomicJson(linkFile,links);journal.status='complete';journal.completedAt=new Date().toISOString();await atomicJson(journalFile,journal);
    return {merged:true,targetAccountId:target.id,copied,alreadyPresent,skipped,backupFile,backupHash:journal.backupHash,operationFile:journalFile,cloudSyncConfirmed:false,mode:'local_additive_copy'};
  }catch(e){if(transaction)db?.exec('ROLLBACK');if(journalFile){const journal=await readJson(journalFile).catch(()=>null);if(journal)await atomicJson(journalFile,{...journal,status:'pending',lastError:e.code??'write_failed'});}throw e;}finally{db?.close();await handle.close();await rm(lock,{force:true});}
}
