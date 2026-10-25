# W7 安装与端到端验收

日期：2026-10-25。范围：[实施计划](WORKSPACE-PLAN.md) W7——从打好的包在干净环境安装，
用真实 Claude Code 跑通“自然语言任务 → 执行 → 产物 → 提问 → 继续”，并按 §2.3 验证性能预算。
这里只记工程事实：脚本、模型和浏览器的测量不代表真人研究（S6 仍为 **真人可用性未验证**）。

## 结论

[`scripts/e2e-acceptance.mjs`](../scripts/e2e-acceptance.mjs) 在 `RHO_E2E_MODEL=1`（真实 Claude Code）
下 7/7 通过，五个状态在四个宽度上 M1–M10 全部达标，E1、E3、E4、E5 成立；性能数字都在预算内。
这一次通过之前，真实模型跑了三次失败，每次都暴露了一个实际问题，已修复后再跑（见“真实模型发现的问题”）。

## 被测对象

| 层 | 身份 |
| --- | --- |
| 应用 | Rho `0c0f1808e48f8530aaece98d8679bfc6f7fd6e8d`，`@rho-workspace/local` 0.4.0 |
| 组件 | Rho-plugins `41b51d39a672ac6392f178d02f222cdb234fa26e`，九个所选插件 |
| Core | Rho-core `ebe351043e74529ccf49960c0b07c805d1e50c07`，二进制 SHA-256 `c31209d5…a67b`（本地构建，不声称可复现或签名） |
| 安装包 | `rho-workspace-local-0.4.0.tgz`，SHA-256 `de1d05c294930b784db4ad1939fe6c0c235a60eb585d1de9d9dcc9f8b2587203`，4,070 个文件，由 `scripts/pack-local.mjs` 从已提交输入组装 |
| 环境 | macOS darwin-arm64（Apple M4 Pro），Node 22.22.3，npm 10.9.8，Rscript 4.5.2，Chrome 155.0.8059.84（headless），Claude Code 2.1.310 |

## 脚本走的路

安装在所有检出目录之外进行：`npm install --omit=dev --ignore-scripts <tgz>`，并移除
`RHO_CORE_BINARY`/`RHO_PACKAGE_ROOT`，所以只用包里自带、经摘要校验的 Core。

1. **安装与冷启动。** 浏览器已打开，从执行 `rho` 到首页渲染计时。
2. **自然语言 → 待运行表单。** 项目里有一份按 `plant` 登记的 `plants.csv`（R 的 PlantGrowth）。
   用安装后的 `rho --grant` 给一个会话授权，按它打印的 MCP 服务器配置启动 Claude Code。
   提示词只有人的话：比较三组的植株重量，写 `analysis.R`，输出按 group 键控的汇总表和箱线图，
   “不要自己运行，放到 Rho 里让我检查后启动”。检查：出现 `rho.action` 视图，Agent 没有调用
   `action.submit`，这个 operationId 在人启动前不存在。
3. **人启动一次。** 人打开 Agent 排好的布局，转到表单，点 Run。Core 收到这个运行恰好一次，提交者是浏览器。
4. **产物。** 在运行视图里点 “List its files”（运行没有写 inventory），从运行打开汇总表；表格显示 ctrl、trt1、trt2 三行。
5. **提问。** 勾选 trt2 行，“Ask about selected rows”，输入问题，“Send question”，展开后点
   “Copy request for the Agent”，从剪贴板读出 Rho 生成的那句话。
6. **继续。** Claude Code 的提示词就是这句复制的话。检查：Agent 读了该 context，`annotation.reply`
   以 `replyTo` 挂在原问题下，页面显示 “Agent response”；它链接的结果按精确版本打开。
7. **导出与重启。** 从运行视图导出；每个导出文件的 SHA-256 与 `provenance.json` 一致。
   然后 SIGTERM 重启安装后的服务，页面重新连上，问题和回答都还在。

`RHO_E2E_STANDIN=1` 用脚本化的 Agent 走同一条协议路径，只用于开发脚本，报告写明它不是 W7 出口。
配对链接、连接文件和会话令牌只在内存或私有运行目录里，报告不含这些内容（已扫描）。

## 真实模型这一次做了什么

| 阶段 | 轮数 | 用时 | 费用 |
| --- | --- | --- | --- |
| 任务 | 27 | 131 s | $1.05 |
| 回答提问 | 58（上限 60） | 307 s | $2.16 |

- 任务：Agent 写了 `analysis.R`（只用 base R，校验组名），布局为 `analysis.R` 与表单左右分栏，
  提议 `plants-weight-by-group-1`：参数是登记版本的 `plants.csv`，声明 `summary.csv`
  （键 `group`，命名空间 `plant-groups`）和 `weight_boxplot.png`，没有 inventory。没有自己运行。
- 回答：Agent 给 `analysis.R` 加了 Welch 双样本 t 检验，自己提交运行 `plants-ttest-trt2-ctrl-1`
  （人在问题里要求加检验并给出 p 值），登记结果表并在回复里链接。回复给出 t = 2.134，df = 16.79，
  双侧 p = 0.0479，差值 0.494，95% CI 0.005–0.983，单侧 p = 0.0239，并提醒样本量小、多重比较。
  这些数字与本机 R 对 PlantGrowth 运行 `t.test(trt2, ctrl)` 的结果逐位一致；“没有运行能证明统计结论正确”这一界限照旧写在运行视图和导出里。
- Agent 共 82 次调用，16 种方法；6 次被拒：5 次 `capability.resolve` 报 `stale`，1 次 `protocol.validate` 报 `invalid`，都自行恢复。

## 行为契约与结构标尺

| 契约 | 结果 |
| --- | --- |
| E1 Agent 当前对象 | 默认屏可见 “Agent analysis.R version 2”，一次操作可达 |
| E2 产物 ↔ 运行 | 表格从运行视图的产物链接打开（断言）；表上方的来源行写出产生它的运行与状态（截图） |
| E3 对象反馈 | 读取了问题的 context；回复 `replyTo` 原问题；链接 1 个结果，按精确版本打开 |
| E4 事实分层 | 页面上 observed 与 verified 分开；Agent 的话没有用 verified 颜色 |
| E5 任务地图 | `task.map.declare` 0 次 |

M1–M10 在 1440×900、1024×768、768×1024、390×844 下逐一测量，失败即中止。

| 状态 | 常驻占比（1440 / 1024 / 768 / 390） | 常驻 + 临时 |
| --- | --- | --- |
| 表单 | 3.6% / 4.2% / 6.0% / 7.2% | 同左 |
| 运行 | 3.6% / 4.2% / 6.0% / 7.2% | 同左 |
| 结果表 | 7.1% / 8.3% / 9.1% / 11.0% | 同左 |
| 提问 | 同上 | 24.0% / 28.1% / 25.7% / 31.2% |
| 回答 | 同上 | 32.1% / 33.3% / 34.1% / 36.0% |

预算：常驻 ≤ 10%（宽度 ≥ 768）/ 15%，总计 ≤ 40%。提问与回答两个状态的临时层是人自己展开、等人处理的问题条，按 M2 允许。

## 性能（§2.3）

| 项 | 预算 | 测得 | 来源 |
| --- | --- | --- | --- |
| 冷启动（安装包，浏览器已开） | ≤ 3 s | 0.71 s（服务就绪 0.62 s） | 真实模型端到端 |
| 安装 | — | 2.3 s | 真实模型端到端 |
| 打开工作区 | ≤ 1.5 s | 0.40 s（W0 0.90 s） | `RHO_PERF_ENFORCE=1 npm run perf` |
| 输入 p95 | ≤ 50 ms | 16 ms | 同上 |
| 切换视图 p95 | ≤ 100 ms | 24 ms | 同上 |
| 排序 p95 | ≤ 100 ms | 16 ms | 同上 |
| 浏览器堆 | ≤ W0 + 20%（20.4 MiB） | 15.1 MiB | 同上 |
| 服务峰值 RSS | ≤ W0 + 20%（175.9 MiB） | 155.9 MiB；端到端中 141.8 MiB（空闲 128.0 MiB） | 同上 / 端到端 |
| 首屏 gzip | ≤ 99,667 B | 92,093 B | 同上 |
| 总 gzip | ≤ 525,061 B | 432,930 B | 同上 |

`scripts/install-smoke.mjs` 对同一个包另行通过：安装 2.4 s，就绪 0.67 s，冷启动 1.24 s（含启动 Chrome）。

## 四层留证

| 层 | 证据 |
| --- | --- |
| 源码 | 单元 170/170，插件 67/67，契约检查通过（88 个操作）；回归清单 13 个验收脚本全部通过（shell、pages、ui、u2-ui、plugin-ui、interaction、action、object、execution、person-files、collaboration、recovery、continuity） |
| 组件 | 包内 `composition.json` 记录三个仓库的提交、树和构建输入摘要，以及每个插件包的 SHA-256 与 integrity |
| 应用 | `pack-local` 只接受已提交输入；包的 SHA-256 见上 |
| npm 安装 | 干净目录 `npm install` 该 tarball；install-smoke 与端到端都只用安装后的 `rho` 和客户端 |

## 真实模型发现的问题

| 次 | 现象 | 处理 |
| --- | --- | --- |
| 1 | Agent 把表单放在代码旁的分栏里；390 宽只显示布局的第一个视图，脚本要量的表单标题不在屏上 | 脚本问题：人在用表单前会转到它的标签。脚本改为先点表单标签；窄屏是否该把等人启动的表单提到前面记入待议 |
| 2 | 1024 宽时右侧窄栏里产物来源行折成两行，常驻占比 10.8% > 10% | 来源行保持一行：验证说明先收缩、再收缩运行名，都以省略号结束并在 title 里给出全文（8.3%）。stand-in 改用同样的分栏，能复现 |
| 3 | 真实回答有七段，展开后问题条占 1440×900 的 54% > 40% | 问题条改为有名称、可聚焦的滚动区，最高 25vh；stand-in 的回答改为同样长度 |

开发中还修了一个关闭问题：SIGTERM 时如果浏览器有一个请求正在处理，Node 的 `server.close()`
会等这条 keep-alive 连接超时（实测 8 s），超过页面约 2 s 的重连预算，页面停在 Offline。
现在关闭时空闲连接立即关闭；页面的重连预算改为只计连续失败。两项都有回归测试。

## 未覆盖与限制

- 原始配对分析和普通分析两个外部示例项目不在本环境，没有覆盖（决定 7 的默认）。参考案例是 PlantGrowth。
- 只测了 macOS arm64 与 Chrome 155；其他平台和浏览器未验证。
- npm 包名与渠道默认 `@rho-workspace/local`、公开 npm registry；发布需要用户提供权限，尚未发布。
- 回答阶段用了 58/60 轮。5 次 `capability.resolve` 的 `stale` 拒绝不是因为目录变了：探针确认文档编辑与保存、
  运行、登记、布局和浏览器配对都不改变 `catalogRef`；而拒绝文案说“目录或授权已改变”。原因应是模型抄写的
  64 位摘要不符。改进（由 MCP 层自行提供它从 `rho_index` 拿到的 `catalogRef`）涉及插件契约，记入待议。
- 真实模型的每次运行结果会不同；这里记录的是通过的那一次，三次失败的报告未保存在仓库中。
