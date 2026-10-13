# Loomy 生产会话接入

原生会话按官方 config-path.js 规则定位：Windows 当前用户名 SHA256 前12位的 `C:/Users/Public/Loomy/<hash>/userData/auth-session.json`；不扫描其他用户会话。高级引用可以指定私有文件。账号 credentials 使用 desktop/auto 或已有原生 session 文件引用。会话只读重读，不改原应用登录。

## 已纠正的环境差异

旧 `ossptest.voicecloud.cn/loomy/integration/api/v1` 是错误环境；该环境返回100002不证明生产会话已失效。正确官方生产服务为 `https://loomyad.xunfei.cn/api/v1`。请求使用 Authorization Bearer、token、traceparent、loomy-version，与官方 useSessionAuth 一致。域名固定，重定向拒绝。

- `/models`：真实模型ID、类型、上下文、最大输出、function_calling、vision、reasoning_efforts。非聊天类型不作为聊天路由发布。未知型号本地拒绝。
- `/points/records`：只读取顶层 balance/dailyBalance/availableBalance，后者是官方可用总额，绝不从流水求和推测余额。个人与团队余额分离。
- `/pet-work`：真实 nested config/status；earnedPointsToday 与 rewardedTierIds 单独报告。没有达到档位的真实依据时不自动提交宠物奖励。请求前置与提交后复核保留。
- `/chat/completions`：真实 SSE、工具调用/回传，max_tokens/max_completion_tokens兼容；输出上限取官方目录；业务错误流不会转成成功空答。

## 每日额度与宠物奖励分开

- status daily-quota 只读余额；没有当前账号/会话的今日核验回执时返回 active:true/observed:false，正式任务进入刷新；已有今日回执才 observed:true。claim 则按原生客户端执行 POST /api/v1/points/first-login，空对象请求，随后 GET points/records 复核。旧 daily-checkin 只是 daily-quota 兼容别名，不指向宠物奖励。
- 返回 observed:true, claimed:false。HTTP 200、alreadyProcessed 或余额大于零都不是“今日已签到”。
- 只有回执提供 dailyCycleDate/dailyQuota/dailyBalance/currentBalance，且后两者与复核余额一致时，才缓存账号与会话绑定的日回执。health.balance 字段：dailyQuotaObserved、dailyCycleDate、dailyQuota、dailyQuotaObservedAt、dailyQuotaSource。仅上海时区今天的回执 dailyQuotaObserved=true；可显示“今日额度已到账”，其余显示“每日额度自动更新”。余额 GET 自身没有日期。
- 内存回执缓存不保存 token 明文，key 为账号+会话哈希，跨日、切换会话或进程重启不会单靠旧内存状态判定今日到账。刷新失败先清除旧内存回执。checkedIn 始终 null；宠物进度与奖励放 petWork/checkin 详情。
- pet-work 只接受服务器快照提供的业务日期、版本与到达档位，忽略调用者传入的伪进度。没有明确资格不 POST。原生客户端依据真实对话工作量计算档位，网关不模拟活跃会话或有效轮次。

## 会话续期

官方 session 约14天；session-only账号没有可用 refresh_token，参考项目 force-refresh 实际是有密码时重新登录，不是无凭据刷新。网关默认只读现有会话；真实生产端鉴权失效时由官方应用重新登录，再读取新会话。不保存密码或改浏览器。

## 验证与来源

正式provider在真实生产接口完成 DeepSeek-V4.1-Flash 普通/SSE/lookup工具/回传四阶段；官方metadata为1048576上下文、384000最大输出与function_calling=true。目录/余额不是推理成功的替代。

回归：`node --test tests/provider-loomy.test.mjs`。外部参考 `Patrick130306/loomy2api` MIT，完整许可证 vendor/loomy2api/LICENSE；固定提交与区别见 docs/provider-attributions.md。原生产品源码与账号数据不分发。


## 余额健康读取时限

四个独立只读 GET（identity、pet-work、points、models）并行执行，不再串行累计超时。points 关键读取最多20秒，其余各8秒；调用者更短的 timeoutMs 或 signal 优先，完成后清理计时器。points成功才提供主余额；失败保留 balanceError，宠物快照不替代个人余额。辅助目录/宠物失败独立记录，不把已成功的points余额当登录失败。余额缓存层负责将关键错误保留为旧值stale/error，而不是显示新鲜的null。

## 重启后的同日回执恢复

进程重启后，健康读取可从本机领取账本恢复已核验的同日官方回执，不额外提交 first-login。查找使用当前账号 principalHash、上海业务日、已启用配置任务和设备标识组成的精确 claimKey；只接受 observed、observationSchema=1、同日 observationVerifiedDay、官方 first-login 来源及有效日期/额度字段。新鲜 points GET 成功且没有 balanceError 时，仅恢复五个每日额度字段，当前余额及分项仍取新 GET，不恢复旧消费前余额。跨日、换账号、来源不符、未知回执或 points 失败均不继承今日到账标记；宠物奖励不参与此恢复。

