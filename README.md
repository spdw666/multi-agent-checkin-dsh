# 多 Agent 自动签到与 DSH 模型网关

多平台每日权益检查、账号隔离账本、OpenAI 兼容反代及 DSH bundle。仓库只发布后端、CLI、协议适配器、测试、部署脚本和许可证；不包含原生桌面或 Web 前端，使用者可自行制作界面。

## 功能
- WorkBuddy 多账号独立签到；同模型账号池按优先顺序切换，当前账号积分耗尽后使用备用账号，不轮询。
- Trae 国内版签到，真实 device ID；9074 临时拥堵可重试，修复旧版本当天永久跳过的问题。国际版只有订阅检查。
- 千问办公个人版每日额度查询（服务端自动重置，不伪造签到）。
- MiniMax Code 每日签到与额度查询；ZCode 免费套餐领取（遇人工验证返回 action_required）。
- GET /v1/models、POST /v1/chat/completions：普通、SSE、结构化 tool_calls、工具结果回传。工具由下游 Agent 执行。
- 多账号 SQLite 幂等账本、每日随机延迟、启动检查、失败记录；余额查询 25 秒截止时间，失败保留已有缓存值。
- 第三方中转站功能已删除。

## 一键准备与启动
需要 Node.js 24+。Windows PowerShell：
```powershell
git clone https://github.com/spdw666/multi-agent-checkin-dsh.git
cd multi-agent-checkin-dsh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
```
Linux/macOS：
```sh
git clone https://github.com/spdw666/multi-agent-checkin-dsh.git
cd multi-agent-checkin-dsh
bash scripts/install.sh
```
脚本安装构建依赖、构建协议模块、初始化本机配置并启动后台。未登录的平台不会伪造领取成功；执行 `node bin/ai-credit.mjs doctor` 检查登录态。所有凭据只通过本机文件录入，API/admin key 自动生成在 data/api-keys.json。

## CLI
```sh
node bin/ai-credit.mjs start
node bin/ai-credit.mjs stop
node bin/ai-credit.mjs doctor
node bin/ai-credit.mjs claim --all
node bin/ai-credit.mjs claim --account trae-code-cn --task daily-checkin
node bin/ai-credit.mjs models
node bin/ai-credit.mjs records
npm run check
```
默认 http://127.0.0.1:19421；前端未分发，根路径返回服务信息，不是管理网页。

## 账号与部署事实
config.local.json 由示例生成。账号凭据层与模型上游层分离；每个平台账号独立配置 credentials.file。Windows 默认复用客户端本机登录态，Linux VPS 不会凭空拥有 Windows 登录态，须配置自己的文件凭据并维护有效期。
WorkBuddy 添加账号：登录 A → 认证 POST /admin/workbuddy/capture 保存 A → 客户端登录 B → 保存 B。再 POST /admin/workbuddy/pool 配置 routeId、accountIds、enabled:true、cooldownSeconds。POST /admin/workbuddy/switch 在下一请求选择账号。已输出的 SSE 不从头重放。登录快照过期须重新保存，不承诺无限期刷新。
QwenWork 编码器需要 Python 3.11+、`pip install -r vendor/qwen-requirements.txt`，设置 QWENWORK_PYTHON 与 QWENWORK_WASM（来自自己客户端，仓库不分发 WASM/客户端）。MiniMax 原生登录态需要客户端或自己的文件凭据。ZCode 验证可能需要 Edge/Chromium，设置 AI_CREDIT_BROWSER。

## 接入 DSH desktop profile
DSH 示例兼容范围 >=0.1.7-rc.1 <0.3.0-0，实测基于 0.2.0-rc.2。使用独立 Node，设置 AI_CREDIT_NODE 为 Node24绝对路径，尤其宿主是 Electron 时。
```sh
node scripts/install-dsh.mjs --config /ABSOLUTE/PATH/config.local.json
```
安装脚本定位 Windows Desktop CLI；其他安装可执行 `dsh plugin --profile desktop add file:/ABSOLUTE/PATH/PROJECT`，并参考 docs/dsh.md 配置 patch。脚本不自动重启 DSH。不要把 Electron 可执行文件作为 Node worker。

## 自建前端
详见 [管理API](docs/api.md)。管理 API 使用 adminKey，模型 API 使用 apiKey，两者隔离。界面可自行采用 React、Vue、原生桌面或命令行；没有随包的样式或 UI 代码。

## 验证与限制
86项本机回归测试覆盖普通/SSE/tool_calls、跨进程幂等、账号池、临时拒绝恢复、余额超时。多账号场景使用合成上游；真实不同账号领取需在部署者自己的账号上复核。模型目录出现不等于当前账号有权限；使用体检结果标记。原平台协议与活动可能变化。

## 致谢与许可证
项目原创部分 MIT。请保留 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 vendor 中完整许可证。感谢 dingminhua/dsh-connect-workbuddy、dingminhua/dsh-connect-trae、hawklithm/workbuddy2api、spirodelazz/ide-daily-checkin、88lin/workbuddy-auto-signin、linguo2625469/workbuddy2api-panel、wangmingdong/workbuddy-signin、Shuffle-1992/TraeSign、MiniMax-AI/minimax-code、wicm84266964/Buddy2api 和 deepseek-ai/deepseek-harness。
ZCode 客户端协议形状按本机观察实现，未分发客户端二进制；TriDefender/zcode-api 的 README 声明 MIT，复用模块及提交号记录在 vendor/zcode-context/NOTICE.md。具体复用、参考和版本见 Notices。
