// Independently implemented WorkBuddy-switch-compatible account transport.
// The HTTP caller serializes mutations with withConfigMutation. No login,
// credential refresh, task, check-in, route enable, or client switch occurs.
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError,atomicJson,hash,rememberSecret,redact} from './util.mjs';
import {resolveCredentialFile} from './credentials.mjs';
import {syncWorkBuddyPools} from './workbuddy-management.mjs';
import {workBuddyEdition,workBuddyExpiry} from './workbuddy-auth.mjs';
import {WB_TRANSFER_LIMITS,decodeWorkBuddyText,readWorkBuddyZip,createWorkBuddyZip} from './workbuddy-archive.mjs';
const L=WB_TRANSFER_LIMITS,object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const issue=(code,message)=>new AppError(message,400,code);
const domains=new Map([['www.workbuddy.cn','cn'],['workbuddy.cn','cn'],['www.codebuddy.cn','cn'],['codebuddy.cn','cn'],['www.workbuddy.ai','ai'],['workbuddy.ai','ai'],['www.codebuddy.ai','ai'],['codebuddy.ai','ai']]);
function valueText(v,{required=false,max=1000}={}){if(v===undefined||v===null){if(required)throw issue('wb_import_identity','WB 文件缺少稳定账号身份');return '';}if(!['string','number'].includes(typeof v))throw issue('wb_import_identity','WB 账号身份字段类型不正确');const s=String(v);if((required&&!s.trim())||s.length>max||/[\x00-\x1f\x7f]/.test(s))throw issue('wb_import_identity','WB 账号身份字段长度或字符不正确');return s;}
function profileText(v,key,max){if(v!==undefined&&(typeof v!=='string'||v.length>max||(key==='label'?/[\x00-\x1f\x7f]/:/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(v)))throw issue('wb_profile_invalid',`WB ${key} 字段类型或长度不正确`);return v;}
function normalize(raw){
  if(!object(raw))throw issue('wb_import_schema','WB JSON 需要账号对象');
  const original=raw;let authRaw,switchMetadata;
  if(!object(raw.account)||!object(raw.auth)){
    if(!own(raw,'access_token')&&!own(raw,'auth_raw'))throw issue('wb_import_schema','WB JSON 需要 account/auth 对象或 workbuddy-switch 账号记录');
    if(raw.auth_raw!==undefined&&!object(raw.auth_raw))throw issue('wb_import_schema','WB auth_raw 需要对象');
    authRaw=raw.auth_raw;const source=authRaw??{},pa=object(source.account)?source.account:object(raw.profile_raw)?raw.profile_raw:{},ba=object(source.auth)?source.auth:source;
    const variant=[undefined,null,''].includes(raw.variant)?undefined:raw.variant;if(variant!==undefined&&!['cn','ai'].includes(variant))throw issue('wb_import_domain','WB variant 需要 cn 或 ai');
    const domain=raw.domain||ba.domain||(variant==='ai'?'www.workbuddy.ai':'www.codebuddy.cn');
    if(variant!==undefined&&domains.get(String(domain).toLowerCase())!==variant)throw issue('wb_import_domain','WB variant 与官方域名档位不一致');
    if(raw.note!==undefined)profileText(raw.note,'notes',2000);
    const profile={...pa,...(raw.uid!==undefined?{uid:raw.uid}:{}),...(raw.nickname!==undefined?{nickname:raw.nickname}:{}),...(raw.enterpriseId!==undefined?{enterpriseId:raw.enterpriseId}:{}),...(raw.email!==undefined?{email:raw.email}:{})};
    raw={account:profile,auth:{accessToken:original.access_token??ba.accessToken??ba.access_token,refreshToken:original.refresh_token??ba.refreshToken??ba.refresh_token,expiresAt:original.expiresAt??ba.expiresAt,domain},gateway:original.gateway??{...(typeof original.note==='string'?{notes:original.note}:{})}};
    switchMetadata={...(typeof original.displayField==='string'&&['uid','nickname','email','note'].includes(original.displayField)?{displayField:original.displayField}:{})};
  }
  const a=raw.account,b=raw.auth,uid=valueText(a.uid,{required:true,max:200}),domain=typeof b.domain==='string'?b.domain.toLowerCase():'';
  if(!domains.has(domain))throw issue('wb_import_domain','WB auth.domain 需要已知的官方 CN/AI 域名');
  for(const k of ['accessToken','refreshToken']){
    if(k==='refreshToken'&&(b[k]===undefined||b[k]===''))continue;
    if(object(b[k])&&(own(b[k],'$wbEncrypted')||own(b[k],'envelope'))||typeof b[k]==='string'&&/^enc[:/]/i.test(b[k]))throw issue('wb_import_encrypted_token','WB 加密登录态需要先由原客户端保存为可读登录态');
    if(typeof b[k]!=='string'||!b[k].trim()||b[k].length>32768||/[\x00-\x20\x7f]/.test(b[k]))throw issue('wb_import_token','WB 登录态字段缺失或格式不正确');
  }
  rememberSecret(b.accessToken);rememberSecret(b.refreshToken);
  if(!['number','string'].includes(typeof b.expiresAt)||!/^\d+(?:\.\d+)?$/.test(String(b.expiresAt)))throw issue('wb_import_expiry','WB expiresAt 需要秒或毫秒时间戳');
  const expiresAtMs=workBuddyExpiry({expiresAt:b.expiresAt});if(!Number.isFinite(expiresAtMs)||expiresAtMs<=0||expiresAtMs>8640000000000000)throw issue('wb_import_expiry','WB expiresAt 时间戳超出有效范围');
  const gateway=raw.gateway===undefined?{}:raw.gateway;if(!object(gateway)||Object.keys(gateway).some(k=>!['label','notes','inferenceEnabled'].includes(k))||gateway.inferenceEnabled!==undefined&&typeof gateway.inferenceEnabled!=='boolean')throw issue('wb_import_metadata','WB gateway 元数据格式不正确');
  const nickname=valueText(a.nickname,{max:500}),enterpriseId=valueText(a.enterpriseId,{max:200}),label=profileText(gateway.label,'label',128),notes=profileText(gateway.notes,'notes',2000);
  const account={uid,enterpriseId,nickname,...(a.email!==undefined?{email:valueText(a.email,{max:500})}:{}),...(a.enterpriseName!==undefined?{enterpriseName:valueText(a.enterpriseName,{max:500})}:{})},auth={accessToken:b.accessToken,refreshToken:b.refreshToken??'',expiresAt:expiresAtMs,domain};
  return {uid,edition:domains.get(domain),label:label?.trim()||nickname.slice(0,128)||'WorkBuddy '+domains.get(domain).toUpperCase(),notes:notes??'',inferenceEnabled:gateway.inferenceEnabled!==false,account,auth,expiresAtMs,authRaw:authRaw??{account,auth},switchMetadata};
}
function parseJson(text){try{return JSON.parse(text);}catch{throw issue('wb_import_json','WB JSON 语法不正确');}}
function documents(raw){if(Array.isArray(raw))return raw;if(object(raw)&&raw.format==='workbuddy-auths'&&raw.schemaVersion===1&&Array.isArray(raw.accounts))return raw.accounts;return [raw];}
function inputFiles(body){
  if(!object(body))throw issue('wb_import_request','WB 导入需要请求对象');
  const files=body.files===undefined?[{format:body.format??'json',content:body.content}]:body.files;
  if(!Array.isArray(files)||!files.length||files.length>L.files)throw issue('wb_import_file_limit','WB 导入文件数量超出限制');
  let total=0;const records=[];
  for(let fi=0;fi<files.length;fi++){
    const f=files[fi];if(!object(f)||!['json','zip'].includes(f.format??'json'))throw issue('wb_import_format','WB 导入仅接受 JSON 或 ZIP');
    const format=f.format??'json';let bytes;
    if(format==='zip'){
      if(typeof f.content!=='string'||!f.content.length||f.content.length>Math.ceil(L.inputBytes/3)*4+4||f.content.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.content))throw issue('wb_import_archive_invalid','WB ZIP 需要有效 base64 内容');bytes=Buffer.from(f.content,'base64');if(bytes.toString('base64')!==f.content)throw issue('wb_import_archive_invalid','WB ZIP 需要有效 base64 内容');
    }else {if(typeof f.content!=='string'&&!object(f.content)&&!Array.isArray(f.content))throw issue('wb_import_request','WB JSON 内容需要文本、对象或数组');bytes=Buffer.from(typeof f.content==='string'?f.content:JSON.stringify(f.content),'utf8');}
    total+=bytes.length;if(total>L.inputBytes)throw issue('wb_import_size_limit','WB 导入文件总大小超出 4 MiB');
    const list=format==='zip'?readWorkBuddyZip(bytes):[{bytes}];
    for(const file of list){if(file.bytes.length>L.jsonBytes)throw issue('wb_import_size_limit','WB 单个 JSON 文件超出 256 KiB');for(const raw of documents(parseJson(decodeWorkBuddyText(file.bytes)))){if(records.length>=L.accounts)throw issue('wb_import_account_limit','WB 单次最多导入 128 个账号');records.push({raw,fileIndex:fi,index:records.length});}}
  }
  if(!records.length)throw issue('wb_import_empty','WB 文件未包含账号');return records;
}
async function existingIdentities(service){
  const map=new Map();for(const a of service.config.value.accounts??[]){if(a.platform!=='workbuddy')continue;let uid=a.uid??a.principal;
    try{const file=await resolveCredentialFile(a,service.config),b=await readFile(file);if(b.length<=2*1024*1024){const raw=parseJson(decodeWorkBuddyText(b));uid=raw.uid??raw.principal??raw.account?.uid??raw.profileRaw?.uid??uid;}}catch{/* Missing local metadata does not expose a credential or trigger a refresh. */}
    if(uid!==undefined&&uid!==null&&String(uid))map.set(workBuddyEdition(a)+'\0'+String(uid),a);
  }return map;
}
async function prepare(service,body){
  const records=inputFiles(body),existing=await existingIdentities(service),seen=new Set(),entries=[];
  for(const r of records){try{const n=normalize(r.raw),key=n.edition+'\0'+n.uid,found=existing.get(key)??(service.config.value.accounts??[]).find(a=>a.platform==='workbuddy'&&workBuddyEdition(a)===n.edition&&service.ledger?.principalHash?.(a.id)===hash('workbuddy\0'+n.uid)),duplicateInImport=seen.has(key),hasRefreshToken=n.auth.refreshToken.length>0;seen.add(key);entries.push({...r,normalized:n,existing:found,view:{index:r.index,fileIndex:r.fileIndex,label:redact(n.label),uid:redact(n.uid),edition:n.edition,duplicate:!!found||duplicateInImport,duplicateInImport,accountId:found?.id??null,expiresAt:new Date(n.expiresAtMs).toISOString(),expired:n.expiresAtMs<=Date.now(),hasRefreshToken,refreshable:hasRefreshToken,warnings:hasRefreshToken?[]:[{code:'wb_import_access_only',message:'该账号仅含访问态；访问态到期后需重新登录，未提供自动续期凭据'}],inferenceEnabled:found?found.inferenceEnabled!==false:n.inferenceEnabled,valid:true,errors:[]}});}catch(e){if(!(e instanceof AppError))throw e;entries.push({...r,view:{index:r.index,fileIndex:r.fileIndex,label:'待核验账号',uid:null,edition:null,duplicate:false,accountId:null,valid:false,errors:[{code:e.code,message:e.message}]}});}}
  return entries;
}
export async function previewWorkBuddyImport(service,body){
  try{const entries=await prepare(service,body),errors=entries.flatMap(r=>r.view.errors.map(e=>({index:r.index,...e})));return {preview:true,valid:errors.length===0,count:entries.length,entries:entries.map(r=>r.view),errors,tokenReturned:false,limits:L};}
  catch(e){if(!(e instanceof AppError))throw e;return {preview:true,valid:false,count:0,entries:[],errors:[{index:null,code:e.code,message:e.message}],tokenReturned:false,limits:L};}
}
function selection(body,count){if(body.duplicatePolicy!==undefined&&!['skip','replace'].includes(body.duplicatePolicy))throw issue('wb_import_duplicate_policy','WB 重复策略需要 skip 或 replace');if(body.selectedIndexes===undefined)return new Set(Array.from({length:count},(_,i)=>i));const ids=body.selectedIndexes;if(!Array.isArray(ids)||!ids.length||ids.some(i=>!Number.isInteger(i)||i<0||i>=count)||new Set(ids).size!==ids.length)throw issue('wb_import_selection','WB 导入选择索引不正确');return new Set(ids);}
function ownedFile(service,id){const root=resolve(service.config.dataDir,'accounts'),file=resolve(root,id,'workbuddy-session.json');if(!file.startsWith(root+sep))throw issue('wb_import_path','WB 本机账号路径不正确');return file;}
function newId(value,n){let id='wb-'+n.edition+'-'+hash(n.uid).slice(0,16),suffix=0;while(value.accounts.some(a=>a.id===id))id='wb-'+n.edition+'-'+hash(n.uid).slice(0,16)+'-'+(++suffix);return id;}
function newUpstreamId(value,id){let name='wb-'+id,suffix=0;while(value.upstreams.some(u=>u.id===name))name='wb-'+id+'-'+(++suffix);return name;}
async function bytesIfExists(file){try{return await readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function importWorkBuddyAccounts(service,body){
  if(typeof service.config.load==='function')await service.config.load();
  const entries=await prepare(service,body),selected=selection(body,entries.length);if(entries.some(r=>!r.view.valid))throw issue('wb_import_validation','WB 文件存在校验错误，请先修正预览中列出的问题');
  const value=structuredClone(service.config.value),before=structuredClone(service.config.value),seen=new Set(),writes=[],accounts=[];let imported=0,replaced=0,skipped=0;
  for(const r of entries){if(!selected.has(r.index))continue;const n=r.normalized,key=n.edition+'\0'+n.uid;
    if(seen.has(key)||r.existing&&body.duplicatePolicy!=='replace'){skipped++;accounts.push({index:r.index,accountId:r.existing?.id??null,status:'skipped',label:redact(r.existing?.label??n.label)});continue;}seen.add(key);
    const prior=r.existing,id=prior?.id??newId(value,n),file=ownedFile(service,id),account=prior?{...value.accounts.find(a=>a.id===id),credentials:{kind:'file',file}}:{id,label:n.label,notes:n.notes,platform:'workbuddy',edition:n.edition,enabled:true,inferenceEnabled:n.inferenceEnabled,credentials:{kind:'file',file},tasks:[{id:'daily-checkin',enabled:true}]};
    const snapshot={managedBy:'ai-credit-gateway',credentialVersion:1,platform:'workbuddy',uid:n.uid,principal:n.uid,edition:n.edition,domain:n.auth.domain,accessToken:n.auth.accessToken,refreshToken:n.auth.refreshToken,expiresAtMs:n.expiresAtMs,profileRaw:n.account,authRaw:n.authRaw,...(n.switchMetadata?{switchMetadata:n.switchMetadata}:{}),updatedAt:new Date().toISOString()};
    if(prior){value.accounts[value.accounts.findIndex(a=>a.id===id)]=account;replaced++;}else{value.accounts.push(account);imported++;}
    if(!value.upstreams.some(u=>u.kind==='workbuddy'&&u.accountId===id))value.upstreams.push({id:newUpstreamId(value,id),kind:'workbuddy',accountId:id,enabled:true});
    writes.push({id,file,snapshot,original:await bytesIfExists(file)});accounts.push({index:r.index,accountId:id,status:prior?'replaced':'imported',label:redact(account.label??id)});
  }
  if(!writes.length)return {saved:true,imported,replaced,skipped,accounts,backupId:null,tokenReturned:false,desktopLoginChanged:false,routesEnabledChanged:false};
  // Only explicitly auto-managed pools may acquire newly imported members.
  const legacyPools=new Map(value.routes.filter(r=>!r.accountPool||r.accountPool.autoManaged!==true).map(r=>[r.id,structuredClone(r.accountPool)]));syncWorkBuddyPools(value);for(const r of value.routes)if(legacyPools.has(r.id)){const p=legacyPools.get(r.id);if(p===undefined)delete r.accountPool;else r.accountPool=p;}
  const backupId=Date.now()+'-'+randomUUID(),backup=join(service.config.dataDir,'account-transfer-backups',backupId),configOriginal=service.config.file?await bytesIfExists(service.config.file):null;
  await mkdir(backup,{recursive:true,mode:0o700});await atomicJson(join(backup,'manifest.json'),{schemaVersion:1,createdAt:new Date().toISOString(),operation:'workbuddy_import',config:before,files:writes.map((w,i)=>({accountId:w.id,originalExisted:!!w.original,backup:w.original?i+'.bin':null}))});
  for(let i=0;i<writes.length;i++)if(writes[i].original)await writeFile(join(backup,i+'.bin'),writes[i].original,{mode:0o600});
  if(configOriginal)await writeFile(join(backup,'config.original'),configOriginal,{mode:0o600});
  let configAttempted=false;
  try{for(const w of writes){const latest=await bytesIfExists(w.file);if(!((!latest&&!w.original)||latest&&w.original&&latest.equals(w.original)))throw new AppError('WB 本机登录态在导入期间已更新；请重新预览后导入',409,'wb_import_source_changed');w.attempted=true;await atomicJson(w.file,w.snapshot);}if(service.config.file){let latest;try{latest=parseJson(decodeWorkBuddyText(await readFile(service.config.file)));}catch{throw new AppError('WB 配置在导入期间已更新；请重新预览后导入',409,'wb_import_config_changed');}if(JSON.stringify(latest)!==JSON.stringify(before))throw new AppError('WB 配置在导入期间已更新；请重新预览后导入',409,'wb_import_config_changed');}configAttempted=true;await service.config.save(value);}
  catch(error){let incomplete=false;for(const w of writes.filter(w=>w.attempted))try{const actual=await bytesIfExists(w.file),attempted=Buffer.from(JSON.stringify(w.snapshot,null,2)+'\n','utf8');if((!actual&&!w.original)||actual&&w.original&&actual.equals(w.original))continue;if(!actual||!actual.equals(attempted)){incomplete=true;continue;}if(w.original)await writeFile(w.file,w.original,{mode:0o600});else await rm(w.file,{force:true});}catch{incomplete=true;}
    if(configAttempted&&service.config.file&&configOriginal){try{const actual=await bytesIfExists(service.config.file),parsed=actual?parseJson(decodeWorkBuddyText(actual)):null;if(JSON.stringify(parsed)===JSON.stringify(value)||JSON.stringify(parsed)===JSON.stringify(before))await writeFile(service.config.file,configOriginal,{mode:0o600});else incomplete=true;}catch{incomplete=true;}}
    service.config.value=before;if(typeof service.config.load==='function')try{await service.config.load();}catch{incomplete=true;}if(incomplete)throw new AppError('WB 导入失败；独立原件备份已保留，部分还原需要核验',500,'wb_import_rollback_incomplete');if(['wb_import_source_changed','wb_import_config_changed'].includes(error.code))throw error;throw new AppError('WB 导入写入失败；本次账号与配置已还原',500,'wb_import_write_failed');
  }
  for(const w of writes){service.credentials?.cache?.delete(w.id);service.balanceCache?.delete(w.id);service.balanceCacheKeys?.delete(w.id);}
  return {saved:true,imported,replaced,skipped,accounts,backupId,tokenReturned:false,desktopLoginChanged:false,routesEnabledChanged:false};
}
async function exportRaw(service,account){
  const file=await resolveCredentialFile(account,service.config),bytes=await readFile(file);if(bytes.length>2*1024*1024)throw issue('wb_export_size_limit','WB 本机账号文件过大');const raw=parseJson(decodeWorkBuddyText(bytes)),auth=raw.auth??raw,profile=raw.account??raw.profileRaw??{},uid=raw.uid??raw.principal??profile.uid;
  if(typeof auth.accessToken!=='string')throw issue('wb_export_saved_session_required','WB 导出需要已保存的账号登录态，请先保存当前账号');
  const normalized=normalize({account:{...profile,uid,enterpriseId:profile.enterpriseId??'',nickname:profile.nickname??''},auth:{accessToken:auth.accessToken,refreshToken:auth.refreshToken,expiresAt:raw.expiresAtMs??auth.expiresAt,domain:auth.domain??raw.domain},gateway:{label:account.label??account.id,notes:account.notes??'',inferenceEnabled:account.inferenceEnabled!==false}});
  const authRaw=structuredClone(raw.authRaw??{account:normalized.account,auth:normalized.auth}),target=object(authRaw.auth)?authRaw.auth:authRaw;Object.assign(target,normalized.auth);
  // Native switch clients prefer auth_raw.auth. A renewed owned session must
  // export its current token pair there too, not only in the flat snake fields.
  for(const container of [authRaw,authRaw.auth].filter(object))for(const [key,current]of Object.entries({...normalized.auth,access_token:normalized.auth.accessToken,refresh_token:normalized.auth.refreshToken}))if(own(container,key))container[key]=current;
  return {doc:{account:normalized.account,auth:normalized.auth,gateway:{label:account.label??account.id,notes:account.notes??'',inferenceEnabled:account.inferenceEnabled!==false}},authRaw,switchMetadata:raw.switchMetadata??{}};
}
export async function exportWorkBuddyAccounts(service,body){
  if(!object(body)||!['json','zip','switch-json'].includes(body.format??'json')||!Array.isArray(body.accountIds)||!body.accountIds.length||body.accountIds.length>L.accounts||new Set(body.accountIds).size!==body.accountIds.length||body.accountIds.some(id=>typeof id!=='string'))throw issue('wb_export_request','WB 导出需要选择账号与 JSON/ZIP/switch-json 格式');
  const selected=body.accountIds.map(id=>service.config.value.accounts.find(a=>a.id===id&&a.platform==='workbuddy'));if(selected.some(a=>!a))throw new AppError('WB 导出选择包含不存在的账号',404,'account_not_found');const records=[];for(const a of selected)records.push(await exportRaw(service,a));const docs=records.map(r=>r.doc);
  const stamp=new Date().toISOString().slice(0,10).replaceAll('-',''),format=body.format??'json';let bytes;
  if(format==='switch-json')bytes=Buffer.from(JSON.stringify(docs.map((d,i)=>({id:selected[i].id,uid:d.account.uid,nickname:d.account.nickname,email:d.account.email??'',enterpriseId:d.account.enterpriseId,access_token:d.auth.accessToken,refresh_token:d.auth.refreshToken,expiresAt:d.auth.expiresAt,domain:d.auth.domain,variant:workBuddyEdition(selected[i]),token_type:'Bearer',auth_raw:records[i].authRaw,profile_raw:d.account,note:d.gateway.notes,displayField:records[i].switchMetadata.displayField??'nickname',gateway:d.gateway})),null,2)+'\n','utf8');
  else if(format==='json')bytes=Buffer.from(JSON.stringify(docs.length===1?docs[0]:{schemaVersion:1,format:'workbuddy-auths',accounts:docs},null,2)+'\n','utf8');
  else{const manifest=['file\taccount_id\tedition\tlabel\tuid'];const entries=docs.map((d,i)=>{const name='workbuddy-'+String(i+1).padStart(3,'0')+'.json',content=JSON.stringify(d,null,2)+'\n';if(Buffer.byteLength(content,'utf8')>L.jsonBytes)throw issue('wb_export_size_limit','WB 单个账号 JSON 超出 256 KiB，请核验已保存的账号资料');manifest.push([name,selected[i].id,workBuddyEdition(selected[i]),d.gateway.label,d.account.uid].map(v=>String(v).replace(/[\t\r\n]/g,' ')).join('\t'));return {name,content};});entries.push({name:'_manifest.tsv',content:manifest.join('\n')+'\n'});bytes=createWorkBuddyZip(entries);}
  if(bytes.length>(format==='zip'?L.inputBytes:L.jsonBytes))throw issue('wb_export_size_limit',format==='zip'?'WB ZIP 导出超出 4 MiB，请分批选择账号':'WB JSON 导出超出 256 KiB，请选择 ZIP 或分批导出');
  return {exported:true,filename:(format==='switch-json'?'wb-switch-accounts-':'workbuddy-auths-')+docs.length+'-'+stamp+'.'+(format==='zip'?'zip':'json'),contentType:format==='zip'?'application/zip':'application/json; charset=utf-8',encoding:'base64',content:bytes.toString('base64'),count:docs.length};
}
export async function updateWorkBuddyAccount(service,id,body){
  if(!object(body)||!Object.keys(body).length||Object.keys(body).some(k=>!['label','notes'].includes(k)))throw issue('wb_profile_invalid','WB 账号资料仅支持 label 与 notes');
  if(own(body,'label')&&(typeof body.label!=='string'||!body.label.trim()))throw issue('wb_profile_invalid','WB 显示名称需要非空文本');profileText(body.label,'label',128);profileText(body.notes,'notes',2000);
  if(typeof service.config.load==='function')await service.config.load();const value=structuredClone(service.config.value),a=value.accounts.find(a=>a.id===id&&a.platform==='workbuddy');if(!a)throw new AppError('WB 账号不存在',404,'account_not_found');
  if(own(body,'label'))a.label=body.label.trim();if(own(body,'notes'))a.notes=body.notes;await service.config.save(value);return {saved:true,accountId:id,label:a.label??id,notes:a.notes??''};
}
