import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

// Portable: copy this file into PROJECT/tests; default source is ../src.
const SRC=process.env.VIDEO_GATEWAY_TEST_ROOT?path.resolve(process.env.VIDEO_GATEWAY_TEST_ROOT,'src'):path.resolve(import.meta.dirname,'../src');
let fixtureFetch=null,unexpectedNetwork=0;
// Install BEFORE imports, including native signer/provider default capture.
// This test never delegates to the real network, even between test cases.
globalThis.fetch=(...args)=>{if(!fixtureFetch){unexpectedNetwork++;throw new Error('fixture_network_not_armed');}return fixtureFetch(...args);};
const load=file=>import(pathToFileURL(path.join(SRC,file)));
const [{writeVideoSessionVault},{CredentialManager},{Platforms},{ClaimService},{Ledger}]=await Promise.all([load('video-session-vault.mjs'),load('credentials.mjs'),load('platforms.mjs'),load('claims.mjs'),load('store.mjs')]);
const base=path.join(tmpdir(),'video-ledger-contract-fixtures');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'isolated-'));
const kinds={jimeng:{origin:'https://jimeng.jianying.com',principal:'SAMPLE_LEDGER_JIMENG',cookie:'sessionid',domain:'.jianying.com',amount:12},kling:{origin:'https://klingai.kuaishou.com',principal:'SAMPLE_LEDGER_KLING',cookie:'kuaishou.api_st',domain:'.kuaishou.com',amount:5000}};
const vaults=new Map();
async function vault(kind){
 if(vaults.has(kind))return vaults.get(kind);const spec=kinds[kind],file=path.join(root,kind+'.vault.json');
 await writeVideoSessionVault(file,{platform:kind,origin:spec.origin,cookies:[{name:spec.cookie,value:'SAMPLE_AUTH_'+kind,domain:spec.domain,path:'/',secure:true,httpOnly:true,sameSite:'lax'}],...(kind==='jimeng'?{securityState:{xmst:'SAMPLE_AUTHORIZED_RUNTIME_STATE'}}:{})},{principal:spec.principal});
 vaults.set(kind,file);return file;
}
// First-party DTO fields are explicit, never filled by a daily-looking title.
// Jimeng: credit history grant type/source/state; Kling: trade reward category.
// First-party kling-index-DoPyX9ud.js SHA256 e9006619...3b4dbe2 UTF16 421082:
// UI copies row, then sets M.extendedType=M.type; wire extendedType is optional.
function positiveRow(kind,id){const s=kinds[kind];return kind==='jimeng'?{history_id:id,amount:s.amount,create_time:Math.floor(Date.now()/1000),title:'每日登录积分',user_id:s.principal,trade_source:'FREEMIUM_RECEIVE',history_type:1,status:'Checked'}:{orderId:id,amount:s.amount,createTime:Date.now(),message:'每日登录灵感值',userId:s.principal,type:'reward',extendedType:'reward'};}
const scenarios=[
 ['jimeng','positive checked daily grant',null,true],
 ['jimeng','explicit CheckFailed',r=>{r.status='CheckFailed';}],
 ['jimeng','pending Init',r=>{r.status='Init';}],
 ['jimeng','explicit Canceled',r=>{r.status='Canceled';}],
 ['jimeng','consumption history_type2',r=>{r.history_type=2;}],
 ['jimeng','non daily trade source',r=>{r.trade_source='SAMPLE_NON_DAILY';}],
 ['jimeng','missing status evidence',r=>{delete r.status;}],
 ['jimeng','missing grant type evidence',r=>{delete r.history_type;}],
 ['jimeng','missing daily source evidence',r=>{delete r.trade_source;}],
 ['jimeng','missing history ID',r=>{delete r.history_id;}],
 ['jimeng','missing creation date',r=>{delete r.create_time;}],
 ['jimeng','wrong canonical user',r=>{r.user_id='SAMPLE_OTHER_USER';}],
 ['jimeng','title only missing all settlement evidence',r=>{delete r.status;delete r.history_type;delete r.trade_source;delete r.user_id;}],
 ['kling','positive reward ledger',null,true],
 ['kling','refund type',r=>{r.type='refund';r.extendedType='refund';}],
 ['kling','consumption type',r=>{r.type='consume';r.extendedType='consume';}],
 ['kling','reward contradicts refund extended type',r=>{r.extendedType='refund';}],
 ['kling','unknown ledger category',r=>{r.type='SAMPLE_UNKNOWN';r.extendedType='SAMPLE_UNKNOWN';}],
 ['kling','missing grant type evidence',r=>{delete r.type;delete r.extendedType;}],
 ['kling','missing order ID',r=>{delete r.orderId;}],
 ['kling','missing creation date',r=>{delete r.createTime;}],
 ['kling','wrong canonical user',r=>{r.userId='SAMPLE_OTHER_USER';}],
 ['kling','not a daily grant description',r=>{r.message='充值退款';}],
 ['kling','reward wire derives extendedType when absent',r=>{delete r.extendedType;r.message='每日登录灵感值';},true]
];
let caseNumber=0;
for(const [kind,name,change,positive=false]of scenarios){
 const index=caseNumber++;
 test(`${kind}: ${name} cannot bypass official ledger settlement`,{skip:process.platform!=='win32',concurrency:false},async t=>{
  // Different logical day plus separate SQLite prevents global receipt/attempt cache reuse.
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,0,1+index,4)});
  const spec=kinds[kind],file=await vault(kind),dir=path.join(root,'case-'+index);await mkdir(dir,{recursive:true});
  let actions=0,reads=0;const id='SAMPLE_RECORD_'+index,row=positiveRow(kind,id);change?.(row);
  const allowed=kind==='jimeng'?new Set(['/passport/account/info/v2/','/commerce/v1/benefits/user_credit','/commerce/v1/benefits/user_credit_history','/commerce/v1/benefits/credit_receive']):new Set(['/api/user/profile_and_features','/api/account/contract','/api/account/pointAndTicket','/api/account/trade','/api/pay/reward/v2']);
  fixtureFetch=async(target,options={})=>{
   const u=new URL(typeof target==='string'?target:target.url);if(u.origin!==spec.origin||!allowed.has(u.pathname)){unexpectedNetwork++;throw new Error('fixture_destination_not_allowed');}
   assert.equal(options.redirect,'error');assert(['GET','POST'].includes(options.method));reads++;
   if(kind==='jimeng'){
    if(u.pathname==='/passport/account/info/v2/')return Response.json({message:'success',data:{user_id:spec.principal}});
    if(u.pathname.endsWith('/credit_receive')){assert.equal(options.method,'POST');actions++;return Response.json({ret:'0',data:{receive_quota:spec.amount,cur_total_credits:spec.amount}});}
    if(u.pathname.endsWith('/user_credit_history'))return Response.json({ret:'0',data:{records:actions?[row]:[],has_more:false,new_cursor:''}});
    return Response.json({ret:'0',data:{credit:{gift_credit:0,purchase_credit:0,vip_credit:0}}});
   }
   let data;if(u.pathname.endsWith('/profile_and_features'))data={login:true,userProfile:{userId:spec.principal}};
   else if(u.pathname.endsWith('/contract'))data={membership:[{type:'vip'}]};
   else if(u.pathname.endsWith('/reward/v2')){assert.equal(options.method,'POST');actions++;data={status:'SUCCESS',rewardDetail:{pointPackage:[{points:spec.amount}]}};}
   else if(u.pathname.endsWith('/trade'))data=actions?[row]:[];
   else data={total:0,points:[]};return Response.json({status:200,data});
  };
  const account={id:'fixture-'+index,platform:kind,enabled:true,inferenceEnabled:false,credentials:{kind:'file',file},tasks:[{id:'daily-checkin',enabled:true}]},config={path:p=>path.resolve(p),dataDir:dir,value:{accounts:[account],upstreams:[],routes:[],scheduler:{timezone:'Asia/Shanghai'}}};
  const ledger=new Ledger(dir);
  try{
   const credentials=new CredentialManager(config,ledger),platforms=new Platforms(config,credentials),claims=new ClaimService(config,credentials,platforms,ledger);
   const c=await credentials.resolve(account.id);assert.equal(c.source,'windows-current-user-dpapi');assert.equal(c.principal,spec.principal);assert.equal(c.principalHash,ledger.principalHash(account.id));
   const result=await claims.run(account.id,'daily-checkin',{trigger:'automatic',source:'native-ledger-contract-fixture'});
   assert.equal(actions,1,`${kind}/${name}: exactly one SAMPLE official-shaped mutation`);assert(reads>0);assert.equal(unexpectedNetwork,0);
   if(positive){assert.equal(result.status,'success',JSON.stringify(result));assert.equal(result.automaticRewardConfirmed,true);assert.deepEqual(result.officialDailyReceipt.recordIds,[id]);}
   else{assert.notEqual(result.status,'success',`${kind}/${name}: contradictory/missing ledger must not settle`);assert.equal(result.automaticRewardConfirmed,false,`${kind}/${name}: no new award`);assert.notEqual(result.benefitOutcome,'newly_granted');assert.equal(result.officialDailyReceipt,undefined);}
   const again=await claims.run(account.id,'daily-checkin',{trigger:'automatic',source:'native-ledger-contract-repeat'});assert.equal(actions,1,`${kind}/${name}: no replay`);assert.equal(again.automaticRewardConfirmed,false);
  }finally{ledger.close();fixtureFetch=null;}
 });
}
