# CodeArts Agent adapter

固定官方服务 `https://snap-access.cn-north-4.myhuaweicloud.com`；原生 `%APPDATA%/codearts-agent/User/globalStorage/state.vscdb` 只读提取临时AK/SK/securityToken，SDK-HMAC-SHA256签名。`resolve(account,config)`返回私有accessToken/principal，公开视图不含凭据或姓名。

真实业务面：current/user认证；statistics/plugin独立积分账本；model/builtin目录；ops/delivery每日活动；claim后confirm并重读delivery。今日已CONFIRMED，不重复提交。余额与签到读取独立容错，Token单列不并入积分。

当前已验证合同覆盖 builtin 目录的 9 个型号。普通回答、SSE、原生工具调用与结果回传的正式网关四链路测试为 36/36；这与原 DSH 完整工具集验收分开：后者保留 331 个工具，已有 8/9 型号完成真实读取、配对结果回传和最终随机内容核对，Kimi-K3 仍受上游大 Schema 编译限制。逐型号状态见[验证快照](codearts-validation.md)。未知新型号不自动宣称可调用。

容量是网关本地合同（source=`configured_limit`），不是从 builtin 目录读到的官方数值；`officialContextWindow` 和 `officialMaxTokens` 保持 null。本地默认值、硬上限和显式调用预算分开，未宣称已生成至最大输出长度。

chat强制上游v2 SSE，网关按请求返回标准SSE或聚合OpenAI JSON，保留标准delta/tools/usage；legacy text按累计快照另处理。HTTP200流错误为失败，缓冲有界，取消释放reader。输出字段max_completion_tokens归一max_tokens并校验本地上限/冲突。

来源及完整MIT许可证见`docs/provider-attributions.md`与`vendor/Coding2API/LICENSE`。该模块由真实DSH WB DeepSeek V4.1 Flash max编程后由主集成者补契约、测试与实测。

工具选择：原生 auto 已实测；none 在网关移除 tools 定义实现禁止调用。required 和指定函数形式不静默降级，返回 codearts_tool_choice_unsupported。目录声明 toolChoiceModes=[auto,none]、auditToolChoice=auto。原生工具结构由上游输出，不靠提示词 JSON 模拟。

认证失败 APIG.0301 与并发上限 TM.00001041 独立报告，过期 IAM 令牌不自动重试。400 本身不用于推断不支持工具。

## 官方 STS 续期

`resolve` 优先复用来源指纹匹配且有效的网关私有缓存；缓存过期时只读本机 `HuaweiCloudSession`，使用 Windows DPAPI + Electron AES-GCM 解密。刷新完整复现安装版 `huaweicloud.authentication` 的 PKCE + ES256 DPoP 请求，固定 `https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`、`client_id=codearts-agent`，不跟随重定向。

原始 SQLite/客户端账户文件不改写。轮换后的 AK/SK、STS 和下一次 refresh_token 仅存 `%LOCALAPPDATA%/AI Credit Gateway/private-cache/codearts-*.json`。同来源单飞并加本地锁；成功原子替换缓存；失败记录来源绑定标记，后续轮询不重复消费一次性令牌。本机登录态改变会使旧缓存/失败标记失效。原生客户端原有 refresh_token 可能随同一次性轮换失效；后续原生更新以其最新登录态为准，网关不回写原文件。

## 会话关联

明确的 conversationId/sessionId（也支持 metadata 下的 conversation_id/session_id）按账号和模型命名空间稳定生成 chat_id。没有明确会话 ID 的独立请求分配不同随机 ID，即使首句相同也不串会话。上游原生 tool_call_id 与该次 chat_id 建立 10 分钟、最多 512 条的内存关联；工具结果按原始 tool_call_id 复用上游会话，流式和非流式都适用。没有全账号共享的固定 chat_id，也不删除用户其他原生会话。

`TM.00001041` 为上游明确返回的三会话限制；正式验收分别记录实际结果，不把 HTTP 400 解释成不支持工具，也不在产品中自动循环重试。

GLM-5.2 的 toolRoundtripVerified=true 来自正式网关上实际 DSH 与 Hermes 的读文件、原生工具回传及最终内容核对。其余当前八个型号的简单工具回填由逐型号真实四链路记录补齐；这不等于所有复杂客户端 Schema 均兼容，也不推广到未来新增型号。TM.00001041 是明确的上游并发限制；失败请求保留记录，独占有界复测结果单独记录，不把 HTTP400 泛化为不支持工具。

## 并发限制 HTTP 规范化

仅已证实的上游 HTTP 400 且业务码 TM.00001041，网关规范化为 HTTP 429，供客户端按限流策略处理。异常保留 upstreamStatus=400、upstreamCode=TM.00001041，message 明确保留原 HTTP 400 与业务码。其它 400、401、403 或 500 不套用此映射，即使携带相同码也保留其原状态。产品不自动重放生成请求，不伪造 Retry-After；有界复测仅属独立验收操作，初次失败与复测均留存。

## 续期恢复与待确认领取

协议对照固定至 [dsh-our-free-model 的 oauth.ts](https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/ddb451c2f24bac0b0f8b03b2473efbb1f0aefb68/vendor/channel-pack/src/oauth.ts)（MIT，仅参考协议和错误分类，未复制程序）。`InvalidDPoPHeader` 是本次证明被拒，不等同 refresh token 失效。该明确错误及 HTTP429 记录十分钟 retryAt，随后下一次 resolve 才重试；invalid_grant、ExpiredRefreshToken 和结果未知不重复消费。私有持久 intent 在发出轮换请求之前原子落盘，防进程中断后重放。

缓存新增凭据语义指纹（稳定身份、原始RT、PKCE、公钥字段），原生 secret storage 仅随机重新封装不会丢网关轮换链；原生真正新登录优先读取。POST前锁内重查源，检测到原生更新即中止本次刷新。锁仅约束网关进程，不声称覆盖原生客户端的旋转竞争。原生文件不回写；跨日模拟与当前原生登录有效不等于已经证明下一日实机长期恢复。

`CLAIMED` 为待确认：status 返回 claimed=false、pendingConfirmation=true、active=true，claim 仅补 `/v1/ops/confirm`，不重发 `/claim`。只有再次读取到 `CONFIRMED` 或 `CONSUMED` 才报告到账；确认失败且仍CLAIMED返回 codearts_claim_unconfirmed。每日真实已确认状态读到后不重复 POST。

后台恢复未确认账本时，`confirmOnly: true` 会再次读取活动状态：CLAIMED 只发 confirm；CONFIRMED/CONSUMED 直接返回已有回执；重新变为 CLAIMABLE 或未知时返回 `submitted: false, reason: pending_confirmation_changed`，不重发 claim，由共享账本继续保留未确认记录。


## 稳定的传输会话与独立聊天

请求同时携带与body.model精确一致的model-id/model-name。x-ot-session-id与user-session-id按当前凭据稳定推导，凭据轮换后自然变化；body.chat_id依然按独立对话隔离，并保留工具回填关联，不把不同聊天历史合并。旧实现缺少这些头，顺序调用前三个成功后第4个起出现TM.00001041；候选修复后9型号36项真实调用全部通过。签名算法、登录态与积分通道不改，不清除其他原生会话，不自动重放生成。协议参考[CodeArts2API固定client.go](https://github.com/2951461586/CodeArts2API/blob/c11aa7bba77d148ed04dec2c6a67b74cb8732293/internal/codearts/client.go#L130-L175)和[UPSTREAM会话说明](https://github.com/2951461586/CodeArts2API/blob/c11aa7bba77d148ed04dec2c6a67b74cb8732293/docs/UPSTREAM.md#6-并发会话上限与-x-ot-session-id)；未复制其旧版本头或整套网关。


## DSH 首包预算协商

目录声明的 maxTokens 是上限，不自动成为 ModelInfo.defaultMaxTokens。CodeArts显式发布本地默认输出预算；客户端同时传递精确路由ID、context-window和max-output协商头，避免companion异步首包查询回退到通用registry。首包协商保留原331工具的数量、名称及参数验证语义，用户消息不改写；Kimi-K3会按下节规则展开无环本地引用。ArkTS/DeepSeek Agent使用较小默认输出预留，但显式请求仍受独立65536上限检查，不静默裁剪用户指定值。容量调整须由完整工具请求实测确认；不能只调大数字后称验收通过。

## Kimi-K3 参数 Schema 与流错误

仅对 Kimi-K3 展开明确采用 2019-09/2020-12 语义的非递归本地引用。共享 DAG 引用按实例独立展开；`$ref` 的兄弟断言以 `allOf` 保持合取。真正的递归、外部引用、动态引用、旧草案或资源上限命中时，完整保留原 Schema，不截断深度、不减少工具、不放宽为通用 JSON。其它型号的工具 Schema 不变，调用者对象不就地修改。

这是引用兼容修复，不是大工具集已通过的声明。实际完整 DSH 工具集仍遇到 `InferHub.ModelArts.81001.400` / `schema exceeds maximum allowed size`。较紧凑的等价候选只完成离线差分与单函数编译诊断，尚未纳入产品；全 331 工具的 Kimi-K3 闭环仍待后续验收。

HTTP 200 中的 SSE 业务错误仍按失败处理，保留有界、脱敏的 `upstreamCode/upstreamMessage/upstreamStatus`；CodeArts 的序列化错误正文也保留业务码，便于区分 Schema、认证、限流与网络错误。不因传输 HTTP 200 将其记为调用成功。

离线检查（不读取本机登录态、不发真实生成）：

```sh
node --test tests/provider-codearts.test.mjs tests/codearts-all-models.test.mjs tests/codearts-schema.test.mjs tests/gateway-model-headers.test.mjs
npm run check
```
