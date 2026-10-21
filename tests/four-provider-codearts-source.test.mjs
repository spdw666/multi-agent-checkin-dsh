import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.CHECKIN_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {codeartsProvider}=await import(pathToFileURL(join(root,'src/provider-codearts.mjs')));

const SNAP_KEY = 'huaweicloud.codearts-snap';
const AUTH_KEY = 'secret://' + JSON.stringify({extensionId:'huaweicloud.authentication',key:'HuaweiCloudSession'});

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-codearts-source-'));
  const file = join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('create table ItemTable (key text primary key, value text)');
  db.prepare('insert into ItemTable values (?,?)').run(SNAP_KEY, JSON.stringify({userInfoKey:{originData:{accessKey:'fixture-ak',expiresAt:'2040-01-01T00:00:00Z'}}}));
  db.prepare('insert into ItemTable values (?,?)').run(AUTH_KEY, JSON.stringify({data:[1,2,3]}));
  db.close();
  const set = (key,value) => {
    const edit = new DatabaseSync(file);
    try {edit.prepare('insert or replace into ItemTable values (?,?)').run(key,value);}
    finally {edit.close();}
  };
  const version = (account={credentials:{file}},config={}) => {
    assert.equal(typeof codeartsProvider.credentialSourceVersion, 'function');
    return codeartsProvider.credentialSourceVersion(account,config);
  };
  try {await run({file,dir,set,version});}
  finally {await rm(dir,{recursive:true,force:true});}
}

test('CodeArts source version notices native login updates without resolving or modifying credentials',()=>fixture(async({file,set,version})=>{
  const before = await readFile(file), first = await version();
  assert.match(first,/^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(file),before);
  set(AUTH_KEY,JSON.stringify({data:[4,5,6]}));
  const second = await version();
  assert.notEqual(second,first);
  assert.equal(await version(),second);
}));

test('CodeArts native snap changes wake its blocked account even without secret storage',()=>fixture(async({file,set,version})=>{
  const db = new DatabaseSync(file);
  db.prepare('delete from ItemTable where key=?').run(AUTH_KEY);db.close();
  const first = await version();
  assert.match(first,/^[a-f0-9]{64}$/);
  set(SNAP_KEY,JSON.stringify({userInfoKey:{originData:{accessKey:'new-native-fixture',expiresAt:'2040-01-02T00:00:00Z'}}}));
  assert.notEqual(await version(),first);
}));

test('CodeArts unrelated SQLite rows do not manufacture login-state changes',()=>fixture(async({set,version})=>{
  const first = await version();
  set('workbench.editor.recentlyOpenedPathsList',JSON.stringify({entries:['fixture-project']}));
  assert.equal(await version(),first);
  set('workbench.editor.recentlyOpenedPathsList',JSON.stringify({entries:['another-fixture-project']}));
  assert.equal(await version(),first);
}));

test('CodeArts source version honors the resolver file/path/legacy reference precedence',()=>fixture(async({file,version})=>{
  let resolved = [];
  const config = {path(ref){resolved.push(ref);return file;}};
  const first = await version({credentials:{file:'primary-ref',path:'ignored-ref'},file:'ignored-legacy'},config);
  assert.equal(await version({credentials:{path:'path-ref'},file:'ignored-legacy'},config),first);
  assert.equal(await version({file:'legacy-ref'},config),first);
  assert.deepEqual(resolved,['primary-ref','path-ref','legacy-ref']);
}));

test('CodeArts automatic source selection uses the same native profile as resolve',()=>fixture(async({dir,file,version})=>{
  const old = process.env.APPDATA;
  const profile = join(dir,'codearts-agent','User','globalStorage');
  await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'state.vscdb'),await readFile(file));
  process.env.APPDATA = dir;
  try {
    const expected = await version();
    assert.equal(await version({credentials:{file:'auto'}}),expected);
    assert.equal(await version({}),expected);
  } finally {if(old===undefined)delete process.env.APPDATA;else process.env.APPDATA=old;}
}));

test('CodeArts unreadable or absent sources return null, never synthetic changing versions',()=>fixture(async({dir,version})=>{
  const absent = join(dir,'absent.vscdb');
  assert.equal(await version({file:absent}),null);
  assert.equal(await version({file:absent}),null);
  const malformed = join(dir,'malformed.vscdb');await writeFile(malformed,'not a database');
  assert.equal(await version({file:malformed}),null);
  assert.equal(await version({file:malformed}),null);
}));

test('CodeArts an empty native table is unknown rather than a new credential version',()=>fixture(async({file,version})=>{
  const db = new DatabaseSync(file);db.exec('delete from ItemTable');db.close();
  assert.equal(await version(),null);
  assert.equal(await version(),null);
}));
