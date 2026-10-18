# 管理契约：鉴权、端点与请求边界

本文描述 AI网关 HTTP 服务的对外契约，依据 `src/server.mjs`、`src/model-audit.mjs`、`src/claims.mjs`、`src/balances.mjs`、`src/model-directory.mjs` 的实际实装。默认监听 `http://127.0.0.1:19421`（`server.host` / `server.port`）。管理 API 面向自建前端，模型 API 面向调用端，两者互不替代。

## 1. 鉴权：apiKey 与 adminKey 严格分离

| 入口 | 所需密钥 | 头 |
|---|---|---|
| `GET /health` | 无 | — |
| `/v1/*` | `apiKey` | `Authorization: Bearer <apiKey>` |
| `/admin/*` | `adminKey` | `Authorization: Bearer <adminKey>` |

- 两把密钥在 `data/api-keys.json` 中自动生成，各自至少 24 字符；`apiKey` 用于推理，`adminKey` 只用于管理操作。**管理面不接受 `apiKey`，模型面不接受 `adminKey`**，两者不能互相顶替。
- 密钥比较为定长 `timingSafeEqual`；缺少或格式不符的 `Authorization` 一律 `401 authentication_error`。
- 管理面在 `startServer` 传入 `admin:false` 时不挂载（DSH worker shim 场景），任何 `/admin/*` 返回 `404 not_found`，不能凭猜测路径探测。
- 公开仓库包含 Windows 原生桌面源码与 `desktop/build.ps1`；CLI、原生界面和自建前端共用管理契约。个人 EXE、runtime、登录态和数据库不随源码分发。密钥保留在本地，不写入 URL、日志或聊天。

## 2. Host 与 Origin 防护

每个请求先做两级同源校验，失败即拒绝，不进入业务分支：

- **Origin**：请求带 `Origin` 且不等于 `http://<Host>` 时返回 `403 origin_rejected`。浏览器页面即使持有被泄露的环境头也无法跨源调用本网关。
- **Host**：`Host` 必须等于服务自身 `baseUrl` 的 host，或 `localhost:<实际端口>`，否则返回 `403 host_rejected`。用其他主机名（含 IP 变体、反代域名）访问会被拒绝。
- 响应统一带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`，JSON 与静态资源均 `Cache-Control: no-store`；不返回 CORS 许可头，跨源读取不被鼓励也不被支持。界面资源额外带严格 CSP（`default-src 'self'`、`frame-ancestors 'none'`）。

## 3. 请求体上限：聊天 64 MiB，普通管理 4 MiB

- **聊天**：`POST /v1/chat/completions` 使用 `server.bodyLimitBytes`，默认 `67108864`（64 MiB），可配置范围 `1024`–`67108864`，越界为 `400 invalid_config`。这是**字节上限，不是模型上下文上限**；超限返回 `413 body_too_large`，错误消息包含实际字节数与上限，并明确说明**消息历史未被裁剪**——网关不静默截断，长会话由调用端做上下文压缩。上游自身报的 context length / token limit 属另一层限制。
- **普通管理**：除下述账号导入包装例外外，`/admin/*` 请求体固定上限 `4194304`（4 MiB），**不随聊天上限一起放宽**。`POST /admin/model-tests` 允许空 body（按默认 `scope` 处理）。
- **WB 账号导入**：`/admin/workbuddy/accounts/import/preview`、`/commit` 与兼容 `/import` 的 HTTP 正文为 `16777216`（16 MiB）包装上限，仅容纳 base64 与 JSON 转义；解码后的输入文件合计仍为 4 MiB。单 JSON、解压总量、文件数与账号数另行限制，见第 13 节。
- 非 JSON 体返回 `400 invalid_request_error`；`Content-Length` 已超限时直接拒绝，不读取正文。

## 4. 每路由 HTTP 截止时间

- `gatewayRequestTimeout(policy, routeId)`：`server.modelRequestTimeouts` 中若存在与**路由 ID 精确相等**的键，取该值，否则回退 `server.requestTimeoutMs`（默认 `180000`）。改名路由必须同步改键，否则静默回落到通用上限。
- 配置校验：`server.requestTimeoutMs` 与每个超时值都必须是 `1000`–`1200000` 的整数毫秒；映射最多 500 个键、键长 ≤ 512，非整数或越界一律 `400 invalid_config`，不会静默取默认值。
- 该截止时间只作用于本网关的 HTTP 请求；上游 SDK 自身超时与调用端取消相互独立。
- 服务端另设传输层参数：`headersTimeout 15000`、`requestTimeout 30000`、`keepAliveTimeout 5000`（Node 层，与模型截止时间不是同一概念）。

合法配置示例（键为 `/v1/models` 返回的路由 ID，原样包含斜杠）：

```json
{"server":{"requestTimeoutMs":180000,"modelRequestTimeouts":{"nvidia-main/moonshotai/kimi-k3":600000,"nvidia-main/deepseek-ai/deepseek-v4.1-flash":600000}}}
```

600000 是**有界等待，不是上游成功保证**：超时/断连仍按失败或待复测记录，官方 `429` / `503` / `504` 与用户取消结果原样保留。

## 5. 模型 API（`apiKey`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/models` | OpenAI 风格清单，`data[]` 每项为已启用路由，含路由 ID 与 `capabilities`（如 `tools` / `multimodal`）。停用路由不出现在此列表。 |
| `POST` | `/v1/chat/completions` | 普通与 SSE 共用映射层；`stream:true` 时按 `targets` 顺序回退。 |

- SSE 以 `data: {...}` 分帧、`data: [DONE]` 结束；开始输出后发生错误改为发送 `event: error`，不会重放整段请求（避免重复工具动作）。
- 请求头 `Retry-After` 仅在 `429` 且上游给出秒数时出现。
- 客户端断开时上游请求被中止，记账状态为 `cancelled`。

## 6. 管理 API（`adminKey`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | `{status,service,version}`，无需鉴权 |
| `GET` | `/admin/state` | 运行状态：`baseUrl`、`keysFile`、`configFile`、排程计划、上次运行；**不回显任何密钥** |
| `GET` / `PUT` | `/admin/config` | 读取 / 保存配置。`PUT` 改 `dataDir` 返回 `409 restart_required`；响应含 `saved` 与 `serverRestartRequired` |
| `GET` | `/admin/models` | 与 `/v1/models` 同源的路由清单 |
| `GET` | `/admin/model-directory` | 目录发现结果（`count`、`providers[].models[].imported` 等）；`?refresh=1` 强制刷新 |
| `POST` | `/admin/model-import` | 导入/停用路由，`{items:[{upstreamId,model,enabled}]}` |
| `POST` | `/admin/model-export` | 按 `{routeIds:[...]}` 精确取消导入，保留 targets/历史；不是文件下载 |
| `GET` / `POST` | `/admin/model-tests` | 模型体检，见第 7 节 |
| `GET` | `/admin/balances` | 账号余额，见第 8 节；`?refresh=1` 绕过 60 秒缓存 |
| `GET` | `/admin/usage` | 调用用量，见第 9 节 |
| `POST` | `/admin/doctor` | 逐个启用账号检查本机凭据形状与身份 |
| `POST` | `/admin/health` | 查询单个账号的平台侧状态：`{accountId}` |
| `POST` | `/admin/claim` | 领取/签到：带 `accountId` 跑单账号，否则跑全部启用账号 |
| `POST` | `/admin/catalog` | 指定 `{upstreamId}` 强制刷新该上游目录 |
| `POST` | `/admin/rebind` | 明确重绑账号身份（换账号后使用），随后返回 doctor 结果 |
| `GET` | `/admin/records` | 领取/签到记录，支持 `limit` / `accountId` / `platform` |
| `POST` | `/admin/workbuddy/capture` | 保存当前 WorkBuddy 账号快照 |
| `GET` | `/admin/workbuddy/pools` | 各 WorkBuddy 路由的账号池状态 |
| `GET` | `/admin/workbuddy/summary` | 全部已保存 WB 账号、已知积分汇总、去重模型与设置；包含停用/封禁/认证失效账号 |
| `GET` | `/admin/workbuddy/accounts/:id/details` | 单账号完整身份、凭据有效期、封禁证据、全部积分包、任务与回执；`?refresh=true` 刷新 |
| `POST` | `/admin/workbuddy/accounts/:id/mark-status` | `{status:"banned"\|"clear",confirm:true,reason?}` 保存或清除本机封禁标记，不冒充官方状态 |
| `POST` | `/admin/workbuddy/accounts/:id/switch` | 切换客户端及后续网关请求；`switchClient:false` 只切网关 |
| `POST` | `/admin/workbuddy/login/start` | 发起独立官方授权 |
| `POST` | `/admin/workbuddy/login/poll` | 查询授权并保存独立账号 |
| `POST` | `/admin/workbuddy/login/cancel` | 取消本次登录等待 |
| `POST` | `/admin/workbuddy/settings` | 保存 `autoTasks` / `autoMigrateSessions` 布尔设置 |
| `POST` | `/admin/workbuddy/sessions/merge` | 加法复制本机 JSONL/SQLite 会话，保留来源与备份 |
| `GET` / `POST` | `/admin/workbuddy/tasks` | 完整任务查询及 `query/accept/run/claim` 动作；真实执行器未注册者保留待操作 |
| `POST` | `/admin/workbuddy/pool/normalize` | 建立同版本同型号 WB 池，保留旧模型 ID、默认与停用项 |
| `DELETE` | `/admin/accounts/:id` | `{confirm:true}` 删除账号并清理引用，保留聊天、历史与私密备份 |
| `POST` | `/admin/workbuddy/pool` | 配置同模型备用账号池 |
| `POST` | `/admin/workbuddy/switch` | 指定下一请求使用的账号（不迁移正在输出的请求） |
| `POST` | `/admin/restart-dsh` | 重启本机 DSH |
| `POST` | `/admin/shutdown` | 请求停止服务（仅当宿主注册了关闭回调时可用） |

未知管理端点返回 `404 not_found`；错误体统一为：

```json
{"error":{"message":"...","type":"<code>","code":"<code>","upstreamStatus":400}}
```

`upstreamStatus` 仅在保留了上游原始状态码时出现。**已知的上游并发拒绝可能被归一化为 `429`，此时 `upstreamStatus` 保留原始 `400`；任意上游错误不会被重新分类**。

## 7. 模型体检（`POST /admin/model-tests`）

目录用于发现，体检用于验证，导入才决定是否发布，三者不混用。体检**真实请求上游**，可能消耗额度。

```json
{"scope":"selected","routeIds":["workbuddy/deepseek-v4.1-flash"]}
```

### 7.1 scope 精确语义

| scope | 目标集合 |
|---|---|
| `all`（默认） | 所有已启用上游的实时目录条目 |
| `imported` | 已启用路由的**实际目标**：含账号池候选、按 `upstreamId+model` 去重、忽略冷却；合并同模型在多条路由下的 `routeIds` |
| `retry` | 上次报告中 `failed` / `partial` / `uncertain` / `unavailable` 且上游与账号仍启用的条目 |
| `selected` | 显式 `routeIds`，仅接受**已启用**路由；路由必须至少有一个活动目标 |
| `models` | 显式 `items:[{upstreamId,model}]`，精确核验已启用上游中的所选型号，**包括未导入/路由未启用的模型**；不先导入，不改导入开关 |

校验失败一律 `400`：非对象或数组 body、未知 `scope` 为 `invalid_audit_scope`；`routeIds` 为空数组、含空白字符串、路由不存在/已停用/无活动目标为 `invalid_audit_selection`。

`scope:models` 的 `items` 必须是 **1–500** 条数组；每条需包含非空字符串 `upstreamId` 与 `model`。上游不存在/已停用、对应账号已停用、字段类型错误、空白 ID 或重复的 `upstreamId+model` 均返回 `400 invalid_audit_selection`；整个选择先校验，不启动部分任务，不改变已有体检状态。ID 按原值精确使用。模型是否仍在目录中由随后**刷新实时目录**决定；缺失条目记为 `unavailable`，不把“能填一个 ID”当成可调用。

```json
{"scope":"models","items":[{"upstreamId":"opencode-SAMPLE","model":"space-bunny-free"}]}
```

示例上游 ID 需替换成当前配置的真实 ID；`model` 必须来自当前目录。`items` 与 `routeIds` 分属各自 scope，`models` 不借用已启用路由选择，也不把 `model:"catalog"` 解释成扩展全目录。

### 7.2 202 不是成功

`POST` 返回 **`202` 只表示任务已开始**，不代表体检通过。判定结果必须轮询 `GET /admin/model-tests`：

- 首次运行前返回 `{status:"not_started",results:[]}`。
- 报告字段：`scope`、`routeIds`（selected）或 `items`（models）、`startedAt`、`updatedAt`、`status`、`total`、`completed`、`results`、`jobKeys`、`summary`（完成后），异常时为 `error`。
- 精确测试的所选条目立即显示本轮 `running`，不继续借用旧绿色状态；未选模型保留原时间、阶段和原因。最新选择不会清空其他模型的结果。
- **`results` 可能保留历史条目**（含 `previousAttempts`，最多 5 条先前尝试）。不要用 `results.length` 计本轮进度——本轮目标以 `jobKeys` 为准，`summary` 也仅统计本轮键。
- 已有体检在运行时：`selected` 和 `models` 返回 `409 audit_in_progress`，不排队或改写精确选择；同一非精确 scope 返回当前报告，其他非精确 scope 只记录一个后续 `queuedScope`（后来的选择可更新它），不并发写体检记录。

### 7.3 状态语义（不把未验证当通过）

| status | 含义 |
|---|---|
| `passed` | 四项阶段全部通过 |
| `partial` | 聊天通过但工具链未全通过，或前两阶段通过但存在非硬性失败 |
| `uncertain` | 超时、断连或无法判定，属**待复测**，不等于模型永久下线 |
| `unavailable` | 当前目录或通道不提供该条目（如无活动权益、未声明调用通道） |
| `failed` | 出现明确的硬性客户端错误，附原因 |

`capabilityStatus` 另行区分 `full` / `chat_only`（仅聊天通过） / `tools_undeclared`（上游未声明结构化工具）。**聊天通过不等于 Agent 工具链通过。**

目录展示的 `status:chat_verified`（“对话已验证”）是最近体检记录的展示映射：`audit.status:partial`、`capabilityStatus:chat_only`，且普通 `ordinary` 和 SSE `stream` 两阶段均 `ok:true`。底层审计仍保留 `partial/chat_only`；工具与回传标记 `unsupported`、理由为未声明，不改成 `passed`。只有普通通过、SSE 超时/报错时不满足映射，也不凭旧单次成功显示已验证。此状态不证明外部工具、图片或未来可用性。

### 7.4 阶段、超时与并发

- 四个阶段：普通回复、流式、工具调用、工具结果回传。流式要求拿到完整文本与结束事件；工具阶段要求真实结构化 `tool_calls`（名称与参数需匹配）且参数一致；回传阶段要求模型确认本地工具结果。上游未声明工具能力时标记 `unsupported` 并跳过，不伪造通过。
- 阶段超时：**OpenCode 每阶段 `120000`**；精确 `trae-code-cn/deepseek-v4.1-flash` 为 `120000`；NVIDIA 普通模型 `120000`，NVIDIA `moonshotai/kimi-k3` 与 `deepseek-ai/deepseek-v4.1-flash` 为有界 `600000`；其他上游 `45000`。阶段计时从**真正开始请求**时计起，排队不消耗阶段预算。目录刷新另有 45000ms 有界等待，不与阶段生成时间混用。
- 本地阶段预算耗尽保存 `error.code:audit_stage_timeout`、`error.status:408`、`timeoutSource:local_audit_deadline` 和实际 `timeoutMs`；它不是官方返回的 HTTP 408。真正上游错误仍保存其 typed 错误与原因，不能统一改成“模型不可用”。
- OpenCode 体检使用桥接支持的单条用户纯文本，不带 `max_tokens`；这只调整体检探针形状，真实客户端的历史、工具、采样或显式输出预算不会被静默删除。桥接契约见 [OpenCode](opencode.md)。
- 并发上限 2；同一 NVIDIA 账号的体检串行执行（按账号分道），避免互相挤占限流窗口。
- 仅支持自动选工具的上游会在记录中标明 `auditToolChoice`，仍要求结构化工具与回传成功。
- 报告同时写入服务账本的 `model-audit` 状态，并落盘到 `AI_CREDIT_MEMORY`（默认 `D:/AI Memory/AI积分网关-多平台签到与DSH反代`）下 `测试记录/模型全量体检.json`、`模型全量体检.md`；每个本轮完成结果追加到 `体检事件.jsonl`。相同 `upstreamId+model` 的当前记录更新时，通过 `previousAttempts` 保留最多 5 条先前尝试，失败阶段与原因不以新一次成功抹去。定向测试之外的模型记录保持原样。
- API 和原生目录读取同一服务保存的最新体检状态；重开目录可读取新结果，不把外部一次探针未写入该来源的成功冒充界面已验证。体检不修改导入选择、不改变路由启用开关、不改变账号池偏好。

## 8. 余额（`GET /admin/balances`）

返回 `{accounts:[...]}`，每账号含 `accountId`、`label`、`platform`、`edition`、`enabled`、`value`、`unit`、`parts[]`、`expiresAt`、`checkedIn`、`note`、`checkedAt`、`stale`，失败时附 `error`。

**三态必须区分，缺数据不显示为零：**

| 形态 | 含义 |
|---|---|
| 数值（含 `0`） | 平台明确返回的余额；`0` 是真实零 |
| `value:null` | **未知**：没有可用结果，不是零 |
| `stale:true` | 本次核验失败，返回的是上次成功缓存与旧 `checkedAt`；失败原因保留在 `error` / `note` |

- 成功缓存 60 秒内复用；`?refresh=1` 强制重新核验。单次查询有界（默认 25 秒），超时记 `balance_timeout`。
- 积分、Token、现金与资源包单位不同，`parts[]` 分项展示，**不合计为统一余额**。
- Antigravity 按模型组返回每周与 5 小时配额，并用 `quotaKnown` / `quotaStale` / `quotaFetchedAt` / `quotaError` 标明数据新鲜度。
- NVIDIA 条目 `mode:"rate_limited_free"`，`dailyLimit` 与 `remaining` **恒为 `null`**（官方已取消积分制）；`requestLimit` / `requestRemaining` / `tokenLimit` / `tokenRemaining` / `resetAt` 来自官方响应头（`source:"official_response_headers"`）或官方策略（`source:"official_policy"`）。**公示上限不等于实时剩余额度**，`credentialStatus` 区分 `configured` / `missing` / `rejected`，凭据失败时清空历史额度而不伪造数字。

每日自动权益提供 `dailyQuotaObserved`、`dailyCycleDate`、`dailyQuota`、`dailyQuotaObservedAt`、`dailyQuotaSource`。只有官方同账号回执日期是当前业务日、额度有效且后续余额/账单复核成功时，前端才显示今日额度已到账；单凭正余额、旧缓存或宠物奖励不成立。Loomy的 `checkedIn` 保持 `null`，宠物领取另见 `checkinKind/claimable`。

## 9. 调用用量（`GET /admin/usage`）

查询参数：`accountId`、`model`、`status`、`from`、`to`、`beforeId`、`limit`。返回 `records`、`total`、`nextBeforeId`、`source:"gateway"`。

- `model` 匹配**实际上游模型 ID**，不是对外路由 ID；`status` 取 `running` / `completed` / `failed` / `cancelled`。
- `from` / `to` 必须是可解析日期，否则 `400 invalid_date`。
- `total` 是筛选范围内的**尝试条数**，不是独立请求数：同一请求回退到其他账号或模型时，各次尝试共享 `requestId`，但保留各自的实际模型、账号与结果。
- 带 `accountId` 时附 `balanceChanges`（前次/本次核验时间、余额、单位、变化量）。差额包含窗口内消费、领取、套餐到期与客户端活动，**不归因于某一次模型请求**。
- 账本只覆盖启用此功能后的网关调用；不保存提示词、回复正文、工具参数或凭据。写入失败不会改写聊天结果，只输出存储错误标记。字段明细见 [usage.md](usage.md)。

## 10. 领取 / 签到状态（`POST /admin/claim`）

HTTP `200` 不等于权益已发放，必须逐账号看 `status`。真实代码产生的状态集合如下（**代码中不存在 `submitted` 与 `failed` 顶层状态**；`submitted` 只是各上游适配器内部的字段）：

| status | 触发条件 |
|---|---|
| `skipped` | 账号停用（`account_disabled`）或任务停用（`task_disabled`） |
| `observed` | 该任务核验服务端每日额度；可以执行官方幂等刷新并复查，不表示主动领取了新积分 |
| `already` | 服务端已确认领取过，或本地幂等判定（`local_idempotency`） |
| `busy` | 另一进程/worker 正在执行同一账号任务（`another_worker`） |
| `not_available` | 活动未开启（`activity_inactive`） |
| `device_occupied` | 设备当日限额（`device_daily_limit`） |
| `uncertain` | 提交后未获确认（`previous_submission_unconfirmed` / `claim_response_not_confirmed`）；本地状态陈旧时**不会仅因记录过期就重复提交** |
| `success` | 服务端状态复查确认已领取（`serverConfirmed:true`），附 `credits` 等单位信息 |
| `rejected` | 上游明确拒绝（含先前记录中的确定性拒绝） |
| `action_required` | 需要人工验证（如官方窗口完成验证后重试） |
| `error` | 上游异常或服务端状态未知（`unknown_server_state`） |

- CodeArts 的本地 `uncertain` 若对应服务端明确 `CLAIMED / pendingConfirmation:true`，仅恢复幂等确认入账，不再提交 `/ops/claim`；状态变化或回执仍缺失时保留 `uncertain`，其他平台不因同名标记绕过提交保护。
- 仅Loomy/小浣熊自动日额度任务会定向重核缺少日期回执标记的旧 `observed` 记录；新观察记录携带 `observationSchema:1 / observationVerifiedDay`。已领取、已拒绝、一般未知提交和其他平台的幂等保护不释放。
- 幂等键由平台、账号身份指纹、日期（或活动窗口）、任务与设备标识组成；Qoder 等按活动窗口换期（10:00 CST）而非按自然日。
- 千问办公个人版的每日额度由服务端**自动重置**，属 `observed`，不存在手动签到接口——**“官方每日自动额度”不等于“主动签到成功”**。
- 适配器与新的已知服务端回执同时返回 `observed:true` 时，官方每日额度刷新记为 `observed` / `claimed:false` / `officialRefreshConfirmed:true`；只收到刷新接口成功但没有相符回执仍是 `uncertain`，不把每日公示额加到新领取统计。
- `POST /admin/claim` 省略 `accountId` 时批量处理启用账号，输出按账号逐项检查；CLI 的 `claim --account ACCOUNT --task TASK` 为单账号任务，不以未实现的 `--all` 参数代替批量接口。

## 11. 自建前端注意事项

1. 用 `adminKey` 调管理面、`apiKey` 调模型面，不要把两者混用或互相透传。
2. 先 `GET /admin/state` 拿 `baseUrl`，再按该地址发起同源请求，避免 `host_rejected`。
3. `202` 与 `200` 都不代表业务成功：体检看 `status` 与 `jobKeys`，领取看逐账号 `status`，余额看 `value` 与 `stale`。
4. 未知状态显示为“未知”，不要用绿色或零值填充；缓存数值必须同时显示 `checkedAt` 与 `stale`。
5. 长会话超限时提示调整 `server.bodyLimitBytes`；普通管理请求上限固定 4 MiB，不要一并放大。WB 账号导入使用其独立包装／原始文件双重限制。

### 模型目录占位与“导出选中”（取消导入）

`GET /admin/model-directory` 合并实时目录与当前启用路由目标。每条模型的 `importedRouteIds` 精确列出使用该目标的启用路由；`imported` 表示配置关系，不证明可调用。实时目录缺失的目标仍显示：`source: configured_route`、`catalogStatus: missing`（接口失败为 `unavailable`，上游停用为 `upstream_disabled`）、`imported: true`、`callable: false`、`importable: false`，不补造 contextWindow/maxTokens/tools。接口失败另保留 provider.error；发布计数失败返回 published:null 与 publishedError，不吞掉配置条目。停用路由不生成占位。

`POST /admin/model-export` 接受 `{routeIds:["antigravity-main/gemini-pro-agent"]}`，这里“导出”指取消导入，不是文件下载。需要 adminKey；选择为 1–500 个唯一非空字符串。空、错类型、重复返回 HTTP 400 `invalid_selection`；任一路由不存在返回 HTTP 400 `invalid_route`，全请求不写配置。返回 `{saved:true,selected,disabled,alreadyDisabled,routeIds,disabledRouteIds}`：disabled 仅本次停用数；两个 ID 数组均包含全量选择（含原已停用路由）。该操作不访问目录或模型接口，只精确设置选中路由 enabled=false，保留 targets、历史、未选路由及其他配置；重复执行成功且不重复写盘。多目标或同目标别名仍按 routeId 精确操作。

同服务 ConfigStore 的 import/export、PUT config、WorkBuddy capture/pool 使用共同提交队列。模型导入的远程发现置于写锁外；发现期间选中路由或上游变更返回 HTTP 409 `configuration_changed`，不以旧请求复活已取消路由；无关路由修改合并到最新配置。并发 PUT 请求在读 body/等待锁期间发现配置版本对象改变也返回 409，调用方应重读后重新操作。本机制为同服务进程内保护，不宣称跨进程文件事务。旧 model-import 的 enabled:false 分支保留兼容且不再依赖目录，精确批量取消优先使用 model-export。

旧 `/admin/model-import` 的取消条目可携带 `importedRouteIds`；服务端逐一核对这些现存路由仍包含该 upstream/model，全部匹配才停用指定路由，其他别名/多目标路由保持不变。未携带该字段的旧客户端沿用原单目标匹配行为。请优先使用 `/admin/model-export` 明确选择 routeIds。

体检预算独立于模型请求服务器预算：OpenCode 与精确 `trae-code-cn/deepseek-v4.1-flash` 的每一体检阶段为 120000ms，耗尽本地预算标记 `audit_stage_timeout`（HTTP 408），并不当作官方接口返回；其他普通体检维持 45000ms，NVIDIA 专属预算与服务器请求截止保持各自策略，完整表见第 7.4 节。

### 同模型接力 活动与免费平台

新增 `GET/POST /admin/model-relay`、`GET /admin/activity-context`、`GET /admin/free-providers`、`POST /admin/free-provider-add`。均要求adminKey，同样使用固定4MiB管理请求上限。策略、元数据覆盖、流式有界缓冲、待配置状态和文件引用契约见[同模型自动接力与活动洞察](model-relay.md)。来源标记只接受 `X-AI-Credit-Source: dsh|hermes`，不会把客户端值当作体检来源来绕过接力。

## 12. WB 帐号池与详细账号状态

完整操作与字段见 [WB 帐号池](wb-account-pool.md)。以下为调用方必须保持的兼容语义。

### 查询与显示

- `GET /admin/workbuddy/summary` 默认读取本机已知结果，包含全部保存的 WB 账号；停用、认证拒绝与封禁账号仍在 `accounts` 中，不从列表移除。
- `?refresh=true` 刷新；加 `accountId=ACCOUNT` 可定向刷新。`GET /admin/workbuddy/accounts/ACCOUNT/details?refresh=true` 返回 `{account}`，提供单账号详情。
- 旧账号行的 `remaining` / `total` 保留；详细对象包括 `identity`、`profile`、`credential`、`ban`、`balance`、`tasks`、`dailyCheckin`。UID、userId 与网关账号 ID 分开，缺失值为未知。
- `credential` 只返回状态、`accessState` / `refreshState` 与 Access/Refresh 有效期等元数据，不返回 token/Cookie。账号身份留在本机管理面，不进入活动用量日志。
- `balance` 包含当前余额/总额、全部分页积分包、最近成功/失败与错误；刷新失败保留可识别的旧数据，不将其伪装为新成功。未知不填零，总额不拿剩余冒充。
- `tasks.items` 保留任务内容、目标/进度、奖励、接受/达标/领奖/锁定状态与执行策略。查询失败和未查询分别标记，不能把空数组统一解释为“无任务”。
- 原生“积分总览”排除 WB，池页使用显眼的“积分剩余 / 总额”；余额管理 API 的默认全平台契约保留，避免破坏既有调用方。

### 封禁与人工标记

`ban.status` 区分 `banned`、`auth_rejected`、`unknown`、`clear`，保留 `reason`、`httpStatus`、`upstreamCode`、`source` 与 `checkedAt`。HTTP 401/403 或 `12153` 等业务认证拒绝不独立证明官方封禁；明确封禁/blocked 证据才作为官方封禁。

```json
{"status":"banned","reason":"SAMPLE：已由用户核对","confirm":true}
```

将该 body 发送到 `POST /admin/workbuddy/accounts/ACCOUNT/mark-status` 只保存可撤销的**本机用户标记**，不向上游封号、不冒充官方事实；`status:"clear"` 清除本地标记。标记为封禁后退出 WB 池候选，但账号卡、详情、聊天和历史保留；删号仍需单独显式确认。

### 任务、切换与会话

`GET /admin/workbuddy/tasks?accountId=ACCOUNT` 查询任务；POST 支持 `action: query/accept/run/claim`。任务按实际注册执行器处理：接受任务、真实每日签到、对话/技能/专家/画布/资料库/自动化等已接入功能，执行后回查官方进度并只领取已达标奖励；前置条件未就绪或未注册执行器时保留具体等待状态或 `manual_action_required`，不伪造进度或遥测。执行器要求见 [WB_TASK_EXECUTORS.md](WB_TASK_EXECUTORS.md)。

设置只接受布尔 `autoTasks` / `autoMigrateSessions`，默认关闭。自动任务同账号互斥，约每 30 分钟检查，不以刷新余额代替签到。

账号切换使用 `POST /admin/workbuddy/accounts/ACCOUNT/switch`；`switchClient:false` 只切网关后续请求。会话合并是新 ID 的本机加法副本，保留源与幂等映射；`cloudSyncConfirmed:false` 不表示云端同步已确认。官方客户端运行或写入失败时返回实际状态并回滚，不重放已经输出的模型请求。

### 接力分区

`POST /admin/model-relay` 支持 `partitions:{workbuddy:true,other:true}`，两者均为布尔。WB 只接 WB；非 WB 供应排除 WB，即使手工构造混合配置也做分区筛选。账号封禁/停用不参与供给，认证失败按独立原因处理。

HTTP 截止与供给进度超时不同：接力默认 30 秒无有效进展，正文/推理/工具增量刷新计时。主供应窗口广播与备用能力筛选分离，保留模型 ID、历史、工具与输出预算；不要将能力错误写成真实积分耗尽。


## 13. WB 账号交换、备注与自动轮换

所有接口使用 `adminKey`。普通管理请求固定 4 MiB；账号导入 preview/commit（含兼容 `/import`）单独提供 16 MiB HTTP 包装上限，供 base64 / JSON 转义使用，解码后的文件合计仍限制 4 MiB，单 JSON 256 KiB、解压总量 16 MiB、账号 128、文件 32。这个例外不改变其他管理入口或聊天字节边界。

| 接口 | 输入 / 结果 |
|---|---|
| `POST /admin/workbuddy/accounts/import/preview` | `{files:[{format:"json"或"zip",name,content}],duplicatePolicy}` → 脱敏 `entries`、`errors`、`valid` |
| `POST /admin/workbuddy/accounts/import/commit` | 同一 `files`，可加 `selectedIndexes`；`duplicatePolicy:"skip"`（默认）或 `"replace"` → `saved`、新增/替换/跳过与逐账号结果 |
| `POST /admin/workbuddy/accounts/export` | `{accountIds:["ACCOUNT"],format:"json"或"zip"或"switch-json"}` → `exported`、`filename`、`contentType`、`encoding:"base64"`、`content`、`count` |
| `POST /admin/workbuddy/accounts/:id/profile` | `{label?,notes?}` → 本机展示字段保存回执；不变更主体/任务/路由 |
| `POST /admin/workbuddy/accounts/:id/inference` | 严格 `{enabled:boolean}` → `inferenceEnabled` 与签到/任务不变回执 |
| `GET /admin/workbuddy/rotation` | `{settings,state,preview}`，默认只读 |
| `POST /admin/workbuddy/rotation` | 平铺严格设置：`enabled`、`target`、`strategy`、频率/冷却/门槛、`edition` |
| `POST /admin/workbuddy/rotation/evaluate` | `{dryRun:true}` 默认只预览；false 才按当前策略尝试提交 |

导入按版本 + UID 去重；预览不写入、不续期、不调用模型；提交重新核对当前配置，默认跳过已有账号。显式替换更新同主体凭据，保留既有槽位、显示名/备注、账号与积分启停、任务、手动池、路由启停；私密原件备份和失败回滚与结果分别记录。导出响应是刻意返回的凭据文件传输，客户端保存后不打印内容，普通 summary/details 继续隐藏 token。

轮换与接力/签到任务分开：默认关闭，仅考虑同版本可用 WB 候选，暂停积分调用的账号排除；网关只影响下一请求，CLI 存活时推迟，不终止进程。`dryRun` 预览、配置保存和实际逐目标切换结果是三个状态；HTTP 200 不是“所有账号都已经切换”。

文件形状、容量、错误与示例见 [WB 账号交换](WB_ACCOUNT_TRANSFER.md)；轮换设置、候选、CLI 门控与地区写入见 [WB 轮换](WB_ROTATION.md)；来源对照见 [WB_SWITCH_COMPARISON.md](WB_SWITCH_COMPARISON.md)。

交换预览支持旧版仅 Access Token 的账号：`hasRefreshToken:false`、`refreshable:false`、`warnings:[{code:"wb_import_access_only",...}]`。导出缺失 Refresh Token 为 `""`，到期需重新登录；不伪造续期能力。
