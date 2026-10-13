import test from'node:test';import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{mkdtemp,rm,copyFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{syncFleshOut,planFleshOutSync}from'../scripts/fleshout-sync.mjs';
const row=(id,model='live',n=8192)=>({id,model,max_tokens:n,provider:'custom',base_url:'http://127.0.0.1:19421/v1',api_key:'private-fixture'});
test('FleshOut plan clamps only exact managed rows and never restores disabled gateway models',()=>{
 const plan=planFleshOutSync({models:[row('aigw-live'),row('user-model'),{...row('aigw-external'),base_url:'https://example.invalid/v1'},row('aigw-stale','disabled')],config:[]},[{id:'live',maxTokens:4096}],{prune:true});
 assert.deepEqual(plan.changes.map(x=>x.action),['lower_output_budget','delete_stale']);assert.equal(JSON.stringify(plan).includes('private-fixture'),false);
 assert.throws(()=>planFleshOutSync({models:[],config:[]},[]),/catalog/);
 assert.equal(planFleshOutSync({models:[row('aigw-default','disabled')],config:[{value:JSON.stringify({defaultModelId:'aigw-default'})}]},[{id:'live',maxTokens:4096}],{prune:true}).changes.length,0);
});
test('FleshOut dry-run, consistent backup, exact transaction, copied rollback and concurrent-change rejection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fleshout-sync-')),file=join(dir,'source.db');const db=new DatabaseSync(file);
 db.exec('create table ai_models(id text primary key,model text,max_tokens integer,provider text,base_url text,api_key text);create table app_config(key text,value text);create table chapters(body text);');
 for(const r of [row('aigw-live'),row('aigw-stale','disabled'),row('external')])db.prepare('insert into ai_models values(?,?,?,?,?,?)').run(...Object.values(r));db.prepare('insert into app_config values(?,?)').run('ai_settings','{"defaultModelId":"aigw-live"}');db.prepare('insert into chapters values(?)').run('original prose');db.close();
 try{
 const options={dbFile:file,catalog:[{id:'live',maxTokens:4096}],prune:true,backupDir:join(dir,'private')};
 const before=await syncFleshOut(options);assert.equal(before.applied,false);assert.equal(before.changes.length,2);
 await assert.rejects(syncFleshOut({...options,apply:true,expectedFingerprint:'different'}),/concurrent change/);
 const applied=await syncFleshOut({...options,apply:true,expectedFingerprint:before.fingerprint});assert.equal(applied.modelCount,2);assert.equal(applied.configUnchanged,true);assert.equal(applied.backupQuickCheck,'ok');
 const restored=join(dir,'rollback-copy.db');await copyFile(applied.backupFile,restored);const check=new DatabaseSync(restored,{readOnly:true});try{assert.equal(check.prepare('select max_tokens from ai_models where id=?').get('aigw-live').max_tokens,8192);assert.equal(check.prepare('select count(*) n from ai_models').get().n,3);assert.equal(check.prepare('select body from chapters').get().body,'original prose');assert.equal(check.prepare('pragma quick_check').get().quick_check,'ok');}finally{check.close()}
 const unchanged=await syncFleshOut(options);assert.equal(unchanged.changes.length,0);
 }finally{await rm(dir,{recursive:true,force:true})}
});
