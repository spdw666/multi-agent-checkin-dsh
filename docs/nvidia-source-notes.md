# NVIDIA 免费目录与官方接口依据

核对日期：2026-10-11。目录/文档核验与账号生成实测分别记录。

## 完整免费目录，不以 API 列表冒充免费列表

- [Build 免费筛选目录](https://build.nvidia.com/models?pageSize=96&filters=nimType%3Anim_type_preview) 当前 `resultTotal=38`；从页面 `self.__next_f.push` 的 `searchResult.results[].resources[]` 提取，按 publisher/name 去重，校验完整分页与免费标签。
- 免费依据是 `labels[nimType].values` 中的 `Free Endpoint`；聊天依据是 `playgroundType=chat`。分类不是按模型名字猜工具能力。
- [官方 API 目录](https://integrate.api.nvidia.com/v1/models) 本次 GET 为 80 项。与 Build 38 项合并后为 98 行，交集 20。API 独有的 60 行保留可见，但不自动标免费或导入。
- Build 38 项中聊天 17、非聊天 21；16 个聊天精确 ID 匹配 API，可导入；旧 Ising 1-35B 不匹配，保留待核验理由。16 中 13 声明工具能力；不要求先生成测试通过才显示/导入。
- `glm-5-3` 与 `glm-5-3-flash` 是 Build 路径；API 精确 ID 为 `z-ai/glm-5.3` 与 `z-ai/glm-5.3-flash`，以请求 schema 的 model.default 为准。

## 容量与能力

精确上下文来自各 Build 页内嵌 `specifications.contextLength`；工具能力来自 `modelCapability.functionCalling`；输出优先取请求 schema 中 `max_tokens.maximum`（包含 anyOf）。没有最大值但有官方 schema 默认值时，默认值仅作为本地配置上限，`officialMaxTokens:null`、`maxTokensSource:configured_default`，不称其为官方最大输出。未知上下文不造 32K。

| API 精确 ID | 上下文 | 本地输出配置 | 官方最大输出 | 工具 | 来源 |
|---|---:|---:|---:|---|---|
| `deepseek-ai/deepseek-v4.1-flash` | 1048576 | 1048576 | 1048576 | 是 | [Build](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash/build) |
| `z-ai/glm-5.3` | 1048576 | 1024 | 未声明 | 是 | [Build](https://build.nvidia.com/z-ai/glm-5-3/build) |
| `z-ai/glm-5.3-flash` | 1048576 | 1024 | 未声明 | 是 | [Build](https://build.nvidia.com/z-ai/glm-5-3-flash/build) |
| `moonshotai/kimi-k3` | 1048576 | 65536 | 65536 | 是 | [Build](https://build.nvidia.com/moonshotai/kimi-k3/build) |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 1048576 | 32768 | 32768 | 是 | [Build](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/build) |
| `meta/muse-glimmer-30b` | 131072 | 16384 | 16384 | 是 | [Build](https://build.nvidia.com/meta/muse-glimmer-30b/build) |
| `nvidia/ising-calibration-1.5-31b` | 262144 | 32768 | 32768 | 否/未声明 | [Build](https://build.nvidia.com/nvidia/ising-calibration-1.5-31b/build) |
| `poolside/laguna-xs-2.1` | 262144 | 16384 | 16384 | 是 | [Build](https://build.nvidia.com/poolside/laguna-xs-2.1/build) |
| `google/diffusiongemma-26b-a4b-it` | 262144 | 32768 | 32768 | 是 | [Build](https://build.nvidia.com/google/diffusiongemma-26b-a4b-it/build) |
| `nvidia/nemotron-3-ultra-550b-a55b` | 1048576 | 32768 | 32768 | 是 | [Build](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/build) |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 262144 | 65536 | 65536 | 是 | [Build](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/build) |
| `nvidia/ising-calibration-1-35b-a3b` | 待核验 | 待核验 | 未声明 | 否/未声明 | [Build](https://build.nvidia.com/nvidia/ising-calibration-1-35b-a3b/build) |
| `google/gemma-4-31b-it` | 262144 | 32768 | 32768 | 是 | [Build](https://build.nvidia.com/google/gemma-4-31b-it/build) / [推理参数](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer) |
| `nvidia/nemotron-3-super-120b-a12b` | 1048576 | 32768 | 32768 | 是 | [Build](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/build) / [推理参数](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer) |
| `openai/gpt-oss-20b` | 131072 | 4096 | 4096 | 是 | [Build](https://build.nvidia.com/openai/gpt-oss-20b/build) |
| `meta/llama-3.2-11b-vision-instruct` | 131072 | 8192 | 8192 | 否/未声明 | [Build](https://build.nvidia.com/meta/llama-3.2-11b-vision-instruct/build) |
| `meta/llama-3.2-90b-vision-instruct` | 131072 | 8192 | 8192 | 否/未声明 | [Build](https://build.nvidia.com/meta/llama-3.2-90b-vision-instruct/build) |

Super 的 1M 以 Build 结构精确值修正为 1,048,576；最大输出由官方推理参数给出 32,768。Gemma 4 的 Build 通用 schema 未列最大输出，但 [官方推理参数](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer) 给出 32,768。GLM 两型号明确标为保守配置 1,024，而非隐藏模型。

### 38 个免费端点分类

| Build 条目 / API ID | 分类 | 聊天 |
|---|---|---|
| [nvidia/kumo-tabular](https://build.nvidia.com/nvidia/kumo-tabular/build) | other | 否 |
| [nvidia/body-pose](https://build.nvidia.com/nvidia/body-pose/build) | video | 否 |
| [deepseek-ai/deepseek-v4.1-flash](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash/build) | chat | 是 |
| [nvidia/kumo-relational](https://build.nvidia.com/nvidia/kumo-relational/build) | other | 否 |
| [z-ai/glm-5.3](https://build.nvidia.com/z-ai/glm-5-3/build) | chat | 是 |
| [z-ai/glm-5.3-flash](https://build.nvidia.com/z-ai/glm-5-3-flash/build) | chat | 是 |
| [moonshotai/kimi-k3](https://build.nvidia.com/moonshotai/kimi-k3/build) | chat | 是 |
| [nvidia/nemotron-3.5-lightning-30b-a3b](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/build) | chat | 是 |
| [meta/muse-glimmer-30b](https://build.nvidia.com/meta/muse-glimmer-30b/build) | chat | 是 |
| [nvidia/riva-translate-4b-instruct-v2](https://build.nvidia.com/nvidia/riva-translate-4b-instruct-v2/build) | other | 否 |
| [nvidia/ising-calibration-1.5-31b](https://build.nvidia.com/nvidia/ising-calibration-1.5-31b/build) | chat | 是 |
| [nvidia/nemotron-3-embed-1b](https://build.nvidia.com/nvidia/nemotron-3-embed-1b/build) | embedding | 否 |
| [poolside/laguna-xs-2.1](https://build.nvidia.com/poolside/laguna-xs-2.1/build) | chat | 是 |
| [google/diffusiongemma-26b-a4b-it](https://build.nvidia.com/google/diffusiongemma-26b-a4b-it/build) | chat | 是 |
| [nvidia/nemotron-3-ultra-550b-a55b](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/build) | chat | 是 |
| [nvidia/nemotron-3.5-content-safety](https://build.nvidia.com/nvidia/nemotron-3.5-content-safety/build) | other | 否 |
| [nvidia/cosmos3-nano](https://build.nvidia.com/nvidia/cosmos3-nano/build) | video | 否 |
| [nvidia/cosmos3-nano-reasoner](https://build.nvidia.com/nvidia/cosmos3-nano-reasoner/build) | video | 否 |
| [nvidia/nemotron-3-nano-omni-30b-a3b-reasoning](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/build) | chat | 是 |
| [nvidia/synthetic-video-detector](https://build.nvidia.com/nvidia/synthetic-video-detector/build) | video | 否 |
| [nvidia/active-speaker-detection](https://build.nvidia.com/nvidia/active-speaker-detection/build) | video | 否 |
| [nvidia/ising-calibration-1-35b-a3b](https://build.nvidia.com/nvidia/ising-calibration-1-35b-a3b/build) | chat | 是 |
| [google/gemma-4-31b-it](https://build.nvidia.com/google/gemma-4-31b-it/build) | chat | 是 |
| [nvidia/nemotron-voicechat](https://build.nvidia.com/nvidia/nemotron-voicechat/build) | audio | 否 |
| [nvidia/nemotron-3-super-120b-a12b](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/build) | chat | 是 |
| [nvidia/cosmos-transfer2_5-2b](https://build.nvidia.com/nvidia/cosmos-transfer2_5-2b/build) | video | 否 |
| [nvidia/streampetr](https://build.nvidia.com/nvidia/streampetr/build) | video | 否 |
| [nvidia/llama-3_1-nemotron-safety-guard-8b-v3](https://build.nvidia.com/nvidia/llama-3_1-nemotron-safety-guard-8b-v3/build) | other | 否 |
| [openai/gpt-oss-20b](https://build.nvidia.com/openai/gpt-oss-20b/build) | chat | 是 |
| [meta/llama-guard-4-12b](https://build.nvidia.com/meta/llama-guard-4-12b/build) | other | 否 |
| [nvidia/bnr](https://build.nvidia.com/nvidia/bnr/build) | audio | 否 |
| [nvidia/magpie-tts-zeroshot](https://build.nvidia.com/nvidia/magpie-tts-zeroshot/build) | audio | 否 |
| [nvidia/sparsedrive](https://build.nvidia.com/nvidia/sparsedrive/build) | video | 否 |
| [nvidia/bevformer](https://build.nvidia.com/nvidia/bevformer/build) | video | 否 |
| [nvidia/studiovoice](https://build.nvidia.com/nvidia/studiovoice/build) | audio | 否 |
| [meta/llama-3.2-11b-vision-instruct](https://build.nvidia.com/meta/llama-3.2-11b-vision-instruct/build) | chat | 是 |
| [meta/llama-3.2-90b-vision-instruct](https://build.nvidia.com/meta/llama-3.2-90b-vision-instruct/build) | chat | 是 |
| [google/google-paligemma](https://build.nvidia.com/google/google-paligemma/build) | image | 否 |

## 动态目录与快照

`src/nvidia-catalog.snapshot.json` 保存查证快照、精确字段和逐型号来源。线上每小时刷新完整 Build 免费目录；读取失败使用最近目录或内置快照，标 `stale:true` 与来源，失败重试间隔五分钟。新免费聊天条目自动读取官方 Build 元数据，精确匹配 API 后导入；不再有二型号代码白名单。已核验型号的容量使用有来源快照，目录变更本身不随意重写容量。

Build 抓取固定 HTTPS 主机、无 Bearer 凭据、无跳转；每页上限 4 MiB、目录总请求有取消/超时，并发最多 4。非聊天端点只作分类展示，不误发到聊天接口。目录超过单页 96 且分页不完整时显式退回快照，不静默漏模型。

## 固定聊天传输

生成仅 `https://integrate.api.nvidia.com/v1/chat/completions`；目录仅 `/v1/models`。保留 Node 原生 HTTPS、TLS 校验、只接受私有凭据传入的本机代理、取消、有限 JSON、SSE 透传和禁止重定向。工具字段/原始调用 ID/工具回传保留；未声明工具的型号在联网前给出明确错误。Super 的 none/low/high 推理映射保持原行为，其他未声明推理等级不猜测。

## 积分、政策与账号响应头分开

- NVIDIA 已取消 Build 积分制，统一积分余额 `balanceApplicability:not_applicable`，不是“余额为零”。[官方解释](https://forums.developer.nvidia.com/t/unable-to-view-my-account-credit/328471)。
- 当前 [Build 官方运行时文案](https://build.nvidia.com/api/runtime/content/copy.yaml) 公示 Up to 40 rpm 与 10,000 requests per day，并说明按模型/流量变化；政策模块单独记录来源和采集时间。这不是当前账号实时剩余值，不能据此推算已用百分比。
- 适配器仅观察真实响应头 request/token limit、remaining、reset 与 Retry-After；缺失保持 null，`dailyLimit/remaining` 兼容字段不伪造。五分钟缓存只作用于响应头观测；过期清空数值但保留来源、observedAt、observationStatus:expired。
- 独立凭据摘要级认证历史保留 lastAuthenticatedAt、lastDirectoryAt、lastAuthErrorAt、last429At。目录 200 既不降低历史 authenticated，也不修复 rejected；401/403 清空旧限流数值且保留历史成功时间。主控 ledger 提供跨进程历史恢复。
- Retry-After 冷却独立保留 cooldownUntil，429 不自动重放计费/生成请求。所有原始错误正文和 key 均不输出。

## 可运行离线核验

```powershell
node --test tests/nvidia.test.mjs tests/nvidia-catalog.test.mjs tests/nvidia-stream-integration.test.mjs
```

覆盖完整分类、免费与公开目录差异、动态新增模型、精确 ID、官方 maximum 与本地 default 区别、未知上下文、不支持工具、目录缓存退回、认证历史与五分钟观测分离、401/429、SSE 截断/错误脱敏和取消。生成/SSE/工具/回传的真实结果由集成审计独立记录。

## Kimi K3 thinking and audit
Official inference reference https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-infer documents low/high/max reasoning, upstream default max, and preserved assistant reasoning_content. The adapter forwards documented efforts and preserves full assistant messages; normal user calls keep the upstream default. Four-phase availability audits explicitly select low (reported in the audit record), separately from user settings. Audit scheduling serializes the same NVIDIA account to avoid queue waits exhausting inference deadlines.
