# WebView2 桌面分发

WebView2 工作台是可选桌面界面。后端产品版本仍为 **0.8.1**，界面发行版本为 **0.8.1-web.1**。公开 0.8.1 后端基线只增加便携路径适配：默认运行记忆使用当前用户目录，剪贴板图片路径识别不限定某个用户名。现有 `desktop/build.ps1` 继续构建 WinForms；其默认入口、原生配置和同步方式没有切换成 WebView2。

## 直接下载

- [独立预览发行页](https://github.com/spdw666/multi-agent-checkin-dsh/releases/tag/v0.8.1-desktop-webview2.1)
- [Windows x64 ZIP](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip)

完整解压后双击 **AI积分网关.exe** 或 **启动新版工作台.cmd**。内置 Node.js 22.23.3 和网关后端，普通用户无需 npm 或源码构建。首次打开是空账号工作台；需要自己在官方平台登录或导入自己的账号。包内没有作者账号、密钥、个人配置、数据库或调用记录。

运行环境是 Windows 10/11 x64、.NET Framework 4.8+ 与 WebView2 Evergreen Runtime。启动程序会检测实际 Runtime；仅安装 Edge 浏览器不等于已有 Runtime。缺少 Runtime 时，可以主动点击安装随包附带的 Microsoft 签名 bootstrapper，或访问[微软官方下载](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section)。bootstrapper 安装需要联网；已有 Runtime 时不重装。详见[微软运行时分发文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。

## 数据与实例隔离

便携包创建自己的 `user-data`，包含配置、账号池、后台数据、WebView 资料和窗口状态；目录不可写时，使用 `%LOCALAPPDATA%/AiCreditGatewayWebPortable/<目录身份哈希>`。它不自动读取原生安装的账号或配置，也不替换原生快捷方式。

首启计划任务与启动签到关闭，端口为 `0`，由系统分配空闲回环端口。需要使用外部客户端时，从本实例状态中查看实际地址和自行配置凭据。账号导入、刷新、签到、模型测试、开启任务等均由用户发起，不在首启自动执行。

顶部关闭按钮收至托盘；托盘退出窗口后，后台可以继续运行。删除本便携版前，先在窗口底部暂停本实例后台，再退出 UI，最后备份所需 `user-data`。使用后的文件夹包含个人数据，不应作为发行原件上传。

## 从干净源码构建

需要 Windows x64、.NET Framework 4.8 开发/编译组件、Git 和官方 Node.js **22.23.3 x64**。首次构建需要网络下载固定版本 WebView2 SDK 与官方 bootstrapper；脚本核验固定 SHA-256，并核验 bootstrapper 的 Microsoft Authenticode 签名。版本、来源及许可保留在 `desktop/webview-shell/prerequisites`、`licenses` 和字体目录中。

```powershell
git clone https://github.com/spdw666/multi-agent-checkin-dsh.git
Set-Location multi-agent-checkin-dsh
git checkout v0.8.1-desktop-webview2.1
npm ci
npm run build
node --test tests/portable-path-defaults.test.mjs tests/webview-distribution.test.mjs tests/webview-import-selection.test.mjs
node --test --test-concurrency=1 desktop/webview-shell/adapter/tests/management.test.mjs
$node = (Get-Command node.exe).Source
.\scripts\build-webview-desktop.ps1 -BundleCore -NodeExecutable $node
& .\artifacts\webview-desktop\AI积分网关.exe --contract-test "$env:TEMP\webview-contract.json"
```

构建结果位于 `artifacts/webview-desktop`，与原生构建输出分开。`-BundleCore` 必需，后端从当前干净源码树的 `bin/src/web/vendor` 固定清单打包，不读取作者桌面安装。品牌资源来自当前仓库 `desktop`；可选宿主共享实现固定为 `desktop/webview-shell/host/NativeDesktop.cs`，不是作者机器上的文件。该可选副本保留早期管理工具的内部帮助实现，Web 管理入口仍使用 Web 页；原生默认 `desktop/AiCreditDesktop.cs` 与 `desktop/build.ps1` 保持原字节。

构建会校验固定 SDK、Node 和 bootstrapper 哈希。若官方 bootstrapper 的移动下载链接返回新字节，构建会明确失败；维护者应单独审查更新来源、签名与 pin，不应跳过校验。可复现是指来源和依赖可核对、功能合同可重跑，不承诺 C# 编译时间戳或 ZIP 时间戳逐字节相同。

## 创建干净发行 ZIP

`OutputDirectory` 和 `ArchivePath` 必须选尚未存在的新路径，避免把首次运行后的个人数据当发行原件打包。先运行上面的构建命令准备与核验依赖，再运行：

```powershell
$repo = (Get-Location).Path
.\desktop\webview-shell\package-portable.ps1 `
  -CoreDirectory $repo -NodeExecutable $node `
  -OutputDirectory "$repo\artifacts\webview-release" `
  -ArchivePath "$repo\artifacts\AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip" `
  -DependencyDirectory "$repo\.cache\webview2"
```

脚本从固定清单重建发行目录，拒绝数据目录、个人配置、数据库和日志；生成逐文件 `checksums.sha256`，并生成 ZIP 的 `.sha256`。从发行页下载后，可用 `Get-FileHash -Algorithm SHA256 <ZIP>` 对照附件哈希。

## CI 与版本选择

`Backend checks` 保持既有后端和原生检查；新增 `Optional WebView2 desktop` 在 Windows、Node 22.23.3 下运行路径测试、发行源清洁测试、HTTP mock 管理合同、独立构建和无窗口桥接合同，并提供临时构建产物。该流程不自动发布 Release，不登录平台、不执行真实签到或模型调用。

Web 桌面包使用独立预览标签 `v0.8.1-desktop-webview2.1`。既有 `v0.8.1` 和 `dsh-ai-credit-gateway-0.8.1.tgz` 保持原样；`.tgz` 是后端/npm 分发包，不是 Windows 桌面 ZIP。选择原生界面的用户继续使用原生构建入口。
