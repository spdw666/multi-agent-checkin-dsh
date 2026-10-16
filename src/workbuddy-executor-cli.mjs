// Execute genuine features through the user's installed, unmodified official CLI.
// No usage/completion telemetry is manufactured by the gateway.
import {spawn} from 'node:child_process';
import {access,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {AppError,hash,rememberSecret,redact} from './util.mjs';

export async function findWorkBuddyExecutorCli({env=process.env,exists=async p=>{try{await access(p);return true;}catch{return false;}}}={}){
 const tail='resources/app.asar.unpacked/cli/bin/codebuddy',paths=[env.AI_CREDIT_WB_EXECUTOR_CLI,'D:/WorkBuddy/'+tail,env.LOCALAPPDATA&&join(env.LOCALAPPDATA,'Programs/WorkBuddy',tail),env.ProgramFiles&&join(env.ProgramFiles,'WorkBuddy',tail),'/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy','/opt/WorkBuddy/'+tail];
 for(const file of paths.filter(Boolean))if(await exists(file))return {file:resolve(file),productFile:resolve(dirname(file),'../product.json')};
 return null;
}
export async function findWorkBuddyExecutorNode(env=process.env){
 if(env.AI_CREDIT_WB_EXECUTOR_NODE){try{await access(env.AI_CREDIT_WB_EXECUTOR_NODE);return resolve(env.AI_CREDIT_WB_EXECUTOR_NODE);}catch{}}
 const home=env.USERPROFILE??env.HOME;if(home){const versions=join(home,'.workbuddy','binaries','node','versions');try{const rank=v=>v==='22.22.2-6'?0:/^22\./.test(v)?1:2;for(const v of (await readdir(versions)).filter(n=>/^\d+\.\d+\.\d+(?:-\d+)?$/.test(n)).sort((a,b)=>rank(a)-rank(b)||b.localeCompare(a,undefined,{numeric:true}))){const file=join(versions,v,process.platform==='win32'?'node.exe':'bin/node');try{await access(file);return file;}catch{}}}catch{}}
 return process.execPath;
}
export function workBuddyExecutorEnvironment(credential,root,productFile,source=process.env){
 const env={};for(const [k,v]of Object.entries(source))if(!/^(?:CODEBUDDY|WORKBUDDY|ACC_|ANTHROPIC_|OPENAI_|CLAUDE_|AI_CREDIT_|QWEN_|DSH_)/i.test(k)&&!/^NODE_(?:OPTIONS|PATH)$/i.test(k)&&!/(?:TOKEN|API_KEY|ACCESS_KEY|SECRET|PASSWORD|AUTHORIZATION|COOKIE|PRIVATE_KEY)/i.test(k))env[k]=v;
 const domain=credential.domain??'www.workbuddy.cn';if(!['www.workbuddy.cn','workbuddy.cn','www.codebuddy.cn','codebuddy.cn','copilot.tencent.com','www.workbuddy.ai','workbuddy.ai'].includes(domain))throw new AppError('WB 官方执行器域名待核对',400,'wb_executor_domain_invalid');
 rememberSecret(credential.accessToken);
 Object.assign(env,{HOME:join(root,'home'),USERPROFILE:join(root,'home'),APPDATA:join(root,'appdata'),LOCALAPPDATA:join(root,'localappdata'),TEMP:join(root,'tmp'),TMP:join(root,'tmp'),CODEBUDDY_CONFIG_DIR:join(root,'config'),WORKBUDDY_CONFIG_DIR:join(root,'config'),WORKBUDDY_DATA_ROOT:join(root,'data'),CODEBUDDY_FORCE_LITE_WB_BUNDLE:'1',CODEBUDDY_HOST:'workbuddy-desktop',CODEBUDDY_CREDENTIALS_IN_MEMORY:'1',CODEBUDDY_DISABLE_PRODUCT_CACHE:'1',DISABLE_AUTOUPDATER:'1',ACC_PRODUCT_CONFIG_PATH:productFile,CODEBUDDY_AUTH_TOKEN:credential.accessToken,ACC_USER_ID:String(credential.uid??credential.principal),CODEBUDDY_BASE_URL:/workbuddy\.ai$/.test(domain)?'https://'+domain+'/v2':'https://copilot.tencent.com/v2',CODEBUDDY_CUSTOM_HEADERS:'X-Domain: '+domain+'\nX-User-Id: '+String(credential.uid??credential.principal)});
 return env;
}
function toolText(result){return typeof result.content==='string'?result.content:Array.isArray(result.content)?result.content.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n'):JSON.stringify(result.content??'');}
function toolFailure(result,name){const text=toolText(result);return result.is_error===true||result.isError===true||result._meta?.is_error===true||/^Error\s*:/i.test(text)||/^<tool_use_error>/i.test(text);}
function toolPermissionDenied(result){return /^Error:\s*Permission to use [\s\S]*?has been denied/i.test(toolText(result));}
function structuredToolResult(result){
 const values=[];if(result.structuredContent&&typeof result.structuredContent==='object')values.push(result.structuredContent);
 const texts=typeof result.content==='string'?[result.content]:Array.isArray(result.content)?result.content.filter(x=>x?.type==='text').map(x=>x.text):[];
 if(result.content&&typeof result.content==='object'&&!Array.isArray(result.content))values.push(result.content);
 for(let value of texts){try{for(let n=0;n<3&&typeof value==='string';n++)value=JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g,''));if(value&&typeof value==='object')values.push(value);}catch{}}
 return values;
}
function designContentCount(values){let count=0;const seen=new Set();function visit(value,depth=0){if(!value||typeof value!=='object'||depth>12||seen.has(value))return;seen.add(value);if(Array.isArray(value)){for(const v of value)visit(v,depth+1);return;}const type=String(value.type??value.nodeType??'').toLowerCase(),id=value.id??value.nodeId??value.node_id;if(id!==undefined&&((type&&!['page','document','root','file'].includes(type))||typeof value.text==='string'&&value.text.trim()||typeof value.characters==='string'&&value.characters.trim()))count++;for(const child of Object.values(value))if(child&&typeof child==='object')visit(child,depth+1);}for(const value of values)visit(value);return count;}
export function workBuddyExecutorPermissionRules(rules,{shell}={}){
 const expanded=[...rules];if(shell!=='powershell')return expanded;
 for(const rule of rules){
  if(!rule.startsWith('Bash(& ')||!rule.endsWith(')'))continue;
  const command=rule.slice(5,-1),literal=command.replace(/^&\s+/,'');
  // Native allow checks compare extracted subcommands rather than the original
  // PowerShell call syntax. Add only equivalent *exact* literal spellings for
  // its regex and shell-quote parsers; never broaden to an executable prefix.
  // Expressions, redirection, pipelines, substitutions and wildcard rules are
  // deliberately not canonicalized by this small literal-only compatibility.
  const tokens=[];let offset=0,valid=true;const token=/'([^'\r\n]*)'|"([^"\r\n$`\\]*)"|([^\s'";|&<>$`*?(){}\[\]\\]+)/y;
  while(offset<literal.length){while(/\s/.test(literal[offset]??'')&&offset<literal.length)offset++;if(offset===literal.length)break;token.lastIndex=offset;const match=token.exec(literal);if(!match){valid=false;break;}tokens.push(match[1]??match[2]??match[3]);offset=token.lastIndex;if(offset<literal.length&&!/\s/.test(literal[offset])){valid=false;break;}}
  if(!valid||!tokens.length||!(/^(?:[A-Za-z]:[\\/]|\/)/.test(tokens[0]))||tokens.some(value=>/[\x00-\x1f*?;|&<>$`(){}\[\]]/.test(value)))continue;
  expanded.push('Bash('+literal+')','Bash('+tokens.join(' ')+')');
 }
 return [...new Set(expanded)];
}
export function parseWorkBuddyExecutorTrace(rows,{exitCode,requireTool,requireArtifact=false}={}){
 const calls=new Map(),results=new Map(),artifacts=[],designReadbacks=[];let terminal=null,contentChars=0;
 for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row))continue;if(row.type==='result')terminal=row;const message=row.message??row;
  for(const item of Array.isArray(message.content)?message.content:[]){if(!item||typeof item!=='object'||Array.isArray(item))continue;if(item.type==='text'&&typeof item.text==='string')contentChars+=item.text.length;
   if(item.type==='tool_use'&&typeof item.id==='string')calls.set(item.id,{id:item.id,name:String(item.name??''),input:item.input??{}});
   if(item.type==='tool_result'&&typeof item.tool_use_id==='string')results.set(item.tool_use_id,item);
  }
 }
 const completed=[...calls.values()].filter(c=>results.has(c.id)&&!toolFailure(results.get(c.id),c.name)),failed=[...calls.values()].filter(c=>results.has(c.id)&&toolFailure(results.get(c.id),c.name)),unclosed=[...calls.values()].filter(c=>!results.has(c.id)),denied=failed.filter(c=>toolPermissionDenied(results.get(c.id)));
 for(const c of completed){const result=results.get(c.id),text=toolText(result);
  if(/create_design|create.*canvas|automation_update|scheduled.*task/i.test(c.name)){const fileId=text.match(/(?:fileId|file_id|automationId|taskId|"id")[\s"':=]+([a-zA-Z0-9_-]{5,128})/);if(fileId)artifacts.push({kind:/design|canvas/.test(c.name)?'design':'automation',id:fileId[1]});}
  if(/fetch_file_info|batch_read/i.test(c.name)){
   const inputId=c.input?.fileId??c.input?.file_id,values=structuredToolResult(result),reported=values.map(v=>v.fileId??v.file_id??v.data?.fileId??v.data?.file_id).find(v=>v!==undefined),id=reported??inputId;
   if((typeof id==='string'||typeof id==='number')&&/^[a-zA-Z0-9_-]{1,128}$/.test(String(id)))designReadbacks.push({id:String(id),contentPresent:(inputId===undefined||reported===undefined||String(inputId)===String(reported))&&designContentCount(values)>0});
  }
 }
 const normalTerminal=exitCode===0&&terminal?.type==='result'&&terminal.is_error!==true&&terminal.subtype==='success'&&!terminal.terminal_reason&&typeof terminal.result==='string'&&terminal.result.trim().length>0;
 const requiredToolSeen=!requireTool||completed.some(c=>requireTool.test(c.name));
 const valid=normalTerminal&&unclosed.length===0&&denied.length===0&&requiredToolSeen&&(!requireArtifact||artifacts.length>0),errorBeforeSideEffect=denied.length>0&&unclosed.length===0&&failed.every(c=>toolPermissionDenied(results.get(c.id)))&&completed.every(c=>['Read','Glob','Grep','Skill'].includes(c.name));
 return {valid,normalTerminal,requiredToolSeen,unclosedTools:unclosed.length,failedTools:failed.length,permissionDeniedTools:denied.map(c=>c.name),errorBeforeSideEffect,completedTools:completed.map(c=>{const subagentType=c.name==='Agent'?(c.input?.subagent_type??c.input?.name):undefined,subagentName=c.name==='Agent'?c.input?.name:undefined;return{name:c.name,id:c.id,...(typeof subagentType==='string'&&subagentType.length<=128?{subagentType}:{}),...(typeof subagentName==='string'&&subagentName.length<=128?{subagentName}:{})};}),artifacts,designReadbacks,sessionId:typeof terminal?.session_id==='string'?terminal.session_id:null,contentChars,usage:terminal?.usage??null,terminalReason:terminal?.terminal_reason??null,terminalState:{present:!!terminal,subtype:terminal?.subtype??null,isError:terminal?.is_error??null,resultChars:typeof terminal?.result==='string'?terminal.result.length:0,errorCount:Array.isArray(terminal?.errors)?terminal.errors.length:0},reason:valid?null:!normalTerminal?'cli_result_not_complete':unclosed.length?'tool_result_missing':denied.length?'tool_permission_denied':!requiredToolSeen?'required_feature_not_executed':requireArtifact&&!artifacts.length?'feature_artifact_not_observed':null};
}
export async function runWorkBuddyOfficialCli({service,accountId,operationId,prompt,signal,check=()=>{},model='fast-model',requireTool,requireArtifact=false,allowedTools,timeoutMs=180000,prepare,onBeforeSpawn=()=>{},verifyResult}){
 check();signal?.throwIfAborted();const runtime=service.workbuddyRuntime??{},cli=runtime.executorCli??await findWorkBuddyExecutorCli();if(!cli)throw new AppError('官方 WorkBuddy 执行组件待安装或定位',503,'wb_executor_cli_missing');
 const credential=await service.credentials.resolve(accountId),root=join(service.config.dataDir,'wb-executor-runtime',hash(accountId+'\0'+String(credential.uid??credential.principal))),cwd=join(root,'workspace');
 const env=workBuddyExecutorEnvironment(credential,root,cli.productFile);
 for(const p of [cwd,...['home','appdata','localappdata','tmp','config','data'].map(p=>join(root,p))])await mkdir(p,{recursive:true,mode:0o700});
 const prepared=await prepare?.({root,cwd,env,cli,credential});
 prompt=prepared?.prompt??prompt;requireTool=prepared?.requireTool??requireTool;
 if(typeof prepared?.verifyResult==='function'){const callerVerify=verifyResult;verifyResult=async(...args)=>(!callerVerify||await callerVerify(...args)===true)&&await prepared.verifyResult(...args)===true;}
 const tools=Array.isArray(allowedTools)?allowedTools:String(allowedTools??'').split(/[\s,]+/).filter(Boolean);let permissionArgs=[];
 if(tools.length){
  if(tools.length>64||tools.some(t=>typeof t!=='string'||!/^[A-Za-z0-9_:.\/-]{1,128}$/.test(t)))throw new AppError('执行工具白名单格式错误',400,'wb_executor_tools_invalid');
  const rules=prepared?.permissionRules??[];
  if(!Array.isArray(rules)||rules.length>32||rules.some(rule=>typeof rule!=='string'||rule.length>4096||/[\r\n\x00-\x1f]/.test(rule)||!/^([A-Za-z0-9_:.\/-]+)\(.+\)$/.test(rule)||!tools.includes(rule.slice(0,rule.indexOf('(')))||/^\s*\*\s*$/.test(rule.slice(rule.indexOf('(')+1,-1))))throw new AppError('执行工具精确权限格式错误',400,'wb_executor_permissions_invalid');
  const expandedRules=workBuddyExecutorPermissionRules(rules,{shell:env.CODEBUDDY_CODE_SHELL}),scoped=new Set(expandedRules.map(rule=>rule.slice(0,rule.indexOf('(')))),allow=[...new Set([...tools.filter(tool=>tool!=='Bash'&&!scoped.has(tool)),...expandedRules])];
  const file=join(root,'executor-permissions-'+hash(String(operationId)).slice(0,16)+'.json');await writeFile(file,JSON.stringify({permissions:{allow}}),{mode:0o600});permissionArgs=['--settings',file];
 }
 const args=[cli.file,'--print','--output-format','stream-json','--verbose','--model',model,'--max-turns','12','--setting-sources','user',...(tools.length?['--tools',tools.join(',')]:[]),...(prepared?.args??[]),...permissionArgs];
 check();signal?.throwIfAborted();const rows=[],localAbort=new AbortController(),combined=signal?AbortSignal.any([signal,localAbort.signal]):localAbort.signal;
 if(!runtime.executorNode)runtime.resolvedExecutorNode??=await findWorkBuddyExecutorNode();
 const startedAt=new Date().toISOString();let buffer='',stderr='',bytes=0,spawned=false;await onBeforeSpawn();check();signal?.throwIfAborted();
 const result=await new Promise((resolveResult,reject)=>{
  const child=spawn(runtime.executorNode??runtime.resolvedExecutorNode??process.execPath,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let timer,settled=false;
  const cleanup=()=>{clearTimeout(timer);combined.removeEventListener('abort',abort);};
  const abort=()=>{if(child.exitCode!==null)return;if(process.platform==='win32'&&child.pid){const killer=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>child.kill());killer.once('close',code=>{if(code!==0&&child.exitCode===null)child.kill();});}else child.kill();};combined.addEventListener('abort',abort,{once:true});
  child.stdin.on('error',()=>{});
  child.once('spawn',()=>{spawned=true;if(combined.aborted)abort();else child.stdin.end(prompt);});
  child.once('error',e=>{if(settled)return;settled=true;cleanup();const error=new AppError('官方 WB 执行组件启动失败',503,'wb_executor_spawn_failed');error.beforeSubmission=!spawned;reject(error);});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const parse=line=>{if(!line.trim())return;try{rows.push(JSON.parse(line));}catch{/* CLI banner is not a structured completion result. */}};
  child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>8*1024*1024){localAbort.abort(new AppError('执行器输出超过上限',502,'wb_executor_trace_limit'));return;}buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){parse(buffer.slice(0,n));buffer=buffer.slice(n+1);}});
  child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});
  child.once('close',async(code,terminationSignal)=>{if(settled)return;cleanup();try{parse(buffer);if(combined.aborted)throw combined.reason??new AppError('WB 任务执行已停止',499,'wb_executor_cancelled');await runtime.executorTraceSink?.(rows);if(combined.aborted)throw combined.reason;const trace=parseWorkBuddyExecutorTrace(rows,{exitCode:code,requireTool,requireArtifact});settled=true;resolveResult({...trace,exitCode:code,terminationSignal,startedAt,endedAt:new Date().toISOString(),operationId,workspace:cwd,stderrPreview:redact(stderr).slice(0,1000)});}catch(cause){settled=true;const error=cause instanceof Error?cause:new AppError('官方执行输出解析或终结失败',502,'wb_executor_trace_invalid');error.beforeSubmission=!spawned;reject(error);}});
  timer=setTimeout(()=>localAbort.abort(new AppError('官方任务执行等待超时，保留已发状态待回查',504,'wb_executor_timeout')),timeoutMs);timer.unref?.();
 });
 if(prepared?.feature)result.feature=prepared.feature;
 if(verifyResult&&result.valid){const verified=await verifyResult(result,{root,cwd});if(verified!==true){result.valid=false;result.reason='feature_readback_not_confirmed';}}
 // Never persist credentials or the raw transcript; only bounded real observations.
 const evidence={...result,stderrPreview:undefined,completedTools:result.completedTools.slice(0,100),usage:result.usage&&typeof result.usage==='object'?result.usage:null};
 await writeFile(join(root,'last-execution.json'),JSON.stringify(evidence,null,2),{mode:0o600});
 return result;
}
