import {AppError, dayIn} from './util.mjs';

// 豆包桌面客户端「工作」模式的同源协议。
// 实测基线 2026-11-13（豆包 2.25.10 / Chromium 147 / pc_version 2.35.8）：
//  - 端点 POST https://www.doubao.com/chat/completion
//  - 选模型靠 option 里三处同步的 model_item_key（豆包自家用数字，第三方用 person-* 全名）
//  - 推理强度 option.reasoning_effort：低=3 / 中=4 / 高=5
//  - 不需要 a_bogus / msToken 签名；但必须用桌面客户端 aid=582478，网页版 497858 会被判「访问频繁」
//  - 正文在 STREAM_CHUNK 的 patch_op[patch_object=1].patch_value.content_block[block_type=10000].content.text_block.text
const ENDPOINT = 'https://www.doubao.com/chat/completion';
const BOT_ID = '7338286299411103781';
const AID = 582478;
const DEFAULT_DEVICE_ID = '810790401142921';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// 工作模式固定档位。对话模式那套 need_deep_think 0/1/3 不适用。
const WORK_MODE = {agentMode: 1, needDeepThink: 10001, modeId: '3', conversationMode: '2'};

// 菜单项顺序与 i18n 文案取自客户端实测；key 为客户端在 localStorage.mode_select_value 落下的真实值。
// tools 字段是逐模型实测结果（2026-11-13，见 doubaoBridge）：走提示词桥时 9 个模型稳定回 tool_calls，
// 只有 GLM 5.3 Flash 坚持"我的接口不是这种约定"并拒绝，四种措辞都救不回来，故单独标 false。
export const DOUBAO_MODELS = [
  {id: 'auto', key: '9', name: '自动', vendor: 'doubao', defaultEffort: 'medium', tools: true},
  {id: 'doubao-2.1-lite', key: 'seed-lite-7b', name: '豆包 2.1 Lite', vendor: 'doubao', defaultEffort: 'medium', tools: true},
  {id: 'doubao-2.1-pro', key: '5', name: '豆包 2.1 Pro', vendor: 'doubao', defaultEffort: 'medium', tools: true},
  {id: 'deepseek-v4.1-flash', key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', vendor: 'deepseek', defaultEffort: 'medium', tools: true},
  {id: 'kimi-k3.1-pro', key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', vendor: 'moonshot', defaultEffort: 'medium', tools: true},
  {id: 'kimi-k3.1-pro-highspeed', key: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速', vendor: 'moonshot', defaultEffort: 'medium', tools: true},
  {id: 'kimi-k3', key: 'person-kimi-k3-261111', name: 'Kimi K3', vendor: 'moonshot', defaultEffort: 'medium', tools: true},
  {id: 'glm-5.3', key: 'person-glm-5-3-261111', name: 'GLM 5.3', vendor: 'zhipu', defaultEffort: 'high', tools: true},
  {id: 'glm-5.3-flash', key: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', vendor: 'zhipu', defaultEffort: 'high', tools: false},
  {id: 'deepseek-v4-pro', key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', vendor: 'deepseek', defaultEffort: 'high', tools: true},
];

const EFFORTS = {low: '3', medium: '4', high: '5'};

// 客户端只暴露低/中/高三级；OpenAI 的 minimal/xhigh 等档位在这里没有对应，直接拒绝而不是静默降级。
function wireEffort(effort, fallback) {
  if (effort == null || effort === '') return EFFORTS[fallback];
  const s = String(effort).trim();
  // 目录里 reasoningEfforts 是 {low:'3',medium:'4',high:'5'}；relay 在跨目标转发时
  // 会先把档位换成线值再交给 provider，所以这里必须幂等接受 3/4/5，否则同一请求
  // 直连能过、走 relay 就报「只支持低/中/高」。
  if (s === '3' || s === '4' || s === '5') return s;
  const v = EFFORTS[s];
  if (!v) throw new AppError(`豆包工作模式只支持低/中/高（low|medium|high），收到 ${effort}`, 400, 'reasoning_effort_not_supported');
  return v;
}

export function doubaoModel(id) {
  const raw = typeof id === 'string' ? id.trim() : '';
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return DOUBAO_MODELS.find(m => m.id === bare || m.id === raw || m.key === raw) ?? null;
}

// 模型目录：能力只声明已实测过的部分。tools 来自 DOUBAO_MODELS 的逐模型实测结果（桥），
// 上下文窗口未逐模型实测，统一给客户端默认值并标注来源，避免伪造精确数字。
export function doubaoModels() {
  return DOUBAO_MODELS.map(m => ({
    id: m.id,
    name: m.name,
    // 豆包没有 OpenAI 式原生 tools 通道，但 provider 内的提示词桥能把工具定义交出去并解析回执，
    // 对调用方而言确实返回 tool_calls，因此这里如实声明 true（稳定性见 doubaoBridge 的重试策略）。
    tools: m.tools === true,
    toolsSource: m.tools === true ? 'prompt_bridge_until_native_channel' : 'model_refuses_contract',
    multimodal: false,
    // 客户端工作模式在真实请求里带 model_extra_params:{memory_profile:'300k_230',
    // total_window_size:'300000'}，**豆包自己的文本窗口就是 300000**。早先保守写成 200000
    // 会让 DSH 的模型切换压缩算出 threshold=118080（=200000-16384 预留输出-65536 headroom），
    // 一个 120k 的会话就永远切不过来，报 MODEL_SWITCH_COMPACTION_FAILED。
    //
    // 但声明 300000 又太小：DSH 的 preflight 用 (contextWindow - maxTokens) 当可用输入窗口，
    // 即 283616，而它统计的 token 里包含**全部工具 JSON Schema**（475 个工具 = 255504 tokens）。
    // 豆包走提示词桥，工具只以文字清单进契约、Schema 全文不进 body，这部分开销对豆包并不存在，
    // 于是会话涨到 291311 tokens 就被永久拒发（实测 2026-11-13 21:52）。
    //
    // 600000 ≈ 豆包 300K 文本窗口 + 约 256K 工具 Schema 开销 + 余量，反映真实可用能力。
    // 文本量仍由 trimToBudget(blocks, MAX_TEXT_CHARS=280000) 按字符硬限，不会撑爆豆包。
    contextWindow: 600000,
    maxTokens: 16384,
    contextWindowSource: 'client_model_extra_params_total_window_size',
    maxTokensSource: 'doubao_client_work_mode_unverified',
    reasoning: {supportedEfforts: ['low', 'medium', 'high'], control: 'effort', defaultEffort: m.defaultEffort},
    reasoningEfforts: {...EFFORTS},
    reasoningSource: 'client_observed_2026-11-13',
    defaultEffort: m.defaultEffort,
    callable: true,
  }));
}

const uuid = () => crypto.randomUUID();

function safeParseJson(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return {};
  try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}

// 豆包没有 OpenAI 式 tools 通道：它的 function calling 是前端扩展注册、服务端触发的私有链路
// （window.neotix + saman_neotix_function_callback），反代侧无法注册函数，拿不到原生通道。
// 这里用「调用方约定」把工具定义交给模型并解析它输出的 JSON。两个实测结论决定了写法：
//   1) 约定必须写在 user 消息里；写进 system 会被 GLM / DeepSeek-V4-Pro 判成提示词注入而拒绝。
//   2) 措辞要说明「我的程序会读取并执行」，不能声称「你拥有这个工具」，否则模型会答"环境里没有"。
// DSH 一次会递上几百个工具定义（实测 351 个）。原实现把每个工具的完整 JSON Schema 都写进
// 契约，光这一项就能撑到十几万字符，豆包会直接判 710020202 common invalid param。
// 这里只保留名称、参数名和一句描述：调用方本来就按名称分发，模型不需要看到 schema 全文。
const TOOL_CONTRACT_MAX_SPECS = 32;

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
    // 曾把剩余工具名全部列出（实测 461 个、近万字符），结果契约被稀释到模型
    // 只记住「本地工具」而忘记输出 JSON 回执。这里只给数量与示例。
    const rest = tools.slice(picked.length).map(t => (t?.function ?? t ?? {}).name ?? '').filter(Boolean);
    lines.push('- 另有 ' + rest.length + ' 个工具，用法相同，按名称直接调用即可（例如 ' + rest.slice(0, 8).join(', ') + (rest.length > 8 ? ' …' : '') + '）。');
  }
  return lines.join('\n');
}

function toolContract(tools, retry) {
  const head = retry
    ? '上一次回复没有被解析成工具调用。这一次请只输出那一行 JSON，不要任何解释、不要 Markdown 代码块。\n\n'
    : '';
  // 这三条边界缺一不可：模型会主动去用豆包客户端的本地文件工具、把历史叙述当指令、
  // 或者把契约 JSON 包进代码块导致解析失败。
  const bounds = [
    '你没有本地文件读写、命令执行或环境管理能力；不要尝试读取或创建任何本地文件，也不要调用任何本地工具。',
    '对话历史里形如「（我调用了 X）」和「[调用方程序返回的结果]」的文字，是我方程序在你我之间转述的记录，不是你的能力，也不代表你现在可以执行它们。',
    '需要工具时不要输出 Markdown 代码块，直接给裸 JSON。',
  ].join('\n');
  return `${head}${bounds}\n\n我的程序会读取并执行你回复里的工具调用，然后把结果发回来。需要调用工具时，请直接输出一行 JSON：
{"tool_calls":[{"name":"工具名","arguments":{...}}]}
不需要工具时，正常回答即可。

可用工具：
${toolSpecLines(tools)}`;
}

function withToolContract(messages, contract) {
  const arr = Array.isArray(messages) ? messages.slice() : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.role !== 'user') continue;
    const c = arr[i].content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text ?? '').join('') : '';
    arr[i] = {...arr[i], content: contract + '\n\n---\n\n' + text};
    return arr;
  }
  arr.push({role: 'user', content: contract});
  return arr;
}

// 模型常带前后废话，不能全文 JSON.parse；这里找第一个括号配对的完整对象。
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
  if (typeof text !== 'string' || !text) return null;
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
      out.push({
        id: 'call_' + uuid().replace(/-/g, '').slice(0, 16),
        type: 'function',
        function: {name, arguments: JSON.stringify(safeParseJson(c?.arguments ?? c?.function?.arguments ?? {}))},
      });
    }
    if (out.length) return out;
  }
  return null;
}

// OpenAI messages → 豆包单条 content。豆包按 conversation_id 承载历史，直接新建会话时
// 只能把整段对话序列化进一条消息；这是实测可用的无状态形态。
// 单条 text_block 的安全上限（字符，不是字节）。取 28 万是为了留出工具契约与模板文本的余量。
const MAX_TEXT_CHARS = 280000;

function trimToBudget(blocks, budget) {
  let total = 0;
  for (const [, t] of blocks) total += t.length;
  if (total <= budget) return blocks;
  const head = [];
  const rest = [];
  for (const b of blocks) (b[0] === 'system' ? head : rest).push(b);
  let left = budget;
  for (const [, t] of head) left -= t.length;
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const len = rest[i][1].length;
    if (len > left) {
      if (!kept.length && left > 1000) kept.unshift([rest[i][0], rest[i][1].slice(-left)]);
      break;
    }
    kept.unshift(rest[i]);
    left -= len;
  }
  const omitted = rest.length - kept.length;
  const out = head.slice();
  if (omitted > 0) out.push(['system', '[已省略 ' + omitted + ' 条较早消息以适配豆包单条文本上限]']);
  out.push(...kept);
  return out;
}

function flattenMessages(messages, system) {
  let blocks = [];
  if (typeof system === 'string' && system.trim()) blocks.push(['system', system]);
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    // 豆包只有「一条 user 消息」这一种入口，OpenAI 的 tool 角色必须降级成文本往返，
    // 否则带工具历史的对话会在第二轮丢掉工具结果。
    if (m.role === 'tool') {
      const t = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map(p => p?.text ?? '').join('') : '';
      blocks.push(['tool', `[调用方程序返回的结果${m.name ? ' / ' + m.name : ''}] ${t}`]);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    let text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? p.text ?? '' : '')).join('')
        : '';
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // 历史里的调用必须写成「叙述」，绝不能写成契约同形 JSON。
      // 实测：写成 {"tool_calls":[...]} 时模型会把它当成自己的执行意图，
      // 转头去调豆包客户端的本地文件工具，正文全空，整轮只能判 empty_response。
      const notes = m.tool_calls.map(c => {
        const name = c?.function?.name ?? c?.name ?? '';
        const args = safeParseJson(c?.function?.arguments ?? c?.arguments ?? {});
        return '（我调用了 ' + name + '，参数 ' + JSON.stringify(args) + '）';
      });
      text = (text ? text + '\n' : '') + notes.join('');
    }
    if (!text) continue;
    blocks.push([role, text]);
  }
  if (!blocks.length) throw new AppError('豆包请求缺少可用消息内容', 400, 'empty_messages');
  // 豆包工作模式对单条 text_block 有长度上限：实测 20 万字符可过、57 万字符被服务端判
  // 710020202 common invalid param（不是超时，是读 body 时即拒）。超限时保留 system 与最近的
  // 若干轮，从中间丢弃并留一条省略标记，保证长会话仍能跑而不是整轮失败。
  blocks = trimToBudget(blocks, MAX_TEXT_CHARS);
  if (blocks.length === 1 && blocks[0][0] === 'user') return blocks[0][1];
  return blocks.map(([r, t]) => `<|im_start|>${r}\n${t}<|im_end|>`).join('\n');
}

export function doubaoBody(input, meta, deviceId = DEFAULT_DEVICE_ID) {
  const now = Date.now();
  const localMessageId = uuid();
  const text = flattenMessages(input.messages, input.system);
  const effort = wireEffort(input.reasoning_effort, meta.defaultEffort);
  const agentTaskParam = {runtime_type: 1, folder_name: '', device_name: '', workspace: '', local_app_id: '', local_device_id: ''};
  const generalTaskParam = {
    action: 0,
    thread_local_message_id: [localMessageId],
    project_id: '',
    runtime_type: 1,
    agent_task_param: agentTaskParam,
    server_do_compare: true,
  };
  const conversationInitOption = {project_id: '', need_ack_conversation: true};
  return {
    client_meta: {
      local_conversation_id: 'local_' + String(now).slice(-16),
      conversation_id: '',
      bot_id: BOT_ID,
      last_section_id: '',
      last_message_index: null,
      local_permissions: [
        {permission_name: 'ACCESS_COARSE_LOCATION', status: 3},
        {permission_name: 'ACCESS_FINE_LOCATION', status: 3},
        {permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 3},
      ],
    },
    messages: [{
      local_message_id: localMessageId,
      content_block: [{
        block_type: 10000,
        content: {text_block: {text, icon_url: '', icon_url_dark: '', summary: ''}, pc_event_block: ''},
        block_id: uuid(),
        parent_id: '',
        meta_info: [],
        extra_info: {},
        append_fields: [],
      }],
      message_status: 0,
    }],
    option: {
      send_message_scene: '',
      create_time_ms: now,
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      agent_mode: WORK_MODE.agentMode,
      tts_switch: false,
      need_deep_think: WORK_MODE.needDeepThink,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: uuid(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: conversationInitOption,
      conversation_init_ext: {
        agent_task_param: JSON.stringify(agentTaskParam),
        model_item_key: meta.key,
        reasoning_effort: effort,
        mode_id: WORK_MODE.modeId,
      },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: {support_chunk_delta: true},
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: generalTaskParam,
      recovery_option: {is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0},
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: {model_item_key: meta.key, model_extra_params: {memory_profile: '300k_230', total_window_size: '300000'}, reasoning_effort: Number(effort)},
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: WORK_MODE.conversationMode,
        mode_id: WORK_MODE.modeId,
        model_item_key: meta.key,
        agent_mode: String(WORK_MODE.agentMode),
        reasoning_effort: effort,
        provider_id: '',
      },
      conversation_mode: Number(WORK_MODE.conversationMode),
    },
    user_context: [],
    ext: {
      general_task_param: JSON.stringify(generalTaskParam),
      use_deep_think: String(WORK_MODE.needDeepThink),
      agent_mode: String(WORK_MODE.agentMode),
      conversation_init_option: JSON.stringify(conversationInitOption),
      sub_conv_firstmet_type: '1',
      collection_id: '',
      is_finish: '1',
      commerce_credit_config_enable: '0',
    },
  };
}

function doubaoUrl(deviceId) {
  const q = new URLSearchParams({
    aid: String(AID), device_id: deviceId, device_platform: 'web', doubao_device_platform: 'desktop',
    channel: 'win', client_platform: 'pc_client', chromium_version: '147.0.7727.149',
    pc_version: '2.35.8', doubao_pc_version: '2.35.8', fp: 'verify_' + deviceId,
    web_id: deviceId, tea_uuid: deviceId, web_tab_id: deviceId + '-1', samantha_web: '1',
    region: 'CN', version_code: '20800', real_aid: String(AID), language: 'zh',
    real_region: 'CN', sys_region: 'CN', use_olympus: '0',
  });
  return ENDPOINT + '?' + q.toString();
}

// 710012001 = 登录态失效；710022002/710022013 = 账号维度临时风控（实测：短时内连续新建会话后触发，
// 表现为 HTTP 200 + SSE_HEARTBEAT/STREAM_ERROR/SSE_REPLY_END，300~400ms 即拒，冷却后自行恢复）；
// 710022004 = 需要验证码。按语义映射成网关能识别的状态码，让 router 的 fallbackStatuses 与账号冷却生效。
// 710022002 / 710022004 / 710022013 实测是同一族账号级频控：连续请求后开始返回，
// 文案分别是「当前服务访问频繁」「需要验证码」「系统错误」，但都是「等一下就好」。
// 三个必须同样映射成 429 —— 路由的 fallbackStatuses 只认 408/429/500/502/503/504，
// 早先把 710022004 写成 403 会让这类可重试的限流被当成终端错误直接甩给客户端
// （DSH 里表现为 gateway_terminal_error HTTP 400，用户点了重发还是立刻失败）。
const ERROR_STATUS = {710012001: 401, 710012000: 401, 710022002: 429, 710022013: 429, 710022004: 429, 710020202: 400};
const RATE_LIMIT_CODES = new Set([710022002, 710022004, 710022013]);

function upstreamError(code, message, extra) {
  console.error('[doubao] upstream', code, String(message || '').slice(0, 200), JSON.stringify(extra ?? {}).slice(0, 300));
  const status = ERROR_STATUS[Number(code)] ?? 502;
  const kind = RATE_LIMIT_CODES.has(Number(code)) ? 'doubao_rate_limited' : 'doubao_upstream_error';
  const verify = Number(code) === 710022004;
  const human = verify ? '（豆包要求人机验证：请打开豆包客户端完成验证码后重试，网关无法代过）' : '';
  const err = new AppError(`豆包 ${code}: ${message || '请求被拒绝'}${human}`, status, kind);
  if (extra && typeof extra === 'object') err.upstreamExtra = extra;
  // 这一族都是账号级/窗口级限流，响应里没有 Retry-After，短冷却只会让客户端反复重撞，
  // 越撞越难恢复（710022004 更要人工过验证码，30 秒绝无可能自愈）。由 provider 自己声明
  // 900 秒本地冷却，而不是让 model-relay 的通用策略替所有平台猜一个长窗口。
  err.upstreamCode = Number(code);
  if (RATE_LIMIT_CODES.has(Number(code))) {
    err.rateLimitKind = 'long_window';
    err.rateLimitRetryable = false;
    err.localRetrySeconds = 900;
  }
  return err;
}

export function doubaoCookie(c) {
  if (typeof c?.cookie === 'string' && c.cookie.trim()) return c.cookie.trim();
  const sid = typeof c?.sessionid === 'string' ? c.sessionid.trim() : '';
  if (!sid) throw new AppError('豆包账号缺少 cookie 登录态', 401, 'credential_missing');
  // 只给 sessionid 服务端会判 login invalid；这里仅作兜底，正常路径应导入完整 cookie。
  return `sessionid=${sid}; sessionid_ss=${sid}`;
}

// 单块 SSE 解析：豆包用 `event: X\ndata: {json}\n\n`。
function splitEvents(buf) {
  const out = [];
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const ev = chunk.match(/event:\s*(\S+)/);
    const data = chunk.match(/data:\s*([\s\S]*)$/);
    if (ev) out.push({event: ev[1], data: data ? data[1] : ''});
  }
  return {events: out, rest: buf};
}

// 正文增量在 patch_object=1 的 content_block.block_type=10000.content.text_block.text。
// 10040 的 thinking_block 在 summary 模式下只有阶段标题、没有思考正文，因此不作为 reasoning_content 输出。
function textDelta(payload) {
  let acc = '';
  for (const op of payload.patch_op ?? []) {
    if (op.patch_object !== 1) continue;
    for (const cb of op.patch_value?.content_block ?? []) {
      if (cb.block_type !== 10000) continue;
      const s = cb.content?.text_block?.text;
      if (typeof s === 'string' && s) acc += s;
    }
  }
  return acc;
}

// 10040 的 thinking_block 在 summary 模式下通常只有阶段标题（streaming_title/finish_title），
// 没有思考正文。但「有过思维链、正文却为空」正是推理吃满输出预算的特征，
// 必须采出来当诊断依据与降档重试的判据，否则整轮只能以空正文收场。
// 降档阶梯：high(5) → medium(4) → low(3)。豆包在长上下文 + 高推理档下常把输出预算
// 全烧在思维链上，正文一个字符都不出（10040 有标题、10000 为空）。provider 内部先降一档
// 重试，比把空响应甩给上层判 empty_response 有效得多。已到 low 则返回 null 表示不能再降。
function lowerEffort(effort) {
  const v = String(effort ?? "").trim();
  if (v === "high" || v === "5") return "medium";
  if (v === "medium" || v === "4") return "low";
  return null;
}

function thinkingDelta(payload) {
  let acc = "";
  for (const op of payload.patch_op ?? []) {
    if (op.patch_object !== 1) continue;
    for (const cb of op.patch_value?.content_block ?? []) {
      if (cb.block_type !== 10040) continue;
      const tb = cb.content?.thinking_block ?? {};
      const t = tb.streaming_title || tb.finish_title;
      if (typeof t === "string" && t) acc += t + " ";
    }
  }
  return acc;
}

function openAiChunk(id, model, delta, finish = null) {
  return 'data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{index: 0, delta, finish_reason: finish}],
  }) + '\n\n';
}

function chatHeaders(cookie) {
  return {
    'content-type': 'application/json;charset=UTF-8',
    accept: 'text/event-stream',
    'agw-js-conv': 'str, str',
    origin: 'https://www.doubao.com',
    referer: 'https://www.doubao.com/chat/',
    'user-agent': UA,
    'accept-language': 'zh-CN,zh;q=0.9',
    'x-flow-trace': `04-${uuid()}-${uuid().replace(/-/g, '').slice(0, 16)}-01`,
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    priority: 'u=1, i',
    'sec-ch-ua': '"Chromium";v="147", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    cookie,
  };
}

// 一次补全 → 纯文本。tools 桥必须拿到完整文本才能判定是否成了解析得动的工具调用，
// 所以这条路不边流边判，聚合后再按调用方要的形态回放。
async function pumpText(cookie, meta, deviceId, messages, input, signal, fetcher, effortOverride) {
  const body = doubaoBody(effortOverride ? {...input, messages, reasoning_effort: effortOverride} : {...input, messages}, meta, deviceId);
  const rawBody = JSON.stringify(body);
  const toolCount = Array.isArray(input?.tools) ? input.tools.length : 0;
  let response;
  try {
    response = await fetcher(doubaoUrl(deviceId), {
      method: 'POST',
      redirect: 'error',
      headers: chatHeaders(cookie),
      body: rawBody,
      signal: signal ?? AbortSignal.timeout(180000),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e;
    if (e instanceof AppError) throw e;
    throw new AppError('豆包连接失败: ' + (e?.message ?? e), 502, 'doubao_transport_error');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    console.error('[doubao] non-ok', response.status, 'bodyBytes=' + rawBody.length, 'msgs=' + (input?.messages?.length ?? 0), 'tools=' + toolCount, 'resp=' + text.slice(0, 400));
    throw upstreamError(parsed?.error_code ?? parsed?.code ?? response.status, parsed?.error_msg ?? parsed?.msg ?? text.slice(0, 200), parsed?.extra);
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    throw upstreamError(parsed?.error_code ?? parsed?.code ?? 502, parsed?.error_msg ?? parsed?.msg ?? (text.slice(0, 200) || '豆包返回了非流式响应'), parsed?.extra);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  let raw = '', finished = false, out = '', think = '', seen = {};
  const pull = async () => {
    const {done, value} = await reader.read();
    if (done) { finished = true; return false; }
    raw += decoder.decode(value, {stream: true});
    const {events, rest} = splitEvents(raw);
    raw = rest;
    queue.push(...events);
    return true;
  };
  const nextEvent = async () => {
    while (!queue.length) {
      if (finished) return null;
      if (!await pull()) return null;
    }
    return queue.shift();
  };
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) {
      await reader.cancel().catch(() => {});
      throw new AppError('豆包首包超时', 504, 'doubao_first_event_timeout');
    }
    const ev = await nextEvent();
    if (!ev) {
      await reader.cancel().catch(() => {});
      throw new AppError('豆包在返回首个事件前关闭了连接', 502, 'doubao_empty_stream');
    }
    if (ev.event === 'SSE_HEARTBEAT') break;
    if (ev.event === 'STREAM_ERROR') {
      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch {}
      await reader.cancel().catch(() => {});
      throw upstreamError(parsed?.error_code ?? parsed?.code ?? 'unknown', parsed?.error_msg ?? parsed?.msg ?? '流内错误', parsed?.extra);
    }
    queue.unshift(ev);
    break;
  }
  for (;;) {
    const ev = await nextEvent();
    if (!ev) break;
    if (ev.event === 'STREAM_ERROR') {
      let p = null; try { p = JSON.parse(ev.data); } catch {}
      await reader.cancel().catch(() => {});
      throw upstreamError(p?.error_code ?? 'unknown', p?.error_msg ?? '流内错误', p?.extra);
    }
    if (ev.event === 'STREAM_CHUNK') {
      let payload = null;
      try { payload = JSON.parse(ev.data); } catch { continue; }
      for (const op of payload.patch_op ?? []) {
        if (op.patch_object !== 1) continue;
        for (const cb of op.patch_value?.content_block ?? []) seen[cb.block_type] = (seen[cb.block_type] ?? 0) + 1;
      }
      const d = textDelta(payload);
      if (d) out += d;
      const t = thinkingDelta(payload);
      if (t) think += t;
    }
  }
  if (!out.trim()) console.error('[doubao] empty-text', 'blocks=' + JSON.stringify(seen), 'thinking=' + JSON.stringify(think.trim().slice(0, 200)), 'events=' + (raw ? 1 : 0));
  return {text: out, thinking: think.trim()};
}

// tools 桥：首次 + 1 次重试。次数不能再多——relay 给单个 target 的窗口只有 30s
// （modelRelay.attemptTimeoutMs），豆包单次补全本身要 5~40s，第三次重试必然把整个
// 请求推过窗口，表现为「Same-model supplier delivered no answer」而不是一个有意义的错。
const TOOL_BRIDGE_ATTEMPTS = 2;
// 重试预算：超过这个时长就带着已有文本收尾，把「模型不配合」如实交回调用方。
const TOOL_BRIDGE_BUDGET_MS = 25000;

async function doubaoBridge(c, input, meta, cookie, deviceId, toolList, signal, fetcher) {
  const wantStream = input?.stream !== false;
  const id = 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24);
  let text = '', calls = null, attempts = 0, thinking = '';
  const started = Date.now();
  // 只有在「一个正文字符都没有」时才降档：有正文就说明这次推理没吃满预算，重试只会更慢。
  let effortOverride;
  for (let k = 0; k < TOOL_BRIDGE_ATTEMPTS; k++) {
    if (signal?.aborted) throw signal.reason ?? new AppError('豆包请求已取消', 499, 'aborted');
    if (k > 0 && Date.now() - started > TOOL_BRIDGE_BUDGET_MS) break;
    attempts = k + 1;
    const messages = withToolContract(input.messages, toolContract(toolList, k > 0));
    const pumped = await pumpText(cookie, meta, deviceId, messages, input, signal, fetcher, effortOverride);
    text = pumped.text;
    thinking = pumped.thinking;
    calls = parseToolCalls(text, toolList);
    if (calls || text.trim()) break;
    effortOverride = lowerEffort(effortOverride ?? input?.reasoning_effort ?? meta.defaultEffort);
    if (!effortOverride) break;
  }
  // 空正文一律如实报错：以前这里构造 content:"" 并回 200，上层只能判成笼统的
  // empty_response，日志里看不出是「思维链吃满」还是「服务端什么也没发」。
  if (!calls && !text.trim()) {
    const seen = thinking ? `；豆包只回了思维链标题（${thinking.slice(0, 160)}）` : '；豆包没有返回任何内容块';
    throw new AppError(`豆包未产出正文或工具调用${seen}`, 502, 'doubao_empty_answer');
  }
  const message = calls
    ? {role: 'assistant', content: null, tool_calls: calls}
    : {role: 'assistant', content: text};
  const finish = calls ? 'tool_calls' : 'stop';
  const usage = {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0};

  if (!wantStream) {
    return {
      response: new Response(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: meta.id,
        choices: [{index: 0, message, finish_reason: finish}],
        usage,
        'x-doubao-tool-bridge': {attempts, mode: 'prompt_contract'},
      }), {status: 200, headers: {'content-type': 'application/json; charset=utf-8'}}),
    };
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = s => controller.enqueue(encoder.encode(s));
      send(openAiChunk(id, meta.id, {role: 'assistant', content: ''}));
      if (calls) {
        send('data: ' + JSON.stringify({
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: meta.id,
          choices: [{index: 0, delta: {tool_calls: calls.map((cl, i) => ({index: i, ...cl}))}, finish_reason: null}],
        }) + '\n\n');
      } else if (text) {
        send(openAiChunk(id, meta.id, {content: text}));
      }
      send(openAiChunk(id, meta.id, {}, finish));
      send('data: [DONE]\n\n');
      try { controller.close(); } catch {}
    },
  });
  return {response: new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache'}})};
}

export async function doubaoChat(c, input, signal, {fetcher = fetch} = {}) {
  const meta = doubaoModel(input?.model);
  if (!meta) throw new AppError(`豆包未提供模型 ${input?.model ?? '(空)'}`, 400, 'model_not_found');
  // 先校验推理档位：否则空 messages 会先抛"缺少消息"，把参数错误掩盖成请求体裁剪问题。
  wireEffort(input?.reasoning_effort, meta.defaultEffort);
  // 同理，缺登录态属于 401 凭证问题，不能等 body 组装完才暴露。
  const cookie = doubaoCookie(c);
  const deviceId = typeof c?.deviceId === 'string' && c.deviceId.trim() ? c.deviceId.trim() : DEFAULT_DEVICE_ID;
  // 带 tools 的请求走提示词桥：豆包没有原生工具通道，桥负责把工具定义交给模型并解析它的 JSON 回执。
  const toolList = Array.isArray(input?.tools) && input.tools.length ? input.tools : null;
  if (toolList) return doubaoBridge(c, input, meta, cookie, deviceId, toolList, signal, fetcher);
  const body = doubaoBody(input, meta, deviceId);
  const wantStream = input?.stream !== false;
  const id = 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24);

  let response;
  try {
    response = await fetcher(doubaoUrl(deviceId), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        accept: 'text/event-stream',
        'agw-js-conv': 'str, str',
        origin: 'https://www.doubao.com',
        referer: 'https://www.doubao.com/chat/',
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        // 桌面客户端同源请求会带这组浏览器/追踪头；缺失时服务端风控更容易把请求判成脚本。
        'x-flow-trace': `04-${uuid()}-${uuid().replace(/-/g, '').slice(0, 16)}-01`,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        priority: 'u=1, i',
        'sec-ch-ua': '"Chromium";v="147", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        cookie,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(180000),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e;
    if (e instanceof AppError) throw e;
    throw new AppError('豆包连接失败: ' + (e?.message ?? e), 502, 'doubao_transport_error');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    console.error('[doubao] non-ok', response.status, 'bodyBytes=' + JSON.stringify(body).length, 'msgs=' + (input?.messages?.length ?? 0), 'tools=' + (toolList?.length ?? 0), 'resp=' + text.slice(0, 400));
    throw upstreamError(parsed?.error_code ?? parsed?.code ?? response.status, parsed?.error_msg ?? parsed?.msg ?? text.slice(0, 200), parsed?.extra);
  }

  // 豆包出错时常以 HTTP 200 + application/json 返回错误体；不能把它当空流。
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    console.error('[doubao] non-sse', 'bodyBytes=' + JSON.stringify(body).length, 'msgs=' + (input?.messages?.length ?? 0), 'tools=' + (toolList?.length ?? 0), 'resp=' + text.slice(0, 400));
    throw upstreamError(
      parsed?.error_code ?? parsed?.code ?? 502,
      parsed?.error_msg ?? parsed?.msg ?? (text.slice(0, 200) || '豆包返回了非流式响应'),
      parsed?.extra,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  // 事件泵：所有已解析事件都进同一条队列，绝不因为「首包守卫」而丢弃正文块
  // （豆包常常把整段 SSE 缓冲到一次 read 才吐出，早期版本在这里丢光过全文）。
  const queue = [];
  let raw = '';
  let finished = false;
  const pull = async () => {
    const {done, value} = await reader.read();
    if (done) { finished = true; return false; }
    raw += decoder.decode(value, {stream: true});
    const {events, rest} = splitEvents(raw);
    raw = rest;
    queue.push(...events);
    return true;
  };
  const nextEvent = async () => {
    while (!queue.length) {
      if (finished) return null;
      if (!await pull()) return null;
    }
    return queue.shift();
  };

  // 业务错误常常以 HTTP 200 + STREAM_ERROR 抵达；必须先读到首个可判定事件再决定返回普通响应还是抛错，
  // 否则 router 无法对 710012001/710022002 做换号或冷却。
  const deadline = Date.now() + 30000;
  let first = null;
  for (;;) {
    if (Date.now() > deadline) {
      await reader.cancel().catch(() => {});
      throw new AppError('豆包首包超时', 504, 'doubao_first_event_timeout');
    }
    let ev = await nextEvent();
    while (ev && ev.event === 'SSE_HEARTBEAT') ev = await nextEvent();
    if (!ev) {
      await reader.cancel().catch(() => {});
      throw new AppError('豆包在返回首个事件前关闭了连接', 502, 'doubao_empty_stream');
    }
    if (ev.event === 'STREAM_ERROR') {
      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch {}
      await reader.cancel().catch(() => {});
      throw upstreamError(parsed?.error_code ?? parsed?.code ?? 'unknown', parsed?.error_msg ?? parsed?.msg ?? '流内错误', parsed?.extra);
    }
    first = ev;
    break;
  }
  queue.unshift(first);

  const pump = async (onText, onEnd) => {
    for (;;) {
      const ev = await nextEvent();
      if (!ev) return;
      if (ev.event === 'STREAM_CHUNK') {
        let payload = null;
        try { payload = JSON.parse(ev.data); } catch { continue; }
        const d = textDelta(payload);
        if (d) await onText(d);
      } else if (ev.event === 'STREAM_ERROR') {
        let p = null; try { p = JSON.parse(ev.data); } catch {}
        await reader.cancel().catch(() => {});
        throw upstreamError(p?.error_code ?? 'unknown', p?.error_msg ?? '流内错误', p?.extra);
      } else if (ev.event === 'SSE_REPLY_END') {
        let endType = 0; try { endType = JSON.parse(ev.data).end_type ?? 0; } catch {}
        if (endType === 1) await onEnd();
      }
    }
  };

  if (!wantStream) {
    let text = '';
    await pump(d => { text += d; return Promise.resolve(); }, () => Promise.resolve());
    return {
      response: new Response(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: meta.id,
        choices: [{index: 0, message: {role: 'assistant', content: text}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
      }), {status: 200, headers: {'content-type': 'application/json; charset=utf-8'}}),
    };
  }

  const encoder = new TextEncoder();
  let closed = false;
  let doneSent = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = s => { if (!closed) controller.enqueue(encoder.encode(s)); };
      const finish = () => {
        if (doneSent) return Promise.resolve();
        doneSent = true;
        send(openAiChunk(id, meta.id, {}, 'stop'));
        send('data: [DONE]\n\n');
        return Promise.resolve();
      };
      try {
        send(openAiChunk(id, meta.id, {role: 'assistant', content: ''}));
        await pump(d => { send(openAiChunk(id, meta.id, {content: d})); return Promise.resolve(); }, finish);
        // 服务端未发 end_type=1 时补一个收尾，保证客户端不会挂起等 [DONE]；已发过则不重复。
        if (!doneSent) await finish();
      } catch (e) {
        send('data: ' + JSON.stringify({error: {message: e?.message ?? '豆包流中断', type: e?.code ?? 'doubao_stream_error'}}) + '\n\n');
      } finally {
        closed = true;
        try { controller.close(); } catch {}
        reader.cancel().catch(() => {});
      }
    },
    cancel() { closed = true; reader.cancel().catch(() => {}); },
  });
  return {response: new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache'}})};
}

// ---- alice 侧读接口（订阅额度 / 活动进度）----
// 与 /chat/completion 的差异（2026-11-13 实测）：alice 系列要求 Referer 为客户端私有 scheme、
// UA 末尾带 SamanthaDoubao 产品后缀，并且必须用完整 cookie 罐（缺 multi_sids / sid_ucp_v1 / passport_csrf_token
// 会一律返回 710012001 login invalid，而 /chat/completion 用同一罐里的 sessionid 仍可用）。
const ALICE_BASE = 'https://www.doubao.com';
const CLIENT_UA = UA + ' SamanthaDoubao/2.35.12';
const CAMPAIGN_GROUP_CODE = 'pc_incentive_task_mvp_v3';

function aliceQuery(deviceId) {
  return new URLSearchParams({
    aid: String(AID), device_id: deviceId, device_platform: 'web', doubao_device_platform: 'desktop',
    channel: 'win', client_platform: 'pc_client', pc_version: '2.35.8', doubao_pc_version: '2.35.8',
    samantha_web: '1', region: 'CN', version_code: '20800', real_aid: String(AID), language: 'zh',
    real_region: 'CN', sys_region: 'CN', use_olympus: '0',
  }).toString();
}

async function alicePost(fetcher, path, body, cookie, deviceId) {
  const res = await fetcher(ALICE_BASE + path + '?' + aliceQuery(deviceId), {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'agw-js-conv': 'str',
      referer: 'chrome://doubao-chat/',
      'user-agent': CLIENT_UA,
      cookie,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new AppError(`豆包 ${path} 返回非 JSON（HTTP ${res.status}）`, res.status === 200 ? 502 : res.status, 'doubao_upstream_error'); }
  if (Number(json.code) !== 0) throw upstreamError(json.code, json.msg || json.message, json.error);
  return json.data;
}

function parseAmount(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function quotaWindows(section) {
  const out = [];
  for (const g of section?.window_limit_groups ?? []) {
    for (const w of g.window_limits ?? []) {
      const total = parseAmount(w.total_amount), used = parseAmount(w.used_amount);
      out.push({
        group: g.feature_group ?? '',
        name: g.feature_group_name ?? g.feature_group ?? '额度',
        total, used,
        remaining: total !== null && used !== null ? Math.max(0, total - used) : null,
        expiresAt: Number.isFinite(w.end_time) && w.end_time > 0 ? new Date(w.end_time).toISOString() : null,
      });
    }
  }
  return out;
}

// 只读：不触发任何领取动作。额度来自 subscription/quota/summary，活动进度来自 ug/campaign/v3/detail。
export async function doubaoHealth(c, { fetcher = fetch } = {}) {
  const deviceId = typeof c?.deviceId === 'string' && c.deviceId.trim() ? c.deviceId.trim() : DEFAULT_DEVICE_ID;
  const cookie = doubaoCookie(c);
  const [subscription, campaign, signIns] = await Promise.all([
    alicePost(fetcher, '/alice/commerce/sale/subscription/quota/summary/', { product_line: 'membership' }, cookie, deviceId),
    alicePost(fetcher, '/alice/ug/campaign/v3/detail/', { campaign_group_code: CAMPAIGN_GROUP_CODE }, cookie, deviceId).catch(() => null),
    readSignIns(fetcher, cookie, deviceId).catch(() => ({day: dayIn(new Date(), 'Asia/Shanghai'), today: null, todayCredits: 0, history: []})),
  ]);
  const quotas = [...quotaWindows(subscription?.incentive_quota_section), ...quotaWindows(subscription?.window_limit_section)];
  const remaining = quotas.reduce((n, q) => (q.remaining !== null ? n + q.remaining : n), 0);
  const sub = subscription?.current_subscription ?? {};
  const campaignView = campaign ? {
    code: campaign.campaign_code ?? CAMPAIGN_GROUP_CODE,
    points: Number(campaign.progress?.total_amount ?? 0) || 0,
    milestones: (campaign.milestones ?? []).map(m => ({
      code: m.campaign_code, threshold: m.milestone_threshold,
      reward: m.reward_summaries?.[0]?.reward_amount ?? null,
      title: m.title ?? null, status: m.task_status ?? null,
    })),
    tasks: (campaign.tasks ?? []).map(t => ({ code: t.campaign_code, type: t.campaign_type, title: t.title ?? null })),
  } : null;
  return {
    status: 'authenticated',
    subscription: {
      name: sub.display?.short_name ?? sub.display?.product_name ?? null,
      skuKey: sub.sku_key ?? null,
      endTime: Number.isFinite(sub.end_time) && sub.end_time > 0 ? new Date(sub.end_time).toISOString() : null,
    },
    quotas,
    remaining,
    campaign: campaignView,
    checkedIn: signIns.today !== null,
    signIn: {
      day: signIns.today ?? signIns.day,
      credits: signIns.todayCredits,
      sampleDays: signIns.history.length,
      lastAt: signIns.history[0]?.at ?? null,
    },
  };
}

// ── 每日签到 ────────────────────────────────────────────────────────────────
// 签到不是 campaign landing 接口（那套 scene 对任意值都返回空壳，不可枚举）。
// 真实来源是额度流水：POST /alice/ug/campaign/quota/records/ 里 task_code === 'daily_signin'
// 的记录，每条 +200 POINT；领取动作是 POST /alice/ug/campaign/item/reward/claim/
// {"campaign_item_code":"daily_signin"}。
// 该领取接口是幂等的：今天已领也会回「领取成功」，所以结算只认流水是否新增。
const SIGNIN_TASK_CODE = 'daily_signin';
const SIGNIN_DEFAULT_CREDITS = 200;

async function readSignIns(fetcher, cookie, deviceId, {timezone = 'Asia/Shanghai'} = {}) {
  const data = await alicePost(fetcher, '/alice/ug/campaign/quota/records/', {cursor: '', page_size: 20}, cookie, deviceId);
  const records = Array.isArray(data?.records) ? data.records : [];
  const day = dayIn(new Date(), timezone);
  const history = [];
  let today = null, todayCredits = 0;
  for (const r of records) {
    if (r?.task_code !== SIGNIN_TASK_CODE) continue;
    const ms = Number(r.create_time_ms);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const at = new Date(ms);
    const item = {day: dayIn(at, timezone), amount: parseAmount(r.amount) ?? 0, at: at.toISOString()};
    history.push(item);
    if (item.day === day && today === null) { today = item.day; todayCredits = item.amount; }
  }
  history.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {day, today, todayCredits, history};
}

// 只读：判断今天是否已签。返回 claims.mjs 需要的 {known,active,claimed,credits,details}。
export async function doubaoStatus(c, {fetcher = fetch, timezone = 'Asia/Shanghai'} = {}) {
  const deviceId = typeof c?.deviceId === 'string' && c.deviceId.trim() ? c.deviceId.trim() : DEFAULT_DEVICE_ID;
  const signIns = await readSignIns(fetcher, doubaoCookie(c), deviceId, {timezone});
  return {
    known: true,
    active: true,
    claimed: signIns.today !== null,
    credits: signIns.todayCredits,
    day: signIns.today ?? signIns.day,
    details: {
      day: signIns.today ?? signIns.day,
      source: '/alice/ug/campaign/quota/records/',
      taskCode: SIGNIN_TASK_CODE,
      creditsPerDay: signIns.todayCredits || SIGNIN_DEFAULT_CREDITS,
      sampleDays: signIns.history.length,
      history: signIns.history.slice(0, 8),
      lastSignInAt: signIns.history[0]?.at ?? null,
    },
  };
}

// 领取。已签则不发请求；签到以「流水是否新增」结算，不以接口回执为准。
export async function doubaoClaim(c, {fetcher = fetch, timezone = 'Asia/Shanghai'} = {}) {
  const before = await doubaoStatus(c, {fetcher, timezone});
  if (before.claimed) {
    return {claimed: true, submitted: false, alreadyClaimed: true, mutation: false, credits: before.credits, details: before.details};
  }
  const deviceId = typeof c?.deviceId === 'string' && c.deviceId.trim() ? c.deviceId.trim() : DEFAULT_DEVICE_ID;
  const cookie = doubaoCookie(c);
  const data = await alicePost(fetcher, '/alice/ug/campaign/item/reward/claim/', {campaign_item_code: SIGNIN_TASK_CODE}, cookie, deviceId);
  const biz = data?.biz_error ?? {};
  if (Number(biz.code ?? 0) !== 0) {
    throw new AppError(`豆包签到被拒：${biz.message ?? 'unknown'}`, 409, 'doubao_claim_rejected');
  }
  // 回执说成功不算数：接口对「今天已领」同样回成功。用流水复验（0/400/1200ms）。
  let after = null;
  for (const delay of [0, 400, 1200]) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try { after = await doubaoStatus(c, {fetcher, timezone}); } catch { continue; }
    if (after.claimed) break;
  }
  const granted = after?.claimed === true;
  return {
    claimed: granted,
    submitted: true,
    alreadyClaimed: false,
    mutation: true,
    credits: granted ? after.credits || SIGNIN_DEFAULT_CREDITS : 0,
    details: {
      ...(after?.details ?? {}),
      rewardToast: biz.message ?? null,
      verifiedBy: granted ? 'quota_records_after_claim' : 'quota_records_unchanged',
    },
  };
}
