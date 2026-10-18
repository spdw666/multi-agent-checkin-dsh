# 官方客户端版本监测与自动升级调研

当前已实现的是 **版本监测、状态缓存、启动入口和桌面快捷方式**；网关**不下载、不安装**官方客户端更新。检查版本与实际完成客户端升级、加载新运行时、模型协议兼容分别验收，不用一个“最新”状态覆盖全部层次。

## 1. 已实现的入口与操作

Windows 原生第八页 **软件更新** 显示软件、已装版本、最新版本、状态、来源、最后检查和说明。

| 操作 | 实际行为 |
|---|---|
| 刷新 | `GET /admin/client-updates`，读取服务账本缓存；不立刻重查官方源 |
| 立即检查 | `POST /admin/client-updates/check`，重新读取本机版本与官方来源；已有检查时共用同一服务内实际任务 |
| 自动检查 | 默认启用，默认每 24 小时一次；只在后台运行期间调度 |
| 双击行 / 打开所选 | 启动配置对应的客户端入口 |
| 右键菜单 | 打开软件、安装目录、官网、查看检测详情、复制安装路径，创建单个或全部桌面快捷方式 |

启动和快捷方式不是安装操作，不终止正在运行的 Agent 任务。客户端安装位置、版本来源和进程仍需按当前机器检查，目录里有文件不证明其正在运行。

## 2. 缓存、待重启和失败状态

报告提供 `status`、`startedAt`、`checkedAt`、`durationMs`、`nextCheckAt`、`summary` 与逐目标 `targets`；所有管理入口使用 `adminKey`，不回传凭据。`GET` 的缓存数据必须连同检查时间展示，服务重启后残留 `running` 记录不充当真实锁。

当前真正运行中的检查在服务内单飞，手动检查也不并发复制；取消等待和取消状态按实际结果保留。目标状态区分：

| 状态 | 解释 |
|---|---|
| `update_available` | 官方源返回较新版本，不代表已下载安装 |
| `current` | 本机读取版本与该官方通道当前返回一致，不代表进程已经重启或其他通道没有新包 |
| `ahead` | 本机版本高于当前官方源，保留撤回、灰度或源不同步等说明，不自动降级 |
| `not_detected` | 预期位置未读取到有效本机版本，不伪造已安装 |
| `no_source` | 没有可核对来源，不填猜测版本 |
| `error` / `cancelled` | 查询失败 / 已取消，保留错误或状态，不显示为已是最新 |
| `disabled` | 当前目标停用，不做该目标版本检查 |

**Qoder 待重启**：读取版本目录及其官方 ready 标记，返回 `pendingRestart:true` 时说明“已下载就绪，重启客户端后生效”。这不是从旧主程序壳版本猜测，也不声称现有进程已经加载该目录版本。相同原则适用于任何安装目录、下载状态与当前进程的区分。

版本比较保持稳定版/预发布语义；千问办公的数字渠道 build 后缀按该目标的明确策略比较，不把它作为所有产品的全局版本规则。官方来源低于本机时保留原始来源与说明，不把“官网最新”绝对化。

## 3. 来源与配置

各目标按当前适配读取官方更新 API、官方 feed、官方发布页、官方 GitHub Releases 或明确的客户端更新日志；本机版本来自对应 manifest、配置、ASAR、PE 版本或产品版本目录。国内版、国际版、桌面版和渠道版本分别查询，不混用一个产品名称下的不同发行物。

当前默认监测清单覆盖 WorkBuddy/WorkBuddy AI、CodeBuddy 国内/国际、Qoder 国内/国际、Loomy、小浣熊、MiniMax Code、LobsterAI、OpenCode、Cline、Trae CN、ZCode、千问办公、CodeArts、Antigravity，以及作为调用端的 DSH；具体 ID 与来源以 [当前源码清单](../src/client-updates.mjs) 为准，不以一张历史截图代替当前来源。

有些客户端内置更新通道与当前适配使用的官方源不同，说明列保留差异，不能只靠客户端窗口的一次“最新”判断。来源 URL、最后检查、可读本机路径与错误说明是诊断数据，不将个人标识或凭据发布到公开报告。

配置片段（合并而非覆盖现有配置）：

```json
{
  "clientUpdates": {
    "enabled": true,
    "intervalHours": 24,
    "timeoutMs": 15000,
    "targets": {"SAMPLE":{"enabled":false}}
  }
}
```

`intervalHours` 支持 1–720，`timeoutMs` 支持 1000–120000。`SAMPLE` 替换为清单中真实目标 ID；目标可单独停用。高级来源覆盖只接受当前校验支持的字段和类型，先核对源码及当前官方来源，不借此把任意安装文件当官方稳定更新。

## 4. 自动下载安装仍是调研，不是启用功能

下面保留自动升级的设计条件与官方参考；当前没有自动下载安装任务。WinGet ID 是集成候选，不保证当前包版本与厂商最新发布一致。

| 软件 | WinGet 候选 ID |
|---|---|
| WorkBuddy | `Tencent.WorkBuddy` |
| TRAE CN | `ByteDance.Trae.CN` |
| TraeWork CN | `ByteDance.TraeWork.CN` |
| MiniMax | `MiniMax.MiniMaxCode` |
| QwenWork CN | `Alibaba.QwenWork.CN` |
| ZCode | `ZhipuAI.ZCode` |

将来接入自动安装前，仍需逐目标验证：

1. 优先官方稳定更新源；精确 WinGet ID 仅作核验后的备选，不因社区清单滞后而降级。
2. 核对产品、版本、地区、架构、安装范围、官方 URL、manifest hash 与 Windows 签名；不从未知来源执行安装包。
3. 先下载，运行中客户端延后安装；不强制结束 Agent、对话或网关流。
4. 串行安装并复查真正已装版本；保留原安装位置、账号数据与独立回滚，不把协议兼容性默认为成立。
5. 产品迁移（例如 TraeWork 到 TRAE）与同产品升级分开，Windows/DSH 重启不并入客户端升级动作。

仅供未来集成评估的官方命令形状，不是网关已经运行的定时任务：

```powershell
winget upgrade --id Tencent.WorkBuddy --exact --source winget --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
```

不使用无差别 `upgrade --all`、强制降级、未知版本强升或绕过包哈希核验来替代逐目标验收。

## 5. 官方参考

- [Microsoft WinGet upgrade](https://learn.microsoft.com/en-us/windows/package-manager/winget/upgrade)
- [Microsoft Windows Package Manager manifests](https://github.com/microsoft/winget-pkgs)
- [Electron 更新机制](https://www.electronjs.org/docs/latest/tutorial/updates)
- [TRAE 官方产品迁移说明](https://docs.trae.cn/ide_traework-to-traecode-data-migration)
- 网关实现：[客户端版本监测](../src/client-updates.mjs)、[管理 API](../src/server.mjs)、[原生界面](../desktop/AiCreditDesktop.cs)。

本文不固定当前厂商版本号、不包含本机安装快照或个人路径，也不把一次监测结果当永久维护保证。
