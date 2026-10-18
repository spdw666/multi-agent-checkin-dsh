import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {isAbsolute, join, dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {AppError, rememberSecret} from './util.mjs';

const invalid = () => new AppError('OpenCode 专用连接配置格式错误',400,'opencode_network_profile_invalid');
const cancelled = () => new AppError('请求取消或超时',499,'request_cancelled');
function origin(value) {
  if(typeof value!=='string'||!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value))throw invalid();
  const u=new URL(value);if(!u.port||+u.port<1024||+u.port>65535)throw invalid();return value;
}
export function validateNetworkProfile(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  for(const key of ['executable','proxyConfigFile','scratchDirectory','stateDirectory'])if(typeof value[key]!=='string'||!isAbsolute(value[key]))throw invalid();
  for(const key of ['proxyUrl','controllerUrl','serverUrl'])origin(value[key]);
  if(new Set([value.proxyUrl,value.controllerUrl,value.serverUrl]).size!==3)throw invalid();
  if(typeof value.controllerToken!=='string'||value.controllerToken.length<24)throw invalid();
  return {...value};
}
async function readProfile(file) {
  if(typeof file!=='string'||!isAbsolute(file))throw invalid();
  try{return validateNetworkProfile(JSON.parse(await readFile(file,'utf8')));}
  catch(error){if(error instanceof AppError)throw error;throw new AppError('OpenCode 专用连接配置待读取',503,'opencode_network_profile_unavailable');}
}
async function probeProxy(p) {
  const r=await fetch(p.controllerUrl+'/version',{headers:{authorization:'Bearer '+p.controllerToken},signal:AbortSignal.timeout(1000),redirect:'error'});
  if(r.status===401||r.status===403)throw new AppError('OpenCode 专用连接端口认证不匹配',503,'opencode_network_port_conflict');
  if(!r.ok)return false;const j=await r.json();return typeof j.version==='string'&&j.meta===true;
}
async function probeServer(p,c) {
  const r=await fetch(p.serverUrl+'/api/info',{headers:{authorization:'Basic '+Buffer.from('opencode:'+c.password).toString('base64')},signal:AbortSignal.timeout(1000),redirect:'error'});
  if(r.status===401||r.status===403)throw new AppError('OpenCode 专用服务端口认证不匹配',503,'opencode_network_port_conflict');
  if(!r.ok)return false;const j=await r.json();return typeof j.version==='string'&&Number.isSafeInteger(j.pid)&&j.pid>0;
}
async function launch(file,args,options,record) {
  const child=spawn(file,args,{...options,windowsHide:true,shell:false,detached:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new AppError('OpenCode 专用进程启动失败',503,'opencode_network_start_failed')));});
  child.unref();
  await mkdir(dirname(record),{recursive:true});
  await writeFile(record,JSON.stringify({pid:child.pid,executable:file,at:new Date().toISOString()},null,2)+'\n');
}
async function startProxy(p) {
  await launch(p.executable,['-d',dirname(p.proxyConfigFile),'-f',p.proxyConfigFile],{},join(p.stateDirectory,'proxy-process.json'));
}
async function startServer(p,c) {
  const configDirectory=join(p.scratchDirectory,'config');await mkdir(configDirectory,{recursive:true});
  const file=join(process.env.LOCALAPPDATA??'','Programs','@opencodedesktop','resources','opencode-cli.exe');
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(?:http|https|all|no)_proxy$/i.test(key)||/^OPENCODE_CONFIG(?:_|$)/.test(key))delete env[key];
  Object.assign(env,{HTTP_PROXY:p.proxyUrl,HTTPS_PROXY:p.proxyUrl,NO_PROXY:'127.0.0.1,localhost,::1',PWD:p.scratchDirectory,
    OPENCODE_SERVER_PASSWORD:c.password,OPENCODE_CONFIG_DIR:configDirectory,OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1'});
  // This is a separate official server, not a restart/reconfiguration of the user's shared service.
  await launch(file,['serve','--hostname','127.0.0.1','--port',new URL(p.serverUrl).port],{cwd:p.scratchDirectory,env},join(p.stateDirectory,'server-process.json'));
}
function forCaller(promise,signal) {
  if(!signal)return promise;if(signal.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(cancelled());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export function createNetworkOpenCodeService(adapters={}) {
  const read=adapters.readProfile??readProfile,proxy=adapters.probeProxy??probeProxy,server=adapters.probeServer??probeServer;
  const launchProxy=adapters.startProxy??startProxy,launchServer=adapters.startServer??startServer,pause=adapters.sleep??sleep;
  const flights=new Map();
  async function ready(probe,launch,p,c) {
    const check=async()=>{try{return await probe(p,c);}catch(e){if(e.code==='opencode_network_port_conflict')throw e;return false;}};
    if(await check())return;await launch(p,c);
    for(let i=0;i<60;i++){if(await check())return;await pause(150);}
    throw new AppError('OpenCode 专用连接启动后尚未就绪',503,'opencode_network_not_ready');
  }
  async function discover(service,credential) {
    const p=validateNetworkProfile(await read(service.networkProfile));rememberSecret(p.controllerToken);
    if(typeof credential?.password!=='string'||!credential.password)throw invalid();
    await ready(proxy,launchProxy,p,credential);await ready(server,launchServer,p,credential);
    return {...service,baseUrl:p.serverUrl};
  }
  return async function resolve(service,credential,{signal}={}) {
    if(signal?.aborted)throw cancelled();
    const key=service.networkProfile;
    if(typeof key!=='string'||!isAbsolute(key))throw invalid();
    // Do not share discovery across a changed password or a different caller profile.
    const flightKey=key+'\0'+credential?.password;
    if(!flights.has(flightKey)){
      const flight=discover(service,credential);flights.set(flightKey,flight);
      const clear=()=>{if(flights.get(flightKey)===flight)flights.delete(flightKey);};flight.then(clear,clear);
    }
    const found=await forCaller(flights.get(flightKey),signal);return {...service,baseUrl:found.baseUrl};
  };
}
export const resolveNetworkOpenCodeService=createNetworkOpenCodeService();
