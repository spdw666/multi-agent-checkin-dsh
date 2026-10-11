# 商汤小浣熊原生接入

## 凭据与刷新

默认只读当前用户 `~/.box-agent/config/auth.json`，或 `BOX_AGENT_CONFIG_DIR/auth.json`；账号引用 `credentials: {kind: "desktop", file: "auto"}`。支持显式私有 JSON 文件引用。access_token 为原生 Bearer 身份，与 Electron Cookie 库独立。每次 resolve 重读；不因 Cookie 库为空判未登录。不改浏览器或原生文件。到期前 60 秒使用官方 `/api/web/auth/v1/refresh` 续期，轮换凭据仅保存于当前用户 LocalAppData/AI Credit Gateway/private-cache 下按源路径散列隔离的文件。缓存绑定原生文件 SHA256；原生登录更新后重新采纳新源。进程内 singleflight 与跨进程排他文件锁避免重复刷新；请求前持久化 intent，失败或不确定结果禁止反复消费同一 refresh token，直至本机登录态带来新凭据。返回凭据必须身份一致、有足够有效期。客户端与网关独立缓存可能遇到服务端会话撤销，届时显示明确重新登录状态，不声称凭据永久有效。

## 真实接口

仅向 `https://xiaohuanxiong.com` 固定 `/api/web/` 路径发送凭据，拒绝重定向：
- POST `/api/web/auth/v1/refresh`：固定官方续期端点，拒绝重定向，不自动尝试其他地址。
- GET `/api/web/llm/v2/model_catalog`：服务器目录、上下文、最大输出；未声明 tools 保持未知。
- GET `/api/web/points/v1/balance`：可用、每日、月度、奖励、充值积分分别展示，未知值不归零。
- POST `/api/web/llm/v2/chat/completions`：真实增量 SSE，工具调用/回传保持原结构；未知模型在本地拒绝，防止上游静默回落。兼容 max_completion_tokens。模型特有 reasoning_effort 未声明，不将网关通用档位作为官方支持字段。

每日额度为服务端自动额度。`daily-quota` 返回 known/observed 与真实余额快照；claim 此任务不发网络请求。capabilities.checkin=false，未称签到成功。

## 验证

2026-10-11 官方目录、可用余额与各积分桶已通过真实 GET 核验；个人数字只记录在本机验证输出中。`sn-sensenova-6-8-flash` 普通对话、真实 SSE、lookup 工具调用及结果回传四阶段通过。该型号256000上下文/63999输出来自官方目录，tools=true仅用于已实测型号，其他保持未知。自动额度观测不推断原始发放量。

回归：`node --test tests/provider-raccoon.test.mjs tests/raccoon-refresh.test.mjs`，40项，含未知模型、余额零与未知、原生凭据优先、泄露检查、SSE/工具字段、自动额度不POST，以及续期固定域名、原文件不变、轮换缓存、源更新、身份校验、singleflight、文件锁、失败禁止重复消费。

## 来源
- https://github.com/xxhhlk/raccoon2api （MIT，原生路径与官方端点）
- https://github.com/rockswang/wild-work/tree/main/internal/raccoon （README声明MIT，轮换与协议对照；未复制源码）
- 本机官方客户端资源及上述官方端点实测；公开代码不携带用户凭据。

