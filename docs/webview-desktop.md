# WebView2 工作台：下载、运行与源码构建

[返回主页](../README.md) · [完整使用手册](getting-started.md) · [发行隐私与证据范围](release-privacy.md)

## 版本与下载

| 项目 | 本发行 |
|---|---|
| UI / 后端 / Node | `0.8.1-web.1` / `0.8.1` / 官方 `22.23.3 x64` |
| 标签与类型 | [`v0.8.1-desktop-webview2.1`](https://github.com/spdw666/multi-agent-checkin-dsh/releases/tag/v0.8.1-desktop-webview2.1)，独立预览发行 |
| ZIP | [`AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip`](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip) |
| 大小 | **43,568,706 字节** |
| ZIP SHA-256 | `a2693c8492622689962bdef87787e74560fa6ea1911090f8d66acd0b702cf81d` |
| 附件 | [SHA256SUMS](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/SHA256SUMS)、[ZIP.sha256](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip.sha256)、[BUILD-INFO.json](https://github.com/spdw666/multi-agent-checkin-dsh/releases/download/v0.8.1-desktop-webview2.1/BUILD-INFO.json) |

```powershell
Get-FileHash -Algorithm SHA256 .\AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip
```

先比对附件名和完整 hash，再解压。ZIP 内 `checksums.sha256` 列出原始发行文件；首次运行生成的个人数据不在发行清单内。旧 `v0.8.1` 的 `dsh-ai-credit-gateway-0.8.1.tgz` 是后端/npm 资产，不是 Windows 桌面包。

后端基于公开 0.8.1，加通用运行记忆目录与通用剪贴板用户名路径识别的便携适配。Web UI 独立增加，不表述成后端新版本。`desktop/build.ps1` 和 `desktop/AiCreditDesktop.cs` 继续作为默认 WinForms 构建入口；本包不替换原生配置或快捷方式。

## 下载后开始

1. **完整解压**到自己的文件夹，不从 ZIP 预览中运行，不只复制 EXE。
2. 双击 **AI积分网关.exe**，或 **启动新版工作台.cmd**。普通使用者不需要安装 Node.js/npm。
3. 首启自动建立独立后台和空账号工作台。自己完成官方登录、添加账号或导入自己的备份，再按需配置路由与排程。

首次账号、上游和路由为空；计划任务、启动签到与自动积分任务关闭。不自动读取其他安装实例的配置/登录，不自动续期、领取、测试模型或执行任务。账号有效性和权益分别以官方响应核对。

## 运行环境与 Runtime

- Windows **10/11 x64**；.NET Framework **4.8 或更新版本**。
- **WebView2 Evergreen Runtime**，不是把普通 Edge 浏览器当运行时。
- 已有 Runtime 时直接使用；缺少时显示 Microsoft 官方下载与随包 bootstrapper 入口，由用户主动点击安装，再重新检测。bootstrapper 安装需要网络。
- [微软 WebView2 Runtime 下载](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section)、[运行时分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[.NET 4.8 下载](https://dotnet.microsoft.com/download/dotnet-framework/net48)。

bootstrapper 有官方来源、固定 SHA-256 和 Microsoft 签名核验，资料在 `prerequisites/PROVENANCE.json`。它不是完整离线 Runtime；“包内有 bootstrapper”不等于离线安装已准备齐备。平台特有客户端、账号权益与可选 Python/第三方桥，仍按对应集成准备。

## 十二个页面与操作方式

四个主视图：总览、平台与账号、模型路由、任务记录。八个管理内页：账号管理、路由配置、领取记录、业务偏好、请求诊断、WorkBuddy 账号池、软件更新、运行中心。

使用搜索、目录与常驻账号详情浏览状态；键盘选择与命令面板用于定位入口。管理页留在同一 Web 窗口，后台只接收固定 typed 动作；系统保存对话框、官方登录页等由宿主处理。页面打开或只读重连不会自动执行写操作。

WB 导入先预览真实条目，再选择和确认；取消确认可返回预览，明确放弃或成功导入后清理保留输入；不确定结果先核对回执，不自动再次提交。账号导出包含登录快照；模型页“导出选中模型”实际是移出发布路由，二者分开。

## 端口、数据与生命周期

### 地址与长期接入

首启 `server.host=127.0.0.1`、`server.port=0`，由系统选空闲回环端口，避免争用其他实例固定端口。界面状态和本实例 `user-data/data/runtime.json` 提供实际地址。

**系统分配端口在重启后可能变化。**长期接入 DSH/Hermes 等外部客户端时，先在“业务偏好”设置未占用的固定端口，重启本便携版后台，再配置调用端 `/v1` 地址、模型密钥和完整路由 ID。

### 私有工作目录

| 文件 / 目录 | 用途 |
|---|---|
| `user-data/config.local.json` | 本实例配置 |
| `user-data/data` | 后台密钥、账号快照、账本、runtime、日志等 |
| `user-data/webview-profile` | WebView 资料 |
| `user-data/window-bounds.json` | 窗口状态 |
| `user-data/memory` | 本实例运行记忆 |

如果解压目录不可写，使用 `%LOCALAPPDATA%/AiCreditGatewayWebPortable/<目录身份哈希>`，依旧与原生实例分开。移动目录可能改变该后备身份；迁移前先确认和备份真实数据位置。

### 隐藏、退出与停止

| 操作 | 结果 |
|---|---|
| 主窗口 X | 收到托盘，后台继续 |
| 托盘“退出窗口，后台继续” | 退出 UI，后台保留 |
| 底部“暂停后台” | 停止本便携实例后台，之后手动启动 |
| 停止后台并退出 | 请求停止本实例后退出，按操作自己的收尾规则处理 |

可用 `创建桌面快捷方式.ps1` 创建独立的 Web 工作台快捷方式。更新或删除前先停本实例后台、退出 UI，备份实际 `user-data`；更新时保留个人数据，而不是用空模板覆盖。首次使用后的目录不作为公共原件再发布。

## 从干净源码构建

源码构建需要 Windows x64、Git、官方 **Node.js 22.23.3 x64** 与本机 .NET Framework C# 编译环境。固定 WebView2 SDK 为 **1.0.4314.35**，首次构建从 NuGet 获取并校验 package/DLL hash；bootstrapper 从 Microsoft 下载并校验固定 hash 和签名。

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

`-BundleCore` 必需。输出位于 `artifacts/webview-desktop`，依赖缓存与原生输出分开。后端由当前源码 `bin/src/web/vendor` 的固定运行文件清单产生，不读取个人安装或配置；品牌素材来自仓库 `desktop`。

可选宿主共享源码明确使用 `desktop/webview-shell/host/NativeDesktop.cs`，与默认 WinForms 源码分开保留；其构建输入说明见[BUILD-INFO.md](../desktop/webview-shell/BUILD-INFO.md)。Git 换行、编译时间戳和 ZIP 时间戳会影响原始字节，不宣称跨机器编译 ZIP 逐字节相同；应核对来源、依赖 pin、输入与运行合同。

如果 Microsoft 的移动下载链接返回新 bootstrapper 字节，旧 pin 会使构建失败。维护者应审阅来源、签名和新 pin，不跳过校验。运行 Node、字体、WebView2 SDK 与可选组件的许可见包内 `licenses`、字体目录和[第三方声明](../THIRD_PARTY_NOTICES.md)。

## 创建干净发行 ZIP

先完成构建与依赖校验。输出目录和 ZIP 路径都选择尚不存在的新路径，避免覆盖或打包使用数据：

```powershell
$repo = (Get-Location).Path
.\desktop\webview-shell\package-portable.ps1 `
  -CoreDirectory $repo -NodeExecutable $node `
  -OutputDirectory "$repo\artifacts\webview-release" `
  -ArchivePath "$repo\artifacts\AiCreditGateway-WebView2-0.8.1-web.1-win-x64.zip" `
  -DependencyDirectory "$repo\.cache\webview2"
```

打包脚本从固定清单新建目录，检查禁止的数据/配置/日志，写入逐文件清单和 ZIP `.sha256`。脚本扫描与人工/独立隐私审查是两层证据；打包成功不自动等价于整个 Git 历史或所有旧附件均无个人状态。当前复核范围见[发行隐私说明](release-privacy.md)。

## 已验范围与预览状态

| 验证层 | 本版证据含义 |
|---|---|
| 源码与合同 | 路径、typed 管理、导入选择/真实 DTO/生命周期等离线回归；不是官方服务实测 |
| Windows 构建与宿主 | SDK/Node/bootstrapper pin，宿主桥合同与 Web 页读取 |
| 便携首次运行 | 已有 .NET/WebView2 的 Windows 上，中文/空格路径空账号首启、实例身份、端口/profile隔离和退出生命周期 |
| 公共 CI | 后端/原生与可选 Web 两套流程；不替你执行登录、领取和模型生成 |
| 未覆盖为通用结论 | 缺 Runtime 的全新 Windows 虚拟机安装、所有平台/地区/套餐、所有模型与工具组合 |

官方登录、实际新奖励与客户端工具闭环依然要按具体目标验证。预览标签没有把这些未覆盖项改写成已通过。

## 启动排查

1. 确认 ZIP 完整 hash，完整解压，EXE、core、runtime 与 UI 文件在同一包内。
2. 核对 Windows x64、.NET 4.8 与实际 Runtime；缺 Runtime 按官方提示安装并重新检测。
3. 工作台为空时先添加自己的账号；确认没有误连另一个原生/源码实例。
4. 后台在线但客户端连接失败时，检查端口变化、`/v1`、模型 `apiKey` 与路由 ID；管理 `adminKey` 不填入模型客户端。
5. 账号/模型失败看错误码与回执，使用定向检查，避免把重新导入或反复生成当作修复。
6. 反馈仅附版本、脱敏错误码和复现步骤，不附账号包、完整 runtime/配置、个人 profile 或真实状态截图。
