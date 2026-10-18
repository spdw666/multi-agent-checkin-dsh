# 接入 Hermes

Hermes 通过命名自定义 Provider 直连本网关的 OpenAI 兼容接口：

```text
Hermes → http://127.0.0.1:19421/v1 → 已启用的平台路由
```

不需要 DSH 插件，也不需要把网关代码注入 Hermes。DSH 和 Hermes 可以同时使用同一套账号与路由配置；并发调用仍消耗真实上游额度。

## 准备

安装可靠性插件时，仅将 `ai-credit-reliability` 追加到现有 `plugins.enabled`；保留原有插件列表和其他 Provider，不全局开启插件发现。


1. 启动网关，确认 `/health` 返回成功，并用自己的账号完成模型体检。
2. 确认 Hermes 实际使用的 home/profile。设置了 `HERMES_HOME` 时使用该目录；不要盲目编辑另一份 `~/.hermes/config.yaml`。
3. 备份实际 `config.yaml` 并记录 SHA-256。保留已有 `model`、`providers` 和其他设置。
4. 确认 Hermes 版本支持命名 `providers`、`key_cmd`、`discover_models` 和 `extra_body`。字段支持以实际安装版本为准。

## 配置

在已有 `providers` 映射里添加 `ai-credit`，没有该映射时才新建。不要追加第二个同名顶层 `providers`。

下面是 Windows 路径示例；把三个路径替换为本机 Node、仓库脚本、网关真实数据目录的绝对路径。使用正斜杠与双引号可以处理带空格的路径。数据目录可能由 `config.local.json` 的 `dataDir` 改写，不一定在仓库下。

```yaml
providers:
  ai-credit:
    name: AI网关
    base_url: http://127.0.0.1:19421/v1
    api_mode: chat_completions
    discover_models: true
    key_cmd: '"C:/Tools/node/node.exe" "C:/Gateway/scripts/hermes-key.mjs" "C:/Gateway/data/api-keys.json"'
    extra_body:
      reasoning_effort: null
    extra_headers:
      X-AI-Credit-Source: hermes
      X-AI-Credit-Retry-Owner: gateway
    request_timeout_seconds: 1210
    stale_timeout_seconds: 1210
```

Linux/macOS 可将 `key_cmd` 改为类似 `'/usr/bin/node "/opt/ai-credit/scripts/hermes-key.mjs" "/var/lib/ai-credit/api-keys.json"'`。安装目录和文件访问权限由部署者配置。

`scripts/hermes-key.mjs` 每次执行只读取 `apiKey`，不使用 `adminKey`。它通过标准输出把 `{access_token, expires_in}` 交给 Hermes，不把密钥写回 YAML 或 `.env`。`expires_in: 65` 是 helper 缓存刷新提示，不是网关密钥真实有效期；具体提前刷新时间由 Hermes 实现决定。

**不要把 helper 的标准输出复制到聊天、日志或工单。** 缺文件、非法 JSON、空密钥等失败只产生固定错误消息，并返回退出码 1。密钥文件始终留在本机，不提交 Git。

## 模型选择与推理档位

打开 Hermes 模型选择器，或在 CLI 使用 `/model`，选择“AI网关”及实际返回的模型 ID。不要照抄别人的账号前缀，也不要删除模型 ID 中的斜杠。

`discover_models: true` 从 `/v1/models` 获取启用路由；不写死模型清单，不恢复停用项。Hermes 可能缓存目录，网关启停模型后需刷新目录。添加 Provider 本身不要求覆盖原默认模型，已有会话也不应被迁移到新 Provider。

Hermes 通用 custom Provider 可能默认发送 `reasoning_effort: medium`，但部分 Trae 路由只接受 `low/high/xhigh`，会返回 `400 / reasoning_effort_not_supported`。配置中的 `extra_body.reasoning_effort: null` 覆盖统一档位，由网关/上游按该路由的默认策略处理。

**此方案下，Hermes 的思考强度菜单不逐平台透传。** 这不是全档位适配；未来若增加逐模型映射，应同时验证普通、流式及工具链。该配置仅影响新增 Provider，不修改 DSH 的推理设置或其他 Hermes Provider。

## 网关统一恢复：避免 Hermes 再跑一遍整池

网关对一次请求的供应选择、短窗口等待和同型号接力共用同一个总期限。最终错误返回 `gatewayManagedRetry: true`、`gatewayRetryOwner: gateway`、`retryable: false`、`gatewayRequestId`；非流式错误还返回 `X-Should-Retry: false`。`relayFailure.root` 是主要失败，`last` 是最后失败，`attemptCount` 是已发出的供应尝试，`skippedCount` 是本地排除的候选；跳过不是一次真实上游失败。它们不包含账号 ID、请求正文或凭据。

`X-Request-Id` / `X-AI-Credit-Request-Id` 由网关为每次请求生成。`X-AI-Credit-Source: hermes` 只帮助区分诊断来源，不赋予任何管理权限。客户端指定的请求 ID 不覆盖网关 ID。

Hermes 的 SDK 没有重试，不代表整个 Agent 没有重试。已核对的 Hermes `d923a5eb487a17c0a68801bba9ef0f56c81040a8` 主客户端设有 `max_retries=0`，但外层 conversation loop、流断开恢复及 5xx 非流式探针各有自己的恢复分支。**只配置超时或只安装错误分类插件，都不足以阻止流式层先重放请求。**

本仓库提供配套集成：

1. `integrations/hermes/ai-credit-reliability/` 是 Hermes 官方 `transform_api_error_classification` 插件。仅处理 `ai-credit` / `custom:ai-credit` 且实际请求 URL 指向本机 `/v1/chat/completions` 的请求；远端及其他 Provider 保持原行为。
2. `integrations/hermes/native-patch/agent/chat_completion_helpers.py` 是针对上述核验版本的最小原生补丁副本：在流式重试及 5xx 非流式探针之前，尊重同一官方插件已经作出的“网关拥有恢复权”判定。安装前必须逐文件核对当前原件 SHA，保留原件；Hermes 版本或文件发生后续变化时，应将该小段变更重新合并，不能整文件覆盖其他更新。
3. 配置只在此命名 Provider 合并上面的两个 `extra_headers` 和两个超时字段，保留已有其他请求头、凭据 helper、默认模型及其他 Provider。

超时单位是秒。`1210` 覆盖网关支持的最大 1200 秒总预算及 10 秒交付余量；实际网关仍按每条路由自己的预算结束，并非把每次请求强制等待 1210 秒。Hermes 的 `providers.<id>.models.<model>.timeout_seconds/stale_timeout_seconds` 优先于 Provider 默认值，已有逐模型覆盖时也要按相应网关预算加 10 秒核对。延长客户端等待不重置网关总预算、不增加重试次数，也不改变输出 token 上限。

显式设置 `X-AI-Credit-Retry-Owner: gateway` 是此 Provider 的本地客户端策略：收到网关有类型的终局错误时不再整池重放；连接或读响应中断、结果未知时也保留原请求并结束本次自动恢复，避免前一次已生成或已进入工具链后再次执行。官方短窗口恢复仍由网关在剩余预算内处理。插件不会把长窗口限流说成已恢复，不会压缩消息、改模型、删除工具结果或影响其他 Provider 的重试。

仅针对本地 SAMPLE 端点的回归：

```powershell
node --test tests/reliability-clients.test.mjs
& 'HOST/Hermes/venv/Scripts/python.exe' tests/reliability-hermes.py
```

第二条使用 `HERMES_SOURCE` 指向待验证版本，测试真实 SDK、官方插件分派和 `_StreamingCall._handle_stream_error`，包含 HTTP 5xx、SSE 部分工具输出、取消、读超时与其他 Provider 对照。它不读取真实会话或生成模型；安装与真实任务验收仍需分别记录。

## 分层验证

- **配置层**：原默认模型保持不变；Provider 能解析本机凭据；模型选择器与 `/v1/models` 的启用路由一致。
- **协议层**：分别验证普通回复、SSE、工具调用、流式工具调用，保留每条路由的结果与时间。
- **Agent 层**：让 Hermes 读取一个临时文件里的随机内容，确认工具实际执行、结果返回模型且最终回答一致。仅输出工具调用 JSON 不算工具执行闭环。
- **故障层**：网关停止时先查 `/health`；401 核对 `apiKey` 和真实数据目录；400 核对推理字段；列表陈旧时刷新目录。不要重复重启 DSH 排查 Hermes 的 HTTP 链路。

该接入方式已有本机真实验证：七条当时启用路由的四类协议探针共 28 项通过，WorkBuddy Flash 与 Trae Flash 均完成 Hermes 真实读文件闭环。这是一次部署验证，不是所有账号、模型、Hermes 版本永久可用的承诺；个人路由、凭据及原始会话不随仓库发布。

离线凭据 helper 回归：

```bash
node --test tests/hermes-key.test.mjs
npm run check
```

测试只使用临时虚构密钥文件，不读取真实账号，不调用模型。它验证 helper 行为，不代替 Hermes 实测。

## 回滚

若配置在接入后未发生其他修改，可核对 SHA-256 后恢复备份；否则只移除新增的 `providers.ai-credit`，保留后续设置。移除自己额外复制的 helper（若有），在新会话选择原 Provider。无需删除账号凭据、网关路由或账本，也无需重启 DSH。

若只回滚本节可靠性集成，保留 Provider 本身和原模型：移除新增插件、按哈希守卫恢复此次原生文件备份，仅撤销本轮新增的两个请求头与两个超时值。配置或原生文件有后续修改时逐字段/逐段逆向合并，不能恢复整个旧配置覆盖新账号或新设置。

## 实现依据

- [Hermes 自定义 Provider 文档](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-providers)
- 对应安装版本的 `hermes_cli/runtime_provider_custom.py`、`hermes_cli/model_switch_providers.py` 和 `plugins/model-providers/custom/__init__.py`。
