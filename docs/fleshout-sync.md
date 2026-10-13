# FleshOut 托管模型同步

脚本 `scripts/fleshout-sync.mjs` 默认只输出 dry-run。需要 Node 支持 `node:sqlite` 的 DatabaseSync 与 online backup。

```powershell
node scripts/fleshout-sync.mjs --db "PATH/fleshout.db" --catalog "PATH/live-models.json" --prune-stale
# 检查输出后，使用该 fingerprint 明确提交：
node scripts/fleshout-sync.mjs --db "PATH/fleshout.db" --catalog "PATH/live-models.json" --prune-stale --apply --expected-fingerprint FINGERPRINT --backup-dir "PRIVATE/backup"
node --test tests/fleshout-sync.test.mjs
```

目录 JSON 是真实 `/v1/models` 返回值（data 数组），不是手写历史路线表。目录为空或ID重复会拒绝处理。

## 变更规则

- 仅修改 ID 前缀 `aigw-`、provider `custom`、base_url 精确 `http://127.0.0.1:19421/v1` 三者同时成立的行。
- 输出预算只按目录中正整数 maxTokens 下调，不擅自调高。
- 默认不删除；显式 `--prune-stale` 才删除不在目录中的托管行。被 app_config 引用的默认模型保持。
- 不新增模型，不重新启用网关已停用路线，不修改外部用户模型、默认设置或作品。
- apply 前使用 SQLite online backup；backup quick_check 与内容指纹必须通过。
- BEGIN IMMEDIATE 后再次核对模型/配置指纹；用户并发改动时回滚整笔事务。
- 私有备份含 API Key，禁止上传仓库或作为公开附件。

## 验证和回滚

对备份另作副本，校验 SHA-256 与 quick_check，确认副本模型/配置还原为变更前状态；这不修改正在运行的客户端。真正恢复需要客户端停止写入后再执行 SQLite 一致恢复，不向活动 WAL 库直接覆盖单独 db 文件。保留当前新配置时无需恢复。

数据库校验和网关 SSE 通过，与客户端“获取模型/测试连接”按钮成功是不同证据；GUI 功能必须在客户端中另行验证。
