import test from 'node:test';import assert from 'node:assert/strict';import {readFile,access} from 'node:fs/promises';import {join} from 'node:path';import {projectRoot} from '../src/config.mjs';
test('public desktop source has a portable native build and excludes local state',async()=>{
 const source=await readFile(join(projectRoot,'desktop/AiCreditDesktop.cs'),'utf8'),build=await readFile(join(projectRoot,'desktop/build.ps1'),'utf8'),ignore=await readFile(join(projectRoot,'desktop/.gitignore'),'utf8');
 assert.match(source,/class MainWindow/);assert.match(source,/class WbPoolBoard/);assert.match(build,/AI积分网关\.exe/);assert.match(build,/Microsoft\.NET/);assert.match(build,/BundleCore/);assert.match(build,/NATIVE_BUILD_OK/);assert.doesNotMatch(build,/[CD]:[\\/]Users[\\/]/i);
 for(const path of ['app-logo.png','app-logo-rounded.ico'])await access(join(projectRoot,'desktop',path));
 for(const value of ['desktop.local.json','runtime/','core/','*.exe'])assert.ok(ignore.includes(value));
});
