import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {mkdir,copyFile,readFile,writeFile,access} from 'node:fs/promises';
import {ConfigStore,projectRoot} from '../src/config.mjs';
import {hash,atomicJson,readJson} from '../src/util.mjs';
import {syncDshCode} from './sync-dsh-code.mjs';
const args=process.argv.slice(2),i=args.indexOf('--config');const configFile=resolve(i<0?join(projectRoot,'config.local.json'):args[i+1]);
const cfg=new ConfigStore(configFile);await cfg.load();const profile=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'profiles/desktop');const backup=join(cfg.dataDir,'dsh-install');
await mkdir(backup,{recursive:true});const recordFile=join(backup,'record.json');
let record;try{record=await readJson(recordFile)}catch{}
if(!record){record={profile,packageName:'dsh-ai-credit-gateway',configFile,before:{},startedAt:new Date().toISOString()};for(const name of ['package.json','cordis.patch.yml','pnpm-lock.yaml']){try{const bytes=await readFile(join(profile,name));record.before[name]={exists:true,sha256:hash(bytes)};await writeFile(join(backup,name+'.original'),bytes,{mode:0o600});}catch(e){if(e.code!=='ENOENT')throw e;record.before[name]={exists:false};}}await atomicJson(recordFile,record);}
const child=spawn(process.execPath,['--expose-internals',join(projectRoot,'scripts/dsh-cli.mjs'),'plugin','--profile','desktop','add','file:'+projectRoot.replaceAll('\\','/')],{stdio:'inherit',windowsHide:true});
const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r)});if(code!==0){console.log('DSH_INSTALL_FAILED exit='+code+' backup='+backup);process.exit(code??1)}
const manifest=await readJson(join(profile,'package.json'));if(!manifest.dsh?.profile?.bundles?.includes(record.packageName))throw new Error('DSH did not activate the bundle in profile manifest');
console.log('DSH_CODE_VERIFIED '+JSON.stringify(await syncDshCode(join(profile,'node_modules',record.packageName))));
const patchFile=join(profile,'cordis.patch.yml');let patch=await readFile(patchFile,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e});
if(!patch.includes('# AI_CREDIT_GATEWAY_BEGIN')){patch+='\n# AI_CREDIT_GATEWAY_BEGIN\n- id: dsh-ai-credit-gateway\n  config:\n    configFile: '+JSON.stringify(configFile)+'\n# AI_CREDIT_GATEWAY_END\n';await writeFile(patchFile,patch,'utf8');}
record.after={};for(const name of ['package.json','cordis.patch.yml','pnpm-lock.yaml']){try{record.after[name]=hash(await readFile(join(profile,name)))}catch{}}
record.installedAt=new Date().toISOString();await atomicJson(recordFile,record);
console.log('DSH_BUNDLE_INSTALLED profile=desktop package=dsh-ai-credit-gateway config='+configFile+' rollbackRecord='+recordFile);
