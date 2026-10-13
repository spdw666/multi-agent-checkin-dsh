# 接入其他 OpenAI 兼容客户端

网关对外只有一条 OpenAI 兼容入口（`http://127.0.0.1:19421/v1`）。**任何支持自定义 OpenAI 端点的客户端都可以直接接入，本仓库不需要为它写适配器**：

```text
第三方客户端 → http://127.0.0.1:19421/v1 → 已启用的平台路由
```

方向只有一个：**客户端填本网关的地址**。网关不反向代理、不抓取、不注入任何客户端进程，因此不需要改客户端可执行文件或前端资源，也不恢复已移除的 relay / 第三方中转站配置类型。

## 通用三要素

任何客户端接进来都只需要三个值：

| 字段 | 取值 |
|---|---|
| Base URL / Endpoint | `http://127.0.0.1:19421/v1` |
| API Key | `data/api-keys.json` 里的 **`apiKey`**（推理用；`adminKey` 只管管理 API） |
| Model | `GET /v1/models` 返回的**路由 ID**，原样照抄，包含斜杠 |

模型 ID 形如 `upstreamId/model`（例如 `workbuddy/deepseek-v4.1-flash`），不是上游裸模型名。客户端若把模型 ID 当路径或做 URL 编码处理，先确认它能原样传输。

## 本机实测案例：FleshOut（Tauri 桌面写作软件）

FleshOut 是第三方 Tauri 2.x + Rust 桌面应用，自带 OpenAI 兼容自定义端点，可直接使用本网关。它的模型配置存在自己的 SQLite 里，与网关配置彼此独立。

### 数据形状

FleshOut 的模型表字段为 camelCase，数据库列名为 snake_case：

| 字段 | 语义 |
|---|---|
| `provider` | `ollama` 或 `custom`；接本网关用 **`custom`** |
| `baseUrl` / `base_url` | 本网关地址，必须含 `/v1` |
| `apiKey` / `api_key` | 网关 `apiKey` |
| `model` | 网关路由 ID |
| `temperature` | 客户端采样温度 |
| `maxTokens` / `max_tokens` | **输出上限，必须按上游分档，见下** |
| `timeout` | 请求超时，单位**秒** |

### 一个必须注意的坑：`max_tokens` 要按模型分档

客户端默认值往往很大。FleshOut 默认 `maxTokens: 128000`，直接使用会让部分上游返回：

```json
{"error":{"message":"NVIDIA 最大输出参数超过该模型输出配置上限","type":"nvidia_max_tokens_invalid"}}
```

本机实例观测到的可用档位（**属于实例实测，不是全平台保证**）：

| 上游 | 可用 `max_tokens` | 观测 |
|---|---|---|
| NVIDIA `z-ai/glm-5.3`、`z-ai/glm-5.3-flash`、`moonshotai/kimi-k3` | **1024** | 4096 / 2048 均返回 `nvidia_max_tokens_invalid` |
| Trae 两条托管路由 | 4096 | 当前实时目录输出上限；旧8192配置应下调 |
| 其余路由 | 按当前 `/v1/models` 的 `maxTokens` | 不从另一平台档位推断 |

配置新客户端时先按保守值起步，再按实测放宽；上游拒绝会以明确错误返回，不会静默截断。

### 配置方式

**推荐：用客户端界面。** 在模型管理里新增一条 `Custom` 连接，填上面三要素即可；界面里通常还有"获取模型"与"测试连接"两个按钮，先点它们确认再保存。

**备选：直接写客户端数据库。** 当界面缺少选项时，可把同样的行写入客户端自己的模型表，并让它指向网关。要点：

1. **先关闭该客户端**，或确认其数据库使用了 WAL 且允许并发写；同一份 SQLite 被两个进程同时写会锁库。
2. 使用 SQLite online backup 取得一致快照，执行 quick_check 并记录 SHA-256。运行中的 WAL 库不靠逐个复制三件套保证一致。备份包含 API Key，放私有目录。
3. 使用事务与状态指纹复检，仅变更明确托管行，保留用户自定义模型、默认模型及写作数据。
4. 写完核对数据库及客户端列表；客户端若缓存模型清单，重新打开模型设置进行刷新。

本仓库提供默认 dry-run 的 `scripts/fleshout-sync.mjs`，精确识别 `aigw-` ID、custom provider、网关 Base URL 三项同时匹配的行；只下调超限输出，显式 `--prune-stale` 才移除停用托管行，默认模型引用保持。详见 [FleshOut 同步工具](fleshout-sync.md)。

### 验证顺序

1. `GET /v1/models`（带 `Authorization: Bearer <apiKey>`）返回路由清单。
2. 客户端"测试连接"返回成功与延迟。
3. 发一条普通短请求，确认返回内容而非错误。
4. 再跑一次真实任务（长文 / 多轮 / 客户端自己的流式路径）。

### 边界与已知限制

- 网关需保持运行；客户端不会自动拉起网关。
- 客户端"逐字回显极短 token"这类非常规任务，个别上游可能只返回前缀（内容落在推理字段里），换正常问句即恢复——这是上游输出行为，不是网关故障。
- Antigravity 路由依赖上游地区判定；出口地区不被接受时返回 `antigravity_region_unsupported`，与其他接入方式一致。
- 各客户端的功能细节（是否支持流式、模型列表如何解析）由客户端自身实现决定，本仓库不代为保证。

## 已接入的客户端

| 客户端 | 接入方式 | 文档 |
|---|---|---|
| DSH | bundle + 独立 worker | [docs/dsh.md](dsh.md) |
| Hermes | 命名自定义 Provider | [docs/hermes.md](hermes.md) |
| FleshOut 等其他 OpenAI 兼容客户端 | 填本网关 Base URL | 本文 |
