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

## 读取并参考，未复制其程序

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
- [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api)：未发现明确 LICENSE，只核对接口名称，不复制其程序。

## MiniMax Code 官方协议参照
MiniMax-AI/minimax-code，MIT；模型目录、Mavis Messages 与 Matrix 余额协议按官方源码验证，本工程独立实现统一 OpenAI 映射。许可证 vendor/minimax-code.LICENSE。
## 原生卡片设计参照
wangmingdong/workbuddy-signin（MIT）的积分卡片布局与用户截图；本网关使用独立 WinForms 控件实现，未嵌入其网页。

## WorkBuddy 多账号池参照（2026-10-08）
linguo2625469/workbuddy2api-panel，MIT，commit d66384d9e3d69655f799d7d8f2e5fba1946e00ab；原作者 Sliverkiss，增强分支 linguo2625469。参考账号池、硬额度/软限流分类、成功账号粘性和冷却恢复；本工程独立实现 Node 多账号签到及同模型切换，未移植其自动成长任务或 Go 服务器。完整 MIT 文本保留 vendor/LICENSE.workbuddy2api-panel。

## 公共源码包
不包含原生/Web前端、客户端程序、WASM、凭据、数据库或会话档案。千问协议助手 vendor/qwenwork_ref 参考 wicm84266964/Buddy2api（MIT），完整许可证在该目录；编码器边界/UTF-8和上游映射由本网关实现。Galaxy/HTMLrev 仅作为本机桌面设计参考，公共包未分发其UI。

