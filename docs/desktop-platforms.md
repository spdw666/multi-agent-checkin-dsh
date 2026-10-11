# 桌面平台接入与真实能力

平台种类：`qoder`、`codebuddy`、`workbuddyai`、`cline`、`codearts`、`lobster`、`raccoon`、`loomy`。国内与国际登录态使用独立账号；Qoder 和 CodeBuddy 显式填写 edition=cn/global。

## 本机读取

`credentials: {kind: "desktop", file: "auto"}` 用于已实现的官方桌面登录读取。文件模式仅保存私有引用；管理配置禁止直接内嵌 accessToken、refreshToken、apiKey、accessKey、secretKey、securityToken 等凭据。不同平台的私有文件结构见各 provider 文档，不互换 token。

示例（无真实凭据）：

```json
{"id":"qoder-cn","platform":"qoder","edition":"cn","enabled":false,"credentials":{"kind":"desktop","file":"auto"},"tasks":[{"id":"daily-checkin","enabled":true}]}
```

对应 upstream 的 kind 与 account.platform 必须相同。先查模型目录，再导入需要发布的模型；保留用户此前停用的账号和模型。目录存在不表示每个模型都经过普通、SSE、工具调用和工具回传四项验收。

## 每日活动

- Qoder 使用实际 CREDITS 活动 ID 与服务器活动日组合去重。上午 10 点换期后调度器重新检查；不以自然日的一次已领取记录锁死下一窗口。
- CodeArts、Lobster 只领取已验证的每日活动，先查状态，提交后再查；已经领取不重复 POST。
- CodeBuddy CN 与 WorkBuddy 若实际同一计费身份，由一个账号负责签到。共享领取不意味着可以把两个展示卡片额度相加。
- WorkBuddy AI 是否有活动按官方当前响应判断。没有活动与签到查询失败不同：前者显示无每日签到，后者显示签到待核验。
- Cline 等没有已验证签到接口的平台不伪造签到；兑换码不是每日签到，平台自动发放也不是本地领取成功。

## 额度与能力

余额与签到独立请求；一个接口失败不抹去另一个已核验结果。数值 null 表示没有读到，不是零；网络失败不等于登录过期。输出或上下文配置上限若不是官方元数据，字段 source 明确标记 configured_limit/configured_default，official 字段保持 null。

## 调用与验收

DSH 与 Hermes 继续使用既有 ai-credit Provider 和启用路由，默认模型不会因导入新平台而被擅自更换。管理 API 选测：POST /admin/model-tests，body 为 {"scope":"selected","routeIds":["精确路由ID"]}。结果区分 passed、partial、uncertain、unavailable、failed；聊天通过但工具未声明不会显示四项全通过。

参考与许可证：[provider-b.md](provider-b.md)、[provider-attributions.md](provider-attributions.md)。各平台详细文档按 provider 名称分列。
