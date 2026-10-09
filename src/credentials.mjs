import {bigModelCredential} from './bigmodel.mjs';
import {readFile, stat, access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join, dirname} from 'node:path';
import {homedir, userInfo} from 'node:os';
import {createHash,createDecipheriv} from 'node:crypto';
import {AppError, rememberSecret, readJson, hash,atomicJson} from './util.mjs';
import {projectRoot} from './config.mjs';
import {parseTraeStorageDocument, readTraeIdentity} from '../vendor/trae-core.mjs';
import {decryptElectronJson} from './windows-crypto.mjs';
import {parseMiniMaxCredential} from './minimax.mjs';
import {refreshQwenSession} from './qwenwork.mjs';
import {readMiniMaxDesktop,miniMaxRuntimeDir} from './minimax-desktop.mjs';
export function jwtClaims(token) {try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString())}catch{return {}}}
async function firstExisting(paths) {for(const p of paths){if(!p)continue;try{await access(p);return p}catch{}}throw new AppError('Local credential file not found',401,'credential_missing');}
function appData() {return process.env.APPDATA??(process.platform==='darwin'?join(homedir(),'Library/Application Support'):join(homedir(),'.config'));}
function localData(){return process.env.LOCALAPPDATA??(process.platform==='darwin'?join(homedir(),'Library/Application Support'):join(homedir(),'.local/share'));}
export async function resolveCredentialFile(account,config) {
  const explicit=account.credentials?.file;
  if(explicit&&explicit!=='auto')return config.path(explicit);
  if(account.platform==='workbuddy')return firstExisting([process.env.WORKBUDDY_AUTH_FILE,join(localData(),'CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'),join(homedir(),'.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')]);
  if(account.platform==='trae'){
    const names={cn:['Trae CN','trae-cn'],solo:['TRAE SOLO CN','trae-solo-cn'],sg:['Trae','trae'], 'solo-sg':['TRAE SOLO','trae-solo']}[account.edition??'cn'];
    return firstExisting(names.map(name=>join(appData(),name,'User/globalStorage/storage.json')));
  }
  if(account.platform==='qwenwork')return firstExisting([join(appData(),'QwenWorkCN/auth-v2.dat'),join(appData(),'QwenWork/auth-v2.dat'),join(appData(),'QwenWorkCN/auth.dat'),join(appData(),'QwenWork/auth.dat')]);
  if(account.platform==='zcode')return firstExisting([join(homedir(),'.zcode/v2/credentials.json')]);
  if(account.platform==='minimax'&&account.credentials?.kind==='desktop')return firstExisting([join(miniMaxRuntimeDir(account,config),'auth/prod',account.region==='intl'?'en':'cn','mcode-public/auth.json')]);
  throw new AppError('Configure an account-specific credentials file',401,'credential_missing');
}
export async function resolveWorkBuddyExecutable(account,config) {
  const value=account.credentials.executable;
  if(value&&value!=='auto')return config.path(value);
  return firstExisting([process.env.WORKBUDDY_APP_EXECUTABLE,process.env.WORKBUDDY_EXE,join(localData(),'Programs/WorkBuddy/WorkBuddy.exe'), ...(process.platform==='win32'?['D:/workbuddy/WorkBuddy.exe']:[]),...(process.platform==='darwin'?['/Applications/WorkBuddy.app/Contents/MacOS/Electron']:[])]);
}
export function runNativeHelper(executable,value,{timeout=12000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[join(projectRoot,'vendor/wb-auth-helper.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let result=Buffer.alloc(0), settled=false;
    const fail=(code)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();reject(new AppError(`WorkBuddy credential helper: ${code}`,401,code));};
    const timer=setTimeout(()=>fail('helper_timeout'),timeout);
    child.on('error',()=>fail('helper_start_failed'));
    child.stdout.on('data',chunk=>{result=Buffer.concat([result,chunk]);if(result.length>65536)fail('helper_output_limit');});
    child.stderr.on('data',()=>{}); // Never copy raw runtime stderr to a public diagnostic.
    child.on('close',()=>{
      if(settled)return;settled=true;clearTimeout(timer);
      try {const response=JSON.parse(result.toString('utf8'));result.fill(0);
        if(!response.ok||typeof response.accessToken!=='string')throw new AppError(`WorkBuddy credential helper: ${response.reason??'invalid_response'}`,401,'credential_decrypt_failed');
        resolve(response.accessToken);
      }catch(e){reject(e instanceof AppError?e:new AppError('Invalid credential helper response',401,'credential_decrypt_failed'));}
    });
    child.stdin.on('error',()=>fail('helper_input_failed'));
    child.stdin.end(JSON.stringify({version:1,operation:'decrypt',value}));
  });
}
export class CredentialManager {
  constructor(config,ledger){this.config=config;this.ledger=ledger;this.cache=new Map();this.flights=new Map();}
  account(id) {const a=this.config.value.accounts.find(a=>a.id===id);if(!a||a.enabled===false)throw new AppError('Account missing or disabled',400,'account_disabled');return a;}
  async resolve(id,{force=false}={}) {
    const account=this.account(id);
    if(force)this.cache.delete(id);
    if(this.flights.has(id))return this.flights.get(id);
    const p=this.read(account).catch(e=>{if(account.platform==='qwenwork'&&e.code==='credential_expired')return this.refreshQwen(id);throw e;}).finally(()=>this.flights.delete(id));this.flights.set(id,p);return p;
  }
  async read(account) {
    const file=await resolveCredentialFile(account,this.config);const info=await stat(file).catch(e=>{if(account.platform==='minimax')throw new AppError('MiniMax Code 登录态待导入本机凭据文件',401,'minimax_login_required');throw e});
    const fingerprint=hash(JSON.stringify(account.credentials)+file+info.mtimeMs+info.size);
    let credential=account.platform==='minimax'&&account.credentials.kind==='desktop'?undefined:this.cache.get(account.id)?.fingerprint===fingerprint?this.cache.get(account.id).credential:undefined;
    if(!credential) {
      if(account.platform==='minimax') {
        const raw=await readJson(file).catch(()=>{throw new AppError('MiniMax Code 登录态待导入本机凭据文件',401,'minimax_login_required')});
        credential=account.credentials.kind==='desktop'?await readMiniMaxDesktop(file,account,this.config):{...parseMiniMaxCredential(raw),filePath:file};
      }else if(account.platform==='bigmodel'){credential={...bigModelCredential(await readJson(file),account.id),filePath:file};}else if(account.credentials.kind==='file') {
        const raw=await readJson(file);credential={...raw,accessToken:raw.accessToken??raw.token,principal:raw.principal??raw.uid??raw.userId??jwtClaims(raw.accessToken??raw.token??'').sub,expiresAtMs:raw.expiresAtMs??jwtClaims(raw.accessToken??raw.token??'').exp*1000,source:'local-config',filePath:file};
      }else if(account.platform==='workbuddy') {
        const raw=await readJson(file);let accessToken=raw.auth?.accessToken;
        if(typeof accessToken==='object')accessToken=await runNativeHelper(await resolveWorkBuddyExecutable(account,this.config),accessToken);
        credential={accessToken,refreshToken:'',uid:String(raw.account?.uid??''),principal:String(raw.account?.uid??''),domain:raw.auth?.domain??'www.workbuddy.cn',expiresAtMs:raw.auth?.expiresAt??jwtClaims(accessToken??'').exp*1000,source:'desktop',filePath:file};
      }else if(account.platform==='trae') {
        const text=await readFile(file,'utf8');const raw=parseTraeStorageDocument(text);
        credential={accessToken:raw.token??raw.accessToken,refreshToken:'',userId:String(raw.userId??''),principal:String(raw.userId??''),host:raw.host??'',userRegion:raw.userRegion?.region??raw.userRegion,edition:account.edition??'cn',expiresAtMs:typeof raw.expiredAt==='string'?Date.parse(raw.expiredAt):(raw.expiredAt<1e12?raw.expiredAt*1000:raw.expiredAt),source:'desktop',filePath:file};
        credential.identity=await readTraeIdentity({path:file,edition:credential.edition,source:'desktop'});
      }else if(account.platform==='zcode') {
        const raw=await readJson(file);let token=raw.zcodejwttoken;
        if(token?.startsWith('enc:v1:')) {
          const [iv,tag,ct]=token.slice(7).split('.').map(v=>Buffer.from(v,'base64url'));
          const key=createHash('sha256').update(process.env.ZCODE_CREDENTIAL_SECRET??`zcode-credential-fallback:${process.platform}:${homedir()}:${userInfo().username}`).digest();
          try {const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);token=Buffer.concat([decipher.update(ct),decipher.final()]).toString('utf8');}finally{key.fill(0)}
        }
        const claims=jwtClaims(token??'');credential={accessToken:token,principal:String(claims.user_id??claims.sub??''),expiresAtMs:claims.exp*1000,source:'desktop',filePath:file};
        const nativeState=await readJson(join(dirname(file),'telemetry-state.json')).catch(()=>({}));credential.identity={deviceId:nativeState.deviceMid};
      }else if(account.platform==='qwenwork') {
        let raw=await decryptElectronJson(file,join(dirname(file),'Local State'));
        const owned=await readJson(join(this.config.dataDir,'accounts',account.id,'qwenwork-session.json')).catch(()=>null);
        if(owned?.sourceFingerprint===fingerprint&&Date.parse(owned.expiresAt)>Date.now())raw=owned;
        credential={accessToken:raw.token,principal:raw.user?.id,expiresAtMs:Date.parse(raw.expiresAt),user:raw.user,source:'desktop',filePath:file};
        if(raw.user?.isBiz!==false)throw new AppError('QwenWork account is not explicitly in personal mode; switch to 我的 AI 团队 in the client',409,'qwenwork_personal_scope_required');
        if(account.personalTeamId&&raw.user?.teamId!==account.personalTeamId)throw new AppError('QwenWork team differs from configured personalTeamId',409,'qwenwork_team_mismatch');
      }else throw new AppError('MiniMax needs persisted browser login state; no desktop credentials configured',401,'browser_login_required');
      if(typeof credential.accessToken!=='string'||!credential.accessToken||!credential.principal)throw new AppError('Credential lacks token or stable account identity',401,'invalid_credentials');
      rememberSecret(credential.accessToken);this.cache.set(account.id,{fingerprint,credential});
    }
    const binding=this.ledger.bind(account.id,account.platform,credential.principal);
    if(!binding.ok)throw new AppError('Desktop account changed; explicitly rebind this account before using it',409,'principal_changed');
    if(Number.isFinite(credential.expiresAtMs)&&credential.expiresAtMs<=Date.now())throw new AppError('Desktop token expired; reopen the client to renew login, then recheck',401,'credential_expired');
    return {...credential,principalHash:binding.fingerprint};
  }
  async refreshQwen(id) {
    const account=this.account(id);if(account.platform!=='qwenwork')throw new AppError('QwenWork account required',400,'invalid_account');
    const file=await resolveCredentialFile(account,this.config),info=await stat(file);
    const fingerprint=hash(JSON.stringify(account.credentials)+file+info.mtimeMs+info.size);
    const prior=await readJson(join(this.config.dataDir,'accounts',id,'qwenwork-session.json')).catch(()=>null);
    const raw=prior?.sourceFingerprint===fingerprint?prior:await decryptElectronJson(file,join(dirname(file),'Local State'));
    rememberSecret(raw.refreshToken);rememberSecret(raw.token);
    const renewed=await refreshQwenSession(raw);rememberSecret(renewed.token);rememberSecret(renewed.refreshToken);
    await atomicJson(join(this.config.dataDir,'accounts',id,'qwenwork-session.json'),{...renewed,sourceFingerprint:fingerprint});
    this.cache.delete(id);return this.read(account);
  }
  async doctor(id){try{const c=await this.resolve(id,{force:true});return {accountId:id,status:'credential_readable',principalHash:c.principalHash.slice(0,12),source:c.source,expiresAt:c.expiresAtMs?new Date(c.expiresAtMs).toISOString():null};}catch(e){return {accountId:id,status:'error',code:e.code??'credential_read_error',message:e.message};}}
}
