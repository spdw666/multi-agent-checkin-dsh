// Domestic WorkBuddy endpoints answer in single-digit milliseconds from this
// host, but the runtime is started with NODE_USE_ENV_PROXY=1 + HTTPS_PROXY, so
// every global fetch goes through the user's outbound proxy first. A stalled
// CONNECT there surfaces as undici's 10s connect timeout and the request dies
// before a single byte reaches the upstream (2026-11-13 aigw-eed7a7b7: 504
// provider_timeout / UND_ERR_CONNECT_TIMEOUT at 10.37s, nothing received).
// Keep the domestic hosts on a direct socket; the global ones stay proxied.
// This must run before the first fetch, because the env proxy agent is built
// lazily from the environment on first use.
const DIRECT_HOSTS = ['copilot.tencent.com', 'codebuddy.cn', '.codebuddy.cn', 'workbuddy.cn', '.workbuddy.cn'];
const firstValue = value => value === undefined ? '' : String(value);

if (firstValue(process.env.NODE_USE_ENV_PROXY) !== '') {
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = firstValue(process.env[name]).split(',').map(entry => entry.trim()).filter(Boolean);
    for (const host of DIRECT_HOSTS) if (!entries.includes(host)) entries.push(host);
    process.env[name] = entries.join(',');
  }
}
