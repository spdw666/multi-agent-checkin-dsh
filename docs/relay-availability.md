# 同型号供应筛选与 503

网关只更换供应，不更换客户端模型 ID，不截断历史、工具参数或调用方的输出预算。

## 精确的模型别名

普通模型按完整型号及版本归组，只规范化已知命名空间与 `:free` 后缀。Qoder 的 `gmodel` 是原生不透明键，只有当其带鉴权签名的实际目录明确返回 `id=gmodel`、精确的 `name=GLM-x.y`、`callable!=false` 和 `source=qoder-official-signed-catalog` 时，才参与该精确版本的同型号供应组。界面路由名称、用户自填名称、`Auto`、模糊前缀均不提供别名依据；每次准备请求重新解析当前目录，不固定猜测 `gmodel` 的版本。

停用的账号、上游与路由不会因别名被恢复。已有 WorkBuddy 账号池的真实额度冷却仍被全局接力遵守；池外同型号供应可以接力，但不会改变原池的手动优先级。

## 默认预算不是官方硬上限

`maxTokensSource=configured_default` 仅表示默认输出建议。官方目录没有声明输出上限时，网关保留调用方的原始 `max_tokens` / `max_completion_tokens`，不因这个默认建议直接判定供应不兼容。明确的官方容量仍作检查，不适配的目标只跳过，不降低原始预算。

目录聚合也不会把另一供应的 `configured_default=1024` 当硬上限，压低原供应的默认输出值；原供应自身默认仍保留。同一目录刷新期间，对同一账号/凭据引用的在途模型读取合并为一次，完成后即释放，不永久缓存不透明型号别名。一个读取者取消不取消其他读取者，查询有独立的有界超时。非 GLM 组不会为了不相关的 Qoder `gmodel` 别名反复读取签名目录。

## 请求能力与供应冷却分开

`relay_capacity_incompatible`、`tools_not_supported`、`images_not_supported`、`reasoning_effort_not_supported`、`reasoning_parameter_not_supported` 是本次请求的兼容性失败，可以继续寻找同型号适配供应，但不写整个供应的冷却。旧版本遗留的 `capability_unavailable` 冷却亦不阻挡后续本来适配的请求。

真实额度、限流、认证和上游故障冷却照常保留。新鲜官方积分/credits 已明确为零的供应不发送生成请求；有同型号余量供应时直接接力，全部都明确为零时返回 HTTP 402 / `same_model_credits_exhausted`，不捏造下一次补充时间。货币余额为零、过期/错误/未知积分均不视为生成额度为零。所有已启用的同型号供应处于实际冷却时，返回 HTTP 503 / `same_model_cooldown` 和有限的 `retryAfterSeconds`，HTTP `Retry-After` 为它向上取整的秒数。没有启用供应时返回 `same_model_unavailable`，也不把 Qoder、Cline 等组误称为 WorkBuddy 账号池。

同型号供应的实际余额、可用资源包和限流由供应方决定，目录列出不等于一次请求必定成功。全部实际供应返回错误时保留失败状态，不把更换了其他型号或返回空答案当成功。

已有适配供应返回限流、额度、认证或超时错误，而最后候选仅因为工具、图片或输出预算不适配时，最终接口返回 `503 / same_model_unavailable`，不把整条失败链误判为调用者的 `400 INVALID_REQUEST`。每家供应的原始错误仍分别写入账本；存在真实冷却时附实际最早重试期限。全部候选单纯不支持请求能力时，保留相应 `400`；不相关的请求参数错误仍立即结束，不继续接力。

## 慢供应与整轮超时

接力在完整验证前缓冲答案和工具调用。一家供应悬停时，不能让它一直占到客户端整轮超时：多供应请求默认给单供应至多 90 秒，并按剩余整轮预算为后续同型号供应留出时间；该期限覆盖目录、发送和完整缓冲读取。超时返回内部 `504 / relay_target_timeout`，丢弃尚未交付的片段，再尝试同款下一家。只有一家时保留整轮预算。

模型目录的 `modelRelay` 声明 `attemptTimeoutMs` 和实际 `requestTimeoutMs`。DSH 的缓冲模式空窗期限至少为服务器整轮预算加 10 秒收尾余量，避免把正常接力等候误判为用户取消。服务器仍读取当前用户的整轮设置，不修改管理配置、默认模型或原始输出预算。真正的用户取消立即停止、记 `499 / request_cancelled`，不尝试其他供应；网关整轮期限则记 `504 / request_timeout`，不冒记为自愿取消。

## 验证

```powershell
node --test tests/relay-availability.test.mjs tests/model-relay.test.mjs tests/relay-reasoning-integration.test.mjs
```

测试为隔离的合成上游，覆盖 Qoder `1024` 默认值误判、连续请求、官方别名变化、未声明别名、真实信用/限流冷却、旧能力冷却、同型号 402 接力与最大思考档、账号池不被复活、停用项、预算/工具/上下文原样保留。真实桌面刷新与完整工具回合的实测记录独立归档，不能由单项账本 `completed` 替代。
