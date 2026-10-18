# Windows运行时与流清理

Windows桌面后台和DSH私有worker使用随包运行时，而不是用户全局Node。
本次经本机兼容性/自然退出验证采用官方Node22.23.3 LTS；软件Node API最低版本相应为22.23.3。
不修改系统PATH、DSH宿主Node、Hermes Python或OpenCode客户端运行时。

官方24.20已修复#61999 Windows退出竞争，但本机24.22与26.12仍在独立ACP测试中出现运行期CleanupQueue断言。
不把这两种问题混为一个已修上游根因。22.23.3通过同一ACP41项与完整测试；推荐使用配套已验运行时。

ACP SSE解析器在所有成功、异常、超限、取消分支中均取消所拥有的reader，并在finally释放reader lock。
这是已被正确预期B/M/R验证的资源所有权修正；它本身不是Node原生C++全部缺陷的修复证明。
测试以自然退出码和独立资源诊断为准，不使用process.exit、--test-force-exit来伪装清理完成。

来源：
- https://nodejs.org/en/blog/release/v24.20.0
- https://github.com/nodejs/node/pull/61999
- https://nodejs.org/download/release/v22.23.3/SHASUMS256.txt
- https://nodejs.org/docs/latest-v22.x/api/webstreams.html#readablestreamdefaultreaderreleaselock

本轮实际Node版本矩阵、上游两入口长工具验收、自然全量、安装与独立回滚见交付VERIFICATION.txt。
