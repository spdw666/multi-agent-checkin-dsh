import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
 findWorkBuddyExecutorCli,findWorkBuddyExecutorNode,workBuddyExecutorEnvironment,workBuddyExecutorPermissionRules,
 parseWorkBuddyExecutorTrace,runWorkBuddyOfficialCli
} from '../src/workbuddy-executor-cli.mjs';

// Every identity, key, model, nonce and feature id below is synthetic. The
// executable fixtures invoke only the current Node binary and a temporary local
// script; they never invoke the installed WorkBuddy CLI or any model endpoint.
const sampleCredential=()=>({accessToken:'SAMPLE-WB-ACCESS-TOKEN-LOCAL-ONLY',uid:'SAMPLE-UID',principal:'SAMPLE-PRINCIPAL',domain:'www.codebuddy.cn'});
const success=(extra={})=>({type:'result',subtype:'success',is_error:false,result:'SAMPLE completed',session_id:'SAMPLE-SESSION',usage:{input_tokens:3,output_tokens:2},...extra});
const call=(name='Write',id='SAMPLE-CALL')=>({type:'assistant',message:{content:[{type:'tool_use',id,name,input:{file_path:'SAMPLE-marker.txt',content:'SAMPLE-NONCE'}}]}});
const result=(content='SAMPLE written',id='SAMPLE-CALL',extra={})=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content,...extra}]}});
const parse=(rows,options={})=>parseWorkBuddyExecutorTrace(rows,{exitCode:0,...options});

test('finder honors an explicit SAMPLE CLI override and derives its adjacent product file',async()=>{
 const file=resolve('SAMPLE-install','cli','bin','codebuddy'),seen=[];
 const found=await findWorkBuddyExecutorCli({env:{AI_CREDIT_WB_EXECUTOR_CLI:file},exists:async path=>{seen.push(path);return path===file;}});
 assert.deepEqual(found,{file,productFile:resolve(dirname(file),'../product.json')});
 assert.deepEqual(seen,[file]);
});
test('finder probes platform candidates without accessing an actual installation',async()=>{
 const env={LOCALAPPDATA:resolve('SAMPLE-local'),ProgramFiles:resolve('SAMPLE-programs')},seen=[];
 const expected=join(env.LOCALAPPDATA,'Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy');
 const found=await findWorkBuddyExecutorCli({env,exists:async path=>{seen.push(path);return path===expected;}});
 assert.equal(found.file,resolve(expected));
 assert.ok(seen[0].endsWith('resources/app.asar.unpacked/cli/bin/codebuddy'));
 assert.equal(seen.at(-1),expected);
});
test('finder returns null when every injected probe misses',async()=>{
 let count=0;const found=await findWorkBuddyExecutorCli({env:{},exists:async()=>{count++;return false;}});
 assert.equal(found,null);assert.ok(count>=3);
});

test('environment separates CN transport API base from the saved authentication domain',()=>{
 const credential=sampleCredential(),root=resolve('SAMPLE-runtime'),product=resolve('SAMPLE-product.json');
 const env=workBuddyExecutorEnvironment(credential,root,product,{PATH:'SAMPLE-PATH',SystemRoot:'SAMPLE-SYSTEM'});
 assert.equal(env.CODEBUDDY_AUTH_TOKEN,credential.accessToken);
 assert.equal(env.ACC_USER_ID,'SAMPLE-UID');
 assert.equal(env.ACC_PRODUCT_CONFIG_PATH,product);
 assert.equal(env.CODEBUDDY_BASE_URL,'https://copilot.tencent.com/v2');
 assert.equal(env.CODEBUDDY_CUSTOM_HEADERS,'X-Domain: www.codebuddy.cn\nX-User-Id: SAMPLE-UID');
 assert.equal(env.PATH,'SAMPLE-PATH');assert.equal(env.SystemRoot,'SAMPLE-SYSTEM');
 assert.equal(env.CODEBUDDY_CREDENTIALS_IN_MEMORY,'1');
 assert.equal(env.CODEBUDDY_FORCE_LITE_WB_BUNDLE,'1');
 assert.equal(env.CODEBUDDY_DISABLE_PRODUCT_CACHE,'1');assert.equal(env.DISABLE_AUTOUPDATER,'1');
});
test('environment places home, authentication, caches and temporary state inside the SAMPLE runtime',()=>{
 const root=resolve('SAMPLE-runtime'),env=workBuddyExecutorEnvironment(sampleCredential(),root,'SAMPLE-product',{
  HOME:'SAMPLE-old-home',USERPROFILE:'SAMPLE-old-home',APPDATA:'SAMPLE-old-roaming',LOCALAPPDATA:'SAMPLE-old-local',
  CODEBUDDY_CONFIG_DIR:'SAMPLE-old-config',WORKBUDDY_CONFIG_DIR:'SAMPLE-old-config',TEMP:'SAMPLE-old-temp',TMP:'SAMPLE-old-temp'
 });
 for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','CODEBUDDY_CONFIG_DIR','WORKBUDDY_CONFIG_DIR','WORKBUDDY_DATA_ROOT']){
  const rel=relative(root,env[key]);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),key+' remains within the fixture root');
 }
 assert.equal(env.HOME,env.USERPROFILE);assert.equal(env.CODEBUDDY_CONFIG_DIR,env.WORKBUDDY_CONFIG_DIR);
});
test('environment strips inherited provider credentials, old WB configuration and generic secrets',()=>{
 const poisoned={PATH:'SAMPLE-PATH',HTTP_PROXY:'http://127.0.0.1:1',
  OPENAI_API_KEY:'SAMPLE-other-openai',ANTHROPIC_API_KEY:'SAMPLE-other-anthropic',CLAUDE_CODE_OAUTH_TOKEN:'SAMPLE-other-claude',
  DSH_API_KEY:'SAMPLE-other-dsh',QWEN_COOKIE:'SAMPLE-other-qwen',AI_CREDIT_ADMIN_TOKEN:'SAMPLE-other-admin',
  GITHUB_TOKEN:'SAMPLE-other-github',AUTH_TOKEN:'SAMPLE-other-auth',SAMPLE_SECRET:'SAMPLE-other-secret',
  SERVICE_PASSWORD:'SAMPLE-other-password',SESSION_COOKIE:'SAMPLE-other-cookie',
  CODEBUDDY_AUTH_TOKEN:'SAMPLE-old-wb',CODEBUDDY_API_KEY:'SAMPLE-old-api-key',
  CODEBUDDY_CUSTOM_HEADERS:'SAMPLE-old-header',ACC_PRODUCT_CONFIG_V3:'SAMPLE-old-product',ACC_USER_ID:'SAMPLE-old-uid',
  WORKBUDDY_USER_DATA_DIR:'SAMPLE-old-user-data'};
 const credential=sampleCredential(),env=workBuddyExecutorEnvironment(credential,resolve('SAMPLE-runtime'),'SAMPLE-product',poisoned);
 for(const [key,value] of Object.entries(poisoned)){
  if(['PATH','HTTP_PROXY'].includes(key)){assert.equal(env[key],value);continue;}
  assert.notEqual(env[key],value,key+' must not reuse another credential or profile');
 }
 assert.equal(env.CODEBUDDY_AUTH_TOKEN,credential.accessToken);
 for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GITHUB_TOKEN','CODEBUDDY_API_KEY','ACC_PRODUCT_CONFIG_V3'])assert.equal(env[key],undefined);
});
test('environment clears inherited Node injection and unrelated cloud credentials',()=>{
 const env=workBuddyExecutorEnvironment(sampleCredential(),resolve('SAMPLE-runtime'),'SAMPLE-product',{
  NODE_OPTIONS:'--require SAMPLE-foreign-bootstrap.cjs',NODE_PATH:'SAMPLE-foreign-modules',
  AWS_ACCESS_KEY_ID:'SAMPLE-other-cloud-id',AWS_SECRET_ACCESS_KEY:'SAMPLE-other-cloud-secret',
  AZURE_CLIENT_SECRET:'SAMPLE-other-azure-secret'
 });
 for(const key of ['NODE_OPTIONS','NODE_PATH','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AZURE_CLIENT_SECRET'])assert.ok(!env[key],key+' must not be inherited');
});
test('AI account uses its own official API base while principal remains a valid uid fallback',()=>{
 const credential={accessToken:'SAMPLE-AI-TOKEN',principal:'SAMPLE-PRINCIPAL',domain:'www.workbuddy.ai'};
 const env=workBuddyExecutorEnvironment(credential,resolve('SAMPLE-runtime'),'SAMPLE-product',{});
 assert.equal(env.CODEBUDDY_BASE_URL,'https://www.workbuddy.ai/v2');
 assert.equal(env.ACC_USER_ID,'SAMPLE-PRINCIPAL');
 assert.ok(env.CODEBUDDY_CUSTOM_HEADERS.endsWith('X-User-Id: SAMPLE-PRINCIPAL'));
});
test('environment rejects an unrecognized domain before passing credentials to a child',()=>{
 assert.throws(()=>workBuddyExecutorEnvironment({...sampleCredential(),domain:'SAMPLE.invalid'},resolve('SAMPLE-runtime'),'SAMPLE-product',{}),{code:'wb_executor_domain_invalid'});
});
test('environment uses the official WorkBuddy sidecar host contract rather than an inherited standalone host',()=>{
 const env=workBuddyExecutorEnvironment(sampleCredential(),resolve('SAMPLE-runtime'),'SAMPLE-product',{CODEBUDDY_HOST:'web-ui'});
 assert.equal(env.CODEBUDDY_HOST,'workbuddy-desktop');
});

test('parser accepts a genuine closed tool pair followed by a normal result',()=>{
 const trace=parse([call(),result(),{type:'assistant',message:{content:[{type:'text',text:'SAMPLE answer'}]}},success()],{requireTool:/^Write$/});
 assert.equal(trace.valid,true);assert.equal(trace.normalTerminal,true);assert.equal(trace.requiredToolSeen,true);
 assert.equal(trace.unclosedTools,0);assert.equal(trace.failedTools,0);assert.equal(trace.contentChars,13);
 assert.deepEqual(trace.completedTools,[{name:'Write',id:'SAMPLE-CALL'}]);assert.equal(trace.sessionId,'SAMPLE-SESSION');
 assert.equal(trace.usage.input_tokens,3);assert.equal(trace.reason,null);
});
test('parser recognizes an observed structured automation artifact from its completed tool',()=>{
 const trace=parse([call('mcp__SAMPLE__automation_update'),result([{type:'text',text:JSON.stringify({automationId:'SAMPLE-AUTOMATION'})}]),success()],{requireTool:/automation_update/,requireArtifact:true});
 assert.equal(trace.valid,true);assert.deepEqual(trace.artifacts,[{kind:'automation',id:'SAMPLE-AUTOMATION'}]);
});
test('parser recognizes an observed design artifact without manufacturing one from assistant prose',()=>{
 const good=parse([call('mcp__SAMPLE__create_design'),result(JSON.stringify({fileId:'SAMPLE-DESIGN'})),success()],{requireTool:/create_design/,requireArtifact:true});
 assert.equal(good.valid,true);assert.deepEqual(good.artifacts,[{kind:'design',id:'SAMPLE-DESIGN'}]);
 const prose=parse([{type:'assistant',message:{content:[{type:'text',text:'fileId: SAMPLE-FAKE'}]}},success()],{requireArtifact:true});
 assert.equal(prose.valid,false);assert.equal(prose.reason,'feature_artifact_not_observed');assert.deepEqual(prose.artifacts,[]);
});
test('parser rejects an exit-zero error terminal and retains an error terminal state',()=>{
 const trace=parse([success({subtype:'error_during_execution',is_error:true,result:undefined,errors:['SAMPLE error'],errors_info:[{status:405,code:'SAMPLE-ERROR'}]})]);
 assert.equal(trace.valid,false);assert.equal(trace.normalTerminal,false);assert.equal(trace.reason,'cli_result_not_complete');
 if(trace.terminalState){assert.equal(trace.terminalState.present,true);assert.equal(trace.terminalState.isError,true);assert.equal(trace.terminalState.errorCount,1);}
});
for(const terminalReason of ['aborted_tools','aborted_streaming'])test('parser rejects the official cancelled-success form: '+terminalReason,()=>{
 const trace=parse([success({result:'',terminal_reason:terminalReason})]);
 assert.equal(trace.valid,false);assert.equal(trace.normalTerminal,false);assert.equal(trace.terminalReason,terminalReason);
});
test('parser rejects nonzero exit even when the last terminal claims success',()=>{
 const trace=parse([success()],{exitCode:1});assert.equal(trace.valid,false);assert.equal(trace.normalTerminal,false);
});
test('parser rejects an absent terminal, empty answer and unknown terminal subtype',()=>{
 for(const rows of [[],[{type:'assistant',message:{content:[{type:'text',text:'SAMPLE unfinished'}]}}],[success({result:'  '})],[success({subtype:'SAMPLE-unknown'})]]){
  const trace=parse(rows);assert.equal(trace.valid,false);assert.equal(trace.normalTerminal,false);
 }
});
test('parser rejects an unclosed tool even when the model claims completion',()=>{
 const trace=parse([call(),success()]);assert.equal(trace.valid,false);assert.equal(trace.unclosedTools,1);assert.equal(trace.reason,'tool_result_missing');
});
test('parser rejects a failed required tool and does not count it as completed',()=>{
 const trace=parse([call(),result('SAMPLE write failed','SAMPLE-CALL',{is_error:true}),success()],{requireTool:/Write/});
 assert.equal(trace.valid,false);assert.equal(trace.failedTools,1);assert.equal(trace.requiredToolSeen,false);assert.deepEqual(trace.completedTools,[]);assert.equal(trace.reason,'required_feature_not_executed');
});
test('parser rejects a missing required feature even if another tool completed',()=>{
 const trace=parse([call('Read'),result(),success()],{requireTool:/automation_update/});
 assert.equal(trace.valid,false);assert.equal(trace.requiredToolSeen,false);assert.equal(trace.reason,'required_feature_not_executed');
});
test('parser rejects a feature without its required artifact identifier',()=>{
 const trace=parse([call('automation_update'),result('SAMPLE no entity identifier'),success()],{requireTool:/automation_update/,requireArtifact:true});
 assert.equal(trace.valid,false);assert.equal(trace.requiredToolSeen,true);assert.deepEqual(trace.artifacts,[]);assert.equal(trace.reason,'feature_artifact_not_observed');
});
test('parser uses the final result instead of accepting an earlier success',()=>{
 const trace=parse([success(),success({subtype:'error_during_execution',is_error:true,errors:['SAMPLE final failure']})]);assert.equal(trace.valid,false);
});
test('unknown error frames alone and incomplete protocol metadata never create completion',()=>{
 for(const rows of [[{type:'error',error:{code:'SAMPLE-UNKNOWN',message:'SAMPLE error'}}],[{type:'SAMPLE-unknown'},{type:'system',subtype:'init'}]]){
  const trace=parse(rows);assert.equal(trace.valid,false);assert.equal(trace.normalTerminal,false);
 }
});

const fakeCli=String.raw`
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input);
const marker={nonce:request.nonce,stdin:input,
 tokenMatched:process.env.CODEBUDDY_AUTH_TOKEN==='SAMPLE-WB-ACCESS-TOKEN-LOCAL-ONLY',
 inheritedOtherKey:!!process.env.OPENAI_API_KEY,
 secretInArgv:process.argv.some(x=>x.includes('SAMPLE-WB-ACCESS-TOKEN-LOCAL-ONLY')||x.includes('SAMPLE-UID')),
 args:process.argv.slice(2),home:process.env.HOME,profile:process.env.CODEBUDDY_CONFIG_DIR,
 apiBase:process.env.CODEBUDDY_BASE_URL,domainHeaderMatched:process.env.CODEBUDDY_CUSTOM_HEADERS==='X-Domain: www.codebuddy.cn\nX-User-Id: SAMPLE-UID'};
await writeFile(join(process.cwd(),'SAMPLE-marker.json'),JSON.stringify(marker));
if(request.mode==='hang'){setInterval(()=>{},1000);}
else if(request.mode==='oversize'){process.stdout.write('S'.repeat(9*1024*1024));setInterval(()=>{},1000);}
else {
 process.stdout.write('SAMPLE non-JSON CLI banner\n');
 const rows=request.mode==='error'?[{type:'result',subtype:'error_during_execution',is_error:true,errors:['SAMPLE feature failed'],usage:{input_tokens:0,output_tokens:0}}]:[
  {type:'assistant',message:{content:[{type:'tool_use',id:'SAMPLE-LOCAL-CALL',name:'Write',input:{file_path:'SAMPLE-marker.json',content:'SAMPLE-NONCE'}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'SAMPLE-LOCAL-CALL',content:'SAMPLE actual marker written',is_error:false}]}},
  {type:'assistant',message:{content:[{type:'text',text:'SAMPLE completed'}]}},
  {type:'result',subtype:'success',is_error:false,result:'SAMPLE completed',session_id:'SAMPLE-LOCAL-SESSION',usage:{input_tokens:1,output_tokens:1}}
 ];
 process.stderr.write('SAMPLE stderr '+process.env.CODEBUDDY_AUTH_TOKEN);
 const data=rows.map(x=>JSON.stringify(x)).join('\r\n');
 process.stdout.write(data.slice(0,29));
 setTimeout(()=>process.stdout.write(data.slice(29)),5);
}
`;

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'SAMPLE-wb-cli-tests-'));
 t.after(async()=>{
  const parent=resolve(tmpdir()),target=resolve(root),rel=relative(parent,target);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&basename(target).startsWith('SAMPLE-wb-cli-tests-'),'cleanup stays inside this generated SAMPLE temp directory');
  await rm(target,{recursive:true,force:true});
 });
 const file=join(root,'SAMPLE-fake-cli.mjs'),productFile=join(root,'SAMPLE-product.json');
 await writeFile(file,fakeCli);await writeFile(productFile,JSON.stringify({productName:'SAMPLE'}));
 let credentialReads=0;const service={config:{dataDir:join(root,'data')},credentials:{async resolve(id){assert.equal(id,'SAMPLE-ACCOUNT');credentialReads++;return sampleCredential();}},workbuddyRuntime:{executorNode:process.execPath,executorCli:{file,productFile}}};
 return {root,file,service,get credentialReads(){return credentialReads;}};
}
function prompt(mode='success'){
 return JSON.stringify({mode,nonce:'SAMPLE-NONCE'});
}
const run=(f,extra={})=>runWorkBuddyOfficialCli({service:f.service,accountId:'SAMPLE-ACCOUNT',operationId:'SAMPLE-OPERATION',prompt:prompt(),model:'SAMPLE-EXACT-MODEL',requireTool:/^Write$/,timeoutMs:5000,...extra});
async function waitForMarker(service,limit=5000){
 const {hash}=await import('../src/util.mjs'),root=join(service.config.dataDir,'wb-executor-runtime',hash('SAMPLE-ACCOUNT\0SAMPLE-UID')),file=join(root,'workspace','SAMPLE-marker.json');
 const deadline=Date.now()+limit;while(Date.now()<deadline){try{await access(file);return file;}catch{}await delay(15);}throw Error('SAMPLE child marker did not arrive');
}

test('real Node fake CLI proves stdin execution, a closed tool pair and an actual local marker',async t=>{
 const f=await fixture(t),old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='SAMPLE-OTHER-OPENAI';
 let result;try{result=await run(f,{allowedTools:'Read,Write'});}finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
 assert.equal(result.valid,true);assert.equal(result.exitCode,0);assert.equal(result.normalTerminal,true);assert.equal(result.completedTools.length,1);
 const marker=JSON.parse(await readFile(join(result.workspace,'SAMPLE-marker.json'),'utf8'));
 assert.equal(marker.nonce,'SAMPLE-NONCE');assert.equal(marker.stdin,prompt());assert.equal(marker.tokenMatched,true);assert.equal(marker.inheritedOtherKey,false);assert.equal(marker.secretInArgv,false);
 assert.equal(marker.apiBase,'https://copilot.tencent.com/v2');assert.equal(marker.domainHeaderMatched,true);
 assert.equal(marker.home,join(dirname(result.workspace),'home'));assert.equal(marker.profile,join(dirname(result.workspace),'config'));
 assert.ok(marker.args.includes('--print'));assert.ok(marker.args.includes('SAMPLE-EXACT-MODEL'));assert.ok(marker.args.includes('Read,Write'));
 assert.equal(result.stderrPreview.includes(sampleCredential().accessToken),false);assert.ok(result.stderrPreview.includes('[REDACTED]'));
 const evidence=await readFile(join(dirname(result.workspace),'last-execution.json'),'utf8');
 assert.equal(evidence.includes(sampleCredential().accessToken),false);assert.equal(evidence.includes('SAMPLE stderr'),false);assert.equal(evidence.includes('tool_use'),false);
 assert.equal(JSON.parse(evidence).valid,true);assert.equal(f.credentialReads,1);
});
test('real Node fake CLI exit-zero error remains an unsuccessful business result',async t=>{
 const f=await fixture(t),result=await run(f,{prompt:prompt('error'),requireTool:undefined});
 assert.equal(result.exitCode,0);assert.equal(result.valid,false);assert.equal(result.normalTerminal,false);assert.equal(result.reason,'cli_result_not_complete');
 assert.equal(result.usage.input_tokens,0);assert.equal(result.completedTools.length,0);
});
test('runner propagates a pre-submission cancellation without resolving credentials',async t=>{
 const f=await fixture(t),controller=new AbortController(),error=Error('SAMPLE cancelled before submission');controller.abort(error);
 await assert.rejects(run(f,{signal:controller.signal}),e=>e===error);assert.equal(f.credentialReads,0);
});
test('runner checks a late preflight change before spawning a child',async t=>{
 const f=await fixture(t),error=Error('SAMPLE setting disabled during preparation');let checks=0;
 await assert.rejects(run(f,{check(){if(++checks===2)throw error;}}),e=>e===error);assert.equal(checks,2);assert.equal(f.credentialReads,1);
});
test('runner reports a missing Node executable as a pre-submission spawn failure',async t=>{
 const f=await fixture(t);f.service.workbuddyRuntime.executorNode=join(f.root,'SAMPLE-NODE-MISSING');
 await assert.rejects(run(f),e=>e.code==='wb_executor_spawn_failed'&&e.beforeSubmission===true);
});
test('runner times out a submitted local fixture instead of reporting a completion',async t=>{
 const f=await fixture(t);
 await assert.rejects(run(f,{prompt:prompt('hang'),timeoutMs:400}),e=>e.code==='wb_executor_timeout'&&e.beforeSubmission===false);
});
test('runner cancels a submitted local fixture only after its real marker is observed',async t=>{
 const f=await fixture(t),controller=new AbortController(),error=Error('SAMPLE cancelled after marker');
 const pending=run(f,{prompt:prompt('hang'),signal:controller.signal});
 const observed=await waitForMarker(f.service);assert.equal(JSON.parse(await readFile(observed,'utf8')).nonce,'SAMPLE-NONCE');
 controller.abort(error);await assert.rejects(pending,e=>e===error&&e.beforeSubmission===false);
});
test('runner prepares private feature inputs before submission and verifies the actual marker afterward',async t=>{
 const f=await fixture(t),order=[];
 const result=await run(f,{
  async prepare({root,cwd,env,cli,credential}){
   order.push('prepare');assert.equal(credential.uid,'SAMPLE-UID');assert.equal(env.ACC_PRODUCT_CONFIG_PATH,cli.productFile);
   assert.equal(cwd,join(root,'workspace'));await writeFile(join(cwd,'SAMPLE-prepared.json'),JSON.stringify({nonce:'SAMPLE-PREPARED'}));
   return {args:['--SAMPLE-feature','SAMPLE-option']};
  },
  onBeforeSpawn(){order.push('before');},
  async verifyResult(result,{root,cwd}){
   order.push('verify');assert.equal(result.valid,true);assert.equal(result.workspace,cwd);assert.equal(dirname(cwd),root);
   const actual=JSON.parse(await readFile(join(cwd,'SAMPLE-marker.json'),'utf8'));
   const prepared=JSON.parse(await readFile(join(cwd,'SAMPLE-prepared.json'),'utf8'));
   assert.ok(actual.args.includes('--SAMPLE-feature'));return actual.nonce==='SAMPLE-NONCE'&&prepared.nonce==='SAMPLE-PREPARED';
  }
 });
 assert.equal(result.valid,true);assert.deepEqual(order,['prepare','before','verify']);
});
test('runner refuses model success when the independent feature readback is not confirmed',async t=>{
 const f=await fixture(t),result=await run(f,{verifyResult:async()=>false});
 assert.equal(result.normalTerminal,true);assert.equal(result.valid,false);assert.equal(result.reason,'feature_readback_not_confirmed');
 const evidence=JSON.parse(await readFile(join(dirname(result.workspace),'last-execution.json'),'utf8'));
 assert.equal(evidence.valid,false);assert.equal(evidence.reason,'feature_readback_not_confirmed');
});
test('runner does not call feature verification after an unsuccessful CLI terminal',async t=>{
 const f=await fixture(t);let verified=0;const result=await run(f,{prompt:prompt('error'),verifyResult:async()=>{verified++;return true;}});
 assert.equal(result.valid,false);assert.equal(verified,0);
});
test('runner honors submission refusal without starting even the local fixture',async t=>{
 const f=await fixture(t),error=Error('SAMPLE submission refused');let before=0;
 await assert.rejects(run(f,{onBeforeSpawn(){before++;throw error;}}),e=>e===error);
 assert.equal(before,1);assert.equal(f.credentialReads,1);
});
test('runner observes cancellation during preparation before invoking the submission callback',async t=>{
 const f=await fixture(t),controller=new AbortController(),error=Error('SAMPLE cancelled during preparation');let before=0;
 await assert.rejects(run(f,{signal:controller.signal,prepare:async()=>{controller.abort(error);},onBeforeSpawn(){before++;}}),e=>e===error);
 assert.equal(before,0);
});
test('runner exposes a structured trace only to its explicit local diagnostic callback',async t=>{
 const f=await fixture(t);let delivered=0;
 f.service.workbuddyRuntime.executorTraceSink=async rows=>{delivered++;assert.ok(rows.some(row=>row.type==='result'));assert.ok(rows.some(row=>row.type==='user'));assert.equal(rows.filter(row=>row.type==='result').length,1);};
 const result=await run(f);assert.equal(result.valid,true);assert.equal(delivered,1);
});
test('runner bounds local fixture stdout and rejects the execution instead of parsing an unbounded trace',async t=>{
 const f=await fixture(t);
 await assert.rejects(run(f,{prompt:prompt('oversize')}),e=>e.code==='wb_executor_trace_limit'&&e.beforeSubmission===false);
});

test('Node finder prefers the official compatible 22.22.2-6 runtime over other installed versions',async t=>{
 const f=await fixture(t),home=join(f.root,'SAMPLE-home'),versions=join(home,'.workbuddy','binaries','node','versions');
 for(const version of ['24.9.0','22.22.3','22.22.2-6','SAMPLE-invalid']){const file=join(versions,version,process.platform==='win32'?'node.exe':'bin/node');await mkdir(dirname(file),{recursive:true});await writeFile(file,'SAMPLE-NOT-EXECUTED');}
 assert.equal(await findWorkBuddyExecutorNode({USERPROFILE:home}),join(versions,'22.22.2-6',process.platform==='win32'?'node.exe':'bin/node'));
 const explicit=join(f.root,'SAMPLE-node');await writeFile(explicit,'SAMPLE-NOT-EXECUTED');assert.equal(await findWorkBuddyExecutorNode({USERPROFILE:home,AI_CREDIT_WB_EXECUTOR_NODE:explicit}),resolve(explicit));
 assert.equal(await findWorkBuddyExecutorNode({USERPROFILE:join(f.root,'SAMPLE-missing')}),process.execPath);
});
test('wrapped native approval denial never becomes a completed Write or Read',()=>{
 const denied='Error: Permission to use Write has been denied because this tool requires approval but permission prompts are not available in non-interactive mode.';
 const trace=parse([call('Skill','SAMPLE-SKILL'),result('SAMPLE loaded','SAMPLE-SKILL'),call(),result([{type:'text',text:denied}]),success()],{requireTool:/^Write$/});
 assert.equal(trace.valid,false);assert.equal(trace.reason,'tool_permission_denied');assert.equal(trace.requiredToolSeen,false);assert.equal(trace.failedTools,1);assert.equal(trace.errorBeforeSideEffect,true);assert.deepEqual(trace.permissionDeniedTools,['Write']);assert.deepEqual(trace.completedTools,[{name:'Skill',id:'SAMPLE-SKILL'}]);
 const priorWrite=parse([call('Write','SAMPLE-FIRST'),result('SAMPLE actually written','SAMPLE-FIRST'),call(),result(denied),success()]);assert.equal(priorWrite.errorBeforeSideEffect,false);
 const read=parse([call('Read'),result(denied.replace('Write','Read')),success()]);assert.equal(read.completedTools.length,0);assert.equal(read.errorBeforeSideEffect,true);
});
test('wrapped tool errors and error tags are failures even without an is_error flag',()=>{
 for(const text of ['Error: SAMPLE file is not writable','<tool_use_error>SAMPLE missing file</tool_use_error>']){const trace=parse([call(),result(text),success()],{requireTool:/^Write$/});assert.equal(trace.valid,false);assert.equal(trace.completedTools.length,0);assert.equal(trace.errorBeforeSideEffect,false);}
});
test('completed real Agent calls preserve canonical member type and optional name',()=>{
 const agent=call('Agent');agent.message.content[0].input={subagent_type:'SAMPLE-canonical-member',name:'SAMPLE-member-display'};
 const trace=parse([agent,result('SAMPLE genuine member completed'),success()]);assert.equal(trace.valid,true);assert.deepEqual(trace.completedTools,[{name:'Agent',id:'SAMPLE-CALL',subagentType:'SAMPLE-canonical-member',subagentName:'SAMPLE-member-display'}]);
 assert.deepEqual(parse([agent,result('Error: SAMPLE member failed'),success()]).completedTools,[]);
});
test('design readback records real same-ID nonempty nodes without retaining node content',()=>{
 const read=call('mcp__SAMPLE__batch_read');read.message.content[0].input={fileId:'SAMPLE-DESIGN'};
 const trace=parse([read,result(JSON.stringify({fileId:'SAMPLE-DESIGN',nodes:[{id:'SAMPLE-NODE',type:'TEXT',characters:'SAMPLE private artwork'}]})),success()]);
 assert.deepEqual(trace.designReadbacks,[{id:'SAMPLE-DESIGN',contentPresent:true}]);assert.equal(JSON.stringify(trace).includes('private artwork'),false);
});
test('design readback does not approve a mismatched ID, empty nodes or a root-only placeholder',()=>{
 const read=call('mcp__SAMPLE__fetch_file_info');read.message.content[0].input={file_id:'SAMPLE-DESIGN'};
 for(const body of [{file_id:'SAMPLE-OTHER',nodes:[{id:'SAMPLE-NODE',type:'TEXT',text:'SAMPLE'}]},{file_id:'SAMPLE-DESIGN',nodes:[]},{file_id:'SAMPLE-DESIGN',nodes:[{id:'SAMPLE-PAGE',type:'PAGE'}]}]){const trace=parse([read,result([{type:'text',text:JSON.stringify(body)}]),success()]);assert.equal(trace.designReadbacks.length,1);assert.equal(trace.designReadbacks[0].contentPresent,false);}
 const failed=parse([read,result('Error: SAMPLE fetch denied'),success()]);assert.deepEqual(failed.designReadbacks,[]);
});
test('malformed optional trace rows and null content items do not crash terminal parsing',()=>{
 const trace=parse([null,[],42,{type:'assistant',message:{content:[null,[],3]}},success()]);assert.equal(trace.valid,true);
});
test('runner supplies only private exact permission rules and never blanket approval',async t=>{
 const f=await fixture(t),result=await run(f,{allowedTools:'Skill,Read,Write,Bash',prepare:async()=>({permissionRules:['Bash(SAMPLE-PYTHON SAMPLE-script.py:*)']})});
 const marker=JSON.parse(await readFile(join(result.workspace,'SAMPLE-marker.json'),'utf8')),args=marker.args,index=args.lastIndexOf('--settings');assert.ok(index>=0);assert.equal(args.includes('-y'),false);assert.equal(args.includes('--allowedTools'),false);assert.equal(args[args.indexOf('--tools')+1],'Skill,Read,Write,Bash');
 const settings=JSON.parse(await readFile(args[index+1],'utf8'));assert.deepEqual(settings,{permissions:{allow:['Skill','Read','Write','Bash(SAMPLE-PYTHON SAMPLE-script.py:*)']}});assert.equal(relative(dirname(result.workspace),args[index+1]).startsWith('..'),false);assert.equal(JSON.stringify(settings).includes(sampleCredential().accessToken),false);
});
test('runner does not autoapprove an unscoped Bash tool and rejects wildcard-only rules',async t=>{
 const f=await fixture(t),result=await run(f,{allowedTools:'Read,Write,Bash'}),marker=JSON.parse(await readFile(join(result.workspace,'SAMPLE-marker.json'),'utf8')),args=marker.args;
 assert.deepEqual(JSON.parse(await readFile(args[args.indexOf('--settings')+1],'utf8')).permissions.allow,['Read','Write']);
 await assert.rejects(run(f,{allowedTools:'Write,Bash',prepare:async()=>({permissionRules:['Bash(*)']})}),{code:'wb_executor_permissions_invalid'});
});
test('runner settles an asynchronous diagnostic failure as a submitted rejection',async t=>{
 const f=await fixture(t),error=Error('SAMPLE diagnostic sink failed');f.service.workbuddyRuntime.executorTraceSink=async()=>{await delay(5);throw error;};
 await assert.rejects(run(f),e=>e===error&&e.beforeSubmission===false);
});

test('PowerShell exact literal Bash approval covers the official parser canonical form without a wildcard',async t=>{
 const f=await fixture(t),command="& 'C:/SAMPLE Python/python.exe' -m markitdown 'C:/SAMPLE work/input.html' -o 'C:/SAMPLE work/output.md'";
 const result=await run(f,{allowedTools:'Skill,Read,Bash',prepare:async({env})=>{env.CODEBUDDY_CODE_SHELL='powershell';return{permissionRules:['Skill(SAMPLE-skill)','Bash('+command+')'],feature:{kind:'market_skill'}};}});
 const marker=JSON.parse(await readFile(join(result.workspace,'SAMPLE-marker.json'),'utf8')),args=marker.args,allow=JSON.parse(await readFile(args[args.indexOf('--settings')+1],'utf8')).permissions.allow;
 assert.ok(allow.includes('Bash('+command+')'));
 assert.ok(allow.includes("Bash('C:/SAMPLE Python/python.exe' -m markitdown 'C:/SAMPLE work/input.html' -o 'C:/SAMPLE work/output.md')"));
 // The shipped shell-quote parser removes the call operator and literal quotes,
 // then uses tokens.join(' ') as the fullCommand for allow-side comparison.
 const nativeCanonical='C:/SAMPLE Python/python.exe -m markitdown C:/SAMPLE work/input.html -o C:/SAMPLE work/output.md';
 assert.ok(allow.includes('Bash('+nativeCanonical+')'));assert.ok(!allow.includes('Bash'));assert.ok(allow.filter(x=>x.startsWith('Bash(')).every(x=>!x.includes('*')));
});
test('PowerShell permission compatibility does not canonicalize expressions, wildcards or other shells',()=>{
 for(const rule of ["Bash(& 'C:/SAMPLE/python.exe' -m markitdown 'INPUT'; OTHER)","Bash(& 'C:/SAMPLE/python.exe' -m markitdown INPUT:*)","Bash(& 'C:/SAMPLE/python.exe' $(OTHER))","Bash(& 'C:/SAMPLE/python.exe' 'INPUT' | OTHER)"]){assert.deepEqual(workBuddyExecutorPermissionRules([rule],{shell:'powershell'}),[rule]);}
 const exact="Bash(& 'C:/SAMPLE/python.exe' -m markitdown 'INPUT' -o 'OUTPUT')";assert.deepEqual(workBuddyExecutorPermissionRules([exact],{shell:'sh'}),[exact]);
});
