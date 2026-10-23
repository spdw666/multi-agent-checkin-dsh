import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname, resolve, isAbsolute} from 'node:path';
import {homedir} from 'node:os';
export class AppError extends Error {
  constructor(message, status = 500, code = 'internal_error') {super(message); this.status = status; this.code = code;}
}
export const hash = text => createHash('sha256').update(Buffer.isBuffer(text)?text:String(text)).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
const knownSecrets = new Set();
export function rememberSecret(value) {if (typeof value === 'string' && value.length > 5) knownSecrets.add(value); return value;}
export function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  // Match against the original text: replacing a prefix first can otherwise
  // hide a longer or overlapping secret from subsequent redaction passes.
  const ranges=[];
  for (const secret of knownSecrets) {
    let start=text.indexOf(secret);
    while(start!==-1){ranges.push([start,start+secret.length]);start=text.indexOf(secret,start+1);}
  }
  if(ranges.length){
    ranges.sort((a,b)=>a[0]-b[0]||b[1]-a[1]);
    const merged=[];
    for(const range of ranges){const last=merged.at(-1);if(last&&range[0]<last[1])last[1]=Math.max(last[1],range[1]);else merged.push(range);}
    const parts=[];let cursor=0;
    for(const [start,end] of merged){parts.push(text.slice(cursor,start),'[REDACTED]');cursor=end;}
    parts.push(text.slice(cursor));text=parts.join('');
  }
  return text.replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[JWT]');
}
export const errorView = e => ({code: e.code ?? 'upstream_error', message: redact(e.message ?? String(e)).slice(0, 500), status: e.status ?? 502});
export function localPath(value, base) {
  const expanded = String(value).replace(/^~(?=[\\/]|$)/, homedir()).replace(/%([^%]+)%/g,(_,key)=>process.env[key]??`%${key}%`);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base,expanded);
}
export async function readJson(file) {return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}
export async function atomicJson(file, value) {
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temp = file + '.' + secret().slice(0,8) + '.tmp';
  await writeFile(temp, JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(temp,file);
}
const dayFormatters=new Map(),dayFormatterLimit=32;
export function dayIn(date = new Date(), timezone = 'Asia/Shanghai') {
  // Cache formatters, not dates: midnight and DST transitions remain live.
  // Non-string inputs retain Intl's coercion semantics and are not retained.
  let formatter=typeof timezone==='string'?dayFormatters.get(timezone):undefined;
  if(!formatter){
    formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
    if(typeof timezone==='string'){
      if(dayFormatters.size>=dayFormatterLimit)dayFormatters.delete(dayFormatters.keys().next().value);
      dayFormatters.set(timezone,formatter);
    }
  }
  return formatter.format(date);
}
export async function jsonFetch(url, {headers, body, method = body === undefined ? 'GET' : 'POST', signal, successCodes=[0,'0',200,'200'], ...options} = {}) {
  const r = await fetch(url,{...options,method,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal??AbortSignal.timeout(30000),redirect:'error'});
  let data;try{data=await r.json();}catch{throw new AppError(`HTTP ${r.status}: expected JSON`,r.ok?502:r.status,'invalid_upstream_response');}
  if(data===null)throw new AppError(`HTTP ${r.status}: expected non-null JSON`,r.ok?502:r.status,'invalid_upstream_response');
  if(!r.ok)throw new AppError(`HTTP ${r.status}: ${redact(data.message??data.msg??data.error?.message??'upstream rejected request')}`,r.status,'upstream_http_error');
  if(data.code!==undefined && !successCodes.includes(data.code))throw new AppError(`Business ${data.code}: ${redact(data.msg??data.message??'request rejected')}`,502,'business_error');
  return data;
}
