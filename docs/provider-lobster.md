# LobsterAI adapter

固定官方服务`https://lobsterai-server.youdao.com`。原生`%APPDATA%/LobsterAI/lobsterai.sqlite`只读kv.auth_tokens/auth_user，每次resolve重读；原ID仅内存散列稳定principal。不得把openclaw网关token当官方服务token。

官方可用模型目录30项；contextWindow采用返回值，输出上限4096是网关configured_default，officialMaxTokens=null。仅`deepseek-flash`经普通/SSE/工具回填/工具SSE回填四链路4/4后标tools:true、toolsSource=live_four_link_verified；其他按官方字段。reasoning外显null以避免DSH缺efforts契约，内部保存isReasoning/reasoningOptions。

该型号产品默认runtime thinking为off（`lobsterai_options.version=1,thinking.level=off`），来自已安装客户端模型兼容协议并实测；用户显式lobsterai_options或reasoning_effort优先。reasoning_effort根据动态目录真实档位转译。四链路第二轮不再向runner注入私有options，改用原生max_completion_tokens，仍4/4。该字段归一max_tokens，冲突/超过4096拒绝。

额度按quota/profile-summary免费池+活动池分别列示，避免free重复合计。每日活动从slot/context动态发现，claim前读取可领取状态和版本，只提交官方check_in动作，提交后context复核；今日已领100不重复提交。不同额度/签到端点失败相互隔离。

上游始终SSE；网关非流返回标准OpenAI JSON，流保留delta/reasoning/toolcalls/usage；event:error与HTTP200业务错误映射失败，取消及缓冲有界。凭据只在本机：研究临时token文件已删除，脚本改内存SQLite读取。

官方 https://github.com/netease-youdao/LobsterAI ，协议参考opencode-lobster-auth MIT详见provider-attributions.md及vendor完整许可证。真实Hermes WB DeepSeek V4.1 Flash max编程，主集成者补兼容契约和真实四链路。

## 通用推理档位兼容

目录字段`reasoningEffortMapping`公开通用OpenAI档位到当前官方原生档位的映射，`reasoningMappingSource=gateway_aliases_of_official_options`；原生`reasoningOptions`和`reasoningDefault`保持不变，不伪造模型能力。目前deepseek-flash官方off/high/max、默认high：none→off，minimal/low/medium→最低可用非off档high，xhigh→max，high/max精确使用。若其他模型真实声明low/medium，优先精确值；最低档按minimal/low/medium/high/xhigh/max顺序选择。仅off时不假造非off档；未知ultra仍400。显式lobsterai_options优先，删除冲突的通用reasoning_effort字段。Hermes原生默认medium由产品兼容，不改runner或用户默认设置。
