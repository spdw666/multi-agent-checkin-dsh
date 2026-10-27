import {createServer} from 'node:http';
import {timingSafeEqual,randomBytes,createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {validateVideoSessionImport,writeVideoSessionVault,verifyVideoSessionIdentity} from './video-session-vault.mjs';

const extensionId='ppbanlmjmecbeffacgjghocjbcfmaifk';
const origin=`chrome-extension://${extensionId}`;
const equals=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const shape=v=>v&&typeof v==='object'&&!Array.isArray(v);
const platforms=new Set(['jimeng','kling','xiaoyunque','vidu','hailuo','pixverse','liblib']);
const publicCodes=new Set(['local_import_save_failed','video_session_invalid','video_session_identity_pending','video_session_identity_contract_pending','video_session_official_auth_rejected','video_session_identity_invalid','video_session_identity_ambiguous','video_session_token_missing','video_session_principal_changed','video_session_write_conflict','video_session_crypt_failed','video_session_response_too_large','video_session_expired','video_session_vault_locked','daily_entitlement_contract_pending','daily_source_contract_pending']);
const safeCode=(code,fallback)=>publicCodes.has(code)?code:fallback;
const receiptResults=rows=>rows.filter(r=>platforms.has(r?.platform)).map(r=>({platform:r.platform,state:['verified','pending-direct-verification','error'].includes(r.state)?r.state:'pending-direct-verification',status:r.state==='verified'?'verified':r.state==='error'?'rejected':'pending',...(/^[a-f0-9]{64}$/.test(r.principalHash??'')?{principalHash:r.principalHash}:{}),...(r.code?{code:safeCode(r.code,'video_session_identity_pending')}:{})}));
export async function createVideoSessionImportServer({vaultDir,verifiedFiles={},port=19422,key=randomBytes(32).toString('base64url'),onboardingPath:resumedPath,expiresInMs=600000,now=()=>Date.now(),crypt,verifyIdentity=verifyVideoSessionIdentity,deferVerification=false}={}){
  if(!vaultDir||!Number.isInteger(port)||port<0||port>65535||typeof key!=='string'||key.length<32||!Number.isFinite(expiresInMs)||expiresInMs<=0||expiresInMs>1800000)throw new Error('invalid local import settings');
  const expiresAt=now()+expiresInMs;let used=false,active=false,armedUntil=0;
  const armToken=randomBytes(24).toString('base64url');
  if(resumedPath!==undefined&&!/^\/onboarding\/[A-Za-z0-9_-]{24}$/.test(resumedPath))throw new Error('invalid local onboarding path');
  const onboardingPath=resumedPath??'/onboarding/'+randomBytes(18).toString('base64url');
  const results=[];let verification=Promise.resolve();
  const verifyItem=async item=>{
    const index=results.findIndex(r=>r.platform===item.platform);
    try{
      const destination=verifiedFiles[item.platform]??join(vaultDir,item.platform+'.verified.json');
      let expectedSourceHash=null;
      try{if((await stat(destination)).size>2097152)throw Object.assign(new Error(),{code:'video_session_response_too_large'});expectedSourceHash=createHash('sha256').update(await readFile(destination)).digest('hex');}catch(e){if(e.code!=='ENOENT')throw e;}
      const identity=await verifyIdentity(item);
      const saved=await writeVideoSessionVault(destination,item,{principal:identity.principal,expectedPrincipalHash:identity.principalHash,expectedSourceHash,crypt});
      results[index]=saved;
    }catch(e){results[index]={platform:item.platform,state:'pending-direct-verification',code:safeCode(e.code,'video_session_identity_pending')};}
  };
  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(req.headers.origin===origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{})});res.end(JSON.stringify(value));};
    const host=req.headers.host,expectedHost=`127.0.0.1:${server.address()?.port}`;
    if(req.socket.remoteAddress!=='127.0.0.1'||host!==expectedHost)return send(403,{code:'local_import_host_invalid'});
    if(req.url===onboardingPath&&req.method==='GET'){
      if(used||now()>=expiresAt)return send(410,{code:'local_import_authorization_expired'});
      const nonce=randomBytes(16).toString('base64');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,'Referrer-Policy':'no-referrer'});
      return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AI积分网关：一次性本机会话连接</title><style>body{font:18px system-ui;max-width:780px;margin:48px auto;line-height:1.8;padding:20px}button{font:inherit;padding:12px 20px}input{display:block;width:95%;margin:18px 0;padding:10px}</style><h1>一次性连接7站登录态</h1><p>授权仅用于即梦、可灵、小云雀、Vidu、海螺、PixVerse、Liblib 当前登录站点。登录态只经127.0.0.1写入本机Windows当前用户加密文件；日常签到由网关直连执行。</p><ol><li>在Edge扩展页重新加载“AI积分网关 · 一次性本机会话导入”。</li><li>点击下方“开启本次连接”，无需复制连接码。</li><li>打开扩展弹窗，勾选说明，点击“本机加密导入”并确认临时权限。</li></ol><button id="arm">开启本次连接（5分钟）</button><p id="result">尚未开启。此按钮只开放本次导入，不启动日常浏览器任务。</p><details><summary>高级：手动连接码</summary><input id="key" type="password" readonly value="${key}"><button id="copy">复制一次性连接码</button></details><script nonce="${nonce}">document.getElementById('arm').onclick=async()=>{const b=document.getElementById('arm');b.disabled=true;try{const r=await fetch('${onboardingPath}/arm',{method:'POST',headers:{'X-AI-Credit-Onboarding':'${armToken}'},cache:'no-store'});if(!r.ok)throw new Error();document.getElementById('result').textContent='已开启5分钟。现在打开扩展，勾选后点击本机加密导入；不需要复制或填写连接码。'}catch{document.getElementById('result').textContent='本次连接待核对，请刷新本机页面后重试。'}finally{b.disabled=false;}};document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('key').value);document.getElementById('result').textContent='已复制手动连接码。'}catch{document.getElementById('key').select();}};</script></html>`);
    }
    if(req.url===onboardingPath+'/arm'&&req.method==='POST'){
      if(req.headers.origin!==`http://${expectedHost}`||!equals(req.headers['x-ai-credit-onboarding'],armToken))return send(403,{code:'local_import_arm_invalid'});
      if(used||now()>=expiresAt)return send(410,{code:'local_import_authorization_expired'});
      req.resume();armedUntil=Math.min(expiresAt,now()+300000);return send(200,{ok:true,expiresAtMs:armedUntil});
    }
    if(req.url==='/health'&&req.method==='GET')return send(200,{status:'ready',mode:'one-time-import-only',browserDailyDependency:false,used,armed:!used&&now()<armedUntil,expiresAt,results});
    const isSession=req.url==='/v1/import-session';
    if(req.url!=='/v1/imports'&&!isSession)return send(404,{code:'not_found'});
    if(req.headers.origin!==origin)return send(403,{code:'local_import_origin_invalid'});
    if(req.method==='OPTIONS'){
      const method=req.headers['access-control-request-method'];if(!(isSession?['GET','POST']:['POST']).includes(method))return send(405,{code:'local_import_method_invalid'});
      res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':method,'Access-Control-Allow-Headers':'Authorization,Content-Type,X-Edge-Daily-Extension','Access-Control-Max-Age':'0','Vary':'Origin','Cache-Control':'no-store'});return res.end();
    }
    if(isSession){
      if(!['GET','POST'].includes(req.method))return send(405,{code:'local_import_method_invalid'});
      if(req.headers['x-edge-daily-extension']!==extensionId||now()>=expiresAt)return send(401,{code:'local_import_confirmation_required'});
      req.resume();
      if(used)return send(401,{ok:true,alreadyImported:true,code:'local_import_already_used',version:1,results:receiptResults(results)});
      if(now()>=armedUntil)return send(401,{code:'local_import_confirmation_required'});
      return send(200,{importKey:key,extensionId,expiresAtMs:armedUntil});
    }
    if(req.method!=='POST')return send(405,{code:'local_import_method_invalid'});
    if(now()>=expiresAt||!equals(req.headers.authorization,`Bearer ${key}`)||req.headers['x-edge-daily-extension']!==extensionId)return send(401,{code:'local_import_authorization_invalid'});
    if(used){req.resume();return send(401,{ok:true,alreadyImported:true,code:'local_import_already_used',version:1,results:receiptResults(results)});}
    if(active)return send(401,{code:'local_import_authorization_invalid'});
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{code:'local_import_json_required'});
    active=true;let body;
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>524288){active=false;send(413,{code:'local_import_body_too_large'});req.resume();return;}chunks.push(chunk);}
      body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!shape(body)||Object.keys(body).some(k=>!['version','imports'].includes(k))||body.version!==1||!Array.isArray(body.imports)||body.imports.length<1||body.imports.length>7)throw new Error();
      const seen=new Set();body.imports=body.imports.map(item=>{const clean=validateVideoSessionImport(item);if(seen.has(clean.platform))throw new Error();seen.add(clean.platform);return clean;});
    }catch{active=false;return send(400,{code:'local_import_schema_invalid'});}
    used=true;armedUntil=0;
    try{
      const stagedItems=[];
      for(const item of body.imports){
        const staged=join(vaultDir,item.platform+'.pending.json');
        try{
          await writeVideoSessionVault(staged,item,{crypt});
          results.push({platform:item.platform,state:'pending-direct-verification'});stagedItems.push(item);
        }catch(e){results.push({platform:item.platform,state:'error',code:safeCode(e.code,'local_import_save_failed')});}
      }
      // MV3 receives its acknowledgement after local encryption, before any
      // potentially slow official request. Nothing here needs a live browser.
      if(deferVerification){
        send(200,{ok:true,version:1,results:receiptResults(results)});
        verification=Promise.all(stagedItems.map(verifyItem));
        return;
      }
      verification=Promise.all(stagedItems.map(verifyItem));await verification;
      return send(200,{ok:true,version:1,results:receiptResults(results)});
    }finally{active=false;body=null;}
  });
  server.headersTimeout=10000;server.requestTimeout=30000;server.timeout=30000;server.maxHeadersCount=30;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,key,expiresAt,onboardingPath,address:server.address(),get results(){return structuredClone(results);},get verification(){return verification;},close:async()=>{await verification;return new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
