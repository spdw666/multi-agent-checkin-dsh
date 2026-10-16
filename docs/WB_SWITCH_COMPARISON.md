# WorkBuddy-switch 功能对照与实现选择

## 来源与版本

参考仓库：[changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)。源码核对固定为 `22b318c1f44b335c2222e444abcc2d0f74e160f7`，提交日期 2026-10-12，版本线 0.1.62。仓库采用 MIT，Copyright (c) 2026 wb-switch。完整许可随本工程保存在 [workbuddy-reference-license.mjs](../src/workbuddy-reference-license.mjs)。

本工程保持 Node.js 服务和 Windows 原生界面，不嵌入参考项目的 Rust/Tauri/React 应用。下表区分功能参照、已有实现和新增独立适配；“接口/离线回归”与账号当前真实资格、服务端实测、云同步属于不同证据层。

## 能力矩阵

| 能力 | workbuddy-switch 的具体实现 | AI积分网关的选择 |
|---|---|---|
| 多账号添加 | OAuth、采集官方当前登录、账号库 | 保留官方登录和保存当前号；另增加 JSON/ZIP 本机导入，独立凭据文件与稳定账号槽位 |
| 导入预览 | JSON 数组逐项预览；隐藏 token；按选中索引导入 | 预览身份、版本、到期、重复与校验问题；提交重新核对文件与当前配置，不将预览当已导入 |
| 去重 | 顶层 `uid` 覆盖，缺 ID 补 ID | 按国内/国际版 + 稳定 UID 去重；默认跳过，显式替换只更新登录态，保留本地路由、任务、启停与槽位 |
| JSON 导出 | 所选完整账号记录数组，含 `access_token` 与 `refresh_token` | 对已保存账号导出默认嵌套 JSON、逐账号 ZIP 或 `switch-json` 扁平数组；公开说明只有 SAMPLE，占位示例与真实文件分离 |
| ZIP | 该提交 `export_import.rs` 是 JSON 流程 | 新增受限 ZIP 解析与逐账号 JSON 打包；在内存读取，不运行压缩包内容 |
| 账号备注 | `note`、`displayField` 控制展示名 | 独立 `label` + `notes`，只更新本机展示，不改上游身份或路由 ID |
| 积分到期 | 包剩余、最早到期、紧迫度排序 | 使用本网关已归一积分包，过滤过期、未知、失效与暂停积分调用账号；保留缓存时间和排除原因 |
| 自动轮换 | CodeBuddy CLI：最早到期优先，冷却、差异阈值、心跳存活门控 | 默认关闭；显式选择网关、CodeBuddy CLI 或两者；到期优先/顺序轮换；网关只影响下一请求，CLI 运行时推迟 |
| CLI 登录状态 | Windows `settings.json.env`；其他系统 helper；独立当前账号 | 按本工程适配范围处理下一次 CLI 启动身份，不关闭或重启正在运行的 CLI；具体写入/备份见轮换手册 |
| WorkBuddy 桌面切号 | 登录文件写入，进度，官方客户端关闭/重开 | 已有客户端切换；写入前备份，客户端正在运行时保留实际状态，不替用户终止生成 |
| 会话复制 | 新 ID 副本与跨账号关联/增量同步 | 已有本机加法复制、幂等映射与来源保留；云归属仍由官方客户端确认，不把本机副本称已云同步 |
| 签到与真实任务 | 账号管理与使用监控为主 | 网关保留独立真实签到/任务执行器和官方回查；暂停积分调用不停止签到任务 |
| 积分/Token 统计 | 官方用量趋势、多来源 Token 统计 | 网关活动洞察只记录本网关请求和官方返回 usage；不冒充全部客户端的完整账单 |
| IDE / VS Code / JetBrains 切号 | 参考项目各自原生实现 | 本工程保持已有 WorkBuddy 桌面与明确的 CLI 适配；IDE/编辑器插件写入流程继续由对应客户端管理 |
| 悬浮窗 / 自动更新 | Agent Companion、签名整包更新 | 未移植参考应用的桌面层；本工程使用自己的七页界面与源码/发行更新流程 |

## 可复核源码

- [JSON 解析、预览、合并、选择导出](https://github.com/changexbc/workbuddy-switch/blob/22b318c1f44b335c2222e444abcc2d0f74e160f7/crates/wb-switch-core/src/modules/export_import.rs)：`parse_accounts_json`（29–43）、`preview_accounts`（52–76）、`merge_import_record`（94–136）、`select_export_records`（180–205）。参考项目原始格式为账号对象数组，明文凭据字段使用 snake_case；加密信封可以入其库，并不意味着网关可直接使用信封调用。
- [账号保存与本地备注](https://github.com/changexbc/workbuddy-switch/blob/22b318c1f44b335c2222e444abcc2d0f74e160f7/crates/wb-switch-core/src/modules/account.rs)：`account_display_name`、`account_meta`、`update_account_display_in`，本地展示字段与稳定身份分开。
- [到期轮换决策](https://github.com/changexbc/workbuddy-switch/blob/22b318c1f44b335c2222e444abcc2d0f74e160f7/crates/wb-switch-core/src/modules/rotate.rs)：`Candidate`、`to_candidate`、`decide_target`、`run_rotate_cycle`，只选择已知有效且有余额候选，使用冷却/紧迫度/差异/最小余额门槛。
- [CLI 写入与存活判定](https://github.com/changexbc/workbuddy-switch/blob/22b318c1f44b335c2222e444abcc2d0f74e160f7/crates/wb-switch-core/src/modules/codebuddy_cli.rs)：21–60 为路径/区域常量；77–156 为 `sessions` 心跳门控；202–296 为地区环境及缓存；302–339 为精确 CLI 进程形状；1430–1516 为账号选择提交。
- [helper](https://github.com/changexbc/workbuddy-switch/blob/22b318c1f44b335c2222e444abcc2d0f74e160f7/scripts/codebuddy-cli-helper.cjs)：读取账号库和 `activeAccountId`，只输出当前账号的 Bearer token。网关没有把这个读取参考项目账号库的 helper 直接搬作自己的凭据管理器。
- [原项目导入界面](https://github.com/changexbc/workbuddy-switch/blob/22b318c1f44b335c2222e444abcc2d0f74e160f7/src/components/import-accounts-dialog.tsx)与[导出界面](https://github.com/changexbc/workbuddy-switch/blob/22b318c1f44b335c2222e444abcc2d0f74e160f7/src/components/export-accounts-dialog.tsx)：选文件→预览→选择→合并，以及多选→保存路径的交互参照。

## 复用与独立实现决策

1. 复用原项目已公开的格式/协议知识、同 UID 去重思路、到期紧迫度与存活门控约束；保持完整许可和固定来源记录。
2. 不整体移植账号库或客户端切换代码，避免覆盖网关稳定 ID、已有任务、路由与本机绑定。网关用现有 `ConfigStore` 提交队列和自己的备份/回执。
3. 原项目主动切换 CLI 的实现会关闭 CLI；网关轮换采用“检测到运行则推迟”，不复用终止进程流程。
4. 附件类 `account` / `auth` JSON 与参考项目顶层数组是不同交换形状，两者明文格式分别适配；机器绑定密文以明确错误返回。具体可接受字段和导出形状以 [账号交换手册](WB_ACCOUNT_TRANSFER.md) 为准，不以相似文件名推断全兼容。
5. 上游新增功能、官方客户端升级与配额规则均会变化；固定提交是可复核参考，不是本工程所有后续行为的代理承诺。
