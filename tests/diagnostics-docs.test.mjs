import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=name=>readFile(new URL('../'+name,import.meta.url),'utf8');
test('diagnostics guide distinguishes gateway and client completion with private metadata excluded',async()=>{const s=await read('docs/diagnostics-and-readiness.md');for(const term of ['completion.gatewayRequest','toolExecution','clientTurn','unknown','提示词','完整账号','TLS'])assert.ok(s.includes(term),term);});
test('preview and route CAS guide preserve complete request and current configuration',async()=>{const s=await read('docs/diagnostics-and-readiness.md');for(const term of ['/admin/route-preview','expectedTargets','409 configuration_changed','不覆盖其他账号','不将请求裁剪','新鲜度'])assert.ok(s.includes(term),term);});
test('readiness and daily check-in guide do not infer runtime or today from disk and old data',async()=>{const s=await read('docs/diagnostics-and-readiness.md');for(const term of ['/admin/client-activation','readOnly:true','不执行 `key_cmd`','直接加载证据','今日已签到','今日未签到','今日签到待核验','昨日数据'])assert.ok(s.includes(term),term);});
test('README links the new operation guide and retains existing stable chapters',async()=>{const s=await read('README.md');for(const term of ['docs/diagnostics-and-readiness.md','路由预演','接入生效检查','## 许可与致谢','## 本机数据、备份与回滚'])assert.ok(s.includes(term),term);});
test('Windows PowerShell 5 bundle gate does not rely on nested native argument quotes',async()=>{const s=await read('desktop/build.ps1');assert.ok(s.includes('split(/[.]/)'));assert.ok(s.includes('22.23.3'));});
