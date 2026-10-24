# 交互模型实施计划（草案 0.1）

- 日期：2026-10-24
- 状态：待评审。把[交互模型](INTERACTION-MODEL.md)从“一份轨迹上的一组规则”推进到
  “可以进入高保真设计”，并规定中间每一步改哪里、怎样算完成、谁来做。
- 依据：[交互模型](INTERACTION-MODEL.md)、[Agent 行为账本](AGENT-LEDGER.md)、
  [产品设计](DESIGN.md)、[设计完成条件](DESIGN-PRIORITIES.md#每项设计的完成条件)、
  现有代码，以及 `work/agent-exp-2215` 留下的记录。
- 读法：第 1 节的不变量每一步都要守；之后每个阶段自成一段，可以单独交给一次会话
  或一个人。开工前先读第 1 节和自己那一段，不必读完全文。

## 0. 目标、终点与不覆盖的范围

要回答的还是那三个问题：什么始终稳定；什么随 Agent 的工作自然变化；什么值得占据
屏幕、什么退到历史和详情。目前的回答见交互模型和第 2 节：工作区内“谁动屏幕”答得
较实，发现、解释、人向 Agent 的往返、量变大以后怎样收敛，基本没答。

终点是第 5 节的门槛：三个问题都有**规则 + 测试 + 回放里可见的一刻**，并且被至少
一个真人、两种任务类型验证过。到那时才进入高保真视觉设计。

这份计划不覆盖：导航结构与多项目切换、多 Agent 编队（账本 §6.4）、桌面窗口、
色彩与字阶。它们等交互模型定下来再排。

## 1. 不变量：每一步都要守的六条

这六条是防止一步步做下去走样的机制，比任何单个阶段都重要。

1. **一个规则源。** 屏幕怎样随事实变化，只写在 `src/expression.ts`。回放、测试、
   以后的 WebUI 都调用它。组件里不另写“这时该不该跟过去”的判断；现在散在
   `web/workspace.tsx`（焦点 effect）和 `src/task-map.ts`（建议与节流）的两套，
   在 S7 收进来或被它取代。
2. **三联。** 每条规则同时存在于三处：交互模型里一句话、`test/expression.test.mjs`
   里一个测试、回放里能定位到的一步（文档写成“#N 时…”）。改任何一处必须改另外两处；
   评审只按三联核对，缺一处不算改完。
3. **事实先于声明。** 对象只从所有者记录生成：documents、operations、resources、
   contexts、activity、task-map、compositions。Agent 的 `task.map.declare` 是叠加层，
   只认它的显式引用（`artifact`、`view`、`from`），不从标题和摘要推断关联。
   新的对象种类要先写明事实源（哪个所有者的哪条记录、哪个字段），没有就不进模型。
4. **没有记录就写“未记录”。** 不显示 0，不填默认值，不用相邻的记录猜。
   时间尤其如此：没有记录时间的事实只给前后区间，节流按早算。
5. **跨所有者的改动先登记再做。** Rho 只改自己的东西：服务端事件、Rho 拥有的契约
   （`task.map.*`）、`web/`、`src/`。`recordActivity` 的内容属于 Rho-plugins 的
   agent 插件，`detailsRef` 属于原生适配器。每个阶段的表里标明所有者；
   Rho 这边不用猜测补上所有者没记的事。
6. **词汇固定。** 注意力三态 `following / working / away`；六个原语
   Respond / Focus / Compose / Connect / Reveal / Revisit；对象种类 source / run /
   artifact，加上本计划新增的 question 和 item；人的动作种类以 `PersonIntent` 为准。
   新词先进交互模型，再进代码。

每一步的固定动作：

- 开工：读本节和自己的阶段；`npm run check:replay`；打开 `npm run prototype:replay`
  走一遍该阶段涉及的场景，知道改动前屏幕长什么样。
- 收工：三联齐全；`npm run check:replay` 和带 `RHO_CORE_BINARY` 的 `npm test` 通过；
  回放在 1440 和 1024 宽各截一张图留在 `work/` 下；[状态](STATUS.md) 加一段且不超过
  300 行；涉及布局的改动按 [AGENTS.md](../AGENTS.md) 先在 Paper 留一页给用户审阅；
  提交信息按仓库惯例写清检查结果。

## 2. 事实底账

计划建立在下面这些已核实的事实上。它们决定了阶段的顺序。

| 事实 | 出处 | 对计划的影响 |
| --- | --- | --- |
| Rho 自己记录每一次**到达它的**调用：时间、方法、返回或被拒、拒绝类型，以及出现时的 operationId / documentId / contextId / returnedVersion。不记 `document.open` 打开的文档、`data.page` 的资源身份和 `action.output` 的流；布局身份可由 returnedVersion 查合成历史。agent 适配器本地拒掉的调用不在其中（本轨迹 4 次，S2 核实） | `project/.rho/rho/activity.json`（62 条）；`plugin-agent/dist/index.js` 的 `recordActivity`；Rho-plugins `plugins/agent/src/layered.ts` | S2 的时间源改用它，“没记录时间的调用”从此消失；读产物的对象身份要等 Rho-plugins 补记，补上之前显示“未记录” |
| 这份记录只有调用方本人能读（`binding.activity` 按 principal 过滤），浏览器读不到；读操作也不发事件 | `src/server.ts` `binding.activity` 分支；`events.json` 只有 8 种事件 | S7 需要服务端把活动暴露给浏览器，这是 Rho 自己的改动 |
| 浏览器每收到一个事件就重取整份快照；快照含 documents、operations、resources、contexts、taskMap、compositions、interactions 等 | `src/observation.ts`；`observation.snapshot` 的输出 | S7 的折叠输入就是快照，不需要新的推送通道，只缺活动一项 |
| `task.map.declare` 的事项已经可以引用对象：`artifact {id, version}`、`view`、`from`（分支边）、`progress`、`group`，以及 `lines[].judgment` 区分判断与陈述 | `protocol/operations/task.map.declare.json` | S3 不需要改契约，只需要规则和指导文本 |
| 项目里的事项已有两条真实引用了产物版本（验收脚本在 18:19:12 补的） | `project/.rho/rho/task-map.json` | S3 有真实数据可用 |
| 解释已有载体：`rho.agent-note` 视图，标签 “Agent note”，绑定作者和依据见证 | `src/presentation.ts:178-186` | S3 的“解释”不新造对象 |
| 人向 Agent 的往返有真实记录：`questions.md` v2、v3，两条上下文，一条被取用（18:19:25）、一条未取用并带两行选区 | `project/.rho/rho/contexts/*.json`；`events.json` 51–64 | S1 直接用；但取用方是验收脚本以 `session.grant` 扮演的 Agent，不是模型 |
| Agent 对问题的回应没有通道：上下文只记取用，回应只存在于注解类反馈 | [状态](STATUS.md) “Not done” 一段 | question 的 `responded` 态在 S1 里只能定义、不能到达 |
| 第一份轨迹是逐条手动驾驶的：一次真实 MCP 会话，由一个 Claude 会话一次发一个调用 | `work/agent-exp-2215/drive.mjs` 头部注释 | “事项最后才声明”可能是驾驶方式造成的；S4 用 `scripts/agent-experiment.mjs` 真正跑 Claude Code 再录一份 |
| 回放里主区移动 13 次，61 次调用中 22 次退到展开里 | `express()` 对现有轨迹的结果 | 第 3 问的“调用这一层”有数字，“规模与时间”没有 |
| 跟随状态下，Agent 的布局会把人已打开视图的版本换成新版本 | `express()`：人打开 run 1 的图后开启跟随，#54 后视图绑定变为 run 5 | 与交互模型 §1“对象身份不被静默换掉”冲突，S0 裁决（已按默认 B 修正） |

## 3. 阶段

| 阶段 | 回答哪一块 | 主要产出 | 估计 |
| --- | --- | --- | --- |
| S0 跟随与版本 | 问题 1：对象身份 | 一条规则的裁决 | 0.5 天 |
| S1 人向 Agent 的往返 | 问题 1：控制权；问题 2：发现的起点 | question 对象、提问动作、真实取用回执 | 1–2 天 |
| S2 活的折叠 | 账本 §5；问题 3 的证据层 | 从 Rho 记录建轨迹、Reveal 面板 | 2–3 天 |
| S3 事项、发现、解释 | 问题 2：发现、解释、关联 | 事项引用对象的规则、Agent 指导文本 | 2–3 天 |
| S4 第二份轨迹 | 全部：规则能否推广 | 自主运行的 Claude Code 轨迹 | 1 天 |
| S5 规模与时间 | 问题 3 | 收敛与退场规则 | 1–2 天 |
| S6 真人验证 | 全部 | 修订清单 | 0.5 天 + 每人 30 分钟 |
| S7 接入 WebUI | 把规则变成产品 | 一个规则源驱动真外壳 | 3–5 天 |

估计只用于排序，不是承诺。S1 和 S2 可以并行；S3 依赖 S2 的轨迹；S5 依赖 S4 的
第二份轨迹；S6 在 S5 之后；S7 最后。

### S0 跟随与版本

- **问题：** 人打开了某个版本的视图，之后开启跟随，Agent 的新布局能不能把这个视图
  换成新版本？
- **三个选项：**
  A. 跟随即同意更新：视图跟着换版本，但留下“回到之前版本”的入口。
  B. 人打开过的视图版本固定；Agent 的新版本进预览位，人的视图上出现“有新版本”的
     入口。与[产品设计](DESIGN.md)“live composition retains exact resource references
     and versions until an explicit update”一致。
  C. 只有 pin 过的视图固定，其余随跟随更新。
- **建议：** B。它不要求人预先 pin，也不让“跟随”这个开关附带改变对象身份。
- **改动：** `src/expression.ts` 的 `arrange()` 和 `show()`；交互模型 §1 加一句；
  测试：`express` 在上述场景下，人打开的视图保持 run 1，新版本出现在预览位。
- **完成判据：** 三联齐全；回放里人打开 run 1 的图再跟随，#54 之后能看到两种版本并存。
- **状态（2026-10-24）：** 按默认 B 实现，待用户确认。视图有了独立于对象的 id，同一
  产物的两个版本可以并存；新增人的动作 `update`（“New version”入口）。回放场景
  “Open run 1's figure at #16, follow”；测试另用一条构造的读（真实运行没有读过图）
  覆盖焦点路径。

### S1 人向 Agent 的往返

- **回答：** 人能否在对象上直接提问，问题是否锚定在确切版本上，取用回执怎样显示，
  以及回执之后不再声称任何事。
- **事实源：** `contexts/*.json`（`delivery`、`fetchedAt`、`resource.reference` 与
  `rows`、`document.source` 指向 `questions.md` 的版本）、`questions.md` 的文档历史、
  `context.changed` 事件及其 principal。
- **改动（全部 Rho）：**
  - `prototypes/replay/build-trace.mjs`：读入上下文和 `questions.md`，产生两类新事实：
    `ask`（作者是浏览器 principal）和 `fetched`（作者是取用方）。`Fact.actor` 从
    只有 `agent` 扩成 principal 身份；界面上的“Agent”从绑定表取名字。
  - `src/expression.ts`：新对象种类 `question`，状态 `prepared → fetched`，
    `responded` 只在存在显式关联时出现（本轨迹里没有）。`PersonIntent` 新增
    `ask { target, rows, text }`，用于回放里模拟提问。Connect：问题挂在它锚定的
    对象和版本上，版本更新后不移动。Respond：回执更新问题出现的每一处。
    Supervise：取用不是升级，不打断。
  - 回放：新场景“在 #20 选两行提问，#x 被取用”，用真实记录；标明取用方是脚本。
- **三联：** 交互模型 §3 Connect 行写入 question；测试“问题留在被问的版本上，
  版本更新后不移动；取用回执不生成任何后续工作的声称”；回放步骤编号写进 §5。
- **完成判据：** 第 6 节五个问题中的第 3 问能在回放里回答；真实的两条上下文都能
  在回放里找到并点开。
- **待决（第 4 节第 7 条）：** 回应通道。没有它，`responded` 永远到不了。
- **状态（2026-10-24）：** 已完成。轨迹从 61 个事实变成 66 个（S3 后是 69 个，下面
  这几条顺延为 #64–68）：#61–65 是 18:19 的
  两次提问（各带 `questions.md` 的一次修改）和一次取用，每条带 principal；run 的
  Agent 由“授权方法与连接一致”的那个 principal 确定，取用同时在 activity 里核对。
  显示名沿用 WebUI 的 `authorLabel`（You / The Agent / Someone in another tab），
  回执例外，写绑定名，因为同一项目可能绑了不止一个 Agent。场景名
  “Ask about two rows at #20”；脚本提问在回放里看得到，但不是这个场景的一部分。

### S2 活的折叠

这是账本 §5 的“第一片”，两份文档指向同一个实现。

- **回答：** 账本的五条投影 Given / Did / Read / Produced / Refused 能否从 Rho
  自己的记录折出来，而不是从实验适配器的 `calls.jsonl`。
- **事实源：** `activity.json`（时间、方法、结果、拒绝类型、已记的身份）、
  documents 历史、operations 记录、resources 注册、contexts、task-map、compositions。
- **改动：**
  - Rho：`src/trace.ts`，纯模块，输入是快照形状的所有者记录，输出 `Trace`。
    `build-trace.mjs` 改为调用它，并对照 `calls.jsonl` 做一次等价检查：两边都有的
    事实，顺序和时间必须一致；只有 `calls.jsonl` 有的（资源身份、布局身份）标“未记录”。
  - Rho：回放加 Reveal 的五条投影视图，每一格可点到产生它的记录；缺事实显示“未记录”。
  - Rho-plugins（登记，不在本阶段做）：`recordActivity` 补记 `resource.id/version`
    和 `compositionId`。补上之前，`data.page` 在回放里只显示“读了一个产物（未记录是哪个）”。
- **三联：** 交互模型 §1“什么只在需要时展开”加入五条投影；测试“从 Rho 记录建的
  轨迹与 calls.jsonl 建的轨迹在共有事实上一致，且每条事实都有记录时间”；回放 #44 的
  Reveal 截图。
- **完成判据：** 账本 §5 写的那条：给定这个项目，一屏能回答“第 44 步时它给了什么、
  做了什么、读了什么、产出了什么、被拒了什么”，7 次拒绝按 `stale 2 / invalid 3 /
  condition 2` 分组。

- **状态（2026-10-24）：** 已完成，完成判据按核实结果改写。`src/trace.ts` 的
  `fold()` 从 `prototypes/replay/trace/records.json`（build-trace 从所有者记录抽出的
  精简版，不含图片和本机路径）折出 `Trace`，`align()` 把它和转录逐条对上，`ledger()`
  折出五条投影；回放对象列表底部的计数点开就是账本面板。等价检查放在
  `test/trace.test.mjs`：共有的 57 个事实操作、结果、拒绝类型、顺序一致，所有者时间
  从不晚于调用记录时间，效果只在 Rho 没记的身份上为 null。**7 次拒绝只能折出 3 次**
  （stale 2、condition 1）：invalid 3 和 condition 1 是 agent 适配器本地拒掉的，
  从未到达 Rho；账本 §5 的“按 stale 2 / invalid 3 / condition 2 分组”只有转录能做到。
  反过来，Rho 记下了转录没有的 4 次调用（一次更早的探测、验收脚本的 3 次）。
- **登记（不在本阶段做）：**
  - Rho-plugins agent `recordActivity`：`document.open` 记结果里的 documentId，
    `data.page` 记 `resource.id/version`，`action.output` 记 `stream`。
  - Rho-plugins agent 适配器（`layered.ts`）：本地拒绝要进 Rho 的活动记录，否则
    Refused 永远少一块；由谁写、写到哪，按[架构](ARCHITECTURE.md)的 owner 表定。
  - Rho 自己：服务边界按 schema 拒掉的请求在 `recordActivity` 之前就返回
    （`src/server.ts` 的 `readOperation` 先于 `serial`），同样不进记录；S7 前修。
  - Rho 自己：任务地图只留最新事项，早先声明的内容不留；要不要留历史，S3 定。
  - 输出文本在原生存储，项目记录只有退出码和字节数；升级理由只能写“Exit N”。

### S3 事项、发现、解释

- **回答：** 发现和解释放在哪里，怎样和事实分开，事项怎样把对象收进去。
- **规则（全部只认显式引用）：**
  - 引用了 `artifact` 或 `view` 的事项，收集那个对象的事实：运行、版本、核验。
    事项的 `lines` 里 `judgment: true` 的行显示为 Agent 的判断，其余为它的陈述；
    两者都不是 Rho 的事实，不用绿色。
  - `from` 边画成分支；没有 `from` 的事项不连线。
  - 没有任何引用的事项仍然只是一份清单，和现在一样。
  - 解释 = `rho.agent-note` 视图，挂在它的依据见证所指的对象旁。跟随时随对象一起
    出现；人在工作时和其他布局改动一样变成建议。
- **改动：**
  - Rho：`src/expression.ts` 新对象种类 `item`，以及 note 视图的处理；
    `build-trace.mjs` 读 `task-map.json` 里补过引用的两条事项。
  - Rho：`src/capabilities.ts` 的 `taskMapContent` 指导文本：开工先声明、边做边改、
    产出后立刻用 `artifact` 指过去、判断标 `judgment`。这是 Rho 拥有的文本。
  - 不改契约。
- **三联：** 交互模型 §2 的“事项”一行改写；测试“只有显式引用的事项收集对象事实；
  标题相同的对象不被关联”；回放 #60 的截图里两条事项带着产物链接。
- **完成判据：** 第 6 节第 2 问（结果的来源）能从事项出发两步到达运行和源版本。
- **待决（第 4 节第 5 条）：** “发现”要不要成为独立对象。

- **状态（2026-10-24）：** 规则部分已完成，解释留待 S4。`DeclaredItem` 带上显式引用
  （`artifact` 解析成那个文件、那份字节、那次运行；`view`、`from`、`lines`），
  `collect()` 只经引用收集，`itemsOn()` 把事项放到它指的版本视图上，点开事项落在那个
  版本。回放 #61–63 是验收脚本的 Agent 重新声明（来自 Rho 记录，经同一个 `fold()`），
  `run`、`figure` 两项可点开，Run 5 再一步到 `analysis.R` v9。`src/capabilities.ts`
  的任务地图指导加了 5–7 条：开工就声明并随工作重声明、核验后立刻用 `artifact`
  引用、分支用 `from`、判断标 `judgment`。事项没有升格成对象种类：它们仍是 Agent 的
  清单，引用在 `collect()` 里解析；需要它们参与 Respond / Revisit 时再升格（离开期间
  事项内容变了，摘要现在按内容比较）。`rho.agent-note` 没有任何记录，规则写进了
  交互模型，代码等 S4 录到。
- **默认值：** 第 4 节第 5 条按默认（不独立成对象）实现。

### S4 第二份轨迹

- **回答：** 规则是否只适用于“一个脚本、五次运行”的数据分析；事项是否真的总在
  最后才声明。
- **做法：** 用 `scripts/agent-experiment.mjs` 的路径真正跑 Claude Code（`claude
  --print`，MCP 只给 rho），任务换一种类型：建议是“改一段代码让失败的检查通过”或
  “整理一份文档并给出引用”。方法授权含 `task.map.*`，提示词只说明任务，不教它
  先声明事项；S3 的指导文本是它唯一的指引。
- **记录：** 只依赖 Rho 自己的记录（S2 之后不需要 `calls.jsonl`）；`work/` 下保留
  原始输出。
- **完成判据：** 轨迹能建、回放能走；交互模型 §5 增加第二张回放表；规则有改动的
  按三联改，没改动的写明“两份轨迹下均成立”。

### S5 规模与时间

- **回答：** 量变大以后什么退场、什么合并、什么值得打断。
- **规则草案（在两份轨迹上定参数）：**
  - 同一源的运行折成一条链：最新一次 + 次数，展开才见全部。
  - 产物按名字列出，版本用圆点（已有）。
  - 连续 N 条事实没被触碰的对象退到“更早”组；N 是参数，默认值在 S6 后定。
  - 升级的触发只有两种：人在等的运行失败或未知；Agent 发出需要人决定的请求
    （目前唯一有事实的是建议的 `cause: pinned`）。
  - 离开太久的摘要封顶：按对象合并，不按事件列。
- **三联：** 交互模型 §4 增加规模一节；每条规则一个测试；回放里用第二份轨迹截图。
- **完成判据：** 两份轨迹的对象列表在 1024 宽下不滚动即可看全当前组。

### S6 真人验证

- **做法：** 一个真人，不读交互模型，看着回放完成交互模型 §6 的五个问题。
  三个场景各走一遍：全程跟随、从中途开始工作、离开再回来。记录“此刻你看到了什么，
  想做什么”，以及卡住的点。不解释界面。
- **产出：** 修订清单；每条修订按三联落地，或写明为什么不改。
- **完成判据：** 五个问题各有至少一次不需要旁人解释就答对的记录；答错的有修订。

### S7 接入 WebUI

- **回答：** 同一套规则驱动真正的外壳。
- **改动：**
  - Rho 服务端：把 Agent 的活动暴露给浏览器——快照里加 `activity`（按项目、
    带 principal），活动变化发事件。这是 `binding.activity` 之外的新读法，授权
    边界要写明：浏览器只读本项目绑定的 principal 的活动。
  - Rho 外壳：`src/trace.ts` 从快照折出 `Trace`；`express()` 的 `Screen` 驱动
    工作区的激活视图、预览位、建议条、升级条和摘要。删除 `web/workspace.tsx`
    里的焦点 effect；任务地图的建议与节流保留在服务端作为写入侧的保护，
    外壳的“动不动主区”只由 `express()` 决定。`view.protection.set` 不变。
  - 验收：扩展 `scripts/ui-acceptance.mjs` 或执行验收——脚本驱动的 Agent 跑一次
    真实运行，检查跟随者的主区按规则移动、工作者的不动、重连后有摘要。
  - 设计评审：动布局前，在 Paper 留一页“回放原型 · 行为”，内容是回放截图与规则编号，
    由用户审阅；不重画。
- **完成判据：** 浏览器验收通过；交互模型 §1–§4 的每条规则在真外壳里有对应的
  验收检查；STATUS 更新。

## 4. 待决清单

每条写明建议的默认值和必须决定的阶段。没决定之前按默认值做，并在文档里标“默认”。

| # | 问题 | 建议默认 | 必须在 |
| --- | --- | --- | --- |
| 1 | 跟随时人打开的视图版本是否更新 | 不更新（S0 的 B） | S0 |
| 2 | 读算不算注意力 | 算，但只产生标记和预览位，不单独打断 | S2 |
| 3 | 跟随默认开不开 | 项目打开且有活的绑定、人尚未输入时为开；一输入就转工作 | S7 |
| 4 | “工作”怎样判定 | 最近有输入或当前视图被 pin；时间阈值等 S6 之后定 | S5 |
| 5 | “发现”是不是独立对象 | 不是：带 `artifact` 引用且有 `lines` 的事项，显示为“Agent 关于 <产物 vN> 的说法” | S3 |
| 6 | 活动记录到什么粒度（账本 §6.1） | 本计划只需要对象身份，不需要参数和结果 | S2 登记时 |
| 7 | 问题的回应通道 | 未定；候选：注解回复、带上下文 id 的文档改动、新的显式关联 | S1 后、S7 前 |
| 8 | 8 秒节流是否同样用于视图 | 是，已按此实现 | 已按默认 |

## 5. 进入高保真的门槛

三个问题各自满足以下条件，才开始画高保真：

- **稳定：** S0 裁决落地；人的视图、选区、pin 在两份轨迹和真人验证里都没有被 Agent
  改过；四个控制入口（停下、接管、撤消、提问）在回放里都在原处可用。
- **变化：** 焦点、布局、对象状态、事项、解释、问题六类变化都只由 `express()`
  产生；两份轨迹下规则成立；发现和解释能从对象出发两步到达来源。
- **占据屏幕：** 调用这一层（展开里的比例）和规模这一层（折叠、退场、升级）都有
  规则和数字；真人验证里没有人为了找东西而打开展开面板。
- **共同条件：** 三联无缺口；`npm run check:replay` 与全套测试通过；S6 的修订清单
  清空或写明不改的理由。

满足之后，高保真设计以回放截图为底，按[设计完成条件](DESIGN-PRIORITIES.md#每项设计的完成条件)
交付，评审仍按三联核对。

## 6. 产出物与归属

| 文件 | 角色 | 所有者 | 阶段 |
| --- | --- | --- | --- |
| `docs/INTERACTION-MODEL.md` | 规则的唯一文字来源 | Rho | 每阶段 |
| `src/expression.ts` | 规则的唯一实现 | Rho | 每阶段 |
| `test/expression.test.mjs` | 规则的测试 | Rho | 每阶段 |
| `prototypes/replay/` | 规则可见的地方 | Rho | 每阶段 |
| `src/trace.ts` | 从所有者记录折出 `Trace` | Rho | S2，S7 复用 |
| `src/capabilities.ts` 的 `taskMapContent` | 给 Agent 的事项指导 | Rho | S3 |
| `scripts/agent-experiment.mjs` 或其变体 | 录第二份轨迹 | Rho | S4 |
| `src/server.ts`、`observation.snapshot` 契约 | 活动暴露给浏览器 | Rho | S7 |
| `web/workspace.tsx`、`web/main.tsx` | 用 `Screen` 驱动外壳 | Rho | S7 |
| `recordActivity` | 补记资源与布局身份 | Rho-plugins | S2 登记，S7 前完成 |
| `detailsRef` | 原生活动的参数与结果 | 原生适配器 | 本计划不需要 |
| `docs/STATUS.md` | 每阶段一段 | Rho | 每阶段 |

## 7. 与其他文档的分工

- [交互模型](INTERACTION-MODEL.md)写规则本身；本计划写顺序、归属和完成判据；
  [账本](AGENT-LEDGER.md)写事实源和投影。三者引用同一个实现，不各自再写一份规则。
- 账本 §3 说 Rho 不记 Did、§4 说读不进事件流：按第 2 节的核实，Rho 记了每次到达它的
  调用的方法、时间、结果和部分身份（`activity.json`），读也在其中；缺的是资源身份、
  适配器本地拒绝和浏览器可读性。账本 §5 的完成条件（7 次拒绝按三类分组）只靠 Rho
  的记录做不到，S2 折出的是 3 次。账本下次修订时请按此更正。
- [状态](STATUS.md)只记每阶段做到哪，不重复规则。
