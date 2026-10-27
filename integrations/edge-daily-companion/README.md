# 一次性本机会话导入

本扩展只完成首次连接，不承担日常签到。当前流程、权限、Windows DPAPI 保存和故障恢复见 [视频平台每日积分](../../docs/video-daily.md)。

在 Edge 的 `edge://extensions` 选择“加载解压缩的扩展”，选择本目录；ID 应为 `ppbanlmjmecbeffacgjghocjbcfmaifk`。manifest.key 为公开 RSA SPKI 公钥；不包含私钥或账号凭据。默认仅有 tabs 与精确站点权限，cookies/scripting 在用户确认导入时临时申请，导入结束撤销。

扩展不读取密码、本地浏览器数据库或任意 localStorage；PixVerse 只取已核定的应用会话 Token，即梦仅取当前官网已核定的 xmst / __msuuid__ 会话片段。Cookie/Token 只经 127.0.0.1 交给当前 Windows 用户 DPAPI 保护的本机导入服务，不写入本仓库。
