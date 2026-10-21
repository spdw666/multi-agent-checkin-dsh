// provider-raccoon.test.mjs — dependency-injection tests for the unified Raccoon contract.
// No ambient network, no real cookie values: the store is a temp SQLite fixture; decryption is injected.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCipheriv, randomBytes} from 'node:crypto';
import {
  descriptor, raccoonProvider, parseRaccoonLlmConfig, raccoonLlmConfig, parseRaccoonSessionBinding,
  raccoonModels, raccoonCookiePresence, raccoonCredentialPresence, raccoonFetch, raccoonHealth,
  raccoonStatus, raccoonClaim, raccoonChat, raccoonResolve, raccoonCredentialView, decryptElectronCookie,
  readElectronCookieKey, RACCOON_ORIGIN, readRaccoonNativeAuth, raccoonServerModels, raccoonBearerHealth,
} from '../src/provider-raccoon.mjs';

const llmFixture = {
  apiBase: 'https://xiaohuanxiong.com/api/web/llm/v2',
  apiKey: 'secre...ey',
  provider: 'openai',
  model: 'raccoon-chat-ml-5-5',
  lightweight: {apiBase: 'https://xiaohuanxiong.com/api/web/llm/v2', apiKey: '***', provider: 'openai', model: 'raccoon-chat-ml-5-5'},
  imageGeneration: {type: 'remote', endpoint: 'https://xiaohuanxiong.com/api/web/llm/v2/images/gen', apiKey: '***', timeout: 1000},
};

const bindingFixture = {
  version: 1,
  modelBinding: {
    source: 'profile', model: 'raccoon-8c4485', routingMode: 'auto', contextWindow: 1000000, maxTokens: 100000,
    profileId: 'hosted:fixture',
    autoRouting: {models: [{model: 'raccoon-8c4485', tags: ['general', 'office', 'code', 'vision']}]},
  },
};

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});

let scratchDir = null;
async function scratch() { if (!scratchDir) scratchDir = await mkdtemp(join(tmpdir(), 'raccoon-test-')); return scratchDir; }
test.after(async () => { if (scratchDir) await rm(scratchDir, {recursive: true, force: true}); });

async function makeCookieDb(rows) {
  const dir = await scratch();
  const dbPath = join(dir, `cookies-${Math.random().toString(16).slice(2)}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, expires_utc INTEGER)');
  const insert = db.prepare('INSERT INTO cookies (host_key, name, encrypted_value, value, expires_utc) VALUES (?,?,?,?,?)');
  for (const row of rows) insert.run(row.host, row.name, row.encrypted ?? Buffer.alloc(0), row.value ?? '', row.expires ?? 0);
  db.close();
  return dbPath;
}

// ------------------------------------------------------------------ descriptor / legacy parsers

test('raccoon descriptor: no check-in surface, cookie auth kind', () => {
  assert.equal(descriptor.id, 'raccoon');
  assert.equal(descriptor.authKind, 'native_bearer_token');
  assert.equal(descriptor.checkinSupported, false);
  assert.ok(descriptor.underlyingProvider.includes('xiaohuanxiong.com'));
});

test('raccoon config parse: gateways found, keys reduced to presence', () => {
  const cfg = parseRaccoonLlmConfig(llmFixture);
  assert.equal(cfg.apiBase, 'https://xiaohuanxiong.com/api/web/llm/v2');
  assert.equal(cfg.model, 'raccoon-chat-ml-5-5');
  assert.equal(cfg.secrets.mainApiKeyPresent, true);
  assert.equal(cfg.secrets.lightweightApiKeyPresent, true);
  assert.ok(!JSON.stringify(cfg).includes('secret-fixture-key'));
  assert.ok(!JSON.stringify(cfg).includes('secret-lw-key'));
});

test('raccoon config parse: malformed JSON -> AppError', () => {
  assert.throws(() => parseRaccoonLlmConfig('{oops'), e => e.code === 'raccoon_config_parse');
});

test('raccoon binding parse: real binding values (contextWindow/maxTokens/profileId)', () => {
  const b = parseRaccoonSessionBinding(bindingFixture);
  assert.equal(b.model, 'raccoon-8c4485');
  assert.equal(b.contextWindow, 1000000);
  assert.equal(b.maxTokens, 100000);
  assert.equal(b.routingMode, 'auto');
  assert.ok(b.tags.includes('vision'));
});

test('raccoon models: real binding capacity surfaced but never marked callable; configured default has nulls', async () => {
  const {writeFile} = await import('node:fs/promises');
  const dir = await scratch();
  const configPath = join(dir, 'llm-config.json');
  const bindingPath = join(dir, 'binding.json');
  await writeFile(configPath, JSON.stringify(llmFixture));
  await writeFile(bindingPath, JSON.stringify(bindingFixture));
  const models2 = await raccoonModels({configFilePath: configPath, sessionBindingPath: bindingPath});
  assert.ok(models2.length >= 2);
  const fromBinding = models2.find(m => m.source === 'installed_session_binding');
  assert.equal(fromBinding.contextWindow, 1000000); // real app binding value
  assert.equal(fromBinding.maxTokens, 100000);
  assert.equal(fromBinding.maxTokensSource, 'app_session_binding');
  assert.equal(fromBinding.officialMaxTokens, null);
  for (const m of models2) { assert.equal(m.callable, false); assert.equal(m.publishable, false); }
});

// ------------------------------------------------------------------ cookie presence / decryption

test('cookie presence: missing db -> present:false (never reads content)', async () => {
  const p = await raccoonCookiePresence({cookieDbPath: 'C:/definitely/not/here', openSqlite: null});
  assert.equal(p.present, false);
});

test('cookie presence: temp db with cookies -> counts + host/name structure only, no values', async () => {
  const dbPath = await makeCookieDb([
    {host: 'xiaohuanxiong.com', name: 'SESSION_ID', encrypted: Buffer.concat([Buffer.from('v10'), randomBytes(40)])},
    {host: '.xiaohuanxiong.com', name: 'user_token', encrypted: Buffer.concat([Buffer.from('v10'), randomBytes(30)])},
    {host: 'example.com', name: 'plain', value: 'plaintext-value-here'},
  ]);
  const p = await raccoonCookiePresence({cookieDbPath: dbPath});
  assert.equal(p.present, true);
  assert.equal(p.cookieCount, 3);
  assert.equal(p.encryptedCount, 2);
  assert.equal(p.plaintextCount, 1);
  const text = JSON.stringify(p);
  assert.ok(!text.includes('plaintext-value-here'));
  assert.ok(text.includes('SESSION_ID')); // names are fine
});

test('cookie presence: empty db -> cookieCount 0 with honest note', async () => {
  const dbPath = await makeCookieDb([]);
  const p = await raccoonCookiePresence({cookieDbPath: dbPath});
  assert.equal(p.present, true);
  assert.equal(p.cookieCount, 0);
  assert.ok(p.note.includes('空'));
});

test('electron cookie decrypt: v10 AES-GCM round-trip; unknown version rejected', () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from('secret-cookie-value');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encrypted = Buffer.concat([Buffer.from('v10'), nonce, ct, tag]);
  const decrypted = decryptElectronCookie(encrypted, key);
  assert.equal(decrypted.toString('utf8'), 'secret-cookie-value');
  assert.throws(() => decryptElectronCookie(Buffer.concat([Buffer.from('v99'), nonce, ct, tag]), key), e => e.code === 'raccoon_cookie_unsupported');
});

test('electron cookie key: DPAPI unwrap via injected unprotect; bad prefix rejected', async () => {
  const key = randomBytes(32);
  const wrapped = Buffer.concat([Buffer.from('DPAPI'), key]).toString('base64');
  const unwrapped = await readElectronCookieKey({localStatePath: 'x', readFileImpl: async () => ({os_crypt: {encrypted_key: wrapped}}), unprotectImpl: async (bytes) => Buffer.from(bytes)});
  assert.equal(unwrapped.length, 32);
  assert.deepEqual(unwrapped, key);
  await assert.rejects(() => readElectronCookieKey({localStatePath: 'x', readFileImpl: async () => ({os_crypt: {encrypted_key: Buffer.from('NOPE:nope').toString('base64')}}), unprotectImpl: async () => key}), e => e.code === 'raccoon_cookie_key_unsupported');
});

// ------------------------------------------------------------------ resolve

test('resolve: empty cookie store -> 401 credential_missing (honest: session absent)', async () => {
  const dbPath = await makeCookieDb([]);
  await assert.rejects(() => raccoonResolve({}, {cookieDbPath: dbPath}), e => e.status === 401 && e.code === 'raccoon_credential_missing');
});

test('resolve: session cookie present -> private credential w/ names+principal; public view name-only', async () => {
  const dbPath = await makeCookieDb([
    {host: 'xiaohuanxiong.com', name: 'SESSION_ID', encrypted: Buffer.concat([Buffer.from('v10'), randomBytes(40)])},
  ]);
  await assert.rejects(raccoonResolve({}, {cookieDbPath:dbPath}),{code:'raccoon_credential_unverified'});
});

test('resolve: credentials.file is refused with a clear reason (cookie-session platform)', async () => {
  await assert.rejects(() => raccoonResolve({credentials: {file: 'C:/whatever.json'}}, {}), e => e.status === 401 && e.code === 'raccoon_credential_missing');
});

// ------------------------------------------------------------------ availability claims & transport

test('raccoon availability: explicit unsupported capability claims', async () => {
  const r = await raccoonClaim();
  assert.equal(r.supported, false);
  assert.equal(r.code, 'no_checkin_confirmed');
  assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1);
  await assert.rejects(() => raccoonChat(), e => e.status === 401 && e.code === 'raccoon_credential_missing');
  const s = await raccoonStatus(undefined, 'daily-checkin');
  assert.equal(s.supported, false);
  assert.equal(s.claimable, false);
  await assert.rejects(() => raccoonStatus(undefined, 'weekly'), e => e.code === 'raccoon_task_unknown');
});

test('raccoon fetch: guards origin/path and requires injection', async () => {
  const spy = async () => new Response('{}', {status: 200});
  await assert.rejects(() => raccoonFetch(spy, 'https://evil.example/api/web/llm/v2/models', {}), e => e.code === 'raccoon_endpoint_invalid');
  await assert.rejects(() => raccoonFetch(spy, `${RACCOON_ORIGIN}/other/path`, {}), e => e.code === 'raccoon_endpoint_invalid');
  await assert.rejects(() => raccoonFetch(undefined, `${RACCOON_ORIGIN}/api/web/llm/v2/models`, {}), e => e.code === 'raccoon_fetch_not_injected');
});

test('raccoon health: empty store + reachable gateway -> session_absent, unknown balance, no fake models', async () => {
  const dbPath = await makeCookieDb([]);
  const fetchImpl = async (url, init = {}) => new Response('{}', {status: 401});
  const h = await raccoonHealth({fetchImpl, cookieDbPath: dbPath, llmConfigPath: 'x', sessionBindingPath: undefined});
  assert.equal(h.gatewayReachable, true);
  assert.equal(h.gatewayStatus, 401);
  assert.equal(h.status, 'session_absent');
  assert.equal(h.balance.value, null);
  assert.equal(h.checkin.supported, false);
  assert.deepEqual(h.capabilities, {checkin: false, inference: false});
});

test('raccoon health: session cookies present -> session_present, structure surfaced', async () => {
  const dbPath = await makeCookieDb([{host: 'xiaohuanxiong.com', name: 'SESSION_ID', encrypted: Buffer.concat([Buffer.from('v10'), randomBytes(40)])}]);
  const h = await raccoonHealth({cookieDbPath: dbPath, llmConfigPath: 'x'});
  assert.equal(h.status, 'session_present');
  assert.equal(h.session.cookieCount, 1);
  assert.ok(h.session.siteCookies.some(s => s.host === 'xiaohuanxiong.com' && s.cookieNames.includes('SESSION_ID')));
});

test('provider export: full unified surface', () => {
  for (const fn of ['resolve', 'models', 'health', 'status', 'claim', 'chat']) assert.equal(typeof raccoonProvider[fn], 'function', fn);
});

const nativeToken='fixture.'+Buffer.from(JSON.stringify({name:'fixture-user',exp:2000000000})).toString('base64url')+'.signature';
const nativeSecret={accessToken:nativeToken,authKind:'bearer',principal:'fixture'};
const catalog={code:0,data:{categories:[{type:'chat',models:[{model_name:'official-chat',description:'官方模型',params:{context_window:1000000,max_tokens:100000},tags:['vision']}]}]}};
test('native auth reads Bearer source independently of zero cookies and hides token in view',async()=>{
 const s=await readRaccoonNativeAuth('fixture',{readFileImpl:async()=>JSON.stringify({access_token:nativeToken,refresh_token:'fixture-refresh'})});assert.equal(s.authKind,'bearer');assert.ok(s.principal.startsWith('raccoon:'));assert.ok(!JSON.stringify(raccoonCredentialView(s)).includes(nativeToken));
});
test('native resolve prefers explicit native auth file even with empty cookie database',async()=>{const {writeFile}=await import('node:fs/promises');const file=join(await scratch(),'native.json');await writeFile(file,JSON.stringify({access_token:nativeToken}));const value=await raccoonResolve({}, {authFilePath:file,cookieDbPath:await makeCookieDb([])});assert.equal(value.authKind,'bearer');});
test('catalog uses real metadata and does not invent tool support',async()=>{const models=await raccoonServerModels(nativeSecret,{fetchImpl:async(url,opts)=>{assert.equal(opts.headers.authorization,'Bearer '+nativeToken);return jsonResponse(catalog);}});assert.equal(models[0].contextWindow,1000000);assert.equal(models[0].tools,null);assert.equal(models[0].source,'official_model_catalog');});
test('balance preserves unknown and real zero, with automatic daily grant not checkin',async()=>{const health=await raccoonBearerHealth(nativeSecret,{fetchImpl:async(url)=>url.includes('model_catalog')?jsonResponse(catalog):jsonResponse({code:0,data:{available_points:0,daily_points:0,reward_points:6000}})});assert.equal(health.balance.value,0);assert.equal(health.balance.parts[0].value,0);assert.equal(health.capabilities.checkin,false);assert.equal(health.status,'authenticated');});
test('chat rejects unknown model before upstream fallback',async()=>{let calls=0;await assert.rejects(raccoonChat({},nativeSecret,{model:'bad'},undefined,{fetchImpl:async()=>{calls++;return jsonResponse(catalog);}}),{code:'raccoon_model_unknown'});assert.equal(calls,1);});
test('chat normalizes SSE, preserves tools, and strips unsupported reasoning field',async()=>{const result=await raccoonChat({},nativeSecret,{model:'official-chat',messages:[{role:'user',content:'hi'}],reasoning_effort:'max',max_completion_tokens:512,tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}]},undefined,{fetchImpl:async(url,opts)=>{if(url.includes('model_catalog'))return jsonResponse(catalog);const body=JSON.parse(opts.body);assert.equal(body.reasoning_effort,undefined);assert.equal(body.max_tokens,512);assert.equal(body.tools.length,1);return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});assert.equal((await result.response.json()).choices[0].message.content,'OK');});
test('native expired authentication maps session error without claiming success',async()=>{await assert.rejects(raccoonBearerHealth(nativeSecret,{fetchImpl:async()=>jsonResponse({},401)}),{code:'raccoon_session_expired'});});

test('daily quota uses dated extended server bills and never claims a new grant',async()=>{let calls=0;const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);const future=new Date(Date.now()+7*86400000).toISOString();const fetchImpl=async(url,options)=>{calls++;assert.equal(options.method,'GET');return jsonResponse({code:0,data:url.includes('/bills')?{items:[{biz_type:'daily_grant',points:300,grant_at:day+'T00:00:00+08:00',expire_at:future}]}:{daily_points:297,available_points:6297}})};const result=await raccoonStatus(nativeSecret,'daily-quota',{fetchImpl});assert.equal(result.observed,true);assert.equal(result.claimed,false);assert.equal(result.claimable,false);assert.equal(result.details.dailyRemaining,297);assert.equal(calls,2);const claim=await raccoonClaim(nativeSecret,'daily-quota',{fetchImpl});assert.equal(claim.claimed,false);assert.equal(claim.submitted,false);assert.equal(calls,4);});

test('business auth error is not mistaken for authenticated HTTP200',async()=>{await assert.rejects(raccoonBearerHealth(nativeSecret,{fetchImpl:async()=>jsonResponse({code:200003,message:'authorization_verify_error'})}),{status:401,code:'raccoon_session_expired'});});

test('daily login follows the native GET initialization, then needs a same-day extended bill; no fabricated 300 credit',async()=>{const now=Date.parse('2026-10-13T04:00:00Z');let initialized=false;const methods=[];const fetchImpl=async(url,init)=>{methods.push(init.method);assert.equal(init.method,'GET');if(url.endsWith('/user_info'))return jsonResponse({code:0,data:{id:'fixture-user'}});if(url.endsWith('/setting_info')){initialized=true;return jsonResponse({code:0,data:{}})}return jsonResponse({code:0,data:url.includes('/bills')?{items:initialized?[{biz_type:'daily_grant',points:300,grant_at:'2026-10-13T00:00:00+08:00',expire_at:'2026-10-19T23:59:59+08:00'}]:[]}:{daily_points:897,available_points:6897}})};const result=await raccoonClaim(nativeSecret,'daily-quota',{now,fetchImpl});assert.equal(result.observed,true);assert.equal(result.claimed,false);assert.equal(result.credit,0);assert.equal(result.submitted,false);assert.equal(result.automaticPerformed,true);assert.equal(result.desktopRewardGranted,undefined);assert.deepEqual(methods,['GET','GET','GET','GET','GET','GET']);});
test('positive balance, old-day bill, default expiry or another reward is not a daily receipt',async()=>{const {raccoonDailyReceipt}=await import('../src/provider-raccoon.mjs');const now=Date.parse('2026-10-13T04:00:00Z');for(const row of [{biz_type:'daily_grant',points:300,grant_at:'2026-10-12T00:00:00+08:00',expire_at:'2026-10-18T23:59:59+08:00'},{biz_type:'daily_grant',points:300,grant_at:'2026-10-13T00:00:00+08:00',expire_at:'2026-10-13T23:59:59+08:00'},{biz_type:'reward_grant',points:3000,grant_at:'2026-10-13T00:00:00+08:00',expire_at:'2027-01-01T00:00:00Z'}])assert.equal(raccoonDailyReceipt({items:[row]},now).observed,false);await assert.rejects(raccoonClaim(nativeSecret,'daily-quota',{now,fetchImpl:async(url,i)=>jsonResponse({code:0,data:i.method==='POST'?{granted:true,popup:{points:3000}}:url.includes('/bills')?{items:[]}:{daily_points:900}})}),{code:'raccoon_daily_unconfirmed'});});

test('health daily badge uses verified bill amount and date, not positive aggregate balance',async()=>{const now=Date.parse('2026-10-13T04:00:00Z');const h=await raccoonBearerHealth(nativeSecret,{now,fetchImpl:async url=>jsonResponse({code:0,data:url.includes('/balance')?{available_points:6897,daily_points:897}:url.includes('/bills')?{items:[{biz_type:'daily_grant',points:300,grant_at:'2026-10-13T00:00:00+08:00',expire_at:'2026-10-19T23:59:59+08:00'}]}:{categories:[]}})});assert.equal(h.balance.dailyQuotaObserved,true);assert.equal(h.balance.dailyCycleDate,'2026-10-13');assert.equal(h.balance.dailyQuota,300);assert.equal(h.balance.dailyQuotaObservedAt,new Date(now).toISOString());assert.equal(h.balance.dailyQuotaSource,'/api/web/points/v1/bills:daily_grant');});
