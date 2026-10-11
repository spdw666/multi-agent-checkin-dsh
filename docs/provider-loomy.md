# Loomy 生产会话接入

原生会话按官方 config-path.js 规则定位：Windows 当前用户名 SHA256 前12位的 `C:/Users/Public/Loomy/<hash>/userData/auth-session.json`；不扫描其他用户会话。高级引用可以指定私有文件。账号 credentials 使用 desktop/auto 或已有原生 session 文件引用。会话只读重读，不改原应用登录。

## 已纠正的环境差异

旧 `ossptest.voicecloud.cn/loomy/integration/api/v1` 是错误环境；该环境返回100002不证明生产会话已失效。正确官方生产服务为 `https://loomyad.xunfei.cn/api/v1`。请求使用 Authorization Bearer、token、traceparent、loomy-version，与官方 useSessionAuth 一致。域名固定，重定向拒绝。

- `/models`：真实模型ID、类型、上下文、最大输出、function_calling、vision、reasoning_efforts。非聊天类型不作为聊天路由发布。未知型号本地拒绝。
- `/points/records`：只读取顶层 balance/dailyBalance/availableBalance，后者是官方可用总额，绝不从流水求和推测余额。个人与团队余额分离。
- `/pet-work`：真实 nested config/status；earnedPointsToday 与 rewardedTierIds 单独报告。没有达到档位的真实依据时不自动提交宠物奖励。请求前置与提交后复核保留。
- `/chat/completions`：真实 SSE、工具调用/回传，max_tokens/max_completion_tokens兼容；输出上限取官方目录；业务错误流不会转成成功空答。

`daily-quota` 只读观测任务返回 known:true/observed:true/reason:server_auto_daily_quota。claim 此任务不发POST，不声称领取成功。宠物奖励与每日自动积分不是同一个任务。

## 会话续期

官方 session 约14天；session-only账号没有可用 refresh_token，参考项目 force-refresh 实际是有密码时重新登录，不是无凭据刷新。网关默认只读现有会话；真实生产端鉴权失效时由官方应用重新登录，再读取新会话。不保存密码或改浏览器。

## 验证与来源

正式provider在真实生产接口完成 DeepSeek-V4.1-Flash 普通/SSE/lookup工具/回传四阶段；官方metadata为1048576上下文、384000最大输出与function_calling=true。目录/余额不是推理成功的替代。

回归：`node --test tests/provider-loomy.test.mjs`，29项。外部参考 `Patrick130306/loomy2api` MIT，完整许可证 vendor/loomy2api/LICENSE；固定提交与区别见 docs/provider-attributions.md。原生产品源码与账号数据不分发。
