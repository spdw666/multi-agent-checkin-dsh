# 积分状态与窗口恢复

## 海螺：余额与每日资格分开

健康检查分别读取身份、余额和权益。国际站正常轮换的 `_abck` / `ak_bmsc` 流量 Cookie 只在严格匹配名称、域、路径、安全标记，且身份、认证信息、来源及其他 Cookie 均未改变时合并到内存。并发旧快照的保存不得回滚新流量状态。认证 Cookie 删除、账号变化、401 或外部凭据文件变化仍触发原身份校验。

卡片的“无每日签到”表示当前账号的官方权益未提供已核验的每日领取资格；这与余额为零、登录失败、“待检查”不同。失败时保留的上次成功值必须标注为旧值，不能假报本次核验成功。

## Liblib Art：官方钱包与独立积分池

余额使用官网 `member/account` 的 `data.attr.usablePower`，仅兼容旧结构时按总量减已用量计算；0 是有效余额。健康层传递 `balance.value`、`parts`、`source`、`note`，未知余额保留 null 与原因，不能以当日奖励数或猜测的零替代。

Art、LibTV 和模型卡分别计量。钱包 GET 可能附带日初始化效果，因此先验证同一账号、同一天、完整的已领取日积分回执，并要求距离日界线至少 120 秒；请求前后再核对身份、日期、历史记录和校验摘要。前置证据不足时不执行钱包读取，而是报告待核验原因。读取既有回执不算自动新增奖励。

## 原生窗口恢复

`RecoverWindowBounds` 将损坏的 `(-32000,-32000)` 最小化位置、脱离全部屏幕的窗口及过大窗口恢复到有效工作区；真实负坐标副屏位置保持不变。`RestoreVisibleWindow` 在显示和激活时复用此逻辑。后台重载脚本不应把最小化时的 `GetWindowRect` 写回正常窗口位置。

## 回归命令

Node.js 22.23.3 或以上，在仓库根目录运行：

```powershell
node --test tests/hailuo-traffic-cookie.test.mjs tests/liblib-balance.test.mjs tests/liblib-wallet-gate.test.mjs tests/liblib-gateway-balance.test.mjs
./desktop/tests/Run-WindowPlacementFixture.ps1 -SourceFile ./desktop/AiCreditDesktop.cs -OutputDirectory "$env:TEMP/AiCreditWindowTests"
```

前者包含 46 项会话、身份、并发、钱包结构、零余额、积分池隔离及网关映射测试；后者包含 14 项窗口工作区恢复测试。测试采用合成账号，不访问私人凭据或执行真实签到。
