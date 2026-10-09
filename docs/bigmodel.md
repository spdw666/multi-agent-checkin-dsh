# 智谱 BigModel 官方接入

这是官方平台适配器，不是任意第三方中转站。固定使用 `https://open.bigmodel.cn/api/paas/v4` 聊天 API 与该平台的余额接口。

## 1. 账号隔离凭据

在本机新建 `accounts/bigmodel-main/credentials.json`，按实际账号填写并保留在本机：

```json
{"apiKey":"","consoleAuthorization":"","consoleCookie":""}
```

`apiKey` 用于模型调用和现金余额；`consoleAuthorization` 或 `consoleCookie` 用于资源包列表。只调用模型时不需要控制台字段；控制台凭据过期会给出单独错误，不把资源包查询失败冒充为现金或模型调用失败。

## 2. 管理配置

将以下项目合并到对应数组，保留原配置及其他账号：

```json
{
  "accounts": [{
    "id": "bigmodel-main", "platform": "bigmodel", "enabled": true,
    "label": "智谱官方",
    "credentials": {"kind": "file", "file": "./accounts/bigmodel-main/credentials.json"},
    "tasks": []
  }],
  "upstreams": [{"id": "bigmodel-official", "kind": "bigmodel", "accountId": "bigmodel-main", "enabled": true}],
  "routes": [{
    "id": "bigmodel-official/glm-4.7", "enabled": true,
    "targets": [{"upstreamId": "bigmodel-official", "model": "glm-4.7"}]
  }]
}
```

文件路径相对管理配置文件解析。读取实时目录后由用户决定导入，不默认导入整个目录；模型名称可能变化。`glm-4.6v` 是实测可调用后补入的目录条目，是否继续适用以账号实时体检为准。

## 3. 使用与显示

- 通过 `/admin/health` 查询账号，通过 `/admin/balances` 展示现金（CNY）和 `parts` 中的资源包。
- 每个资源包独立显示 `name / value / total / unit / scope / status / expiresAt`。Token、次和现金不相加。
- 资源包按平台定义的模型及场景扣减；网页列表并不保证所有包能用于每个模型。
- 默认适配普通、流式与结构化工具链，以及目录声明的图片输入。图像生成、视频生成、搜索等服务未映射到聊天 API。
- 只映射平台确认的思考开关，不虚构 low/medium/high/max 档位。
- `/admin/model-tests` 的 `scope: "imported"` 可主动验证已启用路由；每次结果包含时间和具体失败阶段。

## 4. 成功和扣减分开验证

四项测试通过证明该模型当次链路可用，不自动证明某个指定赠送包已抵扣。资源包更新存在时间差，核对适用场景及官方账单再判断。体检调用自身也会产生真实用量。

参考：[智谱官方 OpenAI SDK 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)。实现文件为 `src/bigmodel.mjs`；凭据、账单和用户会话不随仓库分发。
