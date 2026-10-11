# Cline 官方账号适配

## 账号与请求

适配 api.cline.bot 官方托管账号，不把 BYOK 上游混当成 Cline 免费额度。独立读取本机 Cline 配置；管理配置仅保存文件引用。聊天路径为 /api/v1/chat/completions，目录为 /api/v1/ai/cline/models。请求固定官方 HTTPS origin，不跟随跨域重定向。

WorkOS 账号令牌按官方 SDK 的 workos: 鉴权形式使用。官方续期后的短期凭据放在独立私有缓存，按原配置内容指纹匹配；原客户端配置保持不变，登录身份变化会使旧缓存失效。凭据及账号个人信息不进入公共日志、模型目录和仓库。

## 模型与传输

目录解析真实 ID、上下文及输出元数据，缺少必要容量的条目标记不可发布，不把展示目录等同于生成成功。聊天请求的 JSON 封装、SSE 结束事件、业务错误及工具结果经过统一响应层；HTTP 200 本身不是生成验收。

普通请求与 SSE、工具调用及结果回传分别体检。公开目录可能在未登录时仍可访问，因此目录 200 不用于证明账号已认证。认证状态以用户接口或实际调用为依据。

## 每日权益与额度

当前适配器没有已验证的每日签到任务，supportsCheckin=false；不生成虚假的每日领取记录。已验证用户接口没有返回 credits、balance 或 quota 字段，额度保持待获取，并说明具体原因，而不是显示零或推算剩余。此结论不表示平台所有其他接口都不存在余额能力。

## 来源与许可

- [Cline 身份认证文档](https://docs.cline.bot/api/authentication)
- [Cline 聊天 API 文档](https://docs.cline.bot/api/chat-completions)
- [Cline 模型文档](https://docs.cline.bot/api/models)
- [官方源码及文档镜像](https://github.com/cline/cline)，Apache-2.0；用于核对协议，没有复制其产品实现。

本网关适配代码、统一响应层及测试按本仓库 MIT 许可证提供；内部 provider-buddy.mjs 不是 Apache-2.0 模块。当前实例认证与生成结果保存在部署验证报告，不写入长期 README 作为永久可用承诺。
