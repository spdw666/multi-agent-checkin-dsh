# 接入 Hermes

Hermes 通过命名自定义 Provider 直连本网关的 OpenAI 兼容接口：

```text
Hermes → http://127.0.0.1:19421/v1 → 已启用的平台路由
```

不需要 DSH 插件，也不需要把网关代码注入 Hermes。DSH 和 Hermes 可以同时使用同一套账号与路由配置；并发调用仍消耗真实上游额度。

## 准备

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
    name: AI积分网关
    base_url: http://127.0.0.1:19421/v1
    api_mode: chat_completions
    discover_models: true
    key_cmd: '"C:/Tools/node/node.exe" "C:/Gateway/scripts/hermes-key.mjs" "C:/Gateway/data/api-keys.json"'
    extra_body:
      reasoning_effort: null
```

Linux/macOS 可将 `key_cmd` 改为类似 `'/usr/bin/node "/opt/ai-credit/scripts/hermes-key.mjs" "/var/lib/ai-credit/api-keys.json"'`。安装目录和文件访问权限由部署者配置。

`scripts/hermes-key.mjs` 每次执行只读取 `apiKey`，不使用 `adminKey`。它通过标准输出把 `{access_token, expires_in}` 交给 Hermes，不把密钥写回 YAML 或 `.env`。`expires_in: 65` 是 helper 缓存刷新提示，不是网关密钥真实有效期；具体提前刷新时间由 Hermes 实现决定。

**不要把 helper 的标准输出复制到聊天、日志或工单。** 缺文件、非法 JSON、空密钥等失败只产生固定错误消息，并返回退出码 1。密钥文件始终留在本机，不提交 Git。

## 模型选择与推理档位

打开 Hermes 模型选择器，或在 CLI 使用 `/model`，选择“AI积分网关”及实际返回的模型 ID。不要照抄别人的账号前缀，也不要删除模型 ID 中的斜杠。

`discover_models: true` 从 `/v1/models` 获取启用路由；不写死模型清单，不恢复停用项。Hermes 可能缓存目录，网关启停模型后需刷新目录。添加 Provider 本身不要求覆盖原默认模型，已有会话也不应被迁移到新 Provider。

Hermes 通用 custom Provider 可能默认发送 `reasoning_effort: medium`，但部分 Trae 路由只接受 `low/high/xhigh`，会返回 `400 / reasoning_effort_not_supported`。配置中的 `extra_body.reasoning_effort: null` 覆盖统一档位，由网关/上游按该路由的默认策略处理。

**此方案下，Hermes 的思考强度菜单不逐平台透传。** 这不是全档位适配；未来若增加逐模型映射，应同时验证普通、流式及工具链。该配置仅影响新增 Provider，不修改 DSH 的推理设置或其他 Hermes Provider。

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

## 实现依据

- [Hermes 自定义 Provider 文档](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-providers)
- 对应安装版本的 `hermes_cli/runtime_provider_custom.py`、`hermes_cli/model_switch_providers.py` 和 `plugins/model-providers/custom/__init__.py`。
