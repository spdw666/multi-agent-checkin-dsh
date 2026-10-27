import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=process.env.VIDEO_SDK_CHECKOUT_TEST_ROOT?resolve(process.env.VIDEO_SDK_CHECKOUT_TEST_ROOT):fileURLToPath(new URL('../',import.meta.url));
const pinned={
 'src/video-independent-a/bdms-1.0.1.20.js':'e8879f44c998afa417f8a28210df73698a9f1766f8cec4ec3877936c16becb15',
 'src/video-independent-a/official-kling-node/vendor--kUVOohzB.js':'867036c16c019980aa928877ba3609ca9da5a00c87b3113a704eebbf9f175a56',
 'src/video-independent-a/official-kling-node/vendor-axios-D0P8VZOU.js':'75930e1268ee0ac50679ea29379c5d411cf61938918f22352152885353bfca98',
 'src/video-independent-a/official-kling-node/vendor-spark-md5-D9r9gH7o.js':'ec6115f08682959eac00164b25b46b7c865a911f209bccd630dfd7fbf6789e57'
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [file,expected]of Object.entries(pinned))test('official SDK raw bytes retain pinned SHA-256: '+file,async()=>{
 assert.equal(sha(await readFile(join(root,file))),expected);
});

// Reproduce Git's actual Windows checkout conversion using LF SAMPLE input
// stored under the exact SDK paths. No global Git config or real SDK is edited.
let fixture;
const git=(cwd,args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,`git ${args[0]} failed: ${r.stderr}`);return r.stdout;};
async function freshCheckout(){
 if(fixture)return fixture;
 fixture=(async()=>{
  const temp=await mkdtemp(join(tmpdir(),'video-sdk-checkout-'));
  const source=join(temp,'source'),checkout=join(temp,'checkout');await mkdir(source,{recursive:true});
  await writeFile(join(source,'.gitattributes'),await readFile(join(root,'.gitattributes')));
  const sample=Buffer.from('// SAMPLE exact signing SDK bytes\nexport const SAMPLE = 1;\n','utf8');
  for(const file of Object.keys(pinned)){await mkdir(dirname(join(source,file)),{recursive:true});await writeFile(join(source,file),sample);}
  git(source,['init','--quiet']);git(source,['-c','core.autocrlf=false','add','.']);
  git(source,['-c','user.name=SAMPLE','-c','user.email=sample@example.invalid','commit','--quiet','-m','SAMPLE SDK checkout fixture']);
  git(temp,['clone','--quiet','--no-checkout',source,checkout]);git(checkout,['-c','core.autocrlf=true','checkout','--quiet','--detach','HEAD']);
  return {temp,checkout,sample};
 })();return fixture;
}
for(const file of Object.keys(pinned))test('autocrlf=true fresh checkout preserves SDK bytes: '+file,async()=>{
 const f=await freshCheckout();assert.deepEqual(await readFile(join(f.checkout,file)),f.sample);
 const attr=git(f.checkout,['check-attr','text','--',file]);assert.match(attr,/: text: unset\s*$/);
});
test.after(async()=>{if(fixture){const {temp}=await fixture;const base=resolve(tmpdir())+sep,absolute=resolve(temp);assert.ok(absolute.startsWith(base)&&absolute.includes('video-sdk-checkout-'));await rm(absolute,{recursive:true,force:true});}});

for(const kind of ['jimeng','kling'])test(kind+' pinned official worker signs offline after checkout',async()=>{
 const {signNativeRequest}=await import(pathToFileURL(join(root,'src/video-independent-a/native-signers.mjs')).href);
 const input=kind==='jimeng'?{url:'https://jimeng.jianying.com/commerce/v1/benefits/credit_receive?aid=513695&device_platform=web&region=cn',securityState:{xmst:'SAMPLE_AUTHORIZED_RUNTIME_STATE'}}:{origin:'https://klingai.com',path:'/api/account/pointAndTicket',query:{scope:'PERSONAL'}};
 const signed=await signNativeRequest(kind,input),url=new URL(signed.url);
 assert.ok(url.searchParams.get(kind==='jimeng'?'a_bogus':'__NS_hxfalcon'));
});
