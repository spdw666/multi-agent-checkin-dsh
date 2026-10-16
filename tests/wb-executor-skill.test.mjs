import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareWorkBuddyMarketSkill} from '../src/workbuddy-executor-skill.mjs';

async function fixture(t,overrides={}){
 const base=await mkdtemp(join(tmpdir(),'wb-market-skill-test-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const root=join(base,'isolated'),cwd=join(root,'workspace'),source=join(base,'installed','markitdown-skill');
 await mkdir(cwd,{recursive:true});await mkdir(join(source,'scripts'),{recursive:true});
 await writeFile(join(source,'SKILL.md'),'---\nname: markitdown-skill\nversion: 1.0.1\nallowed-tools: Read,Write,Bash,Glob\n---\nUse the genuine MarkItDown CLI.\n');
 await writeFile(join(source,'_skillhub_meta.json'),JSON.stringify({source:'marketplace',skillId:'skill_SAMPLE_42',version:'1.0.1',description:'original market metadata'}));
 await writeFile(join(source,'scripts','sample.py'),'# Entire original directory copy\n');
 const env={CODEBUDDY_AUTH_TOKEN:'SAMPLE_PRIVATE_TOKEN'},service={config:{dataDir:join(base,'data')},workbuddyRuntime:{}},args={service,root,cwd,env,sourceDirectory:source,dependencyProbe:async()=>({html:true,markitdown:'0.1.8'}),...overrides};
 return {base,root,cwd,source,env,service,args,prepare:()=>prepareWorkBuddyMarketSkill(args)};
}
const completed={valid:true,completedTools:[{name:'Skill'},{name:'Bash'},{name:'Read'}]};
async function writeOutput(prepared,text){await writeFile(prepared.feature.outputPath,text??'# '+prepared.feature.expectedText+'\n\nCollect, classify, and archive this local sample.\n\n* Input: HTML\n* Output: Markdown\n');}

test('copies the entire one original market skill with unchanged metadata and tree hashes',async t=>{
 const f=await fixture(t),original=await readFile(join(f.source,'_skillhub_meta.json'),'utf8'),p=await f.prepare();
 assert.equal(p.feature.skillId,'skill_SAMPLE_42');assert.equal(p.feature.skillVersion,'1.0.1');assert.equal(p.feature.fileCount,3);
 assert.equal(p.feature.originalTreeSha256,p.feature.copiedTreeSha256);
 assert.equal(await readFile(join(p.feature.installedDirectory,'_skillhub_meta.json'),'utf8'),original);
 assert.equal(await readFile(join(f.source,'_skillhub_meta.json'),'utf8'),original);
 assert.equal(await readFile(join(p.feature.installedDirectory,'scripts','sample.py'),'utf8'),'# Entire original directory copy\n');
 assert.equal(f.env.CODEBUDDY_SESSION_SKILL_DIRS,join(f.root,'config','skills'));
});
test('uses private dependency venv by default, never copies bearer into profile or fixture',async t=>{
 const f=await fixture(t),p=await f.prepare();
 assert.equal(p.feature.pythonExecutable,join(f.service.config.dataDir,'wb-executor-tools','python',process.platform==='win32'?'Scripts/python.exe':'bin/python'));
 assert.equal(p.feature.markitdownVersion,'0.1.8');assert.equal(f.env.CODEBUDDY_AUTH_TOKEN,'SAMPLE_PRIVATE_TOKEN');
 assert.ok(!JSON.stringify(p.feature).includes('SAMPLE_PRIVATE_TOKEN'));
 assert.ok(!(await readFile(p.feature.inputPath,'utf8')).includes('SAMPLE_PRIVATE_TOKEN'));
});
test('permission rules approve only the exact official conversion and selected Skill/Read paths',async t=>{
 const f=await fixture(t),p=await f.prepare();
 assert.deepEqual(p.permissionRules,['Skill(markitdown-skill)','Read('+p.feature.inputPath+')','Read('+p.feature.outputPath+')','Bash('+p.feature.command+')']);
 assert.ok(!p.permissionRules.includes('Bash'));assert.ok(!p.permissionRules.some(r=>r.includes('*')));
 assert.ok(p.prompt.includes(p.feature.command));assert.match(p.feature.command,/ -m markitdown /);
 assert.equal(f.env.CODEBUDDY_CODE_SHELL,process.platform==='win32'?'powershell':'sh');
 assert.equal(p.feature.command.startsWith('& '),process.platform==='win32');
});
test('preparation creates only sample HTML, not a fake converted output',async t=>{
 const f=await fixture(t),p=await f.prepare();assert.match(await readFile(p.feature.inputPath,'utf8'),/<h1>WB_MARKET_SAMPLE_/);
 await assert.rejects(readFile(p.feature.outputPath),{code:'ENOENT'});assert.deepEqual(p.args,[]);assert.ok(p.requireTool.test('Skill'));
});
test('each preparation uses fresh input/output names while retaining an identical skill copy',async t=>{
 const f=await fixture(t),a=await f.prepare(),b=await f.prepare();assert.notEqual(a.feature.outputPath,b.feature.outputPath);assert.notEqual(a.feature.expectedText,b.feature.expectedText);assert.equal(a.feature.copiedTreeSha256,b.feature.copiedTreeSha256);
});
test('verifies actual Skill, Bash, Read and independent output content, then records its digest',async t=>{
 const f=await fixture(t),p=await f.prepare();await writeOutput(p);assert.equal(await p.verifyResult(completed,{cwd:f.cwd}),true);assert.match(p.feature.outputSha256,/^[a-f0-9]{64}$/);assert.ok(p.feature.outputBytes>50);
});
test('accepts MarkItDown escaped underscores semantically while retaining original output bytes and hash',async t=>{
 const f=await fixture(t),p=await f.prepare();
 const escapedMarkdown='# '+p.feature.expectedText.replaceAll('_','\\_')+'\n\nCollect, classify, and archive this local sample.\n\n* Input: HTML\n* Output: Markdown\n';
 await writeOutput(p,escapedMarkdown);assert.equal(await p.verifyResult(completed,{cwd:f.cwd}),true);
 assert.equal(await readFile(p.feature.outputPath,'utf8'),escapedMarkdown);
 assert.equal(p.feature.outputSha256,createHash('sha256').update(escapedMarkdown).digest('hex'));
 assert.equal(p.feature.outputBytes,Buffer.byteLength(escapedMarkdown));
});
test('escaped Markdown still requires the actual unique marker and real successful tools',async t=>{
 const f=await fixture(t),p=await f.prepare();
 await writeOutput(p,'# WB\\_MARKET\\_SAMPLE\\_WRONG\n\nCollect, classify, and archive this local sample.\n');
 assert.equal(await p.verifyResult(completed),false);
 await writeOutput(p,'# '+p.feature.expectedText.replaceAll('_','\\_')+'\n\nCollect, classify, and archive this local sample.\n');
 assert.equal(await p.verifyResult({...completed,completedTools:[{name:'Skill'},{name:'Read'}]}),false);
});
test('rejects missing actual feature tools, failed execution and Write replacement',async t=>{
 const f=await fixture(t),p=await f.prepare();await writeOutput(p);
 for(const name of ['Skill','Bash','Read'])assert.equal(await p.verifyResult({...completed,completedTools:completed.completedTools.filter(tool=>tool.name!==name)}),false);
 assert.equal(await p.verifyResult({...completed,valid:false}),false);
 assert.equal(await p.verifyResult({...completed,completedTools:[...completed.completedTools,{name:'Write'}]}),false);
});
test('rejects missing, wrong, raw HTML, oversized or non-Markdown output',async t=>{
 const f=await fixture(t),p=await f.prepare();assert.equal(await p.verifyResult(completed),false);
 for(const text of ['# Wrong output\nCollect, classify, and archive this local sample.\n','<html><h1>'+p.feature.expectedText+'</h1>Collect, classify, and archive this local sample.</html>',p.feature.expectedText+'\nCollect, classify, and archive this local sample.\n','# '+p.feature.expectedText+'\n'+'x'.repeat(1024*1024)]){
  await writeOutput(p,text);assert.equal(await p.verifyResult(completed),false);
 }
});
test('rejects output readback under a different execution workspace',async t=>{
 const f=await fixture(t),p=await f.prepare();await writeOutput(p);assert.equal(await p.verifyResult(completed,{cwd:f.base}),false);
});
test('dependency missing does not install anything or submit a task',async t=>{
 const f=await fixture(t,{dependencyProbe:async()=>({html:false,markitdown:'0.1.8'})});await assert.rejects(f.prepare(),{code:'wb_skill_dependency_missing'});
});
test('runtime Python override is honored in a precisely quoted command',async t=>{
 const f=await fixture(t);f.service.workbuddyRuntime.executorPython=join(f.base,"Python user's tools",process.platform==='win32'?'python.exe':'python');const p=await f.prepare();assert.equal(p.feature.pythonExecutable,f.service.workbuddyRuntime.executorPython);assert.ok(p.feature.command.includes(process.platform==='win32'?"user''s":"user'\\''s"));
});
test('rejects relative Python and workspace escape',async t=>{
 const f=await fixture(t,{pythonExecutable:'python'});await assert.rejects(f.prepare(),{code:'wb_skill_python_missing'});
 f.args.pythonExecutable=join(f.base,'python');f.args.cwd=f.base;await assert.rejects(f.prepare(),{code:'wb_skill_workspace_invalid'});
});
test('requires actual marketplace identity and original metadata version',async t=>{
 const f=await fixture(t);
 for(const value of [{source:'custom',skillId:'SAMPLE',version:'1.0'},{source:'marketplace',version:'1.0'},{source:'marketplace',skillId:'SAMPLE'}]){
  await writeFile(join(f.source,'_skillhub_meta.json'),JSON.stringify(value));await assert.rejects(f.prepare(),{code:'wb_skill_market_metadata_invalid'});
 }
});
test('never overrides a divergent preexisting isolated installation',async t=>{
 const f=await fixture(t),p=await f.prepare();await writeFile(join(p.feature.installedDirectory,'scripts','sample.py'),'changed\n');await assert.rejects(f.prepare(),{code:'wb_skill_copy_conflict'});assert.equal(await readFile(join(f.source,'scripts','sample.py'),'utf8'),'# Entire original directory copy\n');
});
test('source symlinks are not traversed or copied',async t=>{
 const f=await fixture(t);await symlink(f.base,join(f.source,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(f.prepare(),{code:'wb_skill_source_link'});
});
test('cancellation aborts before preparing a workspace or executing commands',async t=>{
 const controller=new AbortController();controller.abort();const f=await fixture(t,{signal:controller.signal});await assert.rejects(f.prepare(),{name:'AbortError'});
});
test('post-copy source drift is rejected rather than silently accepted',async t=>{
 const f=await fixture(t,{dependencyProbe:async()=>{await writeFile(join(f.source,'scripts','sample.py'),'changed after snapshot');return {html:true,markitdown:'0.1.8'};}});await assert.rejects(f.prepare(),{code:'wb_skill_copy_changed'});
});
