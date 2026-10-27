import {mkdir,writeFile,chmod,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createVideoSessionImportServer} from '../src/video-session-import-server.mjs';
import {verifyVideoSessionIdentity} from '../src/video-session-vault.mjs';
const args=process.argv.slice(2);
function arg(name){const p=args.indexOf(name);if(p===-1||!args[p+1])throw new Error(`missing ${name}`);return resolve(args[p+1]);}
const dataDir=arg('--data-dir'),privateDir=arg('--private-dir');
const protocolA=args.includes('--protocol-a')?await import(pathToFileURL(arg('--protocol-a'))):null;
const protocolB=args.includes('--protocol-b')?await import(pathToFileURL(arg('--protocol-b'))):null;
const verifyIdentity=async session=>{
  if(['vidu','pixverse'].includes(session.platform))return verifyVideoSessionIdentity(session);
  let principal;
  if(['jimeng','kling'].includes(session.platform)&&protocolA){principal=(await protocolA.createIndependentDailyProvider(session.platform).verifyIdentity(session)).canonicalPrincipal;}
  else if(['xiaoyunque','hailuo','liblib'].includes(session.platform)&&protocolB){const provider=protocolB.createProvider(session);await provider.verifyIdentity({bind:true});principal=provider.getCredential().principal?.id;}
  else throw Object.assign(new Error(),{code:'video_session_identity_contract_pending'});
  if(typeof principal!=='string'||!principal)throw Object.assign(new Error(),{code:'video_session_identity_invalid'});
  return {principal,principalHash:createHash('sha256').update(session.platform+'\0'+principal).digest('hex')};
};
await mkdir(privateDir,{recursive:true,mode:0o700});
let resume={};
if(args.includes('--resume')){const prior=JSON.parse(await readFile(join(privateDir,'status.json'),'utf8'));resume={key:await readFile(join(privateDir,'IMPORT-KEY.txt'),'utf8'),onboardingPath:new URL(prior.onboardingUrl).pathname};}
const handle=await createVideoSessionImportServer({...resume,expiresInMs:1800000,vaultDir:join(dataDir,'video-sessions'),deferVerification:true,verifyIdentity,verifiedFiles:{vidu:join(dataDir,'accounts','vidu-video-daily','credential.json'),pixverse:join(dataDir,'accounts','pixverse-video-daily','credential.json')}});
const keyFile=join(privateDir,'IMPORT-KEY.txt');
await writeFile(keyFile,handle.key,{mode:0o600});await chmod(keyFile,0o600);
const status={mode:'one-time-import-only',port:handle.address.port,keyFile,onboardingUrl:`http://127.0.0.1:${handle.address.port}${handle.onboardingPath}`,expiresAt:handle.expiresAt,credentialsPrinted:false};
await writeFile(join(privateDir,'status.json'),JSON.stringify(status)+'\n',{mode:0o600});
console.log(JSON.stringify(status));
const timer=setTimeout(async()=>{await handle.close();process.exit(0);},1800000);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{clearTimeout(timer);await handle.close();process.exit(0);});
