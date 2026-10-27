import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {AppError} from './util.mjs';
const localQueues=new Map();
const error=()=>new AppError('本机会话写入互斥等待未完成',409,'video_session_vault_locked');
async function windowsMutex(file){
  const name='Local\\AICreditVideoVault_'+createHash('sha256').update(resolve(file).toLowerCase()).digest('hex');
  const command="$m=$null;$held=$false;try{$name=[Console]::In.ReadLine();$m=New-Object Threading.Mutex($false,$name);try{$held=$m.WaitOne(15000)}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){exit 73};[Console]::Out.WriteLine('OWNED');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{if($held){try{$m.ReleaseMutex()}catch{}};if($m){$m.Dispose()}}";
  return new Promise((res,rej)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',settled=false,released=false;
    const timer=setTimeout(()=>{child.kill();fail();},20000);
    const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);rej(error());};
    child.on('error',fail);child.stdin.on('error',fail);child.stderr.on('data',()=>{});child.on('close',()=>{if(!settled)fail();});
    child.stdout.on('data',b=>{output+=b;if(output.length>128){child.kill();return fail();}if(!settled&&/^OWNED\r?\n/.test(output)){settled=true;clearTimeout(timer);res({
      assertOwned(){if(released||child.exitCode!==null||child.signalCode!==null)throw error();},
      release(){if(released)return Promise.resolve();released=true;return new Promise(done=>{if(child.exitCode!==null)return done();const stop=setTimeout(()=>{child.kill();done();},2000);child.once('close',()=>{clearTimeout(stop);done();});child.stdin.end('RELEASE\n');});}
    });}});
    child.stdin.write(name+'\n');
  });
}
// Windows production uses an OS-owned named mutex shared by gateway/importer
// processes. Non-Windows DPAPI is unsupported; fixture crypto uses this local
// serialization only. The lock is cooperative, not a mandatory editor file lock.
export async function withVideoVaultWriteLock(file,callback){
  if(process.platform==='win32'){
    const lock=await windowsMutex(file);try{lock.assertOwned();return await callback(lock.assertOwned);}finally{await lock.release();}
  }
  const key=resolve(file),prior=localQueues.get(key)??Promise.resolve();let release;
  const gate=new Promise(r=>release=r),turn=prior.catch(()=>{}).then(()=>gate);localQueues.set(key,turn);
  await prior.catch(()=>{});try{return await callback(()=>{});}finally{release();if(localQueues.get(key)===turn)localQueues.delete(key);}
}
