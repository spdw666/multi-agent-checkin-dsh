# 调用用量与计费明细 API

## 查询

`GET /admin/usage` 需要本机 `adminKey` 的 Bearer 认证；模型调用密钥不能访问该管理接口。该接口不会重新提交模型请求或消耗模型额度。

| 参数 | 含义 |
|---|---|
| `accountId` | 精确匹配实际账号 ID，空值查询全部账号 |
| `model` | 精确匹配实际上游模型 ID，不是路由 ID |
| `status` | `running / completed / failed / cancelled`，空值不过滤 |
| `from / to` | 开始时间范围，含边界；合法日期时间转换为 UTC，错误日期返回 400 `invalid_date` |
| `limit` | 默认 100，上限 500 |
| `beforeId` | 上一页的 `nextBeforeId`，按递减记录 ID 查询更早记录 |

响应包含 `records`、筛选范围内的 `total`、`nextBeforeId`、`source`、`note` 和 `balanceChanges`。`total` 与页大小无关；游标为空表示该页后没有更早记录。新请求插入不会改变既有 ID。日期筛选依据 `startedAt`，跨越范围结束时间的请求仍按其开始时间归属。

## 每次上游尝试的字段

| 字段 | 含义 |
|---|---|
| `id / requestId / attempt` | 持久化记录 ID、同次请求关联 ID、从 1 开始的上游尝试序号 |
| `startedAt / finishedAt` | UTC 起止时间；运行中的条目尚无结束时间 |
| `routeId / model` | 对外路由与实际尝试模型，二者分开记录 |
| `upstreamId / accountId / accountLabel / platform` | 实际上游、账号及平台 |
| `source / stream / hasTools` | `api / dsh / audit` 来源、是否流式、是否包含工具定义 |
| `status / error` | 完成、失败、取消或运行中；错误按既有脱敏规则保存 |
| `durationMs / firstTokenMs` | 请求耗时与首个文本或工具调用增量耗时，毫秒；不是人工使用时长 |
| `promptTokens / completionTokens / totalTokens` | 上游 Token 计数；缺少总计但输入输出均明确时可相加 |
| `cachedTokens / reasoningTokens` | 上游明确返回的缓存、推理计数；未返回保持 `null` |
| `credits / cost / costUnit / chargeSource` | 上游明确返回的积分或金额、币种及依据；没有返回时保持 `null / not_reported` |

完成不意味着所有计费字段已返回。服务器明确返回的零与没有返回的 `null` 不同；不得用本地默认值、模型倍率或 Token 数冒充积分扣费。积分当前仅接受用量中的 `credits_used / used_credits` 数值；金额来自 `cost`，币种接受三位大写 `currency`。未返回币种时金额单位仍未知。

上游返回的累计计数按用量字段保留，不逐 SSE 分块重复相加。回退产生多条尝试，其中失败条目可能也曾被上游计费；不要把失败条目的未知计费当作零。消费者提前结束生成器时记录取消。进程异常结束可能留下 `running` 条目，它不证明请求成功，也不补造结束时间。

## 余额核验差额

指定 `accountId` 时，`balanceChanges` 返回该账号最近的核验变化记录，独立于调用列表的日期、模型及状态筛选。

字段为 `checked_at / previous_at / previous_value / value / unit / change / source`。首次核验或单位变化没有可比前值，`change` 为 `null`；余额未改变时不重复追加变化行；缓存、错误或缺少数字的结果不产生新的观察值。

`change = 当前余额 - 前次余额`，负值是净减少，正值是净增加。此变化可能同时包含网关调用、客户端直接调用、领取和套餐到期；这是账号级窗口变化，不是单次请求的精确扣费。同账号的不同单位不相减，不同单位不合计。

## 存储与运行

SQLite 在现有 `dataDir/gateway.sqlite` 中增量创建 `usage_calls` 和 `balance_observations`，不删除原领取记录或账号绑定。网关服务与独立 DSH worker 共用同一数据目录；安装更新后，新的进程加载记录代码，已加载旧代码的 worker 在下一次正常启动时读取更新。

提示词、回复内容、工具参数和凭据不写入用量账本。存储异常输出 `usage_record_write_failed / balance_observation_write_failed`，不替换正常聊天输出。旧版本没有记录的历史与绕过网关的客户端调用不在逐次账本中。

## 回归

```sh
npm run check
node --test tests/usage-details.test.mjs
```

测试使用模拟上游和临时 SQLite，覆盖真实目标归属、普通与 SSE 用量、回退关联、取消、缺失与零值区别、脱敏、持久化、筛选分页、余额单位以及管理认证。
