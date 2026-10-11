# CodeArts Agent adapter

固定官方服务 `https://snap-access.cn-north-4.myhuaweicloud.com`；原生 `%APPDATA%/codearts-agent/User/globalStorage/state.vscdb` 只读提取临时AK/SK/securityToken，SDK-HMAC-SHA256签名。`resolve(account,config)`返回私有accessToken/principal，公开视图不含凭据或姓名。

真实业务面：current/user认证；statistics/plugin独立积分账本；model/builtin目录；ops/delivery每日活动；claim后confirm并重读delivery。今日已CONFIRMED，不重复提交。余额与签到读取独立容错，Token单列不并入积分。

官方目录6个真实模型但未给容量。仅实测通过普通与SSE的`GLM-5.2`启用聊天：网关显式保守contextWindow=16384/maxTokens=2048，source=`configured_limit`，officialContextWindow/officialMaxTokens=null，绝非官方容量。其余目录项callable:false。新增原生工具实证：GLM-5.2、Qwen3-VL-235B、kimi-k2.6-vl、glm-5.2-sft-harmony 返回标准 tool_calls 和 finish_reason=tool_calls，分别记录 toolsSource=live_tool_calls_verified。此项不代表完整工具回填已通过，toolRoundtripVerified 单独记录。

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

GLM-5.2 的 toolRoundtripVerified=true 来自正式网关上实际 DSH 与 Hermes 的读文件、原生工具回传及最终内容核对。其它模型仅返回工具调用的证据不推广为完整回填。TM.00001041 是明确的上游并发限制；失败请求保留记录，独占有界复测结果单独记录，不把 HTTP400 泛化为不支持工具。

## 并发限制 HTTP 规范化

仅已证实的上游 HTTP 400 且业务码 TM.00001041，网关规范化为 HTTP 429，供客户端按限流策略处理。异常保留 upstreamStatus=400、upstreamCode=TM.00001041，message 明确保留原 HTTP 400 与业务码。其它 400、401、403 或 500 不套用此映射，即使携带相同码也保留其原状态。产品不自动重放生成请求，不伪造 Retry-After；有界复测仅属独立验收操作，初次失败与复测均留存。
