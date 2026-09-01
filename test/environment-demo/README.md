# Rho Environment fixture

这是一个用于验证新 Environment 边界的最小项目。它自带 `renv.lock`，因此打开后
应被识别为 **Project Renv**；Rho 不会因为发现 `analysis.R` 而自动初始化、恢复或
修改 renv。

## 验证目标

打开 `test/environment-demo` 后，在 Authority → Environment 中检查：

- **Health** 分开显示权威 receipt/realization 与当前 Workspace 激活状态；
- **Plans** 只显示已经物化、包含 exact Runtime、LibraryStack、目标库、artifact
  digest、network intent 与 verification probe 的不可变计划；
- **Activity** 来自 operation journal 的
  `admitted → executed → verified → committed/reconcile` checkpoint；
- 成功 receipt 要求显式重启并 re-observe，当前 kernel 不会假装已经升级；
- Agent 只能 inspect、解释 incident 和提出 change intent，不能在 Workspace R 中
  直接运行 package install、restore 或 lockfile mutation。

未执行获批计划时，项目文件、`renv.lock` 和库目录都不应发生变化。直接在 Console
中手工调用 renv 属于用户自己的 R 操作，不会被 UI 冒充为 Rho Environment receipt。

## 运行示例

`analysis.R` 只使用 base R 的 `iris`，会生成图和
`output/iris-summary.csv`。运行后可在 Runs、Artifacts 和 Evidence/Claims 中分别检查：

- Run/Artifact 是否真实发生，由 Authority receipt 回答；
- 分析结论引用了哪些来源、是否 stale 或存在 gap，由 Evidence Graph 回答。

## 重置

关闭 Rho 后，只删除本 fixture 自己生成的 `output/` 内容即可。不要为了“重置”而
删除真实项目的 `renv.lock`、`.Rprofile` 或环境库；环境恢复必须从已记录 desired
revision 和 exact plan 重新执行，而不是用 UI 状态猜测。
