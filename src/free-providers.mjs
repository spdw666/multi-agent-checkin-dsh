import {readFileSync} from 'node:fs';
import {readFile,stat,lstat,mkdir,open,link,unlink,rmdir,realpath,rename} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError,hash,rememberSecret} from './util.mjs';

const metadata=JSON.parse(readFileSync(new URL('./free-provider-registry.json',import.meta.url),'utf8'));
const deepFreeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(deepFreeze);Object.freeze(v);}return v;};
export const freeProviderMetadata=deepFreeze(metadata);
export const freeProviderRegistry=freeProviderMetadata.providers;
export function getFreeProvider(id){const p=freeProviderRegistry.find(p=>p.id===id);if(!p)throw new AppError('Unknown free provider',400,'unknown_free_provider');return p;}
export function freeProviderList(){return freeProviderRegistry.map(p=>({...structuredClone(p),configured:false,missingCredential:!p.keyless}));}
export async function resolveFreeCredential(account){
 const provider=getFreeProvider(account.freeProviderId);let data={};const file=account.credentials?.file;
 if(file){if(!isAbsolute(file))throw new AppError('Credential file must be absolute',400,'invalid_credential_file');try{if((await stat(file)).size>1048576)throw new Error();data=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch{throw new AppError('Private credential file missing or invalid',401,'credential_missing');}}
 if(!data||typeof data!=='object'||Array.isArray(data))throw new AppError('Invalid credential document',400,'invalid_credential');
 const apiKey=data.apiKey??data.accessToken;
 if(typeof apiKey==='string')rememberSecret(apiKey);
 if((apiKey!==undefined&&(typeof apiKey!=='string'||!apiKey.trim()||/[\r\n]/.test(apiKey)))||(!apiKey&&!provider.keyless))throw new AppError('Provider API key is missing',401,'credential_missing');
 if(provider.id==='cloudflare'&&!/^[a-f0-9]{32}$/i.test(data.accountId??''))throw new AppError('Cloudflare accountId must contain 32 hexadecimal characters',400,'invalid_account_id');
 if(data.protocol!==undefined&&!(provider.id==='longcat'&&data.protocol==='anthropic'))throw new AppError('Unsupported protocol override',400,'invalid_protocol');
 if(data.proxyUrl!==undefined){let u;try{u=new URL(data.proxyUrl);}catch{}if(!u||u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new AppError('Proxy must be an explicit loopback HTTP proxy',400,'invalid_proxy');}
 return {providerId:provider.id,apiKey,accessToken:apiKey,accountId:data.accountId,proxyUrl:data.proxyUrl,protocol:data.protocol,models:Array.isArray(data.models)?data.models:[],freeModelIds:Array.isArray(data.freeModelIds)?data.freeModelIds:[],principal:`freeapi:${provider.id}:${hash((apiKey??'anonymous')+'|'+(data.accountId??'')).slice(0,24)}`,credentialStatus:apiKey?'configured':'anonymous'};
}
// An add request accepts a typed key, but management configuration retains only
// an account-specific file reference. Register secrets before *any* validation.
export function validateFreeProviderInput(body){
 if(body&&typeof body==='object'&&typeof body.apiKey==='string'){rememberSecret(body.apiKey);rememberSecret(body.apiKey.trim());}
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['providerId','id','apiKey','accountId','credentialFile','models'].includes(k)))throw new AppError('Invalid provider configuration fields',400,'invalid_provider_configuration');
 if(typeof body.id!=='string'||!/^([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})$/.test(body.id)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(body.id))throw new AppError('Invalid account id',400,'invalid_account_id');
 const provider=getFreeProvider(body.providerId);
 if(body.apiKey!==undefined&&body.credentialFile!==undefined)throw new AppError('Choose a typed API key or an existing credential file',400,'conflicting_credentials');
 if(body.apiKey!==undefined&&(typeof body.apiKey!=='string'||body.apiKey.length>16384||/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.apiKey)))throw new AppError('Invalid API key',400,'invalid_api_key');
 const apiKey=body.apiKey?.trim();
 if(apiKey&&/[^\x21-\x7e]/.test(apiKey))throw new AppError('API key must contain printable ASCII without spaces',400,'invalid_api_key');
 if(body.credentialFile!==undefined&&(typeof body.credentialFile!=='string'||body.credentialFile.length>32768||/[\x00-\x1f\x7f]/.test(body.credentialFile)||body.credentialFile&&!isAbsolute(body.credentialFile)))throw new AppError('Credential file must be an absolute local path',400,'invalid_credential_file');
 if(body.accountId!==undefined&&(provider.id!=='cloudflare'||typeof body.accountId!=='string'||body.accountId!==''&&!/^[a-f0-9]{32}$/i.test(body.accountId)))throw new AppError('Cloudflare accountId must contain 32 hexadecimal characters',400,'invalid_account_id');
 if(provider.id==='cloudflare'&&apiKey&&!/^[a-f0-9]{32}$/i.test(body.accountId??''))throw new AppError('Cloudflare API token requires its 32-character accountId',400,'invalid_account_id');
 if(body.credentialFile&&body.accountId)throw new AppError('Existing credential files supply their own accountId',400,'conflicting_credentials');
 if(body.models!==undefined&&(!Array.isArray(body.models)||body.models.length>500||body.models.some(m=>typeof m!=='string'||!m.trim()||m!==m.trim()||m.length>256||/[\x00-\x1f\x7f]/.test(m))||new Set(body.models).size!==body.models.length))throw new AppError('Models must be unique model IDs',400,'invalid_models');
 if(apiKey&&[body.id,body.providerId,body.accountId,...(body.models??[])].some(v=>typeof v==='string'&&v.includes(apiKey)))throw new AppError('Credential values must not appear in public configuration fields',400,'invalid_provider_configuration');
 return {provider,apiKey};
}
export function buildFreeProviderConfig(config,body){
 const {provider}=validateFreeProviderInput(body);if(provider.reuseExisting)throw new AppError('Use the existing dedicated provider integration',400,'reuse_existing_provider');
 if(['retired','non_chat','configuration_required'].includes(provider.availability))throw new AppError('Provider has no available chat transport',400,'provider_unavailable');
 const result=structuredClone(config),id=body.id;if(result.accounts.some(a=>a.id===id)||result.upstreams.some(u=>u.id===id))throw new AppError('Account or upstream already exists',409,'duplicate_account');
 result.accounts.push({id,name:provider.name,platform:'freeapi',freeProviderId:provider.id,enabled:false,tasks:[],credentials:body.credentialFile?{kind:'file',file:body.credentialFile}:{kind:'none'},...(body.models?.length?{selectedModels:[...body.models]}:{})});
 result.upstreams.push({id,kind:'freeapi',accountId:id,enabled:false});return result;
}
// Publish a fully written 0600 inode with link(), which atomically fails rather
// than replacing a pre-existing destination. The parent/account directories are
// verified as actual directories; a newly claimed account directory is exclusive.
export async function prepareFreeProviderConfig(store,config,body){
 const {apiKey}=validateFreeProviderInput(body),value=buildFreeProviderConfig(config,body);
 if(!apiKey)return {value,commit(){},async rollback(){},async persist(){await store.save(value);}};
 if(typeof store?.dataDir!=='string'||!isAbsolute(store.dataDir)||store.dataDir.length>32768||/[\x00-\x1f\x7f]/.test(store.dataDir))throw new AppError('Managed credentials require a configured absolute data directory',400,'invalid_credential_directory');
 let dir,temp,file,created=false,published=false,committed=false,ownedStat;
 const contents=JSON.stringify({apiKey,...(body.accountId?{accountId:body.accountId}:{})},null,2)+'\n';
 const cleanup=async()=>{
  if(committed)return;
  if(published){try{const info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink()&&info.dev===ownedStat.dev&&info.ino===ownedStat.ino&&(await readFile(file,'utf8'))===contents){await unlink(file);published=false;}}catch(e){if(e.code!=='ENOENT')throw new AppError('Managed credential cleanup failed',500,'credential_cleanup_failed');}}
  if(temp)await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw new AppError('Managed credential cleanup failed',500,'credential_cleanup_failed');});
  if(created)await rmdir(dir).catch(e=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw new AppError('Managed credential cleanup failed',500,'credential_cleanup_failed');});
 };
 try{
  const root=resolve(store.dataDir);await mkdir(root,{recursive:true,mode:0o700});let parent=await realpath(root);
  for(const part of ['private','free-providers']){parent=join(parent,part);try{await mkdir(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const info=await lstat(parent);if(info.isSymbolicLink()||!info.isDirectory())throw new AppError('Managed credential directory must not be a link',400,'invalid_credential_directory');}
  dir=join(parent,body.id);try{await mkdir(dir,{mode:0o700});created=true;}catch(e){if(e.code==='EEXIST')throw new AppError('Credential directory already exists; existing credentials were preserved',409,'credential_file_exists');throw e;}
  file=join(dir,'credentials.json');temp=join(dir,'.credentials-'+randomUUID()+'.tmp');
  const handle=await open(temp,'wx',0o600);try{await handle.writeFile(contents,'utf8');await handle.sync();ownedStat=await handle.stat();}finally{await handle.close();}
  await link(temp,file);published=true;await unlink(temp);temp=undefined;
  value.accounts.at(-1).credentials={kind:'file',file};
  const persist=async()=>{
   const before=typeof store.file==='string'?await readFile(store.file):undefined;
   try{await store.save(value);committed=true;}catch(e){
    // ConfigStore.save writes the config before reloading it. A late reload
    // failure must restore that exact pre-commit byte snapshot before key cleanup.
    // This method executes inside withConfigMutation, not after releasing it.
    if(before){
     let current;try{current=JSON.parse((await readFile(store.file,'utf8')).replace(/^\uFEFF/,''));}catch{committed=true;throw new AppError('Credential configuration recovery requires a reload',500,'configuration_recovery_required');}
     if(JSON.stringify(current)===JSON.stringify(value)){
      const restoreTemp=store.file+'.credential-rollback-'+randomUUID()+'.tmp';let createdTemp=false;
      try{const handle=await open(restoreTemp,'wx',0o600);createdTemp=true;try{await handle.writeFile(before);await handle.sync();}finally{await handle.close();}await rename(restoreTemp,store.file);store.value=config;}
      catch{committed=true;throw new AppError('Credential configuration recovery requires a reload',500,'configuration_recovery_required');}
      finally{if(createdTemp)await unlink(restoreTemp).catch(()=>{});}
     }else if(current.accounts?.some(a=>a.credentials?.file===file)){
      // A different writer has retained this reference. Preserve its config and
      // the credential it references rather than deleting a newly owned secret.
      committed=true;throw new AppError('Credential configuration changed during recovery',409,'configuration_changed');
     }
    }
    await cleanup();throw e;
   }
  };
  return {value,commit(){committed=true;},rollback:cleanup,persist};
 }catch(e){await cleanup();if(e instanceof AppError)throw e;throw new AppError('Managed credential file could not be saved',500,'credential_write_failed');}
}
export {freeProviderModels,freeProviderHealth,freeProviderChat} from './free-provider-adapter.mjs';
