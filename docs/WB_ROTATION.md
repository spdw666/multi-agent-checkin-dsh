# WB 账号自动轮换

轮换用于决定**后续请求/后续 CLI 启动**优先使用哪个 WB 账号。它与“同一个请求遇到额度不足时的同型号接力”不同，也与签到/任务调度不同。功能参考 workbuddy-switch 的到期紧迫度、冷却和 CLI 存活门控，本工程使用独立 Node 实现；来源与差异见[能力对照](WB_SWITCH_COMPARISON.md)。

## 三种目标

| `target` | 行为 |
|---|---|
| `gateway` | 在同版本、同精确型号的现有 WB 池里更新下一请求偏好，不改客户端登录文件 |
| `codebuddy-cli` | 为后续 CodeBuddy CLI 启动写入选择；检测到运行会话或相关进程时推迟，不关闭 CLI |
| `both` | 对两个目标分别核对条件和回执，保留各自成功/推迟/失败状态 |

默认 `enabled:false`。网关偏好不改现有路由 ID、路由启停、输入历史、工具、输出预算和运行中的响应。CLI 只在空闲门控通过时更改下一次启动使用的身份；已运行进程持有的 token 是进程快照，改文件不等于该进程已经切换。

## 候选与排序

轮换只考虑所选国内/国际版、整体账号启用、允许积分调用、未封禁、登录和额度证据满足策略的 WB 账号。其他平台（包括独立 `workbuddyai` 适配器）不进入 WB 池。同版同型候选由当前配置决定，不复活关闭的路由或被用户移除的手动池成员。

- **到期优先 `expiry`**：从仍有可用剩余的有效积分包提取最早到期，早到期优先；过期包不创造可用积分。
- **顺序轮换 `round_robin`**：在有效候选中按稳定顺序前进，保留上次选择状态；不是每个 Token 或每一工具步骤换账号。
- **未知/过期**：余额未知、过期或校验失败单独记录排除原因，不补成 0，不自动使用猜测余额。
- **冷却与差异**：`cooldownMinutes` 限制连续切换，`minGapHours` 防止两个相近到期账号反复跳转；`minUrgencyHours` 控制到期优先的紧迫窗口。
- **最小余额**：`minRemainingCredits` 只与 WB 积分比较，不跨现金/Token 单位。
- **暂停积分**：`accounts[].inferenceEnabled:false` 始终排除，不因轮换、忽略冷却或管理查询重新启用。

余额/目录的缓存时间、完整性和真实调用证据分开；目录列出模型不等于该账号已通过真实推理。策略选择不自动制造模型探测或消耗积分验证。

## 界面与设置

在 **wb帐号池 → 轮换设置** 保存开关、版本、目标和策略。**预览**只读展示可用/排除账号与各目标计划；**立即评估**按当前保存设置返回逐目标结果，不生成模型请求。先保存设置再执行，防止把对话框尚未保存的值当作当前策略。

### 设置字段

```json
{
  "enabled": false,
  "target": "gateway",
  "strategy": "expiry",
  "intervalMinutes": 5,
  "cooldownMinutes": 120,
  "minUrgencyHours": 72,
  "minRemainingCredits": 0,
  "minGapHours": 6,
  "edition": "cn"
}
```

设置属于 `workbuddy.rotation`，API 接受上述平铺字段；省略字段保留当前设置，未知字段/错类型返回输入错误。`edition` 为 `cn` / `ai`。关闭轮换不会关闭账号、签到或自动任务，也不会清空账号、历史或已保存的凭据。

### 数值范围

| 字段 | 默认 | 范围 |
|---|---:|---|
| `intervalMinutes` | 5 | 整数 1–1440 |
| `cooldownMinutes` | 120 | 整数 0–10080 |
| `minUrgencyHours` | 72 | 整数 0–8760 |
| `minGapHours` | 6 | 整数 0–8760 |
| `minRemainingCredits` | 0 | 有限数 0–1000000，可小数 |

## 预览、评估与记录

```http
GET /admin/workbuddy/rotation
Authorization: Bearer TOKEN
```

返回 `{settings,state,preview}`。`preview.gateway` 是逐路由计划，`preview.cli` 是 CLI 计划，`eligibleAccounts` / `excludedAccounts` 给候选与排除原因，`gatewayBusy` 给实际忙状态。先看 `preview` 的目标、候选、排序、排除/跳过原因，再决定是否启用。状态保留最近评估和各目标回执；设置已保存与账号已切换是不同结果。

```http
POST /admin/workbuddy/rotation
Authorization: Bearer TOKEN
Content-Type: application/json

{"enabled":true,"target":"gateway","strategy":"expiry","edition":"cn"}
```

显式评估：

```http
POST /admin/workbuddy/rotation/evaluate
Authorization: Bearer TOKEN
Content-Type: application/json

{"dryRun":true}
```

`dryRun` 默认 `true`，预览不写账号偏好或 CLI 登录。`dryRun:false` 按已保存策略检查并尝试提交；回执要分别检查选择、跳过/推迟和失败，而不只看 HTTP 200。重复点击/调度按同一互斥与冷却状态执行，避免并发反复切换。

后台轮换使用共享 SQLite 租约，定时续租并在提交前核对所有者；丢失所有权返回 `rotation_lease_lost`，旧流程停止后续写入，不清理新所有者的租约。服务停止后不启动新的刷新批次，已经开始的查询按有界预算退出。

## CodeBuddy CLI 门控与地区

CLI 存活检测读取 `~/.codebuddy/sessions/` 注册表：`<pid>.json` 或 `manual-*.json`，有效 `lastHeartbeat` 在 120 秒内即视为存活；未来心跳也保守视为存活。该心跳约每 30 秒更新，与用户是否正在对话无关。另核对明确的 CodeBuddy CLI 进程形状，避免只按 `codebuddy` 一个词误判 IDE。

检测到 CLI 会话/进程时返回推迟原因，不终止进程、不重启应用、不改运行中响应。CLI 目录/配置读取失败、环境覆盖冲突或凭据不完整也保留具体原因。

Windows CLI 设置使用 `~/.codebuddy/settings.json.env` 中的 `CODEBUDDY_AUTH_TOKEN`，保留其他配置字段。国内版地区为 `internal`，国际版为 `public` 并使用官方国际兼容地址；地区缓存与配置写入同时核验。写入前保存相关本机原件，失败恢复本次仍属于本操作的改变；外部已有更新时保留新文件并报告回退冲突，其它无冲突文件继续恢复。敏感内容只在本机备份，状态 API 不返回 token。现有 `CODEBUDDY_AUTH_TOKEN` / 地区环境覆盖或自定义 helper 冲突需要先整理，仅凭“写了文件”不代表实际覆盖已生效。

本功能并不接管参考项目 `.wb-switch/accounts.json` 或其 `.codebuddy-rotate/state.json`；网关保存自己的状态与备份。WorkBuddy 客户端切号、CodeBuddy IDE、VS Code/JetBrains 插件仍是各自不同的登录目标。

## 故障与验证口径

| 现象 | 核对项 |
|---|---|
| 开关开了但未切号 | 预览排除原因、策略紧迫窗口、冷却、当前已为目标、CLI 存活 |
| 还有积分但候选被排除 | 登录状态、积分调用开关、官方封禁、当前版、包到期、余额新鲜度 |
| 网关选择变化但客户端未换 | `target:gateway` 只改下一请求，未写桌面/CLI 登录 |
| CLI 配置保存后旧窗口仍用旧号 | 已运行进程仍持旧 token；自动轮换应在门控阶段推迟 |
| 轮换成功但推理失败 | 选择结果与账号当前模型资格、429、上下文/工具能力是独立证据 |

离线验证使用 SAMPLE 账号与沙箱文件，覆盖候选排序、暂停积分排除、冷却、心跳/进程门控和写入回滚；真实验收另记录实际环境与回执。自动轮换不保证官方配额恢复，不绕开真实限流，不把轮换日志当一次成功生成。
