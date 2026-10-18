# OpenCode Zen 免费模型：官方本机文本桥

本页描述当前 `opencode` 适配器的真实契约。它通过已安装的官方 OpenCode CLI / 本机服务调用免费模型，再映射为网关的 OpenAI 兼容响应；不是公共免费推理端点的直接 OAuth 代理，也不把模型目录、登录成功或额度估算当成调用通过。

## 1. 准备与最短接入步骤

1. 安装并启动官方 OpenCode 桌面版，在官方界面完成登录。
2. 在网关保存独立 `opencode` 账号与上游，凭据只引用本机数据库。先查看登录状态与目录，再选要使用的型号。
3. 对少量目录条目做精确体检。未导入型号使用 `POST /admin/model-tests` 的 `scope:models/items`，不用为了测试先启用路由。
4. 查看最近普通和 SSE 两阶段结果、核验时间、失败原因及工具声明。只有按需求确认后，再勾选导入。
5. 用下方单条纯文本示例验证调用。完整 Agent 工具任务使用真正支持该请求契约的供给，不从聊天通过推导工具闭环通过。

配置结构片段（合并进现有配置，不覆盖其他账号或路由）：

```json
{
  "accounts": [
    {"id":"opencode-SAMPLE","platform":"opencode","credentials":{"file":"auto"},"enabled":true}
  ],
  "upstreams": [
    {"id":"opencode-SAMPLE","kind":"opencode","accountId":"opencode-SAMPLE","baseUrl":"http://127.0.0.1:21803","enabled":true}
  ]
}
```

`21803` 是示例回环端口，不是固定安装值。未使用专用连接时，`baseUrl` 是合法回环起点；网关优先读取官方状态文件中的当前 URL，再验证服务身份与认证。`auto` 读取当前用户官方本机数据，不把密码、Access Token 或 Refresh Token 写回公开配置。

当前读取位置：

| 数据 | 当前用途 |
|---|---|
| `~/.local/share/opencode/opencode.db` | 只读官方当前登录记录及本机用量；可通过账号 `credentials.file` 指定数据库 |
| `~/.config/opencode/service.json` | 只读官方本机服务认证信息；不输出密码 |
| `~/.local/state/opencode/service.json` | 发现官方共享服务的当前回环 URL |
| `%LOCALAPPDATA%/Programs/@opencodedesktop/resources/opencode-cli.exe` | 当前 Windows 自动冷启动使用的官方 CLI |

已有 OpenCode 安装不代表上述每项已经就绪；诊断以各自 typed 状态为准。用户数据、节点与凭据文件不属于分发内容。

## 2. 服务发现、冷启动与免费目录

默认链路先校验回环地址，再读取官方服务状态，以认证后的 `/api/info` 验证服务版本与 PID。服务未就绪时运行官方 `service start`，重读状态和端口后再验证；不把过期端口继续当成当前服务。认证拒绝保留 `opencode_service_auth_rejected`，不靠重复启动掩盖。

进程内的共享冷启动是单飞操作；一个调用者取消等待，不终止官方共享服务，也不取消另一调用者的启动等待。当前自动启动面向上述 Windows 标准安装位置，其他平台的启动方式不由这一路径推断。

目录来自官方本机服务的 `/api/model`，仅保留 `providerID:opencode` 且 ID 以 `-free` 结尾的条目。上下文与输出上限读取当前 `limit.context/output`，不从型号名猜测窗口。目录更名、撤回或查询失败会体现在本轮结果里；**目录存在不保证账号、地区、限流窗口或此刻推理可用性**。

公共推理 URL 曾返回的 `FreeTierError` 与本机官方链路的真实结果分别处理。即使已走官方 CLI，也可能收到免费层拒绝、地区拒绝、429、额度不足或上游错误；按实际错误保留，不把登录与免费资格合并成一个成功状态。

## 3. 当前无损请求契约

| 项目 | 当前文本桥行为 |
|---|---|
| 消息 | **仅单条 `role:user`，`content` 为纯文本字符串**；消息对象只含 `role/content` |
| 多角色/多轮历史 | 不转换成拼接提示词，返回 `relay_context_incompatible` |
| 显式采样/输出预算 | 当前本机 prompt 协议没有对应无损字段；`max_tokens`、`max_completion_tokens`、`temperature`、`top_p`、显式推理控制等返回 `relay_capacity_incompatible` |
| 外部调用者工具 | 声明 `tools:false`；工具 schema、工具调用 ID/结果和函数调用历史不被吞掉，返回 `tools_not_supported` |
| 图片 | 声明 `multimodal:false`；`image_url/input_image` 不冒充已支持，返回 `images_not_supported` |
| 普通与 SSE | 官方回答完整组装后映射；SSE 输出一个完整单块，再发 `[DONE]`，不是原生逐 Token 透传 |
| 模型身份 | 终态核对实际 `providerID/id`；返回模型不符记 `opencode_model_mismatch` |

网关**不静默删除客户端字段**，不把多角色历史、工具结果或显式预算裁掉再请求。能力不符时，原始完整请求可由配置允许且确实兼容的同款供应接力；没有兼容供给时保留 typed 失败。OpenCode 官方 Agent 自带工具与外部调用者的结构化工具协议是两件事，不能互相代替。

桥接会话使用明确标题，避免官方自动标题流程额外发起潜在付费请求。会话只读 Agent 的本机审批请求不会被网关自动批准；完成后清理本次会话，不将网关短答解释为调用端工具已执行。

最小请求示例（`SAMPLE_ROUTE` 替换为已经导入后 `/v1/models` 返回的完整路由 ID；环境变量来自本机密钥管理）：

```powershell
$headers = @{Authorization = "Bearer $env:AI_CREDIT_API_KEY"}
$body = @{
  model = 'SAMPLE_ROUTE'
  messages = @(@{role = 'user'; content = 'Explain HTTP and HTTPS briefly.'})
} | ConvertTo-Json -Depth 5
Invoke-RestMethod 'http://127.0.0.1:19421/v1/chat/completions' `
  -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

示例有意不附显式 budget 或采样字段，这不是允许网关删除真实客户端已提交字段。需要 SSE 时在同一请求加入 `stream:true`，并用能完整解析 SSE 的客户端检查结束帧。首个可见输出等待受本机完整生成、客户端期限与网关整轮期限共同影响。

## 4. 可选 networkProfile：专用连接与独立官方服务

默认不启用专用连接。需要隔离网络路径时，只在该 OpenCode 上游增加一个本机绝对文件引用：

```json
{"networkProfile":"C:/SAMPLE/OpenCode/network-profile.local.json"}
```

私有 profile 的字段示例：

```json
{
  "executable":"C:/SAMPLE/OpenCode/mihomo.exe",
  "proxyConfigFile":"C:/SAMPLE/OpenCode/proxy.local.yaml",
  "scratchDirectory":"C:/SAMPLE/OpenCode/work",
  "stateDirectory":"C:/SAMPLE/OpenCode/state",
  "proxyUrl":"http://127.0.0.1:21801",
  "controllerUrl":"http://127.0.0.1:21802",
  "serverUrl":"http://127.0.0.1:21803",
  "controllerToken":"SAMPLE_REPLACE_WITH_LOCAL_SECRET_24PLUS"
}
```

以上都是 SAMPLE 路径与占位 secret，不含节点配置。实际连接配置由用户本机保存。四个文件/目录字段必须为绝对路径，三个 URL 必须是不同的 `http://127.0.0.1:PORT` 回环地址、端口在 1024–65535，控制口令至少 24 字符。该实现验证 Mihomo 的控制接口身份，不把任意 HTTP 代理程序都视作兼容。

请求到来时分别探测专用连接与专用官方服务；缺少进程时按需启动并验证就绪。独立官方 CLI 通过专用子进程环境接收代理地址、配置目录和服务认证，**不改系统全局代理、不切换用户现有代理节点、不重写官方共享服务状态或用户官方配置**。相同 profile 与认证的启动等待单飞，一个等待者取消不影响其他调用者。

端口认证冲突记 `opencode_network_port_conflict`，不会接管该端口。配置格式错误、配置不可读、进程启动失败与未就绪分别保留 `opencode_network_profile_invalid`、`opencode_network_profile_unavailable`、`opencode_network_start_failed`、`opencode_network_not_ready`。专用连接成功不改变官方账号资格、模型服务状态或限流规则。

移除上游 `networkProfile` 引用后，后续请求回到默认官方共享服务发现；已启动的独立服务/连接是各自独立进程，不因删除字段自动退出。维护时只按本机 `stateDirectory` 的进程记录核对并结束这两个专用进程，别按程序名批量结束官方共享服务或其他代理。

## 5. 精确体检、最新记录与“对话已验证”

未导入模型可直接提交：

```json
{"scope":"models","items":[{"upstreamId":"opencode-SAMPLE","model":"space-bunny-free"}]}
```

使用 `adminKey` 发送到 `POST /admin/model-tests`。它接受 1–500 个唯一 `upstreamId+model` 选择；已有体检执行时返回 `409 audit_in_progress`。HTTP 202 只代表已启动；轮询 `GET /admin/model-tests`，按本轮 `jobKeys/total/completed` 看进度，不用含历史条目的 `results.length` 计数。

每个 OpenCode 阶段有界 **120 秒**；探针只发送桥接支持的纯文本，不加显式输出预算。普通与 SSE 分别执行。外部工具与回传因未声明而标记 `unsupported`，不伪造通过。失败保留阶段、耗时、错误码与原因；`audit_stage_timeout` 是本地体检 120 秒截止（408），不冒充官方 HTTP 408。

底层审计 `status:partial/capabilityStatus:chat_only` 且普通与 SSE 均通过时，目录显示 `chat_verified` / **对话已验证**。它不代表 `passed` 四项全部通过，不代表图片和外部工具可用。普通通过但 SSE 失败时不满足这个标记。

报告写入服务账本及配置的体检 JSON/Markdown，完成事件追加到 JSONL；重测同一模型保留最多 5 条先前尝试，不触碰其他模型历史与导入开关。原生目录读取相同保存状态，旧窗口重开后再看最新记录。完整持久化与校验契约见 [API](api.md#7-模型体检post-adminmodel-tests)。

### 如何解读实测，而不把它当永久保证

一次九型号的真实定向验收得到 **9 个普通回答通过、7 个 SSE 通过**：MiMo 的 SSE 触发本地 120 秒 `audit_stage_timeout`；DeepSeek 的 SSE 报告上游 HTTP 500，网关保留 `opencode_upstream_error`（502）及原始原因。其余七个仅获得普通 + SSE 的聊天验证，外部工具仍未声明。这说明同一目录内的不同型号、不同阶段会有不同结果，不代表所有型号都失败，也不代表后续每次请求都会成功。

以上是一次测量的解释示例，不是固定免费目录、永久可用名单或当前账号承诺。实际操作以你本机最近 `updatedAt`、逐型号阶段结果、错误来源和实际请求为准；不要用旧单次成功覆盖本次超时，也不要为刷新徽标自动重放整批模型。

## 6. 额度、错误与运行时各看一层

- **免费剩余次数**：从本机数据库读取当天请求数，结合社区约 200 次/天估算；官方没有公开免费日上限/实时剩余接口，重置口径为 UTC。该值显示“次（估算）”，不是官方实时余额，也不作为可调用证明。
- **Zen 付费余额**：官方 billing 结果单独列 USD；付费余额读取、免费用量读取、目录与推理分别保留状态。一项失败不清空其他已知来源，也不把旧值伪装为新结果。
- **上游拒绝**：免费层拒绝、地区拒绝、429、401/403、402 与其他上游错误各有 typed code；目录/服务/网络错误不一律改成“额度耗尽”。
- **请求归属**：排查时看活动的真实供给、候选跳过和实际派发，不用路由前缀或菜单名称证明本次由 OpenCode 回答。接力与根因保留见 [可靠性说明](reliability.md)。
- **Windows runtime**：网关最低 Node 22.23.3，Windows 推荐已验证的配套 22.23.3；这是网关/私有 worker 的运行时，不替换 OpenCode 官方运行时。自然退出和流资源所有权见 [运行时说明](runtime-reliability.md)。

## 7. 实现与官方协议参考

- 当前网关实现：[provider-opencode.mjs](../src/provider-opencode.mjs)、[官方服务发现](../src/opencode-service.mjs)、[可选专用连接](../src/opencode-network.mjs)、[模型体检](../src/model-audit.mjs)、[目录状态映射](../src/model-directory.mjs)。
- 官方本机服务概念：[OpenCode Server 文档](https://opencode.ai/docs/server/)。实际接口字段以适配器锁定的官方版本为准，不将其他版本的示例自动视作可直接互换。
- 适配器核对的协议版本：[OpenCode session 协议固定提交](https://github.com/anomalyco/opencode/blob/c38d83c0c4f92466ff9c8e12b8a741698e811012/packages/protocol/src/groups/session.ts)。该协议的 session prompt 形状与 OpenAI 外部工具/采样契约不同，桥接据此显式报告不兼容，不猜测静默透传成功。
