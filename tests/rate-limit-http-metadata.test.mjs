import test from 'node:test';
import assert from 'node:assert/strict';
import {rateLimitMetadata} from '../src/rate-limit-metadata.mjs';
import {AppError} from '../src/util.mjs';
const {startServer}=await import(process.env.RATE_LIMIT_SERVER_MODULE??'../src/server.mjs');
const {UsageAttempt}=await import(process.env.RATE_LIMIT_USAGE_MODULE??'../src/usage.mjs');
const clean={upstreamCode:6002,rateLimitKind:'transient',rateLimitRetryable:true,retryAfterSeconds:17,retryAfterSource:'official_header',gatewayManagedRetry:true};
function failure(extra={}){return Object.assign(new AppError('SAMPLE official rate limit, request unchanged',429,'same_model_rate_limited'),clean,extra);}
async function query(error,{partial=false,stream=false}={}){
  const config={value:{server:{host:'127.0.0.1',port:0,requestTimeoutMs:5000},routes:[]}};
  const router={async*chat(){if(partial)yield {model:'SAMPLE',choices:[{index:0,delta:{content:'SAMPLE partial'},finish_reason:null}]};throw error;}};
  const runtime=await startServer({config,router,keys:{apiKey:'SAMPLE_KEY',adminKey:'SAMPLE_ADMIN'}},{port:0});
  try{const r=await fetch(runtime.baseUrl+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer SAMPLE_KEY','Content-Type':'application/json'},body:JSON.stringify({model:'SAMPLE',messages:[{role:'user',content:'SAMPLE unchanged input'}],stream})});return {status:r.status,retry:r.headers.get('retry-after'),text:await r.text()};}finally{await runtime.close();}
}
test('rate metadata keeps only bounded official classification fields',()=>{
  assert.deepEqual(rateLimitMetadata({...clean,rawBody:'SAMPLE_SECRET',url:'https://SAMPLE.invalid/TOKEN',headers:{Authorization:'SAMPLE_SECRET'},upstreamMessage:'SAMPLE_SECRET'}),clean);
});
test('unknown, long-window and entitlement classifications never gain retry permission',()=>{
  for(const kind of ['unknown','long_window','usage_limit'])assert.equal(rateLimitMetadata({...clean,rateLimitKind:kind}).rateLimitRetryable,false);
  for(const upstreamCode of [undefined,6004,14019,'6002'])assert.equal(rateLimitMetadata({...clean,upstreamCode}).rateLimitRetryable,false);
});
test('rate metadata rejects non-numeric, unbounded and forged fields',()=>{
  for(const value of [-1,NaN,Infinity,86401,'17'])assert.equal('retryAfterSeconds' in rateLimitMetadata({...clean,retryAfterSeconds:value}),false);
  assert.deepEqual(rateLimitMetadata({upstreamCode:'6002',rateLimitKind:'SAMPLE_SECRET',retryAfterSource:'SAMPLE_SECRET',retryAfterSeconds:'SAMPLE_SECRET',gatewayManagedRetry:'true'}),{});
});
test('HTTP429 retains root classification, official retry header and gateway retry ownership',async()=>{
  const r=await query(failure());assert.equal(r.status,429);assert.equal(r.retry,'17');
  const error=JSON.parse(r.text).error;for(const [k,v] of Object.entries(clean))assert.equal(error[k],v,k);assert.equal(error.code,'same_model_rate_limited');
});
test('HTTP429 preserves official zero rather than substituting thirty seconds',async()=>{
  const r=await query(failure({retryAfterSeconds:0}));assert.equal(r.retry,'0');assert.equal(JSON.parse(r.text).error.retryAfterSeconds,0);
});
test('HTTP429 local probe cooldown is not advertised as an official reset',async()=>{
  const r=await query(failure({upstreamCode:6004,rateLimitKind:'long_window',rateLimitRetryable:false,retryAfterSeconds:30,retryAfterSource:'local_default'}));
  const e=JSON.parse(r.text).error;assert.equal(r.status,429);assert.equal(e.upstreamCode,6004);assert.equal(e.retryAfterSource,'local_default');assert.equal(e.rateLimitRetryable,false);
});
test('HTTP400 and authentication failures never acquire Retry-After metadata',async()=>{
  for(const status of [400,401,403]){const r=await query(Object.assign(failure(),{status}));const e=JSON.parse(r.text).error;assert.equal(r.status,status);assert.equal(r.retry,null);assert.equal('retryAfterSeconds'in e,false);assert.equal('retryAfterSource'in e,false);}
});
test('HTTP pre-header and post-header errors retain the same sanitized metadata',async()=>{
  const r=await query(failure({rawBody:'SAMPLE_SECRET',upstreamMessage:'SAMPLE_SECRET'}),{partial:true,stream:true});assert.equal(r.status,200);
  const line=r.text.split('\n').find(l=>l.startsWith('data: ')&&l.includes('same_model_rate_limited'));const e=JSON.parse(line.slice(6)).error;
  for(const [k,v] of Object.entries(clean))assert.equal(e[k],v,k);assert.ok(!r.text.includes('SAMPLE_SECRET'));
});
test('usage ledger retains official code and retry source but no provider payload',()=>{
  let saved;const ledger={beginUsage(){return 1},finishUsage(_id,row){saved=row}},config={upstreams:[{id:'SAMPLE_UPSTREAM',kind:'workbuddyai',accountId:'SAMPLE_ACCOUNT'}],accounts:[]};
  const usage=new UsageAttempt(ledger,config,{model:'SAMPLE_MODEL',messages:[{role:'user',content:'SAMPLE'}]},{upstreamId:'SAMPLE_UPSTREAM',model:'SAMPLE_MODEL'});
  usage.finish('failed',failure({rawBody:'SAMPLE_SECRET',upstreamMessage:'SAMPLE_SECRET',response:{token:'SAMPLE_SECRET'}}));
  assert.deepEqual(saved.rateLimit,clean);assert.ok(!JSON.stringify(saved).includes('SAMPLE_SECRET'));assert.equal(saved.error.code,'same_model_rate_limited');
});
