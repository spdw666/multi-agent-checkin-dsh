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
- 公开源码包不附带前端：`web/` 资源不在仓库内，公开入口是 CLI 与管理 API；自建前端请把密钥留在本地，不要写入 URL、日志或聊天。

## 2. Host 与 Origin 防护

每个请求先做两级同源校验，失败即拒绝，不进入业务分支：

- **Origin**：请求带 `Origin` 且不等于 `http://<Host>` 时返回 `403 origin_rejected`。浏览器页面即使持有被泄露的环境头也无法跨源调用本网关。
- **Host**：`Host` 必须等于服务自身 `baseUrl` 的 host，或 `localhost:<实际端口>`，否则返回 `403 host_rejected`。用其他主机名（含 IP 变体、反代域名）访问会被拒绝。
- 响应统一带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`，JSON 与静态资源均 `Cache-Control: no-store`；不返回 CORS 许可头，跨源读取不被鼓励也不被支持。界面资源额外带严格 CSP（`default-src 'self'`、`frame-ancestors 'none'`）。

## 3. 请求体上限：聊天 64 MiB，管理 4 MiB

- **聊天**：`POST /v1/chat/completions` 使用 `server.bodyLimitBytes`，默认 `67108864`（64 MiB），可配置范围 `1024`–`67108864`，越界为 `400 invalid_config`。这是**字节上限，不是模型上下文上限**；超限返回 `413 body_too_large`，错误消息包含实际字节数与上限，并明确说明**消息历史未被裁剪**——网关不静默截断，长会话由调用端做上下文压缩。上游自身报的 context length / token limit 属另一层限制。
- **管理**：所有 `/admin/*` 请求体固定上限 `4194304`（4 MiB），**不随聊天上限一起放宽**。`POST /admin/model-tests` 允许空 body（按默认 `scope` 处理）。
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

校验失败一律 `400`：非对象或数组 body、未知 `scope` 为 `invalid_audit_scope`；`routeIds` 为空数组、含空白字符串、路由不存在/已停用/无活动目标为 `invalid_audit_selection`。

### 7.2 202 不是成功

`POST` 返回 **`202` 只表示任务已开始**，不代表体检通过。判定结果必须轮询 `GET /admin/model-tests`：

- 首次运行前返回 `{status:"not_started",results:[]}`。
- 报告字段：`scope`、`routeIds`、`startedAt`、`updatedAt`、`status`、`total`、`completed`、`results`、`jobKeys`、`summary`（完成后），异常时为 `error`。
- **`results` 可能保留历史条目**（含 `previousAttempts`，最多 5 条先前尝试）。不要用 `results.length` 计本轮进度——本轮目标以 `jobKeys` 为准，`summary` 也仅统计本轮键。
- 已有体检在运行时：`selected` 返回 `409 audit_in_progress`；其他 scope 不会并发写，而是排队到当前任务之后，并在当前报告中以 `queuedScope` 标记。

### 7.3 状态语义（不把未验证当通过）

| status | 含义 |
|---|---|
| `passed` | 四项阶段全部通过 |
| `partial` | 聊天通过但工具链未全通过，或前两阶段通过但存在非硬性失败 |
| `uncertain` | 超时、断连或无法判定，属**待复测**，不等于模型永久下线 |
| `unavailable` | 当前目录或通道不提供该条目（如无活动权益、未声明调用通道） |
| `failed` | 出现明确的硬性客户端错误，附原因 |

`capabilityStatus` 另行区分 `full` / `chat_only`（仅聊天通过） / `tools_undeclared`（上游未声明结构化工具）。**聊天通过不等于 Agent 工具链通过。**

### 7.4 阶段、超时与并发

- 四个阶段：普通回复、流式、工具调用、工具结果回传。流式要求拿到完整文本与结束事件；工具阶段要求真实结构化 `tool_calls`（名称与参数需匹配）且参数一致；回传阶段要求模型确认本地工具结果。上游未声明工具能力时标记 `unsupported` 并跳过，不伪造通过。
- 阶段超时：NVIDIA 普通模型 `120000`；NVIDIA `moonshotai/kimi-k3` 与 `deepseek-ai/deepseek-v4.1-flash` 为有界 `600000`；其他上游 `45000`。阶段计时从**真正开始请求**时计起，排队不消耗阶段预算。
- 并发上限 2；同一 NVIDIA 账号的体检串行执行（按账号分道），避免互相挤占限流窗口。
- 仅支持自动选工具的上游会在记录中标明 `auditToolChoice`，仍要求结构化工具与回传成功。
- 报告落盘到 `AI_CREDIT_MEMORY`（默认 `D:/AI Memory/AI积分网关-多平台签到与DSH反代`）下 `测试记录/` 的 JSON、Markdown 与 `体检事件.jsonl`。体检不修改导入选择、不改变路由启用开关、不改变账号池偏好。

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
- `claim --all` 的批量输出按账号逐项给出结果，退出码不能替代逐项检查。

## 11. 自建前端注意事项

1. 用 `adminKey` 调管理面、`apiKey` 调模型面，不要把两者混用或互相透传。
2. 先 `GET /admin/state` 拿 `baseUrl`，再按该地址发起同源请求，避免 `host_rejected`。
3. `202` 与 `200` 都不代表业务成功：体检看 `status` 与 `jobKeys`，领取看逐账号 `status`，余额看 `value` 与 `stale`。
4. 未知状态显示为“未知”，不要用绿色或零值填充；缓存数值必须同时显示 `checkedAt` 与 `stale`。
5. 长会话超限时提示调整 `server.bodyLimitBytes`；管理请求上限固定 4 MiB，不要一并放大。
