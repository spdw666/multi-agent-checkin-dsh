import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {projectRoot} from './config.mjs';
import {AppError} from './util.mjs';
export function restartDsh({inspectOnly=false}={}){return new Promise((resolve,reject)=>{
 if(process.platform!=='win32'){reject(new AppError('Desktop restart currently targets Windows',400,'dsh_restart_platform'));return;}
 const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(projectRoot,'scripts/restart-dsh.ps1'),...(inspectOnly?['-InspectOnly']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';const timer=setTimeout(()=>{p.kill();reject(new AppError('DSH restart readiness timeout',504,'dsh_restart_timeout'));},40000);
 p.stdout.on('data',b=>out+=b);p.stderr.on('data',()=>{});p.on('error',()=>{clearTimeout(timer);reject(new AppError('DSH restart helper failed',502,'dsh_restart_error'))});p.on('close',code=>{clearTimeout(timer);try{const r=JSON.parse(out.trim());if(code!==0)throw Error();resolve(r);}catch{reject(new AppError('DSH restart failed; inspect desktop logs',502,'dsh_restart_error'))}});
});}
