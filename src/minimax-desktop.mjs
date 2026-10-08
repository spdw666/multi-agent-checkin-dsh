import net from 'node:net';
import {readFile,access} from 'node:fs/promises';
import {join,dirname,resolve,win32} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {AppError,readJson,rememberSecret} from './util.mjs';

// Independent client for the installed application's v1 local auth-lease protocol.
// No native implementation is distributed, and refresh tokens stay in the client's store.
export function miniMaxLeaseEndpoint(dataDir,platform=process.platform) {
  if(platform==='win32') {
    const canonical=win32.normalize(dataDir).replace(/[\\/]+$/,'');
    const digest=createHash('sha256').update(canonical.toLowerCase()).digest('hex').slice(0,16);
    return {endpoint:'\\\\.\\pipe\\mcode-auth-lease-'+digest,capabilityFile:win32.join(canonical,'run/mcode-auth-lease-v1.cap')};
  }
  return {endpoint:join(dataDir,'run/mcode-auth-lease-v1.sock'),capabilityFile:join(dataDir,'run/mcode-auth-lease-v1.cap')};
}
export async function requestMiniMaxLease(dataDir,{timeout=12000,endpoint:explicitEndpoint}={}) {
  const {endpoint,capabilityFile}=explicitEndpoint??miniMaxLeaseEndpoint(dataDir);
  const capability=(await readFile(capabilityFile,'utf8').catch(()=>{throw new AppError('MiniMax Code 登录续期服务尚未运行',401,'minimax_broker_unavailable')})).trim();
  if(!/^[A-Za-z0-9_-]{43}$/.test(capability))throw new AppError('MiniMax local lease capability has an invalid format',401,'minimax_broker_invalid');
  rememberSecret(capability);
  const requestId=randomUUID(),payload=Buffer.from(JSON.stringify({version:1,requestId,capability,method:'lease',minValidityMs:30000}));
  const frame=Buffer.alloc(4+payload.length);frame.writeUInt32BE(payload.length);payload.copy(frame,4);
  return new Promise((resolveLease,reject)=>{
    const socket=net.createConnection(endpoint);let bytes=Buffer.alloc(0),done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolveLease(value)};
    const fail=(code='minimax_broker_unavailable')=>finish(new AppError('MiniMax Code 本机登录续期服务返回 '+code,401,code));
    const timer=setTimeout(()=>fail(),timeout);
    socket.once('connect',()=>socket.write(frame));socket.on('error',()=>fail());socket.on('end',()=>{if(!done)fail()});
    socket.on('data',chunk=>{
      bytes=Buffer.concat([bytes,chunk]);if(bytes.length>65540)return fail('minimax_broker_invalid');
      if(bytes.length<4)return;const length=bytes.readUInt32BE(0);if(length<1||length>65536)return fail('minimax_broker_invalid');
      if(bytes.length<4+length)return;
      let r;try{r=JSON.parse(bytes.subarray(4,4+length).toString())}catch{return fail('minimax_broker_invalid')}
      if(r.version!==1||r.requestId!==requestId)return fail('minimax_broker_invalid');
      if(r.ok!==true)return fail(r.error?.code==='AUTH_REQUIRED'?'minimax_login_required':'minimax_broker_unavailable');
      const lease=r.result;
      if(lease?.method!=='lease'||lease.audience!=='agent-backend'||lease.scopes?.length!==1||lease.scopes[0]!=='agent.default'||typeof lease.accessToken!=='string'||!lease.accessToken||!Number.isSafeInteger(lease.generation)||!Number.isFinite(lease.expiresAtMs)||lease.expiresAtMs<=Date.now())return fail('minimax_broker_invalid');
      rememberSecret(lease.accessToken);finish(null,lease);
    });
  });
}
export function miniMaxRuntimeDir(account,config) {return account.credentials.runtimeDataDir?config.path(account.credentials.runtimeDataDir):resolve(process.env.MINIMAX_DATA_DIR??join(homedir(),'.minimax'));}
async function startNative(account,config) {
  const candidates=account.credentials.executable&&account.credentials.executable!=='auto'?[config.path(account.credentials.executable)]:[process.env.MINIMAX_CODE_EXE,'D:/MiniMax Code/MiniMax Code.exe',join(process.env.LOCALAPPDATA??homedir(),'Programs/MiniMax Code/MiniMax Code.exe')].filter(Boolean);
  for(const file of candidates)try{await access(file);const child=spawn(file,[],{windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();return true}catch{}
  return false;
}
export async function readMiniMaxDesktop(file,account,config,{leaseRequest=requestMiniMaxLease}={}) {
  const runtime=miniMaxRuntimeDir(account,config),region=account.region==='intl'?'intl':'cn';
  const raw=await readJson(file),service='com.minimax.mcode.oauth.prod.'+(region==='intl'?'en':'cn');
  const records=Object.entries(raw.records??{}).filter(([k,v])=>k.split('\0')[0]===service&&v.clientId==='mcode-public'&&v.audience==='agent-backend');
  if(records.length!==1)throw new AppError('MiniMax Code 本机登录态尚未就绪',401,'minimax_login_required');
  const stored=records[0][1];rememberSecret(stored.accessToken);rememberSecret(stored.refreshToken);
  let lease;
  try {lease=await leaseRequest(runtime)}catch(e){
    if(e.code==='minimax_login_required')throw e;
    if(stored.expiresAtMs>Date.now()+30000)lease=stored;
    else if(account.credentials.autoLaunch!==false&&await startNative(account,config)) {
      for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,1000));try{lease=await leaseRequest(runtime);break}catch{}}
    }
  }
  if(!lease)throw new AppError('MiniMax Code 登录态到期，客户端续期尚未完成',401,'minimax_refresh_pending');
  const profile=account.credentials.profileDir?config.path(account.credentials.profileDir):join(process.env.APPDATA??join(homedir(),'.config'),'MiniMax');
  const metadata=await readJson(join(profile,region==='intl'?'minimax-agent-en-config.json':'minimax-agent-cn-config.json'));
  const user=metadata.sharedUser??metadata.user,principal=String(user?.realUserID??'');
  if(!principal||!user.deviceID)throw new AppError('MiniMax Code 桌面账号信息缺少用户或设备标识',401,'minimax_identity_missing');
  return {accessToken:lease.accessToken,principal,expiresAtMs:lease.expiresAtMs,generation:lease.generation,region,authMode:'desktop-oauth',webIdentity:{device_id:user.deviceID,user_id:principal},source:'desktop-oauth',filePath:file};
}
