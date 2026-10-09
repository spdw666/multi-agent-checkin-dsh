# 自建前端管理契约
所有 /admin 路径需 Authorization: Bearer <本机 adminKey>，不允许其他 Origin 的浏览器直接访问；自建 UI 用同源部署或自己的服务端代理，保持令牌在本机配置。模型路径用 apiKey。

GET /health；GET /v1/models；POST /v1/chat/completions。
GET /admin/config、PUT /admin/config（完整配置，无内联凭据）；GET /admin/balances?refresh=1；GET /admin/records。
POST /admin/claim {} 全部账号，或 {accountId,taskId} 单账号；响应每项有 status/reason/credits，别只按 HTTP200判断领取成功。
GET /admin/model-directory；POST /admin/model-import {items:[{upstreamId,model,enabled}]}；GET /admin/model-tests；POST /admin/model-tests {scope:"all"|"imported"}。
scope 默认 all；imported 刷新启用路由目标的目录并执行普通、流式、工具、结果回传测试。返回 202 后轮询 GET，读取 scope/status/completed/total/summary，results 包括保留的历史条目，jobKeys 指明本轮目标。不得将 HTTP202 视为体检成功。不同范围运行时 queuedScope 表示排队，重复同范围复用任务；不改用户路由配置。
POST /admin/workbuddy/capture {id,label}：读当前客户端账号，返回账号 ID 和本机文件路径，不返回凭据。
POST /admin/workbuddy/pool {routeId,accountIds:["wb-a","wb-b"],enabled:true,cooldownSeconds:3600}。
GET /admin/workbuddy/pools；POST /admin/workbuddy/switch {routeId,accountId}。
POST /admin/shutdown：停止本机服务。

前端应有完成/失败状态，finally释放忙碌标记；余额错误显示stale和原因，不把未知余额显示成零。工具调用只返回定义/参数，由调用方执行工具。

聊天请求体默认64 MiB（server.bodyLimitBytes=67108864），管理请求4 MiB；严格按字节计数，超限返回413/body_too_large，保留历史不自动剪裁。新代码逐请求读取限制；DSH worker每30秒重新读取配置。
