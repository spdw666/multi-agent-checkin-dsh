import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStartPlanSystem,buildContextPrefixMessage,formatLocalIsoDate} from '../vendor/zcode-context/system-prompt.mjs';

// ZCode 3.17.1 对 start-plan 免费档模型做内容风控：system 数组必须恰好 3 块，
// 且块 0/块 1 与官方客户端 3.17.1 逐字节一致，否则 405/3012 "unusual activity"。
// 本测试只锁形状与固定文本，不联网、不读私有凭据。

const CLI_PREFIX='You are ZCode, an interactive agent';
const AGENT_PREFIX='\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized security testing, defensive security, ';

const env={cwd:'/workspace/sample',platform:'win32',shell:'powershell',osVersion:'10.0.26200'};

test('start-plan system is exactly 3 blocks with the 3.17.1 cli prefix',()=>{
 const system=buildStartPlanSystem(undefined,'glm-5.3-flash',env,'zai');
 assert.equal(system.length,3);
 assert.equal(system[0].text,CLI_PREFIX);
 assert.ok(system[1].text.startsWith(AGENT_PREFIX),'block 1 must keep the official agent prompt prefix');
 assert.ok(system[2].text.startsWith('\n\n'),'block 2 must keep the leading newlines of the dynamic section');
});

test('client system text never adds a fourth block',()=>{
 const bare=buildStartPlanSystem(undefined,'glm-5.3-flash',env,'zai');
 for(const existing of ['SAMPLE CLIENT SYSTEM',[{type:'text',text:'SAMPLE BLOCK'}],['SAMPLE STRING']]){
  const system=buildStartPlanSystem(existing,'glm-5.3-flash',env,'zai');
  assert.equal(system.length,3);
  assert.equal(system[0].text,bare[0].text);
  assert.equal(system[1].text,bare[1].text);
  assert.ok(system[2].text.startsWith(bare[2].text),'client text is appended to the dynamic block');
  assert.ok(system[2].text.includes('SAMPLE'));
 }
});

test('client blocks contribute only their text and no extra cache breakpoint',()=>{
 const system=buildStartPlanSystem([{type:'text',text:'SAMPLE FIRST',cache_control:{type:'ephemeral'}},{type:'text',text:'SAMPLE SECOND'}],'glm-5.3-flash',env,'zai');
 assert.equal(system.length,3,'client cache_control must not add a breakpoint block');
 assert.deepEqual(system.map(block=>block.cache_control?.type),['ephemeral','ephemeral','ephemeral']);
 assert.ok(system[2].text.endsWith('SAMPLE FIRST\n\nSAMPLE SECOND'));
});

test('empty or missing client system keeps the bare dynamic block',()=>{
 const bare=buildStartPlanSystem(undefined,'glm-5.3-flash',env,'zai');
 for(const empty of [undefined,null,'','   ',[],['   '],[{type:'text',text:'  '}]]){
  assert.equal(buildStartPlanSystem(empty,'glm-5.3-flash',env,'zai')[2].text,bare[2].text);
 }
});

test('the context prefix stays a leading user turn with the local date',()=>{
 const message=buildContextPrefixMessage(new Date(2026,9,31));
 assert.equal(message.role,'user');
 assert.equal(message.content.length,1);
 assert.match(message.content[0].text,/^<system-reminder>[\s\S]*<\/system-reminder>$/);
 assert.match(message.content[0].text,/Today's date is 2026-10-31\./);
 assert.equal(formatLocalIsoDate(new Date(2026,0,5)),'2026-01-05');
});
