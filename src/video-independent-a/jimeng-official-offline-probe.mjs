import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import {NATIVE_USER_AGENT} from './native-signers.mjs';
if(workerData?.userAgent!==undefined&&workerData.userAgent!==NATIVE_USER_AGENT)throw new Error('user_agent_mismatch');
const code=await readFile(new URL('./bdms-1.0.1.20.js',import.meta.url),'utf8');
if(createHash('sha256').update(code).digest('hex')!=='e8879f44c998afa417f8a28210df73698a9f1766f8cec4ec3877936c16becb15')throw new Error('sdk_hash_changed');
const captured=[];
const storageReads=new Set();
class Storage{constructor(){this.data=new Map();}getItem(k){storageReads.add(String(k));return this.data.get(k)??null;}setItem(k,v){this.data.set(k,String(v));}removeItem(k){this.data.delete(k);}clear(){this.data.clear();}}
class Element{
 constructor(tag){this.tagName=String(tag).toUpperCase();this.nodeName=this.tagName;this.children=[];this.childNodes=this.children;this.style={};this.dataset={};this.attrs={};this.classList={add(){},remove(){},contains(){return false;},toggle(){return false;}};}
 setAttribute(k,v){this.attrs[k]=String(v);this[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}appendChild(e){this.children.push(e);e.parentNode=this;return e;}removeChild(e){return e;}insertBefore(e){return this.appendChild(e);}addEventListener(t,f){if(t==='load')queueMicrotask(f);}removeEventListener(){}
 getContext(){return new Proxy({getImageData:()=>({data:new Uint8ClampedArray(4)}),measureText:()=>({width:1}),isPointInPath:()=>false},{get:(t,k)=>k in t?t[k]:()=>{}});}toDataURL(){return 'data:image/png;base64,eA==';}
}
class XHR{open(m,u){this.method=m;this.url=String(u);}setRequestHeader(){}send(){captured.push({kind:'xhr',url:this.url});this.readyState=4;this.status=200;this.responseText='{}';}addEventListener(){}removeEventListener(){}overrideMimeType(){}}
class Req{constructor(input,opt={}){this.url=String(input?.url||input);this.method=opt.method||'GET';this.headers=opt.headers||{};this.body=opt.body;}}
const head=new Element('head'),body=new Element('body'),html=new Element('html');head.parentNode=html;body.parentNode=html;
const document={cookie:'',referrer:'',head,body,documentElement:html,scripts:[],createElement:t=>new Element(t),createTextNode:t=>({nodeType:3,textContent:t,nodeValue:t,data:''}),createComment:t=>({nodeType:8,textContent:t}),getElementsByTagName:t=>t==='head'?[head]:t==='body'?[body]:[],getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],createEvent:()=>({initEvent(){}}),addEventListener(){},removeEventListener(){},dispatchEvent(){},write(){}};
const originalFetch=async(input,opt={})=>{captured.push({kind:'fetch',url:String(input?.url||input),method:opt.method||input?.method||'GET',body:opt.body});return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>'{}',json:async()=>({})};};
const sandbox={document,Document:function(){},HTMLDocument:function(){},Element,HTMLElement:Element,HTMLCanvasElement:Element,DOMTokenList:function(){},NodeList:Array,HTMLCollection:Array,CSSRuleList:Array,CSSStyleDeclaration:function(){},Storage,localStorage:new Storage(),sessionStorage:new Storage(),XMLHttpRequest:XHR,Request:Req,Headers,fetch:originalFetch,URL,URLSearchParams,TextEncoder,TextDecoder,
 navigator:{userAgent:NATIVE_USER_AGENT,language:'zh-CN',languages:['zh-CN'],platform:'Win32',plugins:[1],mimeTypes:[1],hardwareConcurrency:8,webdriver:false},
 location:new URL('https://jimeng.jianying.com/ai-tool/generate?type=image&workspace=0'),performance:{now:()=>Date.now(),timing:{},getEntriesByType:()=>[],mark(){},measure(){}},screen:{width:1920,height:1080,availWidth:1920,availHeight:1080,colorDepth:24,pixelDepth:24},devicePixelRatio:1,
 atob:x=>Buffer.from(x,'base64').toString('binary'),btoa:x=>Buffer.from(x,'binary').toString('base64'),setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,requestAnimationFrame:f=>setTimeout(()=>f(Date.now()),16),cancelAnimationFrame:clearTimeout,
 MutationObserver:class{constructor(f){this.observe=()=>queueMicrotask(f);this.disconnect=()=>{};}},Event:class{constructor(t){this.type=t;}},console:{log(){},warn(){},error(){}},addEventListener(){},removeEventListener(){},dispatchEvent(){}};
Object.assign(sandbox,{window:sandbox,self:sandbox,globalThis:sandbox,top:sandbox,parent:sandbox});
// SAMPLE only; a production vault must supply the user's authorized runtime state.
const cookieTokenOnly=process.argv.includes('--cookie-token-only');
if(cookieTokenOnly)document.cookie='msToken=SAMPLE_COOKIE_MS_TOKEN_1234567890';
else sandbox.localStorage.setItem('xmst',workerData?.securityState?.xmst||'SAMPLE_AUTHORIZED_RUNTIME_STATE');
if(workerData?.securityState?.web_runtime_security_uid)sandbox.localStorage.setItem('web_runtime_security_uid',workerData.securityState.web_runtime_security_uid);
if(workerData?.securityState?.msuuid)sandbox.localStorage.setItem('__msuuid__',workerData.securityState.msuuid);
const timer=setTimeout(()=>{process.stdout.write(JSON.stringify({ok:false,code:'offline_probe_timeout',actualHttpRequests:0})+'\n');process.exit(2);},8000);timer.unref();
try{
 vm.runInContext(code,vm.createContext(sandbox),{timeout:5000,filename:'pinned-bdms.js'});
 if(sandbox.fetch===originalFetch||!sandbox.bdms)throw new Error('official_hook_missing');
 sandbox.bdms.init({aid:513695,pageId:28324,paths:['/commerce/v1/benefits/credit_receive'],track:{mode:2}});
 await new Promise(r=>setTimeout(r,50));
 const target=workerData?.url||'https://jimeng.jianying.com/commerce/v1/benefits/credit_receive?aid=513695&device_platform=web&region=cn';
 if(new URL(target).origin!=='https://jimeng.jianying.com'||new URL(target).pathname!=='/commerce/v1/benefits/credit_receive')throw new Error('path_denied');
 await sandbox.fetch(target,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({time_zone:'Asia/Shanghai'})});
 await new Promise(r=>setTimeout(r,50));
 const signed=captured.find(x=>x.kind==='fetch'&&new URL(x.url,'https://jimeng.jianying.com').pathname==='/commerce/v1/benefits/credit_receive');
 const url=signed&&new URL(signed.url),msTokenLength=url?.searchParams.get('msToken')?.length||0,aBogusLength=url?.searchParams.get('a_bogus')?.length||0;
 if(parentPort)parentPort.postMessage({ok:msTokenLength>0&&aBogusLength>0,url:signed?.url,body:{time_zone:'Asia/Shanghai'},userAgent:sandbox.navigator.userAgent});else process.stdout.write(JSON.stringify({ok:msTokenLength>0&&aBogusLength>0,msTokenLength,aBogusLength,cookieTokenOnly,tokenEqualsCookie:url?.searchParams.get('msToken')==='SAMPLE_COOKIE_MS_TOKEN_1234567890',storageReads:[...storageReads],urlSha256:signed?createHash('sha256').update(signed.url).digest('hex'):null,capturedRequests:captured.length,actualHttpRequests:0,browserProcessesUsed:0,authenticatedServerValidation:false,userAgent:sandbox.navigator.userAgent})+'\n');process.exit(msTokenLength>0&&aBogusLength>0?0:1);
}catch(e){if(parentPort)parentPort.postMessage({ok:false,code:'native_signer_failed'});else process.stdout.write(JSON.stringify({ok:false,code:String(e.message).slice(0,120),stack:String(e.stack).split('\n').slice(0,4),actualHttpRequests:0})+'\n');process.exit(1);}
