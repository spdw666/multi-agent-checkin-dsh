import {readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AppError} from './util.mjs';
import {resolveNetworkOpenCodeService} from './opencode-network.mjs';

const run = promisify(execFile);
const cancelled = () => new AppError('请求取消或超时', 499, 'request_cancelled');

export function openCodeLoopback(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value)) {
    throw new AppError('OpenCode 本机服务地址需为 127.0.0.1 回环地址', 400, 'opencode_endpoint_invalid');
  }
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new AppError('OpenCode 本机服务端口无效', 400, 'opencode_endpoint_invalid');
  return value;
}

async function readState() {
  try { return JSON.parse(await readFile(join(homedir(), '.local', 'state', 'opencode', 'service.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new AppError('OpenCode 本机服务状态文件待修复', 502, 'opencode_service_state_invalid'); }
}

async function probe(origin, credential) {
  const response = await fetch(origin + '/api/info', {
    headers: {authorization: 'Basic ' + Buffer.from('opencode:' + credential.password).toString('base64')},
    signal: AbortSignal.timeout(1500), redirect: 'error',
  });
  if (response.status === 401 || response.status === 403) throw new AppError('OpenCode 本机服务认证待更新', 401, 'opencode_service_auth_rejected');
  if (!response.ok) return false;
  const info = await response.json();
  return typeof info.version === 'string' && Number.isSafeInteger(info.pid) && info.pid > 0;
}

async function start() {
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new AppError('OpenCode 官方 CLI 路径待配置', 503, 'opencode_cli_missing');
  const file = join(base, 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe');
  try { await access(file); } catch { throw new AppError('OpenCode 官方 CLI 待安装', 503, 'opencode_cli_missing'); }
  try {
    // Use the installed vendor's shared-service lifecycle, not a shell command,
    // a replacement inference endpoint or copied desktop credentials on argv.
    await run(file, ['service', 'start'], {windowsHide: true, shell: false, timeout: 20000, maxBuffer: 32768});
  } catch { throw new AppError('OpenCode 官方后台启动失败，请检查官方 service status', 503, 'opencode_service_start_failed'); }
}

function waitForCaller(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Injected adapters are for isolated lifecycle tests. Production uses only the
// official state file, authenticated info endpoint and installed vendor CLI.
export function createOpenCodeService(adapters = {}) {
  const read = adapters.readState ?? readState, ping = adapters.probe ?? probe, launch = adapters.start ?? start;
  let flight;
  async function connected(origin, credential) {
    try { return await ping(origin, credential); }
    catch (error) {
      if (error.code === 'opencode_service_auth_rejected') throw error;
      return false;
    }
  }
  async function discover(service, credential) {
    // Reject an invalid configured endpoint before any credential-bearing probe.
    const configured = openCodeLoopback(service.baseUrl);
    const state = await read();
    const origin = state?.url ? openCodeLoopback(state.url) : configured;
    if (await connected(origin, credential)) return {...service, baseUrl: origin};
    await launch();
    const updated = await read();
    const current = updated?.url ? openCodeLoopback(updated.url) : origin;
    if (await connected(current, credential)) return {...service, baseUrl: current};
    throw new AppError('OpenCode 官方后台已启动，但本机 API 尚未就绪', 503, 'opencode_service_not_ready');
  }
  return async function resolve(service, credential, {signal} = {}) {
    if (signal?.aborted) throw cancelled();
    openCodeLoopback(service.baseUrl);
    if(service.networkProfile)return (adapters.resolveNetwork??resolveNetworkOpenCodeService)(service,credential,{signal});
    // One boot/discovery per process; cancelling one waiter does not terminate
    // the shared official server or another caller's start operation.
    if (!flight) {
      flight = discover(service, credential);
      const pending = flight;
      pending.then(() => { if (flight === pending) flight = null; }, () => { if (flight === pending) flight = null; });
    }
    const found = await waitForCaller(flight, signal);
    return {...service, baseUrl: found.baseUrl};
  };
}

export const resolveOpenCodeService = createOpenCodeService();
