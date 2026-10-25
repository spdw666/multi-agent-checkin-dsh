# 模型目录显示与验证

## 打开与选择

“全部模型 / 选择导入”先显示可响应的窗口，再异步读取目录。加载不发起生成式模型体检；关闭后的晚到响应不操作已释放窗口。目录请求失败时，在同一窗口使用“重试读取目录”，无需重新打开主程序。

目录数据与 DataGridView 行分离，采用虚拟模式按需显示；搜索短防抖，平台和类型筛选立即生效。排序和筛选仅改变可见索引，未保存的选择保持。批量勾选不会为每条记录再次扫描整张表。

国内 WorkBuddy 同 model ID 合并为一行，下拉只显示一个“WorkBuddy 国内账号池”。原始账号、凭据、轮换、路由和体检记录保持；国际版独立。取消合并行时保留每个真实 upstream/model 对应的 importedRouteIds，服务端仍检查路由与目标的精确绑定，不把别的来源或型号一起取消。

## 原子保存

一次请求最多 5000 项导入变更，所有项目通过校验后只提交一次配置。无效型号、来源变化或精确路由绑定错误使整批失败，不进行前半批提交。取消导入不请求远端目录；目录已缺失的已导入项仅可取消，不能凭旧元数据重新启用。按精确 route ID 导出的既有上限仍为 500，与模型导入上限独立。

## 状态口径

- 目录来源及发现时间只证明可见条目，不证明当前账号有调用权益。
- 官方缺失、改名、地区差异及账号权益变化要分别核对；历史曾测 ID 缺失不是单独的下架证明。
- 非聊天模型保留明确分类，专用图像/音频/向量 API 不冒充 DSH/Hermes 聊天模型。
- 连通性先逐型号、逐客户端发送一条无工具短消息，核对非空最终回复、实际错误、耗时及精确供应账本；不先用长历史或完整工具配置阻塞基本检查。
- 工具声明不是工具执行证据。短消息回复、简单工具闭环、完整原生配置分别统计；工作验收仍检查实际文件工具、配对结果回填、最终回复及确切供应账本。普通回答和 HTTP 200 不代替工具执行证据。
- 单型号套餐拒绝只关闭对应型号的本次尝试；账号级认证、资源耗尽或明确限流才按相应账号池处理。保留原拒绝、未提交和新条件补测记录，不覆盖历史来扩大成功数。

## 原生目录参数与容量来源

Trae 的 remote 展示目录和原生 chat wire 目录分别读取。合并时仅从精确匹配的 wire model 透传有效正整数 `maxTokens`；匹配优先级保持原规则，显示别名保留原 `wireConfigName` 与 function。没有 wire 匹配、缺失输出字段或无效值时保持未知，不复制其他型号的输出，也不把 remote 的上下文选择器当输出容量。推理、费率、工具、输入能力和调用通道不因这项透传改动而变化。

Qoder 的 `context_config` 和 `thinking_config` 是原生参数声明，保存在 `qoderNativeParameters`，带 `source` 与 `wireVerified:false`。Context 选项保留原 ID、`token_count` 与严格布尔默认标记；Thinking 保留 mode、原生 effort ID 与默认标记。只有一个明确默认项时才给出默认值，多个默认项、缺失或畸形声明保持未知。

这层原始声明不覆盖实际 `max_input_tokens`，不替缺失输入容量的型号开启 callable，也不自动生成通用 `reasoningEfforts` 或从目录默认项强加请求控制。目录没有官方输出声明时，既有配置默认值继续标记为 `configured_default`，`officialMaxTokens` 保持 null。原显式预算、采样、图像、工具和结果回填均保持。原生字段契约可对照 [Qoder SDK 模型选择策略](https://docs.qoder.com/cli/sdk/model-policy) 与 [TypeScript ModelInfo 参考](https://docs.qoder.com/cli/sdk/references-typescript)；当前账号的具体值仍以当前签名目录为准。

## Qoder 请求与流式信封

请求保留原有 OpenAI 字段，同时把有效输出预算写入原生 `parameters.max_tokens`。仅调用方明确指定时才传递 `temperature`、`top_p`、`tool_choice`、`reasoning_effort` / `enable_thinking` 及已声明的 `contextWindow` → `context_length`；`none` 同步关闭原生 model config 的 reasoning 标记。没有显式上下文选项就不添加默认选择，也不改变 `model_config.max_input_tokens`。

流式响应先区分传输 HTTP 与 SSE 内层 wrapper。当前 wrapper 同时含 `statusCodeValue` 和 `body`，普通事件只接受 numeric `200`；`event: finish` 的状态豁免仍保留 body 内实际 error 的检查。先解析有效 body，外层矛盾字段不覆盖它；普通 payload 的 `code` 不是通用失败判据。null、缺失或 null choices、usage 和控制 marker 按各自语义处理。

当前原生 wrapper 已有正文、reasoning 或工具进展后，EOF 可结束；只收到控制帧不当作模型回复。旧 body-only wrapper 保留原有完整帧和结束标记检查。解析错误提供有界 reason、机器码和状态，不把 raw body、异常文本或凭据写入诊断。此兼容合同不证明账号套餐、模型权限或双客户端工作验收通过。

Qoder 当前协议兼容版本基线为已核验原客户端 `1.1.75-hotfix.1`；`Cosy-Version`、COSY payload 的 `cosyVersion` 与签名 body 的 `business.version` 同步更新。原身份、签名算法、协议 v1/v3、实际输入容量与调用方参数保持；没有用版本变化推导型号级最低版本或调用成功。

## Buddy 拒绝诊断

HTTP 拒绝从既有结构容器中的 `code` 读取有限整数，错误文本保留 `[businessCode=数字]`，经公共错误序列化后仍可定位该次拒绝。仅处理 1000–999999 的安全整数或四至六位十进制字符串；不从任意消息文本、请求字段或 HTML 提取，不记录上游 raw message、body、header。

诊断数字不等于已知策略码。原 `upstreamCode` 白名单、短/长窗口及用量分类、`Retry-After` 和重试条件保持；未知数字只保留诊断，不被解释为可重试、额度耗尽或套餐状态。实际型号原因仍以该请求回执和已核验的原生定义为准。

## DSH 型号默认预算

目录中的 `defaultMaxTokens` 与 `maxTokens` 分别表示显式默认值和当前公布上限。DSH 适配器优先采用前者；仅当前者缺省时才以同一精确路由的有效上限建立本地默认值。显式 `null`、无效值或未知上限不补造。首包头与实际 ModelInfo 使用同一默认映射，避免模型注册表中另一来源的同名型号覆盖它。

这项默认协商不修改调用方显式预算、消息、工具、调用 ID 或回填。显式超额预算仍交给原能力检查处理；小窗口备用供应仍按原规则排除。刷新目录后新请求使用新映射，已准备的快照不追改，删除型号后不保留旧默认。离线回归同时覆盖真实可选 DSH SDK 序列化与纯策略：缺少可选 peer 时只跳过明确标记的 SDK 断言，其余策略断言仍执行，其他导入错误继续失败。

## 本地回归

先执行 `npm ci`、`npm run check`。Windows 使用已有 .NET Framework 编译器，无新增原生运行时依赖：

```powershell
powershell -NoProfile -File desktop/tests/Run-CatalogFixture.ps1 -Contract
powershell -NoProfile -File desktop/tests/Run-DirectoryLifecycleFixture.ps1 -Mode late-success
powershell -NoProfile -File desktop/tests/Run-DirectoryLifecycleFixture.ps1 -Mode late-error
powershell -NoProfile -File desktop/tests/Run-DirectoryLifecycleFixture.ps1 -Mode retry
node --test tests/model-directory-large-selection.test.mjs
```

目录 fixture 的数据来自合成样例，或通过 `-InputJson` 指定的离线目录；不连接官方模型。生命周期 fixture 使用本地延迟 HTTP handler 检查首次可见、关闭后晚到响应与精确重试次数。真实客户端验收独立记录，不由这些离线测试推定。

## 实现依据

- [Microsoft：DataGridView 大数据量性能建议](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/best-practices-for-scaling-the-windows-forms-datagridview-control)
- [Microsoft：DataGridView 虚拟模式](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/virtual-mode-in-the-windows-forms-datagridview-control)

## Qoder 嵌套错误与队列诊断

外层 `403` 不单独说明拒绝原因。适配器只沿显式 `message` 对象或 JSON 字符串读取最多四层，每段不超过 4096 UTF-8 字节，保留安全内层 `innerBusinessCode`；排队字段只接受有界整数、布尔值及已观察到的有限机器标签。自由文本、模型键、请求标识和原始响应不进入错误诊断。

官方 SDK 提供 `model_queue_status`，同一查询可经历等待、就绪后继续请求；公开 [同型案例](https://github.com/decolua/9router/issues/3510) 的内层码为 `10605`，但其他 `403` 不据此推定为排队。当前这项改动仅增强诊断，保持原 HTTP/code/retry 语义，不自动轮询、重放或换账户。
