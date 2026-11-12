// 一次性导入 Vidu 会话：从浏览器 DevTools 的 cURL 或直接粘贴的 Cookie 串写入本机 vault。
//
// 为什么需要这个脚本：Edge/Chrome 的 HttpOnly cookie 用 App-Bound Encryption（v20）加密，
// DPAPI 解不出明文，所以网关无法在后台自动取到浏览器里的新会话。
// 浏览器里的会话还有效、网关里的快照已经过期时，就用这个脚本重新灌一次。
//
// 用法：
//   node scripts/import-vidu-session.mjs --cookie-file <包含 cURL 或 cookie 串的文件> --config <config.local.json>
//   node scripts/import-vidu-session.mjs --cookie "JWT=...; SSUID=...; Shunt=..." --config <config.local.json>
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ConfigStore} from '../src/config.mjs';
import {writeVideoSessionVault,verifyVideoSessionIdentity} from '../src/video-session-vault.mjs';

// Shunt 在 vidu 侧通常是空值 cookie，而 parseCookieString 会丢掉空值，
// 所以它不能进必填名单，下面单独补一条空值占位。
const KEEP=['JWT','SSUID'];
const parseCookieString=raw=>{
  const text=String(raw??'');
  // cURL 里是 -H 'cookie: a=b; c=d'；DevTools 里是裸的 a=b; c=d。
  const header=/cookie:\s*([^\r\n'"]+)/i.exec(text);
  const body=header?header[1]:text;
  const pairs=[];
  for(const part of body.split(';')){
    const i=part.indexOf('=');
    if(i<1)continue;
    const name=part.slice(0,i).trim();
    const value=part.slice(i+1).trim();
    if(name&&value)pairs.push({name,value});
  }
  const seen=new Map();
  for(const p of pairs)if(!seen.has(p.name))seen.set(p.name,p);
  return [...seen.values()];
};
const jwtExpiry=value=>{
  try{
    const payload=JSON.parse(Buffer.from(String(value).split('.')[1],'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp)?payload.exp:null;
  }catch{return null;}
};

export async function importViduSession({configFile,rawCookie}){
  const config=new ConfigStore(resolve(configFile));
  await config.load();
  const account=config.value.accounts.find(a=>a.platform==='vidu'&&a.enabled!==false);
  if(!account)throw new Error('配置里没有启用中的 vidu 账号');
  const file=config.path(account.credentials?.file??'');
  if(!file)throw new Error('vidu 账号没有 credentials.file');

  const pairs=parseCookieString(rawCookie);
  const wanted=pairs.filter(p=>KEEP.includes(p.name));
  const missing=KEEP.filter(n=>!wanted.some(p=>p.name===n));
  if(missing.length)throw new Error('缺少认证 cookie: '+missing.join(', ')+'（拿到的：'+pairs.map(p=>p.name).join(', ')+'）');

  const exp=jwtExpiry(wanted.find(p=>p.name==='JWT').value);
  const shunt=pairs.find(p=>p.name==='Shunt')??{name:'Shunt',value:''};
  const cookies=[...wanted,shunt].map(p=>({
    name:p.name,
    value:p.value,
    domain:'.service.vidu.cn',
    path:'/',
    secure:true,
    httpOnly:true,
    sameSite:'lax',
    ...(exp?{expirationDate:exp}:{})
  }));
  const session={platform:'vidu',origin:'https://www.vidu.cn',cookies};

  const identity=await verifyVideoSessionIdentity(session);
  const saved=await writeVideoSessionVault(file,session,{principal:identity.principal,expectedPrincipalHash:identity.principalHash});
  return {
    file,
    principal:identity.principal,
    state:saved.state,
    cookieNames:cookies.map(c=>c.name),
    sessionExpiresAt:exp?new Date(exp*1000).toISOString():null
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  const opt=name=>{const i=args.indexOf('--'+name);return i>=0?args[i+1]:undefined;};
  const configFile=opt('config');
  if(!configFile){console.error('Usage: node scripts/import-vidu-session.mjs --config CONFIG [--cookie "..." | --cookie-file PATH]');process.exitCode=2;}
  else{
    let rawCookie=opt('cookie');
    const cookieFile=opt('cookie-file');
    try{
      if(!rawCookie&&cookieFile)rawCookie=await readFile(resolve(cookieFile),'utf8');
      if(!rawCookie)throw new Error('需要 --cookie 或 --cookie-file');
      console.log(JSON.stringify(await importViduSession({configFile,rawCookie}),null,1));
    }catch(e){console.error(JSON.stringify({error:e.code??'import_failed',message:e.message}));process.exitCode=1;}
  }
}