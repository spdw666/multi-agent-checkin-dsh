<h1 align="center">AI网关</h1>

<p align="center">
  <b>多平台每日权益、账号余额与模型调用，收拢到一个本机网关</b><br>
  AI网关· 原生独立 Windows 桌面应用<br>
  WorkBuddy · Trae · 千问办公 · MiniMax Code · ZCode · 智谱 BigModel · Antigravity 本机桥<br>
  多账号签到 · 积分耗尽切号 · OpenAI 兼容 API · SSE · 工具调用 · DSH bundle · Hermes
</p>

<p align="center">
  <a href="package.json"><img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-blue"></a>
  <img alt="OpenAI Compatible API" src="https://img.shields.io/badge/API-OpenAI_Compatible-412991">
  <img alt="DSH Bundle" src="https://img.shields.io/badge/DSH-Bundle-285BE7">
</p>

> **分发形式：本公开仓库只包含后端、CLI、平台适配器、DSH 插件、测试与文档；原生桌面前端实现与安装包不公开。** 克隆仓库得到的是可运行的无界面服务，可按管理 API 自建前端。
>
> **兼容 ID：** npm 包 `dsh-ai-credit-gateway`、CLI `ai-credit`、Provider `ai-credit` 沿用历史命名，不随产品更名改变；仓库路径暂保留 `https://github.com/spdw666/multi-agent-checkin-dsh`。

## 界面展示

![AI网关：多账号余额、签到与已启用模型总览](docs/images/platform-balances.png)

*用户提供的本机界面原图（文档资产，本次改版未重新截图，仓库不含该前端实现）。图中账号数、已启用模型、签到时间与余额为截图时的个人配置，非新部署默认值或额度承诺；积分、Token、现金与资源包保持各自单位，不合计成统一余额。*

## 目录

[产品定位](#产品定位) · [能力与平台支持](#能力与平台支持) · [架构](#架构) · [源码快速开始](#源码快速开始) · [账号、上游与路由](#账号上游与路由) · [模型真实体检](#模型真实体检)

[接入 DSH](#接入-dsh) · [接入 Hermes](#接入-hermes) · [调用用量与额度明细](#调用用量与额度明细) · [Antigravity 本机协议桥](#antigravity-本机协议桥) · [诊断与常见问题](#诊断与常见问题) · [测试与贡献](#测试与贡献) · [文档导航](#文档导航) · [许可与致谢](#许可与致谢)

## 产品定位

AI网关是**原生独立 Windows 桌面应用**；本仓库公开其中的后端、CLI 与 DSH 插件。后端解决两件事：

1. **每日权益管理**：读取本机客户端登录态，按账号签到、检查每日免费额度或领取免费套餐，结果写入 SQLite 幂等账本。
2. **统一模型入口**：把各上游协议映射为 OpenAI 兼容接口，让 DSH、Hermes 等工具经同一入口调用；工具由**调用端**执行，网关只做协议映射。

边界同样明确：

- **不是第三方 API 中转站**：只对接本项目实现的上游类型，Antigravity 专用协议桥只接受本机地址（`127.0.0.1`），不恢复任意中转站 URL。
- **不做跨平台统一积分**：各平台积分、Token、现金、资源包单位不同，分别展示，不相加成总余额。
- **不做凭据托管**：平台凭据只留本机文件，管理配置只存引用，不进仓库、日志或聊天。
- **未验收即不声称**：图片输入与跨平台统一余额未验收；Antigravity 上游余额只显示为未知模型配额，不虚构 `0`，也不参与签到。

本项目不是 WorkBuddy2API Panel 的 fork：账号池与文档组织参考了该项目，但后端为 Node.js，自有领取账本与统一输出层，代码复用范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不把参考项目的 OAuth 面板、Redis、Docker、成长任务自动化说成本项目已有功能。

## 能力与平台支持

| 能力 | 当前实现 |
|---|---|
| 每日权益 | WorkBuddy / Trae CN / MiniMax Code 签到，千问办公个人版额度检查，ZCode 免费套餐领取；启动检查、每日排程、随机延迟与失败重试，后台存活时执行 |
| 多账号隔离 | `accounts` 列表，每账号独立本机凭据文件与稳定身份绑定，不用全局 token 单例；幂等账本按身份、任务、日期去重并保留回执 |
| WorkBuddy 账号池 | 同模型按配置顺序选备用账号，积分耗尽时切号，成功账号保持使用；管理 API 可指定下一请求账号，不轮询 |
| 模型目录 / 体检 | 已启用上游的模型与能力；`scope=retry` 定向复测历史未通过项，不动路由与启用选择 |
| OpenAI 兼容 | `GET /v1/models`、`POST /v1/chat/completions`，普通与 SSE 共用映射层，按 `targets` 顺序 fallback |
| 工具调用 | 结构化 `tool_calls` 与结果回传；工具在 DSH / Hermes / 调用方本地执行；已输出 SSE 后不重放整段请求 |
| 图片与推理选项 | 按上游声明映射，不统一虚构图片支持或推理档位 |
| 余额与用量 | 余额查询带截止时间，失败返回缓存与 `stale`，未知不当作零；SQLite 记录实际模型、路由、账号、起止与首字耗时、Token、上游计费值，保留失败 / 取消 / 回退尝试 |
| 接入与前端 | DSH bundle（独立 Node worker + 随机端口 loopback shim）与 Hermes 命名 Provider；模型 API 与管理 API 分离，前端可用 React、Vue、原生桌面或其他方案 |

| 平台 | 登录态来源 | 每日权益 | 模型适配与注意事项 |
|---|---|---|---|
| WorkBuddy 国内版 | 本机桌面端，多账号可存独立快照 | 加油站每日签到，奖励以当次回执为准 | 复用 WorkBuddy bridge，模型按当前账号目录查询，快照过期需更新 |
| Trae 国内版 | IDE `storage.json` 及设备身份 | 每日签到，需真实 `deviceId` | SOLO 通道适配；目录内模型可能不允许当前 function/config 调用 |
| Trae 国际版 | 国际版登录态与区域 | 订阅 / 权益检查，不按国内签到实现 | 可扩展区域配置，不承诺所有国际模型已实测 |
| 千问办公 QwenWork | 桌面个人版，切到“我的 AI 团队” | 额度由服务端自动重置，本项目查询核验 | 需本机编码器依赖，不是 Qwen Code CLI 或通义网页版 |
| MiniMax Code | 桌面登录态及原生 OAuth lease，或平台文件凭据 | 每日签到、奖励与余额查询 | 与 MiniMax Agent 网页账号不是同一实现 |
| ZCode | 桌面登录态及设备上下文 | 免费套餐领取 / 查询，人工验证返回 `action_required` | 已实现模型适配，遇验证先在官方窗口完成再重试 |
| 智谱 BigModel | 官方 API Key；资源包查询另需控制台登录态 | 查现金余额、资源包可用量与到期日，不执行签到 | 官方聊天 API；Token / 次 / CNY 不合计 |

TraeCode CN 与 TraeWork CN 若对应同一身份与权益池，保留一个账号启用即可。

## 架构

```text
本机客户端登录态 / 账号隔离文件
             │
       CredentialManager ── 账号身份绑定、过期检查
             │
     ┌───────┴──────────────────────────┐
签到 / 每日权益适配器              模型目录与路由
     │                                  │
SQLite 幂等账本                  平台 bridge / 原生协议 / 官方 API / 本机桥
     │                                  │
管理 API / 记录查询              统一 OpenAI 响应 / SSE
                                        │
                         独立 HTTP 客户端 或 DSH bundle → 调用方执行本地工具
```

独立服务默认监听 `http://127.0.0.1:19421`；DSH bundle 的 worker 用随机端口 loopback shim 与进程内随机 secret。两种入口共享配置与账本，但不是同一监听端口。上游侧：平台适配器直连对应平台，Antigravity 必须先经本机协议桥。

## 源码快速开始

- **Node.js 24+**（内置 SQLite，先确认 `node --version`）、**Git 与 npm**（构建依赖 esbuild）。
- **Windows 优先**：自动读取登录态依赖对应客户端已安装、已登录。
- **Linux / macOS**：核心网关可运行，须自行准备可用凭据；**核心可运行不等于 Windows 原生凭据目录可迁移**，加密登录态、原生 MiniMax lease、浏览器验证与千问编码器都要在目标环境重新准备并单独验证。
- **DSH 按需安装**：独立 HTTP 服务不要求安装 DSH。

```powershell
git clone https://github.com/spdw666/multi-agent-checkin-dsh.git
cd multi-agent-checkin-dsh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -NoStart
notepad config.local.json          # 先启用已登录的平台
node bin/ai-credit.mjs doctor
node bin/ai-credit.mjs start
Invoke-RestMethod http://127.0.0.1:19421/health
```

```bash
# Linux / macOS
bash scripts/install.sh --no-start
node bin/ai-credit.mjs doctor && node bin/ai-credit.mjs start
curl http://127.0.0.1:19421/health
```

脚本只做本机准备，不替你登录平台，也不安装截图里的原生界面。`serve` 前台运行便于看启动错误，`start` 把日志追加到数据目录的 `service.log`；默认数据目录 `./data`，相对配置文件所在目录解析。

```bash
node bin/ai-credit.mjs start | stop | serve | doctor | init
node bin/ai-credit.mjs health --account workbuddy-main
node bin/ai-credit.mjs claim --all        # 每账号逐项看 status / reason / credits
node bin/ai-credit.mjs models | records
```

命令可追加 `--config /ABSOLUTE/PATH/config.local.json`，或设置 `AI_CREDIT_CONFIG`。`doctor` 查本机凭据形状与身份，`health` 再查平台服务端状态，二者不是同一验证。

## 账号、上游与路由

三层配置分离，`config.example.json` 为完整模板，初始化生成 `config.local.json`（示例默认只启用 WorkBuddy 与一条路由，其他账号多为停用，不能照截图推断平台已自动配置）。

```json
{
  "accounts": [{"id": "workbuddy-main", "platform": "workbuddy", "enabled": true,
    "credentials": {"kind": "desktop", "file": "auto"}, "tasks": [{"id": "daily-checkin", "enabled": true}]}],
  "upstreams": [{"id": "workbuddy", "kind": "workbuddy", "accountId": "workbuddy-main", "enabled": true}],
  "routes": [{"id": "workbuddy/deepseek-v4.1-flash", "enabled": true,
    "targets": [{"upstreamId": "workbuddy", "model": "deepseek-v4.1-flash"}]}]
}
```

此段只说明三层关系，**不是可独立使用的完整文件**，模型 ID 需换成当前目录值。`enabled: false` 表示保留配置但停用，路由从 `/v1/models` 与 DSH 发布列表隐藏。平台 token / Cookie 存本机账号文件，管理配置只存引用；初始化生成 `data/api-keys.json`，`apiKey` 用于模型调用、`adminKey` 用于管理操作，用途不同。

**签到语义**：`/admin/claim` 与 `claim` 命令逐账号返回 `status / reason / credits`，HTTP 200 不等于权益已发放；`already` 表示此前已签到或已领取，不是再次发放；批量命令退出码不能替代逐账号结果检查。千问个人额度由服务端自动重置，不需手动签到；ZCode 可能要求人工验证。

**WorkBuddy 多账号池**：用 `POST /admin/workbuddy/capture` 分别保存账号（客户端切号后再调用一次，不编造身份），用 `POST /admin/workbuddy/pool` 配置同模型备用池，用 `POST /admin/workbuddy/switch` 指定下一请求账号（不迁移正在输出的请求）。积分耗尽且未输出内容时才尝试备用账号；`401`、参数错误与普通限流不当作积分耗尽；已输出 SSE 后不换号重放，避免重复工具动作；额度冷却账号在明确刷新确认恢复后才回到候选；不用轮询消耗所有账号。

**上游客户端自动升级**：签到排程、目录刷新与客户端安装升级是不同功能。当前只完成客户端自身自动升级的可行性调研，**网关尚未实现或启用自动安装与升级排程**，设计见 [docs/client-updates.md](docs/client-updates.md)。

## 模型真实体检

目录用于发现，体检用于验证，导入决定是否对外发布，三者不混用。

```powershell
$keys = Get-Content ./data/api-keys.json -Raw | ConvertFrom-Json
$admin = @{ Authorization = "Bearer $($keys.adminKey)" }; $base = 'http://127.0.0.1:19421'
Invoke-RestMethod "$base/admin/model-directory?refresh=1" -Headers $admin
Invoke-RestMethod "$base/admin/model-tests" -Method Post -Headers $admin `
  -ContentType 'application/json' -Body '{"scope":"imported"}'
Invoke-RestMethod "$base/admin/model-tests" -Headers $admin
```

`scope` 可为 `all`（默认）、`imported`（按已启用路由的实际目标，含备用目标与账号池成员去重）、`retry`（历史未通过项，保留有限次先前尝试）。体检**真实请求上游**，可能消耗额度，不修改导入选择与账号池偏好。

- `POST` 返回 `202` 只表示任务已开始，**不等于体检通过**，须轮询 `scope / status / completed / total / summary / results / jobKeys`。
- `results` 可能含保留的历史条目，不要用其总长度算本轮进度；本轮目标以 `jobKeys` 为准。
- 语义：`passed` 四项通过；`partial` 聊天通过但工具链未全通过；`uncertain` 超时待复测；`unavailable` 当前目录或通道不提供；`failed` 附原因。**聊天通过不等于 Agent 工具链通过**，短暂超时也不等于模型永久下线。
- **目录发现不等于生成可用**：部分上游（如 Antigravity）条目带 `verification: unverified`，需按实例实测状态使用。

## 接入 DSH

本项目是 DSH bundle，不只是外部 HTTP 地址。peers 范围为 `>=0.1.7-rc.1 <0.3.0-0`；接入基于具体 DSH Desktop / runtime 版本与 `desktop` profile，不同版本仍需验证宿主契约。**worker 使用独立 Node 24，不把 Electron / DSH 桌面可执行文件当作 Node。**

```powershell
$env:AI_CREDIT_NODE = (Get-Command node).Source
node scripts/install-dsh.mjs --config /ABSOLUTE/PATH/config.local.json
```

安装脚本定位 Windows Desktop CLI、备份 profile、添加 bundle 并同步代码，记录写在 `data/dsh-install/`；**不自动重启 DSH**。其他安装方式见 [docs/dsh.md](docs/dsh.md)：

```bash
dsh plugin --profile desktop add file:/ABSOLUTE/PATH/multi-agent-checkin-dsh
```

已有插件 `dsh-ai-credit-gateway` 时改配置即可，不重复插入：

```yaml
- id: dsh-ai-credit-gateway
  config:
    configFile: /ABSOLUTE/PATH/config.local.json
```

流程：完成账号体检与目录查询 → 导入要发布的路由 → 安装 bundle → 正常重启 DSH → 在 provider 选择模型 → 分别验证普通、流式、工具调用。运行中的目录刷新与宿主首次加载不是同一回事；初始化崩溃先看 worker / 宿主日志。

## 接入 Hermes

Hermes 用命名自定义 Provider 直连本机网关，不需要 DSH 插件：`Hermes → http://127.0.0.1:19421/v1 → 已启用的路由`。在 Hermes 实际使用的 home/profile 中，为 `config.yaml` 添加 `providers.ai-credit`（没有 `providers` 映射时才新建，不追加第二个同名顶层键）；路径示例请替换为自己的 Node、仓库脚本与真实数据目录。

```yaml
providers:
  ai-credit:
    name: AI网关
    base_url: http://127.0.0.1:19421/v1
    api_mode: chat_completions
    discover_models: true
    key_cmd: '"/ABSOLUTE/PATH/node" "/ABSOLUTE/PATH/scripts/hermes-key.mjs" "/ABSOLUTE/PATH/data/api-keys.json"'
    extra_body:
      reasoning_effort: null
```

- **`key_cmd`**：`scripts/hermes-key.mjs` 每次只读 `apiKey`，不使用 `adminKey`，经标准输出交付密钥，不写入 YAML 或 `.env`；缺文件、非法 JSON、空密钥只输出固定错误并返回退出码 1。**不要把 helper 输出复制到聊天、日志或工单。**
- **`reasoning_effort: null`**：Hermes 通用 custom Provider 可能默认发送 `medium`，部分 Trae 路由只接受 `low/high/xhigh`，会返回 `400 / reasoning_effort_not_supported`；`null` 覆盖统一档位，由网关 / 上游按该路由默认策略处理。此模式下 Hermes 思考强度菜单**不逐平台透传**，也不改 DSH 推理设置与其他 Provider。
- `discover_models: true` 从 `/v1/models` 获取启用路由，不写死清单、不恢复停用项，Hermes 侧目录缓存需刷新；保留原默认模型，在模型选择器中选择“AI网关”及实际路由 ID。

完整 YAML、跨平台路径、分层验证与回滚见 [docs/hermes.md](docs/hermes.md)。网关需保持运行，工具执行仍由 Hermes 完成。

## 调用用量与额度明细

模型调用与领取记录分开保存。启用记录后，经网关普通、SSE、工具调用入口发出的请求按实际上游尝试写入 SQLite，来源标记为 `audit`（体检）、`dsh`（worker）或 `api`（独立 HTTP）；同一请求回退到其他账号或模型时，各次尝试共享 `requestId`，但保留各自的实际模型、账号与结果。

- 字段含起止时间、路由、实际模型、账号、上游、请求与首字耗时、输入 / 输出 / 总 / 缓存 / 推理 Token，以及上游返回的积分与计费金额。
- **耗时是模型请求耗时，不是人工会话时长；Token、积分与金额不互相替代。上游未返回的计费字段为 `null`，不补成零、不按 Token 猜测积分。**
- `GET /admin/usage` 支持 `accountId / model / status / from / to / limit / beforeId`，返回 `records / total / nextBeforeId`；`model` 匹配实际上游模型 ID 而非对外路由 ID，`status` 可为 `running / completed / failed / cancelled`，`total` 是筛选范围内的尝试条数，不是独立请求数。
- 带 `accountId` 时附 `balanceChanges`（前次 / 本次核验时间、余额、单位、变化量）。差额包含窗口内消费、领取、套餐到期与客户端活动，**不归因于某一次模型请求**；失败或缓存余额不制造新差额，不同单位不合计。
- 账本只覆盖功能启用后的网关调用，不补造绕过网关或旧版本历史；不保存提示词、回复正文、工具参数或凭据。写入失败不改写聊天结果，后台输出明确的存储错误标记。

余额三态必须区分：**零**是平台明确返回的数值，**未知**是没有可用结果，**缓存余额**带旧核验时间与 `stale`；UI 保留失败原因与缓存时间，不把缺数据显示为零。工具调用只返回定义与参数，由调用方执行。完整字段与分页语义见 [docs/usage.md](docs/usage.md)。

## Antigravity 本机协议桥

Antigravity 上游走**本机专用协议桥**，不是可配置的第三方中转：

```text
网关 (127.0.0.1:19421/v1) → 本机桥 (127.0.0.1:19431/v1) → Google
```

- **桥**：CLIProxyAPI `v8.0.23` 本机桥，监听 `127.0.0.1:19431/v1`；网关为 `127.0.0.1:19421/v1`，端口与用途不同。
- **地址约束**：`sidecarBaseUrl` 只接受 `http://127.0.0.1:PORT/v1`；带用户名密码、查询串、片段或非 loopback 主机一律拒绝（`invalid_antigravity_bridge`）。**只接受 127.0.0.1，不恢复任意第三方中转。**
- **凭据隔离**：Google OAuth 登录态只存在桥自己的本机 auth-dir，网关不读取也不保存；桥连接 key 按账号存放在网关本机账号隔离文件中，作为该账号的 Bearer 使用。**桥 key、网关 `apiKey`、`adminKey` 三者各自独立，不互相复用或互相填写。**
- **可选自启**：`sidecar.autoStart` 需同时提供 `executable`、`configFile` 与 64 位十六进制 `sha256`，缺一不可；启动前校验可执行文件哈希，桥更新后哈希变化会拒绝启动（`antigravity_bridge_hash_changed`），需先自行核对更新；私有配置文件缺失时不启动。
- **出口代理**：桥按自身配置经 HTTP / SOCKS 出口代理连接 Google，**只影响桥的出站，不改系统或全局节点**；复用代理端口时，节点切换会改变桥的实际出口；修改桥本身的代理配置后按其重载机制处理并复测。
- **目录与实测**：桥返回的模型条目标记 `source: antigravity-local-bridge`、`verification: unverified`，**目录发现不代表生成可用**；按实例的模型体检与实际调用结果使用，本项目不声明该上游“全模型已通过”。
- **地区限制**：上游按出口地区拒绝时返回 `antigravity_region_unsupported`，提示改用合适出口后重新测试。**不承诺用反代解除上游地区限制**；具体出口 / 地区复测记录留在部署者自己的验证记录中，不在本 README 维护日期进度。
- **其他错误**：`antigravity_bridge_unavailable`（桥未运行）、`antigravity_auth_failed`（`401`）、`antigravity_rate_limited`（`429`）、`antigravity_timeout`（响应超时）、`antigravity_upstream_error`、`request_cancelled`；错误不反射上游响应正文、账号邮箱、URL 或 token。
- **未验收项**：图片输入与统一积分余额不声称支持；该上游余额显示为未知模型配额，不虚构 `0`，也不参与签到。

完整安装、独立凭据与出口配置见 [Antigravity 接入说明](docs/antigravity.md)。以下为上游字段示意，还需配置对应账号：

```json
{"upstreams": [{"id": "antigravity", "kind": "antigravity", "accountId": "antigravity-main",
  "sidecarBaseUrl": "http://127.0.0.1:19431/v1",
  "sidecar": {"autoStart": false, "executable": "/ABSOLUTE/PATH/to/bridge-executable",
    "configFile": "/ABSOLUTE/PATH/to/bridge-private-config",
    "sha256": "<64 位十六进制摘要，核对桥版本后填写>"}}]}
```

## 诊断与常见问题

```powershell
node bin/ai-credit.mjs doctor
node bin/ai-credit.mjs health --account workbuddy-main
Invoke-RestMethod "$base/admin/doctor" -Method Post -Headers $admin -ContentType 'application/json' -Body '{}'
```

- **413 / body_too_large**：区分字节限制与模型上下文限制。新版 `server.bodyLimitBytes` 默认 `67108864`（64 MiB），旧部署需在本机配置调整（范围 1024–67108864）；管理请求固定 4 MiB，不同步扩大。网关不静默剪裁历史，超限报错含当前字节数与上限；上游另报 context length / token limit 属另一层限制，由调用端上下文压缩处理。
- **打开首页没有管理面板**：这是无界面源码分发，根路径返回服务信息，截图里的原生界面不随包发布，`ui` 不安装或打开面板；用 CLI / 管理 API 或自建前端。
- **签到没成功**：确认账号与任务启用、客户端登录有效，逐账号看 `status / reason`；`already` 是已签到或已领取。
- **Trae 报 config_name / 4001**：模型在目录中不代表当前账号 SOLO function 可调用，查体检 `unavailable / reason` 并停用当前通道不提供的条目。
- **千问报 encoder failed / INVALID_TOKEN**：检查 `QWENWORK_PYTHON`、Python 依赖与自有 `QWENWORK_WASM`；编码器缺失与 token 过期是不同故障，不要用通义网页或 Qwen Code CLI 登录态替代。
- **principal_changed**：网关绑定账号 ID 与稳定身份以防串号；新账号走保存 / 新增流程，明确重绑时用 `/admin/rebind` 并核对身份。
- **迁到 Linux VPS**：核心服务可运行，但 Windows 加密登录态、原生 lease、浏览器验证与编码器不自动迁移；默认只监听 loopback，改监听地址时同时调整 `host / allowRemote` 并管理网络入口。
- **目录很多、DSH 里只有几款**：目录发现与导入发布分离，只发布已启用路由，先看 `/admin/model-directory` 再导入。

反馈问题时给出平台、客户端版本、路由 ID、错误码、普通或流式、工具调用阶段与去密日志；**不要提交 token、Cookie、运行密钥、账号快照或个人数据库**。

## 测试与贡献

```bash
npm ci
npm run check          # 构建 + 完整离线回归（模拟上游）
```

分层验收建议：

```bash
node --test tests/antigravity.test.mjs          # 本机桥地址约束与错误分类
node --test tests/hermes-key.test.mjs           # 凭据 helper，只用临时虚构文件
node --test tests/sqlite-concurrency.test.mjs   # 账本并发与冷启动竞争
```

离线回归覆盖普通 / SSE / 工具调用与结果回传、跨进程幂等、账号池与手动切换、余额超时与 `stale`、用量账本与回退 / 取消、分页筛选与管理认证、Hermes 凭据 helper、Antigravity 本机桥约束。**离线回归不接触真实账号，不能由此推断每个账号 / 地区 / 模型已通过**；实例验收由部署者用自己的登录态执行 doctor / health / 模型体检与协议探针并记录结果（如 Antigravity 由本机桥按实例实测状态使用）。CI 在 Ubuntu 与 Windows 运行完整检查，并在每个平台额外执行多轮冷启动竞争验证（可用 `SQLITE_STRESS_ROUNDS` 加强）。

贡献代码前确认检查通过；新增平台能力说明清楚“目录声明 / 模拟测试 / 真实调用”三类证据；改接口或任务行为时同步配置示例与文档。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/api.md](docs/api.md) | 管理契约：鉴权、模型与管理端点、请求体上限、前端注意事项 |
| [docs/usage.md](docs/usage.md) | 用量 API 字段、分页、计费与余额变化语义 |
| [docs/dsh.md](docs/dsh.md) | DSH 挂载、profile 与插件配置 |
| [docs/hermes.md](docs/hermes.md) | Hermes Provider、`key_cmd`、推理档位、分层验证与回滚 |
| [docs/model-retry.md](docs/model-retry.md) | 定向复测未通过模型 |
| [docs/bigmodel.md](docs/bigmodel.md) | 智谱官方模型与资源包查询 |
| [docs/client-updates.md](docs/client-updates.md) | 客户端自身自动升级调研（尚未实现） |
| [docs/images/platform-balances.png](docs/images/platform-balances.png) | 界面展示图（文档资产，不含前端实现） |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方模块来源与许可证 |

## 许可与致谢

原创实现采用 [MIT](LICENSE)；第三方模块保留各自版权头、完整许可证与来源，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `vendor/`。下表区分代码复用、独立外部组件与设计 / 协议参考；列入致谢不表示相关项目代码均被打包到本仓库：

| 项目 | 使用方式 |
|---|---|
| [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | 复用 WorkBuddy 上游 bridge 与 DSML 相关模块，保留 MIT 与来源记录 |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | 复用设备身份、目录、区域、SOLO bridge 与签到相关模块；统一输出层由本网关实现 |
| [hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api) | 上述 WorkBuddy DSML 模块的移植来源，随上游 notices 保留 |
| [spirodelazz/ide-daily-checkin](https://github.com/spirodelazz/ide-daily-checkin) / [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin) | 复用 WorkBuddy 凭据读取助手，不执行其成长任务或抽奖流程 |
| [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) | 复用三个上下文模块，具体提交与改动见 `vendor/zcode-context/NOTICE.md` |
| [wicm84266964/Buddy2api](https://github.com/wicm84266964/Buddy2api) | 千问协议助手参照，完整许可证随 `vendor/qwenwork_ref/` 保留 |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | 参考账号池、耗尽与限流分类、冷却恢复及本 README 的信息组织；未移植 Go 服务、Web UI 或自动成长任务 |
| [wangmingdong/workbuddy-signin](https://github.com/wangmingdong/workbuddy-signin) | 参考 MiniMax 签到协议与界面信息组织，本网关独立实现 Node 适配 |
| [Shuffle-1992/TraeSign](https://github.com/Shuffle-1992/TraeSign) | 参考 ZCode 登录态形状与官方验证流程 |
| [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | 参照官方模型目录、Mavis Messages 与 Matrix 余额协议，独立实现 OpenAI 映射 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 对照 DSH bundle / provider / PiAiAdapter 宿主契约 |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Antigravity 接入使用的独立本机协议桥，负责上游认证与协议转换；本网关实现本地桥适配，桥的源码、二进制及凭据不随本仓库分发，安装时保留其 MIT 许可证 |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 对照自定义 Provider、模型发现与工具调用契约完成接入；Hermes 独立运行，本仓库未复制或打包其 Agent 实现 |
| [hucuyuu/zhipu-balance](https://github.com/hucuyuu/zhipu-balance) | 参考智谱现金余额查询端点线索，本网关独立实现请求与字段归一化，未复制其程序 |

感谢上述项目作者与贡献者。本仓库借鉴功能分组、部署步骤与 FAQ 的文档结构，不复制其他项目的功能承诺；上游代码、平台服务与本项目分别维护，具体功能以本仓库实现与实际回执为准。
