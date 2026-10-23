import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.GATEWAY_OPTIMIZATION_TEST_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {diagnosticCode,diagnosticText,diagnosticAccountRef,diagnoseRequestRows,buildRequestDiagnostics}=await import(pathToFileURL(join(root,'src/request-diagnostics.mjs')));
const row=(over={})=>({id:1,requestId:'req-sample',attempt:1,startedAt:'2026-10-23T11:00:00.000Z',finishedAt:'2026-10-23T11:00:01.000Z',durationMs:1000,firstTokenMs:300,routeId:'public/model',model:'model-v1',platform:'workbuddy',accountId:'SAMPLE_ACCOUNT',source:'api',status:'completed',dispatched:true,dispatchCount:1,...over});
test('v2 diagnostics prepares each of 29 accounts once per group, not once per projected field',()=>{
 let reads=0;const config={accounts:Array.from({length:29},(_,i)=>({id:'SAMPLE-'+i,get credentials(){reads++;return {env:'SAMPLE_REFERENCE_'+i}}}))};
 const rows=Array.from({length:3},(_,i)=>row({id:i+1,attempt:i+1,accountId:'SAMPLE-'+i,error:{code:'provider_timeout',status:504},candidatePlan:{state:'eligible',reasonCode:'sample_reason'},relayFailure:{root:{code:'provider_timeout',status:504},last:{code:'sample_reason',status:503}}}));
 const result=diagnoseRequestRows(rows,config);assert.equal(result.candidates.length,3);assert.equal(reads,29);diagnoseRequestRows(rows,config);assert.equal(reads,58);
});
test('v2 public code sanitizer sees mutable nested credentials and key additions immediately',()=>{
 const config={accounts:[{id:'SAMPLE_ACCOUNT',credentials:{access:'OpaqueA123'}}]};
 assert.equal(diagnosticCode('opaquea123_error',config),null);assert.equal(diagnosticCode('opaqueb456_error',config),'opaqueb456_error');
 config.accounts[0].credentials.access='OpaqueB456';assert.equal(diagnosticCode('opaquea123_error',config),'opaquea123_error');assert.equal(diagnosticCode('opaqueb456_error',config),null);
 config.__diagnosticSecrets={admin:'OpaqueC789'};assert.equal(diagnosticCode('opaquec789_error',config),null);delete config.__diagnosticSecrets;assert.equal(diagnosticCode('opaquec789_error',config),'opaquec789_error');
});
test('v2 public text sanitizer refreshes mutable IDs and credentials without a stale cache',()=>{
 const config={accounts:[{id:'SAMPLE-A',credentials:{access:'OpaqueValue'}}]};
 assert.equal(diagnosticText('SAMPLE-A/model',config),diagnosticAccountRef('SAMPLE-A')+'/model');assert.equal(diagnosticText('opaquevalue-model',config),null);
 config.accounts[0].id='SAMPLE-B';config.accounts[0].credentials.access='OtherValue';assert.equal(diagnosticText('SAMPLE-A/model',config),'SAMPLE-A/model');assert.equal(diagnosticText('SAMPLE-B/model',config),diagnosticAccountRef('SAMPLE-B')+'/model');assert.equal(diagnosticText('opaquevalue-model',config),'opaquevalue-model');assert.equal(diagnosticText('othervalue-model',config),null);
});
test('v2 text masking retains longest overlapping IDs, regex escaping, global and case-sensitive replacement',()=>{
 const ids=['SAMPLE','SAMPLE.A','SAMPLE.A+X'],config={accounts:ids.map(id=>({id}))};
 assert.equal(diagnosticText('SAMPLE.A+X/SAMPLE.A/SAMPLE/SAMPLE.A+X',config),[ids[2],ids[1],ids[0],ids[2]].map(diagnosticAccountRef).join('/'));
 assert.equal(diagnosticText('sample.a/model',config),'sample.a/model');assert.equal(diagnosticCode('sample.a_error',config),null);
});
test('v2 row-only unknown account augments masking without mutating configuration',()=>{
 const config={accounts:[]},r=diagnoseRequestRows([row({accountId:'ROW_UNKNOWN',requestId:'req-ROW_UNKNOWN',routeId:'ROW_UNKNOWN/route',model:'ROW_UNKNOWN/model',error:{code:'ROW_UNKNOWN_error',status:500}})],config),ref=diagnosticAccountRef('ROW_UNKNOWN');
 assert.equal(r.requestId,'req-'+ref);assert.equal(r.requestedRoute,ref+'/route');assert.equal(r.model,ref+'/model');assert.equal(r.firstReason,null);assert.equal(r.actualSupplies[0].accountRef,ref);assert.deepEqual(config,{accounts:[]});
});
test('v2 consecutive groups observe config mutation and preserve generic first-failure selection',()=>{
 const rows=[row({status:'failed',error:{code:'OpaqueFailure',status:500}}),row({id:2,attempt:2,status:'failed',error:{code:'provider_timeout',status:504}})],config={accounts:[]};
 assert.equal(diagnoseRequestRows(rows,config).firstReason.code,'OpaqueFailure');config.accounts.push({id:'SAMPLE_NEW',credentials:{access:'OpaqueFailure'}});
 const r=diagnoseRequestRows(rows,config);assert.equal(r.firstReason,null);assert.equal(r.lastReason.code,'provider_timeout');assert.equal(r.candidates[0].reasonCode,null);
});
test('v2 numeric, upstream-only, cyclic and shared secret data retain rejection rules',()=>{
 const shared={access:'OpaqueShared'},account={id:'SAMPLE_ACCOUNT',credentials:shared,uid:778899};account.self=account;
 const config={accounts:[account,{id:'SAMPLE_SECOND',credentials:shared}],upstreams:[{accountId:'UPSTREAM_ONLY'}],__diagnosticSecrets:{nested:{value:'OpaqueGateway'}}};
 for(const value of ['opaqueshared','778899','upstream_only','opaquegateway']){assert.equal(diagnosticCode('error_'+value,config),null);assert.equal(diagnosticText('model_'+value,config),null);}
 assert.equal(diagnosticText('SAMPLE_ACCOUNT/model',config),diagnosticAccountRef('SAMPLE_ACCOUNT')+'/model');
});
test('v2 syntactically invalid public values remain null without traversing config',()=>{
 const config={get accounts(){throw Error('unexpected traversal')}};
 for(const value of [null,undefined,17,{},'', 'Bearer_TOKEN','https://HOST/PAYLOAD','C:/Users/SAMPLE']){assert.equal(diagnosticText(value,config),null);assert.equal(diagnosticCode(value,config),null);}
});
test('v2 request list key changes are fresh across report calls',()=>{
 const config={value:{accounts:[]}},keys={apiKey:'OpaqueFirst'},rows=[row({error:{code:'OpaqueFirst',status:500}})],service={config,keys,ledger:{usage:()=>({records:rows,nextBeforeId:null})}},options={now:Date.parse('2026-10-23T12:00:00Z')};
 assert.equal(buildRequestDiagnostics(service,options).items[0].firstReason,null);keys.apiKey='OpaqueSecond';assert.equal(buildRequestDiagnostics(service,options).items[0].firstReason.code,'OpaqueFirst');
});
test('v2 complete sensitive projection corpus matches frozen baseline output',()=>{
 const config={accounts:[{id:'SAMPLE'},{id:'SAMPLE.A'},{id:'SAMPLE.A+X',uid:'UidOpaque7788',credentials:{access:'OpaqueAccess7799',nested:{env:'SAMPLE_CREDENTIAL_REFERENCE'}}}],upstreams:[{accountId:'UPSTREAM_ONLY'}],__diagnosticSecrets:{admin:'OpaqueAdmin5511'}};
 const values=['public-model','provider_timeout','SAMPLE','SAMPLE.A','SAMPLE.A+X','SAMPLE.A+X/model/SAMPLE','sample.a/model','UidOpaque7788','uidopaque7788','OpaqueAccess7799','opaqueaccess7799_error','SAMPLE_CREDENTIAL_REFERENCE','UPSTREAM_ONLY','upstream_only','OpaqueAdmin5511','Bearer_TOKEN','sk-abcdefghijk','https://HOST/PAYLOAD','C:/Users/private','/home/private','token=VALUE','api_key','unknown','中文模型','a+b@c:1',null,17,'','x'.repeat(201)];
 const output=[];for(let i=0;i<values.length;i++){const value=values[i];output.push([diagnosticCode(value,config),diagnosticText(value,config),diagnoseRequestRows([row({requestId:value,routeId:value,model:value,platform:value,accountId:i%2?'ROW_UNKNOWN':'SAMPLE.A+X',status:'failed',error:{code:value,status:429},candidatePlan:{state:'skipped',reasonCode:value,capabilities:{tools:false,contextWindow:1000}},rateLimit:{upstreamCode:6004,rateLimitKind:'long_window',retryAfterSeconds:7200},relayFailure:{root:{code:value,status:429,platform:value},last:{code:value,status:503}}}),row({id:2,attempt:2,model:value,accountId:'ROW_UNKNOWN',status:'skipped',dispatched:false,error:{code:'tools_not_supported',status:400},requestOutcome:{schema:1,state:'failed'}})],config)]);}
 const digest=createHash('sha256').update(JSON.stringify(output)).digest('hex');assert.equal(digest,'361acf776baa0ade39c9bb30e670c65a84ef0a86593997a6cf42205896c0bb25');
});