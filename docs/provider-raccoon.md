# 商汤小浣熊原生接入

## 凭据与刷新

默认只读当前用户 `~/.box-agent/config/auth.json`，或 `BOX_AGENT_CONFIG_DIR/auth.json`；账号引用 `credentials: {kind: "desktop", file: "auto"}`。支持显式私有 JSON 文件引用。access_token 为原生 Bearer 身份，与 Electron Cookie 库独立。每次 resolve 重读；不因 Cookie 库为空判未登录。不改浏览器或原生文件。到期前 60 秒使用官方 `/api/web/auth/v1/refresh` 续期，轮换凭据仅保存于当前用户 LocalAppData/AI Credit Gateway/private-cache 下按源路径散列隔离的文件。缓存绑定原生文件 SHA256；原生登录更新后重新采纳新源。进程内 singleflight 与跨进程排他文件锁避免重复刷新；请求前持久化 intent，失败或不确定结果禁止反复消费同一 refresh token，直至本机登录态带来新凭据。返回凭据必须身份一致、有足够有效期。客户端与网关独立缓存可能遇到服务端会话撤销，届时显示明确重新登录状态，不声称凭据永久有效。

## 真实接口

仅向 `https://xiaohuanxiong.com` 固定 `/api/web/` 路径发送凭据，拒绝重定向：
- POST `/api/web/auth/v1/refresh`：固定官方续期端点，拒绝重定向，不自动尝试其他地址。
- GET `/api/web/llm/v2/model_catalog`：服务器目录、上下文、最大输出；未声明 tools 保持未知。
- GET `/api/web/points/v1/balance`：可用、每日、月度、奖励、充值积分分别展示，未知值不归零。
- POST `/api/web/llm/v2/chat/completions`：真实增量 SSE，工具调用/回传保持原结构；未知模型在本地拒绝，防止上游静默回落。兼容 max_completion_tokens。模型特有 reasoning_effort 未声明，不将网关通用档位作为官方支持字段。

每日额度为服务端日配额，不是假造签到。`daily-quota` 以当日官方账单与登录延期核验为准；尚未完成时复现已确认的官方桌面登录积分端点并复核。capabilities.checkin=false，日任务以 observed 记录，不称新增签到领取。

## 验证

2026-10-11 官方目录、可用余额与各积分桶已通过真实 GET 核验；个人数字只记录在本机验证输出中。`sn-sensenova-6-8-flash` 普通对话、真实 SSE、lookup 工具调用及结果回传四阶段通过。该型号256000上下文/63999输出来自官方目录，tools=true仅用于已实测型号，其他保持未知。自动额度观测不推断原始发放量。

回归：`node --test tests/provider-raccoon.test.mjs tests/raccoon-refresh.test.mjs`，40项，含未知模型、余额零与未知、原生凭据优先、泄露检查、SSE/工具字段、自动额度不POST，以及续期固定域名、原文件不变、轮换缓存、源更新、身份校验、singleflight、文件锁、失败禁止重复消费。

## 来源
- https://github.com/xxhhlk/raccoon2api （MIT，原生路径与官方端点）
- https://github.com/rockswang/wild-work/tree/main/internal/raccoon （README声明MIT，轮换与协议对照；未复制源码）
- 本机官方客户端资源及上述官方端点实测；公开代码不携带用户凭据。


## 续期缓存与日额度回执

来源对照固定为 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model/tree/ddb451c2f24bac0b0f8b03b2473efbb1f0aefb68/vendor/channel-pack/src) 的 `raccoon-oauth.ts`、`raccoon-credits.ts`，MIT；仅协议/行为对照，本轮未复制其程序实现。原生 app.asar 的登录 effect 与积分规则文案也单独只读核验；REA 曾报告一个 unpacked bufferutil.node 哈希不匹配，后续只解析 JavaScript，没有运行该二进制。

续期成功允许仅返回 access_token；未返回 refresh_token 时保留原值，保留 office_identity 等原生附加字段。私有缓存按身份与原始 refresh token 的语义指纹绑定，JSON 格式和附加元数据变化不丢失已旋转链。跨日到期使用网关缓存的下一次令牌，不回写原客户端。明确 HTTP 429 进入十分钟冷却；未知网络结果、解析失败、真正失效不自动重放。新的原生有效登录可恢复同一身份。锁内 POST 前再次检查源字节，原生已更新则本次中止、下次重新读取。

原生客户端与网关可能同时消费同一旋转令牌家族；网关锁只协调网关进程，不是原生客户端锁。上述修复和时间推进单测不等于跨日实机问题已全部治愈；本轮没有为了测试强制消费原生 refresh token。

`daily-quota` 不再把正余额当作今日完成。它读取 `/api/web/points/v1/balance` 与 `/api/web/points/v1/bills?paging.limit=50&paging.offset=0`，只在 `biz_type=daily_grant`、`grant_at` 属于北京时间当日且 `expire_at` 已延长至次日零点之后时返回 observed=true。账单本身是官方持久回执，使用当前账号凭据实时读取，不保存跨账号本地猜测。前50条没找到只表示待核验。

若未核验本日延长，日任务复现原生登录 effect：POST `/api/web/desktop/v1/login/points/grant`，空 body，`X-Client-Platform: desktop-windows`，再读账单和余额。只有账单复核成功才返回 observed=true；始终 claimed=false、credit=0。`data.granted` 与 `popup.points` 属桌面奖励另列，不冒充每日新领取。已由原客户端完成本日延期则零 POST。

官方原生规则是每日 00:00 起算、默认当日24:00失效、当天登录延长7天。`created_at` 是账单记录时刻，不等于 `grant_at`。实机账单已区分每天 daily_grant 300 与一次 reward_grant 桌面登录奖励3000；一次已领探针 granted=false 且账单无变化，不用于声称下一天 POST 必然发放。

余额输出 `dailyQuotaObserved`、`dailyCycleDate`、`dailyQuota`、`dailyQuotaObservedAt`、`dailyQuotaSource='/api/web/points/v1/bills:daily_grant'`。额度字段取账单 points，不取多日累积 dailyRemaining。读取失败、未知账单、未延期、非当日都不输出已到账。
