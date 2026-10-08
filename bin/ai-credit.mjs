#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {readFile,mkdir,open,rm,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initConfig,ConfigStore,projectRoot} from '../src/config.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {atomicJson,readJson,errorView} from '../src/util.mjs';
import {attachProjectMemory} from '../src/project-memory.mjs';
const args=process.argv.slice(2);const command=args.shift()??'help';
const option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const configFile=resolve(option('config',process.env.AI_CREDIT_CONFIG??join(projectRoot,'config.local.json')));
const emit=value=>console.log(JSON.stringify(value,null,2));
try {
  if(command==='help'){console.log('ai-credit init | serve | start | stop | doctor | health | claim | models | ui | install-autostart | uninstall-autostart\nOptions: --config <file> --account <id> --task <id>');}
  else if(command==='init'){await initConfig(configFile);const s=await createService(configFile);emit({initialized:true,configFile,keysFile:s.keysFile});await s.close();}
  else if(command==='start'){
    const c=new ConfigStore(configFile);await c.load();const runtimeFile=join(c.dataDir,'runtime.json');
    try{const state=await readJson(runtimeFile);const r=await fetch(state.baseUrl+'/health',{signal:AbortSignal.timeout(1500)});if(r.ok){emit({running:true,...state});process.exit(0)}}catch{}
    await mkdir(c.dataDir,{recursive:true});const log=await open(join(c.dataDir,'service.log'),'a');
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'serve','--config',configFile],{detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
    let state;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{state=await readJson(runtimeFile);if(state.pid===child.pid){const r=await fetch(state.baseUrl+'/health',{signal:AbortSignal.timeout(500)});if(r.ok)break;}}catch{}state=undefined;}
    if(!state)throw new Error('Background startup failed; inspect data/service.log');emit({started:true,...state});
  }else if(command==='serve'){
    const s=await createService(configFile);let runtime,stopping=false;
    const detachMemory=attachProjectMemory(s);
    const stop=async()=>{if(stopping)return;stopping=true;detachMemory();s.scheduler.stop();await runtime.close();await rm(join(s.config.dataDir,'runtime.json'),{force:true});await s.close();process.exit(0);};
    try{runtime=await startServer(s,{onShutdown:stop});}catch(e){await s.close();throw e;}
    await atomicJson(join(s.config.dataDir,'runtime.json'),{pid:process.pid,baseUrl:runtime.baseUrl,configFile});
    console.log(`GATEWAY_READY ${runtime.baseUrl} config=${configFile}`);s.scheduler.start();process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }else if(command==='stop'||command==='ui'){
    const c=new ConfigStore(configFile);await c.load();const state=await readJson(join(c.dataDir,'runtime.json'));const keys=await readJson(join(c.dataDir,'api-keys.json'));
    if(command==='stop'){const r=await fetch(state.baseUrl+'/admin/shutdown',{method:'POST',headers:{Authorization:`Bearer ${keys.adminKey}`},signal:AbortSignal.timeout(5000)});emit(await r.json());}
    else {throw new Error('Headless source package: build your own UI against docs/api.md');const url=state.baseUrl+'/#key='+encodeURIComponent(keys.adminKey);const [cmd,argv]=process.platform==='win32'?['powershell.exe',['-NoProfile','-Command',`Start-Process '${url.replaceAll("'","''")}'`]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];const child=spawn(cmd,argv,{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});emit({opened:true,baseUrl:state.baseUrl});}
  }else if(command==='install-autostart'||command==='uninstall-autostart'){
    if(process.platform!=='win32')throw new Error('Use docs/linux.md for systemd deployment');
    const ps=join(projectRoot,'scripts',command+'.ps1');const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',ps,'-ConfigFile',configFile,'-NodeExecutable',process.execPath],{windowsHide:true,stdio:'inherit'});child.on('exit',code=>process.exitCode=code??1);
  }else {
    const s=await createService(configFile);try {
      const id=option('account','workbuddy-main');
      if(command==='doctor'){const results=[];for(const a of s.config.value.accounts)results.push(a.enabled===false?{accountId:a.id,status:'disabled'}:await s.credentials.doctor(a.id));emit({results});if(results.some(r=>r.status==='error'))process.exitCode=1;}
      else if(command==='health')emit({accountId:id,...await s.platforms.health(id)});
      else if(command==='claim'){const r=args.includes('--all')?{results:await s.claims.all()}:await s.claims.run(id,option('task','daily-checkin'));emit(r);if(['error','uncertain','rejected','action_required'].includes(r.status))process.exitCode=1;}
      else if(command==='models')emit(await s.router.models());
      else if(command==='records')emit({records:s.ledger.records()});
      else throw new Error('Unknown command: '+command);
    }finally{await s.close();}
  }
}catch(e){emit({error:errorView(e)});process.exitCode=1;}
