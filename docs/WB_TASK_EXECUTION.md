# WB 自动任务：后台进度、停止与结果核验

## 使用方式

在 WB 账号池进入“积分任务”，点击“执行可自动任务”。软件先创建后台作业，再读取本地进度，不让整个执行过程占用一个长 HTTP 请求。全号入口也打开同一任务窗口，避免多个账号串行执行时主页面长期等待。

窗口会显示当前账号、任务代码、执行阶段、已处理任务数与耗时。阶段分别包含查询官方状态、接受任务、真实执行、回查进度和领取奖励；“处理完一项”不等于官方已达标或积分已到账。

- **关闭**：仅退出本窗口的等待。后台任务继续，重新打开窗口可接管仍在运行的后台作业。
- **停止后续任务**：请求停止安排后续动作。若当前动作已经提交，状态保持“正在停止／等待当前提交确认”，直到实际调用结束；不会立即释放执行锁，也不会重发领取、创建资源或付费生成。
- **重新查询**：取得官方任务状态；不是重新执行任务。已有任务列表、滚动位置与未涉及任务的操作回执会保留。

## 等待预算与防重复

新管理后台作业默认最多安排 180 秒的工作；查询作业默认 30 秒。预算到达后发出取消信号，后续任务停止安排。已经提交且尚未完成的外部动作依然需要确认，因此“请求停止”与“确认已结束”分开显示。该预算不是对外部服务完成时间的保证。

本窗口每次启动／轮询请求均有独立短超时。短暂断连时保留作业 ID，只恢复只读查询；启动 POST 没有回执时不自动重发。相同账号、相同操作的重复启动在原作业活动期间返回同一个作业；冲突操作返回忙碌状态。全号与单号管理作业互斥。

批量“执行可自动任务”先处理可领取奖励、前置任务和有真实执行器的工作，不再逐项接受未达标的纯手工任务或仅等待外部条件的任务。明确点击“全部接受”或选择单项时，仍保留对应操作语义。

任务执行器的持久 `submitted`／`pending` 记录、官方领取回执与跨进程租约继续生效。关闭窗口、取消、超时或服务更新都不清空这些记录后重新执行。未确认的资源创建、生成和领取继续等待官方核验。

## 管理 API

所有端点使用本机管理 Bearer Key；以下只列结构，不包含真实 Key。

```text
POST /admin/workbuddy/task-jobs
GET  /admin/workbuddy/task-jobs?accountId=SAMPLE
GET  /admin/workbuddy/task-jobs/JOB_ID
POST /admin/workbuddy/task-jobs/JOB_ID/cancel
```

启动示例：

```json
{"accountId":"SAMPLE","action":"run"}
```

`accountId` 缺省表示全部启用的 WB 账号；`action` 支持 `run`、`accept`、`claim`、`query`；可选 `taskCode` 或 `taskCodes` 选择任务。启动立即返回 HTTP 202 与作业元数据。

状态包括 `running`、`cancelling`、`completed`、`cancelled`、`timed_out`、`failed`。`progress` 只含阶段、任务、数量和耗时等元数据；`snapshot` 只读取已有本地任务与回执，不触发官方调用；完成后的 `result` 固定为该次结束时的快照。

原 `GET/POST /admin/workbuddy/tasks` 保持兼容。新的原生界面使用作业端点，自动签到和自动任务开关、积分调用停用语义均保持独立。

作业句柄保留在当前后台进程内；服务重启后，客户端显示记录已结束／结果待核验，并通过已有持久回执和官方重新查询恢复，不凭缺失的作业 ID 自动重放动作。

## 验证层次

本地 SAMPLE 测试覆盖慢执行立即回执、进度更新、关闭、停止、断连恢复、单飞、防重复、时间预算、非合作取消保留锁、迟到只读结果丢弃与旧回执保留。生产中的只读任务查询验证和真实任务领取记录分别记账，不把界面测试通过写成新的奖励领取成功。

实现参考了 [Microsoft 的后台操作与取消说明](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-run-an-operation-in-the-background)及[取消等待与取消底层操作的区别](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/cancel-non-cancelable-async-operations)。界面沿用项目的 .NET Framework WinForms 与既有 Theme；没有引入仅 .NET 9 提供的 `Control.InvokeAsync`。
