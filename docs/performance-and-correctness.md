# 性能与并发一致性

优化保留账号、路由、领取规则和排程。缓存仅减少重复计算和重复只读查询，不把旧状态伪装为新的官方回执。

## 数据库与调度热路径

- 每个账本连接复用最多 64 条已编译 SQL；不缓存查询结果。另一个进程提交的新状态仍在下一次读取时可见，领取事务和防重复提交约束不变。
- 余额历史按账号与记录 ID 建索引，避免每次查询遍历其他账号的历史。首次打开旧数据库会幂等创建索引，保留原有记录。
- 日期计算复用最多 32 个字符串时区的 `Intl.DateTimeFormat`；仍逐次格式化实际日期，午夜和夏令时变化不会被缓存。排程时间、时区及随机抖动不变。

## 并发只读与认证恢复

- 同来源的并发余额刷新共享只读操作；账号、版本或凭据引用变化后，旧请求的晚到成功或失败不得覆盖新来源缓存。
- 普通凭据读取与强制续期分开表达需求。强续期等待正在进行的普通读取，再启动或合并所需恢复，不并行旋转同一账号的刷新凭据。
- 共享模型余额查询与调用者取消分离：取消一个调用者只结束该调用者的等待，其他调用者继续接收有时限的共享读取结果。
- 这些合并只作用于读取，不增加领取、接受任务或模型生成的重放。

## 配置、目录与长请求

- `ConfigStore.load` 和最终 WB 积分调用检查仍每次完整读取文件。仅当原始文本完全相同时复用该实例最近一次成功校验结论；每次重新解析原 JSON、重放 lenient 删除计划并返回独立对象。新内容、坏 JSON 和敏感字段编辑立即走原验证路径，不依赖文件时间、大小或 TTL。`snapshot/save` 的严格校验、写锁及双 SHA 冲突检查保留。
- 配置完整校验在单次调用内建立账号／上游索引，保持原过滤次序、错误信息和 `skipped` 非枚举诊断；保留 JSON `-0` 等值，不通过重新序列化改变配置。
- 一次模型目录构建共享已完成／进行中的目录 Promise，以及分区、型号与模型 ID 索引。批次结束即释放，不新增跨批目录 TTL，也不缓存最终路由选择。异步读取前后核对配置及账号池选择，变化时重新构建，持续变化时返回明确状态而非旧目录。
- Router 与 Platforms 两层都按完整账号／上游来源及变化版本区分目录；国内／国际版本、凭据引用或来源改变后不共享旧 flight，晚到结果不覆盖新来源。单个消费者取消只停止自己的等待，底层目录读取有独立的期限与清理。
- 长请求复用已计算的 UTF-8 字节数；请求上下文统计在验证后捕获一次，每次候选尝试复制小型元数据快照。原消息、工具定义、输出预算、模型响应和流式交付保持原路径，不把正文或工具参数放进统计。

## 诊断与记录查询

- 固定列名／比较操作符构建参数化 `WHERE`，过滤值始终参数绑定。启用的条件直接参与索引搜索，`id < ?` 游标直接定位；空字符串省略过滤，其他输入保持既有含义。
- usage 与 records 使用 `(account_id,id)` 索引，records 另有 `(platform,id)` 索引。索引幂等创建，记录不迁移、不清空。
- 公开 usage 默认仍返回实时精确 `total`，总数仍不受分页游标影响。只有不使用总数的活动洞察／请求诊断内部扫描传 `includeTotal:false`，避免每 500 行重复扫描全量计数。
- 活动图表由对所有请求重复 7／30 次筛选改为一次日期分桶；北京时间、顺序、状态、Token 汇总、范围、搜索和截断标志保留。不存在跨请求统计结果缓存。
- 请求诊断对每组请求只准备一次账号脱敏上下文，复用已整理的敏感值、小写比较表、账号替换正则与匿名引用；不再逐字段重新遍历整份配置。复用只存在于当次同步投影，下一次调用仍立即看到账号／敏感值的新增、移除和原地修改，历史行中未配置的账号仍参与该组脱敏。
- 目录查询超时后，忽略取消信号的旧供应商响应也要在后续派发／Trae wire 写入前检查已取消状态，避免覆盖超时后新查询建立的映射。

## 开源设计参考与取舍

本实现借鉴设计，不复制外部源代码，也不新增运行时依赖：

| 资料 | 应用到本项目的做法 |
|---|---|
| [Go singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight) | 合并同一来源的重复只读工作；在此基础上显式隔离消费者取消，并将已完成结果的复用限定在单批刷新。 |
| [Ajv 管理和复用校验函数](https://ajv.js.org/guide/managing-schemas.html) | 借鉴复用昂贵准备工作的原则。Ajv 缓存编译后的函数；本项目复用完全相同文本的校验结论，仍每次读盘，不以此替代严格保存验证。 |
| [SQLite WHERE 优化](https://sqlite.org/optoverview.html)、[组合索引和排序](https://sqlite.org/queryplanner.html) | 参数化有效过滤、账号／ID 索引、主键游标和去除内部重复 COUNT。 |
| [Fastify 序列化](https://github.com/fastify/fast-json-stringify) | 对固定 schema 的编译序列化有参考价值；本项目兼容任意 OpenAI 扩展字段，改为复用已有字节计数与元数据，不换 serializer、不丢字段。 |
| [Bifrost](https://github.com/maximhq/bifrost)、[LiteLLM Router](https://docs.litellm.ai/docs/routing) | 参考减少代理管理开销、区分路由状态与结果缓存的架构。沿用当前 Node 服务和协议适配，不引入 Go／Python 服务或 Redis。 |

模型回答／语义缓存、自动上下文裁剪和按速度改选模型会改变调用结果，因此不作为默认提速策略。官方接口的等待时间仍取决于实际服务，项目的 benchmark 不引用其他网关的宣传性能作为本项目结果。

## 容量、错误与日志

- 低输出预算的既有下限适配保留；多个输出预算字段不向下改写。容量检查同时考虑实际适配后的预算，避免通过检查后才把请求扩大到候选容量以外。
- JSON `null` 明确归类为非法上游响应；401、403、429、503 等 HTTP 状态保留，不再因空值访问而混为普通 502。
- 已登记秘密按原文本匹配区间合并遮盖，覆盖前缀和交叠字符串；Bearer/JWT 的既有遮盖继续生效。

## 离线复测

Node.js 22.23.3 或更高版本，在项目目录执行：

```powershell
npm run check
node scripts/benchmark-hotpaths.mjs --output benchmark-result.json
```

比较另一份源码时：

```powershell
node scripts/benchmark-hotpaths.mjs --root "PATH_TO_BASELINE" --output baseline-result.json
node scripts/benchmark-hotpaths.mjs --root "PATH_TO_MODIFIED" --output modified-result.json
```

基准只创建临时合成账本，不读取真实配置、不连接官方服务：每组预热 1 轮、测量 5 轮并给出中位数；输入固定为 20,000 次元数据读取、3,120 次时区日期计算，以及 50,000 行余额历史中的 100 次查询。比较耗时前应先确认 `input`、各组 `result` 完全相同。SQL 编译次数和查询计划一并输出，便于区分算法改进与机器负载波动。

这是本机热路径测量，不等同于第三方模型生成、官方签到服务或整个界面的等比例加速。自动签到验收仍需要自然未完成状态、调度器实际动作及新的官方回执；手动已完成和 `already` 不算新增自动奖励。

实现参考：[SQLite 语句生命周期](https://sqlite.org/cintro.html)、[Node.js SQLite API](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md)。

### 第二组基准

仍只使用临时合成数据，不读取真实账户或调用官方服务。将 `BASELINE_ROOT` 换为修改前源码目录，`MODIFIED_ROOT` 换为修改后目录，两边使用同一份脚本：

```powershell
node scripts/benchmark-v2-config.mjs "BASELINE_ROOT"
node scripts/benchmark-v2-config.mjs "MODIFIED_ROOT"
node scripts/benchmark-v2-catalog.mjs --root "BASELINE_ROOT"
node scripts/benchmark-v2-catalog.mjs --root "MODIFIED_ROOT"
node scripts/benchmark-v2-store.mjs --root "BASELINE_ROOT" --rows 100000 --rounds 5
node scripts/benchmark-v2-store.mjs --root "MODIFIED_ROOT" --rows 100000 --rounds 5
node scripts/benchmark-v2-request.mjs "BASELINE_ROOT"
node scripts/benchmark-v2-request.mjs "MODIFIED_ROOT"
```

配置包含 29 账号／83 路由的 500 次真实文件读取和 500 账号／1,500 路由的完整校验；数据库包含各 100,000 条调用与领取记录，分别测分页、账号过滤、完整活动洞察和完整请求诊断；长请求包含 256 条消息、64 个工具，每次 8 个离线模拟候选。目录分别考察分阶段模拟延迟与无网络延迟的本机计算。一般基准预热 1 轮、计时 5 轮；零延迟目录预热 10 次，再测 5 轮、每轮 100 次。比较结果 SHA／回答及实际调用数后再比较耗时；小数据集的个别查询可能持平或波动，首次建索引和后续写入维护成本不在读路径计时内。测试目录中的 `optimization-v2-*.test.mjs` 覆盖即时失效、并发、取消、过滤与元数据隔离。
