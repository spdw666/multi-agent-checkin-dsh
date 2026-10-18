// Read-only activation inspection. Never runs key_cmd, provider discovery,
// client executables, credential refresh, or model/health requests upstream.
import {open, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, timingSafeEqual} from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundleName = 'dsh-ai-credit-gateway';
const pluginName = 'ai-credit-reliability';
const integrationFiles = ['package.json', 'bundle/index.mjs', 'bundle/worker.mjs',
  'bundle/model-refresh.mjs', 'bundle/request-policy.mjs', 'bundle/retry-metadata.mjs',
  'src/client-contract.mjs', 'src/request-timeouts.mjs', 'src/server.mjs',
  'src/router.mjs', 'src/model-relay.mjs'];
const stageLabels = {installed:'已安装', configured:'已配置', diskSynced:'磁盘代码已同步',
  runtimeLoaded:'当前进程已加载', modelPublished:'所选模型已发布', acceptance:'实际验收'};
const hash = value => createHash('sha256').update(value).digest('hex');
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : null;
const check = (key, status, evidence) => ({status, label:stageLabels[key], evidence});
const knownPath = value => typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
const samePath = (a, b) => !!a && !!b && resolve(a).replaceAll('\\','/').toLowerCase() === resolve(b).replaceAll('\\','/').toLowerCase();
const missing = result => result.error === 'missing';
const secretMatches=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);

// Trusted-host receipt collectors use this digest. It is never an HTTP proof
// parameter or a report field. Endpoint, pool, account/upstream switches and the
// current model key are all bound; private values are never returned.
export function clientActivationConfigurationFingerprint(config, {apiKey}={}) {
  return hash(canonical({config,key:typeof apiKey==='string'?hash(apiKey):null}));
}

async function localRead(file, {signal, maxBytes}) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw Object.assign(new Error(), {code:'INSPECTION_LIMIT'});
    return await handle.readFile({signal});
  } finally { await handle.close(); }
}

// This deliberately supports only simple configuration scalars and lists. YAML
// aliases/tags/multiline commands remain unknown; no YAML object constructors run.
function yamlTrim(raw) {
  let quote=null;
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    if(quote==='"'&&c==='\\'){i++;continue;}
    if(quote==="'"&&c==="'"&&raw[i+1]==="'"){i++;continue;}
    if(quote&&c===quote){quote=null;continue;}
    if(!quote&&(c==='"'||c==="'")){quote=c;continue;}
    if(!quote&&c==='#'&&(i===0||/\s/.test(raw[i-1])))return raw.slice(0,i).trim();
  }
  return quote?undefined:raw.trim();
}
function scalar(raw) {
  const value = yamlTrim(raw);
  if(value===undefined)return undefined;
  if (!value || /^(?:[|>&*!]|!!)/.test(value)) return undefined;
  if (value.startsWith('"')) {try {return JSON.parse(value);} catch {return undefined;}}
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1,-1).replaceAll("''", "'") : undefined;
  return value;
}
function inlineList(raw) {
  if(!raw.startsWith('[')||!raw.endsWith(']'))return null;
  if(raw==='[]')return [];
  const values=raw.slice(1,-1).split(',').map(part=>scalar(part));
  return values.every(v=>typeof v==='string'&&!/[\[\]{}]|:\s/.test(v))?values:null;
}
function yamlScalarShape(raw) {
  if(!raw)return true;
  if(raw.startsWith('['))return inlineList(raw)!==null;
  if(raw==='{}')return true;
  if(scalar(raw)===undefined)return false;
  if(!/^['"]/.test(raw)&&(/[\[\]{}]|:\s|^[?\-]\s/.test(raw)))return false;
  return true;
}
function yamlLogicalLines(text) {
  const physical=text.replace(/^\uFEFF/,'').split(/\r?\n/),logical=[];
  for(let i=0;i<physical.length;i++){
    let line=physical[i];
    const field=/^( *)(?:"[A-Za-z0-9_.-]+"|'[A-Za-z0-9_.-]+'|[A-Za-z0-9_.-]+)\s*:\s*(".*)$/.exec(line);
    if(field&&yamlTrim(field[2])===undefined){
      // YAML double-quoted backslash line continuation removes the physical
      // newline and continuation indentation; it does NOT insert a space.
      // Other multiline scalar styles stay unknown rather than being guessed.
      let raw=field[2],count=0;
      while(yamlTrim(raw)===undefined){
        const escapes=/(\\+)$/.exec(raw)?.[1].length??0;
        if(escapes%2!==1||++count>32||i+1>=physical.length)return null;
        const next=physical[++i],indent=/^( *)/.exec(next)[1].length;
        if(!next.trim()||indent<=field[1].length||/^ *\t/.test(next))return null;
        raw=raw.slice(0,-1)+next.trimStart();
      }
      line=line.slice(0,line.indexOf(field[2]))+raw;
    }
    logical.push(line);
  }
  return logical;
}
const yamlStringToken=raw=>{
  const value=yamlTrim(raw);
  return value!==undefined&&( /^['"]/.test(value)||! /^(?:true|false|null|~|[-+]?(?:\d+(?:\.\d*)?(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan))$/i.test(value));
};
function yamlMap(text) {
  const entries = new Map(), stack = [];
  const lines=yamlLogicalLines(text);if(!lines)return null;
  const keyPattern=/^(?:"([A-Za-z0-9_.-]+)"|'([A-Za-z0-9_.-]+)'|([A-Za-z0-9_.-]+))\s*:(.*)$/;
  const path=segments=>segments.map(segment=>segment.replaceAll('~','~0').replaceAll('.','~1')).join('.');
  const addField=(indent,match)=>{
    while(stack.length&&stack.at(-1).indent>=indent)stack.pop();
    const parent=stack.at(-1);
    if(!parent&&indent!==0||parent&&(parent.raw||parent.list||parent.childIndent!==undefined&&parent.childIndent!==indent))return false;
    if(parent)parent.childIndent=indent;
    const name=match[1]??match[2]??match[3],key=path([...stack.map(item=>item.key),name]);
    if(entries.has(key))return false;
    const raw=yamlTrim(match[4]);if(raw===undefined||!yamlScalarShape(raw))return false;
    const entry={raw,value:scalar(raw)};entries.set(key,entry);
    stack.push({indent,key:name,raw,entry});return true;
  };
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s*\t/.test(line)) return null;
    const item=/^( *)-( +)(.*)$/.exec(line);
    if(item){
      const indent=item[1].length;
      // A block sequence may be indentless relative to its mapping key. Locate
      // only its own container, never reinterpret a scalar or mapping sibling.
      const at=stack.findLastIndex(node=>!node.synthetic&&!node.raw&&node.indent<=indent&&(node.list?node.listIndent===indent:node.childIndent===undefined));
      if(at<0)return null;
      stack.splice(at+1);const parent=stack[at],entry=parent.entry;
      parent.list=true;parent.listIndent=indent;
      entry.list??=[];entry.listStringOnly??=true;
      const mapping=keyPattern.exec(item[3]);
      if(mapping){
        const index=entry.list.length;entry.list.push(null);entry.listStringOnly=false;
        stack.push({indent,key:'~item'+index,raw:'',synthetic:true});
        if(!addField(indent+1+item[2].length,mapping))return null;
      }else{
        if(!yamlScalarShape(item[3])||scalar(item[3])===undefined)return null;
        entry.list.push(scalar(item[3]));entry.listStringOnly&&=yamlStringToken(item[3]);
      }
      continue;
    }
    const indent=/^( *)/.exec(line)[1].length,match=keyPattern.exec(line.slice(indent));
    if(!match||!addField(indent,match))return null;
  }
  return entries;
}
function yamlList(entry) {
  if (!entry) return [];
  if (entry.list) return entry.listStringOnly?entry.list:null;
  const raw = entry.raw.trim();
  if (!raw.startsWith('[') || !raw.endsWith(']')) return null;
  if(raw!=='[]'&&raw.slice(1,-1).split(',').some(item=>!yamlStringToken(item)))return null;
  return inlineList(raw);
}
function patchConfig(text) {
  text=text.replace(/^\uFEFF/,'');
  const visible=text.split(/\r?\n/).filter(line=>line.trim()&&!/^\s*#/.test(line));
  if(visible[0]?.trim()==='---')visible.shift();
  const root=/^( *)-(?:\s|$)/.exec(visible[0]??'');
  if(!root)return undefined;
  const rootIndent=root[1].length;
  if(visible.some(line=>{const indent=/^( *)/.exec(line)[1].length;return indent<rootIndent||indent===rootIndent&&!/^\s*-(?:\s|$)/.test(line);}))return undefined;
  const values=[];
  for (const block of text.split(/\r?\n(?=\s*-\s+id\s*:)/)) {
    // Only direct entries at the document's root sequence indentation bind
    // this profile. Nested insert/unrelated sequences never become targets.
    const id = /^( *)-\s+id\s*:\s*(.+)$/m.exec(block);
    if (!id||id[1].length!==rootIndent||scalar(id[2])!==bundleName) continue;
    const lines=block.split(/\r?\n/),index=lines.findIndex(line=>/^\s*-\s+id\s*:/.test(line));
    const indent=/^( *)-/.exec(lines[index])?.[1].length;
    const mapping=lines.slice(index).map((line,i)=>i===0?line.slice(indent).replace(/^-\s+/,''):line.trim()&&!/^\s*#/.test(line)?line.slice(indent+2):line).join('\n');
    const parsed=yamlMap(mapping);
    if(!parsed)return undefined;
    if(parsed.has('disabled')&&parsed.get('disabled').raw!=='false')return undefined;
    if(parsed.has('config'))values.push(parsed.get('config.configFile')?.value);
  }
  return values.length===1?values[0]:undefined;
}
function commandWords(value) {
  if (typeof value !== 'string' || /[\r\n;&|<>`$]/.test(value)) return null;
  const words = [], expression = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/gy;
  let position = 0;
  while (position < value.length) {
    expression.lastIndex = position;
    const match = expression.exec(value);
    if (!match) return value.slice(position).trim() ? null : words;
    words.push(match[1]??match[2]??match[3]);position=expression.lastIndex;
  }
  return words;
}
function endpointMatches(value, server) {
  try {const u = new URL(value);return u.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname) && u.port===String(server?.port) && u.pathname.replace(/\/$/,'')==='/v1' && !u.username && !u.password && !u.search && !u.hash;} catch {return false;}
}
function fresh(evidence, now, maxAgeMs) {
  const time = Date.parse(evidence?.observedAt);
  return evidence?.direct===true && Number.isFinite(time) && time<=now+5000 && now-time<=maxAgeMs;
}
function applyDirectEvidence(item, evidence, {now, fingerprint, clientConfigFingerprint, configFingerprint, configuredRoutes, runtimeVersion, maxAgeMs}) {
  if(item.stages.configured.status!=='passed'||!fingerprint||!clientConfigFingerprint)return;
  const bound=proof=>proof?.configFingerprint===configFingerprint&&proof?.clientConfigFingerprint===clientConfigFingerprint&&proof?.codeFingerprint===fingerprint;
  const runtime = evidence?.runtime;
  if (fresh(runtime,now,maxAgeMs) && runtime.source==='active-runtime-handshake' && bound(runtime)) {
    item.stages.runtimeLoaded=check('runtimeLoaded','passed','当前客户端运行握手与本次磁盘集成指纹一致。');
  }
  const publication = evidence?.publication;
  if (fresh(publication,now,maxAgeMs) && publication.source==='client-model-registry' && bound(publication) && configuredRoutes>0 && publication.count===configuredRoutes) {
    item.stages.modelPublished=check('modelPublished','passed','当前客户端模型注册表已直接核对本次启用路由。');
  }
  const acceptance = evidence?.acceptance;
  if (runtimeVersion && configuredRoutes>0 && fresh(acceptance,now,maxAgeMs) && acceptance.source==='client-task-receipt' && bound(acceptance) && acceptance.gatewayVersion===runtimeVersion && acceptance.ordinary===true && acceptance.toolsExecuted===true && acceptance.toolResultReturned===true && acceptance.finalAnswer===true) {
    item.stages.acceptance=check('acceptance','passed','本次版本及路由有真实普通回答、工具执行、结果回传和最终回答回执。');
  }
}

/**
 * Pure read-only report. options is trusted host dependency injection, never an
 * HTTP request body: paths, readFile, runtimeVersion, now and direct evidence.
 * Statuses describe separate stages; configuration and disk never imply runtime.
 */
export async function clientActivationReport(service, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const env=options.env??process.env, home=options.home??homedir(), paths=options.paths??{};
  const sourceRoot=paths.sourceRoot??root;
  const dshHome=paths.dshHome??env.DSH_HOME??join(home,'.dsh');
  const hermesHome=paths.hermesHome??env.HERMES_HOME??join(home,'.hermes');
  const hermesSource=paths.hermesSource??env.HERMES_SOURCE??join(hermesHome,'hermes-agent');
  const timeoutMs=Number.isInteger(options.timeoutMs)?Math.max(10,Math.min(2000,options.timeoutMs)):1000;
  const reader=options.readFile??localRead, cache=new Map(),invalidJson=new Set();
  const exists = async file => {
    if(!knownPath(file))return false;
    let timer;
    try {
      const info=await Promise.race([(options.statFile??stat)(file),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error()),timeoutMs);})]);
      return info.isFile();
    } catch {return false;} finally {clearTimeout(timer);}
  };
  const read = file => {
    if (!file) return Promise.resolve({error:'missing'});
    if (!cache.has(file)) cache.set(file,(async()=>{
      let timer;const controller=new AbortController();
      try {
        const bytes=await Promise.race([Promise.resolve().then(()=>reader(file,{signal:controller.signal,maxBytes:2097152})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error(),{code:'INSPECTION_TIMEOUT'}));},timeoutMs);})]);
        if (Buffer.byteLength(bytes)>2097152) return {error:'limit'};
        return {bytes:Buffer.from(bytes), text:Buffer.from(bytes).toString('utf8')};
      } catch (e) {return {error:e?.code==='ENOENT'?'missing':e?.code==='INSPECTION_TIMEOUT'?'timeout':'unreadable'};}
      finally {clearTimeout(timer);}
    })());
    return cache.get(file);
  };
  const json = async file => {const result=await read(file);if(result.error)return result;try{return {...result,value:JSON.parse(result.text.replace(/^\uFEFF/,''))};}catch{invalidJson.add(file);return {error:'invalid'};}};
  const compare = async pairs => {
    const values=await Promise.all(pairs.map(async([source,target])=>[await read(source),await read(target)]));
    if(values.some(([a,b])=>a.error||b.error))return {status:'unknown'};
    const expected=values.map(([a])=>hash(a.bytes)),actual=values.map(([,b])=>hash(b.bytes));
    return {status:expected.every((h,i)=>h===actual[i])?'passed':'mismatch',fingerprint:hash(JSON.stringify(actual))};
  };
  const config=structuredClone(service?.config?.value??{}), runtimeVersion=version(options.runtimeVersion);
  const configFingerprint=clientActivationConfigurationFingerprint(config,{apiKey:service?.keys?.apiKey}), configuredRoutes=(config.routes??[]).filter(r=>r.enabled!==false).length;
  const diskPackage=await json(join(sourceRoot,'package.json')), diskVersion=version(diskPackage.value?.version);
  const create = (id,name) => ({id,name,version:null,expectedVersion:null,stages:{
    installed:check('installed','unknown','尚无精确安装证据。'),
    configured:check('configured','unknown','尚无精确配置证据。'),
    diskSynced:check('diskSynced','unknown','尚无完整的本次集成文件比对证据。'),
    runtimeLoaded:check('runtimeLoaded','unknown','磁盘与配置不证明当前客户端进程已加载。'),
    modelPublished:check('modelPublished','unknown','未读取当前客户端模型注册表；启用路由不等于已发布。'),
    acceptance:check('acceptance','notRun','本次检查未生成模型请求；未读取到本次环境的真实任务验收回执。')
  },nextActions:[],notes:[]});
  const gateway=create('gateway','AI积分网关');gateway.version=runtimeVersion;gateway.expectedVersion=diskVersion;
  gateway.stages.installed=check('installed',diskVersion?'passed':missing(diskPackage)?'missing':'error',diskVersion?'已读取本次网关安装包元数据。':'网关安装包元数据缺失或未能解析。');
  const keyPresent=typeof service?.keys?.apiKey==='string'&&service.keys.apiKey.length>=24;
  gateway.stages.configured=check('configured',config.server&&keyPresent?'passed':'missing',config.server&&keyPresent?'当前服务配置和本机模型密钥形状已就绪；未回显密钥。':'当前服务配置或本机模型密钥未就绪。');
  gateway.stages.runtimeLoaded=check('runtimeLoaded',runtimeVersion?(diskVersion===runtimeVersion?'passed':'pendingReload'):'unknown',runtimeVersion?(diskVersion===runtimeVersion?'本检查由已启动服务处理，启动版本与磁盘包版本一致；不代替客户端加载证明。':'服务启动版本与磁盘包版本不同，仍需在空闲时重载。'):'缺少服务启动时锁定的版本证据。');
  gateway.stages.diskSynced=check('diskSynced',runtimeVersion&&diskVersion&&runtimeVersion!==diskVersion?'mismatch':'unknown','仅比较版本号不证明运行代码与磁盘代码哈希一致。');
  gateway.notes.push(`本机配置有 ${configuredRoutes} 条启用路由；本检查不刷新供应目录，也不宣称这些路由已在客户端发布。`);
  if(gateway.stages.runtimeLoaded.status==='pendingReload')gateway.nextActions.push({code:'reload_gateway_when_idle',label:'网关空闲后重载，再核对启动版本。'});

  const record=await json(paths.dshRecord??(service?.config?.dataDir?join(service.config.dataDir,'dsh-install','record.json'):null));
  const profile=paths.dshProfile??knownPath(record.value?.profile)??join(dshHome,'profiles','desktop');
  const dshPackageRoot=paths.dshPackageRoot??join(profile,'node_modules',bundleName);
  const [profilePackage,installedPackage,patch]=await Promise.all([json(join(profile,'package.json')),json(join(dshPackageRoot,'package.json')),read(join(profile,'cordis.patch.yml'))]);
  const dsh=create('dsh','DeepSeek Harness');dsh.version=installedPackage.value?.name===bundleName?version(installedPackage.value?.version):null;dsh.expectedVersion=diskVersion;
  dsh.stages.installed=check('installed',dsh.version?'passed':missing(installedPackage)&&missing(profilePackage)?'missing':'error',dsh.version?'已读取精确 DSH profile 中的网关 bundle 安装元数据。':'精确 DSH profile 未发现可核对的网关 bundle。');
  const enabled=Array.isArray(profilePackage.value?.dsh?.profile?.bundles)&&profilePackage.value.dsh.profile.bundles.includes(bundleName);
  const configuredFile=!patch.error?patchConfig(patch.text):null;
  const dshConfigError=[profilePackage,patch].some(result=>result.error&&!missing(result));
  dsh.stages.configured=check('configured',dshConfigError?'error':enabled&&samePath(configuredFile,service?.config?.file)?'passed':'missing',dshConfigError?'DSH profile 配置不可读或 JSON 解析失败；不把错误当作未配置。':enabled&&samePath(configuredFile,service?.config?.file)?'profile 已启用目标 bundle，且只读核对其绑定当前网关配置。':'目标 bundle 未启用、配置绑定缺失或不是当前网关配置。');
  const dshConfigFingerprint=!profilePackage.error&&!patch.error?hash(JSON.stringify([hash(profilePackage.bytes),hash(patch.bytes)])):null;
  const dshComparison=dsh.version?await compare(integrationFiles.map(file=>[join(sourceRoot,file),join(dshPackageRoot,file)])):{status:'unknown'};
  dsh.stages.diskSynced=check('diskSynced',dsh.version&&diskVersion&&dsh.version!==diskVersion?'mismatch':dshComparison.status,dshComparison.status==='passed'?'DSH 已安装的 11 个网关关键集成文件与当前源码逐字节一致；只证明这些磁盘文件。':dshComparison.status==='mismatch'?'DSH 磁盘关键集成文件与当前源码有差异。':'尚未获得 DSH 全部关键集成文件的有效比对。');
  if(dsh.stages.configured.status==='passed')dsh.stages.runtimeLoaded=check('runtimeLoaded','pendingReload','DSH profile 已配置；缺少当前活动客户端的加载握手，磁盘状态另列，不推断已生效。');
  if(dsh.stages.installed.status!=='passed')dsh.nextActions.push({code:'install_dsh_bundle',label:'在选定 DSH profile 安装网关 bundle，再执行只读检查。'});
  else if(dsh.stages.diskSynced.status!=='passed')dsh.nextActions.push({code:'review_dsh_disk_diff',label:'先核对 DSH 磁盘差异，保留配置后再决定同步。'});
  if(dsh.stages.configured.status!=='passed')dsh.nextActions.push({code:'review_dsh_binding',label:'核对 DSH profile 的 bundle 启用项与网关配置绑定。'});

  const [hermesConfig,pluginManifest,pluginCode,hermesProject,hermesCli]=await Promise.all([
    read(paths.hermesConfig??join(hermesHome,'config.yaml')),
    read(join(hermesHome,'plugins',pluginName,'plugin.yaml')),
    read(join(hermesHome,'plugins',pluginName,'__init__.py')),
    read(join(hermesSource,'pyproject.toml')),read(join(hermesSource,'hermes_cli','__init__.py'))]);
  const hermes=create('hermes','Hermes');hermes.expectedVersion=null;
  const metadata=!hermesProject.error?/^version\s*=\s*"([^"]+)"/m.exec(hermesProject.text):null;
  hermes.version=version(metadata?.[1]);
  hermes.stages.installed=check('installed',!hermesProject.error&&!hermesCli.error?'passed':[hermesConfig,pluginManifest,hermesProject,hermesCli].every(missing)?'missing':'unknown',!hermesProject.error&&!hermesCli.error?'已读取精确 Hermes 安装源元数据及 CLI 模块。':'未定位完整 Hermes 安装源；配置文件存在不独自证明客户端已安装。');
  const yaml=!hermesConfig.error?yamlMap(hermesConfig.text):null;
  const provider=key=>yaml?.get('providers.ai-credit.'+key)?.value;
  const providerPresent=!!yaml?.has('providers.ai-credit');
  const unsupportedYaml=!hermesConfig.error&&(!yaml||!yaml.size||!!yaml.get('providers')?.raw||!!yaml.get('providers.ai-credit')?.raw);
  const keyCommand=commandWords(provider('key_cmd'));
  const inlineProvided=typeof provider('api_key')==='string'&&!!provider('api_key');
  const inlineCredential=inlineProvided?(keyPresent&&secretMatches(provider('api_key'),service.keys.apiKey)?'present':'mismatch'):'missing';
  let credential=inlineCredential;
  if(keyCommand?.length===3&&samePath(keyCommand[2],service?.keysFile)) {
    const actual=await read(keyCommand[1]),expected=await read(join(sourceRoot,'scripts','hermes-key.mjs'));
    const helperKeys=await json(service.keysFile);
    const executable=await exists(keyCommand[0]);
    // Only stat the executable. A large Node binary is never read or run.
    if(!keyPresent)credential='missing';
    else if(!helperKeys.error&&typeof helperKeys.value?.apiKey==='string'&&!secretMatches(helperKeys.value.apiKey,service.keys.apiKey))credential='mismatch';
    else if(!actual.error&&!expected.error&&hash(actual.bytes)===hash(expected.bytes)&&executable&&!helperKeys.error&&secretMatches(helperKeys.value?.apiKey,service.keys.apiKey))credential='present';
    else credential='unknown';
  } else if(provider('key_cmd'))credential='unknown';
  if(inlineProvided&&provider('key_cmd')&&(inlineCredential!=='present'||credential!=='present'))credential='unknown';
  const hermesConfigured=providerPresent&&endpointMatches(provider('base_url'),config.server)&&credential==='present';
  hermes.stages.configured=check('configured',hermesConfigured&&!unsupportedYaml?'passed':hermesConfig.error&&!missing(hermesConfig)?'error':unsupportedYaml||providerPresent&&credential==='unknown'?'unknown':credential==='mismatch'?'mismatch':'missing',hermesConfigured&&!unsupportedYaml?'命名 Provider 指向当前本机网关，凭据配置已核对当前模型密钥；key_cmd 从未执行。':unsupportedYaml?'配置存在，但该 YAML 形态或重复键未被本次有限只读解析器确认。':credential==='mismatch'?'Provider 的本机模型密钥与当前服务不一致；未回显密钥。':providerPresent&&credential==='unknown'?'Provider 存在，但凭据 helper 的静态形状未完整核对；未执行任何命令。':'命名 Provider、本机端点或凭据配置缺失。');
  const hermesConfigFingerprint=!hermesConfig.error?hash(JSON.stringify([hash(hermesConfig.bytes)])):null;
  const enabledPlugins=yamlList(yaml?.get('plugins.enabled')),disabledPlugins=yamlList(yaml?.get('plugins.disabled'));
  const manifestMap=!pluginManifest.error?yamlMap(pluginManifest.text):null;
  const pluginConfigured=Array.isArray(enabledPlugins)&&Array.isArray(disabledPlugins)&&enabledPlugins.includes(pluginName)&&!disabledPlugins.includes(pluginName)&&manifestMap?.get('name')?.value===pluginName;
  const hermesComparison=pluginConfigured?await compare([
    [join(sourceRoot,'integrations','hermes',pluginName,'plugin.yaml'),join(hermesHome,'plugins',pluginName,'plugin.yaml')],
    [join(sourceRoot,'integrations','hermes',pluginName,'__init__.py'),join(hermesHome,'plugins',pluginName,'__init__.py')],
    [join(sourceRoot,'integrations','hermes','native-patch','agent','chat_completion_helpers.py'),join(hermesSource,'agent','chat_completion_helpers.py')]
  ]):{status:'unknown'};
  hermes.stages.diskSynced=check('diskSynced',hermesComparison.status,hermesComparison.status==='passed'?'目标官方插件已明确启用，插件两文件及配套原生集成文件与当前源码哈希一致；不证明活动进程加载。':hermesComparison.status==='mismatch'?'目标插件或配套原生集成文件与当前源码有差异。':'目标插件启用项或配套集成文件比对仍待核对。');
  if(hermes.stages.configured.status==='passed')hermes.stages.runtimeLoaded=check('runtimeLoaded','pendingReload','Hermes Provider 已配置；缺少当前活动客户端加载握手，不把官方离线插件加载测试当活动进程证明。');
  if(hermes.stages.installed.status!=='passed')hermes.nextActions.push({code:'locate_hermes_install',label:'设置实际 HERMES_HOME 与 HERMES_SOURCE 后，再核对精确安装源。'});
  if(!hermesConfigured)hermes.nextActions.push({code:'review_hermes_provider',label:'核对命名 ai-credit Provider、本机端点及本机凭据 helper，不执行 helper 诊断输出。'});
  if(!pluginConfigured||hermesComparison.status!=='passed')hermes.nextActions.push({code:'review_hermes_integration',label:'核对目标插件启用项与集成文件差异，保留其他插件和 Provider。'});

  const configurationChanged=clientActivationConfigurationFingerprint(service?.config?.value??{},{apiKey:service?.keys?.apiKey})!==configFingerprint;
  for(const [item,fingerprint,clientConfigFingerprint] of [[gateway,null,null],[dsh,dshComparison.fingerprint,dshConfigFingerprint],[hermes,hermesComparison.fingerprint,hermesConfigFingerprint]]) {
    if(!configurationChanged)applyDirectEvidence(item,options.evidence?.[item.id],{now,fingerprint,clientConfigFingerprint,configFingerprint,configuredRoutes,runtimeVersion,maxAgeMs:Math.max(1000,Math.min(3600000,options.evidenceMaxAgeMs??300000))});
    else if(item.stages.configured.status==='passed')item.stages.configured=check('configured','unknown','检查期间服务配置发生变化；本次旧配置回执不再作为生效证明。');
    if(item.stages.configured.status==='passed'&&item.stages.runtimeLoaded.status!=='passed')item.nextActions.push({code:'confirm_active_client_load',label:'客户端空闲时重新加载后，核对活动运行握手；本检查不重启进程。'});
    if(item.stages.modelPublished.status!=='passed')item.nextActions.push({code:'verify_client_model_registry',label:'在客户端核对所选模型目录，保留完整路由 ID；本检查不刷新供应目录。'});
    if(item.stages.acceptance.status!=='passed')item.nextActions.push({code:'run_explicit_client_acceptance',label:'由用户选择普通回答及真实工具执行、结果回传验收；本检查不发起生成。'});
  }
  const errors=[...cache.values()];
  const settled=await Promise.all(errors),counts={timeout:settled.filter(r=>r.error==='timeout').length,unreadable:settled.filter(r=>['unreadable','limit'].includes(r.error)).length+invalidJson.size};
  return {schemaVersion:1,checkedAt:new Date(now).toISOString(),readOnly:true,
    checks:[gateway,dsh,hermes],diagnostics:{timedOutReads:counts.timeout,unreadableReads:counts.unreadable},
    notes:['所有检查均为本机限定文件只读；未执行命令、重启、切账号、刷新凭据或发送模型请求。','缺少运行加载或真实任务回执时保留未知，不把安装、配置、磁盘同步互相替代。']};
}

export default clientActivationReport;
