# 来源与许可证

本工程的领取账本、配置分层、OpenAI 输出层、CLI、Web 管理页与调度器独立实现，采用 MIT。

## 实际代码复用

| 来源 | 复用位置 | 许可证与版本 |
|---|---|---|
| [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | `vendor/workbuddy/upstream.ts`、`dsml-recovery.ts`，构建成 `vendor/workbuddy-core.mjs`；上游源码未改 | MIT，Copyright (c) 2026 LaoDing；3.6.0，提交 `bf4470e3af4d638b8dcfcb8932177413c5484df6` |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | `vendor/trae/*.ts`；仅账号解密、设备身份、模型目录、SOLO bridge、签到与区域模块被构建到 `vendor/trae-core.mjs` | MIT，Copyright (c) 2026 LaoDing；2.10.0，提交 `3f6321961d4aa827a0e9f7ce32f0ab2a2be5d4a2` |
| [spirodelazz/ide-daily-checkin](https://github.com/spirodelazz/ide-daily-checkin)，其 WorkBuddy 脚本注明源自 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin) | 从 `scripts/signin.py` 的 `AUTH_HELPER_JS` 原样提取为 `vendor/wb-auth-helper.cjs`。只复用凭据读取助手，不执行该项目的成长任务、抽奖或补签 | MIT；原仓库完整许可证保存在 `vendor/LICENSE.ide-daily-checkin`，原脚本署名 88lin |

WorkBuddy 上游的 DSML 模块包含对 [hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api) 解析器的代码移植，原上游注明 MIT、Copyright (c) 2026 Mayer。对应来源、改动说明及上游完整 Third-Party Notices 均保留在 `vendor/workbuddy/`。本工程增加的是统一输出层中的调用形状映射，而非改写该解析器。

所有被分发的上游源码保留文件头部声明。两个 DSH 上游的完整 MIT LICENSE 与 THIRD_PARTY_NOTICES 随包保存在对应 vendor 目录。

Trae SOLO bridge 本地新增仅 `deepseek-v4.1-flash` 的 reasoning-only stop 有界恢复：无可见正文或工具片段时同请求最多一次重试，共享取消与截止预算，累计真实用量；不将思考当最终答案、不重放工具。详见 `docs/trae-reasoning-only.md`，上游 MIT 归属保持。

## 读取并参考，未复制其程序

同款供给组、免费平台注册及故障接力参考 [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)（MIT）；原生活动洞察的信息组织参考 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0）。未复制代码或素材，免费政策另以官方当前资料核对，来源见 `docs/free-providers.md` 与 `docs/model-relay.md`。

| 项目 | 许可证 | 使用决定 |
|---|---|---|
| [ZlaxeyX/workbuddy-auto-checkin](https://github.com/ZlaxeyX/workbuddy-auto-checkin) | MIT | 参考按天幂等与 Windows 计划任务；其默认不带 `/v2` 的旧接口并未直接照搬，实际使用客户端与 dsh-connect-workbuddy 的 `/v2` 接口 |
| [Shuffle-1992/TraeSign](https://github.com/Shuffle-1992/TraeSign) | MIT | 参考 ZCode enc:v1 凭据形状和签到活动接口；启动客户端后本机凭据与只读 billing preview 已通过；活动领取与模型反代尚未完成 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | 核对 bundle、PiAiAdapter、provider 注册契约；实际验证绑定本机 0.2.0-rc.2 Desktop runtime，而非 GitHub 主线版本 |
| [cmochance/codex-app-transfer](https://github.com/cmochance/codex-app-transfer) | MIT | 参考 WorkBuddy 模型目录线索，未复制 Rust 源码 |
| [0xgetz/minimax-agent-automation](https://github.com/0xgetz/minimax-agent-automation) | MIT | 仅参考持久化浏览器状态与签到 UI；注册、一次性邮箱、多账号批量注册等流程未纳入本工程 |

QwenWork 个人版账号上下文与加密存储形状依据本机已安装 QwenWorkCN 1.2.5 的只读源码观察后独立实现；产品源文件不随工程分发。它与 Qwen Code CLI、Qoder 或企业版并非同一接入适配器。

构建依赖 esbuild 0.28.2（MIT）；核心运行使用 Node.js 内置 HTTP、crypto、SQLite，无外部运行依赖。DSH peers 的许可证随宿主包提供；本工程不将宿主 runtime 重新打包。

另查阅 denysvitali/llm-proxy 的 ZCode/MiniMax Code 接入说明；仓库未声明清晰 LICENSE，本工程未复制其代码，MiniMax Code 也未混当为 MiniMax Agent。

## 本次新增的领取适配（2026-10-07）

- [wangmingdong/workbuddy-signin](https://github.com/wangmingdong/workbuddy-signin)：MIT，Copyright (c) 2026 wangmingdong。参考 MiniMax Code 的 `/signin/status`、`/signin/claim` 和时间戳签名协议，独立实现 Node 适配器；未采用示例里的固定用户/设备参数，使用当前账号的客户端标识。完整 MIT 文本保存在 `vendor/LICENSE.workbuddy-signin`。
- [Shuffle-1992/TraeSign](https://github.com/Shuffle-1992/TraeSign)：MIT，Copyright (c) 2026 Shuffle-1992。参考 ZCode 官方 Aliyun SDK 验证流程；将 SDK 调用和领取回执持久化改为本网关实现。完整 MIT 文本保存在 `vendor/LICENSE.TraeSign`。ZCode 实际免费权益领取与余额回执已核验，更新上表早期“尚未完成”的状态。
- MiniMax Code 已安装桌面版中的本地 OAuth lease v1、原生请求头和账号配置形状：只读观察后独立实现客户端，不复制、不分发其产品源码。通过本机具备 capability 的管道向客户端取短期 access-token；refresh-token 的轮换交由客户端处理。
- QwenWorkCN 个人版的 `code: ok`、`account-context` 和 `wallets` 按实际响应解析。每日额度是服务器自动重置，不声称存在手动签到接口。
- [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api)：README License 声明 MIT（没有独立 LICENSE）；提交 17933d242621d4482ed1ce11c8eaf938b4e08e78。复用三个上下文模块，去除 TypeScript 类型；来源、改动和版权记录见 vendor/zcode-context/NOTICE.md。此项更正早期仅参考的描述。

## MiniMax Code 官方协议参照
MiniMax-AI/minimax-code，MIT；模型目录、Mavis Messages 与 Matrix 余额协议按官方源码验证，本工程独立实现统一 OpenAI 映射。许可证 vendor/minimax-code.LICENSE。
## 原生卡片设计参照
wangmingdong/workbuddy-signin（MIT）的积分卡片布局与用户截图；本网关使用独立 WinForms 控件实现，未嵌入其网页。

## WorkBuddy 多账号池参照（2026-10-08）
linguo2625469/workbuddy2api-panel，MIT，commit d66384d9e3d69655f799d7d8f2e5fba1946e00ab；原作者 Sliverkiss，增强分支 linguo2625469。参考账号池、硬额度/软限流分类、成功账号粘性和冷却恢复；本工程独立实现 Node 多账号签到及同模型切换，未移植其自动成长任务或 Go 服务器。完整 MIT 文本保留 vendor/LICENSE.workbuddy2api-panel。

## 公共源码包
包含本网关独立实现的 Windows 原生桌面源码及 `desktop/build.ps1`，不包含个人安装二进制/runtime、第三方客户端程序、凭据、数据库或会话档案。千问协议助手 vendor/qwenwork_ref 参考 wicm84266964/Buddy2api（MIT），完整许可证在该目录；编码器边界/UTF-8和上游映射由本网关实现。Galaxy/HTMLrev 仅作为桌面设计参考，未分发其 UI 代码或素材。

## 智谱官方适配（2026-10-09）

智谱 BigModel 官方 OpenAI 兼容文档用于核对模型调用契约；官方控制台的实际响应用于核对资源包字段。本工程独立实现 `src/bigmodel.mjs`，不复制或分发产品客户端/控制台源码。另参考 hucuyuu/zhipu-balance（MIT）的现金余额查询端点线索，未复制其程序；此处与原有参考项目一并致谢。历史展示图为用户提供的本机截图，不代表第三方客户端代码随仓库分发。

## Antigravity 独立协议桥与 Hermes 接入

- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)：MIT。Antigravity 接入使用独立安装的 CLIProxyAPI 本机进程处理其上游认证及协议转换；本网关的 `src/antigravity.mjs` 为独立实现的本地 HTTP 适配器，不是其 Go 源码移植。本仓库不分发该桥的源码、二进制、配置或凭据；单独部署桥时保留上游发行包中的完整许可证。安装说明见 [docs/antigravity.md](docs/antigravity.md)。
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)：作为独立调用端进行互操作接入。除配置说明与独立密钥helper外，本仓库还提供可选的单文件执行点派生适配（integrations/hermes/native-patch/agent/chat_completion_helpers.py）及Desktop显示层差异补丁。参考源码提交 d923a5eb487a17c0a68801bba9ef0f56c81040a8；原Copyright (c) 2025 Nous Research，MIT完整文本保留于 [LICENSE.hermes-agent](integrations/hermes/LICENSE.hermes-agent)。改动限于AI网关终局错误的重试归属及网关模型来源标签，不打包完整Hermes客户端或用户配置/聊天数据；源码版本和基线SHA不符时先合并适配，不覆盖整棵客户端源码。配置说明见 [docs/hermes.md](docs/hermes.md)。

以上“独立组件 / 协议参考”与本文件所列 vendor 代码复用分开记录；仅做可行性调研、尚未接入的服务不列为已集成组件。

## 桌面平台协议扩展

- [jsongo/buddy-proxy](https://github.com/jsongo/buddy-proxy)，MIT，提交 `cab81ff4fc5eaf4d64dffe1ea560a6e23972af3f`：Qoder COSY 签名/信封与 Buddy 端点协议移植为 Node 实现；固定域名、本机身份读取、错误分类、余额与活动隔离、取消及测试由本工程集成。完整许可证见 `vendor/provider-buddy-proxy.LICENSE`。
- CodeArts 与 Lobster 的参考及代码移植归属、固定提交、许可证位置见 [provider-attributions.md](docs/provider-attributions.md)。官方桌面客户端本身不随公共仓库分发。
- NVIDIA 官方 API 文档和目录用于能力与策略核验，独立实现，未打包模型权重或平台客户端。

## Loomy 与小浣熊生产接口校正

- https://github.com/xxhhlk/raccoon2api/tree/ec98df33de9decae3b2e1ea683df1a67196f4fbe — MIT，完整许可证保留 `vendor/raccoon2api/LICENSE`。 本工程按官方客户端与服务端实测独立实现 Node 适配，不包含参考项目的账户池、登录密码服务或客户端。
- https://github.com/Patrick130306/loomy2api/tree/cf8608d9765b417374dce282c7e53d7932c02d39 — MIT，完整许可证保留 `vendor/loomy2api/LICENSE`。 本工程按官方客户端与服务端实测独立实现 Node 适配，不包含参考项目的账户池、登录密码服务或客户端。
- https://github.com/rockswang/wild-work/tree/fc62c2c947c1382482973089f05e6c7c1554f6d9 — README 声明 MIT，但该提交没有独立 LICENSE 文件；仅作为协议交叉参考，未复制其代码。 本工程按官方客户端与服务端实测独立实现 Node 适配，不包含参考项目的账户池、登录密码服务或客户端。

Loomy 旧测试环境的登录失效结论已纠正；小浣熊 Electron Cookie 为空不代表原生 Bearer 会话缺失。公开产物不含本机登录、设备标识或账户具体积分。

## 跨日登录与原生界面改版参考

- [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model/tree/ddb451c2f24bac0b0f8b03b2473efbb1f0aefb68)，MIT：核对 CodeArts 与小浣熊的官方续期和积分协议、恢复性错误与日额度语义；本网关保持自己的 Node provider/私有缓存与原生界面，不复制其匿名渠道或整包代码。逐项协议与本机回执见对应 provider 文档。
- [BeUI](https://beui.dev/)、[shadcn/ui](https://ui.shadcn.com/)、[Rare UI](https://www.rareui.com/)、[Transitions](https://transitions.dev/)：卡片层级、简短入场/退出过渡、hover/focus与减少动效偏好的视觉和交互参考。本网关原生 WinForms 控件独立实现；本公开仓库未打包这些 React 组件。Beautiful UI 地址也已检索，未获取到可用源码，未列为代码复用。
- 本机平台图标从用户已安装客户端与快捷方式提取，属于各平台商标资源，仅用于本机识别与桌面部署，不作为本公开后端包的原创素材分发。

## WB 账号管理、详细积分包与任务协议参照

| 来源 | 固定参照 | 本项目使用方式 |
|---|---|---|
| [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch) | `22b318c1f44b335c2222e444abcc2d0f74e160f7`，MIT，Copyright (c) 2026 wb-switch | 官方授权/登录格式、本机会话加法复制、账号身份和积分包组织参照；独立适配 Node 管理 API 与 WinForms |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | `6b31db6d045e985042620c819c3a938002e7b0b1`，MIT，Copyright (c) 2026 Sliverkiss / linguo2625469 | 官方任务协议、任务状态及账号卡信息组织参照；不移植其 Go 服务与 Web UI |
| [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | `ac4c55ef5e0833bf0138846a7c5255ecbc14a07c`，MIT | CodeArts/小浣熊续期、错误分类与额度协议对照；不移植匿名渠道或整包代码 |

WB 两个参考项目的完整 MIT 声明与固定提交记录保留在 [src/workbuddy-reference-license.mjs](src/workbuddy-reference-license.mjs)。本工程没有运行第三方安装脚本，不复制用户数据，不将上述项目的所有功能描述为本项目已实现功能。

身份、封禁来源、全部积分包分页、任务描述/奖励/进度/回执由本工程统一管理契约与原生详情窗口呈现。认证 401/403 不独自证明封禁；本机人工标记与官方事实分开。真实任务执行仍按本网关实际注册执行器判断，未接入的自动化/应用/专家使用任务保留待操作。功能边界见 [docs/wb-account-pool.md](docs/wb-account-pool.md)。

## WorkBuddy-switch 账号交换与轮换补充参照

继续固定 `changexbc/workbuddy-switch` 的 MIT 提交 `22b318c1f44b335c2222e444abcc2d0f74e160f7`（0.1.62 版本线），未改变原有完整许可。逐项阅读 `crates/wb-switch-core/src/modules/export_import.rs`、`account.rs`、`rotate.rs`、`codebuddy_cli.rs` 及导入/导出界面，参考账号格式、去重预览、备注、积分到期策略和 CLI 存活门控。

本工程独立实现 Node JSON/ZIP 交换、配置提交/备份、网关下一请求偏好与空闲 CLI 写入；未复制 Rust/Tauri/React 程序、客户端进程终止代码、悬浮窗或签名更新器。ZIP 扩展为本网关实现，非固定参考提交的 JSON 导出功能。完整源文件链接与能力对照见 [docs/WB_SWITCH_COMPARISON.md](docs/WB_SWITCH_COMPARISON.md)，实际格式见 [docs/WB_ACCOUNT_TRANSFER.md](docs/WB_ACCOUNT_TRANSFER.md)。
