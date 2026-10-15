# Linux VPS 迁移

Node.js 24 或更新版本。拷贝工程、config.local.json 及账号隔离的配置文件；不要把 Windows DPAPI 加密文件当作 Linux 可读凭据。WorkBuddy 原生加密凭据仍需对应桌面 runtime；VPS 可采用 `credentials.kind="file"` 与本机配置的明文访问 token，或在本机运行模型桥接、VPS 使用其 OpenAI 上游。

```json
{"accessToken":"TOKEN","principal":"ACCOUNT_ID","uid":"ACCOUNT_ID","domain":"www.workbuddy.cn"}
```

将路径写入对应账号的 credentials.file。expiresAtMs 如填写必须是服务端原始过期时间；未填写时从 JWT exp 推导。令牌变化由该账号配置文件更新，不用全局 token。Trae credentials.kind=file 还需 userId、host、userRegion、edition 与身份 deviceId/machineId；每日签到使用原始设备身份，不随机创建新设备。

systemd 用户单元示例：

```ini
[Unit]
Description=AI Credit Gateway
After=network-online.target
[Service]
Type=simple
WorkingDirectory=/opt/ai-credit-gateway
ExecStart=/usr/bin/node /opt/ai-credit-gateway/bin/ai-credit.mjs serve --config /opt/ai-credit-gateway/config.local.json
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
```

默认保持 127.0.0.1。对服务器或局域网开放时显式设置 server.host 与 allowRemote，配置独立访问密钥，并在部署层使用 TLS/网络访问控制。DSH 私有 shim 仍固定 loopback，不随独立服务的监听设置开放。
