import {randomUUID} from 'node:crypto';
import {AppError,hash} from './util.mjs';

const TTL_MS=120000,HEARTBEAT_MS=15000;
const busy=()=>new AppError('另一个进程正在执行该 WB 任务',409,'wb_executor_busy');
const lost=()=>new AppError('WB 执行租约已失效，停止后续动作',409,'wb_executor_lease_lost');
const locked=error=>Number.isInteger(error?.errcode)&&[5,6].includes(error.errcode&255);
function parseLease(row){try{const value=JSON.parse(row?.value);return value&&typeof value.owner==='string'&&Number.isFinite(value.expiresAt)?value:null;}catch{return null;}}

// This lease coordinates genuine feature execution only. It does not authorize
// actions, replace pending-submission receipts, or replay uncertain operations.
// Every caller must use assertOwned immediately before actions/persistence.
export async function withWorkBuddyExecutorLease(service,key,work){
 const db=service?.ledger?.db;
 if(!db)return work(()=>{}); // Existing in-memory fixture ledgers stay disk-free.
 if(typeof key!=='string'||!key||key.length>4096||typeof work!=='function')throw new TypeError('A bounded lease key and callback are required');
 const metaKey='workbuddy.executor.lease:'+hash(key),owner=randomUUID();
 let transaction=false;
 try{
  db.exec('BEGIN IMMEDIATE');transaction=true;
  const row=db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey),prior=parseLease(row),now=Date.now();
  if(row&&(!prior||prior.expiresAt>now))throw busy();
  const value=JSON.stringify({version:1,owner,expiresAt:now+TTL_MS});
  db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(metaKey,value);
  db.exec('COMMIT');transaction=false;
 }catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}if(locked(error))throw busy();throw error;}
 let invalid=false,finished=false;
 const assertOwned=()=>{
  if(invalid||finished)throw lost();
  try{const lease=parseLease(db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey));if(!lease||lease.owner!==owner||lease.expiresAt<=Date.now()){invalid=true;throw lost();}}
  catch(error){invalid=true;if(error?.code==='wb_executor_lease_lost')throw error;throw lost();}
 };
 const heartbeat=()=>{
  if(invalid||finished)return;
  let renewing=false;
  try{
   db.exec('BEGIN IMMEDIATE');renewing=true;
   const row=db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey),lease=parseLease(row),now=Date.now();
   if(!lease||lease.owner!==owner||lease.expiresAt<=now){invalid=true;db.exec('ROLLBACK');renewing=false;return;}
   const value=JSON.stringify({...lease,expiresAt:now+TTL_MS});
   if(Number(db.prepare('UPDATE meta SET value=? WHERE key=? AND value=?').run(value,metaKey,row.value).changes)!==1)invalid=true;
   db.exec('COMMIT');renewing=false;
  }catch{invalid=true;if(renewing)try{db.exec('ROLLBACK');}catch{}}
 };
 const timer=setInterval(heartbeat,HEARTBEAT_MS);timer.unref?.();
 try{assertOwned();const result=await work(assertOwned);assertOwned();return result;}
 finally{
  finished=true;clearInterval(timer);
  // Compare both owner and unchanged serialized value; never erase a successor.
  try{const row=db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey);if(parseLease(row)?.owner===owner)db.prepare('DELETE FROM meta WHERE key=? AND value=?').run(metaKey,row.value);}catch{/* Closed DB or transient lock: expiry remains the recovery path. */}
 }
}
