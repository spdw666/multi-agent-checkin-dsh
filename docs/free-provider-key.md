# 免费平台：直接填写 API Key

免费平台窗口接受 API Key 本身。填写平台、账号 ID 和 Key 后提交；Cloudflare 还需要该账号的 32 位十六进制 Account ID。账号 ID 是本机配置名称，例如 `groq-main`。

网关自动保存凭据，管理配置仍保留文件引用：

```text
<ConfigStore.dataDir>/private/free-providers/<账号 ID>/credentials.json
```

旧版 `credentialFile` 的绝对路径接入继续保留。新窗口直接输入 Key，与旧文件引用是两种互斥的输入方式。

## 本地管理接口

`POST /admin/free-provider-add`，使用本机管理端的 Admin Bearer Key。该凭据输入接口仅接收 loopback 请求。

```json
{
  "providerId": "groq",
  "id": "groq-main",
  "apiKey": "TOKEN",
  "models": ["MODEL_ID"]
}
```

Cloudflare 示例：

```json
{
  "providerId": "cloudflare",
  "id": "cloudflare-main",
  "apiKey": "TOKEN",
  "accountId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "models": []
}
```

Cloudflare 的令牌和 Account ID 对应其[官方 REST 接入说明](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)。示例里的 `TOKEN` 和 Account ID 是占位符。

兼容旧请求：

```json
{
  "providerId": "groq",
  "id": "groq-legacy",
  "credentialFile": "D:/AI-Keys/groq.json"
}
```

## 保存与状态

- 输入 Key 后，程序创建账号隔离私有目录；配置中没有内联 API Key。
- 程序验证账号 ID、重复账号／上游、字段白名单、Key 长度／控制字符、模型 ID 和 Cloudflare Account ID，然后创建文件。
- Key 上限 16,384 字符；非空 Key 使用可打印 ASCII，无内部空格、换行或控制字节。首尾普通空格会裁掉。
- 账号 ID 使用 1–80 位字母、数字、下划线或连字符；Windows 保留设备名被排除。
- Key 为空时，有 Key 要求的平台保持待配置；目录明确支持匿名调用的平台按其实际目录验证结果保存。
- 目录验证成功仅证明目录与可导入容量满足条件。`credentialStatus=configured` 表示 Key 已录入，真实聊天鉴权状态由聊天结果记录。
- 401／403 鉴权失败时，私有文件保留，账号与上游停用，状态为 `rejected`；网络／目录失败时同样保持待配置，不标成已连通。
- 选中的模型必须在本次目录中可导入；验证失败、中途配置变化或配置提交失败时，新创建且仍由本次事务持有的凭据文件会清理。
- 已存在的凭据目录或文件不会覆盖；用户在事务期间编辑过的凭据也会保留。
- 配置已落盘但末尾重载失败时，提交队列内先核对磁盘是否仍恰等于本次拟提交配置；相等则原子恢复提交前原始配置字节，再清理新 Key。磁盘已被其他写者修改并仍引用新 Key，或恢复状态待确认时，配置与 Key 一起保留，并返回 `configuration_changed` 或 `configuration_recovery_required`，避免留下悬空引用。

## 文件事务与重试

私有文件以 `0600` 模式通过 `wx` 临时文件创建，完整写入与同步后使用硬链接原子发布；目标已存在时发布失败，不替换原件。临时文件随后移除，账号目录只留下 `credentials.json`。系统文件模式语义遵循 [Node.js 文件系统说明](https://nodejs.org/api/fs.html)。

远程目录发现发生在短配置提交队列之前，提交继续使用 `withConfigMutation` 与配置身份检查。一次新增只提交自身账号、上游和所选路由，原有路由与停用状态保留。

同模型冷却状态以 HTTP 503 或限流 429 返回有限非负的 `retryAfterSeconds` 时，响应包括数值字段与向上取整的 `Retry-After` 秒数；其他状态与非法值不追加该重试字段。

## 回归命令

```powershell
node --test --test-concurrency=1 --test-timeout=45000 tests/free-provider-key.test.mjs tests/free-providers.test.mjs tests/relay-activity-http.test.mjs
```

测试使用隔离临时 ConfigStore、真实本地 HTTP 端点和合成平台目录／聊天夹具。测试没有加载真实账号凭据，也没有发起平台生成。测试包含私有写盘、认证请求头、无回显／配置泄漏、失败事务、原件保留、并发冲突、独立事务回滚和 503 重试提示。
