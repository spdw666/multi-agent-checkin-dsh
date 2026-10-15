# 免费平台目录与真实传输

## 来源与状态

核查日期：2026-10-13。参考项目为 [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)，固定提交 `986b2118226f5c2d1a0348e14d151a7005c1924e`。许可证为 MIT；本模块没有复制其程序实现，只独立实现公开端点与协议适配。注册目录保存每项精确源文件 URL。未运行参考仓库代码。

README 的“34个平台”不是当前源码计数：本次 `server/src/providers/index.ts` 注册 **64 个命名平台 + custom**。网站另有 25 平台的显示口径。目录覆盖全部 65 项，真实传输实现覆盖其中 59 个 chat 项；NVIDIA、智谱复用已有适配器；Speechify、FreeAI 仅音频；custom 没有预设端点；GitHub Models 已退役。**注册、离线协议测试、公开目录可读、账号认证成功、免费资格、真实模型运行是六种不同状态。** 其余 58 个新传输项没有因 Kilo 成功而获得实测通过状态。

重要过时信息：

- [GitHub Models 官方文档](https://docs.github.com/en/github-models)：服务已于 2026-07-30 退役，和 GitHub Copilot 分开处理。
- [Hugging Face 当前定价](https://huggingface.co/docs/inference-providers/en/pricing)：Free Users 没有月度 credits。旧参考仓库的 $0.10/月不作为当前免费政策。
- [OpenCode Zen](https://docs.opencode.ai/docs/zen/)：付费模型和限时促销分开。网关不模拟原客户端身份，不自动将所有模型当免费。
- ModelScope 当前参考源码报告魔粒计费；旧每日 2000 免费调用说法不作为余额或可用证明。Reka、Sail 的资格信息仅为参考项目报告，官方本账户政策待核验。
- NVIDIA/BigModel 使用现有独立实现，避免重复账户、重复签到、跨域发送密钥。

## 固定协议与端点

| 协议 | 实现 |
|---|---|
| OpenAI chat | 每平台固定 registry HTTPS origin，`/models` + `/chat/completions`；Kilo 目录例外为 `/api/gateway/models` |
| Google Gemini | 官方 `/v1beta/models` 读取 inputTokenLimit/outputTokenLimit；生成使用 [官方 OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) `/v1beta/openai/chat/completions` |
| Cohere | 原生 `/v1/models` 目录；[官方兼容接口](https://docs.cohere.com/docs/compatibility-api) `/compatibility/v1/chat/completions` |
| Cloudflare | [账户目录](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/) `/accounts/{accountId}/ai/models/search`；`/accounts/{accountId}/ai/v1/chat/completions`；accountId 必须 32 位十六进制 |
| LongCat Anthropic | 私有配置 `protocol: "anthropic"` 使用 [官方接口](https://longcat.chat/platform/docs/APIDocs.html) `/anthropic/v1/messages`；Bearer + anthropic-version；system/tool_use/tool_result IDs 转换 |
| Sail / ACLIDE Responses | `/responses`；Sail background + flex，固定 response ID 有界轮询；函数调用/回填 ID 保留 |
| AI Horde | OpenAI 代理的非流响应；匿名官方 sentinel，工具请求明确报错，不丢工具后伪装成功 |
| Moondream | 固定 OpenAI 兼容端点、max_completion_tokens；未实现工具请求明确报错 |

Anthropic、Responses、Horde 的 SSE 是**缓冲后输出**，返回 `x-gateway-streaming-mode: buffered`，不是上游原生逐 token 流。Anthropic/Responses 未实现的请求参数（例如 reasoning_effort）明确返回 `unsupported_request_option`，不默默删参数。Responses 当前仅文本输入。标准 OpenAI 流保留实际工具 delta，流内错误去密，EOF 没有 finish_reason 视为未完成。

HTTPS 使用系统 TLS 校验；不跟随 3xx；禁止 account/upstream 覆盖固定端点。私有文件允许显式 loopback HTTP proxy，例如 `http://127.0.0.1:7890`。代理不改变目标 origin，不修改系统代理。请求有取消、总超时和 body idle 超时；JSON 最大 4 MiB，SSE 帧最大 1 MiB。服务错误只返回代码/HTTP 状态，不暴露原始上游消息或 token。

参考实现明确记录部分聚合平台存在 HTTP 200 换模型风险。ACLIDE、Airforce、Blaze、BlockRun、CLōD、DreamPrompting、InferBase、LLMtr、Logfare、Lucidity、Moondream、Septor、SimpleLLM、Waterfall 采用严格返回模型 ID 校验，缺失/不一致报错，不把替代模型结果重标成请求模型；尚未核实的别名也不擅自接受。

## 私有凭据与添加接口

```json
{
  "apiKey": "TOKEN",
  "proxyUrl": "http://127.0.0.1:7890",
  "models": [
    {"id":"MODEL_ID","contextWindow":131072,"maxTokens":4096,"tools":true}
  ]
}
```

`models` 是可选的用户明确配置元数据。目录提供有效官方数值时优先使用目录；私有配置数值标为 `metadataSource: private_config`，不是官方核验数值。Cloudflare 另需 `accountId`；仅 LongCat 可设置 `protocol: anthropic`。`freeModelIds` 可显式确认付费/促销混合平台的当前账户选定模型资格，但不改变 `freeEligibility` 为官方免费。

管理 API：

```json
{"providerId":"groq","id":"groq-main","credentialFile":"D:/PRIVATE/groq.json","models":["MODEL_ID"]}
```

`buildFreeProviderConfig` 返回 clone，创建 platform/kind `freeapi` 的 account/upstream，`account.freeProviderId` 绑定具体平台；初始全部 disabled/tasks[]，不自动生成 route。没有文件时保留待配置条目；Kilo/OVH/Horde 可走其明确匿名模式。调用账号健康/目录并导入真实模型由管理服务完成，不在构造函数中产生网络请求。密钥不进入管理配置或 UI 明文输入。

`credentialFields` 为 string[]；`freeProviderList()` 的 `models` 为对象数组，未取得目录时为空。管理服务合并 `configured`、`missingCredential`、账户 ID。模型 capacity 缺失时 `callable/importable:false`，保留条目和原因，绝不兜底 32768。确切 context 存在但输出上限缺失时，本地保守配置为 1024，`officialMaxTokens:null`、`maxTokensSource:configured_default`。工具与图像能力只依 provider 字段/用户配置；目录列表成功不证明当前 API key 有效。

## 额度含义

`quota.value/remaining/unit` 保持 null，除非真正取得对应余额；本模块没有伪造通用 token 总余额或签到。`policy` 附来源、核查日期、资格与说明。HTTP 请求/令牌限额头分别保存 `requestLimit/requestRemaining/tokenLimit/tokenRemaining`，缺字段为 null；429 保存 Retry-After/cooldown。Groq 请求限额头是 RPD、token 头是 TPM，不相加为月余额。

官方政策来源：

- [Google](https://ai.google.dev/gemini-api/docs/rate-limits)：按项目/模型/层级，以实际项目为准。
- [Groq](https://console.groq.com/docs/rate-limits)：按模型、RPD/TPM/RPM 分开。
- [Cohere](https://docs.cohere.com/docs/rate-limits)：evaluation key 每月 1000 API calls，Chat 表列 20/min；生产收费。
- [Cloudflare](https://developers.cloudflare.com/workers-ai/platform/pricing/)：免费每日 10000 Neurons，不代表本账号今日剩余。
- [Kilo](https://kilo.ai/docs/gateway/usage-and-billing)：匿名/认证免费模型每 IP 每小时 200 请求；按实时零价目录筛选。免费提示与输出可能用于训练，保留 `mayTrainOnYourPrompts` 字段。
- [OVH](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started)：匿名试用 2/min/IP/model；认证接口和计费另行判断。

## 本机验收

2026-10-13 真实 Kilo 匿名目录读到 391 条、18 条零价格且容量精确的聊天模型（目录随时间变化）。仅对 `liquid/lfm-2.5-2.6b:free` 进行合成工具闭环：context 65536、max output 8192、tools true；工具 `add_fixture(a=2,b=3)` HTTP 200，回填结果 5 后 HTTP 200、精确回复 `5`。没有本地文件、账号密钥或用户工作内容发送到该免费端点。其他未配置平台保留待配置/未实测状态。

本机只读凭据检查发现已有 NVIDIA/BigModel 账户可复用；目标 provider 环境变量未发现，OpenCode auth 路径未发现，Gemini settings 文件存在但没有对应 API provider 凭据证据。没有复制或修改原客户端密钥。

离线验证命令：`node --test tests/free-providers.test.mjs`。覆盖注册项、未知容量、凭据与固定 origin、上下游输出字段、公开目录认证语义、政策与余额隔离、Gemini/Cohere/Cloudflare/Anthropic/Responses、SSE 错误/截断与合成工具 ID 保留。真实调用证据保存在运行输出目录，不纳入产品默认配置。

一次真实 DSH 公开设计复审启动已执行：选择现有 WorkBuddy DeepSeek-V4.1-Flash/max，未修改默认模型。但本机 headless 插件导入失败，进程 exit 1、实际模型请求 0；因此不计作成功 DSH 审查。离线测试与上述 Kilo 工具实测是本轮成功证据，二者不冒充 DSH 客户端验收。
