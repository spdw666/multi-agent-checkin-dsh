#!/usr/bin/env node
// Offline release boundary audit. Reports codes and entry names, never matched
// credentials or private strings. No backend, browser, account or network calls.
import {readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {resolve,join,extname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {pathToFileURL,fileURLToPath} from 'node:url';

const MAX_ENTRY=160*1024*1024,MAX_TOTAL=320*1024*1024,MAX_FILES=5000;
const hash=b=>createHash('sha256').update(b).digest('hex');
const icons=new Set('antigravity bigmodel cline codearts codebuddy codebuddy-cn freeapi hailuo jimeng kling liblib lobster loomy minimax nvidia opencode pixverse qoder qoder-cn qwenwork raccoon trae vidu workbuddy workbuddyai xiaoyunque zcode'.split(' '));
const exact=new Set(['AI积分网关.exe','AiCredit.WebView2.exe','AI积分网关.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','app-logo.png','app-logo-rounded.ico','BUILD-MANIFEST.json','gateway.portable.json','checksums.sha256','README.md','launch.ps1','启动新版工作台.cmd','创建桌面快捷方式.ps1','ui/index.html','ui/styles.css','ui/management.css','ui/management.js','ui/app.js','ui/demo.json','ui/assets/fonts/Montserrat-Regular.otf','ui/assets/fonts/Montserrat-Bold.otf','ui/assets/fonts/OFL-1.1.txt','ui/assets/fonts/THIRD_PARTY_FONTS.md','adapter/snapshot.mjs','adapter/control.mjs','adapter/management.mjs','adapter/management-contract.json','prerequisites/MicrosoftEdgeWebview2Setup.exe','prerequisites/PROVENANCE.json','licenses/Node-LICENSE.txt','licenses/Node-SHASUMS256.txt','licenses/WebView2-LICENSE.txt','licenses/WebView2-NOTICE.txt','runtime/node.exe','core/package.json','core/config.example.json','core/config.first-run.json','core/LICENSE','core/THIRD_PARTY_NOTICES.md','core/cordis.patch.yml','core/vendor/workbuddy-core.mjs','core/vendor/trae-core.mjs','core/vendor/wb-auth-helper.cjs','core/vendor/qwen-pack.py','core/vendor/qwen-requirements.txt','core/vendor/zcode-context/identity.mjs','core/vendor/zcode-context/system-prompt.mjs','core/vendor/zcode-context/zcode_system.json','core/vendor/zcode-context/NOTICE.md','core/scripts/install-autostart.ps1','core/scripts/uninstall-autostart.ps1','core/scripts/restart-dsh.ps1','core/scripts/hermes-key.mjs']);
const required=['AI积分网关.exe','AI积分网关.exe.config','gateway.portable.json','core/config.first-run.json','core/package.json','core/bin/ai-credit.mjs','core/src/service.mjs','core/vendor/workbuddy-core.mjs','core/vendor/trae-core.mjs','runtime/node.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','ui/index.html','ui/app.js','ui/management.js','ui/management.css','adapter/management.mjs','adapter/management-contract.json','prerequisites/MicrosoftEdgeWebview2Setup.exe','prerequisites/PROVENANCE.json','licenses/Node-LICENSE.txt','licenses/Node-SHASUMS256.txt','licenses/WebView2-LICENSE.txt','README.md','BUILD-MANIFEST.json'];
const forbiddenSegments=/^(?:data|user-data|node_modules|\.git|profiles?|browser[-_]?profiles?|webview[-_]?profiles?|cache|caches|exports?|logs?|_capture|captures?|screenshots?|localstorage|sessionstorage|default)$/i;
const forbiddenFiles=/^(?:config\.local\.json|desktop\.local\.json|api-keys\.json|runtime\.json|cookies|login data|web data|history|preferences|local state)$/i;
const forbiddenExtensions=/\.(?:sqlite(?:3)?(?:-wal|-shm)?|db(?:-wal|-shm)?|log|bak|dmp|pfx|p12|pem|key|har|jsonl|map)$/i;
const trustedHashes=new Map([
 ['runtime/node.exe','9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e'],
 ['Microsoft.Web.WebView2.Core.dll','acdd517b951829f763d1255f32df1e6a936cb8623a7ebff6b8b24172dede6bd6'],
 ['Microsoft.Web.WebView2.WinForms.dll','c66437f80886aecf074804b61af4cc10ad90a95310c8e0a717f31ea377c26b03'],
 ['WebView2Loader.dll','d3fce90bdeecb08596e377dea6a316354dd8949e32ff09b89d51be00c14e21b6'],
 ['prerequisites/MicrosoftEdgeWebview2Setup.exe','13f6d9cdc8c3e7186e4b180db7f48e199ee97d631480e8391fb3106f338fb21a']
]);
export function binaryClassification(name,digest){return trustedHashes.get(name)===digest?'pinned-public-vendor-binary':/^(?:AI积分网关|AiCredit\.WebView2)\.exe$/.test(name)?'application-executable':'unrecognized-binary';}
function allowedName(name){
 if(exact.has(name))return true;
 const icon=name.match(/^(?:ui\/assets\/)?platform-icons\/([^/]+)\.png$/);if(icon)return icons.has(icon[1]);
 if(/^core\/(?:src|web|bin|bundle)\/[A-Za-z0-9_./-]+$/.test(name))return ['.mjs','.cjs','.js','.json','.html','.css','.wasm'].includes(extname(name));
 return /^core\/vendor\/[^/]*(?:LICENSE[^/]*|[^/]*\.LICENSE)$/i.test(name);
}
function canonical(name){if(typeof name!=='string'||!name||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||/[\x00-\x1f\x7f]/.test(name)||name.split('/').some(v=>v==='..'||v==='.'||/[ .]$/.test(v)||v.includes(':')||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(v))||name.includes('//'))throw Object.assign(new Error('unsafe_entry_path'),{code:'unsafe_entry_path'});return name;}
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes){let c=0xffffffff;for(const byte of bytes)c=crcTable[(c^byte)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
export function readZipEntries(bytes){
 if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0)throw Object.assign(new Error('zip_directory_missing'),{code:'zip_directory_missing'});
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+20)||count===65535||size===0xffffffff||offset===0xffffffff||offset+size!==end||count>MAX_FILES)throw Object.assign(new Error('zip_layout_unsupported'),{code:'zip_layout_unsupported'});
 const entries=[],ranges=[];let p=offset,total=0;
 for(let i=0;i<count;i++){
  if(p+46>offset+size||bytes.readUInt32LE(p)!==0x02014b50)throw Object.assign(new Error('zip_directory_invalid'),{code:'zip_directory_invalid'});
  const flags=bytes.readUInt16LE(p+8),method=bytes.readUInt16LE(p+10),crc=bytes.readUInt32LE(p+16),compressed=bytes.readUInt32LE(p+20),length=bytes.readUInt32LE(p+24),nameLength=bytes.readUInt16LE(p+28),extra=bytes.readUInt16LE(p+30),comment=bytes.readUInt16LE(p+32),local=bytes.readUInt32LE(p+42),attrs=bytes.readUInt32LE(p+38);
  if(p+46+nameLength+extra+comment>offset+size||![0,2048].includes(flags)||extra||comment||![0,8].includes(method)||length>MAX_ENTRY||(total+=length)>MAX_TOTAL||compressed===0xffffffff||length===0xffffffff||local+30>offset)throw Object.assign(new Error('zip_entry_unsupported'),{code:'zip_entry_unsupported'});
  const raw=bytes.subarray(p+46,p+46+nameLength);if(!(flags&2048)&&raw.some(b=>b>127))throw Object.assign(new Error('zip_name_encoding_unsupported'),{code:'zip_name_encoding_unsupported'});
  const name=canonical(raw.toString('utf8'));if((attrs>>>16&0xf000)===0xa000)throw Object.assign(new Error('symlink_forbidden'),{code:'symlink_forbidden'});
  if(bytes.readUInt32LE(local)!==0x04034b50)throw Object.assign(new Error('zip_local_header_invalid'),{code:'zip_local_header_invalid'});
  const localNameLength=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),start=local+30+localNameLength+localExtra;
  if(localExtra||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||start+compressed>offset||bytes.subarray(local+30,local+30+localNameLength).toString('utf8')!==name)throw Object.assign(new Error('zip_local_header_mismatch'),{code:'zip_local_header_mismatch'});
  const body=bytes.subarray(start,start+compressed),data=method===0?Buffer.from(body):inflateRawSync(body,{maxOutputLength:MAX_ENTRY});
  if(data.length!==length||crc32(data)!==crc)throw Object.assign(new Error('zip_crc_or_length_mismatch'),{code:'zip_crc_or_length_mismatch'});
  entries.push({name,data,directory:name.endsWith('/')});ranges.push([local,start+compressed]);p+=46+nameLength+extra+comment;
 }
 ranges.sort((a,b)=>a[0]-b[0]);let covered=0;for(const[start,end]of ranges){if(start!==covered)throw Object.assign(new Error('zip_uninventoried_payload'),{code:'zip_uninventoried_payload'});covered=end;}
 if(p!==offset+size||covered!==offset)throw Object.assign(new Error('zip_directory_size_mismatch'),{code:'zip_directory_size_mismatch'});return entries;
}
async function readDirectory(root){const entries=[];let total=0;async function walk(dir,prefix=''){for(const file of await readdir(dir,{withFileTypes:true})){const name=canonical(prefix+file.name),path=join(dir,file.name),stat=await lstat(path);if(stat.isSymbolicLink())throw Object.assign(new Error('symlink_forbidden'),{code:'symlink_forbidden'});if(stat.isDirectory()){entries.push({name:name+'/',directory:true,data:Buffer.alloc(0)});await walk(path,name+'/');}else if(stat.isFile()){if(stat.size>MAX_ENTRY||(total+=stat.size)>MAX_TOTAL||entries.length>=MAX_FILES)throw Object.assign(new Error('directory_size_limit'),{code:'directory_size_limit'});entries.push({name,data:await readFile(path)});}else throw Object.assign(new Error('special_file_forbidden'),{code:'special_file_forbidden'});}}await walk(root);return entries;}
function fileKind(data){
 if(data.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))return 'sqlite';
 if(data.length>=4&&[0x04034b50,0x06054b50,0x08074b50].includes(data.readUInt32LE(0)))return 'zip';
 if(data[0]===0x1f&&data[1]===0x8b)return 'gzip';
 if(data.subarray(0,6).equals(Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c])))return '7z';
 if(data.subarray(0,4).equals(Buffer.from('Rar!')))return 'rar';
 if(data.subarray(0,6).equals(Buffer.from([0xfd,0x37,0x7a,0x58,0x5a,0x00])))return 'xz';
 if(data.subarray(257,262).toString()==='ustar')return 'tar';
 if(data[0]===0x4d&&data[1]===0x5a)return 'pe';
 if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
 return 'text-or-resource';
}
const sensitivePatterns=[
 ['private_absolute_user_path',/[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|All Users\b|USERNAME\b|SAMPLE\b|HOST\b)[^\\/\r\n"'<>|\x00]{1,80}[\\/]|[A-Za-z]:[\\/]+AI Memory(?:[\\/]|\b)|(?:^|[\s"'=(])\/(?:home|Users)\/(?!Public\b|Default\b|SAMPLE\b|HOST\b)[a-zA-Z0-9_.-]{1,80}\//i],
 ['bearer_token_literal',/\bBearer[ \t]+[A-Za-z0-9_~+.\/-]{24,4096}(?:\b|=)/i],
 ['gateway_key_literal',/\bgwv_[A-Za-z0-9_-]{43}\b/],
 ['jwt_literal',/\beyJ[A-Za-z0-9_-]{12,4096}\.[A-Za-z0-9_-]{12,4096}\.[A-Za-z0-9_-]{16,4096}\b/],
 ['private_key_literal',/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
 ['credential_literal',/["'](?:access[_-]?token|refresh[_-]?token|api[_-]?key|adminKey|clientSecret|password|cookie|authorization)["'][ \t]*:[ \t]*["'](?!(?:text\d+|SAMPLE|TOKEN|HOST|PAYLOAD|auto|none)["'])[A-Za-z0-9_~+\/.=:-]{16,4096}["']/i]
];
function rawMarkers(data){const found=new Set();for(const view of [data.toString('latin1'),data.toString('utf16le'),data.subarray(1).toString('utf16le')])for(const[code,pattern]of sensitivePatterns)if(pattern.test(view))found.add(code);return [...found];}
function jsonCredential(value,at='',hits=[]){if(!value||typeof value!=='object')return hits;for(const[k,v]of Object.entries(value)){if(/^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|adminKey|clientSecret|password|cookie|authorization|privateKey)$/i.test(k)&&typeof v==='string'&&v&&!/^(?:text\d+|SAMPLE|TOKEN|HOST|PAYLOAD|auto|none)$/.test(v))hits.push(at+'/'+k);else if(v&&typeof v==='object')jsonCredential(v,at+'/'+k,hits);}return hits;}
function parsed(data){return JSON.parse(data.toString('utf8').replace(/^\uFEFF/,''));}
function diagnosticEntry(name){const parts=name.split('/'),privateAt=parts.findIndex(p=>forbiddenSegments.test(p));return privateAt<0?name:parts.slice(0,privateAt+1).join('/')+'/<runtime-entry>';}
function accountSnapshot(value){if(!value||typeof value!=='object')return false;if(Array.isArray(value))return value.some(accountSnapshot);if(Array.isArray(value.accounts)&&value.accounts.length)return true;if(['currentAccountId','principal','userId','uid','email'].some(k=>typeof value[k]==='string'&&value[k].length))return true;return Object.values(value).some(v=>v&&typeof v==='object'&&accountSnapshot(v));}
async function sourceAssetHashes(){const root=fileURLToPath(new URL('../',import.meta.url)),result=new Map();const pairs=[['app-logo.png','desktop/app-logo.png'],['app-logo-rounded.ico','desktop/app-logo-rounded.ico'],...['Montserrat-Regular.otf','Montserrat-Bold.otf'].map(n=>['ui/assets/fonts/'+n,'desktop/webview-shell/ui/assets/fonts/'+n])];for(const icon of icons){pairs.push(['ui/assets/platform-icons/'+icon+'.png','desktop/webview-shell/ui/assets/platform-icons/'+icon+'.png']);pairs.push(['platform-icons/'+icon+'.png','desktop/platform-icons/'+icon+'.png']);}for(const[entry,path]of pairs)try{result.set(entry,hash(await readFile(join(root,path))));}catch(error){if(error.code!=='ENOENT')throw error;}return result;}
export function auditEntries(entries,{requireRuntime=true,allowMissingChecksums=false,buildInfo=null,assetHashes=new Map()}={}){
 const issues=[],classifications=[],files=new Map(),seen=new Set(),kinds={};
 const issue=(code,entry,detail)=>{entry=diagnosticEntry(entry);if(!issues.some(v=>v.code===code&&v.entry===entry))issues.push({code,entry,detail});};
 let bytes=0;
 for(const entry of entries){
  let name;try{name=canonical(entry.name);}catch{issue('unsafe_entry_path','<entry>','Entry path is absolute, contains traversal/control bytes, or uses a backslash.');continue;}
  const key=name.replace(/\/$/,'').toLowerCase();if(seen.has(key))issue('duplicate_or_case_collision',name,'Entry names must be unique on Windows.');seen.add(key);
  const segments=name.split('/').filter(Boolean);if(segments.some(v=>forbiddenSegments.test(v))||forbiddenFiles.test(segments.at(-1)??'')||forbiddenExtensions.test(name))issue('private_runtime_path',name,'Runtime account/configuration/history/cache/export paths are not release inputs.');
  if(entry.directory)continue;
  if(!allowedName(name))issue('outside_release_allowlist',name,'Only explicit application files, provider runtime code, public licenses and fixed brand assets are permitted.');
  const data=Buffer.from(entry.data);bytes+=data.length;if(data.length>MAX_ENTRY||bytes>MAX_TOTAL)issue('size_limit',name,'Release size bound exceeded.');files.set(name,data);
  const kind=fileKind(data);kinds[kind]=(kinds[kind]??0)+1;
  if(kind==='sqlite')issue('database_magic',name,'SQLite data is forbidden even if renamed to a permitted source extension.');
  if(['zip','gzip','7z','rar','xz','tar'].includes(kind))issue('nested_archive_magic',name,'Nested archives are forbidden, including archives with misleading extensions.');
  if(kind==='png'&&!(/^(?:app-logo\.png|(?:ui\/assets\/)?platform-icons\/[^/]+\.png)$/.test(name)))issue('unapproved_image',name,'Only fixed public brand/platform PNG assets are allowed; screenshots and captures are not.');
  const digest=hash(data),trust=binaryClassification(name,digest),markers=rawMarkers(data);
  if(kind==='png'||name==='app-logo-rounded.ico'||name.endsWith('.otf')){if(!assetHashes.has(name))issue('static_asset_policy_missing',name,'Image/icon/font must match a reviewed source asset, not merely use a brand filename.');else if(assetHashes.get(name)!==digest)issue('static_asset_hash_mismatch',name,'Packaged image/icon/font differs from its reviewed source asset.');}
  if(kind==='pe'){
   const embedded={sqliteHeader:data.indexOf(Buffer.from('SQLite format 3\0'))>=0,zipHeader:data.indexOf(Buffer.from([80,75,3,4]))>=0,pngResource:data.indexOf(Buffer.from([137,80,78,71,13,10,26,10]))>=0};
   classifications.push({entry:diagnosticEntry(name),sha256:digest,classification:trust,markerCodes:markers,embeddedMagic:embedded});
   if(trust==='application-executable'&&(embedded.sqliteHeader||embedded.zipHeader))issue('embedded_runtime_container',name,'Application resources contain an unexpected database/archive header; vendor binaries use their separately pinned public classification.');
  }
  if(trustedHashes.has(name)&&trustedHashes.get(name)!==digest)issue('vendor_binary_hash_mismatch',name,'Public vendor executable/DLL differs from the pinned distribution; no content exemption applies.');
  if(kind==='pe'&&!trustedHashes.has(name)&&trust!=='application-executable')issue('unapproved_executable',name,'An executable was found outside the two application entrypoints and pinned vendor files.');
  for(const code of markers)if(trust!=='pinned-public-vendor-binary')issue(code,name,'High-confidence embedded path/credential marker found; matched value is deliberately omitted.');
  const looksJson=/^[\s\uFEFF]*[\[{]/.test(data.subarray(0,128).toString('utf8'));
  if(name.endsWith('.json')||looksJson)try{const value=parsed(data);if(jsonCredential(value).length)issue('json_credential_value',name,'A nonempty credential property occurs in JSON; property values are deliberately omitted.');if(!['ui/demo.json','core/config.example.json'].includes(name)&&accountSnapshot(value))issue('account_snapshot_data',name,'Resident account/state data is forbidden even without an obvious token or account-specific filename.');}catch{if(name.endsWith('.json'))issue('invalid_json',name,'JSON release input must parse.');}
 }
 if(requireRuntime)for(const name of required)if(!files.has(name))issue('required_file_missing',name,'Required portable runtime component is absent.');
 function json(name){if(!files.has(name))return null;try{return parsed(files.get(name));}catch{return null;}}
 const marker=json('gateway.portable.json'),config=json('core/config.first-run.json'),demo=json('ui/demo.json');
 if(marker&&(marker.mode!=='portable'||marker.schemaVersion!==1||marker.template!=='core/config.first-run.json'||marker.configuration!=='user-data/config.local.json'))issue('first_run_marker_invalid','gateway.portable.json','The runtime must select the empty first-run template and private instance data directory.');
 if(config){
  if(!['accounts','upstreams','routes'].every(k=>Array.isArray(config[k])&&config[k].length===0))issue('first_run_accounts_not_empty','core/config.first-run.json','All first-run account/upstream/route lists must be empty.');
  if(config.scheduler?.enabled!==false||config.scheduler?.startup!==false||config.workbuddy?.autoTasks!==false||config.workbuddy?.autoMigrateSessions!==false||config.clientUpdates?.enabled!==false)issue('first_run_automatic_action_enabled','core/config.first-run.json','Every first-run automatic task/import/update switch must be explicitly off.');
  if(config.server?.host!=='127.0.0.1'||config.server?.port!==0||config.server?.allowRemote!==false)issue('first_run_listener_invalid','core/config.first-run.json','First run must use an OS-assigned loopback-only listener.');
  if(config.dataDir!=='./data')issue('first_run_data_path_invalid','core/config.first-run.json','The shipped template must not contain an absolute/generated user data path.');
 }
 if(demo&&(demo.mode!=='demo'||!Array.isArray(demo.accounts)||demo.accounts.some(a=>!String(a.id).startsWith('demo-'))))issue('demo_not_clearly_synthetic','ui/demo.json','Demo accounts must be explicitly synthetic, not a resident account snapshot.');
 const sums=files.get('checksums.sha256');let checksumEntries=0;
 if(!sums&&!allowMissingChecksums)issue('checksum_manifest_missing','checksums.sha256','Published releases require an inventory checksum for every other file.');
 if(sums){const listed=new Set();for(const line of sums.toString('utf8').trim().split(/\r?\n/)){const m=line.match(/^([a-f0-9]{64})  (.+)$/i);if(!m){issue('checksum_line_invalid','checksums.sha256','Checksum line does not have SHA256 plus an entry path.');continue;}const name=m[2];if(listed.has(name)||name==='checksums.sha256')issue('checksum_inventory_invalid',name,'Checksum entries must be unique and must not include the checksum file itself.');listed.add(name);if(!files.has(name)||hash(files.get(name))!==m[1].toLowerCase())issue('checksum_mismatch',name,'Entry content does not match the manifest.');}checksumEntries=listed.size;for(const name of files.keys())if(name!=='checksums.sha256'&&!listed.has(name))issue('checksum_entry_missing',name,'File was not declared by the checksum inventory.');}
 const provenance=json('prerequisites/PROVENANCE.json');if(provenance&&files.has('prerequisites/MicrosoftEdgeWebview2Setup.exe')&&(provenance.sha256!==hash(files.get('prerequisites/MicrosoftEdgeWebview2Setup.exe'))||provenance.signatureStatus!=='Valid'||!/Microsoft Corporation/.test(provenance.signer??'')))issue('bootstrapper_provenance_invalid','prerequisites/PROVENANCE.json','Microsoft bootstrapper hash/signature record must match the packaged file.');
 if(buildInfo?.compiledExeSha256&&files.has('AI积分网关.exe')&&buildInfo.compiledExeSha256!==hash(files.get('AI积分网关.exe')))issue('build_info_executable_mismatch','AI积分网关.exe','Published BUILD-INFO does not match the executable.');
 if(buildInfo){for(const code of rawMarkers(Buffer.from(JSON.stringify(buildInfo))))issue(code,'<BUILD-INFO.json>','External release metadata contains a high-confidence private marker; value omitted.');if(jsonCredential(buildInfo).length||accountSnapshot(buildInfo))issue('private_release_metadata','<BUILD-INFO.json>','External release metadata must not contain resident credentials or account snapshots.');}
 if(files.has('AI积分网关.exe')&&files.has('AiCredit.WebView2.exe')&&!files.get('AI积分网关.exe').equals(files.get('AiCredit.WebView2.exe')))issue('executable_alias_mismatch','AiCredit.WebView2.exe','Both executable entrypoints must contain the same build.');
 return {ok:issues.length===0,summary:{files:files.size,directories:entries.filter(e=>e.directory).length,uncompressedBytes:bytes,checksumEntries,issues:issues.length,fileKinds:kinds,firstRunEmpty:!!config&&['accounts','upstreams','routes'].every(k=>Array.isArray(config[k])&&config[k].length===0),demoClassified:!!demo,exampleConfigIsNotFirstRunTemplate:files.has('core/config.example.json')&&marker?.template==='core/config.first-run.json'},binaryClassifications:classifications,issues};
}
export async function auditRelease(input,options={}){
 try{
  const path=resolve(input),stat=await lstat(path);if(stat.isSymbolicLink())throw Object.assign(new Error('symlink_forbidden'),{code:'symlink_forbidden'});
  const data=stat.isDirectory()?null:await readFile(path),raw=data?readZipEntries(data):await readDirectory(path);
  // upload-artifact publishes files, not empty directories. A pure native
  // contract may probe an empty user-data directory; any file below it still
  // fails. ZIP inputs remain stricter and reject even empty runtime entries.
  const empty=data?new Set():new Set(raw.filter(e=>e.directory&&!raw.some(f=>!f.directory&&f.name.startsWith(e.name))).map(e=>e.name));
  const entries=raw.filter(e=>!empty.has(e.name));
  const result=auditEntries(entries,{...options,assetHashes:options.assetHashes??await sourceAssetHashes()});
  result.input={kind:data?'zip':'directory',...(data?{bytes:data.length,sha256:hash(data)}:{emptyDirectoriesNotPublished:empty.size})};
  if(data&&options.buildInfo?.sha256&&options.buildInfo.sha256!==hash(data)){result.issues.push({code:'build_info_archive_mismatch',entry:'<BUILD-INFO.json>',detail:'External release metadata does not describe the audited ZIP bytes.'});result.ok=false;result.summary.issues=result.issues.length;}
  if(options.expectedSha256&&data&&hash(data)!==options.expectedSha256.toLowerCase()){result.issues.push({code:'archive_sha256_mismatch',entry:'<archive>',detail:'Published archive bytes differ from the expected public SHA256.'});result.ok=false;result.summary.issues=result.issues.length;}return result;
 }catch(error){return {ok:false,summary:{issues:1},issues:[{code:error.code??'release_read_failed',entry:'<input>',detail:'Release could not be read within the strict ZIP/path/size boundary.'}]};}
}
async function cli(){
 const args=process.argv.slice(2),take=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const path=take('--zip')??take('--directory');if(!path)throw new Error('Usage: node scripts/audit-webview-release.mjs --zip FILE [--expect-sha256 HASH] [--build-info FILE] [--report FILE] OR --directory DIR [--allow-missing-checksums]');
 const buildInfo=take('--build-info')?parsed(await readFile(take('--build-info'))):null;
 const report=await auditRelease(path,{expectedSha256:take('--expect-sha256'),allowMissingChecksums:args.includes('--allow-missing-checksums'),buildInfo});
 const text=JSON.stringify(report,null,2)+'\n';if(take('--report'))await writeFile(take('--report'),text);process.stdout.write(text);process.exitCode=report.ok?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli().catch(()=>{process.stderr.write('release_audit_failed\n');process.exitCode=1;});
