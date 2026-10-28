# AI 积分网关 · Web 工作台便携版

**界面版本：0.8.1-web.1；网关后端：0.8.1；内置 Node.js：22.23.3，Windows x64。**

这是独立 WebView2 桌面界面发行包，不表示后端升级。它与原 WinForms 版分开运行，不替换原生版、不改原生版快捷方式和配置。

## 下载后开始使用

1. 将 ZIP **完整解压**到本机可写文件夹；支持中文和空格路径。不要直接在 ZIP 预览中运行，也不要只复制 EXE。
2. 双击 **AI积分网关.exe**，或双击 **启动新版工作台.cmd**。无需安装 Node.js、npm，也无需运行构建命令。
3. 首次运行会创建独立的 `user-data`，启动内置后台，显示空账号工作台。软件不会自动导入其他程序的登录、签到、测试模型或启用计划任务。
4. 从“管理工具 → 账号管理”添加账号；WorkBuddy 登录/保存当前登录/导入备份均须主动点击并确认。已有官方客户端登录不会在首启时自动导入。

首次配置默认 `server.port=0`，由 Windows 分配空闲的本机回环端口，避免与其他网关争用固定端口。当前实际地址由界面后台状态和 `user-data/data/runtime.json` 提供。初始系统分配的端口在重启后可能变化；要长期接入 DSH/Hermes 等外部客户端，先在“业务偏好”设置一个未占用的固定端口，重启本便携版后台后，再配置外部客户端。

## 运行环境

- Windows 10/11 **x64**，.NET Framework **4.8 或更新版本**。
- 需要 Microsoft **WebView2 Evergreen Runtime**，不是仅有 Edge 浏览器就一定齐备。
- 已有 Runtime 时直接使用，不下载、不重装。缺 Runtime 时，窗口会显示 Microsoft 官方下载入口，以及随包附带的 Microsoft 签名 Evergreen bootstrapper 按钮。用户点击后才启动安装；安装后可点击“安装后重新检测”。bootstrapper 安装需要网络。
- 官方 WebView2 下载：https://developer.microsoft.com/microsoft-edge/webview2/#download-section
- 官方 .NET 4.8 下载：https://dotnet.microsoft.com/download/dotnet-framework/net48
- 支持环境依据 Microsoft 文档；本发行验收在已有 .NET/WebView2 的 Windows 主机完成，不把它表述为“全新 Windows 虚拟机安装已验收”。
- 特定平台的官方客户端、账号权益、可选 Python 或第三方客户端工具，仍由所选集成决定；未配置的平台不会自动运行。

## 工作区

四个主工作区：总览、平台目录、模型路由、任务记录。

八个管理内页：账号管理、路由配置、领取记录、业务偏好、请求诊断、WorkBuddy 账号池、软件更新、运行中心。管理操作在同一 Web 窗口中完成，不唤起旧 WinForms 总览。刷新、签到、修改配置、导入导出、切换账号、停止后台等动作须由用户发起；失败不会自动重放写操作。

软件更新页负责检测版本，并可打开检测到的客户端或创建其快捷方式；它不提供自动下载/安装客户端升级。

## 数据、后台与退出

- 默认配置：`user-data/config.local.json`；后台数据：`user-data/data`；WebView 资料：`user-data/webview-profile`；界面位置：`user-data/window-bounds.json`；运行记忆：`user-data/memory`。
- 如果解压目录不可写，程序会使用 `%LOCALAPPDATA%/AiCreditGatewayWebPortable/<该解压目录的身份哈希>`，仍与原生版数据分开。
- 首启配置为空、定时任务关闭、启动签到关闭、自动积分任务关闭；后台密钥在本机首次运行时新生成，下载包不含账号或密钥。
- 顶部关闭按钮将窗口收至托盘；托盘“退出窗口，后台继续”只退出 UI。底部“暂停后台”在确认后停止**本便携版**后台；“启动后台”重新启动它。
- 删除前先暂停本便携版后台、退出 UI，再备份需要的 `user-data`。不要把含个人 `user-data` 的使用后文件夹重新公开发布。
- 可选运行 `创建桌面快捷方式.ps1`，创建名为“AI积分网关 Web工作台”的快捷方式，保留原生版快捷方式。

## 核对与高级启动

`checksums.sha256` 列出原始发行文件哈希；首次运行产生的个人数据不在清单中。`prerequisites/PROVENANCE.json` 记录 Microsoft bootstrapper 来源、签名和哈希；Node.js 哈希与官方 SHASUMS 一致，第三方许可位于 `licenses` 和 `core/vendor`。

```powershell
# 后台启动 UI，不抢占当前桌面
.\AI积分网关.exe --background
# 请求当前实例只读切到 WorkBuddy 内页，并输出 DOM/截图证据
.\AI积分网关.exe --instance-page manage-workbuddy --instance-evidence "D:\EVIDENCE\workbuddy.json"
# 只退出本包 UI，后台继续
.\AI积分网关.exe --quit-ui
# 自动界面验收需先正常启动本包后台；不会签到、登录或测试模型
.\AI积分网关.exe --self-test "D:\EVIDENCE\selftest.json" --width 800 --height 650
```

源码构建使用仓库的 WebView 专用构建入口；下载本 ZIP 的普通使用者无需构建。
