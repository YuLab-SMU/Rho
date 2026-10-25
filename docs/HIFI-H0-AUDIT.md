# H0 · 真实应用基线审计（2026-10-25）

高保真工作的起点：当前构建（a0f9035d）在真实 Core、真实 R、真实 Agent 记录下的样子。
本文只记录看到和量到的东西；方向在 `HIFI-PLAN.md`，设计稿在 Paper「Rho · 高保真（真实应用）」。

## 怎么拍的

- 一次性服务：`/tmp/rho-h0`（`--root /tmp/rho-h0/root`，`--port 49532`），真实 `rho-core` 与 `Rscript`。
- 项目：
  - `airquality`：W7 真实 Claude Code 会话留下的 R 统计分析。5 次运行，其中 2 次失败，有 5 个声明项和 workspace 布局。
  - `airquality-live`：新项目。由授权 Agent 客户端重跑同一份 `analysis.R`，开头加 `Sys.sleep(10)`，以便看到运行中状态。
  - `check-repair`：代码修复任务。
  - `penguins`：多视图布局。
- 宽度：1440×900、1024×768、390×844，设备像素比 2。每个状态都从 reload 开始。
- 证据：本地 `work/hifi-h0/shots/`（gitignored，87 张）。脚本在 `work/hifi-h0/`，含 `capture.mjs`、`agent-live*.mjs`、`reconnect2.mjs`、`measure.mjs`。

| 编号 | 状态 | 阶段 |
|---|---|---|
| 01 | Home | 开始 |
| 02 / 03 | airquality 概览（折叠 / 展开） | 全景 |
| 04–06 | workspace：默认 / 图 / 表 | 工作 · Artifact 焦点 |
| 07 | Recorded evidence 展开 | 工作 |
| 08 | 失败运行对话框 | 失败 |
| 09 / 10 | check-repair 概览 / Documents | 全景（代码任务） |
| 11 | penguins 多视图 | 工作 |
| 12 | Plugins | 开始 |
| 20–22 | Agent 打开脚本 → 运行中 → 完成（Following） | 工作 · Agent 在场 |
| 23 | Core Host 被杀后：outcome unknown / accepted, not observed | 未知 |
| 24–26 | 服务停止 → 离线 → 重启 → Reconnect | 重连 |

## 量到的层级（airquality workspace，图在前）

由 `measure.mjs` 读取 `getBoundingClientRect`，单位为 CSS px。

| 宽度 | 导航占宽 | 内容起点 y | 图实际尺寸 / 所在面板 |
|---|---|---|---|
| 1440 | 300（rail 68 + 项目导航 232），21% | 152，17% | 1042×622 / 1139×748（原始 1040×620，未缩放） |
| 1024 | 300，**29%** | 152，20% | 699×418 / 723×616 |
| 390 | 抽屉 | **185，22%** | 366×219 / 390×659，图只占屏高 26% |

1440 时内容上方有四条横带：顶栏 48、Rho 条 32、标签栏 39、来源行约 32。

## 发现

严重度：**P0** = 人会读错事实；**P1** = 该看的东西不是最显眼的；**P2** = 精度与打磨。
"归属"指改动应落在哪一层。

### P0

1. **表格数字截断后丢了数量级。**
   - 证据：06。effects.csv 的 p.value 显示 `2.931896…`，CSV 里实际是 `2.93189659247788e-18`；B 行 `3.149109…` 实际是 `3.15e-11`。
   - 后果：人会把 p≈2.9e-18 读成 2.9。
   - 归属：Rho-plugins `tables`（数字格式属于插件领域语言）。
   - 方向：数值列按列统一有效位数；很小或很大的数用科学计数；永不在指数之前截断。
2. **概览把没有执行的运行说成"写了 4 个文件"。**
   - 证据：23-recovery-overview。`airquality-live-5 wrote 4 declared files that nothing verified`，而 `project.runs` 记录为 `execution: unobserved, delivery: not-sent, completion: absent`，4 个文件均 `present: false`。
   - 同屏还有：run 4 同时出现为 `has no observed outcome` 和 `wrote 4 declared files`；计数写着 `1 running`，但没有一行在运行。
   - 原因：`src/execution-facts.ts:93-96` 的 unverified 分支不看 `execution`，用 `declared.length` 而不是实际存在的文件数。任何正在运行的运行也会被这样描述。
   - 归属：Rho `execution-facts`。这是事实错误，不属于高保真改造；单独修，附回归测试。

### P1 · 层级与构图

3. **等宽字体在 Chrome 回落到 Courier。**
   - 证据：20、21、22 中的编辑器和运行标题；02 中的声明项引用。
   - 原因：`--font-mono: "JetBrains Mono", ui-monospace, monospace`，JetBrains Mono 没有打包，Chrome 不解析 `ui-monospace`。
   - 归属：Rho `theme.css` token。
   - 方向：改为 `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`，不引外部字体。
4. **内容前的界面框架过多**：见上表。390 宽时 22% 屏高还没开始内容。
   - 归属：Rho shell。
   - 方向（2026-10-25 修订）：不靠压缩外壳来解决。Rho 条的内容分进底栏（Following、运行链）和右栏（证据、备注）；来源行只保留一条。
5. **工作中导航太宽**：1024 时 rail + 项目导航占 29%。在 workspace 里，项目导航的内容（概览 / 布局 / 内容）此时不是主角。
   - 归属：Rho shell。
   - 方向（2026-10-25 修订）：1440 保留完整三栏，项目树带数量。1024 以下怎么让位，由 1024 / 390 稿决定。
6. **同一运行 id 重复出现。**
   - 证据 05：两个标签 `· airquality-temp-5`，再加来源行，共 3 次。
   - 证据 21：Rho 条、标签、标题、底部运行链接，共 4 次。
   - 违反"一个事实一个主位置"。
   - 方向：运行 id 只在来源行出现一次；标签只写对象名。
7. **被取代的失败占据最强颜色。**
   - 证据 02 / 05：概览先列 run 3、run 4 两条红色失败，运行链 3、4 是实心红点。而当前结果 run 5 完成且字节已校验。
   - 方向：已被后续运行取代的失败降为弱色，可见但不领头；只有"当前就是失败"才用失败色。
8. **Agent 跟随落在运行记录上，而不是它产出的东西。**
   - 证据 22：运行完成后，主区是一列 "x · on disk"，约占面板 35%×30%，其余空白。图要再点一次才能看到。
   - 归属：Rho shell（live / expression 规则）。须先确认规则意图，再决定表现。
9. **运行中缺少时间感。**
   - 证据 21：只有一个 "running" 字样和虚线链点，没有已用时间，也没有输出。声明的文件写成 "not on disk"，读起来像错误，实际意思是"还没有"。
10. **图下方的说明与来源行重复。**
    - 证据 05：`temp-effect.png · 46 KB · version 985b7955`。
    - 图按原始尺寸显示，没有"适应 / 100%"。1440 时尚可，宽屏会留白，390 时太小。
11. **证据面板把内容往下推**：证据 07。展开后占据主区上半部，表格被压到下半屏。Agent 的备注和 "Owner observations / recorded calls" 日志混在同一个滚动区里。
    - 备注里的 `document.edit`、`artifact.check` 是 Agent 自己写的文字，外壳原样显示，不应改写。
    - 方向：证据作为右侧检查器，不挤压主区；舞台上那个对象对应的备注高亮；调用日志折叠在最下面。
12. **Results 行粗细不一。**
    - 证据 02：effects.csv、temp-effect.png 是粗体（被布局放置过），另外两行是常规体。
    - 差异有含义，但版面没有说明这个含义，看起来像随机强调。
13. **代码任务的故事看不见。**
    - 证据 09：概览只有一次完成的运行，没有布局。"No question has been declared…" 用 H2 级标题显示。
    - 证据 10：Documents 行不可打开；登记文件显示内部路径 `.rho/plugins/runs/<64 hex>/artifacts/results.csv`，M5 规则没有拦住。
14. **失败运行对话框松散**：证据 08。一排彩色运行链接，操作按钮没有样式。

### P2

15. Inter 没有打包，没有 Inter 的机器上字形和度量会变。
16. 390 宽时 "Stop run" 缩进不对齐（21）。运行链接行全部带下划线。
17. "accepted, not observed" 用斜体和协议语言（23）。人需要的是"已收到，还没开始执行"。
18. 离线后服务恢复了，页面仍停在 Offline，直到手动点 Reconnect（25 → 26，服务就绪 3 秒后仍离线）。离线期间内容没有任何"这是旧数据"的视觉处理，只有横幅。是否自动重连须对照 `INTERACTION-MODEL` 的意图再定。
19. W7 Agent 回答（`work/e2e-model/answer-*`）：Markdown 未渲染，统计量未取整，表格只占视图一小部分。

### 不属于高保真范围、但须单独跟进

- **N1** 对一次性服务发 SIGTERM（它的 Core Host 先被 SIGKILL）后，服务继续监听、继续应答，也没写出 shutdown 报告。只观察到一次，原因未查（`src/cli.ts:87`）。对照：没有先杀 Core Host 的正常 SIGTERM，服务 4 秒内退出，并写出 `{"shutdown":[]}`。
- **N2** Core Host 被杀后，第一次 `action.submit` 返回 `A prior Host socket remains. Inspect the original requests before explicit Host recovery.`；之后同一服务上的 submit 没有经过显式恢复就成功了。须复现。
- **N3**（S3 闭环发现）提问草稿是未保存的文档缓冲区（`q-<uuid>.md`），项目树的 "Documents" 把它们和项目文件算在一起：airquality 磁盘上只有 analysis.R 和 findings.md，树上却写 7。草稿该不该计入、该放在哪里，由文档所有者决定。

## 做得对的（保留）

- 离线横幅：一句话说清楚是什么时候读到的，加一个 Reconnect。
- 运行链：用形状区分完成 / 失败 / 未知（实心、空心、虚线），不只靠颜色。
- Following 开关：开关本身就说明了状态，不需要额外说明文字。
- 概览按人会问的顺序排列：问题 → 需要注意的 → 结果 → 声明项。
