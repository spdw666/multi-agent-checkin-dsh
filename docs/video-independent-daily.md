# 视频平台独立每日权益

## 运行方式

七个账号类型为 `vidu`、`pixverse`、`jimeng`、`kling`、`xiaoyunque`、`hailuo`、`liblib`。这些账号只参加固定的 `daily-checkin`，不添加视频生成上游、模型或反代路由。

首次连接可以通过已登录的官网会话一次性导入。导入器只在本机监听，Windows 当前用户 DPAPI 保存会话；浏览器扩展不承担日常执行。`liblib` 依实际导入的 Art / TV origin 分流，不把两个产品的资格混用。

日常执行由网关的 CredentialsManager → Platforms → ClaimService → SQLite ledger 完成。程序不启动浏览器、CDP 或无头浏览器。首次导入、源代码安装、模拟响应测试均不构成官方到账证明；验收须分别观察当前官方身份、动作、新增当日账本与浏览器进程完全退出时的执行。

## 添加账号

```powershell
& '.\runtime\node.exe' '.\core\scripts\setup-video-daily.mjs' --config CONFIG_FILE
& '.\runtime\node.exe' '.\core\scripts\setup-video-daily.mjs' --config CONFIG_FILE --apply
```

预览先于写入，保存采用配置快照校验。已有账号不重建、不启用或覆盖；只补齐缺少的七个专用账号，不改原调度、上游、路由、默认设置或凭据。Vidu / PixVerse 保留原账号目录；新增五项引用 `data/video-sessions/PLATFORM.verified.json`。脚本不创建会话凭据。

## 领取与资格

- Vidu 使用官方每日领取回执；正数才是新积分。零显示当日已核验、无新增，不伪报正奖励。同一主体、同日已有正官方回执时，余额读取的未知领取状态不导致重新领取。
- PixVerse 只处理 DAILY / LOGIN 且官方已完成的任务；领取后必须回读 CLAIMED。逻辑日与下一窗口按 UTC，其他平台使用其相应的中国日期合同。
- 即梦、可灵、小云雀的新积分必须对应同一主体、当日、金额一致的新增官方账本记录。通用成功提示、余额增加或自行构造的 JSON 不成为新积分回执。
- 可灵依当前官方会员条件。海螺按实际站点与账号核对当前日资格；Liblib Art 只认同一主体、当日日积分来源，其他尚未核定的 daily 来源明确保持待核验，并保持零领取动作；不将续期、欢迎奖励、订阅额度或免费生成次数算作每日积分。

## 会话维护与并发

会话只能来自已核验的 DPAPI 文件。来源文件、主体、origin、日期和任务均有围栏；来源变化必须重新读取与核验。

HTTP 返回的正规 Set-Cookie 仅合并对应官方域与路径。合法轮换先只读核对同一账号，再加密回写；身份响应持续轮换则停止并保留待核验，不将未知会话当成成功。注销保存过期 tombstone，当前上下文及重启后的解析均停止发送旧凭据。

Windows 生产写入由同文件命名 Mutex 串行化，锁内核对 `expectedSourceHash` 后原子替换。锁由 OS 在持有者退出时释放，不留下需要手动清理的锁文件。这是本组件 writer 的协作事务，不声称对绕过该锁的任意外部编辑器提供 OS 级原子比较交换。

动作前的身份读取失败允许后续正常恢复；提交后的未知、账本不完整或主体变化保持 uncertain，不重放领取。手动重试也不绕过同日 ledger 的提交围栏。
