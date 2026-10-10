import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../src/store.mjs';
// Resolve using URL directly: works with Windows drive letters, spaces and POSIX paths.
const ledgerImport=new URL('../src/store.mjs',import.meta.url).href;
const init=`import {Ledger} from ${JSON.stringify(ledgerImport)};`;
function child(source,dir) {
  const p=spawn(process.execPath,['--input-type=module','-e',source,dir],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',ready=false;
  p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>p.kill(),15000);
  const done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(code,signal)=>{clearTimeout(timer);code===0?resolve(stdout.trim()):reject(new Error(`worker failed code=${code} signal=${signal}\nstdout=${stdout}\nstderr=${stderr}`));});});
  // Mark rejections handled immediately; callers still receive the original promise failure.
  done.catch(()=>{});
  const started=new Promise((resolve,reject)=>{p.on('message',m=>{if(m==='READY'){ready=true;resolve();}});done.then(()=>{if(!ready)reject(Error('worker exited before READY'));},reject);});
  started.catch(()=>{});
  return {p,done,started};
}
async function fixture(fn) {
  const dir=await mkdtemp(join(tmpdir(),'credit-concurrency-'));const children=[];
  const start=source=>{const c=child(source,dir);children.push(c);return c;};
  try{return await fn(dir,start);}finally{for(const c of children)if(c.p.exitCode===null)c.p.kill();await Promise.allSettled(children.map(c=>c.done));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
}
const reserveSource=init+`process.send('READY');process.once('message',()=>{try{const l=new Ledger(process.argv[1]);try{const r=l.reserve('one-account-one-day');console.log(r.acquired?'ACQUIRED':'BUSY');}finally{l.close();}process.disconnect();}catch(e){console.error(JSON.stringify({phase:'initialize-or-reserve',code:e.code,errcode:e.errcode,message:e.message,stack:e.stack}));process.exitCode=1;process.disconnect();}});`;
async function reservations(dir,start,n=8) {
  const workers=Array.from({length:n},()=>start(reserveSource));await Promise.all(workers.map(c=>c.started));
  for(const c of workers)c.p.send('GO');
  const settled=await Promise.allSettled(workers.map(c=>c.done));
  const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  const results=settled.map(r=>r.value);
  assert.equal(results.filter(s=>s==='ACQUIRED').length,1);assert.equal(results.filter(s=>s==='BUSY').length,n-1);
}
test('cross-process SQLite reservation admits a single check-in worker',()=>fixture(async(dir,start)=>{
  const seed=new Ledger(dir);seed.close();await reservations(dir,start);
  const l=new Ledger(dir);try{assert.equal(l.db.prepare('SELECT count(*) AS n FROM claims').get().n,1);}finally{l.close();}
}));
test('SQLite cold-start initialization and reservation remain exclusive across processes',async()=>{
  const rounds=Number(process.env.SQLITE_STRESS_ROUNDS??10);assert.ok(Number.isInteger(rounds)&&rounds>=1&&rounds<=100);
  for(let i=0;i<rounds;i++)await fixture(reservations);
});
const lockSource=`import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';const db=new DatabaseSync(join(process.argv[1],'gateway.sqlite'));db.exec('CREATE TABLE IF NOT EXISTS seed(id);BEGIN IMMEDIATE');process.send('READY');process.once('message',()=>{db.exec('ROLLBACK');db.close();process.disconnect();});`;
test('SQLite initialization waits for a transient WAL activation lock',()=>fixture(async(dir,start)=>{
  const locker=start(lockSource);await locker.started;
  const attempt=start(init+`process.send('READY');const start=performance.now();const l=new Ledger(process.argv[1]);console.log(JSON.stringify({elapsed:performance.now()-start,mode:l.db.prepare('PRAGMA journal_mode').get().journal_mode,timeout:l.db.prepare('PRAGMA busy_timeout').get().timeout}));l.close();process.disconnect();`);
  await attempt.started;const timer=setTimeout(()=>locker.p.send('RELEASE'),200);
  try{const result=JSON.parse(await attempt.done);assert.ok(result.elapsed>=100);assert.equal(result.mode,'wal');assert.equal(result.timeout,5000);}finally{clearTimeout(timer);if(locker.p.connected)locker.p.send('RELEASE');}
  await locker.done;
}));
test('SQLite initialization timeout preserves busy error and closes its connection',()=>fixture(async(dir,start)=>{
  const locker=start(lockSource);await locker.started;const began=performance.now();
  assert.throws(()=>new Ledger(dir,{initializationTimeoutMs:80}),e=>e.code==='ERR_SQLITE_ERROR'&&(e.errcode&255)===5);
  const elapsed=performance.now()-began;assert.ok(elapsed>=60&&elapsed<1500);
  locker.p.send('RELEASE');await locker.done;
  // Windows unlink rejects an outstanding connection, so this also checks failure cleanup.
  await rm(join(dir,'gateway.sqlite'));const l=new Ledger(dir);l.close();
}));
test('SQLite non-lock initialization errors fail immediately and close connection',()=>fixture(async dir=>{
  const db=join(dir,'gateway.sqlite');await writeFile(db,Buffer.alloc(8192,0x78));const start=performance.now();
  assert.throws(()=>new Ledger(dir),e=>e.code==='ERR_SQLITE_ERROR'&&(e.errcode&255)===26);
  assert.ok(performance.now()-start<1500);await rm(db);
}));
test('SQLite initialization validates its bounded deadline',()=>fixture(async dir=>{
  for(const value of [-1,1.5,NaN,Infinity,60001,'100'])assert.throws(()=>new Ledger(dir,{initializationTimeoutMs:value}),RangeError);
  const l=new Ledger(dir,{initializationTimeoutMs:0});l.close();
}));
test('SQLite reopening keeps existing claims and usage rows intact',()=>fixture(async dir=>{
  const l=new Ledger(dir);l.reserve('preserved');l.finish('preserved','success',{ok:true});const id=l.beginUsage({startedAt:'2026-01-01',accountId:'fixture',model:'fixture'});l.finishUsage(id,{status:'completed'});l.close();
  const reopened=new Ledger(dir);try{assert.equal(reopened.reserve('preserved').acquired,false);assert.equal(reopened.usage().total,1);}finally{reopened.close();}
}));
test('SQLite child failure diagnostics preserve original error and exit code',()=>fixture(async(dir,start)=>{
  const c=start(`process.send('READY');console.error('SQLITE_DIAGNOSTIC_FIXTURE');process.exitCode=7;process.disconnect();`);
  await assert.rejects(c.done,e=>/code=7/.test(e.message)&&/SQLITE_DIAGNOSTIC_FIXTURE/.test(e.message));
}));
