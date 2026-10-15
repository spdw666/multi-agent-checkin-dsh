# Trae DeepSeek V4.1 Flash reasoning-only stop 诊断与修复

## 已确认的实际原因

2026-10-13，指定原始 target `trae-code-cn / deepseek-v4.1-flash`，native `model=config_name=deepseek-v4.1-flash`、`function=solo_work_remote`。目录仅该 function 提供这个精确型号，未切换模型、账户或 function。

原始 SSE 脱敏观测显示：默认推理输入 `Reply with only AUDIT_OK.` 返回 9 条 reasoning 增量共 104 字符，所有 `output.response` 长度为 0，最终 `done.finish_reason=stop`。显式目录支持的 low→light 对照仍只有 42 字符 reasoning；completion_tokens=16、reasoning_tokens=11，未提供正文。collectChat 之前已经没有正文，故不是聚合器吞掉内容。

同模型不改变推理设置的普通中文问候返回 18 字符正文，Node.js 项目问题返回 82 字符正文。因此不能判定型号完全不可用，也不能声称“所有输入都会空”。短精确指令的 reasoning-only/部分回复是本轮实际观察到的输出行为。

## 产品改动

`vendor/trae/solo-bridge.ts` 的 `openTraeAnswer` 和 `TraeSoloBridge.chatStream`：

- 仅精确型号 deepseek-v4.1-flash 启用预答案检查；不改其他型号行为。
- 首次可见正文或任何工具片段出现前暂存原始 SSE；上限 4 MiB / 4096 chunks。
- 只有明确的 reasoning-only + stop、没有可见正文或任何工具片段，才原样重试一次。请求字节、模型、function、消息及调用总 AbortSignal 不变；调用方未提供 signal 时共享一个 120 秒总预算。
- 认证/额度/业务错误、空 EOF、超时、取消、前缀超限不重试；出现任何工具片段后不重放，避免工具副作用。
- 第一次废弃的 reasoning 不作为最终答案，不泄漏到第二次回复。空白不算可见正文；后续真正正文前的空白前缀仍保留。
- 已报告的首轮 token/cache/reasoning 计数累计到最终 usage，记录 `trae_attempts`。响应头 `x-ai-credit-trae-attempts` / `x-ai-credit-trae-retry-reason` 供根网关归档。第二次仍为空则显式失败，不把 stop 冒充成功。

## 实际验证边界

12 项离线 fixture 全部通过，含同字节重试、上限、取消、工具不重放、空白、用量累计和其他模型保持原行为。独立复制回滚恢复原版“一次 reasoning-only 仍标传输成功但正文为空”的行为，stage 保持修改版。

新 stage 独立真实四阶段（18:18:07–18:18:16 上海时间）沿原 testModel，不接力、不改审计规则：

| 阶段 | 结果 | 耗时 | 实际数据 |
|---|---|---:|---|
| ordinary | 现有完整性检查通过 | 1750 ms | A |
| stream | 现有完整性检查通过 | 2738 ms | AUD\nOK；reasoning-only 后重试一次 |
| tools | 通过 | 1959 ms | 真实 audit_add，参数 a=2,b=3 |
| roundtrip | 通过 | 2597 ms | 真实工具结果回填后正文 5 |

共 5 次 native 请求，目标全部相同，配置 SHA 不变，脚本 exit0。**普通/流式均未精确遵从 AUDIT_OK，两个 strictExpected=false；不宣称精确指令完全修好。** 本轮补丁解决的是 reasoning-only 被当正常完成及其有界恢复路径，不是伪造内容或普遍保证模型遵从性。正式安装后的 selected 和 DSH/Hermes 文件 nonce 闭环另列实测证据。

证据位于 `outputs/relay-context/trae/`：observation-1.json、observation-low.json、observation-greeting.json、observation-project.json、directory-wire.json、direct-4stage-1.json。只保存模型名、事件形状、长度、数值计数及测试文本，无认证头、token、设备身份或真实用户消息。

## 参照

- 上游协议实现：[dsh-connect-trae/src/solo.ts](https://github.com/dingminhua/dsh-connect-trae/blob/main/src/solo.ts)。原适配器白名单与本地一致，本轮没有盲加未证实字段。
- 同类 provider 行为记录：[DeepSeek Harness discussion 6102](https://github.com/deepseek-ai/deepseek-harness/discussions/6102)、[discussion 5113](https://github.com/deepseek-ai/deepseek-harness/discussions/5113)。这些是同类现象参照，实际根因判据仍是本机原始 SSE 观测。

## 后续严格客户端验收暴露的第二层故障

18:36–18:37，正式 DSH/Hermes 两端都完成真实文件工具调用与工具结果回填，但最终文本仅保留 nonce 前缀，严格验收失败（各 2 API，未放宽判定）。这说明原四阶段“正文非空”只是连通性检查，不能代表完整正文恢复。

`nonce-wire-1.json` 原生事件确认：第二次请求的全部 output.response 仅为 `FILE_READ_OK`，工具原文是 `FILE_READ_OK_d693dedd`。done 仅有 finish_reason=stop；extra_info.content 是 reasoning，不是隐藏答案。桥输出与原生全部正文逐字相同，未发现本地吞帧，亦未用 reasoning 或工具输入填答案。

同一已生成工具回填请求只改 native `stream:false` 的单变量对照，仍返回 HTTP200 text/event-stream，但完整 output.response 序列为 `FILE`、`_`、`READ`、`_OK_d693dedd`，严格 nonce 相等。参见 `nonce-replay-nonstream.json`。这曾构成传输参数候选修复依据，但随后被重复观测反证，并非已确认根因；没有切换账号、模型或 function。

该候选仅 CN 精确型号/function 改 native stream=false，离线 16 项通过；然而 `nonce-wire-2.json` 确认产品两次 native body 都为 false，仍只输出 FILE_READ_OK_d；`direct-4stage-2.json` ordinary=A、stream=AUD，严格指令仍失败。故 stream=false 候选已从产品撤回，bundle 恢复 1365148…；实验 fixture 移到 work，不以其假设测试当产品验证。

另单变量 native stream=true + max_tokens=4096 的 `nonce-replay-budget.json` 仍仅 FILE_READ_OK。一次完整输出不是稳定修复，目录 max_tokens 字段也没有证明该接口增加预算能够补正文。当前继续查原生消息 content 形状与官方请求参数；严格双客户端最终 nonce 仍未通过，任务未关闭。

## 已确证的额度耗尽与错误分类

19:07:33 的 UUID 对照未进入推理：原 SSE 先返回 notify_usage，billing_mode=credits、cn_credits=0、ide_credits=0、work_credits=0，随后 error.code=4008。19:10:47 官方只读余额 totalAmount=1700、consumedAmount=1700、ratio=1，今日奖励已领取。故这次是积分耗尽，不是已证明的“每日请求次数限制”。已停止所有真实 Trae 生成，不购买积分，也不重复领取。

产品只将确证 code4008 归为 HTTP402 / hard_credit；原错误码/消息保留，首次即停止重试。1005 保留原订阅类402；其他4001等保留400client。更新后14项fixture通过。streamfalse/max_tokens/UUID候选均未当成稳定修复；UUID因0余额而无正文结论。

## Raw v2 候选的代码级交付

公开 upstream [raw-chat.ts](https://github.com/dingminhua/dsh-connect-trae/blob/43f29df900f10fa2a5817e5740d196637bc062dd/src/raw-chat.ts) 与 [raw-upstream.ts](https://github.com/dingminhua/dsh-connect-trae/blob/43f29df900f10fa2a5817e5740d196637bc062dd/src/raw-upstream.ts) 明示这是从 DTO 推导的离线候选，不是实测生产协议。[raw-runtime-config.ts](https://github.com/dingminhua/dsh-connect-trae/blob/43f29df900f10fa2a5817e5740d196637bc062dd/src/raw-runtime-config.ts) 把节流标记放在 Raw v2 extra_info，其消费者不是 llm_utils_chat。因此尚无证据把该标记塞入现有 utils 就能关闭上游节流；encrypted_model_params 也不是现有 utils 白名单的必需字段。

专属 `work/relay-context/trae/raw-candidate.mjs` 是独立纯函数实现，构建精确同名 model/config、保留原生 tools、工具调用 ID、工具结果、reasoning，不做提示词伪工具。配套 `raw-candidate.test.mjs` 完成4项离线fixture：源对象不变、型号/配对/额度边界、模拟native工具→真实本地文件读取→原ID回填→模拟精确最终nonce、业务2001失败。它没有网络实现、凭据读取或生产注册，assertLiveReady明确拒绝未验证调用。4/4离线通过不代表新端点可调用。首次本地测试清理目录用rm导致exit1，改为空目录rmdir后4/4exit0，原失败不作模型故障。

### 当前完成边界

已完成：上游原始帧定位、reasoning-only有界恢复、4008精确分类、离线回归与独立回滚、现有四阶段连通性证明。未完成：Trae两客户端严格长nonce完整回复；原生输出丢尾的稳定根因/修复；Raw v2真实认证/模型绑定/工具验收。下一次真实验证须以新的可用积分为前提，并保留同款、原始工具回填及完整nonce判定。
