import test from 'node:test';
import assert from 'node:assert/strict';
import {raccoonProvider,raccoonClaim,raccoonStatus} from '../src/provider-raccoon.mjs';

const now=Date.parse('2026-10-21T02:00:00Z');
const secret={authKind:'bearer',accessToken:'fixture-token',principal:'fixture-principal'};
const plain={biz_type:'daily_grant',points:300,grant_at:'2026-10-21T00:00:00+08:00',expire_at:'2026-10-21T23:59:59+08:00'};
const extended={...plain,expire_at:'2026-10-27T23:59:59+08:00'};
const json=data=>Response.json({code:0,data});
function transport({before=[plain],after=[extended],loginError,settingError,settings={point_grant_popups:[{source:'daily',points:300}]}}={}){
 let initialized=false;
 const calls=[];
 const fetchImpl=async(url,init)=>{
  const path=new URL(url).pathname;
  calls.push({path,method:init.method,body:init.body});
  assert.equal(init.method,'GET','daily login must never submit a reward/claim POST');
  assert.equal(init.headers.authorization,'Bearer fixture-token');
  if(path==='/api/web/points/v1/balance')return json({daily_points:900,available_points:6900});
  if(path==='/api/web/points/v1/bills')return json({items:initialized?after:before});
  assert.equal(init.headers['X-Org-Code'],'','native personal initialization is not a team-identity write');
  if(path==='/api/web/auth/v1/user_info'){
   if(loginError)return loginError();
   return json({id:'fixture-account',office_identity:'personal'});
  }
  if(path==='/api/web/office/v3/setting_info'){
   if(settingError)return settingError();
   initialized=true;return json(settings);
  }
  assert.fail('Unexpected endpoint: '+path);
 };
 return {calls,fetchImpl};
}

test('Raccoon advertises reconciliation only for the GET-only daily login task',()=>{
 assert.deepEqual(raccoonProvider.dailyReconciliationTasks,['daily-quota']);
 assert.ok(Object.isFrozen(raccoonProvider.dailyReconciliationTasks));
});

test('unextended daily grant runs native session initialization then proves an extended official bill',async()=>{
 const t=transport();const result=await raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.observed,true);assert.equal(result.claimed,false);assert.equal(result.submitted,false);
 assert.equal(result.mutation,false);assert.equal(result.automaticPerformed,true);assert.equal(result.credit,0);
 assert.equal(result.operation,'daily-login-session-refresh');assert.equal(result.source,'native_session_get_chain');
 assert.equal(result.details.receipt.loginExtended,true);
 assert.deepEqual(t.calls.map(c=>c.path),['/api/web/points/v1/balance','/api/web/points/v1/bills','/api/web/auth/v1/user_info','/api/web/office/v3/setting_info','/api/web/points/v1/balance','/api/web/points/v1/bills']);
 assert.ok(t.calls.every(c=>c.body===undefined));
});

test('a manual/earlier extended bill is observed without claiming automatic execution',async()=>{
 const t=transport({before:[extended]});const result=await raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.observed,true);assert.equal(result.automaticPerformed,false);assert.equal(result.submitted,false);assert.equal(result.mutation,false);
 assert.equal(result.operation,undefined);assert.equal(t.calls.length,2);
});

test('status remains read-only observation and does not initialize a daily session',async()=>{
 const t=transport();const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.observed,false);assert.equal(result.claimed,false);assert.equal(result.automaticPerformed,undefined);
 assert.equal(t.calls.length,2);assert.ok(t.calls.every(c=>c.path.startsWith('/api/web/points/')));
});

test('a desktop one-time reward popup never substitutes for a daily bill',async()=>{
 const t=transport({after:[{biz_type:'reward_grant',points:3000,grant_at:plain.grant_at,expire_at:'2027-10-21T00:00:00Z'}],settings:{point_grant_popups:[{source:'desktop_login',points:3000}]}});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_daily_unconfirmed',beforeSubmission:true,retryable:true});
 assert.ok(t.calls.every(c=>c.method==='GET'));
});

test('daily popup/positive aggregate balance does not prove official date-and-expiry settlement',async()=>{
 const t=transport({after:[]});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_daily_unconfirmed',beforeSubmission:true,retryable:true});
 assert.equal(t.calls.length,6);
});

test('a still-unextended bill remains retryable rather than fencing a submitted reward',async()=>{
 const t=transport({after:[plain]});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_daily_unconfirmed',beforeSubmission:true,retryable:true});
 assert.ok(!t.calls.some(c=>c.path.includes('/desktop/')));
});

test('an old-day extended bill does not confirm the current daily session',async()=>{
 const old={...extended,grant_at:'2026-10-20T00:00:00+08:00'};const t=transport({before:[old],after:[old]});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_daily_unconfirmed',beforeSubmission:true,retryable:true});
});

test('authentication failure stops before settings and carries no-submission recovery metadata',async()=>{
 const t=transport({loginError:()=>new Response('',{status:401})});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_session_expired',beforeSubmission:true,retryable:true});
 assert.equal(t.calls.length,3);assert.ok(!t.calls.some(c=>c.path.endsWith('/setting_info')));
});

test('business rejection from initialization never converts an acknowledgement to daily success',async()=>{
 const t=transport({settingError:()=>Response.json({code:500,message:'busy'})});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_business_error',beforeSubmission:true,retryable:true});
 assert.equal(t.calls.length,4);
});

test('a lost initialization response can be retried with GET only',async()=>{
 let failed=false;const t=transport({settingError:()=>{if(!failed){failed=true;throw Error('lost response');}return json({});},after:[]});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{beforeSubmission:true,retryable:true});
 // A second independent daily attempt is still GET-only; a missing bill remains unconfirmed.
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_daily_unconfirmed',beforeSubmission:true,retryable:true});
 assert.equal(t.calls.filter(c=>c.path.endsWith('/setting_info')).length,2);
 assert.ok(t.calls.every(c=>c.method==='GET'));
});

test('post-login settlement reads a new balance instead of reusing injected pre-login data',async()=>{
 const t=transport();const result=await raccoonClaim(secret,'daily-quota',{now,balanceData:{daily_points:0,available_points:0},fetchImpl:t.fetchImpl});
 assert.equal(result.automaticPerformed,true);assert.equal(result.details.dailyRemaining,900);
 assert.equal(t.calls.filter(c=>c.path.endsWith('/balance')).length,1);
});

test('invalid session JSON is retryable with no daily reward submission',async()=>{
 const t=transport({settingError:()=>new Response('<html>busy</html>',{headers:{'content-type':'text/html'}})});
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_invalid_json',beforeSubmission:true,retryable:true});
 assert.ok(t.calls.every(c=>c.method==='GET'));
});

test('an arbitrary popup does not leak into the returned verified daily result',async()=>{
 const t=transport({settings:{point_grant_popups:[{source:'daily',points:300,private_token:'fixture-private'}]}});
 const result=await raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.ok(!JSON.stringify(result).includes('fixture-private'));assert.ok(!JSON.stringify(result).includes('fixture-token'));
});

const oldIncome=Array.from({length:50},(_,i)=>({biz_type:'reward_grant',points:i+1,created_at:'2026-10-20T00:00:00Z'}));
function pagedTransport(page){
 const queries=[],calls=[];
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);calls.push(u.pathname);assert.equal(init.method,'GET');
  if(u.pathname.endsWith('/balance'))return json({daily_points:900,available_points:6900});
  assert.equal(u.pathname,'/api/web/points/v1/bills');
  assert.equal(u.searchParams.get('type'),'income','daily proofs must exclude the high-volume expense feed');
  assert.equal(u.searchParams.get('paging.limit'),'50');queries.push(u.searchParams);
  const next=await page(queries.length-1,u.searchParams);
  return next instanceof Response?next:json(next);
 };
 return {fetchImpl,queries,calls};
}

test('daily bill queries use the official income filter rather than a mixed high-volume expense feed',async()=>{
 const t=pagedTransport(()=>({items:[extended],has_more:false}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,true);assert.equal(result.observed,true);assert.equal(t.queries.length,1);
 assert.equal(t.queries[0].get('paging.offset'),'0');
});

test('opaque cursor pagination finds the current daily row behind a full page',async()=>{
 const cursor='cursor+slash/&=next';
 const t=pagedTransport((i,q)=>{if(i===0)return {items:oldIncome,has_more:true,next_cursor:cursor};assert.equal(q.get('cursor'),cursor);assert.equal(q.get('paging.offset'),null);return {items:[extended],has_more:false};});
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.observed,true);assert.equal(result.details.pagination.pages,2);assert.equal(t.queries.length,2);
});

test('legacy total/offset pagination finds the current daily row after the first fifty records',async()=>{
 const t=pagedTransport((i,q)=>{const offset=Number(q.get('paging.offset'));assert.equal(offset,i*50);return i===0?{items:oldIncome,paging:{total:51,offset}}:{items:[extended],paging:{total:51,offset}};});
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.observed,true);assert.equal(result.details.pagination.items,51);assert.equal(t.queries.length,2);
});

test('missing pagination on a full page is unknown, never a fabricated not-checked-in result',async()=>{
 const t=pagedTransport(()=>({items:oldIncome}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,false);assert.equal(result.active,false);assert.equal(result.claimable,false);assert.equal(result.observed,false);
 assert.equal(result.reason,'raccoon_daily_bills_incomplete');assert.equal(result.details.pagination.reason,'pagination_missing');
});

test('the ten-page read budget stops an unbounded cursor feed and retains unknown state',async()=>{
 const t=pagedTransport(i=>({items:oldIncome,has_more:true,next_cursor:'next-'+i}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,false);assert.equal(result.details.pagination.complete,false);
 assert.equal(result.details.pagination.reason,'page_budget_exhausted');assert.equal(t.queries.length,10);
});

test('a repeated cursor terminates without spinning or treating partial history as complete',async()=>{
 const t=pagedTransport(()=>({items:oldIncome,has_more:true,next_cursor:'same'}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,false);assert.equal(result.details.pagination.reason,'cursor_not_advancing');assert.equal(t.queries.length,2);
});

test('a longer cursor cycle is rejected as incomplete',async()=>{
 const cursors=['one','two','one'];const t=pagedTransport(i=>({items:oldIncome,has_more:true,next_cursor:cursors[i]}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,false);assert.equal(result.details.pagination.reason,'cursor_not_advancing');assert.equal(t.queries.length,3);
});

test('has_more without a usable next cursor remains unknown',async()=>{
 const t=pagedTransport(()=>({items:oldIncome,has_more:true,next_cursor:' '}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,false);assert.equal(result.details.pagination.reason,'cursor_missing');assert.equal(t.queries.length,1);
});

test('an empty nonterminal legacy offset page does not loop',async()=>{
 const t=pagedTransport(()=>({items:[],paging:{total:50,offset:0}}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,false);assert.equal(result.details.pagination.reason,'offset_not_advancing');assert.equal(t.queries.length,1);
});

test('an unexpected server offset cannot skip history and produce a false negative',async()=>{
 const t=pagedTransport(()=>({items:[],paging:{total:100,offset:100}}));
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,false);assert.equal(result.details.pagination.reason,'pagination_invalid');
});

test('a later page HTTP error never returns earlier partial pages as a complete negative',async()=>{
 const t=pagedTransport(i=>i===0?{items:oldIncome,has_more:true,next_cursor:'two'}:new Response('',{status:503}));
 await assert.rejects(raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_upstream_error',status:503});
 assert.equal(t.queries.length,2);
});

test('a later page malformed items array never turns partial history into a receipt',async()=>{
 const t=pagedTransport(i=>i===0?{items:oldIncome,has_more:true,next_cursor:'two'}:{items:{},has_more:false});
 await assert.rejects(raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_bills_schema'});
 assert.equal(t.queries.length,2);
});

test('an exhausted official feed without a daily row is a known not-yet-extended state',async()=>{
 const t=pagedTransport(i=>i===0?{items:oldIncome,has_more:true,next_cursor:'two'}:{items:[],has_more:false});
 const result=await raccoonStatus(secret,'daily-quota',{now,fetchImpl:t.fetchImpl});
 assert.equal(result.known,true);assert.equal(result.observed,false);assert.equal(result.active,true);assert.equal(result.claimable,true);
 assert.equal(result.details.pagination.complete,true);assert.equal(result.details.pagination.pages,2);
});

test('an incomplete pre-action bill read defers the session refresh instead of submitting any action',async()=>{
 const t=pagedTransport(()=>({items:oldIncome}));
 await assert.rejects(raccoonClaim(secret,'daily-quota',{now,fetchImpl:t.fetchImpl}),{code:'raccoon_daily_state_unknown',beforeSubmission:true,retryable:true});
 assert.deepEqual(t.calls,['/api/web/points/v1/balance','/api/web/points/v1/bills']);
});
