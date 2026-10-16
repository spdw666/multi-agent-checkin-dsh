// Use one genuinely installed marketplace skill unchanged. The official Skill
// tool owns its native usage accounting; this module never emits growth events.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,readdir,readFile,mkdir,copyFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve,isAbsolute,relative,sep} from 'node:path';
import {AppError} from './util.mjs';

const execFileAsync=promisify(execFile);
const hash=b=>createHash('sha256').update(b).digest('hex');
const skillName='markitdown-skill';
const limits={files:256,bytes:16*1024*1024};
const fail=(message,code,status=409)=>new AppError(message,status,code);
function childOf(parent,path){const rel=relative(parent,path);return rel!==''&&!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel);}
function quote(value,shell){return shell==='powershell'?"'"+value.replace(/'/g,"''")+"'":"'"+value.replace(/'/g,"'\\''")+"'";}

async function tree(directory,active){
 const root=resolve(directory),entries=[];let bytes=0;
 const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw fail('市场技能目录格式待核对','wb_skill_source_invalid');
 async function walk(dir,prefix=''){
  for(const name of (await readdir(dir)).sort()){
   active();const path=join(dir,name),info=await lstat(path),rel=prefix?prefix+'/'+name:name;
   if(info.isSymbolicLink())throw fail('市场技能目录含链接','wb_skill_source_link');
   if(info.isDirectory()){await walk(path,rel);continue;}
   if(!info.isFile())throw fail('市场技能目录含非普通文件','wb_skill_source_invalid');
   bytes+=info.size;if(entries.length>=limits.files||bytes>limits.bytes)throw fail('市场技能目录超过执行上限','wb_skill_source_limit');
   entries.push({path:rel,sha256:hash(await readFile(path)),bytes:info.size});
  }
 }
 await walk(root);active();return {entries,bytes,sha256:hash(JSON.stringify(entries))};
}
async function probePython(python,signal){
 // Only local imports/version lookup. No pip, external URL or WB bearer is used.
 const env={};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','PATHEXT','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key];
 try{
  const {stdout}=await execFileAsync(python,['-I','-c','import json, importlib.metadata; import markitdown, bs4, markdownify; print(json.dumps({"markitdown":importlib.metadata.version("markitdown"),"html":True}))'],{env,windowsHide:true,timeout:15000,maxBuffer:4096,signal});
  const result=JSON.parse(stdout.trim());if(result.html!==true||typeof result.markitdown!=='string')throw Error('invalid');return result;
 }catch(error){signal?.throwIfAborted();throw fail('MarkItDown HTML 本地依赖待安装','wb_skill_dependency_missing',503);}
}

export async function prepareWorkBuddyMarketSkill({service,root,cwd,env,signal,check=()=>{},pythonExecutable,sourceDirectory,dependencyProbe}={}){
 const active=()=>{check();signal?.throwIfAborted();};active();
 if(!root||!cwd||!env||!isAbsolute(root)||!isAbsolute(cwd)||!childOf(resolve(root),resolve(cwd)))throw fail('市场技能隔离工作区待确认','wb_skill_workspace_invalid');
 const source=resolve(sourceDirectory??service?.workbuddyRuntime?.executorSkillDirectory??join(process.env.USERPROFILE??process.env.HOME??'', '.workbuddy','skills',skillName));
 let original,metadata,skillText;
 try{original=await tree(source,active);metadata=JSON.parse(await readFile(join(source,'_skillhub_meta.json'),'utf8'));skillText=await readFile(join(source,'SKILL.md'),'utf8');}
 catch(error){active();if(error instanceof AppError)throw error;throw fail('已安装 MarkItDown 市场技能待确认','wb_skill_market_install_missing');}
 const name=skillText.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1]?.trim();
 const marketId=metadata.skillId??metadata.skill_id??metadata.slug??metadata.id;
 if(name!==skillName||metadata.source!=='marketplace'||!['string','number'].includes(typeof marketId)||!String(marketId).trim()||typeof metadata.version!=='string'||!metadata.version.trim())throw fail('市场技能原始身份元数据待确认','wb_skill_market_metadata_invalid');
 const python=pythonExecutable??service?.workbuddyRuntime?.executorPython??process.env.AI_CREDIT_WB_EXECUTOR_PYTHON??(service?.config?.dataDir?join(service.config.dataDir,'wb-executor-tools','python',process.platform==='win32'?'Scripts/python.exe':'bin/python'):null);
 if(typeof python!=='string'||!isAbsolute(python)||/[\x00-\x1f]/.test(python))throw fail('MarkItDown Python 执行路径待确认','wb_skill_python_missing',503);
 const dependency=await (dependencyProbe??service?.workbuddyRuntime?.executorSkillDependencyProbe??probePython)(python,signal);active();
 if(dependency?.html!==true||typeof dependency.markitdown!=='string'||!dependency.markitdown)throw fail('MarkItDown HTML 本地依赖待安装','wb_skill_dependency_missing',503);
 const config=join(resolve(root),'config'),skills=join(config,'skills'),destination=join(skills,skillName);
 await mkdir(skills,{recursive:true,mode:0o700});active();
 // Never overwrite an existing installation with divergent contents.
 let existing=null;try{existing=await tree(destination,active);}catch(error){if(error?.code!=='ENOENT')throw error;}
 if(existing&&existing.sha256!==original.sha256)throw fail('隔离技能副本与原安装不一致','wb_skill_copy_conflict');
 if(!existing){
  await mkdir(destination,{mode:0o700});
  for(const entry of original.entries){active();const target=join(destination,...entry.path.split('/'));await mkdir(resolve(target,'..'),{recursive:true,mode:0o700});await copyFile(join(source,...entry.path.split('/')),target);}
 }
 const copied=await tree(destination,active),unchanged=await tree(source,active);
 if(copied.sha256!==original.sha256||unchanged.sha256!==original.sha256)throw fail('市场技能复制校验未通过','wb_skill_copy_changed');
 const fixtureId=randomUUID(),expectedText='WB_MARKET_SAMPLE_'+fixtureId.replaceAll('-',''),inputPath=join(cwd,'wb-markitdown-'+fixtureId+'.html'),outputPath=join(cwd,'wb-markitdown-'+fixtureId+'.md');
 await writeFile(inputPath,'<!doctype html>\n<html><head><meta charset="utf-8"><title>WorkBuddy local sample</title></head><body><h1>'+expectedText+'</h1><p>Collect, classify, and archive this local sample.</p><ul><li>Input: HTML</li><li>Output: Markdown</li></ul></body></html>\n',{flag:'wx',mode:0o600});active();
 // Pin the official shell selection, so the exact approval and actual invocation
 // agree on Windows even when Git Bash is absent or installed later.
 const shell=process.platform==='win32'?'powershell':'sh',command=(shell==='powershell'?'& ':'')+quote(python,shell)+' -m markitdown '+quote(inputPath,shell)+' -o '+quote(outputPath,shell);
 env.CODEBUDDY_CODE_SHELL=shell;env.CODEBUDDY_SESSION_SKILL_DIRS=skills;
 env.CODEBUDDY_CONFIG_DIR=config;env.WORKBUDDY_CONFIG_DIR=config;
 const feature={kind:'market_skill',skillName,skillId:String(marketId),skillVersion:metadata.version,originalTreeSha256:original.sha256,copiedTreeSha256:copied.sha256,fileCount:original.entries.length,sourceDirectory:source,installedDirectory:destination,pythonExecutable:python,markitdownVersion:dependency.markitdown,inputPath,outputPath,expectedText,command,shell};
 const prompt='使用真实市场技能完成本地 HTML 到 Markdown 转换。必须先调用 Skill，skill="'+skillName+'"，完整遵守已安装技能说明。随后仅用 Bash 原样执行以下单条命令，不安装包、不访问网络、不创建或修改其他文件：\n'+command+'\n再用 Read 读取实际输出文件 '+outputPath+'，确认包含 '+expectedText+' 和 Collect, classify, and archive this local sample.。不要用 Write、手写或复述代替转换。最终简短报告转换结果。';
 return {args:[],prompt,requireTool:/^Skill$/,permissionRules:['Skill('+skillName+')','Read('+inputPath+')','Read('+outputPath+')','Bash('+command+')'],feature,
  async verifyResult(result,context={}){
   active();if(result?.valid!==true||resolve(context.cwd??cwd)!==resolve(cwd))return false;
   const names=new Set((result.completedTools??[]).map(item=>item.name));if(!['Skill','Bash','Read'].every(name=>names.has(name))||names.has('Write'))return false;
   try{
    const stat=await lstat(outputPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<expectedText.length||stat.size>1024*1024)return false;
    const actualPath=await realpath(outputPath),actualCwd=await realpath(cwd);if(!childOf(actualCwd,actualPath))return false;
    const text=await readFile(outputPath,'utf8');active();
    // MarkItDown/markdownify escapes literal underscores in HTML headings.
    // Compare their rendered semantics without rewriting the actual artifact;
    // the evidence digest below remains a hash of the original output bytes.
    const semanticText=text.replace(/\\_/g,'_');
    const valid=semanticText.includes(expectedText)&&semanticText.includes('Collect, classify, and archive this local sample.')&&/^#\s+WB_MARKET_SAMPLE_/m.test(semanticText)&&!/<(?:html|body|h1)\b/i.test(text);
    if(valid){feature.outputSha256=hash(text);feature.outputBytes=stat.size;}return valid;
   }catch(error){active();return false;}
  }};
}
