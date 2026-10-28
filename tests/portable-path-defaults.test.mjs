import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {clipboardImagePaths} from '../src/transcript-memory.mjs';

function childMemoryRoot(override){
  const env={...process.env};if(override===undefined)delete env.AI_CREDIT_MEMORY;else env.AI_CREDIT_MEMORY=override;
  const moduleUrl=new URL('../src/model-audit.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {memoryRoot} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(memoryRoot));`],{env,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
}
test('memory defaults to the current user home, not an author-specific drive',()=>{
  assert.equal(childMemoryRoot(),join(homedir(),'.ai-credit-gateway','memory'));
});
test('portable instance memory override remains exact',()=>{
  const fixture=join(homedir(),'SAMPLE-portable','user-data','memory');assert.equal(childMemoryRoot(fixture),fixture);
});
test('empty override uses the generic user default instead of the cwd',()=>{
  assert.equal(childMemoryRoot(''),join(homedir(),'.ai-credit-gateway','memory'));
});
test('clipboard matching supports other usernames, drives, spaces and separators',()=>{
  const a=String.raw`C:\Users\SAMPLE USER\AppData\Local\Temp\codex-clipboard-abc-123.png`;
  const b='D:/Users/SAMPLE_TWO/AppData/Local/Temp/codex-clipboard-def-456.jpeg';
  assert.deepEqual(clipboardImagePaths('first '+a+' then '+b),[a,b]);
});
test('clipboard matching stays scoped to clipboard image temp files',()=>{
  assert.deepEqual(clipboardImagePaths('C:/Users/SAMPLE/Documents/private.png C:/Users/SAMPLE/AppData/Local/Temp/not-clipboard.png'),[]);
});
