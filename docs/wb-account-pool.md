# WB 帐号池

原生侧栏 **wb帐号池** 是 WorkBuddy 多账号的统一管理页，使用同一套 Node 管理 API。**积分总览排除 WB**，不会重复显示 WB 积分；管理 API 原有全平台余额输出保留兼容。

## 页面结构

1. 顶部大字号 **积分剩余 / 总额**：汇总启用、非封禁账号的已知积分，并显示总账号数、封禁数、停用数和待获取数。
2. 每账号一张卡：身份、状态、余额、最近核验、积分包预览、任务摘要和操作入口。
3. “详细资料”窗口：四个标签页——**账号资料与登录状态、全部积分包、全部任务状态、操作回执**，均可滚动查看。
4. 去重模型区：按国内/国际版及精确模型名只列一次，保留原有客户端路由 ID。
5. 账号管理操作：添加登录、保存当前客户端账号、切号、合并聊天、自动开关、标记封禁与删除。

所有已保存账号都会列出，包括停用、认证拒绝与封禁账号。坏状态不通过隐藏卡片来“解决”；用户能核对 ID、UID 和原因后决定是否删除。

## 添加、导入导出与轮换

账号管理增加本机 JSON/ZIP 交换、只读预览、按国内/国际版与 UID 去重、明确选择导出和显示名/备注整理。交换文件包含凭据，公开示例只有 SAMPLE；详细格式、限制、接口和替换保留语义见 [WB 账号交换](WB_ACCOUNT_TRANSFER.md)。

账号自动轮换默认关闭，可选择到期优先/顺序及网关/CodeBuddy CLI 目标。轮换不打断生成、不关闭运行中的 CLI、不改变签到任务开关；候选、冷却、门控和逐目标结果见 [WB 轮换](WB_ROTATION.md)。参考项目能力与本工程独立实现边界见[功能对照](WB_SWITCH_COMPARISON.md)。

## 身份与登录详情

### 标识不能混为一谈

| 返回字段 | 内容与语义 |
|---|---|
| `accountId` / `id` | 网关配置槽位，管理 API 使用它引用账号 |
| `label` | 网关显示名/备注，不作为官方身份依据 |
| `identity.uid` | 上游稳定主体标识；没有返回时为 `null` |
| `identity.userId` | 上游用户 ID，不强制与 UID 相同 |
| `identity.nickname` / `username` / `email` | 保存登录中可读取的资料 |
| `identity.domain` | 本机登录的域信息 |
| `identity.source` | `desktop_file` / `saved_session` / `saved_config` 等身份来源 |
| `identity.readError` | 本机资料读取失败原因；没有资料不补造用户 |
| `profile` | 经过筛选的昵称、用户名、邮箱和头像 URL |
| `edition` / `region` / `version` | 国内/国际版与已知客户端版本 |
| `credential.status` | `authenticated`、`auth_rejected`、`banned`、`check_failed`、`not_checked`、`missing` 等实际状态 |
| `credential.accessState` / `refreshState` | Access/Refresh 独立元状态，如 `configured`、过期或缺失，不将“有文件”等同可调用 |
| `credential.accessExpiresAt` / `refreshExpiresAt` | Access/Refresh 有效期元数据，未知为 `null` |
| `credential.hasAccessToken` / `hasRefreshToken` | 是否有本机凭据的布尔值，不是凭据正文 |
| `enabled` / `current` | 启用状态与当前网关偏好账号 |

详情**不返回 access token、refresh token、Cookie 或密码**。UID、邮箱等账号资料只出现在本机受管理鉴权保护的界面，不写入活动用量日志。

默认 summary/details 缓存读取只读取已保存的身份 JSON 元数据和可用到期声明，不解密、续期或轮换令牌，不触发模型调用、接受任务或领奖。显式 `refresh=true` 才进行相应远端核验；停用账号仍显示，但不作为自动批量刷新或自动任务目标。

### 多账号登录

- “添加登录”使用官方授权流程，国内版 `cn` 与国际版 `ai` 分开；每次成功授权保存独立本机快照。
- “保存客户端当前账号”捕获已经在 WorkBuddy 官方客户端登录的账号。快照保存有效期和来源，同一主体重复保存会合并，而非创建无数重复号。
- 多账号常驻指独立保存多个快照；官方客户端的单份登录文件仍代表一个当前主体。
- 后续切换复用有效快照；官方撤销、凭据过期或策略变化仍按真实认证结果处理。

## 封禁、认证失败与人工标记

`ban` 对象包含 `status`、`reason`、`httpStatus`、`upstreamCode`、`source` 和 `checkedAt`。

| `ban.status` | 含义 | 处理方式 |
|---|---|---|
| `banned` | 官方明确封禁/blocked，或用户做本机封禁标记 | 保留卡与详情，退出 WB 调用候选 |
| `auth_rejected` | 登录失效、凭据撤销或认证被拒 | 检查新官方登录，不自动当封禁 |
| `unknown` | 未查询、查询失败或证据不足 | 显示实际错误/时间和最近成功数据 |
| `clear` | 最近官方核验未见封禁且成功 | 仍受账号启用、模型能力和额度限制 |

HTTP **401/403 单独出现不等于账号封禁**。业务认证错误（例如 `12153`）同样按认证拒绝而非封禁处理。只有明确的账号封禁/blocked 证据才作为官方事实；模型能力、余额为零和查询超时也不能替代封禁证据。

“标记封禁”是用户已知结果的本机整理功能，`source:"user_marked"` 与 `source:"official_response"` 分开。标记可撤销；清除本地标记不会清除已有官方封禁证据，也不会保证账号立即可用。

```http
POST /admin/workbuddy/accounts/ACCOUNT/mark-status
Authorization: Bearer TOKEN
Content-Type: application/json
```

```json
{"status":"banned","reason":"SAMPLE：已由用户核对","confirm":true}
```

清除人工标记使用同一路径，body 为 `{"status":"clear","confirm":true}`。标记不向官方发出封号操作，不自动删凭据、聊天或历史。

## 积分剩余 / 总额

### 汇总语义

- `totals.remaining` / `totals.total`：启用、非封禁账号全部结果已知时的完整汇总；部分未知则为 `null`。
- `totals.knownRemaining` / `knownTotal`：可核验部分的汇总。
- `totals.knownAccounts` / `unknownAccounts`：可用余额已知/未知数量。
- `totals.accountCount`：启用、非封禁账号数。
- `totals.allAccounts` / `bannedAccounts` / `disabledAccounts`：全部保存账号、封禁数、停用数。

页面大字号显示完整或“已知积分剩余 / 总额”，并标注部分账号待获取。封禁/停用账号仍显示各自已知数据，但不计入可调用池的积分总额。没有总额时保留未知，不拿剩余值充当总额。

### 单账号余额

旧 `remaining` / `total` / `consumed` 顶层字段继续保留，便于已有管理工具兼容；详细数据放在 `balance`：

| 字段 | 语义 |
|---|---|
| `remaining` / `total` / `consumed` | 官方可核验剩余、有效积分包总额与已消耗 |
| `packages` / `packageCount` | 官方该查询范围返回的全部积分包与数量，保留其中已耗尽/过期行，不只前三项 |
| `queryScope` | `endTimeBegin` / `endTimeEnd` / `statuses` 给出官方查询起止时间与状态筛选；`allHistoricalStatuses:false` 明示不保证任意状态全历史 |
| `complete` | 仅代表上述官方查询范围分页齐全；未完整时总额不伪装为已知 |
| `checkedAt` / `lastSuccessAt` | 此前余额核验/最后成功时间 |
| `lastFailureAt` / `error` | 最近失败时间、状态码与错误 |
| `stale` | 当前数值是失败后保留的旧成功数据 |

当前“总额”是官方返回的有效积分包容量，不是历史累计充值或每日公示权益。最近失败不会抹掉所有历史成功，也不会把旧结果标记成刚刚成功。

### 全部积分包

详情窗口“全部积分包”逐项显示**官方该查询范围返回的全部包**，保留其中已耗尽/过期行，不受卡片只预览少量包的限制。查询起点为 `2000-01-01 00:00:00`，保留协议 `Status:[0,3]`，实际起止时间和状态由 `queryScope` 返回；不保证任意状态的全部历史均可获取。后端进行有界分页、去重和完整性检查，`complete:true` 仅表示此范围分页齐全；分页上限或重复页导致未完整时以 `complete:false` 明确表达，不静默少算。

| 包字段 | 内容 |
|---|---|
| `id` / `rowKey` | 官方包标识与本次显示序号；缺官方 ID 保留 `null` |
| `name` / `packageName` | 名称 |
| `packageCode` / `subProductCode` / `subProductName` | 包编码、子产品编码/名 |
| `total` / `size` | 官方容量 |
| `remaining` / `remain` / `balance` | 同一归一化剩余数值的兼容字段 |
| `consumed` | 已消耗，结合官方已用及容量/剩余核验 |
| `cycle` / `monthly` | 是否周期包 |
| `createdAt` / `expiresAt` / `expiresAtMs` / `refreshAt` | 创建、到期、毫秒到期与刷新时间 |
| `status` | `available` / `exhausted` / `expired` / `unknown` |
| `upstreamStatus` | 官方原始包状态 |

周期包优先解析周期容量/剩余；过期包不计入可用总额。包剩余、模型套餐资格和工具支持是不同层次，正积分不保证任意调用成功。

## 完整任务内容与状态

### 任务字段

“全部任务状态”给出每条官方任务，不因为暂未自动化而隐藏。

| 字段 | 内容 |
|---|---|
| `taskCode` | 官方任务代码，也是动作选择标识 |
| `title` / `name` / `description` / `taskDesc` | 名称、详细内容与原始说明 |
| `taskType` / `tag` | 任务类型和标签/适用端信息，以官方返回为准 |
| `current` / `progress` / `target` | 当前进度与目标 |
| `rewardCredit` / `rewardEnergy` / `rewardBuddy` / `reward` | 积分、能量、Buddy 与可读奖励 |
| `hasReward` | 是否有奖励 |
| `acceptStatus` / `accepted` | 官方接受状态与归一化布尔值 |
| `qualified` / `claimable` | 进度达标、可领取状态 |
| `claimed` / `locked` / `status` / `serverStatus` | 已领、锁定、归一化和官方原状态 |
| `jumpUrl` | 官方任务跳转地址，若有返回 |
| `automaticExecution` / `executionStrategy` | 是否注册真实执行器、下一动作策略 |
| `lastReceipt` | 该任务最近操作回执 |

外层 `tasks` 给出 `items`（兼容 `tasks`）、`checkedAt`、`lastSuccessAt`、`lastFailureAt`、`stale`、`error`、`source` 与 `receipts`。未查询、查询失败与官方确认为空列表分开显示。

### 当前自动执行的真实覆盖

已注册 18 个官方任务的真实执行器，自动任务按“查询 → 接受确认 → 真实功能执行 → 消费完整结果与独立读回 → 官方进度回查 → 达标领取 → 再查 claimed”闭环运行，并保留真实每日签到。自动任务开关默认关闭，统一后台调度器约每 30 分钟检查，同账号互斥；关闭后取消后续自动流程。组件、前置条件与各类任务的执行方式见 [WB 真实功能自动执行器](WB_TASK_EXECUTORS.md)。

以下不是同一件事：

1. 查询返回任务。
2. 用户/程序接受任务。
3. 在真实产品功能中完成任务。
4. 官方进度达到目标。
5. 领取奖励。
6. 官方回查确认已领取。

真实执行覆盖对话、市场技能、画布、模板、专家/专家团、自动化、资料库与外观等功能；注册执行器不等于依赖已经就绪，也不等于官方已经记账。自动化以创建后持久读回并暂停为业务验证，资料库要求读取真实正文，外观要求设置后读回；实际动作验证通过而官方成长进度尚未确认时，仍等待回查，不强领未达标奖励。

应用授权状态观察不等于真实应用体验；应用、外部订阅等前置条件未满足时显示具体等待原因。模板、专家等真实动作已提交而结果未知时保留 `pending`，不重复提交模型动作。未注册的任务仍保留 `manual_action_required`。网关不发送伪造使用事件，也不把请求成功、执行器 `completed` 或领奖提交成功当成官方任务已完成。

| `executionStrategy` | 含义 |
|---|---|
| `already_claimed` | 官方已确认领取 |
| `locked` | 官方锁定 |
| `claim_server_confirmed_reward` | 服务端已达标，可以尝试领奖后回查 |
| `registered_executor_then_verify` | 仅在实际注册执行器时执行，之后回查 |
| `manual_action_required` | 需要真实手工功能使用或尚未接入执行器 |

回执保留动作、taskCode、时间、状态、`serverConfirmed`、错误等。真实执行与领奖均有持久幂等记录，结果未知时不盲目重复提交；实际动作进度与官方 `current` / `target` / `claimed` 分开展示。常见回执 `accepted`、`accept_unconfirmed`、`claimed`、`claim_unconfirmed`、`already_claimed`、`action_required` 应分别展示。

## 每日签到不等于自动刷新

`dailyCheckin` 独立展示签到状态、查询时间、官方今日结果与错误。刷新余额只是查询，不发积分；自动任务包含真实签到，只有官方回执/账单确认才能认定到账。小浣熊等平台的“每日签到领取”语义与 WB 任务列表也不要混同。

## 只停用积分调用，保留签到与任务

每个账号卡片底部固定提供 **停用该账号**；停用后按钮变为 **启用该账号**。该操作仅修改当前 WB 账号的 `inferenceEnabled`：省略或 `true` 表示允许模型调用，`false` 表示停止使用该账号的积分，不参与模型候选、自动接力或调用账号切换。

这个开关不修改账号整体的 `enabled`、任务开关、自动签到、`workbuddy.autoTasks` 或自动迁移设置。只停用积分的账号仍保留资料、余额与任务，签到和已实现的自动任务照常按原设置运行；任务本身的官方执行和领取条件仍按实际状态验证。

```http
POST /admin/workbuddy/accounts/ACCOUNT/inference
Authorization: Bearer TOKEN
Content-Type: application/json

{"enabled":false}
```

恢复使用时发送 `{"enabled":true}`。summary/details 返回 `inferenceEnabled`；`totals.inferenceEnabledAccounts` / `inferenceDisabledAccounts` 分别统计允许与暂停积分调用的账号，`inferenceRemaining` / `inferenceTotal` 表示可调用部分的已知额度。总资产与可调用额度分开，不将暂停积分的余额记为零。

此操作与把整个账号 `enabled` 设为 `false`、封禁标记或删除账号不同。每次新调用均重新核对实际设置，已开始的响应不因开关变化而被中止或重放。

## 切换账号

“切换此号”同时切官方客户端登录文件与网关后续请求，先关闭官方 WorkBuddy，切换后重新打开。写入前备份，失败恢复原客户端登录与网关偏好；正在输出的请求不迁移，不重放已经交付的工具。

```json
{"switchClient":true,"migrate":false}
```

发送至 `POST /admin/workbuddy/accounts/ACCOUNT/switch`。省略 `switchClient` 的 API 默认不切官方客户端；`switchClient:false` 仅切网关下一请求。`migrate` 省略时使用自动迁移设置。

已封禁账号拒绝作为切换目标；停用账号和未入启用池的账号返回实际错误。积分耗尽后只在同版本同型号 WB 池内选择下一账号，保留原客户端模型 ID 和停用路由状态。

## 聊天合并与自动迁移

“一键合并聊天”把保存账号的本机可读 JSONL/SQLite 会话**以新 ID 加法复制**到当前目标号。开启 `autoMigrateSessions` 后，每次切号执行同样复制，默认关闭。

原文、JSONL、数据库来源与官方 edge-sync 映射保留。复制建立本机幂等映射，重复合并不无限增殖；新增内容生成可识别的新版本副本。写入前建立并校验私密备份。

```json
{"targetAccountId":"ACCOUNT","sourceAccountIds":["SOURCE_ACCOUNT"]}
```

发送至 `POST /admin/workbuddy/sessions/merge`。省略来源时处理其他保存账号；目标与来源仍受实际身份/会话能力校验。

`cloudSyncConfirmed:false` 表示云端归属与同步仍需官方客户端下次启动确认。本机处理不等于官方云同步成功；客户端运行中、正文不完整或结构未适配时返回具体待处理结果，保留原账号和源会话。

## 删除账号

卡片和普通账号管理页均有删除。发送 `DELETE /admin/accounts/ACCOUNT`，body 必须为 `{"confirm":true}`。

确认后清理账号、所属上游、池引用及无有效目标路由；仍有其他 WB 目标的路由保留对应接力。聊天、历史和凭据文件保留，响应包括 `credentialFilesPreserved:true` / `historyPreserved:true` 及私密 `backupFile`。

备份在实际 `dataDir/account-deletion-backups/`，包含私有配置，仅留本机。删除与停用、人工封禁标记不同；不会在刷新时自动删除封禁账号。

## 同模型接力与错误诊断

```json
{"modelRelay":{"enabled":true,"partitions":{"workbuddy":true,"other":true}}}
```

WB 只接 WB，其他供应之间接力排除 WB，手工混合配置同样被筛选。封禁与停用号不参与调用，认证拒绝按独立原因处理。

主供应按真实可核验窗口广播，备用逐个验证上下文、工具和输出能力；不删历史或缩短输出预算。供给默认 30 秒无有效进展才超时，正文、推理和工具增量刷新计时；HTTP 整轮预算仍独立存在。

余额为正与工具/模型资格分开。工具不兼容、上下文超限、认证、限流、真实耗尽分别记录；能力错误不应把整个账号写入硬额度冷却。

## 本机管理 API 总表

所有管理请求使用 `Authorization: Bearer TOKEN`，其中 TOKEN 指本机 `adminKey`。不要写在 URL 或日志。正文上限固定 4 MiB。

| 方法与路径 | 作用 |
|---|---|
| `GET /admin/workbuddy/summary` | 全部账号、汇总、去重模型、设置与会话能力；缓存只读 |
| `GET /admin/workbuddy/summary?refresh=true&accountId=ACCOUNT` | 定向刷新启用账号余额 |
| `GET /admin/workbuddy/accounts/ACCOUNT/details?refresh=true` | `{account,refreshed}`，详情刷新包含任务核验 |
| `POST /admin/workbuddy/accounts/ACCOUNT/mark-status` | 本机 `banned`/`clear` 标记，显式 `confirm:true` |
| `POST /admin/workbuddy/login/start` | `{edition:"cn"\|"ai",label?}` 发起官方授权 |
| `POST /admin/workbuddy/login/poll` | `{loginId}` 查询授权并保存 |
| `POST /admin/workbuddy/login/cancel` | `{loginId}` 取消等待 |
| `POST /admin/workbuddy/capture` | 保存官方客户端当前账号 |
| `POST /admin/workbuddy/accounts/ACCOUNT/switch` | `{switchClient,migrate?}` 切号 |
| `POST /admin/workbuddy/sessions/merge` | `{targetAccountId,sourceAccountIds?}` 合并本机副本 |
| `POST /admin/workbuddy/settings` | `{autoTasks?,autoMigrateSessions?}`，仅布尔 |
| `POST /admin/workbuddy/pool/normalize` | 同版本同型号池，保留旧路由 ID 与停用项 |
| `GET /admin/workbuddy/tasks?accountId=ACCOUNT` | 查询官方任务 |
| `POST /admin/workbuddy/tasks` | `{action:"query"\|"accept"\|"run"\|"claim",accountId?,taskCodes?}` |
| `DELETE /admin/accounts/ACCOUNT` | `{confirm:true}` 删除并清引用，保留历史/聊天 |

POST tasks 省略账号时逐个处理启用且非封禁 WB 账号；`taskCode` 可选择单任务，`taskCodes` 可选择多个。具体错误码、主服务鉴权和旧池接口兼容见 [API 契约](api.md)。

## 参考与许可证

- [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)：登录/会话格式、积分与身份组织参照，固定提交 `22b318c1f44b335c2222e444abcc2d0f74e160f7`。
- [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)：官方积分包、任务协议和池状态参照，固定提交 `6b31db6d045e985042620c819c3a938002e7b0b1`。
- [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)：认证/错误分类对照，固定提交 `ac4c55ef5e0833bf0138846a7c5255ecbc14a07c`。

完整 MIT 声明保留于 [src/workbuddy-reference-license.mjs](../src/workbuddy-reference-license.mjs)，详细边界见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。未执行第三方安装脚本，不移植上游全部功能，不替换 DSH profile，也不把未实现真实执行器宣传为自动完成。
