import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root = process.env.WORKBUDDY_CHANNEL_TEST_ROOT
  ? resolve(process.env.WORKBUDDY_CHANNEL_TEST_ROOT)
  : fileURLToPath(new URL('..', import.meta.url));
const {prepareChatBody} = await import(pathToFileURL(join(root, 'vendor/workbuddy-core.mjs')));
const identity = 'You are an AI agent powered by DeepSeek Harness.';
const s1 = 'Tokens prefixed with @ are paths the user explicitly referenced.';
const s2 = 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.';
const sample = identity + '\n' + s1 + '\n' + s2;
const expected = 'You are an AI agent powered by DeepSeek.\nTokens starting with @ are paths the user explicitly referenced.\nRelative paths resolve from the project root; absolute paths identify files or directories on the host.';
const prepare = value => JSON.parse(prepareChatBody(JSON.stringify(value)));

for (const role of ['system', 'developer', ' SYSTEM ']) {
  test('known 11128 system fragments normalized for role ' + JSON.stringify(role), () => {
    const result = prepare({messages: [{role, content: sample}, {role: 'user', content: 'SAMPLE_USER'}]});
    assert.equal(result.messages[0].content, expected);
    assert.equal(result.messages[0].role, role === 'developer' ? 'system' : role);
  });
}

test('all occurrences of known fingerprints are normalized, not only the first', () => {
  const result = prepare({messages: [{role: 'system', content: sample + '\n' + sample}]});
  assert.equal(result.messages[0].content, expected + '\n' + expected);
});

test('system content parts preserve metadata and non-text parts', () => {
  const parts = [{type: 'text', text: sample, cache_control: {type: 'ephemeral'}}, {type: 'image_url', image_url: {url: 'data:image/png;base64,SAMPLE'}}, null, 7, {type: 'text', text: 12}];
  const original = structuredClone(parts);
  const result = prepare({messages: [{role: 'developer', content: parts}]});
  assert.deepEqual(result.messages[0], {role: 'system', content: [{...parts[0], text: expected}, ...parts.slice(1)]});
  assert.deepEqual(parts, original);
});

test('user assistant tool text and tool schemas are untouched even when they quote all fragments', () => {
  const messages = [{role: 'system', content: sample}, {role: 'user', content: sample}, {role: 'assistant', content: sample, tool_calls: [{id: 'call_SAMPLE', type: 'function', function: {name: 'SAMPLE_read', arguments: JSON.stringify({text: sample})}}]}, {role: 'tool', tool_call_id: 'call_SAMPLE', content: sample}];
  const tools = [{type: 'function', function: {name: 'SAMPLE_read', description: sample, parameters: {type: 'object', properties: {path: {type: 'string', description: sample}}}}}];
  const result = prepare({messages, tools});
  assert.deepEqual(result.messages.slice(1), messages.slice(1));
  assert.deepEqual(result.tools, tools);
});

test('unrelated system content and malformed payloads remain unchanged', () => {
  const messages = [{role: 'system', content: 'SAMPLE system mentions DeepSeek Harness, @ files, workspace root, but no known full fragment.'}, {role: 'user', content: ''}];
  assert.deepEqual(prepare({messages}).messages, messages);
  for (const source of ['not JSON', 'null', '[]', '7', '"SAMPLE"']) assert.equal(prepareChatBody(source), source);
});

test('normalization is idempotent and does not mutate the caller source', () => {
  const value = {messages: [{role: 'developer', content: [{type: 'text', text: sample}]}], model: 'SAMPLE_model', temperature: 0, max_tokens: 128000};
  const snapshot = structuredClone(value);
  const source = JSON.stringify(value);
  const once = prepareChatBody(source);
  assert.equal(prepareChatBody(once), once);
  assert.deepEqual(value, snapshot);
  assert.equal(source, JSON.stringify(snapshot));
});

test('360 tools, long history, tool results, output budget, and parameters survive adaptation', () => {
  const tools = Array.from({length: 360}, (_, i) => ({type: 'function', function: {name: 'SAMPLE_tool_' + i, description: 'SAMPLE schema '.repeat(80), parameters: {type: 'object', properties: {path: {type: 'string'}, nonce: {const: 'SAMPLE_nonce_' + i}}, required: ['path']}}}));
  const messages = [{role: 'system', content: sample + '\nSAMPLE_CONTEXT '.repeat(4800)}, ...Array.from({length: 50}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: 'SAMPLE_HISTORY_' + i + sample})), {role: 'assistant', content: null, tool_calls: [{id: 'call_SAMPLE', type: 'function', function: {name: 'SAMPLE_tool_0', arguments: '{"path":"SAMPLE"}'}}]}, {role: 'tool', tool_call_id: 'call_SAMPLE', content: 'SAMPLE_RESULT ' + sample}];
  const input = {model: 'SAMPLE_model', messages, tools, stream: true, max_tokens: 128000, reasoning_effort: 'max', temperature: 0, top_p: 1, stop: ['SAMPLE_STOP'], metadata: {nonce: 'SAMPLE_nonce'}, tool_choice: 'required'};
  const snapshot = structuredClone(input);
  const result = prepare(input);
  assert.equal(result.messages[0].content, expected + '\nSAMPLE_CONTEXT '.repeat(4800));
  assert.deepEqual(result.messages.slice(1), messages.slice(1));
  assert.deepEqual({...result, messages: []}, {...input, messages: []});
  assert.deepEqual(input, snapshot);
});

test('fresh build from tracked TypeScript retains the adaptation (update/rebuild regression)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-channel-build-'));
  try {
    const outfile = join(dir, 'workbuddy-core.mjs');
    await build({entryPoints: [join(root, 'vendor/workbuddy/entry.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22.23.3', legalComments: 'inline', logLevel: 'silent'});
    const built = await import(pathToFileURL(outfile));
    const source = JSON.stringify({messages: [{role: 'developer', content: sample}, {role: 'user', content: sample}], tools: [], max_tokens: 128000, reasoning_effort: 'max'});
    const result = JSON.parse(built.prepareChatBody(source));
    assert.equal(result.messages[0].content, expected);
    assert.equal(result.messages[1].content, sample);
    assert.equal(result.max_tokens, 128000);
    assert.equal(result.reasoning_effort, 'max');
  } finally { await rm(dir, {recursive: true, force: true, maxRetries: 5}); }
});
