# Cline 官方账号适配

## 账号与请求

适配 api.cline.bot 官方托管账号，不把 BYOK 上游混当成 Cline 免费额度。独立读取本机 Cline 配置；管理配置仅保存文件引用。聊天路径为 /api/v1/chat/completions，目录为 /api/v1/ai/cline/models。请求固定官方 HTTPS origin，不跟随跨域重定向。

WorkOS 账号令牌按官方 SDK 的 workos: 鉴权形式使用。官方续期后的短期凭据放在独立私有缓存，按原配置内容指纹匹配；原客户端配置保持不变，登录身份变化会使旧缓存失效。凭据及账号个人信息不进入公共日志、模型目录和仓库。

## 模型与传输

目录解析真实 ID、上下文及输出元数据，缺少必要容量的条目标记不可发布，不把展示目录等同于生成成功。聊天请求的 JSON 封装、SSE 结束事件、业务错误及工具结果经过统一响应层；HTTP 200 本身不是生成验收。

普通请求与 SSE、工具调用及结果回传分别体检。公开目录可能在未登录时仍可访问，因此目录 200 不用于证明账号已认证。认证状态以用户接口或实际调用为依据。

## 每日权益与额度

当前适配器没有每日签到概念，supportsCheckin=false；不生成每日领取记录。认证读取 /api/v1/users/me，随后以该接口返回的账号 ID 调用官方 /api/v1/users/{id}/balance；余额响应必须属于同一账号，账号 ID 不进入公共健康结果。真实零余额保留为零；缺失、非数值、身份不符或余额接口错误保持未知，并与已经成功的身份认证分开报告。

额度单位为 credits，不标成 USD，也不混为 Cline Pass 订阅窗口剩余量。换算完整复现官方 VSCode 显示链：getUserCredits.ts 将原始 balance 除以 100；AccountView 将 currentBalance 传给 CreditBalance，StyledCreditDisplay 再调用 formatCreditsBalance 除以 10000。因此 API 原始值除以 1000000 才是该客户端显示 credits。原始值和 displayDivisor 一并保留供核验，不依赖模糊的字段名推测。

## 来源与许可

- [Cline 身份认证文档](https://docs.cline.bot/api/authentication)
- [Cline 聊天 API 文档](https://docs.cline.bot/api/chat-completions)
- [Cline 模型文档](https://docs.cline.bot/api/models)
- [官方源码及文档镜像](https://github.com/cline/cline)，Apache-2.0；用于核对协议，没有复制其产品实现。

本网关适配代码、统一响应层及测试按本仓库 MIT 许可证提供；内部 provider-buddy.mjs 不是 Apache-2.0 模块。当前实例认证与生成结果保存在部署验证报告，不写入长期 README 作为永久可用承诺。

- [官方账号余额 SDK](https://github.com/cline/cline/blob/c3a40572765b76873c597247941118c1778d02c8/sdk/packages/core/src/account/cline-account-service.ts)
- [官方余额控制器换算](https://github.com/cline/cline/blob/c3a40572765b76873c597247941118c1778d02c8/apps/vscode/src/core/controller/account/getUserCredits.ts)
- [官方显示换算](https://github.com/cline/cline/blob/c3a40572765b76873c597247941118c1778d02c8/apps/vscode/webview-ui/src/utils/format.ts)

## 自动续期

`resolve` 在凭据临近过期时调用官方 `/api/v1/auth/refresh`，正文为 `refreshToken` 与 `grantType=refresh_token`，固定 api.cline.bot HTTPS origin、不跟随重定向。WorkOS 账号保留 `workos:` 鉴权前缀，并拒绝 JWT subject 发生变化的续期响应。

默认桌面凭据复用来源指纹匹配的 `cline-oauth.json`；显式文件账号使用路径隔离的私有缓存。续期只消费最新匹配缓存中的 refreshToken，不退回旧客户端已使用的令牌。成功后原子存储下一令牌与有效期；原配置文件不改动。并发请求单飞且跨进程加锁。失败绑定到来源指纹，轮询不自动反复消费；本机重新登录/原配置改变后旧缓存和失败标记失效。

官方 SDK 参考：`sdk/packages/core/src/auth/cline.ts`，commit `c3a40572765b76873c597247941118c1778d02c8`。本实现独立实现固定端点、令牌校验与本机缓存管理，没有复制官方产品代码。短期 HTTP/模型实测只记录在本轮证据，不视为永久在线承诺。
