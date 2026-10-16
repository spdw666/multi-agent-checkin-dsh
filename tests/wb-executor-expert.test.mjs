import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {deflateRawSync,gzipSync,crc32} from 'node:zlib';
import {hash} from '../src/util.mjs';
import {prepareWorkBuddyExpert,readWorkBuddyExpertArchive} from '../src/workbuddy-executor-expert.mjs';

// Synthetic responses and actual ZIP/TAR byte fixtures only. No installed
// official CLI, real account endpoint or model is invoked by this file.
const ID='ex_SAMPLE_OFFICIAL',TOKEN='SAMPLE-WB-ACCESS-TOKEN';
const agent=(name,body='SAMPLE official role: analyze the supplied local example.')=>'---\nname: '+name+'\ndescription: SAMPLE official '+name+'\ntools: Read, Write, Agent\n---\n'+body+'\n';
const market=(extra={})=>({expert_id:ID,expert_type:'agent',display_name_zh:'SAMPLE 专业顾问',plugin_name:'SAMPLE-plugin',pay_detail:{payMode:0},visible:true,...extra});
const manifest=(extra={})=>({name:'SAMPLE-plugin',agentName:'SAMPLE-advisor',expertType:'agent',marketExpertId:ID,...extra});
function entries(extra={}){return {'SAMPLE-plugin/.codebuddy-plugin/plugin.json':JSON.stringify(manifest()),'SAMPLE-plugin/agents/advisor.md':agent('SAMPLE-advisor'),...extra};}
function zip(files,{method=8,symlink,encrypted=false}={}){
 const locals=[],central=[];let offset=0;
 for(const [path,value]of Object.entries(files)){
  const name=Buffer.from(path),raw=Buffer.from(value),compressed=method===8?deflateRawSync(raw):raw,crc=crc32(raw),local=Buffer.alloc(30),header=Buffer.alloc(46),flags=0x800|(encrypted?1:0);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
  header.writeUInt32LE(0x02014b50);header.writeUInt16LE(0x0314,4);header.writeUInt16LE(20,6);header.writeUInt16LE(flags,8);header.writeUInt16LE(method,10);header.writeUInt32LE(crc,16);header.writeUInt32LE(compressed.length,20);header.writeUInt32LE(raw.length,24);header.writeUInt16LE(name.length,28);header.writeUInt32LE(((path===symlink?0xa1ff:0x81a4)<<16)>>>0,38);header.writeUInt32LE(offset,42);
  locals.push(local,name,compressed);central.push(header,name);offset+=local.length+name.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22),count=Object.keys(files).length;end.writeUInt32LE(0x06054b50);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
function tar(files,{type='0'}={}){
 const parts=[];for(const [path,value]of Object.entries(files)){
  const body=Buffer.from(value),header=Buffer.alloc(512);assert.ok(Buffer.byteLength(path)<100);
  header.write(path,0,100);header.write('0000644\0',100,8);header.write('0000000\0',108,8);header.write('0000000\0',116,8);header.write(body.length.toString(8).padStart(11,'0')+'\0',124,12);header.write('00000000000\0',136,12);header.fill(32,148,156);header[156]=type.charCodeAt(0);header.write('ustar\0',257,6);header.write('00',263,2);
  const checksum=header.reduce((n,b)=>n+b,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);parts.push(header,body,Buffer.alloc((512-body.length%512)%512));
 }
 return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
function json(data){return new Response(JSON.stringify({code:0,data}),{status:200,headers:{'Content-Type':'application/json'}});}
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'SAMPLE-wb-expert-tests-')),cwd=join(root,'workspace');await mkdir(cwd);
 t.after(async()=>{const rel=relative(resolve(tmpdir()),resolve(root));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&basename(root).startsWith('SAMPLE-wb-expert-tests-'));await rm(root,{recursive:true,force:true});});
 const calls=[],row=options.row??market(),detail=options.detail??row,bundle=options.bundle??zip(entries()),env={CODEBUDDY_CONFIG_DIR:join(root,'config'),CODEBUDDY_CUSTOM_HEADERS:'X-Domain: www.codebuddy.cn\nX-User-Id: SAMPLE-UID\nX-Expert-Id: ex_SAMPLE_OLD\nX-Expert-Team-Task: true'};
 let reads=0;const service={credentials:{async resolve(id){assert.equal(id,'SAMPLE-ACCOUNT');reads++;return {accessToken:TOKEN,uid:'SAMPLE-UID',domain:options.domain??'www.codebuddy.cn'};}},workbuddyRuntime:{async fetchImpl(url,init){
  calls.push({url,init});if(options.fetchImpl)return options.fetchImpl(url,init,calls.length);
  if(url.endsWith('/expert/list'))return json({items:options.rows??[row]});
  if(url.endsWith('/expert/get-by-ids'))return json({experts:options.details??[detail]});
  if(url.endsWith('/expert/download-url'))return json({download_url:options.downloadUrl??'https://sample-cdn.example.test/expert.zip?signature=SAMPLE-SIGNED',version:'SAMPLE-v1',expires_at:options.expiresAt??Date.now()+60000});
  return new Response(bundle,{status:options.downloadStatus??200});
 }}};
 return {root,cwd,env,calls,service,get credentialReads(){return reads;},prepare(extra={}){return prepareWorkBuddyExpert({service,accountId:'SAMPLE-ACCOUNT',task:{taskCode:'expert_5'},root,cwd,env,...extra});}};
}
const definitions=prepared=>JSON.parse(prepared.args[prepared.args.indexOf('--agents')+1]);

test('ZIP parser reads only genuine manifest and agent markdown, never hook or executable files',()=>{
 const files=readWorkBuddyExpertArchive(zip(entries({'SAMPLE-plugin/hooks/hooks.json':'{"hooks":["SAMPLE DO NOT EXECUTE"]}','SAMPLE-plugin/setup.js':'throw Error("SAMPLE must not execute")'})));
 assert.equal(files.size,2);assert.ok([...files.keys()].every(p=>/plugin\.json$|agents\/.*\.md$/.test(p)));
});
test('TAR and gzip TAR readers preserve the exact official role text',()=>{
 for(const body of [tar(entries()),gzipSync(tar(entries()))]){
  const files=readWorkBuddyExpertArchive(body);assert.equal(files.get('SAMPLE-plugin/agents/advisor.md'),agent('SAMPLE-advisor'));
 }
});
test('a harmless TAR root-directory entry is accepted without treating it as a file path',()=>{
 const root=tar({'./':''},{type:'5'}).subarray(0,512),files=readWorkBuddyExpertArchive(gzipSync(Buffer.concat([root,tar(entries())])));
 assert.equal(files.get('SAMPLE-plugin/agents/advisor.md'),agent('SAMPLE-advisor'));
});
test('archive rejects traversal paths even when that entry would not be extracted',()=>{
 assert.throws(()=>readWorkBuddyExpertArchive(zip(entries({'../SAMPLE-outside.txt':'SAMPLE'}))),{code:'wb_expert_bundle_invalid'});
 assert.throws(()=>readWorkBuddyExpertArchive(gzipSync(tar(entries({'SAMPLE-plugin/../SAMPLE-outside.txt':'SAMPLE'})))),{code:'wb_expert_bundle_invalid'});
});
test('archive rejects symlinks, encrypted ZIP and unsupported TAR entry types',()=>{
 assert.throws(()=>readWorkBuddyExpertArchive(zip(entries(),{symlink:'SAMPLE-plugin/agents/advisor.md'})),{code:'wb_expert_bundle_invalid'});
 assert.throws(()=>readWorkBuddyExpertArchive(zip(entries(),{encrypted:true})),{code:'wb_expert_bundle_invalid'});
 assert.throws(()=>readWorkBuddyExpertArchive(tar(entries(),{type:'2'})),{code:'wb_expert_bundle_invalid'});
});
test('archive rejects case-colliding paths before any filesystem extraction',()=>{
 assert.throws(()=>readWorkBuddyExpertArchive(zip(entries({'SAMPLE-plugin/agents/ADVISOR.md':agent('SAMPLE-other')}))),{code:'wb_expert_bundle_invalid'});
});
test('ZIP CRC and TAR checksum detect corrupt bytes',()=>{
 const stored=zip(entries(),{method:0}),index=stored.indexOf(Buffer.from('SAMPLE official role'));stored[index]^=1;
 assert.throws(()=>readWorkBuddyExpertArchive(stored),{code:'wb_expert_bundle_invalid'});
 const plain=tar(entries());plain[0]^=1;assert.throws(()=>readWorkBuddyExpertArchive(plain),{code:'wb_expert_bundle_invalid'});
});
test('archive bounds per-role text, compressed expansion and input length',()=>{
 assert.throws(()=>readWorkBuddyExpertArchive(zip(entries({'SAMPLE-plugin/agents/large.md':agent('SAMPLE-large','S'.repeat(129*1024))}))),{code:'wb_expert_bundle_invalid'});
 assert.throws(()=>readWorkBuddyExpertArchive(gzipSync(Buffer.alloc(17*1024*1024))),{code:'wb_expert_bundle_invalid'});
 for(const b of [Buffer.alloc(0),Buffer.from([1]),Buffer.from('SAMPLE unknown archive'),Buffer.alloc(8*1024*1024+1)])assert.throws(()=>readWorkBuddyExpertArchive(b),{code:'wb_expert_bundle_invalid'});
});
test('ordinary expert loads the downloaded official role and sends bearer only to official metadata APIs',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),agents=definitions(prepared);
 assert.equal(prepared.args.at(-1),'SAMPLE-advisor');assert.equal(agents['SAMPLE-advisor'].prompt,agent('SAMPLE-advisor').split('---\n')[2].trim());
 assert.equal(prepared.feature.expertId,ID);assert.equal(prepared.feature.pluginName,'SAMPLE-plugin');assert.equal(prepared.feature.roleHashes[0].sha256,hash(agent('SAMPLE-advisor')));
 assert.equal(prepared.feature.kind,'expert');assert.ok(prepared.prompt.includes('SAMPLE 专业顾问'));assert.ok(prepared.prompt.includes('SAMPLE-advisor'));
 assert.equal(f.calls.length,4);assert.equal(f.credentialReads,1);
 for(const call of f.calls.slice(0,3)){
  assert.equal(new URL(call.url).hostname,'www.workbuddy.cn');assert.equal(call.init.headers.Authorization,'Bearer '+TOKEN);assert.equal(call.init.headers['X-Domain'],'www.codebuddy.cn');assert.equal(call.init.redirect,'error');
 }
 const download=f.calls[3];assert.equal(download.init.method,'GET');assert.equal(download.init.headers.Authorization,undefined);assert.equal(download.init.headers['X-User-Id'],undefined);assert.equal(download.init.headers['X-Domain'],undefined);assert.equal(download.init.redirect,'error');
 assert.ok(!JSON.stringify(prepared).includes(TOKEN));assert.ok(!JSON.stringify(prepared).includes('SAMPLE-SIGNED'));
 assert.equal(f.env.CODEBUDDY_CUSTOM_HEADERS.split('\n').filter(x=>/^X-Expert-Id:/i.test(x)).length,1);assert.ok(f.env.CODEBUDDY_CUSTOM_HEADERS.endsWith('X-Expert-Id: '+ID));assert.ok(!f.env.CODEBUDDY_CUSTOM_HEADERS.includes('X-Expert-Team-Task'));
 const materialized=prepared.feature.materializedDirectory;assert.equal(await readFile(join(materialized,'agents','advisor.md'),'utf8'),agent('SAMPLE-advisor'));
 assert.deepEqual((await readdir(materialized)).sort(),['.codebuddy-plugin','agents']);
});
test('expert directory/detail/download requests preserve their actual contracts',async t=>{
 const f=await fixture(t);await f.prepare();
 const list=JSON.parse(f.calls[0].init.body),detail=JSON.parse(f.calls[1].init.body),download=JSON.parse(f.calls[2].init.body);
 assert.equal(list.expert_type,'agent');assert.equal(list.page,1);assert.equal(list.need_pay_assets,undefined);
 assert.deepEqual(detail,{expert_ids:[ID],include_invisible:false});assert.deepEqual(download,{expert_id:ID});
});
test('team loads its genuine lead and member roles and requires real Agent delegation',async t=>{
 const row=market({expert_type:'team',display_name_zh:'SAMPLE 官方专家团'}),m=manifest({expertType:'team',agentName:'SAMPLE-unused',teamInfo:{leadAgent:'SAMPLE-captain'}});
 const bundle=zip({'SAMPLE-plugin/.workbuddy-plugin/plugin.json':JSON.stringify(m),'SAMPLE-plugin/agents/captain.md':agent('SAMPLE-captain','SAMPLE genuine captain instructions'),'SAMPLE-plugin/agents/planner.md':agent('SAMPLE-planner','SAMPLE genuine planner instructions'),'SAMPLE-plugin/agents/reviewer.md':agent('SAMPLE-reviewer','SAMPLE genuine reviewer instructions')});
 const f=await fixture(t,{row,bundle}),prepared=await f.prepare({task:{taskCode:'Expert_team_use_3'}}),agents=definitions(prepared);
 assert.equal(prepared.feature.agentName,'SAMPLE-captain');assert.deepEqual(prepared.feature.memberNames,['SAMPLE-planner','SAMPLE-reviewer']);assert.equal(prepared.requireTool.test('Agent'),true);
 assert.equal(agents['SAMPLE-captain'].prompt,'SAMPLE genuine captain instructions');assert.equal(agents['SAMPLE-planner'].prompt,'SAMPLE genuine planner instructions');assert.ok(prepared.prompt.includes('SAMPLE-planner'));assert.ok(prepared.prompt.includes('SAMPLE-reviewer'));assert.ok(prepared.prompt.includes('Agent'));
 assert.ok(f.env.CODEBUDDY_CUSTOM_HEADERS.includes('X-Expert-Team-Task: true'));assert.equal(JSON.parse(f.calls[0].init.body).expert_type,'team');
});
test('team refuses a missing official lead or a bundle without real member definitions',async t=>{
 for(const info of [{leadAgent:'SAMPLE-missing'},{leadAgent:'SAMPLE-advisor'}]){
  const row=market({expert_type:'team'}),bundle=zip(entries({'SAMPLE-plugin/.codebuddy-plugin/plugin.json':JSON.stringify(manifest({expertType:'team',teamInfo:info}))})),f=await fixture(t,{row,bundle});
  await assert.rejects(f.prepare({task:{taskCode:'Expert_team_use_3'}}),e=>['wb_expert_role_missing','wb_expert_team_members_missing'].includes(e.code));
 }
});
test('team honors actual manifest member declarations instead of inventing members from helper files',async t=>{
 const row=market({expert_type:'team'}),m=manifest({expertType:'team',teamInfo:{leadAgent:'SAMPLE-advisor',members:[{agent_name:'SAMPLE-member'}]}}),bundle=zip(entries({'SAMPLE-plugin/.codebuddy-plugin/plugin.json':JSON.stringify(m),'SAMPLE-plugin/agents/member.md':agent('SAMPLE-member'),'SAMPLE-plugin/agents/helper.md':agent('SAMPLE-helper')})),f=await fixture(t,{row,bundle});
 const prepared=await f.prepare({task:{taskCode:'Expert_team_use_3'}});assert.deepEqual(prepared.feature.memberNames,['SAMPLE-member']);assert.ok(!prepared.prompt.includes('SAMPLE-helper'));
 const missing={...m,teamInfo:{leadAgent:'SAMPLE-advisor',members:['SAMPLE-not-present']}},bad=await fixture(t,{row,bundle:zip(entries({'SAMPLE-plugin/.codebuddy-plugin/plugin.json':JSON.stringify(missing)}))});await assert.rejects(bad.prepare({task:{taskCode:'Expert_team_use_3'}}),{code:'wb_expert_team_members_missing'});
});
test('lighthouse selection is constrained by the official returned name or id',async t=>{
 const unrelated=market({expert_id:'ex_SAMPLE_OTHER'}),row=market({display_name_zh:'腾讯轻量云官方专家'}),f=await fixture(t,{row,rows:[unrelated,row]});
 const prepared=await f.prepare({task:{taskCode:'Expert_lighthouse'}});assert.equal(prepared.feature.expertId,ID);assert.equal(prepared.feature.kind,'expert_lighthouse');assert.ok(prepared.prompt.includes('腾讯轻量云'));
 const other=await fixture(t,{row:unrelated});await assert.rejects(other.prepare({task:{taskCode:'Expert_lighthouse'}}),{code:'wb_expert_not_available'});
});
test('explicitly paid, invisible, disabled and malformed-price experts are not selected',async t=>{
 const rows=[market({pay_detail:{payMode:1}}),market({pay_detail:{pay_mode:2}}),market({need_pay:1}),market({pay_detail:{payMode:''}}),market({pay_detail:{payMode:false}}),market({visible:false}),market({disabled:true})];
 const f=await fixture(t,{rows});await assert.rejects(f.prepare(),{code:'wb_expert_not_available'});assert.equal(f.calls.length,1);
});
test('detail payment metadata is checked again instead of trusting a stale public directory',async t=>{
 const f=await fixture(t,{detail:market({pay_detail:{payMode:1}})});await assert.rejects(f.prepare(),{code:'wb_expert_not_available'});assert.equal(f.calls.length,2);
});

test('public experts without price fields require real official download authorization and bundle identity',async t=>{
 const row=market({pay_detail:undefined,expert_type:undefined}),f=await fixture(t,{row}),prepared=await f.prepare();
 assert.equal(prepared.feature.entitlementSource,'official_download_authorized');assert.equal(prepared.feature.expertType,'agent');assert.equal(f.calls.length,4);assert.equal(prepared.feature.agentName,'SAMPLE-advisor');assert.ok(!f.calls.some(call=>/purchase|subscribe|payment/i.test(call.url)));
 const denied=await fixture(t,{row,fetchImpl:(url,init,n)=>n===1?json({items:[row]}):n===2?json({experts:[row]}):new Response(JSON.stringify({code:403}),{status:403})});
 await assert.rejects(denied.prepare(),{code:'wb_expert_request_failed'});assert.equal(denied.calls.length,3);assert.deepEqual(await readdir(denied.root),['workspace']);
});
test('missing price is not sufficient when the detail is hidden, paid, mismatched or download is denied',async t=>{
 for(const detail of [market({pay_detail:undefined,visible:false}),market({pay_detail:undefined,need_pay:1}),market({pay_detail:undefined,expert_id:'ex_SAMPLE_OTHER'})]){const f=await fixture(t,{row:market({pay_detail:undefined}),detail});await assert.rejects(f.prepare(),{code:'wb_expert_not_available'});assert.equal(f.calls.length,2);}
 const f=await fixture(t,{row:market({pay_detail:undefined}),downloadStatus:403});await assert.rejects(f.prepare(),{code:'wb_expert_download_failed'});assert.deepEqual(await readdir(f.root),['workspace']);
});
test('server-returned detail must match the canonical selected expert id',async t=>{
 const f=await fixture(t,{detail:market({expert_id:'ex_SAMPLE_WRONG'})});await assert.rejects(f.prepare(),{code:'wb_expert_not_available'});assert.equal(f.calls.length,2);
});
test('downloaded manifest identity and actual role presence are validated',async t=>{
 for(const m of [manifest({marketExpertId:'ex_SAMPLE_WRONG'}),manifest({name:'SAMPLE-other-plugin'}),manifest({agentName:'SAMPLE-missing'}),manifest({expertType:'team'})]){
  const f=await fixture(t,{bundle:zip(entries({'SAMPLE-plugin/.codebuddy-plugin/plugin.json':JSON.stringify(m)}))});await assert.rejects(f.prepare(),e=>['wb_expert_bundle_invalid','wb_expert_role_missing'].includes(e.code));
 }
});
test('manifest and agent instructions never register executable plugin hooks',async t=>{
 const m=manifest({hooks:{SessionStart:[{command:'SAMPLE DO NOT EXECUTE'}]},mcpServers:{SAMPLE:{command:'SAMPLE DO NOT EXECUTE'}}}),bundle=zip(entries({'SAMPLE-plugin/.codebuddy-plugin/plugin.json':JSON.stringify(m),'SAMPLE-plugin/hooks/hooks.json':'{"command":"SAMPLE DO NOT EXECUTE"}','SAMPLE-plugin/install.js':'SAMPLE DO NOT EXECUTE'})),f=await fixture(t,{bundle});
 const prepared=await f.prepare(),defs=definitions(prepared);assert.equal(defs['SAMPLE-advisor'].hooks,undefined);assert.equal(defs['SAMPLE-advisor'].mcpServers,undefined);assert.ok(!prepared.args.includes('--plugin-dir'));
 assert.deepEqual((await readdir(prepared.feature.materializedDirectory)).sort(),['.codebuddy-plugin','agents']);
});
test('download URLs reject insecure protocols, credentials, loopback and unexpected ports',async t=>{
 for(const downloadUrl of ['http://sample.invalid/a.zip','file:///SAMPLE/a.zip','https://127.0.0.1/a.zip','https://localhost/a.zip','https://SAMPLE-user:SAMPLE-pass@example.test/a.zip','https://example.test:444/a.zip']){
  const f=await fixture(t,{downloadUrl});await assert.rejects(f.prepare(),{code:'wb_expert_bundle_invalid'});assert.equal(f.calls.length,3);
 }
});
test('expired signed download URLs and failed downloads are not accepted',async t=>{
 const expired=await fixture(t,{expiresAt:Date.now()-1000});await assert.rejects(expired.prepare(),{code:'wb_expert_download_expired'});assert.equal(expired.calls.length,3);
 const failed=await fixture(t,{downloadStatus:403});await assert.rejects(failed.prepare(),{code:'wb_expert_download_failed'});
});
test('bad official envelope fails without forwarding its body or token into an error',async t=>{
 const f=await fixture(t,{fetchImpl:()=>new Response(JSON.stringify({code:401,message:TOKEN}),{status:401})});
 await assert.rejects(f.prepare(),e=>e.code==='wb_expert_request_failed'&&!e.message.includes(TOKEN));
 const invalid=await fixture(t,{fetchImpl:()=>new Response('null')});await assert.rejects(invalid.prepare(),{code:'wb_expert_response_invalid'});
});
test('metadata and bundle response sizes are bounded before materialization',async t=>{
 const metadata=await fixture(t,{fetchImpl:()=>new Response('S'.repeat(1024*1024+1))});await assert.rejects(metadata.prepare(),{code:'wb_expert_bundle_invalid'});
 const oversized=await fixture(t,{bundle:Buffer.alloc(8*1024*1024+1)});await assert.rejects(oversized.prepare(),{code:'wb_expert_bundle_invalid'});
});
test('pre-cancelled preparation performs no credential resolution or metadata request',async t=>{
 const f=await fixture(t),controller=new AbortController(),error=Error('SAMPLE cancelled');controller.abort(error);await assert.rejects(f.prepare({signal:controller.signal}),e=>e===error);assert.equal(f.credentialReads,0);assert.equal(f.calls.length,0);
});
test('task guards run before every subsequent official operation',async t=>{
 const f=await fixture(t),error=Error('SAMPLE automatic task stopped');let count=0;
 await assert.rejects(f.prepare({check(){if(++count===4)throw error;}}),e=>e===error);assert.ok(f.calls.length<4);
});
test('AI expert APIs remain on the official AI host, while bundle fetch stays unauthenticated',async t=>{
 const f=await fixture(t,{domain:'www.workbuddy.ai'});await f.prepare();assert.ok(f.calls.slice(0,3).every(c=>new URL(c.url).hostname==='www.workbuddy.ai'));assert.equal(f.calls[3].init.headers.Authorization,undefined);
});
test('large authentic role is stored intact in isolated CLI agents instead of being truncated for argv',async t=>{
 const body='SAMPLE actual long role instructions.\n'.repeat(900),source=agent('SAMPLE-advisor',body),f=await fixture(t,{bundle:zip(entries({'SAMPLE-plugin/agents/advisor.md':source}))});
 const prepared=await f.prepare();assert.deepEqual(prepared.args,['--agent','SAMPLE-advisor']);assert.equal(await readFile(join(f.env.CODEBUDDY_CONFIG_DIR,'agents','advisor.md'),'utf8'),source);assert.equal(prepared.feature.roleHashes[0].sha256,hash(source));
});
test('an unsupported task or non-private workspace fails before any network request',async t=>{
 const f=await fixture(t);await assert.rejects(f.prepare({task:{taskCode:'SAMPLE-unsupported'}}),{code:'wb_expert_task_invalid'});assert.equal(f.calls.length,0);
 await assert.rejects(f.prepare({cwd:resolve(f.root,'..','SAMPLE-outside')}),{code:'wb_expert_private_directory_invalid'});assert.equal(f.calls.length,0);
});
