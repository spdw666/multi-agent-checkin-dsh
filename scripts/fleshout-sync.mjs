import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,mkdir,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const hash=x=>createHash('sha256').update(x).digest('hex');
const state=db=>({models:db.prepare('select * from ai_models order by id').all(),config:db.prepare('select * from app_config order by rowid').all()});
export const fleshoutFingerprint=value=>hash(JSON.stringify(value));
export function planFleshOutSync(snapshot,catalog,{baseUrl='http://127.0.0.1:19421/v1',prune=false}={}){
 if(!Array.isArray(catalog)||!catalog.length||catalog.some(m=>typeof m?.id!=='string')||new Set(catalog.map(m=>m.id)).size!==catalog.length)throw Error('Invalid or empty live catalog');
 const changes=[],skipped=[];const references=JSON.stringify(snapshot.config);const byId=new Map(catalog.map(m=>[m.id,m]));
 for(const row of snapshot.models){
  if(!row.id.startsWith('aigw-')||row.provider!=='custom'||row.base_url!==baseUrl)continue;
  const model=byId.get(row.model);
  if(!model){if(prune&&!references.includes(JSON.stringify(row.id).slice(1,-1)))changes.push({id:row.id,model:row.model,action:'delete_stale'});else skipped.push({id:row.id,reason:'stale_preserved_or_referenced_default'});continue;}
  if(Number.isSafeInteger(model.maxTokens)&&model.maxTokens>0&&Number.isSafeInteger(row.max_tokens)&&row.max_tokens>model.maxTokens)changes.push({id:row.id,model:row.model,action:'lower_output_budget',before:row.max_tokens,after:model.maxTokens});
 }
 return {fingerprint:fleshoutFingerprint(snapshot),changes,skipped};
}
export async function syncFleshOut({dbFile,catalog,baseUrl,prune=false,apply=false,backupDir,expectedFingerprint}){
 const source=new DatabaseSync(dbFile,{readOnly:true});let snapshot,plan,backupFile,backupHash;
 try{
  snapshot=state(source);plan=planFleshOutSync(snapshot,catalog,{baseUrl,prune});
  if(expectedFingerprint&&expectedFingerprint!==plan.fingerprint)throw Error('FleshOut concurrent change; original approval fingerprint differs');
  if(!apply||!plan.changes.length)return {...plan,applied:false};
  if(!backupDir)throw Error('Private backup directory required');await mkdir(backupDir,{recursive:true});
  backupFile=join(backupDir,'fleshout-'+Date.now()+'-'+randomUUID()+'.db');await backup(source,backupFile);await chmod(backupFile,0o600);
  const copy=new DatabaseSync(backupFile,{readOnly:true});try{if(copy.prepare('pragma quick_check').get().quick_check!=='ok'||fleshoutFingerprint(state(copy))!==plan.fingerprint)throw Error('Backup consistency check failed');}finally{copy.close()}
  backupHash=hash(await readFile(backupFile));
 }finally{source.close()}
 const db=new DatabaseSync(dbFile);try{
  db.exec('pragma busy_timeout=5000;BEGIN IMMEDIATE');
  if(fleshoutFingerprint(state(db))!==plan.fingerprint)throw Error('FleshOut concurrent change; transaction aborted');
  for(const c of plan.changes){const result=c.action==='delete_stale'?db.prepare('delete from ai_models where id=?').run(c.id):db.prepare('update ai_models set max_tokens=? where id=?').run(c.after,c.id);if(result.changes!==1)throw Error('Unexpected mutation count');}
  db.exec('COMMIT');const after=state(db);
  return {...plan,applied:true,backupFile,backupHash,backupQuickCheck:'ok',afterFingerprint:fleshoutFingerprint(after),modelCount:after.models.length,configUnchanged:JSON.stringify(after.config)===JSON.stringify(snapshot.config)};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1]};
 const catalog=JSON.parse(await readFile(get('--catalog'),'utf8'));
 const result=await syncFleshOut({dbFile:get('--db'),catalog:catalog.data??catalog.models??catalog,apply:args.includes('--apply'),prune:args.includes('--prune-stale'),backupDir:get('--backup-dir'),expectedFingerprint:get('--expected-fingerprint')});console.log(JSON.stringify(result,null,2));
}
