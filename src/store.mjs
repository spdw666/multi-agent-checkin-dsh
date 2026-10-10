import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hash, errorView, redact} from './util.mjs';
export class Ledger {
  constructor(dir,{initializationTimeoutMs=5000}={}) {
    if(!Number.isInteger(initializationTimeoutMs)||initializationTimeoutMs<0||initializationTimeoutMs>60000)throw new RangeError('initializationTimeoutMs must be an integer between 0 and 60000');
    mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(dir,'gateway.sqlite'));
    const deadline=performance.now()+initializationTimeoutMs;
    const pause=new Int32Array(new SharedArrayBuffer(4));
    try {
      for(;;) {
        // WAL activation may return SQLITE_BUSY without invoking SQLite's busy handler.
        // Only idempotent initialization is replayed; never replay remote claims or writes.
        const remaining=Math.max(0,Math.floor(deadline-performance.now()));
        this.db.exec(`PRAGMA busy_timeout=${Math.min(100,remaining)}`);
        try {
          this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS bindings(account_id TEXT PRIMARY KEY, principal_hash TEXT NOT NULL, bound_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(key TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, time TEXT NOT NULL, day TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_calls(id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, account_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_account_time ON usage_calls(account_id,started_at);
      CREATE TABLE IF NOT EXISTS balance_observations(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, checked_at TEXT NOT NULL, unit TEXT NOT NULL, value REAL NOT NULL, previous_at TEXT, previous_value REAL);`);
          break;
        }catch(e) {
          const wait=deadline-performance.now();
          if(e.code!=='ERR_SQLITE_ERROR'||!Number.isInteger(e.errcode)||(e.errcode&255)!==5||wait<=0)throw e;
          Atomics.wait(pause,0,0,Math.min(10,wait));
        }
      }
      this.db.exec('PRAGMA busy_timeout=5000');
    }catch(e) {
      try{this.db.close();}catch{} // Preserve the original SQLite error on constructor failure.
      throw e;
    }
  }
  bind(accountId,platform,principal) {
    const fingerprint=hash(platform+'\0'+principal);const prior=this.db.prepare('SELECT principal_hash FROM bindings WHERE account_id=?').get(accountId);
    if(prior&&prior.principal_hash!==fingerprint)return {ok:false,reason:'principal_changed'};
    if(!prior)this.db.prepare('INSERT INTO bindings VALUES (?,?,?)').run(accountId,fingerprint,new Date().toISOString());
    return {ok:true,fingerprint};
  }
  principalHash(accountId){return this.db.prepare('SELECT principal_hash FROM bindings WHERE account_id=?').get(accountId)?.principal_hash;}
  unbind(accountId){this.db.prepare('DELETE FROM bindings WHERE account_id=?').run(accountId);}
  claimKey(platform,fingerprint,day,task,device=''){return hash([platform,fingerprint,day,task,device].join('\0'));}
  reserve(key,now=Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare('SELECT * FROM claims WHERE key=?').get(key);
      // 9074 is a temporary Trae congestion refusal, not a successful daily claim.
      // Also recover rows written by v8, which incorrectly made this refusal terminal.
      const priorResult=row?JSON.parse(row.result):{};
      const transientRejection=row?.status==='rejected'&&/9074|当前参与用户太多/.test(priorResult.error?.message??'');
      if(row&&['success','already','observed','rejected'].includes(row.status)&&!transientRejection){this.db.exec('COMMIT');return {acquired:false,done:true,status:row.status,result:priorResult};}
      if(row&&row.status==='running'&&now-Date.parse(row.updated_at)<300000){this.db.exec('COMMIT');return {acquired:false,done:false};}
      const uncertain=row?.status==='uncertain'||row?.status==='running';
      this.db.prepare('INSERT INTO claims VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at').run(key,'running',new Date(now).toISOString(),'{}');
      this.db.exec('COMMIT');return {acquired:true,uncertain};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  finish(key,status,result) {this.db.prepare('UPDATE claims SET status=?, updated_at=?, result=? WHERE key=?').run(status,new Date().toISOString(),redact(result),key);}
  record({day,platform,accountId,task,status,...result}) {this.db.prepare('INSERT INTO records(time,day,platform,account_id,task,status,result) VALUES (?,?,?,?,?,?,?)').run(new Date().toISOString(),day,platform,accountId,task,status,redact(result));}
  records({limit=100,accountId='',platform=''}={}) {return this.db.prepare("SELECT * FROM records WHERE (?='' OR account_id=?) AND (?='' OR platform=?) ORDER BY id DESC LIMIT ?").all(accountId,accountId,platform,platform,Math.min(Math.max(Number(limit)||100,1),1000)).map(r=>({...r,result:JSON.parse(r.result)}));}
  beginUsage(row) {return Number(this.db.prepare('INSERT INTO usage_calls(started_at,account_id,model,status,detail) VALUES (?,?,?,?,?)').run(row.startedAt,row.accountId??'',row.model??'','running',redact(row)).lastInsertRowid);}
  finishUsage(id,row) {this.db.prepare('UPDATE usage_calls SET status=?,detail=? WHERE id=?').run(row.status,redact(row),id);}
  usage({accountId='',model='',status='',from='',to='',beforeId=0,limit=100}={}) {
    const where="(?='' OR account_id=?) AND (?='' OR model=?) AND (?='' OR status=?) AND (?='' OR started_at>=?) AND (?='' OR started_at<=?)";
    const params=[accountId,accountId,model,model,status,status,from,from,to,to];
    const n=Math.min(Math.max(Number(limit)||100,1),500),cursor=Math.max(Number(beforeId)||0,0);
    const rows=this.db.prepare(`SELECT * FROM usage_calls WHERE ${where} AND (?=0 OR id<?) ORDER BY id DESC LIMIT ?`).all(...params,cursor,cursor,n+1);
    const more=rows.length>n;rows.length=Math.min(rows.length,n);
    const total=this.db.prepare(`SELECT COUNT(*) AS total FROM usage_calls WHERE ${where}`).get(...params).total;
    return {records:rows.map(r=>({...JSON.parse(r.detail),id:r.id,status:r.status})),total,nextBeforeId:more?rows.at(-1).id:null,source:'gateway',note:'仅记录启用此功能后的网关调用；不包含客户端绕过网关的调用。耗时为请求耗时，非人工会话时长。'};
  }
  observeBalance(row) {
    if(row.stale||row.error||typeof row.value!=='number'||!Number.isFinite(row.value))return;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const prev=this.db.prepare('SELECT * FROM balance_observations WHERE account_id=? ORDER BY id DESC LIMIT 1').get(row.accountId);
      if(!prev||prev.unit!==row.unit||prev.value!==row.value)this.db.prepare('INSERT INTO balance_observations(account_id,checked_at,unit,value,previous_at,previous_value) VALUES (?,?,?,?,?,?)').run(row.accountId,row.checkedAt,row.unit,row.value,prev?.unit===row.unit?prev.checked_at:null,prev?.unit===row.unit?prev.value:null);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  balanceChanges(accountId,limit=100) {return this.db.prepare('SELECT * FROM balance_observations WHERE account_id=? ORDER BY id DESC LIMIT ?').all(accountId,Math.min(Math.max(Number(limit)||100,1),500)).map(r=>({...r,change:r.previous_value===null?null:r.value-r.previous_value,source:'平台余额核验差额，包含窗口内全部消费、领取及到期，不能归因单次请求'}));}
  get(key){const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;}
  set(key,value){this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  close(){this.db.close();}
}
