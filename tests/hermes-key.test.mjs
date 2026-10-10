import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const helper = fileURLToPath(new URL('../scripts/hermes-key.mjs', import.meta.url));
function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-key-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, '本机 keys.json');
  fs.writeFileSync(file, content);
  return file;
}
const run = (...args) => spawnSync(process.execPath, [helper,...args], {encoding:'utf8',timeout:10000,windowsHide:true});
function rejected(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'AI credit gateway local credential unavailable\n');
}
test('Hermes helper reads apiKey only from a BOM file with spaces and Unicode path', t => {
  const file=fixture(t,'\uFEFF'+JSON.stringify({apiKey:'test-inference-only',adminKey:'test-admin-never-output'}));
  const r=run(file);
  assert.equal(r.status,0);assert.equal(r.stderr,'');
  assert.deepEqual(JSON.parse(r.stdout),{access_token:'test-inference-only',expires_in:65});
  assert.ok(!r.stdout.includes('test-admin-never-output'));
});
test('Hermes helper re-reads a rotated local credential', t => {
  const file=fixture(t,JSON.stringify({apiKey:'test-first'}));
  assert.equal(JSON.parse(run(file).stdout).access_token,'test-first');
  fs.writeFileSync(file,JSON.stringify({apiKey:'test-next'}));
  assert.equal(JSON.parse(run(file).stdout).access_token,'test-next');
});
test('Hermes helper rejects missing path', () => rejected(run()));
test('Hermes helper rejects missing file', t => rejected(run(fixture(t,'{}')+'.missing')));
test('Hermes helper suppresses malformed JSON contents', t => rejected(run(fixture(t,'{"apiKey":"test-secret-do-not-echo", broken'))));
test('Hermes helper never substitutes adminKey', t => rejected(run(fixture(t,JSON.stringify({adminKey:'test-admin-never-output'})))));
test('Hermes helper rejects an empty inference key', t => rejected(run(fixture(t,JSON.stringify({apiKey:''})))));
test('Hermes helper rejects whitespace in inference key', t => rejected(run(fixture(t,JSON.stringify({apiKey:'test-key\ninvalid'})))));
