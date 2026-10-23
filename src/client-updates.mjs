import {access, open, readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// 每天检查一次被反代的桌面客户端是否有新版本，只读：不改任何客户端、不下载安装包。
// 每个目标的版本来源都写在清单里；没有公开来源的目标诚实显示“无来源”，
// 不按猜测或网页噪声伪造版本号。

const LOCAL = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');

export const CLIENT_UPDATE_STATE_KEY = 'client-updates';

// version 类型：
//   json      读指定 JSON 文件的字段（field 支持 a.b）
//   asar      读 resources/app.asar 内 package.json 的 version
//   asarUnpacked 读 resources/app.asar.unpacked/package.json
//   exe       读 PE 文件版本（ProductVersion）
// latest 类型：
//   genie     https://<base>/v2/update?platform=<platform>&version=<apiVersion>
//   feed      electron-updater 的 latest.yml（解析 version 行）
//   json      任意 JSON（field 取版本）
//   github    GitHub releases/latest（tag 去前缀）
//   none      没有可靠的公开来源
export const DEFAULT_TARGETS = [
  {
    id: 'workbuddy-cn', name: 'WorkBuddy 国内版', platform: 'workbuddy',
    install: 'D:\\workbuddy',
    version: {type: 'json', file: 'resources/install-manifest.json', field: 'appVersion'},
    latest: {type: 'genie', base: 'https://www.workbuddy.cn', platform: 'workbuddy-win32-x64-user'},
    note: '签到与积分任务主客户端'
  },
  {
    id: 'workbuddy-ai', name: 'WorkBuddy AI 国际版', platform: 'workbuddyai',
    install: 'D:\\WorkBuddyAI',
    version: {type: 'json', file: 'resources/install-manifest.json', field: 'appVersion'},
    latest: {type: 'genie', base: 'https://www.codebuddy.ai', platform: 'workbuddy-win32-x64-user'},
    note: '国际版渠道，与国内版独立发版'
  },
  {
    id: 'codebuddy-cn', name: 'CodeBuddy 国内版', platform: 'codebuddy',
    install: 'D:\\CodeBuddy CN',
    version: {type: 'json', file: 'resources/app/product.json', field: 'version', apiField: 'genieVersion'},
    latest: {type: 'genie', base: 'https://www.workbuddy.cn', platform: 'ide-win32-x64-user'},
    note: '同一 genie 内核；API 用 genieVersion 比较'
  },
  {
    id: 'codebuddy-global', name: 'CodeBuddy 国际版', platform: 'codebuddy',
    install: 'D:\\CodeBuddy',
    version: {type: 'json', file: 'resources/app/product.json', field: 'version', apiField: 'genieVersion'},
    latest: {type: 'genie', base: 'https://www.codebuddy.ai', platform: 'ide-win32-x64-user'},
    note: '官方客户端内更新检查已禁用，这里直接查官方接口'
  },
  {
    id: 'qoder', name: 'Qoder 国际版', platform: 'qoder',
    install: 'D:\\Qoder',
    version: {type: 'qoderVersions'},
    latest: {type: 'feed', url: 'https://download.qoder.com.cn/qoder-app/releases'},
    note: ''
  },
  {
    id: 'qoder-cn', name: 'Qoder 国内版', platform: 'qoder',
    install: 'D:\\Qoder CN',
    version: {type: 'qoderVersions'},
    latest: {type: 'feed', url: 'https://static.qoder.com.cn/qoder-app/releases'},
    note: ''
  },
  {
    id: 'loomy', name: 'Loomy', platform: 'loomy',
    install: 'D:\\Loomy',
    version: {type: 'asarUnpacked'},
    latest: {type: 'feed', url: 'https://static-res.xfinfr.com/loomy/win'},
    note: ''
  },
  {
    id: 'raccoon', name: '商汤小浣熊', platform: 'raccoon',
    install: 'D:\\raccoon-ai',
    version: {type: 'asar'},
    latest: {type: 'feed', url: 'https://sta-volc.xiaohuanxiong.com/office-agent/win'},
    note: ''
  },
  {
    id: 'minimax', name: 'MiniMax Code', platform: 'minimax',
    install: 'D:\\MiniMax Code',
    version: {type: 'asar'},
    latest: {type: 'feed', url: 'https://filecdn.minimax.chat/public/minimax-agent-prod/release'},
    note: '官方 prod feed；客户端内置检查地址 minimax-agent/release 已失效（404），软件内可能误报“最新”'
  },
  {
    id: 'lobsterai', name: 'LobsterAI', platform: 'lobster',
    install: 'D:\\LobsterAI',
    version: {type: 'asar'},
    latest: {type: 'github', repo: 'netease-youdao/lobsterai', prefix: 'v'},
    note: '官方发布在 GitHub Releases'
  },
  {
    id: 'opencode', name: 'OpenCode 桌面版', platform: 'opencode',
    install: join(LOCAL, 'Programs', '@opencodedesktop'),
    version: {type: 'asar'},
    latest: {type: 'json', url: 'https://opencode.ai/update/api/latest/desktop/opencode/', field: 'version'},
    note: ''
  },
  {
    id: 'cline', name: 'Cline 桌面版', platform: 'cline',
    install: 'D:\\Cline',
    version: {type: 'exe', file: 'cline-app.exe'},
    latest: {type: 'github', repo: 'cline/cline', prefix: 'desktop-v'},
    note: ''
  },
  {
    id: 'trae', name: 'Trae CN', platform: 'trae',
    install: 'D:\\Trae CN',
    version: {type: 'json', file: 'resources/app/product.json', field: 'appVersion', apiField: 'tronBuildVersion'},
    latest: {
      type: 'trae', url: 'https://api.trae.com.cn/icube/api/v1/package/check_update',
      mid: '561ed8eddac7a1a19ff38d5f2e5068e4c5bbe879de78d1b794f03080f02cf1a9',
      did: '810790401142921', branch: 'release_desktop_yoma_win32_cn',
      versionCode: '20250325', pid: '7409949320595642651', iid: '1787183286984867'
    },
    note: '字节 ICUBE 更新接口；按 tron 构建号比较'
  },
  {
    id: 'zcode', name: 'ZCode 国内版', platform: 'zcode',
    install: 'D:\\zcode',
    version: {type: 'asar'},
    latest: {type: 'html', url: 'https://zcode.z.ai/cn/changelog', regex: 'font-mono[^>]*> *([0-9]+[.][0-9]+[.][0-9]+)'},
    note: '官方更新日志页'
  },
  {
    id: 'qwenwork', name: '千问办公', platform: 'qwenwork',
    install: 'D:\\QwenWorkCN',
    version: {type: 'json', file: 'updater.cfg', field: 'currentVersion'},
    comparison: 'numeric-build-suffix',
    latest: {type: 'html', url: 'https://docs.qwenwork.cn/release-notes/desktop', regex: 'update-description.{0,4}千问办公 +([0-9]+[.][0-9]+[.][0-9]+(?:-[0-9]+)?)'},
    note: '官方客户端更新日志页'
  },
  {
    id: 'codearts', name: 'CodeArts Agent', platform: 'codearts',
    install: 'D:\\CodeArts Agent',
    version: {type: 'json', file: 'resources/app/product.json', field: 'version'},
    latest: {type: 'json', url: 'https://ide.cn-north-4.myhuaweicloud.com/v1/release-info/latest?sub_product_name=ai&os_type=windows&is_server=false', field: 'result.version'},
    note: '华为官方 release-info 接口'
  },
  {
    id: 'antigravity', name: 'Antigravity', platform: 'antigravity',
    install: join(LOCAL, 'Programs', 'antigravity'),
    version: {type: 'asar'},
    latest: {type: 'json', url: 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases', field: '0.version'},
    note: '官方更新服务版本列表'
  },
  {
    id: 'dsh', name: 'DeepSeek Harness（下游）', platform: 'dsh',
    install: join(LOCAL, 'Programs', 'DeepSeek Harness'),
    version: {type: 'json', file: 'resources/app/package.json', field: 'version'},
    latest: {type: 'feed', url: 'https://download.deepseek.com/dsh-desk/feeds/win-x64', file: 'nightly.yml'},
    note: '调用本网关的下游客户端，顺带监测'
  }
];

// 每个客户端的启动入口与官网（表格里双击/右键直接打开，或创建桌面快捷方式）。
export const CLIENT_LAUNCH = {
  'workbuddy-cn': {executable: 'WorkBuddy.exe', homepage: 'https://www.workbuddy.cn'},
  'workbuddy-ai': {executable: 'WorkBuddyAI.exe', homepage: 'https://www.workbuddy.ai'},
  'codebuddy-cn': {executable: 'CodeBuddy CN.exe', homepage: 'https://copilot.tencent.com'},
  'codebuddy-global': {executable: 'CodeBuddy.exe', homepage: 'https://www.codebuddy.ai'},
  qoder: {executable: 'Qoder.exe', homepage: 'https://qoder.com'},
  'qoder-cn': {executable: 'Qoder CN.exe', homepage: 'https://qoder.com.cn'},
  loomy: {executable: 'Loomy.exe', homepage: 'https://loomy.xfinfr.com'},
  raccoon: {executable: '商汤小浣熊.exe', homepage: 'https://xiaohuanxiong.com'},
  minimax: {executable: 'MiniMax Code.exe', homepage: 'https://agent.minimax.cn'},
  lobsterai: {executable: 'LobsterAI.exe', homepage: 'https://lobsterai.youdao.com'},
  opencode: {executable: 'OpenCode.exe', homepage: 'https://opencode.ai'},
  cline: {executable: 'cline-app.exe', homepage: 'https://cline.bot'},
  trae: {executable: 'Trae CN.exe', homepage: 'https://www.trae.com.cn'},
  zcode: {executable: 'ZCode.exe', homepage: 'https://zcode.z.ai'},
  qwenwork: {executable: 'Launcher.exe', homepage: 'https://qwenwork.cn'},
  codearts: {executable: 'codearts-agent.exe', homepage: 'https://www.huaweicloud.com/product/codeartside.html'},
  antigravity: {executable: 'Antigravity.exe', homepage: 'https://antigravity.google'},
  dsh: {executable: 'DeepSeek Harness.exe', homepage: 'https://www.deepseek.com'}
};

export const CLIENT_UPDATE_DEFAULTS = {enabled: true, intervalHours: 24, timeoutMs: 15000};

export function normalizeClientUpdates(raw) {
  const base = {...CLIENT_UPDATE_DEFAULTS};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {...base, targets: {}};
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled;
  if (Number.isFinite(raw.intervalHours) && raw.intervalHours >= 1) base.intervalHours = raw.intervalHours;
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs >= 1000) base.timeoutMs = raw.timeoutMs;
  base.targets = raw.targets && typeof raw.targets === 'object' && !Array.isArray(raw.targets) ? raw.targets : {};
  return base;
}

export function versionParts(value) {
  const matches = String(value ?? '').match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

// 数字渠道 build 的严格前缀仍视为同一版（5.8.3 / 5.8.3.41334564），
// 但 SemVer 的预发布标识单独比较，不能把 rc 当成同版本的正式发布。
export function compareVersions(installed, latest) {
  const parse = (value) => {
    const match = String(value ?? '').match(/(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/);
    return match ? {core: match[1].split('.').map(Number), pre: match[2]?.split('.') ?? []} : null;
  };
  const left = parse(installed), right = parse(latest);
  if (!left || !right) return 'unknown';
  const a = left.core, b = right.core;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return b[i] > a[i] ? 'newer' : 'older';
  }
  if (!left.pre.length && !right.pre.length) return 'same';
  if (!left.pre.length) return 'older';
  if (!right.pre.length) return 'newer';
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined) return 'newer';
    if (y === undefined) return 'older';
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(y) > BigInt(x) ? 'newer' : 'older';
    if (xn !== yn) return xn ? 'newer' : 'older';
    return y > x ? 'newer' : 'older';
  }
  return 'same';
}

export function parseLatestYml(text) {
  const m = String(text ?? '').match(/^version:\s*['"]?([^\s'"#]+)/m);
  return m ? m[1] : '';
}

export function fieldValue(obj, path) {
  return String(path ?? '').split('.').filter(Boolean)
    .reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

export async function asarReadJson(asarPath, entry = 'package.json') {
  const fh = await open(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (!Number.isFinite(headerSize) || !Number.isFinite(jsonLen) || headerSize <= 0 || jsonLen <= 0) {
      throw new Error('not an asar archive');
    }
    const jbuf = Buffer.alloc(jsonLen);
    await fh.read(jbuf, 0, jsonLen, 16);
    const header = JSON.parse(jbuf.toString('utf8'));
    const info = header.files?.[entry];
    if (!info || typeof info.size !== 'number' || info.unpacked) {
      throw new Error('entry not packed: ' + entry);
    }
    const buf = Buffer.alloc(info.size);
    await fh.read(buf, 0, info.size, 8 + headerSize + Number(info.offset));
    return JSON.parse(buf.toString('utf8'));
  } finally {
    await fh.close();
  }
}

function powershellVersion(exePath) {
  return new Promise((resolve) => {
    const script = `$v=(Get-Item -LiteralPath '${String(exePath).replace(/'/g, "''")}').VersionInfo; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "$($v.ProductVersion)|$($v.FileVersion)"`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('error', () => resolve(''));
    child.on('close', () => {
      const [product, file] = String(out).trim().split('|');
      resolve(String(product || file || '').trim());
    });
    setTimeout(() => { try { child.kill(); } catch {} }, 10000).unref();
  });
}

export async function readInstalledVersion(target) {
  const spec = target.version;
  const root = target.install;
  if (!spec) return {installed: '', apiVersion: '', path: root};
  try {
    if (spec.type === 'json') {
      const data = JSON.parse(await readFile(join(root, spec.file), 'utf8'));
      const installed = String(fieldValue(data, spec.field ?? 'version') ?? '').trim();
      const apiVersion = String(fieldValue(data, spec.apiField ?? spec.field ?? 'version') ?? installed).trim();
      return {installed, apiVersion: apiVersion || installed, path: root};
    }
    if (spec.type === 'asar') {
      const data = await asarReadJson(join(root, 'resources/app.asar'));
      const installed = String(data.version ?? '').trim();
      return {installed, apiVersion: installed, path: root};
    }
    if (spec.type === 'qoderVersions') {
      // Qoder 更新器把新版本整体下载到 .qoder-versions/<version>，主 exe 仍是旧壳；
      // <version>.qoder-update-ready.json 存在表示已下载就绪，重启客户端即生效。
      const dir = join(root, '.qoder-versions');
      let versions = [];
      try {
        const entries = await readdir(dir, {withFileTypes: true});
        versions = entries.filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name)).map(entry => entry.name);
      } catch { versions = []; }
      versions.sort((a, b) => {
        const order = compareVersions(a, b);
        return order === 'newer' ? 1 : order === 'same' ? 0 : -1;
      });
      for (const version of versions) {
        let manifestVersion = '';
        try {
          const manifest = JSON.parse(await readFile(join(dir, version, 'resources/build-manifest.json'), 'utf8'));
          manifestVersion = String(manifest.productVersion ?? '').trim();
        } catch {}
        let pendingRestart = false;
        try { await access(join(dir, version + '.qoder-update-ready.json')); pendingRestart = true; } catch {}
        if (manifestVersion || pendingRestart) {
          const installed = manifestVersion || version;
          return {installed, apiVersion: installed, path: join(dir, version), pendingRestart};
        }
      }
      const data = await asarReadJson(join(root, 'resources/app.asar'));
      const installed = String(data.version ?? '').trim();
      return {installed, apiVersion: installed, path: root};
    }
    if (spec.type === 'asarUnpacked') {
      const data = JSON.parse(await readFile(join(root, 'resources/app.asar.unpacked/package.json'), 'utf8'));
      const installed = String(data.version ?? '').trim();
      return {installed, apiVersion: installed, path: root};
    }
    if (spec.type === 'exe') {
      const installed = await powershellVersion(join(root, spec.file));
      return {installed, apiVersion: installed, path: root};
    }
  } catch (error) {
    return {installed: '', apiVersion: '', path: root, error: error.message};
  }
  return {installed: '', apiVersion: '', path: root};
}

// Some injected transports (and a response body that stalls) need an explicit
// abort race as well as the fetch signal. Remove listeners after every await.
async function abortable(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, {once: true});
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {signal.throwIfAborted(); return operation();}), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function timedSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function httpText(url, {timeoutMs = 15000, headers = {}, fetchImpl = fetch, signal} = {}) {
  const requestSignal = timedSignal(timeoutMs, signal);
  const response = await abortable(() => fetchImpl(url, {
    redirect: 'follow',
    headers: {'user-agent': 'ai-credit-gateway-client-updates/1.0', ...headers},
    signal: requestSignal
  }), requestSignal);
  const text = await abortable(() => response.text(), requestSignal);
  return {status: response.status, text};
}

// GitHub 未认证接口每小时只有 60 次（本机多个工具共用出口 IP，很容易打满）。
// 只在本机内存里借用 gh CLI 已登录的 token，不写配置、不落日志。
let githubTokenCache;
async function githubToken() {
  if (githubTokenCache !== undefined) return githubTokenCache;
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (fromEnv) return (githubTokenCache = fromEnv);
  const candidates = [
    process.env.GH_PATH,
    join(LOCAL, 'Programs', 'GitHubCLI', 'gh.exe'),
    'gh.exe'
  ].filter(Boolean);
  for (const executable of candidates) {
    const token = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(executable, ['auth', 'token'], {windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
      } catch { resolve(''); return; }
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
      child.on('error', () => resolve(''));
      child.on('close', (code) => resolve(code === 0 ? String(out).trim() : ''));
      setTimeout(() => { try { child.kill(); } catch {} resolve(''); }, 5000).unref();
    });
    if (token) return (githubTokenCache = token);
  }
  return (githubTokenCache = '');
}

// ---- 远程 PE 版本读取（千问办公这类只给 "latest" 固定安装包、没有版本清单的客户端）----
function rvaToOffset(sections, rva) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.sizeOfRawData);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.pointerToRawData + (rva - section.virtualAddress);
    }
  }
  return -1;
}

async function readRange(url, start, end, fetchImpl, timeoutMs, signal) {
  const requestSignal = timedSignal(timeoutMs, signal);
  const response = await abortable(() => fetchImpl(url, {
    headers: {range: `bytes=${start}-${end}`, 'user-agent': 'ai-credit-gateway-client-updates/1.0'},
    signal: requestSignal
  }), requestSignal);
  if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await abortable(() => response.arrayBuffer(), requestSignal));
}

export function peVersionFromBuffer(head, rsrc) {
  if (head.toString('ascii', 0, 2) !== 'MZ') throw new Error('not a PE file');
  const peOff = head.readUInt32LE(0x3c);
  if (head.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('bad PE signature');
  const coff = peOff + 4;
  const sections = head.readUInt16LE(coff + 2);
  const optSize = head.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = head.readUInt16LE(opt);
  const dd = opt + (magic === 0x20b ? 112 : 96);
  const rsrcRva = head.readUInt32LE(dd + 16);
  if (!rsrcRva) throw new Error('no resource directory');
  const table = opt + optSize;
  const map = [];
  for (let i = 0; i < sections; i++) {
    const at = table + i * 40;
    map.push({
      virtualSize: head.readUInt32LE(at + 8),
      virtualAddress: head.readUInt32LE(at + 12),
      sizeOfRawData: head.readUInt32LE(at + 16),
      pointerToRawData: head.readUInt32LE(at + 20)
    });
  }
  const base = rvaToOffset(map, rsrcRva);
  if (base < 0) throw new Error('resource section not mapped');
  const dirCount = (offset) => rsrc.readUInt16LE(offset + 12) + rsrc.readUInt16LE(offset + 14);
  const dirEntries = (offset) => offset + 16;
  const find = (dirOffset, id) => {
    const count = dirCount(dirOffset);
    const entries = dirEntries(dirOffset);
    for (let i = 0; i < count; i++) {
      const at = entries + i * 8;
      const name = rsrc.readUInt32LE(at);
      const child = rsrc.readUInt32LE(at + 4);
      if (name === id) return child;
    }
    return null;
  };
  const first = (dirOffset) => {
    const count = dirCount(dirOffset);
    if (!count) return null;
    return rsrc.readUInt32LE(dirEntries(dirOffset) + 4);
  };
  let node = find(0, 16); // RT_VERSION
  if (node === null) throw new Error('no RT_VERSION');
  node = first(node & 0x7fffffff);
  if (node === null) throw new Error('no version name entry');
  node = first(node & 0x7fffffff);
  if (node === null) throw new Error('no version language entry');
  const dataEntry = node & 0x7fffffff;
  const dataRva = rsrc.readUInt32LE(dataEntry);
  const dataSize = rsrc.readUInt32LE(dataEntry + 4);
  const at = dataRva - rsrcRva;
  if (at < 0 || at + dataSize > rsrc.length) throw new Error('version data outside resource section');
  for (let i = at; i + 16 <= at + dataSize; i += 4) {
    if (rsrc.readUInt32LE(i) !== 0xfeef04bd) continue;
    const ms = rsrc.readUInt32LE(i + 8);
    const ls = rsrc.readUInt32LE(i + 12);
    return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  }
  throw new Error('VS_FIXEDFILEINFO not found');
}

export async function remoteExeVersion(url, {fetchImpl = fetch, timeoutMs = 30000, signal} = {}) {
  const head = await readRange(url, 0, 8191, fetchImpl, timeoutMs, signal);
  const peOff = head.readUInt32LE(0x3c);
  const coff = peOff + 4;
  const sections = head.readUInt16LE(coff + 2);
  const optSize = head.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = head.readUInt16LE(opt);
  const dd = opt + (magic === 0x20b ? 112 : 96);
  const rsrcRva = head.readUInt32LE(dd + 16);
  const rsrcSize = head.readUInt32LE(dd + 20);
  if (!rsrcRva || !rsrcSize) throw new Error('no resource directory');
  const table = opt + optSize;
  const map = [];
  for (let i = 0; i < sections; i++) {
    const at = table + i * 40;
    map.push({
      virtualSize: head.readUInt32LE(at + 8),
      virtualAddress: head.readUInt32LE(at + 12),
      sizeOfRawData: head.readUInt32LE(at + 16),
      pointerToRawData: head.readUInt32LE(at + 20)
    });
  }
  const base = rvaToOffset(map, rsrcRva);
  if (base < 0) throw new Error('resource section not mapped');
  const rsrc = await readRange(url, base, base + rsrcSize - 1, fetchImpl, timeoutMs, signal);
  return peVersionFromBuffer(head, rsrc);
}

// ---- 日志解析（Antigravity 每次启动都会把 "latest version: X" 写进 main.log）----
async function readLatestFromLog(file, regex, flags = 'gm') {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  const re = new RegExp(regex, flags);
  let last = '';
  for (const match of text.matchAll(re)) last = match[1] ?? match[0];
  return String(last).trim();
}

async function readLatestFromHtml(url, regex, {fetchImpl, timeoutMs, signal}) {
  const {status, text} = await httpText(url, {timeoutMs, fetchImpl, signal});
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const re = new RegExp(regex, 'm');
  const match = re.exec(text);
  if (!match) throw new Error('version pattern not found');
  return String(match[1] ?? match[0]).trim();
}

export async function fetchLatestVersion(target, {installed, apiVersion, timeoutMs = 15000, fetchImpl = fetch, signal} = {}) {
  signal?.throwIfAborted();
  const spec = target.latest;
  if (!spec || spec.type === 'none') return {latest: '', source: 'none'};
  if (spec.type === 'genie') {
    if (!spec.base || !spec.platform) throw new Error('genie update source requires base and platform');
    const url = `${spec.base}/v2/update?platform=${encodeURIComponent(spec.platform)}&version=${encodeURIComponent(apiVersion || installed || '0.0.0')}`;
    const {status, text} = await httpText(url, {timeoutMs, headers: {accept: 'application/json'}, fetchImpl, signal});
    // 204 = 官方认为当前已是最新
    if (status === 204) return {latest: apiVersion || installed, source: 'genie_update_api', url};
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text);
    if (!data || typeof data.version !== 'string') throw new Error('missing version');
    return {latest: data.version.trim(), source: 'genie_update_api', url, downloadUrl: data.url ?? ''};
  }
  if (spec.type === 'feed') {
    const file = spec.file ?? 'latest.yml';
    const url = `${spec.url.replace(/\/$/, '')}/${file}`;
    const {status, text} = await httpText(url, {timeoutMs, fetchImpl, signal});
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const latest = parseLatestYml(text);
    if (!latest) throw new Error('latest.yml has no version');
    return {latest, source: 'electron_updater_feed', url};
  }
  if (spec.type === 'json') {
    const {status, text} = await httpText(spec.url, {timeoutMs, headers: {accept: 'application/json'}, fetchImpl, signal});
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text);
    const latest = String(fieldValue(data, spec.field ?? 'version') ?? '').trim();
    if (!latest) throw new Error('missing version field');
    return {latest, source: 'official_json_api', url: spec.url};
  }
  if (spec.type === 'text') {
    const {status, text} = await httpText(spec.url, {timeoutMs, fetchImpl, signal});
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const match = text.match(new RegExp(spec.regex));
    const latest = match?.[spec.group ?? 1]?.trim();
    if (!latest) throw new Error('version pattern not found');
    return {latest, source: 'official_page', url: spec.url};
  }
  if (spec.type === 'github') {
    if (!spec.url && !spec.repo) throw new Error('github update source requires URL or repo');
    const url = spec.url || `https://api.github.com/repos/${spec.repo}/releases/latest`;
    const headers = {accept: 'application/vnd.github+json'};
    // Never forward the local GitHub credential to a custom update endpoint.
    const token = new URL(url).origin === 'https://api.github.com' ? await abortable(() => githubToken(), signal) : '';
    if (token) headers.authorization = `Bearer ${token}`;
    const {status, text} = await httpText(url, {timeoutMs, headers, fetchImpl, signal});
    if (status !== 200) throw new Error(`HTTP ${status}${text ? ': ' + text.replace(/\s+/g, ' ').slice(0, 120) : ''}`);
    const data = JSON.parse(text);
    let tag = String(data.tag_name ?? data.name ?? '').trim();
    const prefix = spec.prefix ?? '';
    if (prefix && tag.toLowerCase().startsWith(prefix.toLowerCase())) tag = tag.slice(prefix.length);
    if (!tag) throw new Error('empty release tag');
    return {latest: tag, source: 'github_releases', url: data.html_url ?? url};
  }
  if (spec.type === 'trae') {
    const params = new URLSearchParams({
      mid: spec.mid, did: spec.did, uid: `stable_${spec.mid}`,
      userRegion: 'CN', packageType: 'stable_cn', productCode: 'TRAE',
      platform: 'Win', branch: spec.branch, arch: 'x64', tenant: 'marscode',
      appVersion: installed, buildVersion: apiVersion, traeVersionCode: spec.versionCode,
      pid: spec.pid, iid: spec.iid
    });
    const url = `${spec.url}?${params.toString()}`;
    const {status, text} = await httpText(url, {timeoutMs, headers: {accept: 'application/json'}, fetchImpl, signal});
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text);
    if (data.err_code !== undefined && data.err_code !== 0) throw new Error(data.err_message ?? `trae code ${data.err_code}`);
    const manifest = data.data?.manifest?.win32;
    if (!manifest?.version) {
      // 已是最新时官方只回 needUpdate:false，不返回 manifest；此时把本机 build 当作最新。
      if (data.data?.needUpdate === false) return {latest: apiVersion || installed, source: 'trae_update_api', url};
      throw new Error('trae manifest missing version');
    }
    return {
      latest: String(manifest.version), source: 'trae_update_api', url,
      downloadUrl: manifest.urls?.[0]?.x64 ?? ''
    };
  }
  if (spec.type === 'codearts') {
    const url = `${spec.url}?sub_product_name=${encodeURIComponent(spec.subProduct)}&os_type=${encodeURIComponent(spec.osType)}&is_server=false`;
    const {status, text} = await httpText(url, {timeoutMs, headers: {accept: 'application/json'}, fetchImpl, signal});
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text);
    const latest = String(data.result?.version ?? '').trim();
    if (!latest) throw new Error('codearts release-info returned no version');
    return {latest, source: 'codearts_release_api', url, downloadUrl: data.result?.url ?? ''};
  }
  if (spec.type === 'html' || spec.type === 'text') {
    const latest = await readLatestFromHtml(spec.url, spec.regex, {fetchImpl, timeoutMs, signal});
    return {latest, source: 'official_changelog', url: spec.url};
  }
  if (spec.type === 'log') {
    const file = String(spec.file).replace('%APPDATA%', ROAMING).replace('%LOCALAPPDATA%', LOCAL);
    const latest = await readLatestFromLog(file, spec.regex);
    if (!latest) throw new Error('log has no update result yet');
    return {latest, source: 'client_update_log', url: file};
  }
  if (spec.type === 'remoteExe') {
    const latest = await remoteExeVersion(spec.url, {fetchImpl, timeoutMs: Math.max(timeoutMs, 30000), signal});
    return {latest, source: 'official_installer_pe', url: spec.url, downloadUrl: spec.url};
  }
  throw new Error('unknown latest source');
}

function statusFor(compare) {
  if (compare === 'newer') return 'update_available';
  if (compare === 'same') return 'current';
  if (compare === 'older') return 'ahead';
  return 'unknown';
}

// Source identity is available even when DNS/TLS/HTTP or parsing fails. Do not
// include the Trae installation identifiers in a newly constructed failure URL.
function updateSource(target, installed = '', apiVersion = '') {
  const spec = target.latest ?? {};
  const sources = {genie: 'genie_update_api', feed: 'electron_updater_feed', json: 'official_json_api',
    text: 'official_page', html: 'official_changelog', github: 'github_releases', trae: 'trae_update_api',
    codearts: 'codearts_release_api', remoteExe: 'official_installer_pe', log: 'client_update_log'};
  let sourceUrl = spec.url ?? '';
  if (spec.type === 'feed' && sourceUrl) sourceUrl = `${sourceUrl.replace(/\/$/, '')}/${spec.file ?? 'latest.yml'}`;
  if (spec.type === 'genie' && spec.base) sourceUrl = `${spec.base}/v2/update?platform=${encodeURIComponent(spec.platform ?? '')}&version=${encodeURIComponent(apiVersion || installed || '0.0.0')}`;
  if (spec.type === 'github' && !sourceUrl && spec.repo) sourceUrl = `https://api.github.com/repos/${spec.repo}/releases/latest`;
  if (spec.type === 'log') sourceUrl = String(spec.file ?? '').replace('%APPDATA%', ROAMING).replace('%LOCALAPPDATA%', LOCAL);
  return {source: sources[spec.type] ?? 'none', sourceUrl};
}

export function classifyClientUpdateError(error, {cancelled = false} = {}) {
  const details = String(error?.message ?? error ?? '未知更新检查错误').slice(0, 2048);
  const networkCode = String(error?.cause?.code ?? error?.code ?? '');
  const http = /\bHTTP\s+(\d{3})\b/i.exec(details);
  let errorCode = 'update_check_failed', errorLabel = '检查失败', retryable = false;
  if (cancelled) { errorCode = 'update_cancelled'; errorLabel = '检查已取消'; }
  else if (error?.name === 'TimeoutError' || /timeout|timed out/i.test(details) || /TIMEOUT|ETIMEDOUT/.test(networkCode)) {
    errorCode = 'update_timeout'; errorLabel = '检查超时'; retryable = true;
  } else if (http) {
    const status = Number(http[1]);
    errorCode = `update_http_${status}`; errorLabel = `更新源 HTTP ${status}`;
    retryable = [408, 425, 429, 500, 502, 503, 504].includes(status);
  } else if (/CERT|TLS|SSL/.test(networkCode) || /certificate|TLS|SSL/i.test(details)) {
    errorCode = 'update_tls_error'; errorLabel = '证书或 TLS 检查失败';
  } else if (error?.name === 'SyntaxError' || /version|pattern|manifest|release tag|JSON|update result/i.test(details)) {
    errorCode = 'update_format_changed'; errorLabel = '更新源格式变化';
  } else if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET/.test(networkCode) || /fetch failed|network|socket|connection reset/i.test(details)) {
    errorCode = 'update_network_error'; errorLabel = '网络连接失败'; retryable = true;
  } else if (error?.name === 'AbortError') { errorCode = 'update_cancelled'; errorLabel = '检查已取消'; }
  return {errorCode, errorLabel, errorDetails: details, retryable};
}

function retrySleep(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function withPreviousSuccess(result, previous) {
  const successful = ['update_available', 'current', 'ahead', 'unknown'].includes(result.status) && !!result.latest;
  const priorSuccessful = ['update_available', 'current', 'ahead', 'unknown'].includes(previous?.status) && !!previous?.latest;
  result.lastSuccessAt = successful ? result.checkedAt : previous?.lastSuccessAt ?? (priorSuccessful ? previous.checkedAt : null);
  result.lastSuccessLatest = successful ? result.latest : previous?.lastSuccessLatest ?? (priorSuccessful ? previous.latest : '');
  result.lastSuccessSourceUrl = successful ? result.sourceUrl : previous?.lastSuccessSourceUrl ?? (priorSuccessful ? previous.sourceUrl : '');
  result.stale = !successful && !!result.lastSuccessLatest;
  if (result.stale) result.latest = result.lastSuccessLatest;
  const previousFailures = Number(previous?.consecutiveFailures);
  result.consecutiveFailures = result.status === 'error' ?
    (Number.isFinite(previousFailures) ? Math.max(0, Math.floor(previousFailures)) : 0) + 1 : 0;
  return result;
}

function targetNextCheckAt(row, config) {
  if (config.enabled === false || row.status === 'cancelled') return null;
  if (row.status === 'error' && row.retryDueAt && Number.isFinite(Date.parse(row.retryDueAt))) return row.retryDueAt;
  const checkedAt = Date.parse(row.checkedAt);
  // Upgrade old persisted errors too; otherwise a pre-upgrade timeout would
  // still remain red for a full day before the new scheduling logic took effect.
  const delay = row.status === 'error' ? failureRetryMinutes(row) * 60000 : config.intervalHours * 3600000;
  return Number.isFinite(checkedAt) ? new Date(checkedAt + delay).toISOString() : null;
}

function failureRetryMinutes(row) {
  const retryable = row.retryable ?? classifyClientUpdateError(row.error).retryable;
  const storedFailures = Number(row.consecutiveFailures);
  const failures = Number.isFinite(storedFailures) ? Math.max(1, Math.floor(storedFailures)) : 1;
  return retryable ? [5, 15, 60][Math.min(failures - 1, 2)] : 60;
}

function finishTarget(result, previous, base, started, now) {
  result.checkedAt = new Date(now()).toISOString();
  result.durationMs = Math.max(0, now() - started);
  result.phase = 'done';
  withPreviousSuccess(result, previous);
  result.retryDueAt = result.status === 'error' ? new Date(Date.parse(result.checkedAt) + failureRetryMinutes(result) * 60000).toISOString() : null;
  result.nextCheckAt = targetNextCheckAt(result, {intervalHours: 24, ...base});
  return result;
}

export async function checkTarget(target, base, {timeoutMs = 15000, fetchImpl = fetch, signal,
  previous, maxRetries = 2, retryBaseMs = 250, random = Math.random, sleep = retrySleep,
  now = Date.now, onProgress} = {}) {
  const started = now();
  const result = {id: target.id, name: target.name, platform: target.platform, note: target.note ?? '',
    ...updateSource(target), attemptCount: 0, retryCount: 0, phase: 'checking',
    errorCode: '', errorLabel: '', errorDetails: '', retryable: false};
  const detected = await abortable(() => readInstalledVersion(target), signal);
  result.installPath = detected.path;
  result.installed = detected.installed || '';
  Object.assign(result, updateSource(target, detected.installed, detected.apiVersion));
  if (detected.pendingRestart) {
    result.pendingRestart = true;
    result.note = [target.note, 'v' + detected.installed + ' 已下载就绪，重启客户端后生效'].filter(Boolean).join('；');
  }
  result.executable = target.executable ? join(detected.path, target.executable) : '';
  result.homepage = target.homepage ?? '';
  if (detected.apiVersion && detected.apiVersion !== detected.installed) result.apiVersion = detected.apiVersion;
  if (!detected.installed) {
    result.status = 'not_detected';
    result.error = detected.error ?? '未在预期路径读取到版本';
    Object.assign(result, {errorCode: 'update_not_detected', errorLabel: '未检测到客户端', errorDetails: result.error});
    return finishTarget(result, previous, base, started, now);
  }
  if (base.enabled === false) {
    result.status = 'disabled';
    return finishTarget(result, previous, base, started, now);
  }
  try {
    let latestResult;
    const retries = Math.min(2, Math.max(0, Math.floor(Number(maxRetries) || 0)));
    for (;;) {
      signal?.throwIfAborted();
      result.phase = 'checking';
      result.attemptCount++;
      result.retryCount = result.attemptCount - 1;
      onProgress?.({...result});
      try {
        latestResult = await fetchLatestVersion(target, {
          installed: detected.installed, apiVersion: detected.apiVersion, timeoutMs, fetchImpl, signal
        });
        break;
      } catch (error) {
        const typed = classifyClientUpdateError(error, {cancelled: signal?.aborted});
        if (!typed.retryable || result.retryCount >= retries || signal?.aborted) throw error;
        result.phase = 'retry_wait';
        const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
        const delay = Math.max(0, Math.min(2000, retryBaseMs * 2 ** result.retryCount)) * (1 + jitter * 0.25);
        onProgress?.({...result, ...typed, retryDelayMs: Math.ceil(delay)});
        await abortable(() => sleep(Math.ceil(delay), signal), signal);
      }
    }
    result.latest = latestResult.latest;
    result.source = latestResult.source;
    result.sourceUrl = latestResult.url ?? '';
    if (latestResult.downloadUrl) result.downloadUrl = latestResult.downloadUrl;
    if (!latestResult.latest || latestResult.source === 'none') {
      result.status = 'no_source';
      result.error = '';
    } else {
      // QwenWork updater.cfg appends a numeric channel build (1.3.1-26101419),
      // while its public changelog publishes 1.3.1. This is a target policy,
      // not a global SemVer exception: rc.2 and true numeric prereleases retain
      // normal precedence for every target without this explicit policy.
      const comparable = (value) => target.comparison === 'numeric-build-suffix'
        ? String(value).replace(/^(\d+\.\d+\.\d+)-\d+$/, '$1') : value;
      result.compare = compareVersions(comparable(detected.apiVersion || detected.installed), comparable(latestResult.latest));
      result.status = statusFor(result.compare);
      if (result.status === 'ahead') {
        // 官方源版本低于本机：常见于官方撤回/灰度发布或 CDN 源未同步，不是本机算错版本。
        result.note = [target.note, '官方更新源当前返回的版本低于本机，可能是官方撤回、灰度发布或源未同步'].filter(Boolean).join('；');
      }
    }
  } catch (error) {
    result.status = signal?.aborted ? 'cancelled' : 'error';
    result.error = error.message;
    Object.assign(result, classifyClientUpdateError(error, {cancelled: signal?.aborted}));
  }
  return finishTarget(result, previous, base, started, now);
}

export function mergeTargets(overrides = {}) {
  const targets = DEFAULT_TARGETS.map((target) => {
    const override = overrides[target.id] ?? {};
    let latest = target.latest;
    if (['latestUrl', 'latestType', 'latestField', 'latestFile'].some(key => override[key] !== undefined)) {
      const supported = ['feed', 'json', 'github', 'genie'];
      const type = override.latestType ?? (supported.includes(target.latest?.type) ? target.latest.type : 'feed');
      if (!supported.includes(type)) throw new Error('unsupported client update source type');
      latest = {...(target.latest?.type === type ? target.latest : {}), type};
      if (override.latestUrl !== undefined) {
        if (!/^https?:\/\//.test(override.latestUrl)) throw new Error('client update source URL must use http(s)');
        if (type === 'genie') latest.base = override.latestUrl.replace(/\/$/, '');
        else latest.url = override.latestUrl;
      }
      if (override.latestField !== undefined) {
        if (type !== 'json' || typeof override.latestField !== 'string' || !override.latestField.trim()) throw new Error('latestField requires a JSON update source and a nonempty field path');
        latest.field = override.latestField;
      }
      if (override.latestFile !== undefined) {
        if (type !== 'feed' || typeof override.latestFile !== 'string' || !override.latestFile.trim()) throw new Error('latestFile requires a feed update source and a nonempty filename');
        latest.file = override.latestFile;
      }
      if (type === 'genie' && (!latest.base || !latest.platform)) throw new Error('genie update source requires base and platform');
      if (type === 'github' && !latest.url && !latest.repo) throw new Error('github update source requires URL or repo');
      if (['feed', 'json'].includes(type) && !latest.url) throw new Error(type + ' update source requires URL');
    }
    return {
      ...target,
      ...(CLIENT_LAUNCH[target.id] ?? {}),
      enabled: override.enabled !== false,
      latest
    };
  });
  return targets;
}

export function summarize(targets) {
  const summary = {total: targets.length, update_available: 0, current: 0, ahead: 0, no_source: 0, not_detected: 0, error: 0, cancelled: 0, disabled: 0, unknown: 0};
  for (const target of targets) {
    if (summary[target.status] === undefined) summary.unknown += 1;
    else summary[target.status] += 1;
  }
  summary.ready = summary.total - summary.disabled;
  return summary;
}

// A persisted "running" record is not a lock: it can survive a process restart.
// The real in-flight promise is service-scoped, including force/manual requests.
const activeChecks = new WeakMap();

export function cancelClientUpdateCheck(service, reason = new DOMException('Client update check stopped', 'AbortError')) {
  const active = activeChecks.get(service);
  if (!active) return false;
  active.controller.abort(reason);
  return active.promise;
}

export function runClientUpdateCheck(service, {force = false, failedOnly = false, dueOnly = false, targetIds,
  targets: explicitTargets, fetchImpl = fetch, signal, now = Date.now,
  maxRetries = 2, retryBaseMs = 250, random = Math.random, sleep = retrySleep} = {}) {
  const active = activeChecks.get(service);
  if (active) return active.promise;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, {once: true});
  const record = {controller, promise: null};
  activeChecks.set(service, record);
  record.promise = Promise.resolve().then(() => performClientUpdateCheck(service, {targets: explicitTargets,
    failedOnly, dueOnly: dueOnly && !force, targetIds, fetchImpl, signal: controller.signal, now,
    maxRetries, retryBaseMs, random, sleep})).finally(() => {
    signal?.removeEventListener('abort', onAbort);
    if (activeChecks.get(service) === record) activeChecks.delete(service);
  });
  return record.promise;
}

async function performClientUpdateCheck(service, {targets: explicitTargets, failedOnly, dueOnly, targetIds,
  fetchImpl, signal, now, maxRetries, retryBaseMs, random, sleep}) {
  const config = normalizeClientUpdates(service.config.value.clientUpdates);
  const previous = service.ledger.get(CLIENT_UPDATE_STATE_KEY) ?? {};
  const startedAt = new Date(now()).toISOString();
  const allTargets = explicitTargets?.length ? explicitTargets : mergeTargets(config.targets);
  if (targetIds !== undefined && (!Array.isArray(targetIds) || targetIds.some(id => typeof id !== 'string' || !id.trim()))) {
    throw new Error('targetIds must be an array of client IDs');
  }
  const requested = targetIds === undefined ? null : new Set(targetIds);
  if (requested && [...requested].some(id => !allTargets.some(target => target.id === id))) throw new Error('unknown client update target ID');
  const priorRows = new Map((previous.targets ?? []).map(row => [row.id, row]));
  const targets = allTargets.filter(target => (!requested || requested.has(target.id)) &&
    (!failedOnly || ['error', 'cancelled'].includes(priorRows.get(target.id)?.status)) &&
    (!dueOnly || targetIsDue(priorRows.get(target.id), config, now())));
  // Partial checks preserve untargeted rows and their original timestamps. A
  // failed target must not reset the successful targets' independent daily clock.
  const partial = failedOnly || requested !== null || dueOnly;
  const order = partial ? [...allTargets.map(target => target.id), ...(previous.targets ?? []).map(row => row.id)] : allTargets.map(target => target.id);
  const rows = new Map(partial ? priorRows : []);
  for (const target of targets) rows.set(target.id, {...priorRows.get(target.id), id: target.id,
    name: target.name, platform: target.platform, ...updateSource(target), phase: 'queued'});
  const selectedIds = new Set(targets.map(target => target.id));
  const completed = new Set();
  const orderedRows = () => [...new Set(order)].map(id => rows.get(id)).filter(Boolean).map(row => ({...row}));
  const persist = (status = 'running') => {
    const resultRows = orderedRows();
    const selectedRows = resultRows.filter(row => selectedIds.has(row.id));
    const checkedAt = new Date(now()).toISOString();
    const report = {...previous, status, enabled: config.enabled !== false, intervalHours: config.intervalHours,
      startedAt, checkedAt: status === 'running' ? previous.checkedAt : checkedAt,
      durationMs: Math.max(0, now() - Date.parse(startedAt)),
      selectedTargetIds: [...selectedIds],
      progress: {total: targets.length, completed: completed.size,
        running: selectedRows.filter(row => row.phase === 'checking').length,
        queued: selectedRows.filter(row => row.phase === 'queued').length,
        retrying: selectedRows.filter(row => row.phase === 'retry_wait').length},
      summary: summarize(resultRows), targets: resultRows};
    report.nextCheckAt = status === 'cancelled' ? null : reportNextCheckAt(report, config);
    service.ledger.set(CLIENT_UPDATE_STATE_KEY, report);
    return report;
  };
  persist();
  const concurrency = 4;
  let cursor = 0;
  const worker = async () => {
    while (!signal.aborted && cursor < targets.length) {
      const target = targets[cursor++];
      rows.set(target.id, {...rows.get(target.id), phase: 'checking'});
      persist();
      if (target.enabled === false) {
        rows.set(target.id, finishTarget({id: target.id, name: target.name, platform: target.platform,
          ...updateSource(target), status: 'disabled', attemptCount: 0, retryCount: 0}, priorRows.get(target.id), config, now(), now));
        completed.add(target.id);
        persist();
        continue;
      }
      try {
        const result = await checkTarget(target, config, {timeoutMs: config.timeoutMs, fetchImpl, signal,
          previous: priorRows.get(target.id), now, maxRetries, retryBaseMs, random, sleep,
          onProgress: state => { rows.set(target.id, {...rows.get(target.id), ...state}); persist(); }});
        rows.set(target.id, result);
      } catch (error) {
        rows.set(target.id, finishTarget({id: target.id, name: target.name, platform: target.platform,
          ...updateSource(target), status: signal.aborted ? 'cancelled' : 'error', error: error.message,
          ...classifyClientUpdateError(error, {cancelled: signal.aborted})}, priorRows.get(target.id), config, now(), now));
      }
      completed.add(target.id);
      persist();
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, targets.length)}, worker));
  if (signal.aborted) {
    for (const target of targets) if (!completed.has(target.id)) {
      rows.set(target.id, finishTarget({...rows.get(target.id), status: 'cancelled',
        error: String(signal.reason?.message ?? '检查已取消'),
        ...classifyClientUpdateError(signal.reason, {cancelled: true})}, priorRows.get(target.id), config, now(), now));
    }
  }
  return persist(signal.aborted ? 'cancelled' : 'ok');
}

function targetIsDue(row, config, now) {
  if (!row || row.status === 'cancelled' || ['queued', 'checking', 'retry_wait'].includes(row.phase)) return true;
  const dueAt = Date.parse(targetNextCheckAt(row, config));
  return !Number.isFinite(dueAt) || now >= dueAt;
}

function reportNextCheckAt(report, config) {
  if (config.enabled === false || report.status === 'cancelled') return null;
  const times = (report.targets ?? []).map(row => Date.parse(targetNextCheckAt(row, config))).filter(Number.isFinite);
  if (times.length) return new Date(Math.min(...times)).toISOString();
  const last = Date.parse(report.checkedAt);
  return Number.isFinite(last) ? new Date(last + config.intervalHours * 3600000).toISOString() : null;
}

export function clientUpdatesReport(service) {
  const config = normalizeClientUpdates(service.config.value.clientUpdates);
  const report = service.ledger.get(CLIENT_UPDATE_STATE_KEY) ?? {status: 'not_started'};
  return {...report, enabled: config.enabled, intervalHours: config.intervalHours,
    nextCheckAt: reportNextCheckAt(report, config)};
}

export function clientUpdateDue(service, now = Date.now()) {
  const config = normalizeClientUpdates(service.config.value.clientUpdates);
  if (config.enabled === false) return false;
  if (activeChecks.has(service)) return false;
  const report = service.ledger.get(CLIENT_UPDATE_STATE_KEY);
  if (report?.status === 'cancelled') return true;
  if (report?.targets?.length && report.targets.some(row => targetIsDue(row, config, now))) return true;
  if (report?.targets?.length) return false;
  if (!report?.checkedAt) return true;
  const last = Date.parse(report.checkedAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= config.intervalHours * 3600000;
}
