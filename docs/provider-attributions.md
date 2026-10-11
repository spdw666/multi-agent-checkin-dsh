# A组协议与代码来源

- Coding2API: https://github.com/RobbsLuo/Coding2API/tree/39b43376ed6fd6dce23b278a471b8bf3b71939bc/src/provider/codearts
  - 2026-10-11 git ls-remote HEAD = 39b43376ed6fd6dce23b278a471b8bf3b71939bc。
  - MIT，完整版权许可证保留于 vendor/Coding2API/LICENSE。
  - provider-codearts.mjs 的 Huawei SDK HMAC 签名算法由其 signer.py 译写为 JavaScript；endpoint常量与SSE协议解析作为参考。
  - 改动：固定官方端点、凭据只读本机SQLite、公开视图脱敏、统一provider契约、余额/签到独立、SSE边界与取消、独立fixture测试。
- opencode-lobster-auth: https://github.com/Jasery/opencode-lobster-auth/tree/752e81b6c53e58d6066c4cf4715ee16e9dbedfc6
  - 2026-10-11 git ls-remote HEAD = 752e81b6c53e58d6066c4cf4715ee16e9dbedfc6。
  - MIT，完整版权许可证保留于 vendor/opencode-lobster-auth/LICENSE。
  - Lobster auth-import、constants、models、proxy、sse、usage 为协议研究参考；未采用其静态32K输出与1M窗口fallback。
  - provider-lobster.mjs 为按本机原客户端与官方API实测数据实现的适配器，包括SQLite只读令牌、动态目录、官方额度、每日活动上下文/提交后复核；SSE共用本项目新增provider-sse.mjs。
- Lobster官方源码 https://github.com/netease-youdao/LobsterAI ，安装版本2026.9.23，固定官方服务 https://lobsterai-server.youdao.com。
- CodeArts官方签名规范 https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html 。

以上commit为本轮锁定的公开HEAD；最终发布前保留完整许可证，不将私有账号数据与凭据包含在vendor或文档中。
