import {mkdir,mkdtemp,writeFile,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {isIP} from 'node:net';
import {gunzipSync,inflateRawSync,crc32} from 'node:zlib';
import {AppError,hash,rememberSecret} from './util.mjs';

// Install no plugin executables, hooks or MCP launchers. Only the actual agent
// markdown and manifest identity from the authenticated official download are
// materialized; their role definitions are supplied to the unmodified CLI.
const MAX_DOWNLOAD=8*1024*1024,MAX_EXPANDED=16*1024*1024,MAX_ENTRIES=512,MAX_TEXT=512*1024,MAX_FILE=128*1024;
const fail=(message,code='wb_expert_bundle_invalid',status=502)=>new AppError(message,status,code);
const text=buffer=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{throw fail('官方专家文本编码待确认');}};
function archivePath(raw){
 if(typeof raw!=='string'||raw.length>512||/[\x00-\x1f\x7f:]/.test(raw))throw fail('专家包路径格式错误');
 const name=raw.replace(/\\/g,'/').replace(/^(?:\.\/)+/,'').replace(/\/$/,'');
 if(!name||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw fail('专家包包含越界或保留路径');
 return name;
}
const wanted=name=>/(?:^|\/)(?:\.codebuddy-plugin|\.workbuddy-plugin)\/plugin\.json$/.test(name)||/(?:^|\/)agents\/[^/]+\.md$/i.test(name);
function storeEntry(files,seen,name,data){
 const key=name.toLowerCase();if(seen.has(key))throw fail('专家包包含重复路径');seen.add(key);
 if(wanted(name)){if(data.length>MAX_FILE)throw fail('官方专家单份定义超过上限');files.set(name,text(data));}
}
function zipEntries(buffer){
 let eocd=-1;for(let n=buffer.length-22;n>=Math.max(0,buffer.length-65557);n--)if(buffer.readUInt32LE(n)===0x06054b50&&n+22+buffer.readUInt16LE(n+20)===buffer.length){eocd=n;break;}
 if(eocd<0)throw fail('专家 ZIP 目录缺失');
 const count=buffer.readUInt16LE(eocd+10),centralSize=buffer.readUInt32LE(eocd+12),central=buffer.readUInt32LE(eocd+16);
 if(buffer.readUInt16LE(eocd+4)||buffer.readUInt16LE(eocd+6)||count!==buffer.readUInt16LE(eocd+8)||count===65535||!count||count>MAX_ENTRIES||central+centralSize!==eocd)throw fail('专家 ZIP 目录超限或格式不支持');
 const files=new Map(),seen=new Set();let offset=central,expanded=0;
 for(let n=0;n<count;n++){
  if(offset+46>eocd||buffer.readUInt32LE(offset)!==0x02014b50)throw fail('专家 ZIP 条目损坏');
  const flags=buffer.readUInt16LE(offset+8),method=buffer.readUInt16LE(offset+10),crc=buffer.readUInt32LE(offset+16),compressed=buffer.readUInt32LE(offset+20),size=buffer.readUInt32LE(offset+24),nameLength=buffer.readUInt16LE(offset+28),extraLength=buffer.readUInt16LE(offset+30),commentLength=buffer.readUInt16LE(offset+32),mode=(buffer.readUInt32LE(offset+38)>>>16)&0xf000,local=buffer.readUInt32LE(offset+42),next=offset+46+nameLength+extraLength+commentLength;
  if(next>eocd||!nameLength||flags&1||![0,8].includes(method)||mode===0xa000||size===0xffffffff||compressed===0xffffffff)throw fail('专家 ZIP 包含加密、链接或不支持条目');
  const raw=text(buffer.subarray(offset+46,offset+46+nameLength));expanded+=size;if(expanded>MAX_EXPANDED)throw fail('专家 ZIP 展开大小超过上限');
  if(local+30>central||buffer.readUInt32LE(local)!==0x04034b50)throw fail('专家 ZIP 本地条目损坏');
  const localNameLength=buffer.readUInt16LE(local+26),localExtra=buffer.readUInt16LE(local+28),start=local+30+localNameLength+localExtra;
  if(start+compressed>central||text(buffer.subarray(local+30,local+30+localNameLength))!==raw)throw fail('专家 ZIP 条目身份不一致');
  if(raw.endsWith('/')&&/^(?:\.\/)+$/.test(raw)){offset=next;continue;}const name=archivePath(raw);
  if(raw.endsWith('/')){if(seen.has(name.toLowerCase()))throw fail('专家包包含重复路径');seen.add(name.toLowerCase());offset=next;continue;}
  if(wanted(name)){
   if(size>MAX_FILE)throw fail('官方专家定义超过上限');let data;
   try{data=method===0?buffer.subarray(start,start+compressed):inflateRawSync(buffer.subarray(start,start+compressed),{maxOutputLength:Math.max(1,size+1)});}catch{throw fail('专家 ZIP 解压校验失败');}
   if(data.length!==size||crc32(data)!==crc)throw fail('专家 ZIP 大小或 CRC 校验失败');storeEntry(files,seen,name,data);
  }else{if(seen.has(name.toLowerCase()))throw fail('专家包包含重复路径');seen.add(name.toLowerCase());}
  offset=next;
 }
 if(offset!==central+centralSize)throw fail('专家 ZIP 目录长度不一致');return files;
}
function tarEntries(buffer){
 const files=new Map(),seen=new Set();let offset=0,count=0;
 while(offset+512<=buffer.length){
  const header=buffer.subarray(offset,offset+512);if(header.every(b=>b===0))break;if(++count>MAX_ENTRIES)throw fail('专家 TAR 条目超过上限');
  const field=(a,b)=>text(header.subarray(a,b)).split('\0')[0],octal=(a,b)=>{const value=field(a,b).trim();if(!/^[0-7]*$/.test(value))throw fail('专家 TAR 数值格式错误');return value?parseInt(value,8):0;};
  const checksum=octal(148,156),actual=header.reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0);if(checksum!==actual)throw fail('专家 TAR 校验失败');
  const raw=[field(345,500),field(0,100)].filter(Boolean).join('/'),size=octal(124,136),type=String.fromCharCode(header[156]||48),start=offset+512;
  if(!Number.isSafeInteger(size)||size>MAX_EXPANDED||start+size>buffer.length||!['0','5'].includes(type))throw fail('专家 TAR 包含链接、扩展或损坏条目');
  if(type==='5'&&/^(?:\.\/)*\.?\/?$/.test(raw)){offset=start+Math.ceil(size/512)*512;continue;}const name=archivePath(raw);
  if(type==='5'){if(seen.has(name.toLowerCase()))throw fail('专家包包含重复路径');seen.add(name.toLowerCase());}
  else storeEntry(files,seen,name,buffer.subarray(start,start+size));
  offset=start+Math.ceil(size/512)*512;
 }
 if(!count)throw fail('专家 TAR 没有有效文件');return files;
}
export function readWorkBuddyExpertArchive(bytes){
 let buffer=Buffer.from(bytes);if(buffer.length<2||buffer.length>MAX_DOWNLOAD)throw fail('官方专家下载大小超过上限或为空');
 let files;if(buffer.readUInt16LE(0)===0x8b1f){try{buffer=gunzipSync(buffer,{maxOutputLength:MAX_EXPANDED});}catch{throw fail('专家 GZIP 展开校验失败');}files=tarEntries(buffer);}
 else if(buffer.length>=4&&buffer.readUInt32LE(0)===0x04034b50)files=zipEntries(buffer);
 else if(buffer.length>=512&&buffer.subarray(257,262).toString()==='ustar')files=tarEntries(buffer);
 else throw fail('官方专家包格式不支持');
 if([...files.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)>MAX_TEXT)throw fail('官方专家文本总量超过上限');return files;
}
function scalar(value){const v=String(value??'').trim();return /^(["']).*\1$/.test(v)?v.slice(1,-1):v;}
function agentMarkdown(path,source){
 const match=source.replace(/^\uFEFF/,'').match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/),front=match?.[1]??'',prompt=(match?match[2]:source).trim();
 const field=name=>scalar(front.match(new RegExp('^'+name+':\\s*(.*)$','m'))?.[1]);
 const name=field('name')||path.split('/').at(-1).replace(/\.md$/i,'');
 if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(name)||['__proto__','constructor','prototype'].includes(name)||!prompt)throw fail('官方专家角色名称或正文缺失');
 const definition={description:field('description')||name,prompt},tools=field('tools');
 if(tools){const list=tools.replace(/^\[|\]$/g,'').split(',').map(s=>scalar(s)).filter(Boolean);if(list.length>64)throw fail('专家工具声明超过上限');definition.tools=list;}
 return {name,path,source,prompt,definition,sha256:hash(source)};
}
function nameOf(row){const v=row.display_name_zh??row.display_name_en??row.name;return typeof v==='string'?v:v?.zh??v?.en??'';}
function entitledVisible(row){
 // Official public list/detail responses may omit all price fields. Omission
 // is not a claim of free pricing: actual entitlement is established below by
 // the authenticated download-url authorization, then a successful bundle
 // download. Never invoke a purchase/subscription endpoint or ignore a stated
 // paid/unknown payment mode, including contradictory price metadata.
 const modes=[row.pay_detail?.payMode,row.pay_detail?.pay_mode,row.payMode,row.pay_mode,row.need_pay].filter(value=>value!==undefined&&value!==null);
 return modes.every(mode=>[0,'0'].includes(mode))&&row.visible!==false&&row.is_visible!==false&&row.disabled!==true;
}
function downloadedUrl(value){
 let url;try{url=new URL(value);}catch{throw fail('官方专家未返回有效下载地址');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||isIP(url.hostname)||/^(?:localhost|.*\.(?:local|internal|localhost))$/i.test(url.hostname)||url.href.length>8192)throw fail('官方专家下载地址格式错误');
 return url.href;
}
async function boundedBody(response,limit,check){
 const declared=Number(response.headers?.get?.('content-length'));if(Number.isFinite(declared)&&declared>limit)throw fail('官方专家响应超过上限');
 if(response.body?.[Symbol.asyncIterator]){const chunks=[];let size=0;for await(const chunk of response.body){check();const b=Buffer.from(chunk);size+=b.length;if(size>limit)throw fail('官方专家响应超过上限');chunks.push(b);}return Buffer.concat(chunks);}
 const body=Buffer.from(await response.arrayBuffer());check();if(body.length>limit)throw fail('官方专家响应超过上限');return body;
}
export async function prepareWorkBuddyExpert({service,accountId,task,signal,check=()=>{},root,cwd,env,index=0}){
 const guard=()=>{check();signal?.throwIfAborted();};guard();
 const workspaceRel=typeof root==='string'&&typeof cwd==='string'?relative(resolve(root),resolve(cwd)):null;
 if(!isAbsolute(root??'')||workspaceRel===null||workspaceRel.startsWith('..')||isAbsolute(workspaceRel)||!env||typeof env!=='object')throw fail('专家执行私有目录待确认','wb_expert_private_directory_invalid',400);
 if(!['expert_5','Expert_team_use_3','Expert_lighthouse'].includes(task?.taskCode))throw fail('专家执行任务类型错误','wb_expert_task_invalid',400);
 const team=task.taskCode==='Expert_team_use_3',lighthouse=task.taskCode==='Expert_lighthouse',kind=team?'expert_team':lighthouse?'expert_lighthouse':'expert',credential=await service.credentials.resolve(accountId),domain=credential.domain??'www.workbuddy.cn';
 if(!['www.workbuddy.cn','workbuddy.cn','www.codebuddy.cn','codebuddy.cn','copilot.tencent.com','www.workbuddy.ai','workbuddy.ai'].includes(domain))throw fail('WB 专家认证域名待核对','wb_expert_domain_invalid',400);
 rememberSecret(credential.accessToken);const fetchImpl=service.workbuddyRuntime?.fetchImpl??fetch,base=/workbuddy\.ai$/.test(domain)?'https://www.workbuddy.ai':'https://www.workbuddy.cn';
 const request=async(path,body)=>{
  guard();const response=await fetchImpl(base+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+credential.accessToken,'X-User-Id':String(credential.uid??credential.principal),'X-Domain':domain},body:JSON.stringify(body),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
  const bytes=await boundedBody(response,1024*1024,guard);let row;try{row=JSON.parse(text(bytes));}catch{throw fail('官方专家目录响应待确认','wb_expert_response_invalid');}
  if(!row||typeof row!=='object'||Array.isArray(row))throw fail('官方专家目录响应待确认','wb_expert_response_invalid');
  if(!response.ok||![0,'0',200,'200'].includes(row.code))throw fail('官方专家目录请求未成功','wb_expert_request_failed',response.ok?502:response.status||502);
  return row.data??row;
 };
 const directory=await request('/portal/operation-platform/market/expert/list',{page:1,page_size:100,expert_type:team?'team':'agent',sort_by:'reco_rank',sort_order:'desc',...(lighthouse?{keyword:'轻量'}:{})}),rows=directory.items??directory.experts;
 if(!Array.isArray(rows))throw fail('官方专家列表格式待确认','wb_expert_response_invalid');
 const candidates=rows.filter(row=>row&&typeof row==='object'&&/^ex_[A-Za-z0-9_-]+$/.test(row.expert_id??'')&&(row.expert_type??'agent')===(team?'team':'agent')&&entitledVisible(row)&&(!lighthouse||/腾讯.{0,10}轻量(?:云|应用服务器)|lighthouse/i.test(row.expert_id+' '+nameOf(row))));
 if(!candidates.length)throw fail('当前目录未返回符合条件的可用官方专家','wb_expert_not_available',409);
 const selected=candidates[(Math.max(0,Number.isFinite(index)?Math.floor(index):0))%candidates.length],id=selected.expert_id;
 const detailData=await request('/portal/operation-platform/market/expert/get-by-ids',{expert_ids:[id],include_invisible:false}),details=detailData.items??detailData.experts,detail=Array.isArray(details)?details.find(row=>row?.expert_id===id):undefined;
 if(!detail||!entitledVisible(detail)||(detail.expert_type??'agent')!==(selected.expert_type??'agent'))throw fail('官方专家详情或现有使用资格未确认','wb_expert_not_available',409);
 const download=await request('/portal/operation-platform/market/expert/download-url',{expert_id:id});
 if(download.expires_at){const raw=download.expires_at,expires=typeof raw==='number'?raw*(raw<1e12?1000:1):/^\d+$/.test(raw)?Number(raw)*(Number(raw)<1e12?1000:1):Date.parse(raw);if(Number.isFinite(expires)&&expires<=Date.now())throw fail('官方专家下载地址已过期','wb_expert_download_expired',409);}
 const url=downloadedUrl(download.download_url);rememberSecret(url);guard();
 // The authoritatively returned HTTPS bundle URL gets no WB Authorization,
 // account headers, cookies or redirect-following behavior, even across hosts.
 const response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/octet-stream'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 if(!response.ok)throw fail('官方专家包下载未成功','wb_expert_download_failed',response.status||502);
 const bytes=await boundedBody(response,MAX_DOWNLOAD,guard),files=readWorkBuddyExpertArchive(bytes),manifests=[...files].filter(([path])=>/(?:^|\/)(?:\.codebuddy-plugin|\.workbuddy-plugin)\/plugin\.json$/.test(path));
 if(manifests.length!==1)throw fail('官方专家包清单不唯一');let manifest;try{manifest=JSON.parse(manifests[0][1]);}catch{throw fail('官方专家清单格式错误');}
 if(!manifest||typeof manifest!=='object'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(manifest.name??'')||manifest.expertType&&manifest.expertType!==(selected.expert_type??'agent')||manifest.marketExpertId&&manifest.marketExpertId!==id||detail.plugin_name&&detail.plugin_name!==manifest.name)throw fail('官方专家包身份校验失败');
 const prefix=manifests[0][0].replace(/(?:\.codebuddy-plugin|\.workbuddy-plugin)\/plugin\.json$/,''),roles=[...files].filter(([path])=>path.startsWith(prefix+'agents/')&&!path.slice((prefix+'agents/').length).includes('/')).map(([path,source])=>agentMarkdown(path,source));
 if(!roles.length||roles.length>16||new Set(roles.map(r=>r.name.toLowerCase())).size!==roles.length)throw fail('官方专家包角色缺失、重复或超过上限');
 const requested=team?manifest.teamInfo?.leadAgent:manifest.agentName,lead=roles.find(r=>r.name===requested||r.path.split('/').at(-1).replace(/\.md$/i,'')===String(requested??'').replace(/\.md$/i,''))??(!team&&!requested&&roles.length===1?roles[0]:undefined);
 if(!lead)throw fail('官方专家主角色未确认','wb_expert_role_missing',409);
 let members=team?roles.filter(r=>r!==lead):[];
 const declared=manifest.teamInfo?.members??manifest.members;
 if(team&&Array.isArray(declared)&&declared.length){
  const names=declared.map(m=>typeof m==='string'?m:m?.agentName??m?.agent_name??m?.agent??m?.name).filter(n=>typeof n==='string').map(n=>n.replace(/^agents\//,'').replace(/\.md$/i,'')),selectedMembers=[];
  if(!names.length)throw fail('官方专家团成员声明待确认','wb_expert_team_members_missing',409);
  for(const name of names){const role=roles.find(r=>r.name===name||r.path.split('/').at(-1).replace(/\.md$/i,'')===name);if(!role)throw fail('官方专家团成员角色缺失','wb_expert_team_members_missing',409);if(role!==lead&&!selectedMembers.includes(role))selectedMembers.push(role);}members=selectedMembers;
 }
 if(team&&!members.length)throw fail('官方专家团缺少真实成员角色','wb_expert_team_members_missing',409);
 guard();await mkdir(root,{recursive:true,mode:0o700});const materialized=await mkdtemp(join(root,'expert-')),realRoot=await realpath(root),realDir=await realpath(materialized),rel=relative(realRoot,realDir);
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('专家包落地目录校验失败');
 for(const [path,source]of files){if(!path.startsWith(prefix))continue;const file=join(materialized,...path.slice(prefix.length).split('/'));await mkdir(join(file,'..'),{recursive:true,mode:0o700});await writeFile(file,source,{mode:0o600});}
 const definitions=Object.fromEntries(roles.map(r=>[r.name,r.definition])),serialized=JSON.stringify(definitions);let args;
 if(serialized.length<=24000)args=['--agents',serialized,'--agent',lead.name];
 else{
  // Windows command-line length is bounded. The official CLI also reads the
  // isolated CONFIG_DIR/agents markdown; never truncate an authentic role.
  const config=join(materialized,'cli-profile'),agents=join(config,'agents');await mkdir(agents,{recursive:true,mode:0o700});
  env.CODEBUDDY_CONFIG_DIR=config;env.WORKBUDDY_CONFIG_DIR=config;
  for(const role of roles)await writeFile(join(agents,role.path.split('/').at(-1)),role.source,{mode:0o600});args=['--agent',lead.name];
 }
 const existing=String(env.CODEBUDDY_CUSTOM_HEADERS??'').split(/\r?\n/).filter(line=>!/^\s*X-Expert-(?:Id|Team-Task)\s*:/i.test(line));
 env.CODEBUDDY_CUSTOM_HEADERS=[...existing,'X-Expert-Id: '+id,...(team?['X-Expert-Team-Task: true']:[])].filter(Boolean).join('\n');
 const goal=lighthouse?'请按你真实的腾讯轻量云专家职责，为虚构个人静态网站给出最小部署检查清单；不要创建或修改云资源。':'请按你已载入的真实官方专业职责，为虚构个人项目完成一个小型实用方案，写出三项具体建议和一项应核对的前置条件。';
 const teamGoal=team?'必须真正使用 Agent 工具分别委派以下已载入的真实成员角色：'+members.map(r=>r.name).join('、')+'；等待各成员的真实结果后，由你的官方主角色整合方案。不要仅用文本扮演成员，也不要捏造已调用。':'';
 const prompt='你正在以本次真实载入的官方专家「'+nameOf(detail)+'」（角色 '+lead.name+'）执行任务。'+goal+teamGoal+'仅使用虚构样例，不访问用户原有文件、不发送消息、不购买或发布服务。将实际方案写入当前工作目录 wb-expert-'+Math.max(0,Math.floor(index)||0)+'.md，并用 Read 工具读回核验。';
 return {args,prompt,...(team?{requireTool:/^Agent$/}:{}),feature:{kind,expertId:id,expertType:selected.expert_type??'agent',entitlementSource:'official_download_authorized',pluginName:manifest.name,agentName:lead.name,memberNames:members.map(r=>r.name),bundleSha256:hash(bytes),roleHashes:roles.map(r=>({name:r.name,sha256:r.sha256})),materializedDirectory:materialized}};
}
