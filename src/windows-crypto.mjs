import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createDecipheriv} from 'node:crypto';
import {AppError,readJson} from './util.mjs';
export function dpapiUnprotect(bytes) {
  if(process.platform!=='win32')throw new AppError('Windows desktop storage needs credentials exported for this host',401,'windows_storage_on_other_host');
  return new Promise((resolve,reject)=>{
    const command="Add-Type -AssemblyName System.Security; try { $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)) } catch { exit 1 }";
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',settled=false;
    const timer=setTimeout(()=>{child.kill();fail()},12000);const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);reject(new AppError('Desktop DPAPI decryption failed',401,'desktop_decrypt_failed'))};
    child.on('error',fail);child.stderr.on('data',()=>{});child.stdout.on('data',d=>{out+=d;if(out.length>131072){child.kill();fail()}});child.on('close',code=>{if(settled)return;if(code!==0)return fail();settled=true;clearTimeout(timer);resolve(Buffer.from(out,'base64'))});child.stdin.on('error',fail);child.stdin.end(bytes.toString('base64'));
  });
}
export async function decryptElectronJson(file,localState) {
  const bytes=await readFile(file);
  if(bytes[0]===0x7b)return JSON.parse(bytes.toString('utf8'));
  if(bytes.subarray(0,3).toString()!=='v10'&&bytes.subarray(0,3).toString()!=='v11')throw new AppError('Unknown Electron storage format',401,'unsupported_desktop_storage');
  const state=await readJson(localState);const wrapped=Buffer.from(state.os_crypt?.encrypted_key??'','base64');
  if(wrapped.subarray(0,5).toString()!=='DPAPI')throw new AppError('Unknown Electron key wrapping',401,'unsupported_desktop_storage');
  const key=await dpapiUnprotect(wrapped.subarray(5));let plain;
  try{const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(3,15));decipher.setAuthTag(bytes.subarray(-16));plain=Buffer.concat([decipher.update(bytes.subarray(15,-16)),decipher.final()]);return JSON.parse(plain.toString('utf8'));}finally{key.fill(0);plain?.fill(0)}
}
