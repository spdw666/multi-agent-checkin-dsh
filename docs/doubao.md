# 豆包工作模式 adapter

`doubao` 走豆包桌面客户端「工作」模式的同源协议，不使用任何公开 API Key：凭据是一份浏览器 cookie 罐，端点是 `POST https://www.doubao.com/chat/completion`。实测基线 2026-11-13（豆包 2.25.10 / Chromium 147 / `pc_version=2.35.8`）。

## 凭据与端点形状

| 项 | 值 | 说明 |
|---|---|---|
| 端点 | `https://www.doubao.com/chat/completion` | 只此一个推理入口 |
| `aid` | `582478` | **桌面客户端**的 aid；网页版的 `497858` 会被判「访问频繁」 |
| `bot_id` | `7338286299411103781` | 工作模式固定 bot |
| `device_id` | 默认 `810790401142921` | 可在账号凭据里覆盖 |
| 签名 | 不需要 `a_bogus` / `msToken` | 缺的是同源浏览器头，不是签名 |

`doubaoCookie(c)` 优先用凭据里的完整 `cookie` 字段；只给 `sessionid` 时兜底拼成 `sessionid=<sid>; sessionid_ss=<sid>`，但服务端会判 login invalid，**正常路径必须导入完整 cookie**。

请求头必须带齐桌面客户端的同源标记，否则风控更容易把请求判成脚本：`origin` / `referer` / `user-agent`（Chrome 147）/ `agw-js-conv: str, str` / `x-flow-trace`（每次随机 `04-<uuid>-<hex16>-01`）/ `sec-ch-ua*` / `sec-fetch-*`。

## 模型目录

`DOUBAO_MODELS` 共 10 条，`key` 是客户端写进 `localStorage.mode_select_value` 的真实值——豆包自家模型用数字，第三方用 `person-*` 全名。请求时这个 key 必须在三处同步（`model_config.model_item_key`、`aggregate_params.model_item_key`、`conversation_init_option` 内的 `model_item_key`），任一处不同步都会走错模型。

| id | key | 说明 |
|---|---|---|
| `auto` | `9` | 自动 |
| `doubao-2.1-lite` | `seed-lite-7b` | |
| `doubao-2.1-pro` | `5` | |
| `deepseek-v4.1-flash` | `person-deepseek-v4-1-flash-261017` | |
| `kimi-k3.1-pro` | `person-kimi-k3-1-pro-261111` | |
| `kimi-k3.1-pro-highspeed` | `person-kimi-k3-1-pro-highspeed-261111` | |
| `kimi-k3` | `person-kimi-k3-261111` | |
| `glm-5.3` | `person-glm-5-3-261111` | 默认档 high |
| `glm-5.3-flash` | `person-glm-5-3-flash-261111` | **`tools:false`**，见下 |
| `deepseek-v4-pro` | `person-deepseek-v4-pro-ga-260813` | 默认档 high |

推理档位只有低/中/高三级，线值分别是 `3` / `4` / `5`（`option.reasoning_effort`）。`wireEffort()` 幂等接受 `low|medium|high` 与 `3|4|5`：relay 跨目标转发时会先把档位换成线值再交给 provider，只认字符串会让「直连能过、走 relay 报不支持」这种分裂出现。`minimal` / `xhigh` 没有对应档，直接报 `reasoning_effort_not_supported`，不静默降级。

## 上下文窗口为什么声明 600000

这是本项目里唯一一处刻意偏离官方数值的声明，理由写在 `doubaoModels()` 的注释里，值得单独说明。

豆包客户端在真实请求里带 `model_extra_params: {memory_profile:'300k_230', total_window_size:'300000'}`，**文本窗口就是 300000**。但 DSH 侧有两个不同的算法都读这个声明：

1. 模型切换压缩用 `contextWindow - maxTokens - headroom`。早先保守写 200000，算出 threshold=118080，一个 120k 的会话永远切不过来，报 `MODEL_SWITCH_COMPACTION_FAILED`。
2. preflight 用 `contextWindow - maxTokens` 当可用输入窗口。写 300000 得 283616，而它统计的 token 里**包含全部工具 JSON Schema**——475 个工具约 255504 tokens。豆包走提示词桥，Schema 全文根本不进 body，这部分开销对豆包不存在，于是会话涨到 291311 tokens 就被永久拒发（实测 2026-11-13 21:52）。

`600000 ≈ 300K 文本窗口 + 约 256K 工具 Schema 开销 + 余量`，反映的是调用方视角的真实可用能力。文本量本身另有硬限：`trimToBudget(blocks, MAX_TEXT_CHARS=280000)` 按字符裁剪，不会撑爆豆包。声明来源标注为 `client_model_extra_params_total_window_size`，`maxTokens` 标注 `doubao_client_work_mode_unverified`，没有伪装成官方精确数字。

## 消息体：整段对话压成一条 user

豆包按 `conversation_id` 承载历史；网关每次新建会话，只能把整段 OpenAI messages 序列化进单条 content，用 `<|im_start|>role\n…<|im_end|>` 分段。这是实测可用的无状态形态。

两处必须降级，否则带工具历史的对话第二轮就丢内容：

- `role: 'tool'` → `[调用方程序返回的结果 / <名称>] <正文>`。写成原生 tool 角色会被服务端忽略。
- 历史里的 `assistant.tool_calls` → 叙述句 `（我调用了 <名称>，参数 {...}）`。**绝不能写成契约同形 JSON**：实测写成 `{"tool_calls":[...]}` 时模型会把它当成自己的执行意图，转头去调豆包客户端的本地文件工具，正文全空，整轮只能判 `empty_response`。

`MAX_TEXT_CHARS=280000` 字符是单条 `text_block` 的安全上限（不是字节）：实测 20 万字符可过、57 万被服务端判 `710020202 common invalid param`——是读 body 时即拒，不是超时。超限时保留 system 与最近若干轮，从中间丢弃并插一条 `[已省略 N 条较早消息以适配豆包单条文本上限]`。

## 工具：提示词桥，不是原生通道

豆包没有 OpenAI 式 `tools` 通道。它的 function calling 是前端扩展注册、服务端触发的私有链路（`window.neotix` + `saman_neotix_function_callback`），反代侧无法注册函数，拿不到原生通道。因此带 `tools` 的请求走 `doubaoBridge`：把工具定义写进 user 文本，解析模型回复里的裸 JSON 回执，再还原成标准 `tool_calls`。

契约写法有三条边界，缺一不可（`toolContract()`）：

1. **必须写在 user 消息里**。写进 system 会被 GLM / DeepSeek-V4-Pro 判成提示词注入而拒绝。
2. 措辞要说「我的程序会读取并执行你回复里的工具调用」，不能声称「你拥有这个工具」，否则模型会答"环境里没有"。
3. 明说「不要输出 Markdown 代码块，直接给裸 JSON」，并声明模型没有本地文件/命令/环境能力——否则它会去调豆包客户端的本地工具。

工具清单只给**名称与参数名**（`audit_add(a, b): 把两个数字相加`），不给完整 JSON Schema。原因是 DSH 一次会递上几百个工具（实测 351 个），原实现把每个工具的 schema 全写进契约，光这一项就撑到十几万字符，豆包直接判 `710020202`。`TOOL_CONTRACT_MAX_SPECS = 32` 之后的工具只给数量与前 8 个示例名——曾把剩余工具名全列出（实测 461 个、近万字符），结果契约被稀释到模型只记住「本地工具」而忘记输出 JSON 回执。

`parseToolCalls()` 不用全文 `JSON.parse`（模型常带前后废话），而是找第一个括号配对的完整对象，并只接受目录里已知的工具名。未命中就返回 null，按纯文本处理。

逐模型 `tools` 是实测结果：9 个模型稳定回 `tool_calls`，**只有 GLM 5.3 Flash 坚持"我的接口不是这种约定"，四种措辞都救不回来**，故单独标 `false`，目录里如实声明 `toolsSource: 'model_refuses_contract'`。

## 空正文与降档重试

豆包在长上下文 + 高推理档下常把输出预算全烧在思维链上：`block_type=10040` 有标题、`10000` 一个字符都没有。正文增量只在 `patch_op[patch_object=1].patch_value.content_block[block_type=10000].content.text_block.text`；`10040` 的 `thinking_block` 在 summary 模式下只有阶段标题（`streaming_title` / `finish_title`），没有思考正文，因此不作为 `reasoning_content` 输出，但**必须采出来当诊断依据**。

`doubaoBridge` 的降档阶梯是 `high(5) → medium(4) → low(3)`：只有在「一个正文字符都没有」时才降一档重试；有正文就说明这次推理没吃满预算，重试只会更慢。`TOOL_BRIDGE_ATTEMPTS=2` 上限不能加——relay 给单个 target 的窗口只有 30s，豆包单次补全本身要 5~40s，第三次必然把请求推过窗口，表现为「Same-model supplier delivered no answer」而不是一个有意义的错误。`TOOL_BRIDGE_BUDGET_MS=25000` 之后带着已有文本收尾。

到 low 仍无正文则如实报 `doubao_empty_answer` 502，并在 message 里附上采到的思维链标题。以前这里构造 `content:""` 回 200，上层只能判成笼统的 `empty_response`，日志里看不出是「思维链吃满」还是「服务端什么也没发」。

流式路径同样有首包守卫：先读到首个可判定事件再决定返回普通响应还是抛错，否则 router 无法对 `710012001` / `710022002` 做换号或冷却。所有已解析事件进同一条队列，绝不因首包守卫丢弃正文块——豆包常把整段 SSE 缓冲到一次 read 才吐出，早期版本在这里丢光过全文。服务端未发 `end_type=1` 时补一个收尾，保证客户端不会挂起等 `[DONE]`；已发过则不重复。

## 错误码映射

| 上游码 | 网关状态 | 含义 |
|---|---|---|
| `710012001` / `710012000` | 401 | 登录态失效 |
| `710022002` | 429 | 账号级临时风控（"当前服务访问频繁"） |
| `710022004` | 429 | 需要人机验证 |
| `710022013` | 429 | 账号级临时风控（"系统错误"） |
| `710020202` | 400 | 参数/体积非法（body 过大即此码） |
| 其它 | 502 | 上游错误 |

`710022002` / `710022004` / `710022013` 实测是同一族账号级频控：连续请求后开始返回，表现为 HTTP 200 + `SSE_HEARTBEAT` / `STREAM_ERROR` / `SSE_REPLY_END`，300~400ms 即拒，冷却后自行恢复。三个必须**同样映射成 429**：router 的 `fallbackStatuses` 只认 408/429/500/502/503/504，早先把 `710022004` 写成 403 会让这类可重试的限流被当成终端错误直接甩给客户端（DSH 里表现为 `gateway_terminal_error` HTTP 400，用户点了重发还是立刻失败）。

这一族都标 `rateLimitKind:'long_window'`、`rateLimitRetryable:false`，由 `model-relay` 给 900 秒长冷却。响应里没有 `Retry-After`，30 秒短冷却只会让客户端反复重撞，越撞越难恢复——`710022004` 更要人工过验证码，30 秒绝无可能自愈。`710022004` 的错误文案会明确写出「请打开豆包客户端完成验证码后重试，网关无法代过」。

## 额度与每日签到

只读接口与推理接口不是同一套要求：`alice` 系列必须把 `Referer` 设成客户端私有 scheme `chrome://doubao-chat/`、UA 末尾带 `SamanthaDoubao/2.35.12` 产品后缀，并且必须用**完整 cookie 罐**（缺 `multi_sids` / `sid_ucp_v1` / `passport_csrf_token` 会一律返回 `710012001`，而 `/chat/completion` 用同一罐里的 `sessionid` 仍可用）。

- `doubaoHealth()` 只读，并发拉三个接口：`/alice/commerce/sale/subscription/quota/summary/`（`product_line=membership`，额度）、`/alice/ug/campaign/v3/detail/`（`campaign_group_code=pc_incentive_task_mvp_v3`，活动进度，失败则 `null`）、以及签到流水。额度取 `incentive_quota_section` + `window_limit_section` 的 `window_limit_groups[].window_limits[]`，`remaining = total - used`，`expiresAt` 来自 `end_time`。
- 签到**不是** campaign landing 接口——那套 `scene` 对任意值都返回空壳，不可枚举。真实来源是额度流水：`POST /alice/ug/campaign/quota/records/` 里 `task_code === 'daily_signin'` 的记录，每条 +200 POINT。
- 领取是 `POST /alice/ug/campaign/item/reward/claim/`，body `{"campaign_item_code":"daily_signin"}`。**该接口是幂等的：今天已领也会回「领取成功」，所以结算只认流水是否新增**。`doubaoClaim()` 领取后在 0 / 400 / 1200ms 三次复验 `doubaoStatus()`，`verifiedBy` 如实写 `quota_records_after_claim` 或 `quota_records_unchanged`，回执文案放进 `rewardToast` 仅作展示。

`doubaoStatus()` 返回 `claims.mjs` 需要的 `{known, active, claimed, credits, day, details}`；`details` 带 `source`、`taskCode`、`creditsPerDay`、`sampleDays`、最近 8 条 `history`、`lastSignInAt`，便于排查"为什么今天判成已签"。

## 与其他 provider 的接线点

| 位置 | 挂点 |
|---|---|
| `src/config.mjs` | `allowedPlatforms` 末尾加 `'doubao'` |
| `src/platforms.mjs` | models 分支 `u.kind==='doubao'`、health / status / claim / chat 四处按 `platform==='doubao'` 分派 |
| `src/balances.mjs` | doubao 分支：`h.quotas` → 分组明细，`unit='额度'`，note 拼订阅名 + 活动赠送额度 + 已用 pct + 每日签到 credits |
| `src/service.mjs` | 首行 `import './net-env.mjs';`（见下） |

## 网络：为什么需要 net-env

2026-11-13 实测到一次 `504 provider_timeout` / `UND_ERR_CONNECT_TIMEOUT at 10.37s`：系统代理把 `*.workbuddy.cn` / `*.codebuddy.cn` / `copilot.tencent.com` 这些本该直连的域名也接了进来。`src/net-env.mjs` 在 `NODE_USE_ENV_PROXY` 非空时把这些域名补进 `NO_PROXY`，避免代理链路把国内直连站点拖死。只在 `service.mjs` 首行 import 一次，保证它在任何 `fetch` 之前执行。

## 边界

- 这是**反代适配**，不是官方 API。cookie 失效、风控、人机验证、协议变更都会让整条链路失效，网关只负责如实报错，不绕过验证码。
- 目录里 `tools:true` 指提示词桥能稳定回 `tool_calls`，不等于所有复杂客户端 Schema 都兼容；`glm-5.3-flash` 明确不支持。
- `contextWindow: 600000` 是调用方视角的声明值，不是官方窗口；豆包自身文本窗口仍是 300000，由 `trimToBudget` 按字符硬限。
- 未做多模态。`multimodal: false` 是如实声明。
