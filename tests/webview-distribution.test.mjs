import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,relative,extname} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const shell=join(root,'desktop','webview-shell');
const text=file=>readFile(join(root,file),'utf8');
async function files(dir){const all=[];for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())all.push(...await files(p));else all.push(p);}return all;}
test('default WinForms builder remains separate from optional WebView2 build',async()=>{
  const native=await text('desktop/build.ps1'),optional=await text('scripts/build-webview-desktop.ps1');
  assert.ok(native.includes('AiCreditDesktop.cs'));assert.ok(!native.includes('webview-shell'));
  for(const marker of ['desktop/webview-shell','BundleCore','Portable','CoreDirectory','NativeSourceFile','BrandDirectory'])assert.ok(optional.includes(marker),marker);
});
test('WebView2 source includes runtime modules and no private deployment trees',async()=>{
  const all=await files(shell),names=all.map(p=>relative(shell,p).replaceAll('\\','/'));
  for(const required of ['host/GatewayWebViewHost.cs','ui/index.html','ui/styles.css','ui/app.js','ui/management.js','adapter/snapshot.mjs','adapter/control.mjs','adapter/management.mjs','adapter/management-contract.json','build.ps1','launch.ps1','package-portable.ps1'])assert.ok(names.includes(required),required);
  for(const name of names)assert.ok(!/(^|\/)(node_modules|user-data|data|profiles|deployment|qa|dist)(\/|$)|config\.local\.json$|\.sqlite(?:-|$)|\.log$|LIVE[-_].*\.png$/i.test(name),name);
});
test('portable first-run template contains no accounts, routes or enabled scheduler',async()=>{
  const config=JSON.parse((await readFile(join(shell,'portable','config.first-run.json'),'utf8')).replace(/^\uFEFF/,''));
  assert.deepEqual(config.accounts,[]);assert.deepEqual(config.upstreams,[]);assert.deepEqual(config.routes,[]);
  assert.equal(config.scheduler.enabled,false);assert.equal(config.scheduler.startup,false);assert.equal(config.server.host,'127.0.0.1');assert.equal(config.server.port,0);
});
test('published WebView2 text source contains no author-specific absolute user paths',async()=>{
  for(const file of await files(shell))if(['.cs','.mjs','.js','.html','.css','.json','.ps1','.cmd','.vbs','.md'].includes(extname(file).toLowerCase())){
    const body=await readFile(file,'utf8');assert.ok(!/[a-z]:[\\/]Users[\\/]ms(?:[\\/]|\b)|D:[\\/]AI Memory[\\/]/i.test(body),relative(shell,file));
  }
});
