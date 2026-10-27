# 视频平台每日积分：导入、卡片与自动运行

七站是 Vidu、PixVerse、即梦、可灵、小云雀、海螺与 Liblib；它们只运行固定每日任务，不提供视频反代或生成。功能总览与状态表见 [README](../README.md#七视频平台每日积分)，协议围栏见 [独立每日权益](video-independent-daily.md)。

## 一次性连接

1. 先在 Edge 登录需要连接的官网账号；国内站、国际站以及 Liblib Art/TV 保留实际使用的来源，不替换为另一产品的登录。
2. 在 Edge 的 `edge://extensions` 打开开发者模式，选择“加载解压缩的扩展”，目录为本仓库的 `integrations/edge-daily-companion`。核对名称“AI积分网关 · 一次性本机会话导入”和 ID `ppbanlmjmecbeffacgjghocjbcfmaifk`。
3. 在运行网关的同一 Windows 用户下启动一次性导入服务。`DATA_DIR` 应为网关实际数据目录；`PRIVATE_DIR` 使用本机私有目录，不加入版本控制。示例从仓库根目录运行：

```powershell
node scripts/import-video-sessions.mjs --data-dir DATA_DIR --private-dir PRIVATE_DIR --protocol-a src/video-independent-a/independent-daily-provider.mjs --protocol-b src/video-independent-b/providers.mjs
```

4. 打开该命令返回的本机 `onboardingUrl`，点击“开启本次连接”。打开扩展弹窗，核对说明，勾选确认并点击“本机加密导入”；通常无需复制连接码。
5. 导入服务仅监听 `127.0.0.1:19422`。本机页面先开启 5 分钟连接窗口，扩展再申请临时 Cookie / scripting 权限；连接码一次使用、服务窗口有期限。重复已使用的请求显示既有脱敏回执，不重新导入。
6. 登录态只存本机 Windows 当前用户 DPAPI 加密文件。导入成功与身份通过是两个状态；后续网关须以同一主体的官方身份读回验证。身份未通过时保留待核验，不称为已签到。

扩展仅用于首次导入，不运行每日任务，不在后台打开标签页或生成视频。manifest 中的 `key` 是固定扩展身份使用的公开 RSA SPKI 公钥，不是网站登录凭据或私钥。导入后扩展撤销本次 Cookie / scripting 权限；Cookie、Token、原始账号 ID 和连接码不进入公共日志。

## 添加每日账号

```powershell
node scripts/setup-video-daily.mjs --config CONFIG_FILE
node scripts/setup-video-daily.mjs --config CONFIG_FILE --apply
```

第一条只预览，第二条仅追加缺失的七个专用账号；已有账号对象、路由、上游、默认模型、排程与签到时刻保持原样。脚本不创建凭据，配置中的文件引用必须对应实际完成身份验证的本机加密会话。

## 页面操作

卡片使用本地官方 Logo，底部按“重新核验”“进入”“额度明细”排列。“进入”在 Edge 中打开已绑定来源的官网，不依赖系统默认浏览器，也不提交领取请求。“重新核验”区分今日已领、官方零回执、无每日资格、明确可领取、待核验与读取失败；余额是独立字段。

Vidu 的官方零回执表示当前日已核验但无新增，不等同于正积分；可灵的当前会员条件以及海螺一次性试用不显示成待领取。今日手动已完成的签到显示当日官方状态，同时仍保持手动/既有奖励的归属，不冒记为本网关自动新到账。

## 每天是否需要浏览器

日常只需网关后台、有效的加密会话、网络及官方当时的领取资格；Edge、其他浏览器、导入扩展与无头浏览器都不是执行前提。桌面窗口关闭到托盘后，后台仍可运行；完全退出后台或电脑关机时不发请求。

调度器约每 30 秒检查当前计划、到期时间与持久退避。PixVerse 以 UTC 日为权益周期（北京时间 08:00），其余站点按各自中国日期窗口；睡眠/重启后对已到期项继续核查。已提交但结果未知的任务只读对账，不通过自动重放来制造重复领取。

浏览器全退时的运行成功与“下一个自然日取得新奖励”分别验收。官方可能不向某账号提供每日资格；会话也可能到期。卡片原因与官方新回执才是判定依据，不能由一次健康检查或已有余额推定明日全部有新奖励。

## 故障恢复

- 登录过期：在对应官网重新登录并执行新的本机导入，随后只读核验同主体；不删除 uncertain 记录强行重领。
- 当前无每日资格：查看额度明细中的站点、原因和来源。不要把会员奖励、欢迎礼包、试用积分、免费生成次数与日签到混用。
- 网络或接口错误：保留原回执与退避，由后续调度恢复读取；HTTP 200 本身不是到账证明。
- 电脑刚唤醒：确认后台运行，并检查今日任务的核验时间和 nextClaimAt；计划时间不会因为打开页面而被改写。

## 协议参照

- [Vidu 官方 CLI](https://github.com/shengshu-ai/vidu-cli)、[PixVerse 官方 CLI](https://github.com/PixVerseAI/cli)：余额与任务合同参考，不以 CLI 订阅资格替代网页免费资格。
- [即梦官网](https://jimeng.jianying.com/)、[可灵官网](https://klingai.com/)、[小云雀官网](https://xyq.jianying.com/)、[海螺官网](https://hailuoai.video/)、[Liblib Art](https://www.liblib.art/)：来源、当前身份和权益分别核对。

本仓库测试使用 SAMPLE 数据，不包含个人会话、Cookie、Token、SQLite 或真实账单。官方图标只用于识别服务，来源见 [平台图标来源](platform-icon-sources.md)。
