# 从第一次打开到长期使用

[返回主页](../README.md) · [WebView2 下载与构建](webview-desktop.md) · [API](api.md) · [隐私与发行核对](release-privacy.md)

本手册保留账号、路由、任务、排程、接入和维护的长步骤。主页说明当前发行和产品入口；某个平台的协议、验证快照与限制，使用对应专题手册核对。平台接口与账号权益可能变化，既有测试快照不是所有账号的长期可用承诺。

## 先选一个实例

- Web 便携版：完整解压官方 ZIP，启动 `AI积分网关.exe` 或 `启动新版工作台.cmd`。自己的配置、Node 后台与 WebView profile 位于自己的工作目录。
- 已有 WinForms：继续使用原生入口，不因新增 Web 包而替换账号或配置。源码默认 `desktop/build.ps1` 仍构建原生界面。
- 源码后端：自行指定配置与 Node，浏览器基础管理页不是完整 WebView2 桌面。基础浏览器页保留账号/领取、模型/路由、记录、配置四区。

同一份配置只运行一个后台。区分“原生实例”和“新便携实例”，再核对地址、账号和数据位置；健康检查成功不代表连到了你预期的那一份账号数据。

## 第一次使用的完整路径

1. **准备官方登录或自己的 Key。** 在正确国内/国际版客户端登录。官方 API 平台按固定适配入口录入 Key 或引用本机私有凭据文件，不把另一平台登录态放入当前账号槽位。
2. **连接后台。** 查看工作台底部状态；暂停后由你手动启动。首次不主动跑签到、任务或模型生成。
3. **添加并核对一个账号。** 检查主体、版本、登录期限、余额来源与每日资格。WB 可官方添加登录、保存当前客户端账号或导入自己的备份；解析成功、保存成功与官方认证有效分开看。
4. **选择发布少量模型。** 发现目录，勾选需要的型号并保存路由；保持已有停用项，不因刷新目录重新启用全部模型。
5. **按用途做定向体检。** 普通回答、SSE、工具调用与工具回传逐项看。体检会产生真实请求；要使用 Agent，还要在目标客户端完成真实工具执行、回填和最终答复。
6. **配置调用端。** 填本实例 `/v1` 地址、模型密钥和完整路由 ID。长期使用便携版前先固定端口并重启后台，然后配置 DSH/Hermes。
7. **最后开启自动化。** 排程、启动签到、WB 真实任务、轮换、迁移各有开关。按需启用，不用一次导入就顺便开启所有后台动作。

## 账号、上游、目录与路由

| 名称 | 作用 |
|---|---|
| `accounts` 账号 | 本机保存的稳定槽位、平台、登录来源及任务 |
| `upstreams` 上游 | 某种适配器和账号的供给引用，平台与类型要匹配 |
| 目录 | 当前能发现的型号清单，不等于每款都已调用通过 |
| `routes` 路由 | 客户端使用的稳定模型 ID，指向一个或多个实际目标 |
| 选择导入 / 发布模型 | 启用选定路由，使其出现在 `/v1/models` |
| 导出选中模型 / 移出 | 取消模型导入，停用所选路由，不生成备份文件 |
| 导出账号 | 生成含 WB 登录快照的 JSON/ZIP，与路由发布无关 |

不要把模型目录总数、账号卡数量或某台机器的测试结果当作发行能力数量。请求输入、模型 ID、工具 ID/回填和显式预算需要完整保留；新平台和未来型号按当前能力单独验证。

## WorkBuddy：账号、任务与切换

### 账号池与积分

WB 使用独立账号池，积分总览排除 WorkBuddy，避免同一额度在两个汇总里重复计数。账号池分别显示身份、登录期限、封禁依据、积分包、任务与积分剩余 / 总额。未知额度不是零，充值、套餐、每日权益与本机统计也不是同一个数字。

`401/403` 是认证或访问拒绝，不等于官方封禁。手动标记、官方明确封禁与网络故障分别保留来源。整体启用开关、WB `inferenceEnabled`、任务开关和模型发布各自独立：暂停积分调用不等于停止所有签到或删除登录快照。

### 导入、导出与整理

1. 在 WB 账号池选择自己的 JSON/ZIP，先做只读预览。
2. 核对条目、版本与重复项；默认跳过已有。替换策略只更新对应主体凭据，不随意覆盖显示名、路由和启停策略。
3. 勾选有效条目，确认提交。零选和无效项不提交；取消提交确认可返回预览继续核对。
4. 读取新增、替换、跳过和逐项结果，再按需核对官方身份/余额。
5. 备份时明确选择账号与格式，保存到自己的私密位置。导出只读已保存快照，不为了备份额外续期。

支持的具体嵌套 JSON、`switch-json` 和 ZIP、大小/解压约束见 [WB 账号交换手册](WB_ACCOUNT_TRANSFER.md)。仅有 accessToken 的历史备份不会凭空获得 refreshToken；到期后按官方登录恢复。导出含凭据，普通预览脱敏不等于导出也脱敏。

### 任务与进度

任务可能经历“发现、接受、执行、达标、领奖、结算回查”。`accepted` 不是生成完成，`manual_action_required` 表示需要对应官方动作；没有执行器的项目不伪造完成。关闭 UI 进度窗口只结束窗口等待；取消后台批次、停用未来自动任务、停止整个后台是不同操作。

重连先读取已有 job 和持久回执，不自动再次 POST 执行。需要核对具体功能组件、可重试条件与领奖规则，见[任务生命周期](WB_TASK_EXECUTION.md)和[真实执行器](WB_TASK_EXECUTORS.md)。

### 切换、迁移与轮换

切换账号、网关下一请求偏好、CodeBuddy CLI 后续启动身份和已经运行的客户端进程并不等价。聊天迁移是可选本地副本行为，源会话保留；`cloudSyncConfirmed:false` 不表示官方云端同步完成。`autoMigrateSessions`、`autoTasks` 与轮换默认独立配置。

轮换支持到期优先或顺序策略，网关/CLI/两者分别报告回执。活跃 CLI、冷却、版本或凭据条件会影响提交。轮换不打断已开始的生成；同模型接力则在请求交付前处理明确故障，WB 模型只接 WB，并保留型号、分区和工具约束。详见[轮换](WB_ROTATION.md)、[同模型接力](model-relay.md)和[参考功能对照](WB_SWITCH_COMPARISON.md)。

## 源码启动后端

需要 Node.js **22.23.3+** 与 Git。Windows 推荐固定官方 22.23.3；其他较新大版本不自动继承已验运行时结论。命令在你自己的克隆目录执行：

```powershell
git clone https://github.com/spdw666/multi-agent-checkin-dsh.git
Set-Location multi-agent-checkin-dsh
npm ci
npm run build
node bin/ai-credit.mjs init --config .\config.local.json
node bin/ai-credit.mjs doctor --config .\config.local.json
node bin/ai-credit.mjs serve --config .\config.local.json
```

编辑自己的配置并填写支持的登录来源。前台成功会打印 `GATEWAY_READY`；另开终端核对默认源码服务：

```powershell
Invoke-RestMethod http://127.0.0.1:19421/health
```

`19421` 是通用后端示例默认值，不是便携 `port=0` 实际地址。先在前台核对错误，按 Ctrl+C 停止前台服务后，再选择后台启动：

```powershell
node bin/ai-credit.mjs start --config .\config.local.json
node bin/ai-credit.mjs stop --config .\config.local.json
node bin/ai-credit.mjs ui --config .\config.local.json
node bin/ai-credit.mjs records --config .\config.local.json
```

配置还可用 `AI_CREDIT_CONFIG` 指定。`dataDir` 相对路径基于配置所在目录，不基于终端当前目录。Linux/macOS 使用同一 Node 后端，但桌面凭据读取与客户端依赖按系统区分；WinForms/WebView2 桌面仅说明 Windows 发行，[Linux 服务部署另见手册](linux.md)。

## WinForms 原生桌面

先完成 `npm ci` 与 `npm run build`：

```powershell
.\desktop\build.ps1
# 需要独立 core/runtime 时
.\desktop\build.ps1 -BundleCore -NodeExecutable (Get-Command node.exe).Source
```

默认只编译 `desktop/dist/AI积分网关.exe`，独立运行还需可用的后端和 Node；`-BundleCore` 才准备对应 `core` 与 `runtime`。支持 `-OutputDirectory` 与 `-CoreDirectory`，编译器由脚本检测。默认原生源码 `desktop/AiCreditDesktop.cs` 和 builder 没有被 Web 可选构建替换。

原生配置通常位于 `%LOCALAPPDATA%/AiCreditGateway/config.local.json`；`desktop.local.json` 的 `configFile` 或 `--config` 可指定其他位置。更新前核对真实配置，不按 EXE 所在目录猜测。原生传统页面与 Web 四主视图+八管理内页是不同布局，业务后端契约共用。

## 接入 OpenAI 兼容客户端、DSH 与 Hermes

- 模型 API 使用 `apiKey`：`Authorization: Bearer TOKEN`。管理 API 使用独立 `adminKey`，不要把管理密钥填进模型客户端。
- 模型列表：`GET /v1/models`；聊天：`POST /v1/chat/completions`；SSE、工具声明与工具结果按具体路由核对。
- Base URL 使用本实例 `/v1`，模型名使用完整路由 ID，不用显示名代替。
- DSH 使用本仓库 bundle/`ai-credit` Provider；`discover_models` 控制目录发现。已有 profile 和默认模型按你的配置保留。
- Hermes 使用命名 Provider 和按文档配置的 `key_cmd`；不得把其他 Provider 的凭据 helper 误换成网关 helper。

完整命令、请求预算、profile、helper 与回滚见 [OpenAI 客户端](openai-clients.md)、[DSH](dsh.md)、[DSH 请求策略](dsh-request-policy.md)与[Hermes](hermes.md)。目录、HTTP 200、一次短回答和真实本地工具闭环分别验收。

## 排程、每日权益与状态解释

领取任务按平台活动和官方窗口判断，不保证所有适配器都有签到。服务端自动重置的额度不记录成本机手动领取；此前已领取、本次新增、未知结算和需登录分开显示。机器关闭、后台暂停或用户未登录时，计划时间到达不等于已经执行。

排程、启动检查、失败重查与平台任务有独立开关。配置 Windows 当前用户登录后自启时，可使用下列入口；它不是无人登录也运行的系统服务：

```powershell
node bin/ai-credit.mjs install-autostart --config .\config.local.json
node bin/ai-credit.mjs uninstall-autostart --config .\config.local.json
```

移动目录或更换 Node 后重新核对任务路径。七视频适配仅处理每日权益，不在领取流程自动生成视频。活动、回执、余额来源及零值/未知的语义见[视频权益](video-daily.md)、[独立协议](video-independent-daily.md)和[积分状态](points-state-and-window-recovery.md)。

## 数据位置与更新

| 入口 | 配置 | 数据与资料 |
|---|---|---|
| Web 便携版 | `user-data/config.local.json` | `user-data/data`、`webview-profile`、`window-bounds.json`、`memory` |
| Web 解压目录不可写时 | `%LOCALAPPDATA%/AiCreditGatewayWebPortable/<目录身份哈希>/config.local.json` | 同一独立身份目录内的数据/profile |
| 默认 WinForms | `%LOCALAPPDATA%/AiCreditGateway/config.local.json`，可显式覆盖 | 以实际配置的 `dataDir` 和宿主设置为准 |
| 源码 / CLI | `--config` 或 `AI_CREDIT_CONFIG` 指定 | `dataDir` 相对配置目录解析 |

后台生成的密钥、runtime、日志、SQLite、账号快照、迁移备份和 profile 都是使用数据。`account-deletion-backups` 与 `account-transfer-backups` 可能含删除/替换前凭据，也纳入自己的私密备份，不公开上传。

更新顺序：确认实例和版本 → 停本实例后台与 UI → 一致性备份配置/整个数据/profile → 替换程序 → 核对 Node、启动地址和账号 → 验证选定客户端。活跃 SQLite 应用一致性备份，或停服务后复制，主 DB 与 WAL 要一起考虑。回滚恢复匹配的一套代码、配置与数据，再检查是否还有旧后台进程。

更新页负责检测与打开已登记客户端/创建快捷方式，不自动安装所有上游客户端。便携包与源码更新也不会自动迁移另一实例的账号。不要把使用后的整个目录重新压成公共发行包。

## 配置字段速查

以下是通用后端字段；Web 便携 first-run 模板使用空账号、关闭排程与 `server.port=0`。完整形状以[配置示例](../config.example.json)和[API 契约](api.md)为准。

| 字段组 | 主要字段 |
|---|---|
| 服务 | `server.host`、`server.port`、`allowRemote`、`requestTimeoutMs`、`modelRequestTimeouts`、`bodyLimitBytes` |
| 排程 | `scheduler.enabled/startup/timezone/hour/minute/jitterSeconds/retryMinutes` |
| 账号 | `accounts[].id/platform/edition/enabled`、`credentials.kind/file`、`tasks[].id/enabled` |
| 供给与发布 | `upstreams[].kind/accountId/enabled`、`routes[].targets`、`routes[].enabled` |
| WB | `inferenceEnabled`、`notes`、`autoMigrateSessions`、`autoTasks`、`workbuddy.rotation` |
| 接力 | `modelRelay.enabled/partitions`、`reserveCredits`、`reservePercent`、`balanceMaxAgeSeconds` |

容量、输出预算、请求字节上限与时间截止是不同字段。`bodyLimitBytes` 不是模型 token 容量；模型声明、来源与本地配置上限分开保留；不静默裁剪历史或显式预算。详见[模型目录](model-directory.md)、[请求可靠性](reliability.md)和[上下文来源专题](lobster-native-context-metadata.md)。

## 故障排查

| 情形 | 处理顺序 |
|---|---|
| 认证失败但余额曾经存在 | 核对当前登录、版本和来源；旧缓存不证明当前凭据有效 |
| 目录存在、模型失败 | 定向查认证、模型资格、能力与请求约束，不重复全量生成 |
| 413 / 上下文超限 | 先区分 HTTP 字节限制与上游 token/context 限制；调用端按需要做上下文管理 |
| 401 / Host / Origin | 使用正确回环地址和独立密钥，查看明确错误码；不把鉴权问题当封禁 |
| 首包等待 / SSE 断开 | 核对网关总期限、精确路由预算、上游期限与客户端超时；不逐层同时重放 |
| WB 汇总与任务不一致 | 查看积分包完整性、未知项、任务回执与刷新时间，勿用任务分值代替总余额 |
| 轮换没有立即改变当前 CLI | 轮换影响后续选择，活跃进程可能推迟；核对目标的独立回执 |
| “移出/导出模型”没有文件 | 该操作停用路由；账号文件备份请使用账号导出 |
| 重连后任务仍运行 | 先读已有 job，不重复提交；需要停止时用对应取消动作 |

更多： [诊断/路由预演](diagnostics-and-readiness.md)、[运行中心](operations-center.md)、[请求可靠性](reliability.md)、[流清理](runtime-reliability.md)、[模型复测](model-retry.md)、[用量与活动](usage.md)。反馈保留错误码、版本与步骤，删除凭据、用户标识、导出账号、原始聊天和未审查截图。

## 测试与贡献

```powershell
npm ci
npm run check
node --test tests/docs-contract.test.mjs
```

离线合同/mock、构建、宿主 UI、真实官方结算、客户端工具闭环是不同证据。公共 CI 不执行真实账号领取或模型调用。新增平台要给来源/许可、字段、能力边界与测试；改 API 同步调用方；不提交凭据、账号状态截图、完整设备标识、数据库、聊天或本机日志。

## 专题手册索引

下表保留原主页已经提供的全部后端专题入口；验证快照用于解释当时条件，不转化为当前所有账号的能力保证。

| 手册 | 用途 |
|---|---|
| [Antigravity](antigravity.md) | 对应功能、来源、契约与操作细节 |
| [模型体检 API](api.md) | 对应功能、来源、契约与操作细节 |
| [BigModel](bigmodel.md) | 对应功能、来源、契约与操作细节 |
| [客户端版本监测](client-updates.md) | 对应功能、来源、契约与操作细节 |
| [CodeArts 验证快照](codearts-validation.md) | 对应功能、来源、契约与操作细节 |
| [平台登录态](desktop-platforms.md) | 对应功能、来源、契约与操作细节 |
| [原生操作与状态说明](diagnostics-and-readiness.md) | 对应功能、来源、契约与操作细节 |
| [DSH 请求策略](dsh-request-policy.md) | 对应功能、来源、契约与操作细节 |
| [DSH](dsh.md) | 对应功能、来源、契约与操作细节 |
| [FleshOut 同步](fleshout-sync.md) | 对应功能、来源、契约与操作细节 |
| [直接 API Key 录入](free-provider-key.md) | 对应功能、来源、契约与操作细节 |
| [免费平台](free-providers.md) | 对应功能、来源、契约与操作细节 |
| [Hermes 接入](hermes.md) | 对应功能、来源、契约与操作细节 |
| [Linux 部署](linux.md) | 对应功能、来源、契约与操作细节 |
| [来源说明](lobster-glm5v-client-registry-context.md) | 对应功能、来源、契约与操作细节 |
| [精确来源说明](lobster-qwen-manufacturer-context.md) | 对应功能、来源、契约与操作细节 |
| [模型目录显示与验证](model-directory.md) | 对应功能、来源、契约与操作细节 |
| [接力说明](model-relay.md) | 对应功能、来源、契约与操作细节 |
| [模型复测](model-retry.md) | 对应功能、来源、契约与操作细节 |
| [NVIDIA](nvidia-source-notes.md) | 对应功能、来源、契约与操作细节 |
| [OpenAI 客户端](openai-clients.md) | 对应功能、来源、契约与操作细节 |
| [详细接入文档](opencode.md) | 对应功能、来源、契约与操作细节 |
| [运行中心与应用控制](operations-center.md) | 对应功能、来源、契约与操作细节 |
| [缓存、取消隔离与离线基准](performance-and-correctness.md) | 对应功能、来源、契约与操作细节 |
| [积分状态与窗口恢复说明](points-state-and-window-recovery.md) | 对应功能、来源、契约与操作细节 |
| [适配归属](provider-attributions.md) | 对应功能、来源、契约与操作细节 |
| [CodeArts 适配说明](provider-codearts.md) | 对应功能、来源、契约与操作细节 |
| [小浣熊](provider-raccoon.md) | 对应功能、来源、契约与操作细节 |
| [思考档位转换](relay-reasoning.md) | 对应功能、来源、契约与操作细节 |
| [请求能力、重试和期限说明](reliability.md) | 对应功能、来源、契约与操作细节 |
| [Windows 运行时与流清理](runtime-reliability.md) | 对应功能、来源、契约与操作细节 |
| [用量说明](usage.md) | 对应功能、来源、契约与操作细节 |
| [视频平台每日积分](video-daily.md) | 对应功能、来源、契约与操作细节 |
| [独立每日权益协议](video-independent-daily.md) | 对应功能、来源、契约与操作细节 |
| [WB 账号交换手册](WB_ACCOUNT_TRANSFER.md) | 对应功能、来源、契约与操作细节 |
| [WB 轮换手册](WB_ROTATION.md) | 对应功能、来源、契约与操作细节 |
| [workbuddy-switch 参考矩阵](WB_SWITCH_COMPARISON.md) | 对应功能、来源、契约与操作细节 |
| [WB 自动任务执行与取消说明](WB_TASK_EXECUTION.md) | 对应功能、来源、契约与操作细节 |
| [WB 自动执行器说明](WB_TASK_EXECUTORS.md) | 对应功能、来源、契约与操作细节 |
| [WB 帐号池手册](wb-account-pool.md) | 对应功能、来源、契约与操作细节 |
| [WebView2 桌面分发](webview-desktop.md) | 对应功能、来源、契约与操作细节 |
| [渠道校验与接力说明](workbuddy-channel-reliability.md) | 对应功能、来源、契约与操作细节 |
| [ZCode 接入](zcode.md) | 对应功能、来源、契约与操作细节 |

原始许可、固定来源和完整致谢见 [主页许可与致谢](../README.md#许可与致谢) 和 [第三方声明](../THIRD_PARTY_NOTICES.md)。
