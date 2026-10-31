# AI积分网关

**自己的账号、每日权益与模型入口，一个本机工作台。**

AI积分网关连接你已登录的桌面客户端与已配置的官方 API，集中查看账号、余额、每日领取、WorkBuddy 任务和模型路由，再通过 OpenAI 兼容接口接入 DSH、Hermes 或其他客户端。

[下载 WebView2 便携版](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip) · [三步上手](#三步开始使用) · [功能与平台](#支持的平台与能力边界) · [完整使用手册](docs/getting-started.md) · [隐私与发行核对](docs/release-privacy.md)

> **先看这三点：**下载包不附个人账号，首次打开是空工作台，需要自己登录或导入自己的账号；平台权益由官方账号与当前服务决定；模型目录、余额、签到回执和真实调用是四种不同证据。

**本页导航：** [选择入口](#选择你的入口) · [三步上手](#三步开始使用) · [十二个页面](#新工作台四个主视图八个管理内页) · [能力矩阵](#支持的平台与能力边界) · [账号与模型](#账号备份与模型发布别混淆) · [数据与更新](#本机数据备份与回滚) · [版本校验](#版本下载与校验) · [源码构建](#快速开始) · [故障排查](#诊断与常见问题)

## 选择你的入口

| 入口 | 适合谁 | 获取与启动 |
|---|---|---|
| **WebView2 工作台 · 便携预览版** | 想直接使用新界面的 Windows 用户 | [下载 Windows x64 ZIP](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip)，**完整解压**，双击 `AI积分网关.exe` 或 `启动新版工作台.cmd`。自带 Node.js 与后端，普通用户无需 npm |
| **WinForms 原生界面** | 继续使用原生桌面、已有原生部署的用户 | 保留原生界面与配置方式；源码默认入口仍是 [`desktop/build.ps1`](desktop/build.ps1)，[原生构建说明](docs/getting-started.md#winforms-原生桌面) |
| **Node.js 服务 / CLI** | 自行部署、接入客户端或使用管理 API | [源码启动](docs/getting-started.md#源码启动后端)、[Linux 部署](docs/linux.md)、[API 手册](docs/api.md)；浏览器基础管理页与完整桌面工作台分开说明 |

Web 版是**独立实例**，不自动接管原生版账号、配置或快捷方式。新增可选 Web 构建没有切换默认 WinForms builder。已有原生用户按自己的需要选择；不要把两个实例的数据目录混在一起。

### Web 版运行环境

- Windows **10/11 x64**、.NET Framework **4.8+**。
- Microsoft **WebView2 Evergreen Runtime**。普通 Edge 浏览器与 Runtime 不等同；启动时会检测实际 Runtime。
- 缺少 Runtime 时，可按提示主动运行随包附带的 Microsoft 签名 bootstrapper，或从[微软官方下载](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section)。安装 Runtime 需要联网；已安装时不重装。
- Node.js **22.23.3** 已随便携包附带；平台自己的官方客户端、账号与可选集成依赖仍按对应平台准备。

## 三步开始使用

### 1. 打开工作台，准备自己的账号

完整解压 ZIP，启动工作台。在官方平台完成自己的登录，再到“账号管理”选择支持的登录来源；WorkBuddy 可添加官方登录、保存客户端当前账号或导入自己的 JSON/ZIP 备份。先核对平台、国内/国际版与账号身份，再看余额。**首次启动不会自动导入其他软件的登录，不会自动签到或测试模型。**

### 2. 选择模型，先验证一小组

到“路由配置”发现模型目录，选择要发布的模型并保存路由。目录出现只说明发现了条目；需要时对选中路由做定向体检，分别查看普通回答、SSE、工具调用与工具结果回传。体检可能产生真实调用和额度消耗，不默认全量执行。

### 3. 接入调用端，再开启所需自动化

使用本实例的 `/v1` 地址、模型密钥和完整路由 ID，按[通用客户端](docs/openai-clients.md)、[DSH](docs/dsh.md)或[Hermes](docs/hermes.md)说明接入。先完成一次你需要的真实任务，再按需启用计划领取、WB 任务或账号轮换；这些开关彼此独立。

**便携版首次使用 `port=0`，系统分配的端口在重启后可能变化。**长期接入 DSH/Hermes 等外部客户端前，先在“业务偏好”设置未占用的固定端口，重启本便携版后台，再配置客户端。查看 `/health` 只能确认后台在线，不代表账号或模型验证已通过。

## 新工作台：四个主视图，八个管理内页

| 页面 | 主要用途 |
|---|---|
| **总览** | 查看平台状态、余额摘要、任务回执与后台状态 |
| **平台与账号** | 按平台浏览目录、搜索账号，常驻详情中分别核对登录、余额与权益 |
| **模型路由** | 查看已发布模型及其供给，不因浏览页面改动实际选择 |
| **任务记录** | 从记录与回执追踪结果，不把一次提示当作服务端结算 |
| **账号管理** | 添加、编辑、启停账号，配置登录来源和签到任务 |
| **路由配置** | 管理上游、免费平台入口、模型导入/移出、优先级、同模型接力与定向体检 |
| **领取记录** | 检索领取结果与账本明细，区分既有领取、本次新增和待核验 |
| **业务偏好** | 计划、监听地址/端口、请求与接力策略；高级项按需配置 |
| **请求诊断** | 定向身份检查、路由预览和请求详情，区分认证、能力与上游错误 |
| **WorkBuddy 账号池** | 账号详情、积分包、任务、官方登录、切换、积分调用开关、交换备份与轮换 |
| **软件更新** | 检查客户端版本和状态，打开已登记客户端或创建快捷方式；不自动下载安装客户端升级 |
| **运行中心** | 模型健康、应用独立密钥、会话策略、到期日历与通知设置 |

管理功能在 Web 内页完成；导出保存等必要系统文件对话框由宿主处理。新界面带平台标识、目录与常驻详情、键盘选择和命令面板。界面变化不代表新增了上游权益或所有模型都已通过测试。

## 支持的平台与能力边界

### 能力矩阵

| 能力 | 已实现的产品入口 | 使用时的边界与核对点 |
|---|---|---|
| 账号与凭据 | 桌面登录读取、私有文件引用、特定平台官方登录、WB 账号交换 | 来源与版本对应；普通展示 DTO 不批量返回凭据；账号有效性另做核对 |
| 每日权益 | 对已实现的平台查询、领取、排程与回执账本 | 资格、活动窗口和结算由官方返回；无签到、待核验、此前已领、本次新增分开展示 |
| WB 账号池 | 独立登录快照、积分包、任务、积分调用开关、轮换、切换与可选迁移 | 接受任务、执行任务、领奖是不同动作；关闭进度窗口不等于取消后台任务 |
| 模型与调用 | 目录发现、选择发布、稳定路由 ID、普通/SSE/工具调用链路 | 目录不是全模型验收；不同型号、地区、套餐及工具组合分别验证 |
| 同模型接力 | 兼容供给的优先级、跳过与故障归类 | 保持同款/同版及请求约束；已交付内容或工具结果后不重放整个请求 |
| 诊断与运行 | 请求元数据、模型体检、用量账本、会话策略、通知 | 体检按选择执行；用量估算与官方余额来源分开；敏感原始内容不用于公开反馈 |
| 客户端接入 | OpenAI 兼容 API、DSH bundle、Hermes 命名 Provider | 网关在线、客户端配置生效、真实工具闭环是不同验证层 |
| 发布与隐私 | 独立便携目录、空配置模板、固定依赖校验、发行文件清单 | 下载原件与首次运行产生的个人数据分开；公开审计方法和本轮状态见[隐私说明](docs/release-privacy.md) |

### 专用平台与接入类型

以下名称与类型来自公开源码的适配器注册和分发，不是某台机器的账号数量，也不是实时免费额度清单。

| 平台 / 类型 | 用途与说明 |
|---|---|
| WorkBuddy `workbuddy` | 账号池、积分与任务、模型目录和调用；[完整账号池手册](docs/wb-account-pool.md) |
| Trae 国内/国际 `trae` | 官方登录态、SOLO/目录与调用能力分开核对；[思考输出说明](docs/trae-reasoning-only.md) |
| Qoder `qoder`、CodeBuddy `codebuddy` | 账号显式区分国内/国际版；[桌面平台手册](docs/desktop-platforms.md) |
| WorkBuddy AI `workbuddyai`、Cline `cline` | 使用各自适配器和当前官方能力；共享领取/计费主体的展示不重复相加 |
| CodeArts Agent `codearts` | 已公开的登录读取、活动查询/领取、模型接入；[适配说明](docs/provider-codearts.md)与[验证说明](docs/codearts-validation.md) |
| LobsterAI `lobster`、小浣熊 `raccoon`、Loomy `loomy` | 桌面账号、权益与模型能力按各平台实现；[来源与归属](docs/provider-attributions.md) |
| 千问办公 `qwenwork`、MiniMax Code `minimax` | 按账号资格核对目录、用量与调用；服务端自动重置额度不伪装成手动签到 |
| ZCode `zcode` | 标准代理、本机登录与精确目录；可选代理需单独准备，[接入说明](docs/zcode.md) |
| BigModel `bigmodel`、NVIDIA NIM `nvidia` | 官方 API、私有 Key 与额度来源；[BigModel](docs/bigmodel.md)、[NVIDIA](docs/nvidia-source-notes.md) |
| Antigravity `antigravity` | 明确的本机 loopback 桥接；独立桥和登录不随网关打包，[说明](docs/antigravity.md) |
| OpenCode Zen `opencode` | 官方 CLI 的免费文本桥与当前目录，[纯文本契约](docs/opencode.md) |
| 固定官方 API 注册表 `freeapi` | 例如 Cloudflare、OpenRouter、SiliconFlow；按平台注册条件配置自己的 Key，不接任意中转 URL，[免费平台](docs/free-providers.md)与[Key 录入](docs/free-provider-key.md) |
| 即梦、可灵、小云雀、海螺、Liblib Art、Vidu、PixVerse | 每日积分/权益的独立领取适配，不作为自动生成图像或视频的承诺，[视频每日权益](docs/video-daily.md) |

平台注册、免费资格、目录可见、余额读取、签到、推理、SSE 与工具闭环分别判断。当前状态以你的账号和官方响应为准，不按注册条目数量推导“全部可用”。

## 账号备份与模型发布，别混淆

| 操作 | 实际效果 |
|---|---|
| **导入 / 导出账号** | WB JSON、ZIP 或兼容 `switch-json` 的登录快照交换。先预览、选条目、确认提交；导出会生成含登录数据的备份文件 |
| **导入模型 / 发布模型** | 启用选定路由，使其出现在调用端的模型列表，不导入账号凭据 |
| **“导出选中模型” / 移出模型** | 既有按钮名指取消模型导入、停用选定路由，**不生成账号或模型备份文件** |
| **停用账号 / 暂停积分调用** | 控制账号或 WB 推理候选，不等同于删除凭据、移出模型、停止排程或取消已运行任务 |
| **轮换 / 接力** | 轮换影响下一次候选偏好；接力处理同一请求交付前的兼容供给故障 |

账号导出物包含真实凭据，应只保存在自己的私密备份位置；普通预览与账号列表的脱敏展示不代表导出文件也已脱敏。详见 [WB 账号交换](docs/WB_ACCOUNT_TRANSFER.md)、[轮换](docs/WB_ROTATION.md)和[同模型接力](docs/model-relay.md)。

## 本机数据、备份与回滚

| 动作 | UI | 本实例后台 |
|---|---|---|
| 点击主窗口 X | 收至托盘 | 继续运行 |
| 托盘“退出窗口，后台继续” | 退出 UI | 继续运行 |
| 底部“暂停后台” | 保留窗口 | 暂停本实例；之后手动启动 |
| 停止后台并退出 | 退出窗口 | 请求停止本实例，按各操作收尾规则处理 |

Web 便携版默认使用 `user-data/config.local.json`、`user-data/data`、`user-data/webview-profile` 与 `user-data/memory`；解压目录不可写时，改用 `%LOCALAPPDATA%/AiCreditGatewayWebPortable/<目录身份哈希>`。WinForms 的默认配置位置与便携版不同，见[数据位置表](docs/getting-started.md#数据位置与更新)。

更新前先确认实际配置与数据位置，暂停该实例后台、退出 UI、备份数据，再替换程序文件。保留自己的账号、密钥、路由、profile 与历史；首次运行后的 `user-data` 不属于可公开分发原件。下载新包不是迁移账号，也不是自动升级所有官方客户端。

## 版本、下载与校验

| 项目 | 当前公开发行 |
|---|---|
| 后端产品版本 | **0.8.1**，公开基线加便携路径适配；不夹带其他分支的本机未发布功能 |
| Web UI 版本 | **0.8.1-web.1** |
| Web 预览标签 | [`v0.8.1-desktop-webview2.1`](https://github.com/spdw666/multi-agent-checkin-dsh/releases/tag/v0.8.1-desktop-webview2.1) |
| Windows x64 附件 | `AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip`，**43,568,706 字节** |
| ZIP SHA-256 | `a2693c8492622689962bdef87787e74560fa6ea1911090f8d66acd0b702cf81d` |
| 校验与构建资料 | [SHA256SUMS](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/SHA256SUMS)、[BUILD-INFO.json](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/BUILD-INFO.json)、包内 `checksums.sha256` |

```powershell
Get-FileHash -Algorithm SHA256 .\AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip
```

核对下载附件名、完整 SHA-256 和文件大小；不要把旧的 `dsh-ai-credit-gateway-0.8.1.tgz` 当 Windows 桌面包。原 `v0.8.1` 后端资产保持独立。源码、SDK、Node、bootstrapper pin 和编译输入的说明见 [Web 分发手册](docs/webview-desktop.md)。

## 快速开始

仅运行便携 ZIP 不需要构建。源码后端最低 Node.js 22.23.3；Web 便携构建固定使用官方 **22.23.3 x64**，还需要 Windows .NET Framework 编译环境。WebView2 SDK、bootstrapper 与第三方许可有固定来源及 hash。

```powershell
git clone https://github.com/spdw666/multi-agent-checkin-dsh.git
Set-Location multi-agent-checkin-dsh
npm ci
npm run build
# 选择其一；两者默认不互相替换
.\desktop\build.ps1 -BundleCore -NodeExecutable (Get-Command node.exe).Source
.\scripts\build-webview-desktop.ps1 -BundleCore -NodeExecutable (Get-Command node.exe).Source
```

[后端与原生启动步骤](docs/getting-started.md#源码启动后端) · [Web 构建/打包](docs/webview-desktop.md#从干净源码构建) · [Linux](docs/linux.md) · [API](docs/api.md)

## 诊断与常见问题

请求诊断台提供 **路由预演** 与 **接入生效检查**，分别核对路由候选、实际供给和客户端当前加载状态。网关在线、配置已保存、客户端已生效、真实工具闭环仍是不同结果；操作入口见[原生操作与状态说明](docs/diagnostics-and-readiness.md)。

Web 版仍标为预览。已做源码/合同与 mock 回归、Windows 构建、中文空格路径空账号首启、独立配置/profile/端口和退出生命周期检查；这不等于每个平台登录、全部模型、所有官方权益或全新 Windows 环境都已验证。**已有 Runtime 的 Windows 验收，不记作缺 Runtime 的全新虚拟机安装已通过。**本轮发行隐私复核的结果和证据范围见[隐私与发行核对](docs/release-privacy.md)。

| 遇到的问题 | 先核对什么 |
|---|---|
| 打不开新界面 / 缺 Runtime | 是否完整解压、Windows x64、.NET 4.8、实际 WebView2 Runtime；[启动排查](docs/webview-desktop.md#启动排查) |
| 工作台没有账号 | 首启就是空配置；登录自己的平台，核对正确实例与版本，再添加或导入 |
| 客户端连不上，后台却正常 | 本实例地址、端口、模型密钥、完整路由 ID；port=0 重启后可能变化 |
| 目录有模型却调用失败 | 登录、资格、目录能力、上下文与工具分别查；[模型复测](docs/model-retry.md)、[诊断与预演](docs/diagnostics-and-readiness.md) |
| ZCode 返回 3012 / 异常活动拦截 | 多为请求形状与当前官方客户端不一致：应用版本头、system 块 0/1 文本、恰好 3 块、会话类型四项各自生效；[四重指纹](docs/zcode.md#3012冷却与诊断) |
| 余额存在但没有“本次新增” | 余额与领取结算分开；[积分状态](docs/points-state-and-window-recovery.md) |
| 401 / 413 / 等待很久 / 流中断 | [请求可靠性](docs/reliability.md)、[Windows 流清理](docs/runtime-reliability.md)、[请求策略](docs/dsh-request-policy.md) |
| WB 任务窗口关闭后仍在运行 | UI 等待、后台执行与取消各有生命周期；[后台任务手册](docs/WB_TASK_EXECUTION.md) |

反馈时附版本、脱敏错误码、操作入口、发生时间和可复现步骤；不要附账号导出包、凭据文件、带管理状态的 URL 或未审查的个人截图。更多情形见[使用手册](docs/getting-started.md#故障排查)。

<details>
<summary><strong>进阶使用与原生兼容入口</strong>：架构、WB、客户端、请求预算、排程与配置（按需展开）</summary>

这些摘要保留原生教程与既有后端契约的术语，完整步骤迁至[使用手册](docs/getting-started.md)和对应专题。它们不是新 Web 页面数量，也不是新增上游权益。

## 产品定位与架构

客户端 → 稳定路由 → 兼容供给 → 官方服务，是本项目的调用方向；账号、上游和路由分别管理。本机 Node 服务负责凭据引用、领取账本、模型分发和诊断，WinForms 与 WebView2 都是调用同一管理契约的展示/操作层。Web 便携版拥有独立配置与后台身份，不自动读取另一安装实例的账号。DSH worker 与桌面 HTTP 后台也可能是不同进程，更新后分别核对载入版本，而不是只看源码文件已替换。

## Windows 原生桌面

原生源码入口仍是 `desktop/AiCreditDesktop.cs` 与 `desktop/build.ps1`，不是 Web 专用 wrapper。先构建后端，编译 EXE；需要独立运行目录时选择 `-BundleCore`，仅编译界面不等于已经包含 Node 与后端。原生实际配置可能在 LocalAppData，也可能通过显式参数覆盖；更新前确认真实使用位置。完整命令、启动参数、独立输出与回滚见[原生说明](docs/getting-started.md#winforms-原生桌面)，已有原生部署不因新增 Web 发行而切换默认入口。

## 九个页面

“九个页面”是旧原生教程的导航称呼，保留用于查阅原生操作；本页前文的新 Web 工作台实际为四个主视图与八个管理内页。原生的积分总览、账号管理、模型路由、领取记录、偏好设置、WB 账号池等术语可按用途映射到新内页；活动洞察属于用量/账本相关视图，不应被数作新 Web 的额外页面。积分总览排除 WorkBuddy，WB 的余额和积分包在独立账号池里核对。布局名称变化不改变现有账号、路由 ID 或账本语义。

## wb帐号池详解

wb帐号池显示身份与版本、登录期限、封禁依据、积分包、任务和积分剩余 / 总额。`401/403` 不等于官方封禁：认证拒绝、用户标记与官方明确证据分别记录。接受、执行、达标与领奖各有回执；`manual_action_required` 保留所需官方操作，不制造完成。可选迁移保留原文和本地副本，`cloudSyncConfirmed:false` 不声称云端同步；`autoMigrateSessions`、`autoTasks` 和轮换各自配置，详见[账号池](docs/wb-account-pool.md)及[执行器](docs/WB_TASK_EXECUTORS.md)。

## 同模型自动接力

接力发生在同一请求内容交付前，按明确错误、可用额度和兼容供给顺序选择目标，不是把整个模型池无差别重试。WB 模型只接 WB，并保留版本、型号、上下文、工具集合、输入历史与显式预算；其他分区独立处理。已产生正文、推理或工具调用之后不整体重放。账号轮换则影响下一次候选偏好，不代表当前请求已实时换号。策略、候选跳过与真实尝试的区别见[同模型接力](docs/model-relay.md)、[可用性](docs/relay-availability.md)和[思考档位](docs/relay-reasoning.md)。

## OpenAI 兼容客户端接入

客户端使用本实例 `/v1` 地址与推理 `apiKey`，模型列表来自 `GET /v1/models`，普通聊天和 SSE 使用 `POST /v1/chat/completions`。鉴权形状为 `Authorization: Bearer TOKEN`，这里的 TOKEN 是占位符；管理 `adminKey` 与推理密钥分开。模型名填完整路由 ID，不用中文显示名代替。首次先验证一条所需路由，再按用途验证工具调用、工具执行回填与最终回复；具体示例及差异见[通用客户端](docs/openai-clients.md)。

## DSH 与 Hermes 接入

DSH 通过 bundle 和 `ai-credit` Provider 接入，`discover_models` 控制模型发现；既有 profile、默认模型和工具配置按你的选择保留。Hermes 使用独立命名 Provider，按文档设置 `key_cmd` 等取钥方式，不覆盖其他厂商 helper。两者都需要核对正确实例、固定端口、路由和密钥，配置写入、服务健康与真实任务闭环分别验证。安装、预算、客户端重载与回滚见 [DSH](docs/dsh.md)、[DSH 请求策略](docs/dsh-request-policy.md)及 [Hermes](docs/hermes.md)。

## 上下文、工具、推理与超时

上下文窗口、默认输出预算、HTTP 请求体字节和端到端时间截止是不同约束。`bodyLimitBytes` 不是 token 上限；`modelRequestTimeouts` 是精确路由预算，不等于所有平台官方期限。模型元数据保留官方、本地配置和观察来源，不静默压缩输入或降低显式输出。工具支持也要验证实际声明、执行和回填，目录上的标签不是完整客户端验收。重试由单一层拥有，接力时保留兼容请求；详见[可靠性](docs/reliability.md)、[目录](docs/model-directory.md)和[流清理](docs/runtime-reliability.md)。

## 每日签到与自动刷新

刷新是查询，签到是领取，任务是完成对应功能；三者分别核对。计划任务、启动检查、WB 自动任务和轮换不共享一个总开关，首次便携配置保持关闭。官方自动重置不记作本机新增领取，既有回执也不当作本轮奖励。活动日、自然日和窗口变化按平台协议处理；后台暂停、关机或未登录时，不按计划时间推定执行。详细回执、重查和无签到/待核验语义见[每日权益](docs/video-daily.md)与[状态说明](docs/points-state-and-window-recovery.md)。

## 配置参考

通用配置为 `accounts → upstreams → routes` 三层引用，平台和账号类型对应，凭据使用本机私有引用而不是内嵌到公开配置。服务字段包括监听、`bodyLimitBytes` 和 `modelRequestTimeouts`；排程与 WB 任务各自控制。接力的 `reserveCredits`、`reservePercent` 和余额新鲜度是本地策略，不当作官方剩余额度。`account-deletion-backups` 等目录可能含敏感备份。完整字段和示例见[配置速查](docs/getting-started.md#配置字段速查)、[配置示例](config.example.json)及[API](docs/api.md)。

## 测试、发布与贡献

源码可执行 `npm ci`、`npm run check` 和文档合同测试。前台启动输出 `GATEWAY_READY` 只证明服务就绪；离线合同、构建、真实官方结算与客户端工具闭环分开记录。Web 专用 CI 与既有后端/原生检查并行保留，不通过 CI 执行真实账号领取。改功能同步文档、能力边界、来源与测试，保留无关并发修改。发布还要核对远端提交、附件、完整 hash 和实际下载；个人配置、账号导出、数据库、日志及真实状态截图不进入新公开提交。

</details>

## 文档导航

| 主题 | 手册 |
|---|---|
| 新人、日常操作、数据与升级 | [完整使用手册](docs/getting-started.md)、[Web 发行](docs/webview-desktop.md)、[隐私核对](docs/release-privacy.md) |
| WB 账号与任务 | [账号池](docs/wb-account-pool.md)、[账号交换](docs/WB_ACCOUNT_TRANSFER.md)、[任务进度](docs/WB_TASK_EXECUTION.md)、[真实执行器](docs/WB_TASK_EXECUTORS.md)、[轮换](docs/WB_ROTATION.md) |
| 模型与接力 | [目录与验证](docs/model-directory.md)、[复测](docs/model-retry.md)、[接力](docs/model-relay.md)、[可用性](docs/relay-availability.md)、[思考档位](docs/relay-reasoning.md)、[渠道校验](docs/workbuddy-channel-reliability.md) |
| 客户端 | [OpenAI 兼容](docs/openai-clients.md)、[DSH](docs/dsh.md)、[DSH 请求策略](docs/dsh-request-policy.md)、[Hermes](docs/hermes.md)、[FleshOut](docs/fleshout-sync.md) |
| 平台与权益 | [桌面平台](docs/desktop-platforms.md)、[官方 API 平台](docs/free-providers.md)、[Key 录入](docs/free-provider-key.md)、[视频每日权益](docs/video-daily.md)、[独立每日协议](docs/video-independent-daily.md) |
| ZCode | [标准代理接入](docs/zcode.md)，含 3012 的四重内容指纹与诊断顺序 |
| 诊断与运行 | [API](docs/api.md)、[用量](docs/usage.md)、[运行中心](docs/operations-center.md)、[客户端更新](docs/client-updates.md)、[性能与取消隔离](docs/performance-and-correctness.md) |
| 全部已有专题 | [专题索引](docs/getting-started.md#专题手册索引)，保留原主页的完整后端专题入口 |

## 许可与致谢

原创实现采用 [MIT](LICENSE)；复用代码、可选独立组件和平台素材保留各自许可与归属。[第三方声明](THIRD_PARTY_NOTICES.md)、[适配归属](docs/provider-attributions.md)、[平台图标来源](docs/platform-icon-sources.md)和[完整致谢](#许可与致谢)分别列明。可选 ZCode 标准代理 runtime 的许可与历史上下文组件不同，以对应第三方声明为准。平台商标和图标不视为本项目原创品牌资产。

兼容名称继续保留：npm 包 `dsh-ai-credit-gateway`，CLI / DSH Provider `ai-credit`。平台、参考项目与本项目各自维护；功能以当前公开实现、你的账号资格和实际服务端结果为准。


<details>
<summary>完整上游与设计参照致谢</summary>

原创实现采用 [MIT](LICENSE)。可选 ZCode 标准代理使用的上游 v4.8.5 runtime 采用 **CC-BY-NC-SA-4.0**，与历史 `vendor/zcode-context` 固定提交的 MIT 声明分开记录，不因本仓库 MIT 声明而变更。第三方保留版权头、完整许可证、固定来源与修改说明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。代码复用、独立组件与设计/协议参照分开记录，不把上游整项目功能当成本项目功能。

| 项目 | 使用方式 |
|---|---|
| [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) / [hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api) | WorkBuddy bridge / DSML 复用，保留 MIT 与解析器来源 |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | 身份、目录、区域、SOLO bridge 与签到模块 |
| [spirodelazz/ide-daily-checkin](https://github.com/spirodelazz/ide-daily-checkin) / [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin) | 本机凭据助手，不直接执行其成长/抽奖 |
| [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch) | 登录/交换格式、账号整理、会话复制、到期轮换和 CLI 存活门控参照；独立适配 Node/WinForms，范围见功能对照，不冒称其全部客户端切换/悬浮窗/自动更新 |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | 池、额度/限流、任务协议与卡片组织，未移植 Go/Web UI |
| [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | CodeArts/小浣熊续期、额度与分类参照，不复制匿名渠道或整仓承诺 |
| [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi) / [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) | 同款供给、免费平台与活动组织，未复制程序/素材 |
| [ZlaxeyX/workbuddy-auto-checkin](https://github.com/ZlaxeyX/workbuddy-auto-checkin) | 每日幂等/计划任务参照，未照搬旧端点 |
| [wangmingdong/workbuddy-signin](https://github.com/wangmingdong/workbuddy-signin) | MiniMax 签到与积分卡片组织 |
| [Shuffle-1992/TraeSign](https://github.com/Shuffle-1992/TraeSign) | ZCode 登录形状与验证流程 |
| [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) | 历史三个上下文模块保留原提交 MIT 声明与 vendor NOTICE；可选完整标准代理固定 v4.8.5 / CC-BY-NC-SA-4.0，许可与改动另记 |
| [wicm84266964/Buddy2api](https://github.com/wicm84266964/Buddy2api) | 千问协议助手与完整许可 |
| [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | 官方目录/Mavis/Matrix 核对，独立统一映射 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | bundle / Provider / PiAiAdapter 契约 |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 独立 Antigravity 本机桥，不打包 |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 可选执行点适配与 UI 差异补丁，保留 MIT；不打包完整客户端/用户数据 |
| [hucuyuu/zhipu-balance](https://github.com/hucuyuu/zhipu-balance) | 智谱余额端点线索 |
| [cmochance/codex-app-transfer](https://github.com/cmochance/codex-app-transfer) / [0xgetz/minimax-agent-automation](https://github.com/0xgetz/minimax-agent-automation) | 目录/持久化登录观察，未纳入批量注册 |
| [jsongo/buddy-proxy](https://github.com/jsongo/buddy-proxy) | Qoder COSY 签名/信封/端点移植，完整许可 |
| [xxhhlk/raccoon2api](https://github.com/xxhhlk/raccoon2api) / [Patrick130306/loomy2api](https://github.com/Patrick130306/loomy2api) | 小浣熊/Loomy 交叉参考，独立实现 |
| [rockswang/wild-work](https://github.com/rockswang/wild-work) | 协议交叉参照，未复制 |
| [RobbsLuo/Coding2API](https://github.com/RobbsLuo/Coding2API) / [Jasery/opencode-lobster-auth](https://github.com/Jasery/opencode-lobster-auth) | CodeArts 签名移植/Lobster 协议，归属见平台来源 |
| [netease-youdao/LobsterAI](https://github.com/netease-youdao/LobsterAI) | 官方协议核对，客户端独立安装 |
| [denysvitali/llm-proxy](https://github.com/denysvitali/llm-proxy) | 查阅说明，许可不明确，未复制 |
| [BeUI](https://beui.dev/) / [shadcn/ui](https://ui.shadcn.com/) / [Rare UI](https://www.rareui.com/) / [Transitions](https://transitions.dev/) / Galaxy / HTMLrev | 视觉/动效参照，**未复制实现**，不打包其 React 组件 |

WB 完整 MIT 文本及固定提交另见 [参考声明模块](src/workbuddy-reference-license.mjs)。平台图标属于各平台商标资源，不视为本项目原创品牌资产。

感谢以上作者与贡献者。上游项目、平台服务和本项目独立维护；具体能力以本仓库实现、账号资格和实际服务端回执为准。

</details>
