# CodeArts Agent adapter

固定官方服务 `https://snap-access.cn-north-4.myhuaweicloud.com`；原生 `%APPDATA%/codearts-agent/User/globalStorage/state.vscdb` 只读提取临时AK/SK/securityToken，SDK-HMAC-SHA256签名。`resolve(account,config)`返回私有accessToken/principal，公开视图不含凭据或姓名。

真实业务面：current/user认证；statistics/plugin独立积分账本；model/builtin目录；ops/delivery每日活动；claim后confirm并重读delivery。今日已CONFIRMED，不重复提交。余额与签到读取独立容错，Token单列不并入积分。

官方目录6个真实模型但未给容量。仅实测通过普通与SSE的`GLM-5.2`启用聊天：网关显式保守contextWindow=16384/maxTokens=2048，source=`configured_limit`，officialContextWindow/officialMaxTokens=null，绝非官方容量。其余目录项callable:false。工具调用两次分别返回流业务错误与HTTP400，因此tools:false，无Agent工具链成功声明。

chat强制上游v2 SSE，网关按请求返回标准SSE或聚合OpenAI JSON，保留标准delta/tools/usage；legacy text按累计快照另处理。HTTP200流错误为失败，缓冲有界，取消释放reader。输出字段max_completion_tokens归一max_tokens并校验本地上限/冲突。

来源及完整MIT许可证见`docs/provider-attributions.md`与`vendor/Coding2API/LICENSE`。该模块由真实DSH WB DeepSeek V4.1 Flash max编程后由主集成者补契约、测试与实测。
