# 同款模型接力的思考档位转换

接力时保持客户端模型 ID 与同款型号，仅按实际供应平台的能力声明重建本次上游请求的思考控制。模型目录中的 `reasoning: true` 或 `isReasoning: true` 仅表示内部推理，不等于模型支持可选档位。

## 转换规则

| 来源状态 | 实际目标状态 | 上游控制 |
|---|---|---|
| 可选档位、用户显式 `max` | 无可选档位／仅内置推理 | 删除目标未声明的 `reasoning_effort`、`thinking` 及原平台控制 envelope |
| 无可选档位、SDK `null` 或无控制字段 | 有可选档位 | 发送目标实际声明的最高档，不假定最高档名称为 `max` |
| 无可选档位、客户端默认 `none/off` | 有可选档位 | 按用户约定选择目标实际最高档；默认关闭值不作为来源的有效可选档位 |
| 来源显式合法 `low/high/...` | 有可选档位 | 优先保持或使用声明映射；缺该档时取最近不低于意图的实际档，超过目标上限则取其最高档 |
| 来源 `max` | 目标只有 `high` | 发送 `high`；Trae 若声明 `high: heavy` 则发送原生 `heavy` |
| 来源任意强度 | 目标只声明真实思考开关 | 发送 `enabled`，不伪装强度；来源的合法显式关闭且目标接受关闭时发送 `disabled` |
| 来源无可选档位的二元开关 | 目标有可选档位 | 目标最高档 |
| 来源合法关闭 | 目标明确强制思考 `alwaysEnabled` | 目标最高档，开启原生思考开关 |
| `extra_body.reasoning_effort: null` | 任意 | `null` 当作缺省，移除覆盖项；不覆盖非空的显式意图 |
| 目标能力元数据未知／只有默认值 | 任意 | 不虚构档位或原生参数，保留模型／消息／工具等非控制字段 |
| 未发生接力 | 任意 | 返回原请求对象，不改变既有普通调用行为 |

最高档由实际档位表排序得到，排序为 `minimal < low < medium < high < xhigh < max`。声明的别名可对应同一个原生档；原生值相同的别名不制造更高档。原生未知名称只有在明确的通用档→原生值映射中才用于发送。

## 模型能力契约

纯 helper 读取现有模型目录字段：

- `reasoningEfforts`、`thinkingLevelMap`：通用档→已声明原生值。
- `reasoning.supportedEfforts`（兼容 `reasoning.supported`）：已声明通用档。
- `reasoningOptions` + `reasoningEffortMapping`：实际原生选项与目录别名；例如 Lobster 的 `medium -> high` 不是额外的中等原生档。
- `reasoning.supportedThinkingTypes`：明确的原生 `enabled/disabled` 开关；只有开关且没有强度时按二元处理。
- `reasoning.control: thinking` 或 `thinking+effort`：明确要求原生思考开关。
- `reasoning.alwaysEnabled`、`onlyReasoning`：目标强制思考。

### 官方参数核对

NVIDIA Kimi K3 官方推理参数仅有 `low/high/max`，默认 `max`，因此有强度的转入请求使用目录声明，而不是给全部 NVIDIA 型号统一发 `max`。[NVIDIA 官方 API](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-infer)

智谱官方文档现已声明 GLM-5.3 系列 API 的 `low/high/max`，GLM-5.3 与 Flash 还要求开启思考；旧版本仅二元思考的能力与这些有档型号分开。代码按实际型号元数据转换，不把所有 BigModel 都按 binary-only 处理。[智谱深度思考官方文档](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[Z.ai GLM-5.3 官方文档](https://docs.z.ai/guides/llm/glm-5.3)

已检索现有 WorkBuddy 实现并对照本项目 `vendor/workbuddy-core.mjs`、`src/platforms.mjs`。第三方的一次 HTTP 成功或经验补全不作为本项目新档位声明。Lobster 本项目已有官方目录 `thinkingConfig.options` 和声明别名转换，helper 复用该契约。[Lobster 官方源码仓库](https://github.com/netease-youdao/LobsterAI)

## 调用接口

```javascript
import {adaptRelayReasoning} from './relay-reasoning.mjs';

// originalRequest 与 sourceModel 每个候选都使用原始值。
// relayed 只在实际换供应目标时为 true，不等同于全局策略开启。
const {request: upstreamRequest, metadata} = adaptRelayReasoning(
  originalRequest,
  targetModelMetadata,
  {kind: targetPlatformKind, sourceModel: originalSourceModelMetadata, relayed: true},
);
```

helper 返回 `{request, metadata}`。`metadata` 只含控制转换信息：`mode`、`changed`、`sourceIntent`、`sourceHasLevels`、`targetEffort`、`wireEffort`、`targetMaximum`、`removedFields`；不记录消息、工具参数、文件正文或凭据。未知输入只记固定 `unrecognized`，声明但非已知枚举的原生控制值只记 `declared_native`，不把任意输入字符串写到账本。

helper 不修改 `originalRequest`，不更改 model ID、messages、tools、工具回传、输出上限、stream 或取消 signal。请求级控制字段和 `extra_body` 控制仅在副本中转换，包括 `thinking_config/thinkingConfig`、camel-case 开关、思考预算及原生配置 envelope。消息历史中的 `reasoning_content` 或名为 `reasoning_effort`、`thinkingConfig` 的工具参数仍原样保留。

## 离线回归

helper 子任务基线在独立 `baseline` 副本运行已有 13 项档位／元数据测试：`tests 13 / pass 13 / fail 0 / skipped 0`，退出 0。

初版 helper 41 项通过；自审补充实际档位与开关并存、合法 native disabled、原生同值别名、显式 binary wire 四项，独立审查再补充 native/camel-case 控制清理、合法嵌套低档及元数据固定枚举三项。helper 共 48 项；同时已有 13 项仍通过，共 61 项、0 失败、0 跳过，退出 0。

```powershell
Set-Location 'C:/Projects/ai-credit-gateway'
& 'C:/Tools/node/node.exe' `
  --test --test-timeout=45000 `
  tests/relay-reasoning.test.mjs tests/fixes-v6.test.mjs tests/provider-client-metadata.test.mjs
```

这些测试验证纯转换与原请求保持；真实模型生成、Router/Platforms 集成、部署和独立回滚证据由总验证记录单独列出，不用离线 fixture 代替真实接力验收。
