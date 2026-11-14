# DSH 挂载
在 ~/.dsh/profiles/desktop/cordis.patch.yml 的 patch 数组追加：
```yaml
- id: dsh-ai-credit-gateway
  config:
    configFile: /ABSOLUTE/PATH/config.local.json
```
bundle列表由 `dsh plugin --profile desktop add file:/ABSOLUTE/PATH/PROJECT` 写入 profile package.json 的 dsh.profile.bundles。若已有同ID，修改其config，不重复insert。设置 AI_CREDIT_NODE 为独立 Node24 的绝对路径。下次正常宿主启动加载安装后的代码；配置目录刷新约30秒。已经输出的请求不因切换账号重放。

## worker 监听端口

挂载后的 bundle 会另起一个本地 worker 进程（`bundle/worker.mjs`），由它把网关的模型目录注册给 DSH。

worker 优先绑定 `AI_CREDIT_WORKER_PORT`（默认 `60077`）；端口被占用时重试 5 次，仍失败则回落系统分配的临时端口，并打印 `worker fixed port <N> unavailable: <code>`。

固定端口是有意义的：外层若按 `http://127.0.0.1:<port>` 做过 per-provider / per-model 的窗口覆盖，端口漂移会让这些覆盖静默失配（表现为"配置明明写了却不生效"）。需要换端口请用该环境变量统一指定，不要依赖临时端口。

两点运维注意：

- 改动 `src/` 下的代码后需要**重启 worker** 才会生效；改配置文件是热载的，约 30 秒内自动刷新。
- worker 使用自己生成的随机 key，因此它的端口不响应主服务的 adminKey / apiKey；想确认它注册出去的模型目录，请直接读网关侧 `/admin/models`，或看 worker 的启动日志。
