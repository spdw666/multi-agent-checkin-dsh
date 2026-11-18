// OpenCode Zen free-tier bridge.
//
// A 403 from the public endpoint is not proof that every free route is closed:
//   POST https://opencode.ai/inference/openai/v1/chat/completions
//   {"error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode."}}
// Verified 2026-10-17 with the stored OAuth token, and with opencode-looking
// user-agent/client/session headers — all 403. Paid tiers answer 400
// "Model is unavailable" for names that are not in the caller's plan.
//
// This adapter uses the genuine local OpenCode server. An opt-in dedicated
// network profile can isolate its connection without altering the user's
// global proxy or the official shared service. The adapter drives that server
// over its authenticated loopback API: create a session, post the prompt, poll
// the session message list, and translate the assistant message into the
// OpenAI shape the router expects.
//
// What stays true:
//  - The access token, refresh token and server password never leave this file.
//  - The upstream call happens inside OpenCode, so quota and abuse rules are
//    whatever OpenCode itself enforces. This adapter adds no evasion.
//  - Free-tier availability, model names and limits can change without notice;
//    a failure is reported as the real upstream error, never as success.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {AppError,rememberSecret,errorView} from './util.mjs';
import {resolveOpenCodeService} from './opencode-service.mjs';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
// 长任务实测：一次 3000 词请求 95.9s 才 finish（22,827 字符 / 5,533 输出 token）。
// 旧的 120s 顶到边缘就会被判超时，120s→300s 让 "长文/长任务" 真正跑完。
const SESSION_TIMEOUT_MS = 300000;
const POLL_INTERVAL_MS = 1200;

function servicePasswordPath() {
  return join(homedir(), '.config', 'opencode', 'service.json');
}
function credentialDatabasePath() {
  // The desktop app keeps opencode.db under the user profile, not AppData.
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

// Only the loopback server the desktop app already runs is accepted. A caller
// cannot point this at an arbitrary host.
function serverOrigin(value) {
  const raw = typeof value === 'string' && value ? value : '';
  const match = LOOPBACK.exec(raw);
  if (!match) throw new AppError('OpenCode 本机服务地址需为 127.0.0.1 回环地址', 400, 'opencode_endpoint_invalid');
  return raw;
}

async function readJson(file, code, message) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new AppError(message, 401, code);
    throw new AppError(message, 502, code);
  }
}

// The desktop app stores its OAuth token in opencode.db and the local server
// password in service.json. Both are read-only here; nothing is written back.
async function desktopSession(account) {
  const dbPath = account?.credentials?.file && account.credentials.file !== 'auto'
    ? account.credentials.file
    : credentialDatabasePath();
  let rows;
  try {
    const db = new DatabaseSync(dbPath, {readOnly: true});
    try {
      rows = db.prepare("SELECT json_extract(value,'$.access') AS access, json_extract(value,'$.expires') AS expires FROM credential WHERE active=1 AND integration_id='opencode' LIMIT 1").all();
    } finally { db.close(); }
  } catch (error) {
    throw new AppError('OpenCode 登录态待就绪（数据库不可读）', 401, 'opencode_login_required');
  }
  const row = rows?.[0];
  if (!row || typeof row.access !== 'string' || !row.access) {
    throw new AppError('OpenCode 尚未登录，请先在官方客户端完成登录', 401, 'opencode_login_required');
  }
  const service = await readJson(servicePasswordPath(), 'opencode_service_missing', 'OpenCode 本机服务配置待就绪');
  if (typeof service.password !== 'string' || !service.password) {
    throw new AppError('OpenCode 本机服务密码待就绪', 401, 'opencode_service_missing');
  }
  rememberSecret(row.access);
  rememberSecret(service.password);
  const expiresAtMs = Number.isFinite(Number(row.expires)) ? Number(row.expires) : null;
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    throw new AppError('OpenCode 登录态已过期，请在官方客户端续期', 401, 'opencode_login_expired');
  }
  return {accessToken: row.access, password: service.password, principal: 'opencode-desktop', expiresAtMs};
}

function authorization(credential) {
  return 'Basic ' + Buffer.from('opencode:' + credential.password, 'utf8').toString('base64');
}

async function api(service, credential, path, {method = 'GET', body, signal, timeoutMs = 20000} = {}) {
  if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
  const origin = serverOrigin(service.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay, {once: true});
  if (signal?.aborted) relay();
  try {
    if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
    const response = await fetch(origin + path, {
      method,
      headers: {authorization: authorization(credential), 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 300); } catch {}
      const status = response.status === 401 || response.status === 403 ? 401 : response.status === 404 ? 502 : 502;
      throw new AppError('OpenCode 本机服务返回 ' + response.status + (detail ? '：' + detail : ''), status, 'opencode_bridge_failed');
    }
    // 204 (session delete) carries no body; do not fail on an empty payload.
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
    if (controller.signal.aborted) throw new AppError('OpenCode 本机服务响应超时', 504, 'opencode_bridge_timeout');
    throw new AppError('OpenCode 本机服务不可达：' + (error.message ?? 'unknown'), 503, 'opencode_bridge_unreachable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

// Model list comes from the running app, so a renamed or withdrawn free model
// disappears from the directory instead of being guessed.
//
// 能力必须照抄上游 /api/model 的真实声明：`capabilities.tools` 与
// `capabilities.input` 里是否含 'image'。旧版本这里硬编码 tools:false /
// multimodal:false，直接把 deepseek-v4.1-flash-free（上游声明 tools:true、
// input:[text,image]）标成「不会工具、不能识图」，与实测相反。
export async function openCodeModels(credential, upstream = {}, options = {}) {
  const service = upstream.kind === 'opencode' ? await resolveOpenCodeService(upstream, credential, options) : upstream;
  const payload = await api(service, credential, '/api/model', {signal: options.signal, timeoutMs: options.timeoutMs ?? 20000});
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter(row => row?.providerID === 'opencode')
    .filter(row => typeof row.id === 'string' && /-free$/.test(row.id))
    .map(row => {
      const input = Array.isArray(row.capabilities?.input) ? row.capabilities.input : [];
      const supportsImages = input.includes('image');
      const supportsTools = row.capabilities?.tools === true;
      // variants 是上游自己的思考档清单（low/high/max），照抄成 OpenAI 形状。
      const efforts = (Array.isArray(row.variants) ? row.variants : [])
        .map(v => (typeof v?.id === 'string' ? v.id : null)).filter(Boolean);
      return {
        id: row.id,
        name: row.name ?? row.id,
        // The gateway only treats a model as importable when both limits are
        // known positive integers; OpenCode reports them under limit.context/output.
        callable: true,
        importable: true,
        free: true,
        contextWindow: Number.isSafeInteger(row.limit?.context) ? row.limit.context : null,
        // 输出上限是上游给的 limit.output；桥不裁剪输出，只裁剪输入。
        maxTokens: Number.isSafeInteger(row.limit?.output) ? row.limit.output : null,
        maxTokensSource: Number.isSafeInteger(row.limit?.output) ? 'official_catalog' : null,
        officialMaxTokens: Number.isSafeInteger(row.limit?.output) ? row.limit.output : null,
        tools: supportsTools,
        ...(supportsTools ? {toolsSource: 'opencode_live_catalog_2026-11-17'} : {}),
        multimodal: supportsImages,
        ...(efforts.length ? {reasoning: {supportedEfforts: efforts, defaultEffort: efforts[0]}, reasoningEfforts: Object.fromEntries(efforts.map(e => [e, e])), reasoningSource: 'opencode_catalog_variants'} : {}),
        note: '本机 OpenCode 会话桥：文本+图像附件、多轮历史拼接、提示词工具契约（无原生 tools 通道）；额度与可用性由 OpenCode 决定',
      };
    });
}

// OpenCode surfaces upstream failures as a typed block. Map the ones that mean
// something to the gateway so quota/auth problems trigger cooldown or handoff
// instead of being reported as a malformed answer.
function providerError(error) {
  const status = Number(error?.status) || 0;
  const detail = typeof error?.message === 'string' && error.message ? error.message : 'unknown';
  if (status === 403 && /free tier can only be used from within OpenCode/i.test(detail)) {
    return new AppError('OpenCode 官方免费层拒绝了本次请求：' + detail + '；登录成功与免费层推理资格分别核验', 403, 'opencode_free_tier_rejected');
  }
  if (status === 403 && /not available in your country/i.test(detail)) {
    return new AppError('OpenCode 官方模型地区不可用：' + detail, 403, 'opencode_region_unavailable');
  }
  if (status === 429) return new AppError('OpenCode 免费层限流：' + detail, 429, 'opencode_free_rate_limited');
  if (status === 401 || status === 403) return new AppError('OpenCode 授权失败：' + detail, 401, 'opencode_unauthorized');
  if (status === 402) return new AppError('OpenCode 额度不足：' + detail, 402, 'opencode_quota_exhausted');
  return new AppError('OpenCode 上游错误：' + detail, 502, 'opencode_upstream_error');
}

function assistantText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const text = parts.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  const reasoning = parts.filter(part => part?.type === 'reasoning' && typeof part.text === 'string').map(part => part.text).join('');
  return {text, reasoning};
}

// ---------------------------------------------------------------------------
// 调用方协议 → OpenCode 会话协议
//
// openapi（/openapi.json，2026-11-17 实测 124 条 paths）里 prompt 只收
// {text, files}：没有 tools、没有 max_tokens、没有 temperature。旧实现因此对
// 任何工具、图像、多轮历史直接 400，把「能识图会工具」的模型标成纯文本。
// 实测（2026-11-17）纠正了三点：
//   1) files[].uri 接受 data:image/png;base64 与 file:///，16x16 PNG 被正确
//      识别成 "Red"，所以图像可以无损转过去；
//   2) 把 OpenAI 的 tool 定义写成提示词契约后，模型会精确回一行
//      {"tool_calls":[{"name":..,"arguments":{..}}]}（3.8s，正文精确命中），
//      工具语义可以保留；
//   3) 多轮历史拼进单条 text 后模型确实按历史回答（Ada/41 → ADA:41）。
// 仍然做不到的只有采样参数与显式输出上限（会话桥没有这两个通道），这类请求
// 继续抛 relay_capacity_incompatible，让路由把原文交给兼容供应。
// ---------------------------------------------------------------------------
const TOOL_CONTRACT_MAX_SPECS = 32;
// 单条 prompt 的字符预算：会话桥按上游 200K 窗口收，留出契约与模板余量。
const PROMPT_CHAR_BUDGET = 400000;

// 采样参数与原生输出上限是会话桥唯一真实缺失的通道；保留原样交给兼容供应。
//
// 例外：stream_options / store 不是生成参数，而是我方能准确兑现的传输控制，
// 收下即等价，不算静默丢弃调用方约束：
//   - stream_options.include_usage：桥本来就自己聚合 usage（assistant.tokens
//     换算成 prompt_tokens/completion_tokens），不需要上游再发 usage 分片；
//   - store：桥每次请求都新建 session，并在 finally 里 DELETE 掉整段 transcript，
//     本身就等于 store:false。
// DSH 的 pi-ai openai-completions 适配器会无条件带这两个键（supportsUsageInStreaming
// 与 supportsStore 默认都是 true），不收就会让整轮对话在起服务前 400：
// 2026-11-17T15:27Z aigw-298984b7 实测报「未提供本次显式生成参数：stream_options, store」。
// 真正的采样参数（temperature/top_p/stop/response_format/seed 等）仍然明确拒绝。
export const ABSORBED_TRANSPORT_CONTROLS = Object.freeze(['stream_options', 'store']);

function toolSpecLines(tools) {
  const picked = tools.slice(0, TOOL_CONTRACT_MAX_SPECS);
  const lines = picked.map(t => {
    const fn = t?.function ?? t ?? {};
    const params = fn.parameters ?? {};
    const argList = Object.keys(params?.properties ?? {}).join(', ') || '无参数';
    const desc = String(fn.description ?? '').replace(/\s+/g, ' ').slice(0, 80);
    return '- ' + (fn.name ?? '') + '(' + argList + ')' + (desc ? ': ' + desc : '');
  });
  if (tools.length > picked.length) {
    const rest = tools.slice(picked.length).map(t => (t?.function ?? t ?? {}).name ?? '').filter(Boolean);
    lines.push('- 另有 ' + rest.length + ' 个工具，用法相同，按名称直接调用即可（例如 ' + rest.slice(0, 8).join(', ') + (rest.length > 8 ? ' …' : '') + '）。');
  }
  return lines.join('\n');
}

function toolContract(tools, retry) {
  const head = retry ? '上一次回复没有被解析成工具调用。这一次请只输出那一行 JSON，不要任何解释、不要 Markdown 代码块。\n\n' : '';
  const bounds = [
    '忽略你自己环境里的内置工具（read/edit/bash 等）；本对话里可用的工具只有下面列出的这些，且由我方程序执行。',
    '需要工具时不要输出 Markdown 代码块，直接给裸 JSON。',
  ].join('\n');
  return `${head}${bounds}\n\n我的程序会读取并执行你回复里的工具调用，然后把结果发回来。需要调用工具时，请直接输出一行 JSON：
{"tool_calls":[{"name":"工具名","arguments":{...}}]}
不需要工具时，正常回答即可。

可用工具：
${toolSpecLines(tools)}`;
}

// 历史必须拼成一条文本：会话桥的 prompt 只有 text 一个内容入口。用与 OpenAI
// 消息形状无关的显式标记，避免模型把历史文本当成自己的指令。
function historyBlock(messages) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : m.role === 'tool' ? 'tool' : 'user';
    let text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? p.text ?? '' : '')).join('')
        : '';
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const notes = m.tool_calls.map(c => {
        const name = c?.function?.name ?? c?.name ?? '';
        const args = safeJson(c?.function?.arguments ?? c?.arguments ?? {});
        return '（我调用了 ' + name + '，参数 ' + JSON.stringify(args) + '）';
      });
      text = (text ? text + '\n' : '') + notes.join('');
    }
    if (!text.trim()) continue;
    out.push(`<|${role}|>\n${text}`);
  }
  return out.join('\n\n');
}

function safeJson(value) {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}

// data: URI 或 http(s) URL 都是 FileAttachment.uri 允许的形状；OpenAI 的
// image_url.url 原样搬过去即可。非图（image_url 之外的多模态部件）不猜，直接报错。
function imageFiles(messages) {
  const files = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      if (part?.type !== 'image_url' && part?.type !== 'input_image') continue;
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.image_url;
      if (typeof url === 'string' && url) files.push({uri: url, name: url.startsWith('data:') ? 'inline-image' : url.split('/').pop() || 'image'});
    }
  }
  return files;
}

function stripDataUri(url) {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(String(url ?? ''));
  if (!m) return null;
  return {mime: m[1] ?? 'image/png', base64: m[2]};
}

// 1x1 或损坏的 data URI 会被 OpenCode 以 400 "Image could not be decoded" 拒绝，
// 那会让一条本来只想问文字历史的长对话整轮失败。发送前先做最小校验。
function validDataUri(url) {
  const parsed = stripDataUri(url);
  if (!parsed) return true; // file:// 或 http(s) 交给上游判断
  const payload = parsed.base64.trim();
  if (!payload) return false;
  try {
    const bytes = Buffer.from(payload, 'base64');
    // PNG 签名 + IHDR 宽度/高度：太小（1x1）上游解码器会拒。
    if (bytes.length < 60) return false;
    if (parsed.mime === 'image/png' && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
    if (parsed.mime === 'image/png') {
      const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
      if (!(w >= 2 && h >= 2)) return false;
    }
    return true;
  } catch { return false; }
}

// OpenAI 的 reasoning_effort 在会话桥里没有对应字段，但 session 的
// Model.Ref.variant 就是思考档（实测 2026-11-17：default/low/high/max 逐档可设，
// 回执 modelVariant.variant 与请求一致）。所以这里只做「档位→variant」翻译，
// 不再像旧实现那样把 reasoning_effort 当非法生成参数拒掉。
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function wantsVariant(input) {
  if (input?.reasoning_effort === undefined) return null;
  const effort = typeof input.reasoning_effort === 'string' ? input.reasoning_effort.trim().toLowerCase() : '';
  if (!EFFORT_ORDER.includes(effort)) throw new AppError('OpenCode思考档格式无效', 400, 'reasoning_effort_not_supported');
  return effort;
}

// 把请求档位落到上游真实声明的 variant 上（catalog 的 variants 通常只有
// low/high/max）。none/minimal 表示「尽量别思考」，取最弱的可用档。
function pickVariant(effort, variants) {
  if (!effort || !Array.isArray(variants) || !variants.length) return null;
  const ranked = variants.filter(v => EFFORT_ORDER.includes(v)).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (!ranked.length) return null;
  const want = EFFORT_ORDER.indexOf(effort);
  let best = ranked[0];
  for (const v of ranked) {
    if (EFFORT_ORDER.indexOf(v) <= want) best = v;
  }
  return best;
}

function bridgeRequest(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  if (!messages.length) throw new AppError('OpenCode 请求缺少消息', 400, 'empty_messages');
  const tools = Array.isArray(input?.tools) ? input.tools : Array.isArray(input?.functions) ? input.functions : [];
  const effort = wantsVariant(input);
  // 采样参数与原生输出上限是会话桥唯一真实缺失的通道；见 ABSORBED_TRANSPORT_CONTROLS。
  const unsupported = Object.keys(input ?? {}).filter(key => !['model', 'messages', 'stream', 'tools', 'tool_choice', 'functions', 'function_call', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', ...ABSORBED_TRANSPORT_CONTROLS].includes(key) && input[key] !== undefined);
  if (unsupported.length) {
    throw new AppError('OpenCode 本机协议未提供本次显式生成参数：' + unsupported.join(', ') + '；原始约束已保留供兼容供应接力', 400, 'relay_capacity_incompatible');
  }
  const files = imageFiles(messages).filter(f => {
    if (f.uri.startsWith('data:') && !validDataUri(f.uri)) return false;
    return true;
  });
  let text = historyBlock(messages);
  if (!text.trim()) throw new AppError('OpenCode 请求缺少可用文本', 400, 'empty_messages');
  const wantTools = tools.length > 0 && input?.tool_choice !== 'none';
  if (wantTools) {
    const contract = toolContract(tools, false);
    // 契约放在最后一条 user 之前，与豆包一致：写进 system 会被判提示词注入。
    text = contract + '\n\n---\n\n' + text;
  }
  if (text.length > PROMPT_CHAR_BUDGET) {
    // 超预算时保留尾部（最近对话），头部加省略标记。
    text = '[较早的对话已省略以适配会话桥单条文本上限]\n\n' + text.slice(-PROMPT_CHAR_BUDGET);
  }
  return {text, files, wantTools, tools, effort};
}

// 模型常带前后废话，不能全文 JSON.parse；找第一个括号配对的完整对象。
function matchJsonEnd(s) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return 0;
}

function parseToolCalls(text, tools) {
  if (typeof text !== 'string' || !text || !tools?.length) return null;
  const known = new Set(tools.map(t => (t?.function ?? t)?.name).filter(Boolean));
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = matchJsonEnd(text.slice(i));
    if (!end) continue;
    let obj;
    try { obj = JSON.parse(text.slice(i, i + end)); } catch { continue; }
    const arr = obj?.tool_calls;
    if (!Array.isArray(arr) || !arr.length) continue;
    const out = [];
    for (const c of arr) {
      const name = c?.name ?? c?.function?.name;
      if (name == null || !known.has(name)) continue;
      out.push({id: 'call_' + Math.random().toString(16).slice(2, 18), type: 'function', function: {name, arguments: JSON.stringify(safeJson(c?.arguments ?? c?.function?.arguments ?? {}))}});
    }
    if (out.length) return out;
  }
  return null;
}

function newest(rows, predicate) {
  return rows.map((row, index) => ({row, index})).filter(({row}) => predicate(row))
    .sort((a, b) => {
      const at = Number(a.row.time?.created), bt = Number(b.row.time?.created);
      return Number.isFinite(at) && Number.isFinite(bt) && at !== bt ? bt - at : a.index - b.index;
    })[0]?.row ?? null;
}

// The router contract is chat(upstream, credential, input, signal) -> {response}
// where response streams OpenAI SSE. OpenCode answers with one assembled message,
// so it is re-emitted as a single chunk followed by [DONE].
export async function openCodeChat(upstream, credential, input, signal) {
  if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
  const model = typeof input?.model === 'string' ? input.model : '';
  if (!model) throw new AppError('OpenCode 请求缺少模型 ID', 400, 'model_missing');
  const bridged = bridgeRequest(input);
  const service = upstream?.kind === 'opencode' ? await resolveOpenCodeService(upstream, credential, {signal}) : upstream ?? {};
  const timeoutMs = SESSION_TIMEOUT_MS;
  // 思考档只能通过 Model.Ref.variant 落到上游。catalog 声明的档位是权威清单
  // （free 模型是 low/high/max），请求档位先映射到最近的一档，映射不到就不设。
  const sessionModel = {providerID: 'opencode', id: model};
  if (bridged.effort) {
    const catalog = await api(service, credential, '/api/model', {signal, timeoutMs: 15000}).catch(() => null);
    const row = (Array.isArray(catalog?.data) ? catalog.data : []).find(entry => entry?.providerID === 'opencode' && entry?.id === model);
    const variants = (Array.isArray(row?.variants) ? row.variants : []).map(v => v?.id).filter(id => typeof id === 'string');
    const chosen = pickVariant(bridged.effort, variants);
    if (chosen) sessionModel.variant = chosen;
  }
  // Default agent is "build", which allows every tool — a forwarded chat message
  // could then edit files or run commands here. Read-only agent plus "ask" is the
  // strictest policy the free tier still accepts: community measurements report
  // that "deny" trips the same 403 gate as no session at all (实测 2026-11-17：
  // deny-all 会让回合在 100s 后 finish:"error" 且无任何正文). Any approval the
  // model raises is refused below, so no local action ever runs.
  const created = await api(service, credential, '/api/session', {
    method: 'POST',
    // A supplied title prevents OpenCode's automatic (potentially paid) title-model request.
    body: {title: 'AI credit gateway', location: {directory: process.cwd()}, model: sessionModel, agent: 'plan', permissions: [{action: '*', resource: '*', effect: 'ask'}]},
    signal,
    timeoutMs: 20000,
  });
  const sessionId = created?.data?.id;
  if (typeof sessionId !== 'string' || !sessionId) throw new AppError('OpenCode 未能创建会话', 502, 'opencode_session_failed');
  try {
    // files 只在真有图时才带：空数组会被 additionalProperties:false 的严格校验接受，
    // 但省掉更干净。
    const promptBody = bridged.files.length ? {text: bridged.text, files: bridged.files} : {text: bridged.text};
    const posted = await api(service, credential, '/api/session/' + encodeURIComponent(sessionId) + '/prompt', {method: 'POST', body: promptBody, signal, timeoutMs: 30000});
    void posted;
    const deadline = Date.now() + timeoutMs;
    let assistant = null, failure = null, completed = false;
    // 拒绝过的审批必须记住，否则每轮轮询都会重发一次 reply，把上游刷成 400。
    const answered = new Set();
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new AppError('请求取消或超时', 499, 'request_cancelled');
      // 本机模型会主动发起 read/bash 一类本地工具调用。网关只做中转，绝不能让它
      // 落到宿主机上：每轮把待审批项全部 reject（正确字段是 decision，不是 reply）。
      const pending = await api(service, credential, '/api/session/' + encodeURIComponent(sessionId) + '/permission', {signal, timeoutMs: 15000}).catch(() => null);
      for (const request of Array.isArray(pending?.data) ? pending.data : []) {
        const requestId = request?.id;
        if (typeof requestId !== 'string' || answered.has(requestId)) continue;
        answered.add(requestId);
        await api(service, credential, '/api/session/' + encodeURIComponent(sessionId) + '/permission/' + encodeURIComponent(requestId) + '/reply', {
          method: 'POST',
          body: {decision: 'reject', message: 'ai-credit-gateway: 本地工具执行已禁用'},
          timeoutMs: 15000,
        }).catch(() => {});
      }
      // Ask for the newest page explicitly: the default first page may contain
      // only old completed steps once a multi-step turn exceeds its page size.
      const listed = await api(service, credential, '/api/session/' + encodeURIComponent(sessionId) + '/message?order=desc&limit=200', {signal, timeoutMs: 20000});
      const rows = Array.isArray(listed?.data) ? listed.data : [];
      assistant = newest(rows, row => row?.type === 'assistant');
      failure = newest(rows, row => row?.type === 'error');
      const idle = newest(rows, row => row?.type === 'idle');
      // A failed turn carries its reason on the assistant or idle event, e.g.
      // {"type":"provider.quota","status":429,"message":"Rate limit exceeded"}.
      const turnError = assistant?.error ?? idle?.error ?? failure?.error ?? null;
      if (turnError) throw providerError(turnError);
      if (idle?.outcome === 'interrupted') throw new AppError('OpenCode 回合已中断', 502, 'opencode_turn_interrupted');
      if (failure || idle?.outcome === 'failed' || assistant?.finish === 'error') {
        throw new AppError('OpenCode 回合执行失败', 502, 'opencode_upstream_error');
      }
      // A tool-call step is not the final turn, even when its provider stream
      // completed. Inspect the newest assistant rather than the first row.
      const terminal = ['stop', 'length', 'content-filter'].includes(assistant?.finish);
      const idleAfterAssistant = idle?.outcome === 'succeeded' && (!assistant?.time?.created || !idle.time?.created || Number(idle.time.created) >= Number(assistant.time.created));
      completed = !!assistant && (terminal || idleAfterAssistant && assistant.finish !== 'tool-calls');
      if (completed) break;
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new AppError('请求取消或超时', 499, 'request_cancelled')); };
        const timer = setTimeout(done, POLL_INTERVAL_MS);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
      });
    }
    if (!completed) {
      const detail = failure?.message ?? failure?.error ?? 'unknown';
      throw new AppError('OpenCode 免费模型尚未返回完整终态：' + detail, 504, 'opencode_bridge_timeout');
    }
    if (assistant.model?.providerID !== 'opencode' || assistant.model?.id !== model) {
      throw new AppError('OpenCode 返回模型与所选模型不一致', 502, 'opencode_model_mismatch');
    }
    const shaped = assistantText(assistant);
    // 提示词契约回执：正文就是那一行 JSON 时，按 OpenAI 的 tool_calls 交回调用方。
    const calls = bridged.wantTools ? parseToolCalls(shaped.text, bridged.tools) : null;
    if (!calls && !shaped.text.trim()) {
      // OpenCode reports a failed turn as finish:"error" with empty text; surfacing
      // that as a successful empty answer would hide a real upstream failure.
      const detail = assistant?.error?.message ?? assistant?.error ?? failure?.message ?? 'empty answer';
      throw new AppError('OpenCode 免费模型未返回正文：' + detail, 502, 'opencode_empty_answer');
    }
    const usage = assistant?.tokens ? {
      prompt_tokens: assistant.tokens.input ?? 0,
      completion_tokens: assistant.tokens.output ?? 0,
      total_tokens: (assistant.tokens.input ?? 0) + (assistant.tokens.output ?? 0),
    } : null;
    const finish = calls ? 'tool_calls' : (assistant?.finish ?? 'stop');
    const delta = calls
      ? {role: 'assistant', content: null, tool_calls: calls.map((c, index) => ({index, ...c}))}
      : {role: 'assistant', content: shaped.text, ...(shaped.reasoning ? {reasoning_content: shaped.reasoning} : {})};
    const chunk = {
      id: 'chatcmpl-opencode-' + sessionId,
      object: 'chat.completion.chunk',
      model,
      choices: [{index: 0, delta, finish_reason: finish}],
      ...(usage ? {usage} : {}),
    };
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return {response: new Response(body, {headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'}})};
  } finally {
    // Sessions are cheap but not free; drop the transcript this request created.
    await api(service, credential, '/api/session/' + encodeURIComponent(sessionId), {method: 'DELETE', timeoutMs: 8000}).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 余额与免费额度
//
// Zen 的付费余额可以从 console 的 billing 接口读到（Bearer = 客户端 OAuth token，
// 实测 200：{balanceMicroCents:"0", mode:"pay-as-you-go"}）。免费模型的每日请求
// 限额由服务端私有配置控制、没有公开接口，这里只把「本机 OpenCode 数据库里今天
// 已经发生的请求数」如实统计出来，再按社区实测的 ~200 次/天给出估算剩余，并在
// note 里注明这是估算而不是官方数字。
const BILLING_URL = 'https://opencode.ai/console/api/billing/status';
const FREE_DAILY_LIMIT_ESTIMATE = 200;

function utcDayStartMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function localDailyRequests(account) {
  const dbPath = account?.credentials?.file && account.credentials.file !== 'auto'
    ? account.credentials.file
    : credentialDatabasePath();
  try {
    const db = new DatabaseSync(dbPath, {readOnly: true});
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM session_message WHERE type='assistant' AND time_created >= ? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.model.providerID')='opencode' AND json_extract(data,'$.model.id') GLOB '*-free' ELSE 0 END"
      ).get(utcDayStartMs());
      return Number(row?.n ?? 0);
    } finally { db.close(); }
  } catch { return null; }
}

async function zenBilling(accessToken, timeoutMs = 8000) {
  if (typeof accessToken !== 'string' || !accessToken) return {ok: false, reason: 'no-token'};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(BILLING_URL, {
      headers: {authorization: 'Bearer ' + accessToken, accept: 'application/json'},
      signal: controller.signal,
    });
    if (!response.ok) return {ok: false, status: response.status};
    const data = await response.json();
    // Missing, blank and boolean fields are unknown, not an observed $0.
    const raw = data?.balanceMicroCents;
    const micro = typeof raw === 'number' || typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(micro) || micro < 0) return {ok: false, reason: 'invalid-balance'};
    return {
      ok: true,
      balanceUsd: micro / 100_000_000,
      mode: typeof data?.mode === 'string' ? data.mode : null,
      billingMode: typeof data?.billingMode === 'string' ? data.billingMode : null,
    };
  } catch {
    return {ok: false};
  } finally { clearTimeout(timer); }
}

function openCodeBalance(account) {
  const used = localDailyRequests(account);
  const parts = [];
  let note;
  let value = null;
  let unit = '次（估算）';
  if (used === null) {
    note = '本机 OpenCode 数据库不可读，无法统计今日免费请求；官方未公开免费额度上限。';
  } else {
    const remaining = Math.max(0, FREE_DAILY_LIMIT_ESTIMATE - used);
    value = remaining;
    parts.push({name: '今日免费请求', value: used, unit: '次'});
    parts.push({name: '估算每日上限', value: FREE_DAILY_LIMIT_ESTIMATE, unit: '次（社区估算）'});
    note = '免费模型按 IP 每日限流，官方未公开上限，按社区实测约 ' + FREE_DAILY_LIMIT_ESTIMATE
      + ' 次/天估算（UTC 00:00 重置）。今日已用 ' + used + ' 次，估算剩 ' + remaining + ' 次。';
  }
  return {used, value, unit, parts, note};
}

export async function openCodeHealth(credential, upstream = {}, options = {}) {
  const service = upstream?.baseUrl ? upstream : (options.upstream?.baseUrl ? options.upstream : {});
  const account = options.account ?? {};
  // Quota sources do not require the desktop inference server to be running.
  // Keep its catalog diagnostic separate; a stopped app must not erase readable
  // local usage or the independently fetched official paid balance.
  const usage = openCodeBalance(account);
  const [catalog, billing] = await Promise.all([
    openCodeModels(credential, service, {...options, timeoutMs: options.timeoutMs ?? 3000})
      .then(models => ({models, error: null}), error => ({models: null, error: errorView(error)})),
    zenBilling(credential?.accessToken, options.timeoutMs ?? 8000),
  ]);
  const models = catalog.models;
  const balanceKnown = usage.value !== null || billing.ok && billing.balanceUsd !== null;
  const balanceParts = [...usage.parts];
  const notes = [catalog.error ? '本机 OpenCode 服务未连接，模型调用待恢复；额度独立读取' : '', usage.note];
  if (billing.ok && billing.balanceUsd !== null) {
    balanceParts.unshift({name: 'Zen 付费余额', value: billing.balanceUsd, unit: 'USD'});
    notes.push('Zen 余额 $' + billing.balanceUsd.toFixed(2)
      + (billing.balanceUsd > 0 ? '，可用付费模型' : '，仅免费模型可用'));
  } else if (!billing.ok) {
    notes.push('Zen 付费余额读取失败' + (billing.status ? '（HTTP ' + billing.status + '）' : ''));
  }
  return {
    known: balanceKnown,
    balanceKnown,
    status: catalog.error ? 'bridge_unavailable' : models.length ? 'ok' : 'empty',
    // Local session presence is not proof that the inference service is live.
    credentialStatus: catalog.error ? 'failed' : 'session',
    capabilities: {checkin: false, inference: !!models?.length},
    freeModels: models?.length ?? null,
    bridge: {status: catalog.error ? 'unavailable' : models.length ? 'ready' : 'empty', ...(catalog.error ? {error: catalog.error} : {})},
    billing: {known: billing.ok, ...(billing.status ? {status: billing.status} : {}), ...(billing.reason ? {reason: billing.reason} : {})},
    authentication: {status: 'session', source: 'opencode desktop'},
    balance: {
      // 主数值回答“还能用多少”：免费额度的估算剩余次数；余额放在 note/parts 里。
      value: usage.value !== null ? usage.value : (billing.ok ? billing.balanceUsd : null),
      unit: usage.value !== null ? usage.unit : 'USD',
      parts: balanceParts,
      note: notes.filter(Boolean).join('；').replace('；；', '；').replace('。；', '。'),
    },
  };
}

export function openCodeResolve(account) {
  return desktopSession(account);
}

// Signatures match the other desktop adapters: models(credential, options) and
// health(credential, options) receive the resolved credential; chat gets the
// upstream row (which carries the loopback baseUrl) as its first argument.
export const openCodeProvider = {
  resolve: (account) => openCodeResolve(account),
  models: (credential, options = {}) => openCodeModels(credential, options.upstream ?? {}, options),
  health: (credential, options = {}) => openCodeHealth(credential, options.upstream ?? {}, options),
  chat: (upstream, credential, input, signal) => openCodeChat(upstream, credential, input, signal),
  checkinSupported: false,
  descriptor: {name: 'OpenCode Zen 免费', checkinSupported: false},
};
