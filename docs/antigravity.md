# Antigravity 专用本机协议桥

星桥 AI 网关通过单账号、本机运行的 CLIProxyAPI 将 Antigravity 接到 DSH 和 Hermes。它不是任意第三方中转站配置入口，也不改变 Google 对账号、模型、地区与额度的判定。

```text
DSH / Hermes
    ↓ 网关推理密钥
星桥网关 127.0.0.1:19421/v1
    ↓ 独立桥接密钥
Antigravity 协议桥 127.0.0.1:19431/v1
    ↓ 本机保存的 OAuth + 配置的网络出口
Google Antigravity 上游
```

## 组件和版本

- 网关核心运行环境为 Node.js 24 或更新版本。
- 协议桥配置以 **CLIProxyAPI v8.0.23** 的 v8 配置结构为依据。下载与核对摘要应在安装时完成，不运行来源不明的安装脚本。
- 一个桥实例、一份独立 `auth-dir`、一个平台账号。多账号请使用不同端口、目录、桥接密钥和网关账号 ID；不要把不同账号混在同一桥实例中计算额度。
- Antigravity 原客户端、协议桥、网关和调用方是不同组件；关闭原客户端不代表可以停止协议桥或网关。

上游项目与发行页：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、[v8.0.23](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.23)。桥的第三方二进制不随本仓库分发。

## 1. 准备独立协议桥

将适合当前系统的发行包解压到本机私有目录，保留其许可证。创建仅本机使用的 `config.yaml`，将 `BRIDGE_TOKEN` 替换为独立生成的随机密钥；不要使用网关的 `apiKey` 或 `adminKey`。

```yaml
config-version: 8
server:
  host: 127.0.0.1
  port: 19431
  commercial-mode: true
management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys: ["BRIDGE_TOKEN"]
requests:
  proxy-url: "http://127.0.0.1:7890"
  streaming:
    keepalive-seconds: 15
routing:
  retry:
    request-retry: 0
    max-retry-interval: 0
oauth:
  auth-dir: "C:/GatewayPrivate/antigravity/auth"
  providers:
    antigravity:
      antigravity-credits: false
observability:
  logs:
    debug: false
    logging-to-file: false
    request-log: false
  usage:
    usage-statistics-enabled: false
plugins:
  enabled: false
```

修改路径及代理地址以匹配本机环境；示例不是已配置好的网络出口。`antigravity-credits: false` 避免主动启用桥的付费积分兜底策略。没有设置管理密钥时管理 API 关闭。仍应把整个协议桥目录视为私有数据，不上传它产生的凭据、日志或诊断文件。

通过协议桥自身的 OAuth 登录流程完成账号授权：

```powershell
.\cli-proxy-api.exe -config .\config.yaml -antigravity-login
.\cli-proxy-api.exe -config .\config.yaml --local-model
```

协议桥负责续期其保存的 OAuth。原客户端已经登录不表示桥必然拥有登录态；复制本机原生凭据是版本相关操作，不作为跨平台通用安装步骤。不要将 OAuth 内容交给 DSH、Hermes 或网关下游。

## 2. 配置网关账号和上游

新建本机专用 `bridge-credential.json`，不提交 Git：

```json
{
  "accessToken": "BRIDGE_TOKEN",
  "principal": "a-stable-identifier-for-this-antigravity-account"
}
```

`principal` 必须稳定绑定这一账号；更换桥内账号时使用新网关账号 ID 和新凭据文件，避免混合历史记录。桥接密钥必须与桥配置匹配，而不是填 Google OAuth token。

将以下对象分别合并到现有 `accounts`、`upstreams`，不要覆盖原有数组：

```json
{
  "accounts": [{
    "id": "antigravity-main",
    "label": "Antigravity",
    "platform": "antigravity",
    "enabled": true,
    "credentials": {"kind": "file", "file": "C:/GatewayPrivate/antigravity/bridge-credential.json"},
    "tasks": []
  }],
  "upstreams": [{
    "id": "antigravity-main",
    "kind": "antigravity",
    "accountId": "antigravity-main",
    "enabled": true,
    "sidecarBaseUrl": "http://127.0.0.1:19431/v1"
  }]
}
```

只接受 `http://127.0.0.1:PORT/v1`，拒绝远程地址、用户信息、查询参数、fragment 和其他路径；不跟随 HTTP 重定向。凭据只通过本地请求头交给协议桥，不经环境变量指定的全局 HTTP 代理转发。

可选自动启动：给该上游增加 `sidecar` 对象。先核对可信发行摘要，再计算实际解压后可执行文件的 SHA-256；压缩包摘要与 EXE 摘要不是同一个值。

```json
{
  "sidecar": {
    "autoStart": true,
    "executable": "C:/GatewayPrivate/antigravity/cli-proxy-api.exe",
    "configFile": "C:/GatewayPrivate/antigravity/config.yaml",
    "sha256": "SHA256_OF_THE_EXECUTABLE"
  }
}
```

网关遇到本地连接拒绝时才尝试启动；执行文件摘要变化会阻止启动，需重新核验版本后更新配置。侧车独立运行，关闭网关不自动终止侧车；维护时按进程路径确认后单独停止。不要通过高频重启 DSH 检查侧车。

## 3. 发现、测试和启用模型

使用网关模型目录刷新、体检和导入接口；见 [管理 API](api.md)。模型 ID 来自本机桥实际目录，不照抄演示 ID。

验收至少分为：

1. OAuth 续期成功；账号与项目查询成功。
2. 目录中确实存在该模型。**这一层不代表推理成功。**
3. 普通回复、SSE、工具调用、工具结果回传分别有实测结果。
4. DSH 和 Hermes 各完成真实工具执行闭环。

仅启用实际通过且准备使用的路由。其余配置可保留为停用，不发布到 `/v1/models`。图片输入在当前适配器中不声明支持；统一积分余额未知，显示模型配额未知，不伪造零积分或签到状态。

## 网络出口和故障分类

本地调用入口和上游出口是两段网络。DSH/Hermes 访问回环网关，不需要单独配置美国代理；真正访问 Google 的协议桥仍需满足上游地区与账号要求。

协议桥的 `requests.proxy-url` 可以单独指定出口，也可以复用本机现有代理端口。复用端口时，代理客户端切换节点会影响这个出口；它不等于固定美国专线。要保持其他应用使用香港、仅 Antigravity 使用美国，需准备独立的美国代理监听端口，再把桥指向该端口。

| 错误码 | 含义与处理 |
|---|---|
| `antigravity_region_unsupported` | 上游拒绝出口地区；本机提示切换美国节点后重测，不能把目录可见当成生成可用 |
| `antigravity_auth_failed` | 核对桥接密钥与桥账号登录/续期状态；单独判断哪一段认证失败 |
| `antigravity_rate_limited` | 模型配额或限流；等待重置，不用切节点代替额度检查 |
| `antigravity_bridge_unavailable` | 检查本地端口、运行进程及私有配置 |
| `antigravity_bridge_hash_changed` | 协议桥二进制变化；核对可信版本和实际 EXE 摘要 |
| `antigravity_timeout` | 上游首包超过等待时间；定向复测该模型，不误判为本地桥停机 |
| `antigravity_upstream_error` | 保存脱敏 HTTP 状态并检查协议桥私有诊断，不公开原始凭据 |

## 验证和回滚

```bash
node --test tests/antigravity.test.mjs
npm run check
```

离线测试仅验证协议边界、地区错误分类、脱敏和本地 SSE 工具映射，不代表真实账号模型验收。

回滚前确认配置没有后续变更；停用新增 Antigravity 路由和上游，恢复备份的已改代码及配置，保留其他平台、账本和原生客户端凭据。如果后续已修改其他配置，应只撤销本次新增字段而不是整份覆盖。单独停止由本次安装的协议桥，不删除原客户端账号。
