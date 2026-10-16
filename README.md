<h1 align="center">AI积分网关</h1>

<p align="center">
  <b>桌面账号、每日权益、详细 WB 帐号池与统一模型入口</b><br>
  Windows 原生桌面 · Node.js 本机服务 · OpenAI 兼容 API · DSH · Hermes
</p>

<p align="center">
  <a href="package.json"><img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-blue"></a>
  <img alt="OpenAI Compatible API" src="https://img.shields.io/badge/API-OpenAI_Compatible-412991">
</p>

**AI积分网关**把本机桌面客户端账号的登录态、每日领取、余额与模型调用收拢到一个入口。可以在 Windows 原生界面管理账号，也可以只运行 Node.js 服务，通过 CLI、管理 API 或 OpenAI 兼容客户端使用同一后端。

WB 使用独立的 **wb帐号池**：逐账号展示身份、登录状态、封禁依据、积分包、任务内容与任务状态；顶部突出显示 **积分剩余 / 总额**。其他平台继续使用“积分总览”，其中不重复展示 WorkBuddy 积分。

> 兼容名称：npm 包仍为 `dsh-ai-credit-gateway`，CLI 与 DSH Provider 仍为 `ai-credit`，历史仓库地址保持不变。Windows 正式入口为 **`AI积分网关.exe`**。

真实功能自动任务的执行链、官方组件、状态和防重复机制见 [WB 自动执行器说明](docs/WB_TASK_EXECUTORS.md)。

## 目录

- [产品定位与架构](#产品定位与架构)
- [快速开始](#快速开始)
- [Windows 原生桌面](#windows-原生桌面)
- [七个页面](#七个页面)
- [wb帐号池详解](#wb帐号池详解)
- [账号导入、导出与整理](#账号导入导出与整理)
- [账号自动轮换](#账号自动轮换)
- [同模型自动接力](#同模型自动接力)
- [支持的平台与能力边界](#支持的平台与能力边界)
- [OpenAI 兼容客户端接入](#openai-兼容客户端接入)
- [DSH 与 Hermes 接入](#dsh-与-hermes-接入)
- [上下文、工具、推理与超时](#上下文工具推理与超时)
- [每日签到与自动刷新](#每日签到与自动刷新)
- [配置参考](#配置参考)
- [本机数据、备份与回滚](#本机数据备份与回滚)
- [诊断与常见问题](#诊断与常见问题)
- [测试、发布与贡献](#测试发布与贡献)
- [文档导航](#文档导航)
- [许可与致谢](#许可与致谢)

## 产品定位与架构

### 本项目做什么

1. **管理权益**：按账号读取本机登录态、检查余额、执行已实现的真实签到或领取流程，并保留服务端回执与本机幂等账本。
2. **统一调用**：把不同上游协议映射为 `/v1/models` 与 `/v1/chat/completions`，供 DSH、Hermes、FleshOut 等客户端使用。
3. **组织账号池**：让同款模型在兼容供给间接力；WB 与非 WB 隔离，登录失败、限流、能力不足和真实额度耗尽分别处理。
4. **保留可诊断性**：目录声明、离线测试、真实调用、客户端工具闭环与云同步确认分别记录，不用一个绿色图标代替这些证据。

```text
Windows 原生桌面 ── adminKey ──┐
CLI / 本机管理 API ───────────┤
                             ▼
                       Node.js 本机服务
                    配置 / SQLite / 调度器
                             ▲
DSH / Hermes / 其他客户端 ─ apiKey ─ /v1
                             │
                    路由 / 同模型接力 / 适配器
                             │
                  本机已登录账号 / 官方 API
```

- **界面与服务分离**：WinForms 负责交互；Node 负责凭据、签到、余额、任务、模型与账本。界面重连不应取消正在进行的模型请求。
- **工具由调用端执行**：网关转换和传递 `tool_calls`，不会把一段工具调用 JSON 当成真实文件操作已完成。
- **不同计费单位分别展示**：积分、Token、现金和资源包不相加；WB 汇总只统计该池同单位的已知结果。
- **本机凭据不进配置**：配置保存文件引用；令牌、Cookie、运行密钥和数据库留在本机，不随源码分发。

### 仓库结构

| 路径 | 内容 |
|---|---|
| `desktop/AiCreditDesktop.cs` | Windows WinForms 桌面源码、七页导航与 WB 详情 |
| `desktop/build.ps1` | Windows 本机编译入口 |
| `bin/ai-credit.mjs` | CLI 与前台/后台服务入口 |
| `src/` | 服务、路由、适配器、任务、账号池与会话迁移 |
| `vendor/` | 保留来源、版权与许可证的复用模块 |
| `bundle/`、`cordis.patch.yml` | DSH bundle 入口与插件声明 |
| `scripts/` | 构建、DSH 安装、诊断与 Hermes helper |
| `tests/` | 协议、状态、分页、任务、文档与原生源码检查 |
| `docs/` | API、平台来源、接入与行为说明 |

公开仓库包含原生桌面源码与构建入口，不包含个人安装目录、登录数据、数据库或聊天。本机已有 EXE/Node runtime 不等于仓库发行附件；下载二进制以实际 Releases 附件为准。


### WB 日常工作流

**新账号**：添加官方登录 / 保存当前客户端账号 / 导入 JSON 或 ZIP → 核对账号身份与版本 → 刷新积分 → 选择需要发布的模型。**整理账号**：修改显示名与备注 → 按 ID/UID 搜索 → 只停用积分调用或显式删除。**多账号使用**：同版同模型池按额度故障接力；另可开启到期优先/顺序轮换，提前决定后续账号。导入、发布路由、真实模型请求与官方任务完成分别给回执，不合并为一个“成功”。

常用入口与操作区别：

| 操作 | 改变什么 | 保留什么 |
|---|---|---|
| 添加/导入账号 | 新的独立登录快照；显式替换只换同主体凭据 | 原账号、稳定 ID、路由启停、历史与其他平台 |
| 导出账号 JSON/ZIP | 将选中已保存登录数据写到用户选择路径 | 账号和路由保持原状，不执行推理或任务 |
| 停用该账号 | `inferenceEnabled:false`，暂停模型/积分调用 | 自动签到、自动任务、资料和登录态 |
| 账号管理整体停用 | `enabled:false`，退出自动调度/使用 | 账号配置与历史 |
| 自动轮换 | 后续网关请求/后续 CLI 启动的优先账号 | 已开始的生成、模型 ID、上下文与工具 |
| 模型路由“导出选中” | 取消发布选中模型路由 | 账号、登录态、路由定义与历史 |

详细对照：[workbuddy-switch 参考矩阵](docs/WB_SWITCH_COMPARISON.md)。本项目使用其格式/策略知识独立适配，完整上游许可保留；IDE 插件切号、悬浮窗、签名更新等参考项目桌面功能不自动成为本网关功能。

## 快速开始

### 环境

- Node.js **24+**：服务使用内置 SQLite；npm 构建使用 esbuild。
- Git：拉取源码与更新。
- Windows 原生界面另需本机 C# 编译环境，由 `desktop/build.ps1` 检测。
- 使用桌面账号的平台先在官方客户端登录；各平台地区、套餐、目录与能力并不相同。

### 从源码启动后端

以 `C:\Gateway` 为自选安装目录示例，不要复制别人的私有配置与数据目录。

```powershell
git clone https://github.com/spdw666/multi-agent-checkin-dsh.git C:\Gateway
Set-Location C:\Gateway
npm ci
npm run build
node bin/ai-credit.mjs init --config C:\Gateway\config.local.json
notepad C:\Gateway\config.local.json
node bin/ai-credit.mjs doctor --config C:\Gateway\config.local.json
node bin/ai-credit.mjs serve --config C:\Gateway\config.local.json
```

首次用 `serve` 在前台看启动错误，成功会打印 `GATEWAY_READY`。另开终端检查：

```powershell
Invoke-RestMethod http://127.0.0.1:19421/health
```

稳定后改后台启动；同一配置只保留一个服务实例。

```powershell
node bin/ai-credit.mjs start --config C:\Gateway\config.local.json
node bin/ai-credit.mjs stop --config C:\Gateway\config.local.json
```

Linux/macOS 可运行同一 Node 后端，使用自己的绝对路径；平台凭据读取取决于客户端与系统，WinForms 桌面不在这两个系统运行。长期服务见 [Linux 部署](docs/linux.md)。

### 常用 CLI

```powershell
node bin/ai-credit.mjs doctor --config C:\Gateway\config.local.json
node bin/ai-credit.mjs health --account ACCOUNT --config C:\Gateway\config.local.json
node bin/ai-credit.mjs claim --account ACCOUNT --task daily-checkin --config C:\Gateway\config.local.json
node bin/ai-credit.mjs models --config C:\Gateway\config.local.json
node bin/ai-credit.mjs records --config C:\Gateway\config.local.json
```

`ACCOUNT` 换成配置账号 ID。批量领取用 `POST /admin/claim` 并省略 `accountId`，不把 CLI 未实现的参数当批量开关。配置可由 `--config` 或 `AI_CREDIT_CONFIG` 指定。

## Windows 原生桌面

### 构建与启动

```powershell
Set-Location C:\Gateway
powershell -NoProfile -ExecutionPolicy Bypass -File .\desktop\build.ps1
```

默认仅编译到 `desktop/dist/AI积分网关.exe`。若需要可单独放置的桌面目录，同时打包后端与指定 Node runtime：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\desktop\build.ps1 `
  -BundleCore -NodeExecutable (Get-Command node.exe).Source
```

`-OutputDirectory` 可指定输出目录，`-CoreDirectory` 可指定后端源码根目录。脚本默认定位 Windows .NET Framework 64 位 C# 编译器，找不到时查找 PATH 中的 `csc.exe`。需要先在根目录完成 `npm ci` / `npm run build`；打包输出包含 `core/` 与 `runtime/`，不复制个人配置/数据。程序入口为 **AI积分网关.exe**，首次运行按该目录初始化自己的配置。

仓库只分发自有 app-logo 素材。`platform-icons/` 是可选本机图标目录，不参与编译依赖；没有平台图标时使用原生占位显示。本机已有的官方客户端图标不上传公共仓库。

### 重连与更新

页面轮询、后台进程和模型长连接是不同生命周期。短暂 GET 失败采用有界重试与退避；领取、删除、切号等写操作不因重连自动重放。手动暂停后台后，不应被自动恢复立即拉起。

升级先停止旧实例，备份实际配置与数据目录，再部署程序和后端；不要只换界面却保留不兼容 API，不要覆盖用户配置、密钥和历史。回退见[本机数据、备份与回滚](#本机数据备份与回滚)。

## 七个页面

| 页面 | 用途 | 关键语义 |
|---|---|---|
| 积分总览 | 非 WB 平台余额、每日领取和核验 | **排除 WorkBuddy**；不同单位不相加；未知不填零 |
| 账号管理 | 平台账号、启停、登录与删除 | 稳定身份绑定，换主体明确重绑 |
| 模型路由 | 模型导入、启停、目标与接力分区 | 目录发现、体检与发布分离 |
| 领取记录 | 签到、领取、重复与失败回执 | `success`、`already`、`observed` 分开 |
| 偏好设置 | 每日排程、随机延迟与后台偏好 | 保存配置不等于官方任务已完成 |
| 活动洞察 | 请求、上下文组成、供给尝试与原因 | 字符估算不冒充官方 Token，只观察本网关流量 |
| wb帐号池 | 身份、封禁、积分包、完整任务与会话管理 | 封禁、认证失效、停用账号仍保留展示 |

“积分总览”排除 WB 是展示分工，不是从配置、账本或管理 API 删除 WB。管理工具需要全部平台时仍可使用原有未筛选余额接口。

## wb帐号池详解

完整字段与管理协议见 [WB 帐号池手册](docs/wb-account-pool.md)。

### 汇总与账号卡

- 顶部独立区域以大字号展示启用且非封禁账号的 **积分剩余 / 总额**，并给全部账号数、封禁数、已知数与待获取数。
- 每账号单独一张卡；停用、认证拒绝或封禁账号不因过滤而消失。
- 卡片给身份、状态、积分、最近核验与操作入口，账号详情完整展开更多字段。
- 相同 WB 模型按精确型号只展示一次，不按账号重复铺开。
- 部分余额未知时写“已知积分剩余 / 总额”，不把未知账号当零纳入汇总。

### 身份与登录信息

| 字段 | 含义 |
|---|---|
| 账号 ID / `accountId` | 网关配置槽位，用于 API 与引用 |
| UID / `uid` | 上游主体标识，缺失保留未知 |
| 用户 ID / `userId` | 上游用户 ID，是否与 UID 相同以实际数据为准 |
| 昵称、用户名、邮箱、域/版本 | 已返回资料及国内/国际版归属 |
| 凭据状态与有效期 | Access/Refresh 状态、有效期与来源；**不展示令牌值** |
| 核验时间与来源 | 官方结果、缓存或人工本机标记分别说明 |

“添加登录”打开官方授权，国内与国际版分别处理。“保存客户端当前账号”捕获官方客户端当前登录并保存独立快照；同主体再次保存时合并，不无限产生重复账号。

多账号常驻指保存多个独立登录快照，不代表一个官方登录文件同时承载多个主体。后续切换复用保存状态；官方撤销、过期或策略变化按实际结果提示新登录。

### 封禁、认证拒绝与删除

- **已封禁**：有官方明确封禁/blocked 证据，或用户主动做了本地封禁标记；详情保留来源与原因。
- **认证拒绝 / `auth_rejected`**：会话撤销、登录失效或凭据被拒；HTTP 401/403 单独出现不等于官方封禁。
- **未知**：本次查询证据不足；保留最近成功数据与失败原因，不猜测为正常或封禁。
- **手动标记封禁**：本机整理功能，可清除；标记后退出 WB 接力候选，不自动删聊天。
- **停用该账号 / 启用该账号**：每个 WB 账号都有独立按钮，仅暂停该账号的积分与模型调用；账号资料、登录态、自动签到和自动任务继续保留。停用后不会加入模型候选或自动切号；再次启用恢复参与。该开关对应 `accounts[].inferenceEnabled`，与停用整个账号的 `enabled` 不同。
- **删除账号**：确认后清理账号、上游、池与失效路由引用；保留聊天、历史及私密回滚备份，与“停用”不同。

核对账号 ID、UID 与封禁来源后再删除。封禁卡保留是为了识别整理，不让它继续参与调用。

### 积分与积分包

详情包含**官方该查询范围返回的全部积分包**，保留其中已耗尽/过期行：包 ID、名称、编码、原始总额、剩余、已用、创建/到期/刷新时间及状态，以实际上游字段为准。查询起点为 `2000-01-01`，保留官方协议状态筛选 `[0,3]`；`queryScope` 返回起止时间和状态范围，`complete` 只代表此范围分页齐全，不保证任意状态的全部历史均可获取。

“总额”是当前官方积分包/余额体系的可核验总额，不是历史累计充值或每天承诺发放量；缺失显示待获取。最近成功、最近失败、缓存时间与错误码同时保留，帮助区分“还有积分却用不了”的具体层次。

正余额不保证任意模型、地区、套餐或工具均可用。工具不兼容、上下文超限、限流、认证与真实耗尽分别记录，不把所有错误都归为积分不足。

### 任务内容、状态与自动任务

完整任务列表给出 ID/编码、标题、说明、类型、适用端、目标与当前进度、积分/Buddy 等奖励、接受/达标/领取/锁定状态、查询时间和最近执行回执。

当前真实自动流程覆盖：

1. 查询官方任务，接受可接受任务。
2. 执行已实现的真实每日签到。
3. 领取服务端已达标且可领取任务的奖励。
4. 重新查询任务/余额，核对结果并持久去重。

**后台已接入真实功能执行器：对话、技能、专家、画布、外观、资料库与本地自动化按各自入口执行，并回查官方任务进度。** 首次对话前置任务优先处理；应用授权、订阅等待时间、资料正文与业务组件等条件未就绪时保留具体状态。完整流程、幂等规则与组件要求见 [WB 自动执行器说明](docs/WB_TASK_EXECUTORS.md)。只有官方查询确认达标才领取，只有再查 `claimed` 才显示已领取。没有执行器的任务继续显示 `manual_action_required`；已接入但条件未就绪的任务返回具体等待原因。

“自动任务”由后台约每 30 分钟检查，同账号互斥。默认关闭，关闭后停止后续自动流程。查询、接受、执行与领取分别有状态，以官方回查为准。

WB 真实任务执行器使用共享 SQLite 租约，桌面核心与 DSH 同时触发同一账号、任务时仅一个进程执行；丢租后停止后续动作，已提交但结果不确定的操作保留待核验，不重复生成。

### 切号与聊天迁移

- **切换此号**：写官方客户端登录文件并切网关后续请求的池偏好，正在输出的请求不迁移。
- **只切网关**：API 的 `switchClient:false` 只改后续请求，不写客户端登录文件。
- **一键合并聊天**：把已保存账号的本机可读 JSONL/SQLite 会话以新 ID 加法复制到目标账号，保留来源和幂等映射。
- **切号自动迁移聊天**：开启后在切号前执行同样的本机复制；默认关闭。

先关闭 WorkBuddy，再切换/迁移。写入前备份与校验，失败恢复客户端登录和网关选择，不强行关闭正在执行的用户任务。

`cloudSyncConfirmed:false` 表示只完成本机处理，云端归属和同步需官方客户端下次启动确认。源会话保留；结构未适配或正文不全时返回待处理状态，不用调用账本冒充聊天正文。

## 账号导入、导出与整理

完整格式与 API 见 [WB 账号交换手册](docs/WB_ACCOUNT_TRANSFER.md)。WB 帐号池顶部固定有“导入账号”“导出账号”“轮换设置”，每号“更多操作”有“修改名称 / 备注”“导出此号”；原管理入口继续处理添加登录、保存当前客户端和本地显示名/备注，保持原来的身份、积分、任务与会话管理。

### 导入的操作顺序

1. 选择一个或多个 `.json` / `.zip`；先做只读预览。
2. 核对国内/国际版、稳定 UID、有效期、格式问题与重复项。
3. 选择导入条目，决定“跳过已有”还是“替换已有登录态”，再提交。
4. 查看新增、替换、跳过及逐项回执；之后按需刷新身份和积分。

支持附件类 `account` / `auth` JSON（单对象、对象数组或带 `schemaVersion:1` 的 `workbuddy-auths` 包），以及 workbuddy-switch 原始明文扁平数组；ZIP 可装多个账号 JSON。预览不返回 token，也不执行登录续期、签到或生成。JSON 中的昵称不是网关稳定 ID，文件名也不作为身份依据。

```json
{
  "account": {"uid":"SAMPLE_UID","enterpriseId":"SAMPLE_ENTERPRISE","nickname":"SAMPLE 工作号"},
  "auth": {"accessToken":"SAMPLE_ACCESS_TOKEN","refreshToken":"SAMPLE_REFRESH_TOKEN","expiresAt":1893456000000,"domain":"www.workbuddy.cn"},
  "gateway": {"label":"SAMPLE 国内号","notes":"SAMPLE 本地备注","inferenceEnabled":true}
}
```

身份按**版本 + UID**去重，默认跳过已有；显式替换只更新对应主体的已保存凭据，不覆盖原账号 ID、显示名、备注、整体启用、积分调用开关、任务和路由策略。已有自动维护池可以加入同版新账号，手动池与停用路由保持原样。新增账号按保存回执建立，不用文件内任意路径决定本机落盘位置。

### 导出与本地整理

导出选择当前浏览账号、全部或明确多选账号，保存为兼容 JSON、逐账号 ZIP 或 workbuddy-switch JSON（`switch-json`）；格式与导入相对应，包含实际登录数据，而日常 summary/details 仍隐藏 token。把导出物留在本机私密备份目录；公开仓库只包含 SAMPLE 格式示例，不包含个人账号包、账号清单、密钥或压缩包。

显示名与备注仅影响本机识别，不修改官方 UID、登录地区或路由 ID。备注空串表示清空；账号详情继续显示身份、登录期限、封禁依据、积分包与任务。预览、保存、官方认证有效与真实推理是不同验收步骤，不把成功解析文件描述为模型已经可用。

### 管理接口速查

| 接口 | 用途 |
|---|---|
| `POST /admin/workbuddy/accounts/import/preview` | 只读解析与去重预览 |
| `POST /admin/workbuddy/accounts/import/commit` | 按选择和策略提交 |
| `POST /admin/workbuddy/accounts/export` | 返回所选账号 JSON/ZIP 的 base64 内容 |
| `POST /admin/workbuddy/accounts/ACCOUNT/profile` | 保存显示名和备注 |
| `POST /admin/workbuddy/accounts/ACCOUNT/inference` | 仅暂停/恢复积分调用 |

全部使用 `adminKey`。普通管理 HTTP 请求为 4 MiB；账号导入入口为 base64 / JSON 转义提供 16 MiB 包装正文上限，解码后的原始文件合计仍为 4 MiB，另有单 JSON、账号与解压限制，见完整手册。导出响应含登录数据，客户端直接保存文件，不把响应正文写入反馈日志。

## 账号自动轮换

轮换默认关闭，在 [WB 轮换手册](docs/WB_ROTATION.md) 中配置目标、策略、频率、冷却、紧迫窗口、差异阈值和最小剩余积分。设置、预览、实际评估与提交回执分别展示。

| 选择 | 含义 |
|---|---|
| 到期优先 `expiry` | 有效包中剩余积分的最早到期更紧迫者优先 |
| 顺序轮换 `round_robin` | 在有效候选中按稳定顺序前进 |
| 网关 `gateway` | 只改同版同型号 WB 池下一请求偏好 |
| CodeBuddy CLI `codebuddy-cli` | 为空闲 CLI 的后续启动准备身份 |
| 两者 `both` | 两个目标分别核对并报告结果 |

整体停用、暂停积分调用、封禁、凭据/余额不满足条件、过期或未知的账号退出轮换候选。冷却和到期差异门槛用于避免抖动，不跨国内/国际版或型号替换。网关更新后不打断已经开始的生成，不重放工具，不改模型 ID/输入历史/预算。

CLI 检测到心跳新鲜的会话或明确运行进程时推迟，不关闭用户 CLI 或重启客户端。配置写入前保留原件，地区、已有 helper/环境覆盖与凭据条件分别核对；运行中进程仍持有自己的旧 token，写盘不当成该进程实时换号。

自动轮换不等于故障接力：前者按策略选择**下一次**，后者在同一请求交付前按明确故障分类选择兼容备用；两者都遵守账号积分开关。自动签到和真实任务有独立开关/幂等账本，不随轮换停止。

```json
{"enabled":false,"target":"gateway","strategy":"expiry","intervalMinutes":5,"cooldownMinutes":120,"minUrgencyHours":72,"minRemainingCredits":0,"minGapHours":6,"edition":"cn"}
```

`GET /admin/workbuddy/rotation` 返回设置、状态与预览；`POST` 同路径保存平铺设置；`POST /admin/workbuddy/rotation/evaluate` 默认 `{"dryRun":true}` 只预览，`dryRun:false` 才尝试按策略提交。开关开启与实际切换成功分别检查，不用 HTTP 200 代替逐目标回执。

## 同模型自动接力

```json
{
  "modelRelay": {
    "enabled": true,
    "reservePercent": 10,
    "reserveCredits": 100,
    "partitions": { "workbuddy": true, "other": true }
  }
}
```

- **WB 分区**：WB 模型只接 WB 账号。
- **其他分区**：非 WB 供应之间按同款同版本接力，排除 WB。
- 全局开关、分区开关与单路由 `relay:false` 分别生效。
- 精确型号/版本匹配，Flash、Pro 和其他版本不互换。
- 保留客户端模型 ID、消息历史、工具定义/回执和输出预算，不删历史制造成功。
- 未知余额不填零，积分阈值不与现金比较；停用账号、封禁账号与停用路由不自动恢复。

额度低/耗尽、限流、认证拒绝、目录缺失和通道故障分别分类。候选需满足实际上下文、工具、图片与输出能力；能力不兼容不应写成硬额度耗尽。主供应能力广播与备用筛选分开，备用窗口较小不应压低主供应声明。

直接 SSE 已交付内容后不重放请求。接力模式采用有界完整响应缓冲，所以首批可见输出可能晚于上游首包；正文、推理和工具增量刷新进度计时。取消优先，已交付后不重放。见 [接力说明](docs/model-relay.md) 与 [API 契约](docs/api.md)。

## 支持的平台与能力边界

16 种专用上游适配如下；`freeapi` 另用于固定官方平台注册表，不接受任意中转站 URL。

| 平台 | 类型 | 平台 | 类型 |
|---|---|---|---|
| WorkBuddy | `workbuddy` | Qoder / Qoder CN | `qoder` |
| Trae 国内/国际 | `trae` | CodeBuddy 国内/国际 | `codebuddy` |
| 千问办公 | `qwenwork` | WorkBuddy AI | `workbuddyai` |
| MiniMax Code | `minimax` | Cline | `cline` |
| ZCode | `zcode` | CodeArts Agent | `codearts` |
| 智谱 BigModel 官方 API | `bigmodel` | LobsterAI | `lobster` |
| Antigravity 本机桥 | `antigravity` | 小浣熊 Raccoon | `raccoon` |
| NVIDIA NIM 官方 API | `nvidia` | Loomy | `loomy` |

“适配已实现”不等于每个账号、地区、模型、套餐和工具组合都通过真实调用；登录、目录、余额、签到、推理、工具与流式分别核验。

- 国内/国际版使用各自登录态。
- CodeArts/小浣熊检测到新有效官方登录后恢复读取，未知结果不盲目重放旧旋转令牌。
- 千问办公个人版额度由服务端自动重置，不虚构手动签到。
- NVIDIA 官方策略上限、响应头观测和本机统计分开，不用公示上限当实时剩余。
- Antigravity 使用独立 CLIProxyAPI 本机桥，只连接明确 loopback 地址，不打包该桥及凭据。

见 [平台登录态](docs/desktop-platforms.md)、[适配归属](docs/provider-attributions.md) 与 [免费平台](docs/free-providers.md)。

## OpenAI 兼容客户端接入

| 字段 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:19421/v1`，包含 `/v1` |
| API Key | 本机 `api-keys.json` 的 `apiKey` |
| Model | `/v1/models` 返回的启用路由 ID，含斜杠原样填写 |

`TOKEN` 是占位符，实际密钥从本机读取，不提交源码/反馈日志。

```powershell
$Headers = @{ Authorization = 'Bearer TOKEN' }
Invoke-RestMethod 'http://127.0.0.1:19421/v1/models' -Headers $Headers
$Body = @{
  model = 'UPSTREAM/MODEL'
  messages = @(@{role='user'; content='只回复连接正常'})
  stream = $false
} | ConvertTo-Json -Depth 20
Invoke-RestMethod 'http://127.0.0.1:19421/v1/chat/completions' `
  -Method Post -Headers $Headers -ContentType 'application/json' -Body $Body
```

换成真实路由。模型调用用 `apiKey`，管理面用 `adminKey`，二者不互换。验证顺序：健康 → 目录 → 普通请求 → SSE → 工具请求/结果回传 → 客户端真实任务。目录可见或“测试连接”成功不等于工具闭环。

FleshOut 等支持自定义 OpenAI 端点的客户端无需修改程序。同步客户端数据库时先备份整库并保留原默认模型。见 [OpenAI 客户端](docs/openai-clients.md) 与 [FleshOut 同步](docs/fleshout-sync.md)。

## DSH 与 Hermes 接入

### DSH bundle

```powershell
Set-Location C:\Gateway
$env:AI_CREDIT_NODE = (Get-Command node).Source
node scripts/install-dsh.mjs --config C:\Gateway\config.local.json
```

脚本定位 Desktop CLI，备份实际 `desktop` profile，添加 bundle 并同步代码，记录在数据目录 `dsh-install/`。不自动重启 DSH；worker 用独立 Node 24，不将 Electron 当 Node。

peers 范围见 [package.json](package.json)，安装/回滚见 [DSH](docs/dsh.md)，预算与重试见 [DSH 请求策略](docs/dsh-request-policy.md)。保留已有 profile、默认模型与其他插件。

### Hermes 命名 Provider

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

换成实际 Node、脚本和数据目录。`key_cmd` 只读取 `apiKey`，通过标准输出交 Hermes，不写 YAML；不要把 helper 输出复制到日志。

`discover_models:true` 获取启用路由。示例 `extra_body.reasoning_effort:null` 清除 Hermes 统一档位，由网关/上游默认处理，不等于逐平台透传全部菜单档位。显式档位需核对最终序列化请求，避免 `extra_body` 覆盖预期值。Hermes 无需 DSH 插件。见 [Hermes 配置/回滚](docs/hermes.md)。

## 上下文、工具、推理与超时

保留消息历史、工具 schema、调用 ID/回执、客户端模型 ID 与显式输出预算。能力不匹配时给具体错误或跳过候选，不静默删工具/历史/输出预算。声明窗口、实际输入 Token、请求体字节与最大输出 Token 是不同指标。

### 工具闭环

1. 客户端发送工具定义与消息。
2. 模型返回结构化 `tool_calls`。
3. 客户端实际执行工具。
4. 客户端以原 `tool_call_id` 回传结果。
5. 模型依据结果完成回答。

五步完成才算闭环。活动洞察的“携带工具/文件上下文”不冒充已执行操作。

### 三类时间预算

| 层 | 作用 |
|---|---|
| 调用端 | DSH/Hermes/客户端首包、整轮、取消与重试 |
| 网关 HTTP | `server.requestTimeoutMs` 或精确路由 `modelRequestTimeouts` |
| 供给有效进展 | 默认约 30 秒无进展超时，正文/推理/工具增量刷新计时 |

HTTP 默认 180000ms，允许 1000–1200000ms。接力缓冲时可见首包较晚不等于上游没进展；延长客户端超时不会修复认证、能力或额度错误。

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 19421,
    "requestTimeoutMs": 180000,
    "modelRequestTimeouts": { "UPSTREAM/MODEL": 600000 },
    "bodyLimitBytes": 67108864
  }
}
```

这是字段片段，不是完整配置。映射键精确匹配路由；改名同步改键。聊天正文默认 64 MiB，普通管理正文固定 4 MiB；WB 账号导入有独立 16 MiB 包装上限、原始文件合计仍 4 MiB。体积超限与模型上下文超限分开。见 [API](docs/api.md)。

## 每日签到与自动刷新

| 展示/状态 | 含义 |
|---|---|
| 每日签到领取 | 需要真实签到/领取，刷新余额不代替领取 |
| 今日签到额度已到账 | 同日有效官方账单确认；旧账单或正余额不算今日已领 |
| 官方每日自动额度 | 服务端自动重置，网关只观察 |
| 自动刷新 | 重新查询状态/余额，查询本身不加积分 |
| `success` | 按平台契约成功，结合回执与确认字段 |
| `already` | 此前已完成，不是又发一次 |
| `observed` | 观察到官方状态，不冒充主动领取 |
| `action_required` | 需要真实操作、登录或未接入执行器 |

排程含启动检查、每日时间、随机延迟与失败重试。幂等按稳定主体、任务、日期/活动窗口去重；HTTP 200 不代表每账号都领到了。完整状态见 [API](docs/api.md)。

## 配置参考

完整模板见 [config.example.json](config.example.json)。三层关系：`accounts` 账号 → `upstreams.accountId` 适配器 → `routes.targets` 对外路由。

### 服务与排程

| 字段 | 用途 |
|---|---|
| `schemaVersion` | 当前 `1` |
| `dataDir` | 相对路径基于配置所在目录，不基于终端 cwd |
| `server.host` / `port` | 默认 `127.0.0.1:19421` |
| `server.allowRemote` | 非 loopback 需显式开启，默认关闭 |
| `server.requestTimeoutMs` | HTTP 通用截止，默认 180000ms |
| `server.modelRequestTimeouts` | 精确路由覆盖，最多 500 项 |
| `server.bodyLimitBytes` | 聊天字节上限 1024–67108864 |
| `scheduler.enabled` / `startup` | 排程与启动检查 |
| `scheduler.timezone` / `hour` / `minute` | 每日时区与时间 |
| `scheduler.jitterSeconds` / `retryMinutes` | 随机延迟与失败重试 |

### 账号、上游与路由

| 字段 | 用途 |
|---|---|
| `accounts[].id` / `platform` / `label` / `enabled` | 稳定槽位、平台、名称、启停 |
| `accounts[].edition` | 支持地区/版本的平台选择 |
| `accounts[].credentials.kind` / `file` | 本机读取方式/文件引用，`auto` 由适配器定位 |
| `credentials.executable` / `autoLaunch` | 部分客户端短期凭据选项 |
| `accounts[].tasks[].id` / `enabled` | 平台已实现的领取任务 |
| `accounts[].personalTeamId` | 千问办公个人团队选择 |
| `upstreams[].id` / `kind` / `accountId` / `enabled` | 上游与账号引用 |
| `upstreams[].localLimits` | NVIDIA 本机并发/间隔，不冒充官方配额 |
| `routes[].id` / `enabled` | 稳定客户端模型 ID 与是否发布 |
| `routes[].targets[].upstreamId` / `model` | 精确目标与上游模型 |
| `routes[].relay` | `false` 单独停接力 |
| `routes[].accountPool.accountIds` / `cooldownSeconds` | WB 候选与冷却 |

各类 ID 唯一，引用完整，账号平台与上游类型一致。停用路由保留配置/历史但从 `/v1/models` 隐藏。

### WB 与接力

| 字段 | 用途 |
|---|---|
| `workbuddy.autoMigrateSessions` | 切号迁移本机会话副本，默认关闭 |
| `workbuddy.autoTasks` | 周期执行已实现真实任务，默认关闭 |
| `workbuddy.rotation` | 账号轮换设置，默认关闭；与签到任务和接力分开 |
| `accounts[].inferenceEnabled` | 仅控制 WB 模型积分调用，缺省为 true |
| `accounts[].notes` | 本机账号备注，不作为上游身份 |
| `modelRelay.enabled` | 自动接力总开关 |
| `modelRelay.partitions.workbuddy` / `other` | 两分区开关 |
| `modelRelay.reserveCredits` | 已知积分预留，默认 100 |
| `modelRelay.reservePercent` | 已知总额预留，默认 10%，范围 0–50 |
| `modelRelay.balanceMaxAgeSeconds` | 余额新鲜度，默认 60 秒，范围 5–600 |

内联 `apiKey`、`refreshToken`、`cookie` 等凭据会被配置校验拒绝。官方 API Key 也放账号专属本机文件，由配置引用。

## 本机数据、备份与回滚

| 文件/目录 | 内容 |
|---|---|
| `config.local.json` | 私有账号、上游与路由，不提交 |
| `data/api-keys.json` | 自动生成 `apiKey` 与 `adminKey` |
| `data/runtime.json` | 当前进程与地址 |
| `data/service.log` | 后台日志 |
| 数据目录 SQLite | 领取账本、用量、池状态与幂等 |
| `data/account-deletion-backups/` | 删号前私密配置备份 |
| `data/account-transfer-backups/` | 导入/替换前的私密配置与凭据原件 |
| WB 快照/迁移备份 | 独立凭据、原数据库/文件与迁移映射 |

`data/` 指实际 `dataDir`，不保证在仓库。备份覆盖配置、整个数据目录和涉及的客户端登录/会话文件。活跃 SQLite 用一致性备份或停服务后复制，不能只复制主 DB 漏掉 WAL。

### 更新步骤

1. 记录版本、配置、实际 Node 与服务地址。
2. 停桌面/后端，备份程序、配置、数据并记录 SHA-256。
3. 拉取源码，运行 `npm ci` 与 `npm run check`，需要界面时重建 `desktop/build.ps1`。
4. 部署程序/后端，保留私有配置/数据，不用示例覆盖。
5. 核对 `/health`、主体、余额、启停路由和真实工具闭环。

### 回滚步骤

先在独立副本验证旧程序及对应配置/数据，确认恢复旧行为再应用安装。恢复前再次备份当前状态，保留升级后新增历史；不要随意混配新旧 DB、配置与程序。

DSH profile 用 [DSH 回滚](docs/dsh.md) 和 `scripts/rollback-dsh.mjs`；删号、迁移、客户端模型同步分别用各自备份。删号不删聊天，所以账号配置回滚与聊天回滚不同。

## 诊断与常见问题

### 健康正常，模型失败

`/health` 只说明服务运行。继续查认证、目录/导入、能力与真实调用，记录路由/错误码/普通或 SSE/工具阶段，以及失败发生在生成前、中还是回传后。

### 有积分却用不了

查详情的最近成功/失败与积分包，再看分类：`tools_not_supported`、上下文超限、401、429、`same_model_credits_exhausted` 分别是能力、容量、认证、限流与额度，不是一回事。

### 等很久才开始输出

核对接力完整响应缓冲、调用端重试和首包预算。活动洞察可区分尝试与交付。有推理/正文/工具进展不按固定短时限杀掉；无进展、取消或整轮截止仍会终止。

### 新登录仍显示旧状态

用 `doctor` 核对官方主体与槽位绑定；新有效登录优先于旧缓存。换主体需明确重绑，不把两个主体历史静默合并；未知续期不重复使用旧旋转令牌。

### 封禁与认证拒绝混淆

所有保存账号包括停用/封禁项都保留。核对官方证据、本机标记、`auth_rejected` 和未知；401/403 不独立证明封禁。删号前核对 ID/UID。

### 汇总、积分包与任务不一致

核对时间、单位、全部分页与缓存；“已知积分”只统计有结果账号，未知不填零。过期包、奖励预告和当前余额不同；接受、执行、达标、领奖分别查回执，未接入执行器保留待操作。

### 413 / 上下文超限

413 是 `server.bodyLimitBytes` 字节上限，模型 Token 上限另查上游。网关不静默剪历史；调用端采用明确上下文管理策略或选择兼容供给。

### 401 / Host / Origin

模型面 `apiKey`、管理面 `adminKey`。Host/Origin 满足实际监听契约；远程监听、代理与客户端地址要一起配置。见 [API](docs/api.md)。

### 界面断连，请求仍运行

区分轮询、进程与模型长连接。先查健康、日志与请求状态，避免重复提交已受理的领取/删除/切号。GET 重连不重放写操作，手动暂停按用户操作恢复。

### 导入成功但账号仍然认证失败

导入说明交换文件已保存，不是一次官方续期或真实推理。先核对 UID、国内/国际版、到期时间与定向身份/余额查询；同主体凭据过期可重新授权或显式替换，不将认证拒绝误写为封禁。ZIP/JSON 错误在预览修正后再提交。

### 轮换开启却没有换账号

查看轮换预览与最近回执：当前已为目标、没有有效余额候选、冷却中、到期差异不够、积分调用暂停以及 CLI 存活都是不同原因。`gateway` 目标只影响下一次网关请求，原生客户端未换号符合该目标语义。正在输出的请求不为轮换而重放。

### 刷新后一直显示正在处理

账号操作成功、失败、取消与“操作已成功但刷新失败”有独立终态；按钮会恢复。界面更新以匹配的保存回执为准，HTTP 失败不乐观切换账号开关。反馈时给操作、终态文字与去密时间，不重复提交已受理的写操作。

### 如何反馈

给版本、平台、客户端版本、路由、错误码、时间、请求模式、工具阶段与去密日志。不提交 token、Cookie、密钥、登录快照、个人 DB 或完整聊天。以错误分类和源码证据为准，不仅凭截图猜测。

## 测试、发布与贡献

```powershell
npm ci
npm run check
node --test tests/docs-contract.test.mjs
node --test tests/http.test.mjs
```

`npm run check` 构建 vendor 后执行完整离线回归，不对真实账号领奖。覆盖 OpenAI 普通/SSE/工具、取消、体积、鉴权、身份、池、额度/限流、账本、分页、任务、会话副本与文档。

文档契约检查必要章节、有效相对链接、API、完整致谢与凭据占位符，不用固定 README 行数代替完整性。Windows 构建在 Windows 验证；跨平台 CI 不代替真实登录或工具闭环。

### 真实验收与发布

按“基线 → 修改 → 独立副本回滚”记录命令、输入、输出、退出码、SHA 与行为。真实请求会使用账号额度，按目的分层测试；零余额或官方拒绝先保留状态，不循环发送付费生成。

正常提交/推送，保留历史与无关并发修改。发布前跑测试、链接/凭据检查；发布后核对远端提交、CI 与实际 Release 附件。本机安装、Git push、CI 与二进制发行分别验收。

### 贡献约定

- 新平台给来源/许可证、凭据形状、能力矩阵和离线测试。
- 改 API 同步调用方/文档；任务明确真实执行、达标与领奖回查，不伪造完成。
- 保留模型 ID、上下文、工具 ID/结果与输出预算，回退核对兼容性。
- 不提交凭据、完整设备标识、DB、聊天或本机安装二进制。
- UI 检查缩放、滚动、长字段、未知/失败状态与减少动效。

## 文档导航

| 文档 | 内容 |
|---|---|
| [WB 帐号池](docs/wb-account-pool.md) | 身份、封禁、积分包、任务、迁移与 API |
| [WB 账号交换](docs/WB_ACCOUNT_TRANSFER.md) | 添加、JSON/ZIP 预览/去重/导出、备注与回执 |
| [WB 轮换](docs/WB_ROTATION.md) | 到期/顺序策略、目标、CLI 存活门控与故障 |
| [workbuddy-switch 功能对照](docs/WB_SWITCH_COMPARISON.md) | 固定来源、能力矩阵、复用与独立实现选择 |
| [API](docs/api.md) / [用量](docs/usage.md) | 管理契约、状态、分页与记账 |
| [同模型接力](docs/model-relay.md) | 候选、缓冲、活动与免费平台 |
| [DSH](docs/dsh.md) / [请求策略](docs/dsh-request-policy.md) | bundle、profile、预算与回滚 |
| [Hermes](docs/hermes.md) / [OpenAI 客户端](docs/openai-clients.md) | Provider、helper 与接入 |
| [FleshOut](docs/fleshout-sync.md) | 同步、整库备份与冲突检测 |
| [平台登录态](docs/desktop-platforms.md) / [模型复测](docs/model-retry.md) | 凭据与定向体检 |
| [CodeArts](docs/provider-codearts.md) / [小浣熊](docs/provider-raccoon.md) | 认证、额度与错误 |
| [Antigravity](docs/antigravity.md) / [NVIDIA](docs/nvidia-source-notes.md) | 本机桥、策略与限流 |
| [BigModel](docs/bigmodel.md) / [免费平台](docs/free-providers.md) | 资源包与固定官方平台 |
| [归属](docs/provider-attributions.md) / [第三方声明](THIRD_PARTY_NOTICES.md) | 固定来源与复用边界 |
| [客户端更新调研](docs/client-updates.md) | 调研不等于已实现自动升级 |

## 许可与致谢

原创实现采用 [MIT](LICENSE)。第三方保留版权头、完整许可证、固定来源与修改说明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。代码复用、独立组件与设计/协议参照分开记录，不把上游整项目功能当成本项目功能。

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
| [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) | 复用三个上下文模块，保留 vendor NOTICE |
| [wicm84266964/Buddy2api](https://github.com/wicm84266964/Buddy2api) | 千问协议助手与完整许可 |
| [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | 官方目录/Mavis/Matrix 核对，独立统一映射 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | bundle / Provider / PiAiAdapter 契约 |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 独立 Antigravity 本机桥，不打包 |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 独立调用端互操作，未打包其实现 |
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
