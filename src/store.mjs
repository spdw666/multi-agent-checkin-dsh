import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hash, errorView, redact} from './util.mjs';
export class Ledger {
  constructor(dir) {
    mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(dir,'gateway.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS bindings(account_id TEXT PRIMARY KEY, principal_hash TEXT NOT NULL, bound_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(key TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, time TEXT NOT NULL, day TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
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
  get(key){const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;}
  set(key,value){this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  close(){this.db.close();}
}
