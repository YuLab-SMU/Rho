# U1 浏览器外壳对齐计划

Updated: 2026-10-17

设计来源是 Paper "Rho · 工作台 v1" 的
["Rho · U1 补稿（代码对齐）"](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-C-0)
页面：U1-01 至 U1-09c 共 16 个画板，加一张 "U1 · 对齐说明" 规格画板。
数值以画板计算样式为准，界面文案以画板英文为准。本文只记录 `web/` 与画板的差距、
分批顺序和完成条件；现状和验收结果仍写在 [Status](STATUS.md) 与
[U1 browser checks](UI-ACCEPTANCE.md)。

范围是 [Browser UI](UI.md) 的 U1 观察外壳。没有功能 renderer、布局写入或新的后端操作，
这些属于 U2–U4。

## 差距总览

| 区域 | 现在（`web/`） | 画板 |
| --- | --- | --- |
| 颜色 | 主按钮黑色；描边 #c3c9c6；选中底 #e9edfb；成功 #2f6f51；错误 #a22d2a；无元信息色和离线灰 | 主按钮 #3A68F0；描边 #DDE0E4；内分隔 #EEF0F2；选中 #E8EEFD / #2347B8；正常 #3D8B67；离线/未知 #9AA1A7；错误 #B23B37；元信息 #6B737A |
| 尺寸 | 圆角 6；按钮无定高；焦点 2px outline；上下文栏 280 | 按钮 32 r8，小按钮 26 r7，输入 36–40 r8，3px 蓝色光圈；标签 30 r7；胶囊 28 全圆角；面板 r12；侧栏行 30 r7；上下文栏 330 |
| 字体 | h1 26、h2 15、移动端 23；有 500 字重 | 28 / 20 / 14 / 13 / 12 / 11；只用 400 / 600 |
| 宽度 | 窄屏 700；窄屏保留 rail | ≥1280 三栏；1024 上下文栏覆盖；<768 去掉 rail 和侧栏，抽屉 + 底部面板，工具栏 48，点击区 36 |
| 工具栏 | 始终有 "Rho" 字标；状态是 Observing / Disconnected（红） | 字标只在未连接页；左侧是位置（项目 / 布局 + Read-only，首页为 Home）；绿点 Up to date · 10:24，灰点 Offline · last read 10:24 |
| rail | 插件页高亮 Plugins；底部直接 Unpair | 项目内高亮 Projects；插件目录和详情高亮 Plugins；Unpair 移到上下文面板 "This tab" 和命令面板，先确认 |
| 配对 | 有 rail 和 Commands；"Connect to your work" / "Pair this browser" | 不再做人工配对（用户决定，2026-10-17）。由 Agent 打开带一次性链接的标签页；未连接时只显示居中卡片 "Open Rho from your Agent"，没有输入框。U1-01 / 01b 作废 |
| 首页 | 路径输入框和两个按钮在同一行；绝对时间 | "Welcome back" / "Welcome to Rho"；新建和打开是 480 宽弹出面板，固定前缀 `~/projects/`；相对时间，完整时间放 tooltip；整行可点 |
| 项目侧栏 | Workspace、"Capabilities & access"、Compositions、Resources、Retained operations | Layouts、Files；计数为 0 时不显示；不放插件行，同一时刻只有一个选中行 |
| 概览 | "No composition yet"；资源 JSON、字节数 | "No saved layout yet"；列出文档和文件，身份信息折叠 |
| 工作区 | 原生 select；不可用视图写 "This view is unavailable" 加 JSON | 标签页；"This view can't be shown here yet" 加 Shows / Needs / In this build；"About Documents" 打开插件详情；引用放 "View reference" 折叠，等宽字体，不用红色 |
| 上下文栏 | "Context & access"，含项目 JSON | 三段，含 "This tab"；切换命令写成 Show / Hide context & access |
| 断线 | 橙色整条横幅 "Observation interrupted" / "Reconnect and inspect" | 中性灰提示条 "Can't reach Rho. You're seeing what was read at 10:24." / "Reconnect"；侧栏、标签和已读内容保留 |
| 命令面板 | 无输入框，无分组 | 占位 "Type a command"，分组，只列命令；底部 "Commands only. To ask about your work, use Claude Code." |
| 插件页 | "Capabilities & access"，逐个显示 Present / Enabled / Satisfied 和方法名 | 目录按用途分组；详情顺序为提示词 → 说明 → Skills → 能做的事 → Views → Information；正常不写状态，不正常只写第一条原因和由谁处理（U1-06c）；方法名和权限清单不进界面 |

## 分批

每批独立提交，提交前跑完本批的检查。

每批都要检查：`npm run build:web`；`npm run test:ui`，并把
`scripts/ui-acceptance.mjs` 的断言改成新文案；在 1600 / 1280 / 1024 / 768 / 390
五个宽度截图，与对应画板比对。验收脚本现在不测 768，第 1 批里补上。

| 批 | 内容 | 主要文件 | 完成条件 |
| --- | --- | --- | --- |
| 1 外观 | 颜色、尺寸、字号和字重 token；按钮、输入、标签、胶囊、面板样式；断点改为 1280 / 1024 / 768 | `web/theme.css` | 计算样式与规格画板一致，界面上不再出现 500 字重或黑色主按钮；验收脚本补测 768 宽度 |
| 2 工具栏与 rail | 去掉字标（未连接页除外）；位置文字加 Read-only；状态胶囊显示读取时间，进行中写 "Connecting"；rail 高亮规则；Unpair 改名 "Disconnect this tab"，移到上下文面板和命令面板，先确认；启动器 `--open` 打开一次性链接，取代人工配对 | `web/main.tsx`、`src/cli.ts` | 在线、离线、未知三种状态各一张截图；确认框可用 Esc 取消，焦点回到触发按钮 |
| 3 首页 | Welcome 标题；新建 / 打开改为弹出面板，带固定前缀和替代操作；相对时间；去掉 "paired root" 等配对用语。配对卡片和失败状态已取消，改为第 2 批的 Agent 链接 | `web/main.tsx`，可拆出 `web/home.tsx` | 对照 U1-02、03、03b；面板内焦点不跑出去；错误信息里附带下一步操作 |
| 4 项目内 | 侧栏改为 Layouts / Files，0 不显示；概览 "No saved layout yet"；用标签页替代 select；不可用视图写 Shows / Needs / In this build，并给出 About 入口；上下文栏三段 | `web/main.tsx`、`web/workspace.tsx` | 对照 U1-04、05；主视图不出现 JSON，引用只在 View reference 折叠里 |
| 5 断线与命令 | 灰色提示条，保留已读内容；命令面板加输入框、分组和页脚；Show / Hide 动词随状态变化 | `web/main.tsx` | 对照 U1-07、08；Reconnect 只重新读取，不会启动工作 |
| 6 窄屏 | <768 去掉 rail 和侧栏；导航改为抽屉，上下文改为底部面板；工具栏 48，点击区 36 | `web/main.tsx`、`web/theme.css` | 对照 U1-09a–c；390 宽度下页面不横向溢出，两个弹层都能困住焦点并归还焦点 |
| 7a 插件页临时版 | 把 "Capabilities & access" 改名为 Plugins；去掉 Present / Enabled / Satisfied 和方法名；能用时不写状态，不能用时写一句原因 | `web/main.tsx`，拆出 `web/plugins.tsx` | 对照 U1-06c；界面上不再出现 Capabilities 字样 |
| 7b 插件页完整版 | 目录、详情、提示词复制、能做的事、Views、Information；从项目点 About 进入时显示该项目的开启状态，返回时回到原项目 | `web/plugins.tsx` | 对照 U1-06、06b、06d；所有展示文案都来自 descriptor |

## 阻塞与待定

- 7b 需要 Rho-plugins 先在 descriptor 里加上显示名、标语、分类、示例提示词，以及动作和视图的显示名，发布后 Rho 再更新所引用的版本。在此之前只做 7a；如果需要临时文案，必须标明来源，不能写进组件。
- 规格画板上还有四个待确认问题：
  - a：启动器能否加一行人类可读的输出。已不适用：人不再读启动器输出，Agent 使用 `openUrl` 或 `--open`；
  - b：断线后是否自动重试；
  - c：配对失败能否区分原因。已不适用：链接失效时统一显示 "This link has already been used"，其他失败显示服务端原文；
  - d：项目列表能否带上次打开时间和路径。
  确认之前，按画板写的退路实现：失败原因不区分，时间缺失时只显示名称和路径。确认之后，再补上对应的状态。
- 每批完成后，更新 [Status](STATUS.md) 和 [U1 browser checks](UI-ACCEPTANCE.md) 的证据。设计稿与实现有出入时，先改画板并在规格画板上记一笔，不在代码里另行定一套规则。
