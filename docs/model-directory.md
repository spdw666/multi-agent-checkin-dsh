# 模型目录显示与验证

## 打开与选择

“全部模型 / 选择导入”先显示可响应的窗口，再异步读取目录。加载不发起生成式模型体检；关闭后的晚到响应不操作已释放窗口。目录请求失败时，在同一窗口使用“重试读取目录”，无需重新打开主程序。

目录数据与 DataGridView 行分离，采用虚拟模式按需显示；搜索短防抖，平台和类型筛选立即生效。排序和筛选仅改变可见索引，未保存的选择保持。批量勾选不会为每条记录再次扫描整张表。

国内 WorkBuddy 同 model ID 合并为一行，下拉只显示一个“WorkBuddy 国内账号池”。原始账号、凭据、轮换、路由和体检记录保持；国际版独立。取消合并行时保留每个真实 upstream/model 对应的 importedRouteIds，服务端仍检查路由与目标的精确绑定，不把别的来源或型号一起取消。

## 原子保存

一次请求最多 5000 项导入变更，所有项目通过校验后只提交一次配置。无效型号、来源变化或精确路由绑定错误使整批失败，不进行前半批提交。取消导入不请求远端目录；目录已缺失的已导入项仅可取消，不能凭旧元数据重新启用。按精确 route ID 导出的既有上限仍为 500，与模型导入上限独立。

## 状态口径

- 目录来源及发现时间只证明可见条目，不证明当前账号有调用权益。
- 官方缺失、改名、地区差异及账号权益变化要分别核对；历史曾测 ID 缺失不是单独的下架证明。
- 非聊天模型保留明确分类，专用图像/音频/向量 API 不冒充 DSH/Hermes 聊天模型。
- 工具声明不是工具执行证据。每款保留的 Agent 模型在每个客户端分别核验实际文件工具、配对结果回填、最终随机字符串及确切供应账本；普通回答和 HTTP 200 不代替这一步。

## 本地回归

先执行 `npm ci`、`npm run check`。Windows 使用已有 .NET Framework 编译器，无新增原生运行时依赖：

```powershell
powershell -NoProfile -File desktop/tests/Run-CatalogFixture.ps1 -Contract
powershell -NoProfile -File desktop/tests/Run-DirectoryLifecycleFixture.ps1 -Mode late-success
powershell -NoProfile -File desktop/tests/Run-DirectoryLifecycleFixture.ps1 -Mode late-error
powershell -NoProfile -File desktop/tests/Run-DirectoryLifecycleFixture.ps1 -Mode retry
node --test tests/model-directory-large-selection.test.mjs
```

目录 fixture 的数据来自合成样例，或通过 `-InputJson` 指定的离线目录；不连接官方模型。生命周期 fixture 使用本地延迟 HTTP handler 检查首次可见、关闭后晚到响应与精确重试次数。真实客户端验收独立记录，不由这些离线测试推定。

## 实现依据

- [Microsoft：DataGridView 大数据量性能建议](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/best-practices-for-scaling-the-windows-forms-datagridview-control)
- [Microsoft：DataGridView 虚拟模式](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/virtual-mode-in-the-windows-forms-datagridview-control)
