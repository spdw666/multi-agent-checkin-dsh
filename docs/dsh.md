# DSH 挂载
在 ~/.dsh/profiles/desktop/cordis.patch.yml 的 patch 数组追加：
```yaml
- id: dsh-ai-credit-gateway
  config:
    configFile: /ABSOLUTE/PATH/config.local.json
```
bundle列表由 `dsh plugin --profile desktop add file:/ABSOLUTE/PATH/PROJECT` 写入 profile package.json 的 dsh.profile.bundles。若已有同ID，修改其config，不重复insert。设置 AI_CREDIT_NODE 为独立 Node24 的绝对路径。下次正常宿主启动加载安装后的代码；配置目录刷新约30秒。已经输出的请求不因切换账号重放。
