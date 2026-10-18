import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {clientActivationReport,clientActivationConfigurationFingerprint} from '../src/client-activation.mjs';

const VERSION='0.6.0', NOW=new Date('2026-10-18T12:00:00.000Z');
const SECRET='SAMPLE_PRIVATE_API_KEY_NEVER_RETURN_0001';
const integrationFiles=['package.json','bundle/index.mjs','bundle/worker.mjs','bundle/model-refresh.mjs',
  'bundle/request-policy.mjs','bundle/retry-metadata.mjs','src/client-contract.mjs','src/request-timeouts.mjs',
  'src/server.mjs','src/router.mjs','src/model-relay.mjs'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const bundleName='dsh-ai-credit-gateway', pluginName='ai-credit-reliability';
const stage=(report,id,key)=>report.checks.find(c=>c.id===id).stages[key].status;

async function fixture(t,{installed=false,key=true,hermes=true}={}) {
  const folder=await mkdtemp(join(tmpdir(),'client-activation-SAMPLE-'));
  t.after(async()=>{assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));await rm(folder,{recursive:true,force:true});});
  const home=join(folder,'home'),sourceRoot=join(folder,'source'),data=join(folder,'data');
  const dshProfile=join(home,'.dsh','profiles','desktop'),dshPackageRoot=join(dshProfile,'node_modules',bundleName);
  const hermesHome=join(home,'.hermes'),hermesSource=join(hermesHome,'hermes-agent');
  const configFile=join(folder,'SAMPLE-config.json'),keysFile=join(data,'api-keys.json');
  const helper=join(sourceRoot,'scripts','hermes-key.mjs'),node=join(folder,'SAMPLE-node.exe');
  const write=async(file,text)=>{await mkdir(dirname(file),{recursive:true});await writeFile(file,text);};
  const packageText=JSON.stringify({name:bundleName,version:VERSION});
  const content=file=>file==='package.json'?packageText:`SAMPLE fixture ${file}\n`;
  for(const file of integrationFiles)await write(join(sourceRoot,file),content(file));
  await write(helper,'// SAMPLE helper; never execute\n');await write(node,'SAMPLE not an executable\n');
  for(const file of ['plugin.yaml','__init__.py'])await write(join(sourceRoot,'integrations','hermes',pluginName,file),file==='plugin.yaml'?`name: ${pluginName}\nversion: 1.0.0\n`:'# SAMPLE plugin\n');
  await write(join(sourceRoot,'integrations','hermes','native-patch','agent','chat_completion_helpers.py'),'# SAMPLE native patch\n');
  let sideEffects=0;
  const noSideEffect=()=>{sideEffects++;throw new Error('SAMPLE side effect forbidden');};
  const config={server:{host:'127.0.0.1',port:19421},routes:[{id:'SAMPLE-route',enabled:true,targets:[{upstreamId:'SAMPLE',model:'SAMPLE-model'}]}]};
  const service={config:{file:configFile,dataDir:data,value:config,load:noSideEffect,save:noSideEffect},
    keys:key?{apiKey:SECRET}:{},keysFile,router:{models:noSideEffect,chat:noSideEffect},
    platforms:{models:noSideEffect,health:noSideEffect},credentials:{get:noSideEffect,refresh:noSideEffect},
    ledger:{get:noSideEffect,set:noSideEffect},claims:{run:noSideEffect}};
  await write(configFile,JSON.stringify(config));await write(keysFile,JSON.stringify({apiKey:SECRET,adminKey:'SAMPLE_ADMIN_KEY_NEVER_RETURN'}));
  let yaml=`providers:\n  ai-credit:\n    base_url: http://127.0.0.1:19421/v1\n    key_cmd: '\"${node.replaceAll('\\','/')}\" \"${helper.replaceAll('\\','/')}\" \"${keysFile.replaceAll('\\','/')}\"'\nplugins:\n  enabled:\n    - SAMPLE-other-plugin\n    - ${pluginName}\n  disabled: []\n`;
  const install=async()=>{
    await write(join(dshProfile,'package.json'),JSON.stringify({dsh:{profile:{bundles:[bundleName]}}}));
    await write(join(dshProfile,'cordis.patch.yml'),`- id: SAMPLE-other\n  config:\n    configFile: SAMPLE-unrelated\n- id: ${bundleName}\n  config:\n    configFile: ${JSON.stringify(configFile)}\n`);
    await write(join(data,'dsh-install','record.json'),JSON.stringify({profile:dshProfile,configFile}));
    for(const file of integrationFiles)await write(join(dshPackageRoot,file),content(file));
    if(hermes){
      await write(join(hermesHome,'config.yaml'),yaml);
      await write(join(hermesSource,'pyproject.toml'),'[project]\nname = "hermes-agent"\nversion = "1.0.0"\n');
      await write(join(hermesSource,'hermes_cli','__init__.py'),'# SAMPLE hermes cli\n');
      await write(join(hermesSource,'agent','chat_completion_helpers.py'),'# SAMPLE native patch\n');
      for(const file of ['plugin.yaml','__init__.py'])await write(join(hermesHome,'plugins',pluginName,file),await readFile(join(sourceRoot,'integrations','hermes',pluginName,file)));
    }
  };
  if(installed)await install();
  const options={home,env:{},paths:{sourceRoot},runtimeVersion:VERSION,now:NOW};
  const report=extra=>clientActivationReport(service,{...options,...extra});
  return {folder,home,sourceRoot,dshProfile,dshPackageRoot,hermesHome,hermesSource,service,options,write,report,install,
    yaml,helper,node,keysFile,sideEffects:()=>sideEffects,content};
}
async function tree(folder) {
  const values=[];
  async function visit(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await visit(file);else values.push([file,digest(await readFile(file))]);}}
  await visit(folder);return values.sort(([a],[b])=>a.localeCompare(b));
}
async function fingerprints(f) {
  const dsh=digest(JSON.stringify(await Promise.all(integrationFiles.map(async file=>digest(await readFile(join(f.dshPackageRoot,file)))))));
  const hermes=digest(JSON.stringify(await Promise.all([
    join(f.hermesHome,'plugins',pluginName,'plugin.yaml'),join(f.hermesHome,'plugins',pluginName,'__init__.py'),
    join(f.hermesSource,'agent','chat_completion_helpers.py')].map(async file=>digest(await readFile(file))))));
  const config=clientActivationConfigurationFingerprint(f.service.config.value,{apiKey:f.service.keys.apiKey});
  const dshConfig=digest(JSON.stringify(await Promise.all([join(f.dshProfile,'package.json'),join(f.dshProfile,'cordis.patch.yml')].map(async file=>digest(await readFile(file))))));
  const hermesConfig=digest(JSON.stringify([digest(await readFile(join(f.hermesHome,'config.yaml')))]));
  return {dsh,hermes,config,dshConfig,hermesConfig};
}
function receipts(fingerprint,id) {
  const binding={configFingerprint:fingerprint.config,clientConfigFingerprint:fingerprint[id+'Config'],codeFingerprint:fingerprint[id]};
  return {
    runtime:{direct:true,source:'active-runtime-handshake',observedAt:NOW.toISOString(),...binding},
    publication:{direct:true,source:'client-model-registry',observedAt:NOW.toISOString(),count:1,...binding},
    acceptance:{direct:true,source:'client-task-receipt',observedAt:NOW.toISOString(),gatewayVersion:VERSION,ordinary:true,toolsExecuted:true,toolResultReturned:true,finalAnswer:true,...binding}
  };
}

test('SAMPLE missing clients do not become installed or activated',async t=>{
  const f=await fixture(t),report=await f.report();
  assert.equal(stage(report,'gateway','installed'),'passed');
  for(const id of ['dsh','hermes']){assert.equal(stage(report,id,'installed'),'missing');assert.equal(stage(report,id,'configured'),'missing');assert.equal(stage(report,id,'runtimeLoaded'),'unknown');assert.equal(stage(report,id,'modelPublished'),'unknown');assert.equal(stage(report,id,'acceptance'),'notRun');}
  assert.equal(report.readOnly,true);assert.equal(report.schemaVersion,1);assert.equal(f.sideEffects(),0);
});

test('SAMPLE configured and identical disk files remain pending runtime / publication / acceptance',async t=>{
  const f=await fixture(t,{installed:true}),report=await f.report();
  for(const id of ['dsh','hermes']){
    assert.equal(stage(report,id,'installed'),'passed');assert.equal(stage(report,id,'configured'),'passed');
    assert.equal(stage(report,id,'diskSynced'),'passed');assert.equal(stage(report,id,'runtimeLoaded'),'pendingReload');
    assert.equal(stage(report,id,'modelPublished'),'unknown');assert.equal(stage(report,id,'acceptance'),'notRun');
  }
  assert.equal(stage(report,'gateway','runtimeLoaded'),'passed');
  assert.equal(stage(report,'gateway','diskSynced'),'unknown','same version is not a code hash proof');
  assert.equal(f.sideEffects(),0);
});

test('SAMPLE direct fresh runtime handshake is bound to integration hashes',async t=>{
  const f=await fixture(t,{installed:true}),fingerprint=await fingerprints(f);
  const evidence=Object.fromEntries(['dsh','hermes'].map(id=>[id,{runtime:receipts(fingerprint,id).runtime}]));
  let report=await f.report({evidence});
  for(const id of ['dsh','hermes'])assert.equal(stage(report,id,'runtimeLoaded'),'passed');
  evidence.dsh.runtime.codeFingerprint='SAMPLE-wrong-hash';evidence.hermes.runtime.observedAt='2026-10-17T12:00:00Z';
  report=await f.report({evidence});
  assert.equal(stage(report,'dsh','runtimeLoaded'),'pendingReload');assert.equal(stage(report,'hermes','runtimeLoaded'),'pendingReload');
});

test('SAMPLE publication and real task acceptance require independent current receipts',async t=>{
  const f=await fixture(t,{installed:true}),fingerprint=await fingerprints(f);
  const evidence={hermes:receipts(fingerprint,'hermes')};
  let report=await f.report({evidence});assert.equal(stage(report,'hermes','modelPublished'),'passed');assert.equal(stage(report,'hermes','acceptance'),'passed');
  evidence.hermes.acceptance.toolResultReturned=false;evidence.hermes.publication.configFingerprint='SAMPLE-old-config';
  report=await f.report({evidence});assert.equal(stage(report,'hermes','modelPublished'),'unknown');assert.equal(stage(report,'hermes','acceptance'),'notRun');
  assert.equal(f.sideEffects(),0);
});

test('SAMPLE old DSH disk version and gateway startup version expose distinct mismatch states',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.dshPackageRoot,'package.json'),JSON.stringify({name:bundleName,version:'0.5.0'}));
  const report=await f.report({runtimeVersion:'0.5.1'});
  assert.equal(stage(report,'dsh','diskSynced'),'mismatch');assert.equal(stage(report,'dsh','runtimeLoaded'),'pendingReload');
  assert.equal(stage(report,'gateway','runtimeLoaded'),'pendingReload');assert.equal(stage(report,'gateway','diskSynced'),'mismatch');
});

test('SAMPLE same metadata version with changed DSH code is not disk synced',async t=>{
  const f=await fixture(t,{installed:true});await f.write(join(f.dshPackageRoot,'bundle','index.mjs'),'SAMPLE old implementation\n');
  assert.equal(stage(await f.report(),'dsh','diskSynced'),'mismatch');
});

test('SAMPLE missing key is not configured; key_cmd is never invoked',async t=>{
  const f=await fixture(t,{installed:true,key:false}),report=await f.report();
  assert.equal(stage(report,'gateway','configured'),'missing');assert.equal(stage(report,'hermes','configured'),'missing');
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml.replace(/^\s+key_cmd:.*\n/m,''));
  assert.equal(stage(await f.report(),'hermes','configured'),'missing');assert.equal(f.sideEffects(),0);
});

test('SAMPLE wrong DSH config binding, wrong Hermes port, disabled target plugin stay distinct',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.dshProfile,'cordis.patch.yml'),`- id: ${bundleName}\n  config:\n    configFile: ${JSON.stringify(join(f.folder,'SAMPLE-other-config.json'))}\n`);
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml.replace('19421/v1','19422/v1').replace('disabled: []',`disabled: [${pluginName}]`));
  const report=await f.report();assert.equal(stage(report,'dsh','configured'),'missing');assert.equal(stage(report,'hermes','configured'),'missing');assert.equal(stage(report,'hermes','diskSynced'),'unknown');
});

test('SAMPLE Hermes plugin metadata alone is not code sync or active runtime evidence',async t=>{
  const f=await fixture(t,{installed:true});await f.write(join(f.hermesSource,'agent','chat_completion_helpers.py'),'# SAMPLE changed native implementation\n');
  const report=await f.report();assert.equal(stage(report,'hermes','diskSynced'),'mismatch');assert.equal(stage(report,'hermes','runtimeLoaded'),'pendingReload');
});

test('SAMPLE duplicate or unsupported YAML does not infer configuration',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml+'providers:\n  ai-credit:\n    api_key: '+SECRET+'\n');
  assert.equal(stage(await f.report(),'hermes','configured'),'unknown');
  await f.write(join(f.hermesHome,'config.yaml'),'providers:\n  ai-credit: *SAMPLE-alias\n');
  assert.notEqual(stage(await f.report(),'hermes','configured'),'passed');
});

test('SAMPLE inline provider key is a local configuration shape, not runtime proof',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml.replace(/^\s+key_cmd:.*$/m,'    api_key: '+SECRET));
  const report=await f.report();assert.equal(stage(report,'hermes','configured'),'passed');assert.equal(stage(report,'hermes','runtimeLoaded'),'pendingReload');assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('SAMPLE denied / malformed files are fixed redacted statuses',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.dshProfile,'package.json'),'{SAMPLE malformed');
  const report=await f.report({readFile:async(file)=>{if(file===join(f.hermesHome,'config.yaml'))throw Object.assign(new Error('SAMPLE path and token '+SECRET),{code:'EACCES'});return readFile(file);}});
  assert.equal(stage(report,'dsh','configured'),'error');assert.equal(stage(report,'hermes','configured'),'error');
  assert.ok(report.diagnostics.unreadableReads>=2);
  assert.ok(!JSON.stringify(report).includes(SECRET));assert.ok(!JSON.stringify(report).includes(f.folder));
});

test('SAMPLE stalled local read has a bounded timeout and no provider fallback',async t=>{
  const f=await fixture(t,{installed:true});const started=Date.now();
  const report=await f.report({timeoutMs:20,readFile:async(file)=>file===join(f.hermesHome,'config.yaml')?new Promise(()=>{}):readFile(file)});
  assert.ok(Date.now()-started<2000);assert.equal(stage(report,'hermes','configured'),'error');assert.equal(report.diagnostics.timedOutReads,1);assert.equal(f.sideEffects(),0);
});

test('SAMPLE inspection does not alter any file or inspect unbounded / external paths',async t=>{
  const f=await fixture(t,{installed:true}),before=await tree(f.folder),reads=[];
  const report=await f.report({readFile:async(file)=>{assert.ok(resolve(file).startsWith(resolve(f.folder)+sep));reads.push(file);return readFile(file);},statFile:async(file)=>{assert.equal(file,f.node);return stat(file);}});
  assert.deepEqual(await tree(f.folder),before);assert.ok(reads.length<60);assert.equal(f.sideEffects(),0);
  const serialized=JSON.stringify(report);for(const value of [SECRET,'SAMPLE_ADMIN_KEY_NEVER_RETURN',f.folder,f.service.config.file,'SAMPLE-route','SAMPLE-model'])assert.ok(!serialized.includes(value),value);
});

test('SAMPLE missing runtimeVersion never becomes current startup or acceptance proof',async t=>{
  const f=await fixture(t,{installed:true}),report=await f.report({runtimeVersion:undefined});
  assert.equal(stage(report,'gateway','runtimeLoaded'),'unknown');assert.equal(stage(report,'gateway','acceptance'),'notRun');
});

test('SAMPLE duplicate DSH configuration bindings do not pass inspection',async t=>{
  const f=await fixture(t,{installed:true});
  const patch=await readFile(join(f.dshProfile,'cordis.patch.yml'),'utf8');
  await f.write(join(f.dshProfile,'cordis.patch.yml'),patch+`- id: ${bundleName}\n  config:\n    configFile: ${JSON.stringify(f.service.config.file)}\n`);
  assert.notEqual(stage(await f.report(),'dsh','configured'),'passed');
});

test('SAMPLE unsupported JSON-as-YAML and alias provider stay unknown, without command execution',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.hermesHome,'config.yaml'),JSON.stringify({providers:{'ai-credit':{base_url:'http://127.0.0.1:19421/v1',api_key:SECRET}}}));
  assert.equal(stage(await f.report(),'hermes','configured'),'unknown');
  await f.write(join(f.hermesHome,'config.yaml'),'providers:\n  ai-credit: *SAMPLE-provider\n');
  assert.equal(stage(await f.report(),'hermes','configured'),'unknown');
});

test('SAMPLE old receipts expire on endpoint, account, upstream, pool or model-key changes',async t=>{
  const f=await fixture(t,{installed:true}),fingerprint=await fingerprints(f);
  const evidence={dsh:receipts(fingerprint,'dsh'),hermes:receipts(fingerprint,'hermes')};
  const before=structuredClone(f.service.config.value),originalKey=f.service.keys.apiKey;
  let report=await f.report({evidence});
  for(const id of ['dsh','hermes'])for(const key of ['runtimeLoaded','modelPublished','acceptance'])assert.equal(stage(report,id,key),'passed');
  const mutations=[c=>{c.server.port=19422;},c=>{c.accounts=[{id:'SAMPLE_ACCOUNT',enabled:false,inferenceEnabled:false}];},c=>{c.upstreams=[{id:'SAMPLE',enabled:false}];},c=>{c.routes[0].accountPool={enabled:true,accountIds:['SAMPLE']};},()=>{f.service.keys.apiKey='SAMPLE_CHANGED_MODEL_KEY_000000000000';}];
  for(const mutate of mutations){
    f.service.config.value=structuredClone(before);f.service.keys.apiKey=originalKey;mutate(f.service.config.value);
    report=await f.report({evidence});
    for(const id of ['dsh','hermes'])for(const key of ['runtimeLoaded','modelPublished','acceptance'])assert.notEqual(stage(report,id,key),'passed',id+'/'+key);
  }
});

test('SAMPLE runtime, publication and acceptance bind exact client config and integration code',async t=>{
  const f=await fixture(t,{installed:true}),fingerprint=await fingerprints(f),evidence={dsh:receipts(fingerprint,'dsh'),hermes:receipts(fingerprint,'hermes')};
  await f.write(join(f.dshPackageRoot,'bundle','worker.mjs'),'SAMPLE modified same-version worker\n');
  let report=await f.report({evidence});assert.equal(stage(report,'dsh','diskSynced'),'mismatch');
  for(const key of ['runtimeLoaded','modelPublished','acceptance'])assert.notEqual(stage(report,'dsh',key),'passed');
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml+'# SAMPLE changed client configuration\n');
  report=await f.report({evidence});
  for(const key of ['runtimeLoaded','modelPublished','acceptance'])assert.notEqual(stage(report,'hermes',key),'passed');
});

test('SAMPLE changed DSH binding cannot retain a previously loaded receipt',async t=>{
  const f=await fixture(t,{installed:true}),fingerprint=await fingerprints(f),evidence={dsh:receipts(fingerprint,'dsh')};
  await f.write(join(f.dshProfile,'cordis.patch.yml'),`- id: ${bundleName}\n  config:\n    configFile: ${JSON.stringify(join(f.folder,'SAMPLE_OTHER.json'))}\n`);
  const report=await f.report({evidence});assert.equal(stage(report,'dsh','configured'),'missing');
  for(const key of ['runtimeLoaded','modelPublished','acceptance'])assert.notEqual(stage(report,'dsh',key),'passed');
});

test('SAMPLE wrong inline model key is a mismatch rather than configured',async t=>{
  const f=await fixture(t,{installed:true}),wrong='SAMPLE_WRONG_MODEL_KEY_000000000000000';
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml.replace(/^\s+key_cmd:.*$/m,'    api_key: '+wrong));
  const report=await f.report();assert.equal(stage(report,'hermes','configured'),'mismatch');
  assert.ok(!JSON.stringify(report).includes(wrong));assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('SAMPLE invalid YAML lines, scalar children and inconsistent siblings stay unknown',async t=>{
  const f=await fixture(t,{installed:true});
  for(const yaml of [f.yaml+'@SAMPLE_INVALID_YAML\n',f.yaml+'SAMPLE_scalar: true\n  SAMPLE_child: value\n',f.yaml.replace('    base_url:','   base_url:')]){
    await f.write(join(f.hermesHome,'config.yaml'),yaml);
    const report=await f.report();assert.equal(stage(report,'hermes','configured'),'unknown');assert.notEqual(stage(report,'hermes','diskSynced'),'passed');
  }
});

test('SAMPLE configFile outside the direct DSH config mapping is not a binding',async t=>{
  const f=await fixture(t,{installed:true});
  for(const middle of ['  unrelated:\n    configFile: ','  config:\n    unrelated:\n      configFile: ']){
    await f.write(join(f.dshProfile,'cordis.patch.yml'),`- id: ${bundleName}\n${middle}${JSON.stringify(f.service.config.file)}\n`);
    assert.notEqual(stage(await f.report(),'dsh','configured'),'passed');
  }
});

test('SAMPLE denied DSH profile reports error and increments unreadable count',async t=>{
  const f=await fixture(t,{installed:true});
  const report=await f.report({readFile:async file=>{if(file===join(f.dshProfile,'package.json'))throw Object.assign(new Error('SAMPLE'),{code:'EACCES'});return readFile(file);}});
  assert.equal(stage(report,'dsh','configured'),'error');assert.ok(report.diagnostics.unreadableReads>=1);
});

test('SAMPLE configuration changed while reading invalidates old proof and configuration stage',async t=>{
  const f=await fixture(t,{installed:true}),fingerprint=await fingerprints(f),evidence={dsh:receipts(fingerprint,'dsh'),hermes:receipts(fingerprint,'hermes')};
  let changed=false;
  const report=await f.report({evidence,readFile:async file=>{if(!changed){changed=true;f.service.config.value.server.port=19422;}return readFile(file);}});
  for(const id of ['dsh','hermes']){assert.equal(stage(report,id,'configured'),'unknown');for(const key of ['runtimeLoaded','modelPublished','acceptance'])assert.notEqual(stage(report,id,key),'passed');}
});

test('SAMPLE helper credential-file rotation cannot reuse a current-service receipt',async t=>{
  const f=await fixture(t,{installed:true}),fingerprint=await fingerprints(f),evidence={hermes:receipts(fingerprint,'hermes')};
  await f.write(f.keysFile,JSON.stringify({apiKey:'SAMPLE_ROTATED_FILE_KEY_000000000000000'}));
  const report=await f.report({evidence});assert.equal(stage(report,'hermes','configured'),'mismatch');
  for(const key of ['runtimeLoaded','modelPublished','acceptance'])assert.notEqual(stage(report,'hermes',key),'passed');
  assert.ok(!JSON.stringify(report).includes('SAMPLE_ROTATED_FILE_KEY'));
});

test('SAMPLE dotted YAML keys cannot impersonate the nested Provider or DSH config binding',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.hermesHome,'config.yaml'),`providers.ai-credit:\nproviders.ai-credit.base_url: http://127.0.0.1:19421/v1\nproviders.ai-credit.api_key: ${SECRET}\n`);
  assert.notEqual(stage(await f.report(),'hermes','configured'),'passed');
  await f.write(join(f.dshProfile,'cordis.patch.yml'),`- id: ${bundleName}\n  config.configFile: ${JSON.stringify(f.service.config.file)}\n`);
  assert.notEqual(stage(await f.report(),'dsh','configured'),'passed');
});

function wrappedPath(value) {
  const quoted=JSON.stringify(value.replaceAll('\\','/')),at=Math.floor(quoted.length/2);
  return quoted.slice(0,at)+'\\\n      '+quoted.slice(at);
}

test('SAMPLE DSH double-quoted backslash line continuation preserves the exact config binding',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.dshProfile,'cordis.patch.yml'),`- id: ${bundleName}\n  config:\n    configFile: ${wrappedPath(f.service.config.file)}\n  disabled: false\n`);
  const report=await f.report();assert.equal(stage(report,'dsh','configured'),'passed');
  assert.equal(stage(report,'dsh','runtimeLoaded'),'pendingReload');assert.equal(stage(report,'dsh','acceptance'),'notRun');
});

test('SAMPLE malformed multiline quoting never becomes a DSH config binding',async t=>{
  const f=await fixture(t,{installed:true});
  const malformed=[wrappedPath(f.service.config.file).replace('\\\n','\n'),wrappedPath(f.service.config.file).slice(0,-1),wrappedPath(f.service.config.file).replace('\n      ','\n  ')];
  for(const value of malformed){
    await f.write(join(f.dshProfile,'cordis.patch.yml'),`- id: ${bundleName}\n  config:\n    configFile: ${value}\n`);
    assert.notEqual(stage(await f.report(),'dsh','configured'),'passed');
  }
});

test('SAMPLE wrapped configFile still enforces direct parent, duplicate fields and unique target',async t=>{
  const f=await fixture(t,{installed:true}),value=wrappedPath(f.service.config.file);
  const configurations=[
    `- id: ${bundleName}\n  unrelated:\n    configFile: ${value}\n`,
    `- id: ${bundleName}\n  config:\n    configFile: ${value}\n    configFile: ${value}\n`,
    `- id: ${bundleName}\n  config:\n    configFile: ${value}\n- id: ${bundleName}\n  config:\n    configFile: ${value}\n`
  ];
  for(const patch of configurations){await f.write(join(f.dshProfile,'cordis.patch.yml'),patch);assert.notEqual(stage(await f.report(),'dsh','configured'),'passed');}
});

test('SAMPLE Hermes unrelated indentless MCP argument lists do not hide its named Provider',async t=>{
  const f=await fixture(t,{installed:true});
  const unrelated='mcp_servers:\n  SAMPLE_server:\n    command: SAMPLE-command\n    args:\n    - stdio\n    - SAMPLE-argument\n    env:\n      SAMPLE_VARIABLE: SAMPLE-value\n    enabled: true\n';
  await f.write(join(f.hermesHome,'config.yaml'),unrelated+f.yaml);
  const report=await f.report();assert.equal(stage(report,'hermes','configured'),'passed');assert.equal(stage(report,'hermes','diskSynced'),'passed');assert.equal(stage(report,'hermes','runtimeLoaded'),'pendingReload');
});

test('SAMPLE Hermes unrelated indentless arrays of mappings preserve target section boundaries',async t=>{
  const f=await fixture(t,{installed:true});
  const unrelated='moa:\n  presets:\n    default:\n      reference_models:\n      - provider: SAMPLE-first\n        model: SAMPLE-model-a\n        enabled: true\n      - provider: SAMPLE-second\n        model: SAMPLE-model-b\n        enabled: false\n';
  await f.write(join(f.hermesHome,'config.yaml'),unrelated+f.yaml);
  const report=await f.report();assert.equal(stage(report,'hermes','configured'),'passed');assert.equal(stage(report,'hermes','diskSynced'),'passed');assert.equal(stage(report,'hermes','modelPublished'),'unknown');
  await f.write(join(f.hermesHome,'config.yaml'),unrelated.replace('        model: SAMPLE-model-a\n','        model: SAMPLE-model-a\n        model: SAMPLE-duplicate\n')+f.yaml);
  assert.equal(stage(await f.report(),'hermes','configured'),'unknown','duplicate mapping keys are still rejected');
});

test('SAMPLE target plugin enabled block list supports explicit indentless strings only',async t=>{
  const f=await fixture(t,{installed:true});
  const inlineIndentless=f.yaml.replace('  enabled:\n    - SAMPLE-other-plugin\n    - '+pluginName,'  enabled:\n  - SAMPLE-other-plugin\n  - '+pluginName);
  await f.write(join(f.hermesHome,'config.yaml'),inlineIndentless);
  assert.equal(stage(await f.report(),'hermes','diskSynced'),'passed');
  for(const invalid of [inlineIndentless.replace('  - SAMPLE-other-plugin','  - true'),inlineIndentless.replace('  - SAMPLE-other-plugin','  - 12'),inlineIndentless.replace('  - SAMPLE-other-plugin','  - name: SAMPLE-map'),inlineIndentless.replace('  disabled: []','  disabled: false')]){
    await f.write(join(f.hermesHome,'config.yaml'),invalid);
    assert.notEqual(stage(await f.report(),'hermes','diskSynced'),'passed');
  }
});

test('SAMPLE target Provider duplicate after unrelated mapping arrays remains unknown',async t=>{
  const f=await fixture(t,{installed:true});
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml+'moa:\n  models:\n  - provider: SAMPLE\n    enabled: true\nproviders:\n  ai-credit:\n    base_url: http://127.0.0.1:19421/v1\n');
  assert.equal(stage(await f.report(),'hermes','configured'),'unknown');
});

test('SAMPLE custom two-token Hermes helper stays unknown and is never executed',async t=>{
  const f=await fixture(t,{installed:true}),custom=join(f.folder,'SAMPLE-custom-helper.mjs');
  await f.write(custom,'throw new Error("SAMPLE helper must never execute");\n');
  const command=`'"${f.node.replaceAll('\\','/')}" "${custom.replaceAll('\\','/')}"'`;
  await f.write(join(f.hermesHome,'config.yaml'),f.yaml.replace(/^\s+key_cmd:.*$/m,'    key_cmd: '+command));
  const report=await f.report();assert.equal(stage(report,'hermes','configured'),'unknown');assert.equal(stage(report,'hermes','diskSynced'),'passed');assert.equal(stage(report,'hermes','acceptance'),'notRun');assert.equal(f.sideEffects(),0);
});

test('SAMPLE disabled or wrong-typed DSH target does not become configured even with a wrapped binding',async t=>{
  const f=await fixture(t,{installed:true});
  for(const disabled of ['true','"false"']){
    await f.write(join(f.dshProfile,'cordis.patch.yml'),`- id: ${bundleName}\n  config:\n    configFile: ${wrappedPath(f.service.config.file)}\n  disabled: ${disabled}\n`);
    assert.notEqual(stage(await f.report(),'dsh','configured'),'passed');
  }
});

test('SAMPLE nested bundle targets do not impersonate direct Cordis root sequence entries',async t=>{
  const f=await fixture(t,{installed:true});
  const root=`- id: ${bundleName}\n  config:\n    configFile: ${wrappedPath(f.service.config.file)}\n`;
  for(const patch of ['unrelated:\n'+root.split('\n').map(line=>line?'  '+line:line).join('\n'),'- id: SAMPLE-unrelated\n  config:\n    nested:\n'+root.split('\n').map(line=>line?'      '+line:line).join('\n')]){
    await f.write(join(f.dshProfile,'cordis.patch.yml'),patch);
    assert.notEqual(stage(await f.report(),'dsh','configured'),'passed');
  }
  for(const patch of [root.split('\n').map(line=>line?'  '+line:line).join('\n'),'\uFEFF---\n'+root]){
    await f.write(join(f.dshProfile,'cordis.patch.yml'),patch);
    assert.equal(stage(await f.report(),'dsh','configured'),'passed','legitimate whole-root indentation and BOM/document header remain supported');
  }
});
