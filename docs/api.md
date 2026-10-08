# 自建前端管理契约
所有 /admin 路径需 Authorization: Bearer <本机 adminKey>，不允许其他 Origin 的浏览器直接访问；自建 UI 用同源部署或自己的服务端代理，保持令牌在本机配置。模型路径用 apiKey。

GET /health；GET /v1/models；POST /v1/chat/completions。
GET /admin/config、PUT /admin/config（完整配置，无内联凭据）；GET /admin/balances?refresh=1；GET /admin/records。
POST /admin/claim {} 全部账号，或 {accountId,taskId} 单账号；响应每项有 status/reason/credits，别只按 HTTP200判断领取成功。
GET /admin/model-directory；POST /admin/model-import {items:[{upstreamId,model,enabled}]}；GET /admin/model-audit；POST /admin/model-audit。
POST /admin/workbuddy/capture {id,label}：读当前客户端账号，返回账号 ID 和本机文件路径，不返回凭据。
POST /admin/workbuddy/pool {routeId,accountIds:["wb-a","wb-b"],enabled:true,cooldownSeconds:3600}。
GET /admin/workbuddy/pools；POST /admin/workbuddy/switch {routeId,accountId}。
POST /admin/shutdown：停止本机服务。

前端应有完成/失败状态，finally释放忙碌标记；余额错误显示stale和原因，不把未知余额显示成零。工具调用只返回定义/参数，由调用方执行工具。
