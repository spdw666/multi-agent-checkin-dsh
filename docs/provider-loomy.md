# Loomy adapter

官方产品https://loomy.xunfei.cn，安装D:/Loomy。Windows实际userData为`C:/Users/Public/Loomy/<user-hash>/userData`，auth-session.json含session/userid；模块只读定位并在内存散列principal，不把.env.prod当用户登录。

本机确有会话；身份、pet-work、积分记录、team balance端点实际HTTP200但业务码100002登录已失效。因此health=session_expired、inference=false、余额unknown。HTTP可达不是认证成功。重新登录后可按相同源重新核验。

pet-work为官方宠物打工奖励，GET /api/v1/pet-work + POST /api/v1/pet-work/rewards；仅有服务端可领取状态才提交，提交后重读。它不等于已证实独立每日签到，不配置每日签到任务。

当前未核实任何可调用model ID；models返回[]，删除`imodel/品牌family`占位。聊天协议实现保留但不发布模型，JSON业务错误明确返回；配额不将团队余额当个人余额。resolve/models/health/status/claim/chat均规范导出，默认fetch为global。

仅本机文件引用；无部署、默认模型或GUI变更。真实Hermes工具调查及编程，主集成者收口契约。
