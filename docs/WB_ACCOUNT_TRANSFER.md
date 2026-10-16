# WB 账号添加、JSON/ZIP 导入与导出

本手册描述账号**交换文件**，与模型路由页“导出选中”（取消模型导入）是不同操作。所有接口使用本机 `adminKey`；导入/导出仅处理保存账号数据，不执行登录续期、模型生成、签到、任务或客户端切换。

## 界面入口

打开 **wb帐号池**，顶部固定有 **导入账号**、**导出账号**、**轮换设置**。每号 **更多操作** 提供 **修改名称 / 备注** 和 **导出此号**；固定的 **停用该账号 / 启用该账号** 继续只控制积分调用。

导入对话框支持多文件、逐条勾选、全选有效项和清空，默认跳过已有；勾选 **替换重复账号的登录凭据** 后重新预览。无效项或零选择不提交。导出可选择当前浏览账号、全部或多选账号，并选择兼容 JSON、ZIP 或 workbuddy-switch JSON，保存到系统对话框指定路径。

## 从哪里添加账号

| 方式 | 适用场景 | 结果 |
|---|---|---|
| 添加登录 | 通过官方国内/国际版授权 | 保存新的独立登录快照 |
| 保存客户端当前账号 | 官方 WorkBuddy 已经登录 | 捕获当前主体，重复主体合并 |
| 导入 JSON / ZIP | 从已有本机账号备份迁入 | 先预览，再按选择与去重策略提交 |
| 修改显示名 / 备注 | 整理已经保存的账号 | 只更新网关本机展示，不改 UID/地区/登录 |

每次导入保持已有账号和路由。新增账号建立独立 `dataDir/accounts/ACCOUNT/workbuddy-session.json` 与 WorkBuddy 上游；已有自动维护池可收纳同版本新账号，手动池、明确关闭的池和路由启停状态保持原样。导入成功不等于官方登录仍有效，后续以定向余额/身份核验结果为准。

## JSON 形状

默认兼容 JSON 的账号对象分为 `account`（身份）、`auth`（登录态）和可选 `gateway`（本地整理信息）。另支持 workbuddy-switch 原始明文账号数组，详见下节。最小交换示例全部为 SAMPLE；实际文件只保存在本机：

```json
{
  "account": {
    "uid": "SAMPLE_UID",
    "enterpriseId": "SAMPLE_ENTERPRISE",
    "nickname": "SAMPLE 工作账号"
  },
  "auth": {
    "accessToken": "SAMPLE_ACCESS_TOKEN",
    "refreshToken": "SAMPLE_REFRESH_TOKEN",
    "expiresAt": 1893456000000,
    "domain": "www.workbuddy.cn"
  },
  "gateway": {
    "label": "SAMPLE 国内工作号",
    "notes": "SAMPLE 备注",
    "inferenceEnabled": true
  }
}
```

- 顶层可为单个账号对象、账号对象数组，或 `{ "schemaVersion": 1, "format": "workbuddy-auths", "accounts": [...] }`。
- `uid` 是去重身份，`enterpriseId` / `nickname` 是资料；网关账号 ID 由稳定槽位维护，不直接信任文件名作为 ID。
- `accessToken` / `refreshToken` 为非空明文字符串；凭据内容不出现在预览、普通 summary/details 或错误日志中。
- `expiresAt` 接受秒或毫秒时间戳，导出统一毫秒；过期与字段缺失分开展示。
- `domain` 使用已知官方 WorkBuddy/CodeBuddy 的国内/国际域名，不接受任意自建服务 URL。国内与国际同 UID 仍为不同账号身份。
- `gateway` 保留本机显示名、备注及积分调用开关，不是官方账号资料。`label` 最多 128 字符，`notes` 最多 2000 字符；账号备注与路由 ID 分开。

### workbuddy-switch 原始 JSON 数组

导入也接受原项目的明文扁平账号数组，导出选择 `format:"switch-json"`。这与默认 `json` 里的嵌套 `auth` 是两种明确格式：

```json
[
  {
    "id": "SAMPLE_EXPORT_ID",
    "uid": "SAMPLE_UID",
    "nickname": "SAMPLE 工作号",
    "access_token": "SAMPLE_ACCESS_TOKEN",
    "refresh_token": "SAMPLE_REFRESH_TOKEN",
    "expiresAt": 1893456000000,
    "domain": "www.workbuddy.cn",
    "variant": "cn",
    "note": "SAMPLE 本地备注"
  }
]
```

`variant` 为 `cn` / `ai`，需与显式官方 `domain` 一致；flat 文件省略域名时，`ai` 使用 `www.workbuddy.ai`，其它缺省国内版使用 `www.codebuddy.cn`。文件的旧 `id` 不覆盖网关现有稳定槽位。`note` 是本地备注，不作为官方身份。明文 token 优先取顶层 `access_token` / `refresh_token`；缺失才从对象 `auth_raw.auth` 或 `auth_raw` 读取，并保留其原始对象于本机凭据快照。文件中的 `$wbEncrypted` 信封或 `enc:v1` 机器绑定密文返回 `wb_import_encrypted_token`，不将其当有效明文 token，更不从密文伪造登录。

原项目 `displayField` 属于其界面显示策略；网关用自己的 `label` / `notes`，其它参考应用状态不按整对象覆盖。完整来源与互通边界见[功能对照](WB_SWITCH_COMPARISON.md)。

## ZIP 形状与边界

ZIP 包含逐账号 JSON，如 `workbuddy-001.json`、`workbuddy-002.json`，可附 `_manifest.tsv` 清单。后端只在内存读取允许条目，检查路径、压缩法、CRC、大小与数量；不会把压缩包中的任意路径展开到磁盘或运行其中内容。

| 限制 | 上限 |
|---|---:|
| 账号导入 HTTP 包装正文 | 16 MiB（base64 / JSON 转义包装余量；仅导入入口） |
| 一次输入文件总字节 | 4 MiB |
| 单个 JSON | 256 KiB |
| 解压总字节 | 16 MiB |
| 文件数 | 32 |
| ZIP 条目 | 256 |
| 一次账号数 | 128 |

其他管理入口仍为 4 MiB。16 MiB 只容纳导入时的 base64 与 JSON 转义包装，并不把原始文件总大小放大：解码后输入文件合计仍严格限制 4 MiB，单 JSON、解压量与账号数量也独立校验。

支持 ZIP stored/deflate，文件名不是身份依据。拆分大包时保持相同预览→提交流程。ZIP 的 base64 只是 HTTP 传输编码，导出文件仍包含登录数据，应像本机凭据备份一样单独保存，不放公共源码、Issue 或发布附件。

## 预览、选择与重复策略

1. 选择一个或多个 JSON/ZIP，先提交预览。
2. 检查版本、UID、到期、校验错误及重复状态；预览不修改配置、不续期、不生成。
3. 选择索引和 `skip` / `replace`；默认 `skip`。
4. 提交时服务端重新解析并核对当前账号，不把旧预览当作写入权限。
5. 检查最终 `saved`、`imported`、`replaced`、`skipped`、逐账号结果及 `backupId`。

重复身份为 `edition + uid`。文件内重复不会无限追加账号。`skip` 保留已有登录态；`replace` 更新对应主体的凭据快照，保留现有账号 ID、显示名、备注、整体启用、积分调用开关、任务、路由与池策略。新账号默认启用每日签到任务与整体账号；网关自身导出携带的 `inferenceEnabled:false` 可在新账号还原时继续保留。

显式选择用 `selectedIndexes:[0,1]`，空选择作为输入错误；选中索引必须来自本次预览且不重复。校验问题在写入前返回；实际写入前保存私密配置和被替换凭据，并再次比对当前原件。失败只恢复本次仍归属本操作的写入；若外部客户端已续期/修改同一凭据则保留较新的文件，报告未完整还原，不把部分保存显示成成功。

## API

### 预览

```http
POST /admin/workbuddy/accounts/import/preview
Authorization: Bearer TOKEN
Content-Type: application/json
```

```json
{
  "files": [
    {
      "format": "json",
      "name": "SAMPLE.json",
      "content": "{\"account\":{\"uid\":\"SAMPLE_UID\"},\"auth\":{\"accessToken\":\"SAMPLE_ACCESS_TOKEN\",\"refreshToken\":\"SAMPLE_REFRESH_TOKEN\",\"expiresAt\":1893456000000,\"domain\":\"www.workbuddy.cn\"}}"
    }
  ],
  "duplicatePolicy": "skip"
}
```

ZIP 的 `content` 为原 ZIP 字节 base64；单文件也接受 `{format,content}`。预览响应给 `preview`、`valid`、`count`、`entries`、`errors`、`tokenReturned:false`。`valid:false` 是校验结果，不是已导入。

### 提交

`POST /admin/workbuddy/accounts/import/commit`，发送同一份 `files`，另可加 `selectedIndexes` 和 `duplicatePolicy`。普通回执不含 token，含 `desktopLoginChanged:false` / `routesEnabledChanged:false`；这些字段只说明本操作没有切桌面或改变路由启停，不代表账号已经完成真实调用。

### 导出

```http
POST /admin/workbuddy/accounts/export
Authorization: Bearer TOKEN
Content-Type: application/json
```

```json
{"accountIds":["ACCOUNT"],"format":"json"}
```

`format` 可为 `json`（默认兼容形状）、`zip`（逐账号 JSON）或 `switch-json`（参考项目扁平数组），响应为 `{exported:true,filename,contentType,encoding:"base64",content,count}`。客户端根据响应把 `content` 解码保存到用户选择的路径，不把完整响应打印在终端。`accountIds` 为明确的已保存 WB 账号；导出不临时访问上游刷新登录，不把其他平台加入 WB 包。

JSON / switch-json 导出的单文件同样限制 256 KiB，保证能直接重新导入；较多账号选择 ZIP 或分批导出。ZIP 合计最多 4 MiB，每个账号 JSON 仍最多 256 KiB。导出前按实际编码字节检查，不以账号个数替代容量核验。

PowerShell 保存方式（从本机私密文件取管理密钥，不把结果正文输出）：

```powershell
$base = 'http://127.0.0.1:19421'
$keys = Get-Content 'C:\Gateway\datapi-keys.json' -Raw | ConvertFrom-Json
$headers = @{Authorization = 'Bearer ' + $keys.adminKey}
$body = @{accountIds=@('ACCOUNT'); format='zip'} | ConvertTo-Json
$result = Invoke-RestMethod "$base/admin/workbuddy/accounts/export" `
  -Method Post -Headers $headers -ContentType 'application/json' -Body $body
[IO.File]::WriteAllBytes('C:\Gateway-Backups\wb-accounts.zip', [Convert]::FromBase64String($result.content))
```

路径目录需先建立。`ACCOUNT` 换成实际本机槽位；接口账号选择不是客户端 UID，按 summary 的 `accountId` 使用。

### 显示名与备注

`POST /admin/workbuddy/accounts/ACCOUNT/profile`，body 为 `{"label":"SAMPLE 工作号","notes":"SAMPLE 备注"}`。只发送需要更改的字段，清空备注发送 `""`；回执确认保存后再更新界面。它不重绑官方主体、不改变登录、不重命名路由、不触发任务。

## 数据与核验

| 结果 / 错误码 | 含义与后续动作 |
|---|---|
| `wb_import_encrypted_token` | 机器绑定密文，需原客户端重新保存可读登录态，不作为明文导入 |
| `wb_import_config_changed`（409） | 准备期间实际配置已改变，保留较新配置，重读后重新预览/提交 |
| `wb_import_source_changed`（409） | 同一凭据文件已被外部更新，保留新登录态，重新核对后提交 |
| `wb_import_rollback_incomplete`（500） | 回退遇到外部变更或写入问题，保留新文件和私密原件备份，按回执核对，不显示成功 |
| `wb_export_size_limit` | 导出超过可重导容量，改选 ZIP 或拆分账号批次 |

- 导入备份在实际 `dataDir/account-transfer-backups/`，包含私密原件，只留本机。
- 导出文件含登录数据，而仓库中的格式示例只含 SAMPLE；常规管理接口继续隐藏 token。
- 格式校验 → 保存 → 主体/余额刷新 → 真实推理 → 官方客户端切号是独立步骤；前一步成功不冒充后一步已完成。
- 回滚先在独立副本核对备份对应的账号/配置，保留更新后新增历史，再恢复相关文件；不要整目录覆盖其他同期变更。
- 与自动轮换的关系见 [WB 轮换](WB_ROTATION.md)；暂停积分调用与签到/任务的关系见 [WB 帐号池](wb-account-pool.md)。
