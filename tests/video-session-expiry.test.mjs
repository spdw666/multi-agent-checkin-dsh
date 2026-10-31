import test from 'node:test';
import assert from 'node:assert/strict';

import {VIDEO_SESSION_AUTH_COOKIES,videoSessionCookieHeader,videoSessionAuthToken} from '../src/video-session-vault.mjs';
import {createProvider} from '../src/video-independent-b/providers.mjs';
import {cookieHeaderFor} from '../src/video-independent-a/independent-daily-provider.mjs';
import {AppError} from '../src/util.mjs';

// 2026-10-31 liblib 线上故障：usertoken/webid 的浏览器 expirationDate 已过期（2026-10-31T05:52:14Z），
// 但官方 api2.liblib.art 仍返回 200 —— 本地把 expirationDate 当令牌失效证据，导致「已登录却报 login_required」。
// 契约：认证类 cookie 不按本地期限剔除，真失效只由上游 401 判定。
const PAST = 1793375534;   // 2026-10-31T05:52:14Z，故障当天的过期时刻
const FUTURE = 1830000000; // 远未来

const session = (platform, origin, cookies) => ({
  platform, origin, accessToken: undefined, principal: {id: 'u-1', kind: 'uuid'}, cookies
});

test('video session keeps expired auth cookies in the request while still dropping expired non-auth cookies', () => {
  const s = session('liblib', 'https://www.liblib.art', [
    {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'acw_tc', value: 'waf-old', domain: 'api2.liblib.art', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: PAST},
    {name: 'theme', value: 'dark', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: PAST}
  ]);
  const header = videoSessionCookieHeader(s, 'https://www.liblib.art/');
  assert.match(header, /usertoken=tok-live/);
  assert.match(header, /webid=web-1/);
  assert.doesNotMatch(header, /theme=dark/, '非认证 cookie 过期后仍应剔除');
  assert.equal(videoSessionAuthToken(s, 'usertoken'), 'tok-live');
});

test('protocol-b provider still sends the expired liblib token and webid headers', async () => {
  const seen = [];
  const prov = createProvider(session('liblib', 'https://www.liblib.art', [
    {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'acw_tc', value: 'waf-old', domain: 'api2.liblib.art', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: PAST}
  ]), {
    now: () => Date.now(),
    transport: async req => {
      seen.push(req);
      return {status: 200, body: {code: 0, data: {uuid: 'u-1', id: 12621838}}, setCookies: []};
    }
  });
  const identity = await prov.verifyIdentity({bind: false});
  assert.equal(identity.authenticated, true);
  assert.equal(seen.length >= 1, true);
  assert.equal(seen[0].headers.token, 'tok-live', '过期 usertoken 必须仍然发出');
  assert.equal(seen[0].headers.webid, 'web-1', '过期 webid 必须仍然发出');
  assert.equal(seen[0].headers.token === '' , false);
});

test('an expired auth cookie is only rejected when the upstream says 401', async () => {
  for (const tokenExpiry of [PAST, FUTURE]) {
    const prov = createProvider(session('liblib', 'https://www.liblib.art', [
      {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: tokenExpiry},
      {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: tokenExpiry}
    ]), {
      transport: async () => ({status: 401, body: {code: 1001}, setCookies: []})
    });
    await assert.rejects(() => prov.verifyIdentity({bind: false}), e => e.code === 'login_required');
  }
});

test('protocol-a cookieHeaderFor keeps expired identity cookies and drops other expired ones', () => {
  const cookies = [
    {name: 'sessionid', value: 'sid-live', domain: '.jianying.com', path: '/', expirationDate: PAST},
    {name: 'xmst', value: 'xmst-live', domain: '.jianying.com', path: '/', expirationDate: PAST},
    {name: 'ttwid', value: 'old', domain: '.jianying.com', path: '/', expirationDate: PAST}
  ];
  const header = cookieHeaderFor('https://jimeng.jianying.com/passport/account/info/v2/?account_sdk_source=web', cookies, Date.now());
  assert.match(header, /sessionid=sid-live/);
  assert.match(header, /xmst=xmst-live/);
  assert.doesNotMatch(header, /ttwid=old/);
});

test('the shared auth cookie list covers every platform token name used by the import rules', () => {
  for (const name of ['liblibai_usertoken','usertoken','usertoken_online','webid','_token','sessionid','sessionid_ss','_ai_token']) {
    assert.equal(VIDEO_SESSION_AUTH_COOKIES.includes(name), true, `${name} 必须在认证名单里`);
  }
});
// api2.liblib.art 实测 8 次里 3 次 socket_timeout + 1 次 ECONNRESET（直连与代理同样抖）。
// 契约：传输层失败（未拿到响应）最多 3 次尝试；拿到响应（含 4xx/5xx）一律不重试，避免重复提交。
test('a transport outage is retried up to three attempts before surfacing transport_error', async () => {
  let calls = 0;
  const prov = createProvider(session('liblib', 'https://www.liblib.art', [
    {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST}
  ]), {
    transport: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'});
      return {status: 200, body: {code: 0, data: {uuid: 'u-1', id: 12621838}}, setCookies: []};
    }
  });
  const identity = await prov.verifyIdentity({bind: false});
  assert.equal(identity.authenticated, true);
  assert.equal(calls, 3, '前两次抖动、第三次成功，共 3 次尝试');
});

test('persistent transport failure gives up after three attempts and reports transport_error', async () => {
  let calls = 0;
  const prov = createProvider(session('liblib', 'https://www.liblib.art', [
    {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST}
  ]), {
    transport: async () => { calls++; const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
  });
  await assert.rejects(() => prov.verifyIdentity({bind: false}), e => e.code === 'transport_error');
  assert.equal(calls, 3, '失败也要跑满 3 次尝试，不是 1 次');
});

test('an HTTP response is never retried, even when it is an error', async () => {
  let calls = 0;
  const prov = createProvider(session('liblib', 'https://www.liblib.art', [
    {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST}
  ]), {
    transport: async () => { calls++; return {status: 500, body: {code: 500}, setCookies: []}; }
  });
  await assert.rejects(() => prov.verifyIdentity({bind: false}), e => e.code === 'upstream_http_error');
  assert.equal(calls, 1, '拿到响应就不重试');
});

// 2026-10-31 回归：rotatingTransport 遇到 4xx 时会用 Set-Cookie 判定登出并抛 AppError。
// 那不是传输抖动。若按「不是 ProviderError 就重试」放行，一次明确的登出会被重放三次。
test('a business AppError raised by the transport is surfaced at once instead of retried', async () => {
  let calls = 0;
  const prov = createProvider(session('liblib', 'https://www.liblib.art', [
    {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST}
  ]), {
    transport: async () => { calls++; throw Object.assign(new AppError('登出已确认', 401, 'video_session_expired'), {beforeSubmission: true}); }
  });
  await assert.rejects(() => prov.verifyIdentity({bind: false}), e => e.code === 'video_session_expired');
  assert.equal(calls, 1, '业务错误必须立刻上抛，不重试');
});

// 2026-10-31 回归：重试循环把 req 挪进循环体后，循环外 onSetCookies 分支的 req.url 变成未定义，
// 表现为 liblib/hailuo 全部 502 "req is not defined"。带 Set-Cookie 的响应必须仍然可用。
test('a response carrying Set-Cookie is still routed to the credential updater after retries', async () => {
  const seenUrls = [];
  const prov = createProvider(session('liblib', 'https://www.liblib.art', [
    {name: 'usertoken', value: 'tok-live', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST},
    {name: 'webid', value: 'web-1', domain: 'www.liblib.art', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: PAST}
  ]), {
    transport: async () => ({status: 200, body: {code: 0, data: {uuid: 'u-1', id: 12621838}}, setCookies: ['acw_tc=fresh; Path=/; Domain=api2.liblib.art']}),
    onSetCookies: async (_cred, cookies, url) => { seenUrls.push({cookies, url}); return undefined; }
  });
  const identity = await prov.verifyIdentity({bind: false});
  assert.equal(identity.authenticated, true);
  assert.equal(seenUrls.length, 1, 'onSetCookies 必须被调用一次');
  assert.match(seenUrls[0].url, /^https:\/\/api2\.liblib\.art\//, '必须传来真实的请求 URL');
  assert.deepEqual(seenUrls[0].cookies, ['acw_tc=fresh; Path=/; Domain=api2.liblib.art']);
});
