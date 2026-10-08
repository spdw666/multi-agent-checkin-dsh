import {spawn} from 'node:child_process';
import {access,mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AppError,jsonFetch,rememberSecret,atomicJson} from './util.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function findBrowser() {
 const candidates=[process.env.AI_CREDIT_BROWSER,...(process.platform==='win32'?[join(process.env['ProgramFiles(x86)']??'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),join(process.env.ProgramFiles??'C:/Program Files','Microsoft/Edge/Application/msedge.exe')]:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'])];
 for(const path of candidates){if(!path)continue;try{await access(path);return path}catch{}}
 throw new AppError('Configure AI_CREDIT_BROWSER with an installed Chromium/Edge executable',503,'browser_missing');
}
export async function openBrowser(profile,url,{headless=true}={}) {
 await mkdir(profile,{recursive:true,mode:0o700});
 const active=join(profile,'DevToolsActivePort');await unlink(active).catch(()=>{});
 const child=spawn(await findBrowser(),[`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check',...(headless?['--headless=new']:[]),url],{windowsHide:headless,stdio:'ignore'});
 let launchError;child.on('error',e=>{launchError=e});child.unref();
 let port, pages;
 for(let i=0;i<120;i++){
  if(launchError||child.exitCode!==null)throw new AppError('Account browser profile is busy or browser startup failed',503,'browser_start_failed');
  await delay(250);
  try {port=Number((await readFile(active,'utf8')).split('\n')[0]);if(!(port>0&&port<65536))continue;const r=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)});pages=await r.json();if(pages.some(p=>p.type==='page'))break;}catch{}
 }
 const page=pages?.find(p=>p.type==='page');
 if(!page){try{child.kill()}catch{};throw new AppError('Account browser debugging channel did not start',503,'browser_start_failed')}
 const ws=new WebSocket(page.webSocketDebuggerUrl);let seq=0;const pending=new Map(),listeners=[];
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('CDP timeout')),10000);ws.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(t);reject(new Error('CDP connection failed'))},{once:true})});
 ws.addEventListener('message',event=>{let msg;try{msg=JSON.parse(event.data)}catch{return}const p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error('Browser command failed: '+msg.error.code)):p.resolve(msg.result)}else for(const listener of listeners)listener(msg)});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser command timeout'))},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
 return {call,onEvent:fn=>listeners.push(fn),evaluate:async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error('Browser script failed');return r.result?.value},async close(){try{await call('Browser.close')}catch{}ws.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Browser closed'))}pending.clear()}};
}
export function captchaHtml({sceneId,prefix,region}) {
 return `<!doctype html><meta charset="utf-8"><title>AI积分网关 · ZCode验证</title><h2>ZCode 官方验证</h2><p>请在此窗口完成官方验证。成功后程序会提交领取并记录服务端结果。</p><div id="cap"></div><button id="go">开始验证</button><script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script><script>window.claimValidation={};if(typeof initAliyunCaptcha==='function')initAliyunCaptcha({SceneId:${JSON.stringify(sceneId)},prefix:${JSON.stringify(prefix)},region:${JSON.stringify(region)},mode:'popup',language:'zh-cn',element:'#cap',button:'#go',getInstance:i=>{window.claimInstance=i;if(typeof i.startTracelessVerification==='function')i.startTracelessVerification();else window.claimValidation.challenge=true},success:r=>{window.claimValidation.param=typeof r==='string'?r:r.captchaVerifyParam},fail:e=>{window.claimValidation.challenge=true},onError:e=>{window.claimValidation.error=true}});else window.claimValidation.error=true;</script>`;
}
export async function zcodeValidation(profile,region,{fetchConfig=jsonFetch,timeout=45000,headless=true}={}) {
 const raw=await fetchConfig('https://zcode.z.ai/api/v1/client/configs?app_version=3.14.4&platform=win32-x64');
 const config=raw.data?.configs?.captcha;
 if(!config?.sceneId||!config?.prefix){const e=new AppError('ZCode verification configuration is incomplete',502,'zcode_validation_config_missing');e.beforeSubmission=true;throw e;}
 const path=join(profile,'verification.html');await mkdir(profile,{recursive:true});await writeFile(path,captchaHtml({...config,region}));
 let browser;
 try {
  browser=await openBrowser(profile,pathToFileURL(path).href,{headless});
  for(const end=Date.now()+timeout;Date.now()<end;){
   const state=await browser.evaluate('window.claimValidation || {}');
   if(state.param){rememberSecret(state.param);return state.param;}
   if(headless&&(state.challenge||state.error))break;
   await delay(1000);
  }
  throw new AppError('ZCode 官方验证要求交互；本次未提交领取请求',409,'zcode_validation_required');
 }catch(e){e.beforeSubmission=true;e.actionRequired=true;throw e;}finally{if(browser)await browser.close()}
}
export async function importMiniMaxSession(profile,file,{region='cn',timeout=300000}={}) {
 const origin=region==='intl'?'https://agent.minimax.io':'https://agent.minimax.cn';
 const browser=await openBrowser(profile,origin,{headless:false});let captured;
 try {
  browser.onEvent(msg=>{if(msg.method!=='Network.requestWillBeSent')return;let url;try{url=new URL(msg.params.request.url)}catch{return}if(url.origin!==origin||!url.pathname.startsWith('/minimax-cloud/api/'))return;const p=Object.fromEntries(url.searchParams);if(!p.token||!p.user_id||p.user_id==='0'||!p.uuid||!p.device_id)return;rememberSecret(p.token);const {token,user_id,...identity}=p;delete identity.unix;captured={access_token:token,principal:user_id,region,webIdentity:identity};});
  await browser.call('Network.enable');await browser.call('Page.reload');
  for(const end=Date.now()+timeout;Date.now()<end;){if(captured){await atomicJson(file,captured);return {imported:true,file,region};}await delay(1000)}
  throw new AppError('MiniMax 登录尚未完成；未保存凭据',401,'minimax_login_required');
 }finally{await browser.close()}
}
