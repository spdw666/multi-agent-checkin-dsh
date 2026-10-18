# Hermes Desktop 的网关模型来源前缀（可选补丁）

网关返回的路由ID携带入口来源，但不同Hermes版本的菜单可能只显示模型短名。此补丁只修改Hermes Desktop显示层：在ai-credit/custom:ai-credit provider的列表、搜索结果和已选模型标签前增加WB国内、WB国际、Trae国内等前缀。普通Provider显示保持原样。

前缀表示用户选中的路由入口，不表示本次接力最终由哪个账号或平台生成；实际供应看网关活动账本。模型ID、API请求、凭据与账号路由不改。此文件不会随网关启动自动安装。

## 使用前先核对

补丁是已验证版本的四个TypeScript源文件精确差异，不含Hermes程序、renderer产物或用户配置。将应用目录定位到实际Hermes源码根，先备份四个源文件与当前renderer，然后执行只读检查：

~~~sh
git apply --ignore-space-change --check PATH_TO_GATEWAY/integrations/hermes/ui-model-prefix.patch
~~~

检查通过后再应用：

~~~sh
git apply --ignore-space-change PATH_TO_GATEWAY/integrations/hermes/ui-model-prefix.patch
~~~

随后使用该Hermes版本自己的测试和Desktop构建流程重新生成renderer，再在空闲时加载新界面。源码上下文或基线SHA不一致时先合并当前版本，别覆盖整棵客户端源码或用户配置。仅应用源码而未重建界面，不算显示已经生效。

## 参考版本基线

原基线SHA256如下；它们用于判断补丁适配性，不是所有Hermes版本通用的文件哈希：

|文件|原SHA256|
|---|---|
|apps/desktop/src/lib/model-status-label.ts|4a834ee6ab1207d952c0f2a30f1f7ad09de0fd983f6bb39772d57406caadb3f2|
|apps/desktop/src/app/shell/model-catalog-menu.tsx|caf425a3baa588daa2339374f019b1f09c2c9804a09eac1e27c29ac452d08b2e|
|apps/desktop/src/app/chat/composer/model-pill.tsx|a74193a0801c098705285d1bd125e6e324cec393bf6a5d5b27c533561aaf7d71|

既有修复在独立副本验证41项显示行为；此次发布另将此精确补丁应用于四份原始基线副本，git apply --check与apply均exit0。实际客户端运行、安装和回滚证据保留在项目本机交接目录，不把这些历史结果当成新Hermes版本自动兼容保证。

撤销源码改动前先核对自己后续修改；独立副本可用git apply -R检验。正式回滚应恢复对应源码及同一构建的renderer，用户账号、模型设置与聊天记录不在补丁内。
