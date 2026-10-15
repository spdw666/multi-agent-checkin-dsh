import {watch} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {atomicJson} from './util.mjs';
import {memoryRoot} from './model-audit.mjs';
import {followVisibleTranscript} from './transcript-memory.mjs';
export function attachProjectMemory(service){
 let timer,stopped=false,saving=Promise.resolve(),stopTranscript=()=>{};
 void followVisibleTranscript().then(stop=>{if(stopped)stop();else stopTranscript=stop}).catch(()=>{});
 const update=()=>{saving=saving.then(async()=>{if(stopped)return;await mkdir(memoryRoot,{recursive:true});const c=service.config.value;
  await atomicJson(join(memoryRoot,'运行快照.json'),{updatedAt:new Date().toISOString(),configFile:service.config.file,accounts:c.accounts.map(a=>({id:a.id,platform:a.platform,enabled:a.enabled!==false,credentialMode:a.credentials?.kind??a.credentials?.mode})),upstreams:c.upstreams.map(({id,kind,accountId,enabled})=>({id,kind,accountId,enabled})),routes:c.routes,scheduler:c.scheduler});
  await writeFile(join(memoryRoot,'运行更新时间.txt'),new Date().toISOString()+'\n配置快照由后台监听更新；模型体检每完成一个模型即更新测试记录。\n','utf8');}).catch(()=>{});return saving;};
 void update();const watcher=watch(dirname(service.config.file),(event,file)=>{if(file&&String(file)!==basename(service.config.file))return;clearTimeout(timer);timer=setTimeout(()=>{void service.config.load().then(update).catch(()=>{})},250)});watcher.unref();return ()=>{stopped=true;clearTimeout(timer);watcher.close();stopTranscript();};
}
