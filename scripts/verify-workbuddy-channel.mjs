// Run after building and before packing. This is an offline artifact contract,
// not a provider request or a claim that future upstream rules stay unchanged.
import assert from 'node:assert/strict';
import {prepareChatBody} from '../vendor/workbuddy-core.mjs';

const source = 'You are an AI agent powered by DeepSeek Harness.\n'
  + 'Tokens prefixed with @ are paths the user explicitly referenced.\n'
  + 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.';
const input = {messages: [{role:'system',content:source},{role:'user',content:source}],
  tools:[{type:'function',function:{name:'SAMPLE_read',parameters:{type:'object',properties:{path:{type:'string'}}}}}],max_tokens:4096};
const result = JSON.parse(prepareChatBody(JSON.stringify(input)));
assert.match(result.messages[0].content,/powered by DeepSeek\./);
assert.match(result.messages[0].content,/Tokens starting with @/);
assert.match(result.messages[0].content,/Relative paths resolve from the project root/);
assert.equal(result.messages[1].content,source);
assert.deepEqual(result.tools,input.tools);
assert.equal(result.max_tokens,input.max_tokens);
console.log('WORKBUDDY_CHANNEL_ARTIFACT_OK system_adaptation=3 user_history_preserved=true tools_preserved=true');
