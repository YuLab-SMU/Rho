# Agent 行为账本（草案 0.1）

- 日期：2026-10-25
- 状态：待评审。回答“Rho 用哪些事实描述 Agent 的行为，哪些事实 Rho 没有”。
- 依据：[dsh-context](https://github.com/bowenliang123/dsh-context) 源码（`/tmp/dsh-context-ref`，27k 行）、
  [交互模型](INTERACTION-MODEL.md)、[架构](ARCHITECTURE.md)、一次真实运行
  `work/agent-exp-2215`（61 次调用）、`work/phase1-native-artifacts-20261021` 的原生观察账本。
- 结论先写：参考实现的地基值得学，**但它一半的卡片 Rho 学着做就会变成编造**；
  能学的那一半，Rho 已有的证据比它强。
- 更正（2026-10-24）：第 2、3、4、5 节里关于“Rho 记不记调用”的几处，按
  [交互模型实施计划](INTERACTION-PLAN.md) S2 的核实结果改过：Rho 记了每次到达它的调用
  （`activity.json`），但 agent 适配器在本地拒掉的调用不在其中，读操作的对象身份也没记。
  第 5 节的第一片已由 `src/trace.ts` 做出。

## 0. 参考实现到底做了什么

它不是一个“面板”，而是一条数据通路：**会话日志是唯一事实源，界面上每张卡片都是对日志的一次投影。**

| 它的做法 | 证据 |
| --- | --- |
| 从持久化日志折叠出视图状态，不把状态存在视图里 | `src/host/fold.ts`、`src/host/foldState.ts` |
| 折叠是**全函数**：未知事件原样返回，坏事件整条丢弃不留半截状态，从不写入 `undefined` 属性 | `docs/compatibility.md:46` |
| 缓存是派生的：版本号只在“后面的事件补不回来”时才升；过期行**从持久日志重新折叠** | `docs/compatibility.md:98-99` |
| 冷读有全进程闸门：FIFO、一次一个、只在 V8 堆低于 2/3 时放行；被跳过的读走调用方**设计好的无数据路径**，不报错；探针本身失败则放行（计量器不能阻塞读） | `src/host/coldRead.ts`、`docs/compatibility.md:100` |
| 缺字段 ≠ 零：`key` 不存在表示“更老的宿主，只有 token 没有成本”，而不是 0 | `src/shared/types.ts:13-17` |
| 归因靠**运行时插桩**，不是靠日志推断：读服务时所在 fiber 的名字就是即将 `register()` 的插件；只留名字不留 context，否则会把整个 agent 钉住 | `src/host/attribution.ts:1-8` |
| 不确定要写在界面上：`approximate`、`truncated`、`best-effort`，共 47 处 | `src/client/assemble.ts:11,67`、`src/client/i18nEn.ts:444` |

分母也要写清楚：它知道模型的上下文，因为它**自己就是组装上下文的人**。
system prompt、每个工具的 JSON schema、注入、压缩，都是 dsh 自己放进窗口的。

## 1. 这一条决定 Rho 能抄多少

Rho 的 Agent 是外部客户端。`@rho-workspace/plugin-agent` 的 README 写得很直白：
“The external client owns the conversation/model loop.” 原生观察入口也明确
“excludes model prose/reasoning”。

于是有一条硬边界：

| 它问的问题 | Rho 能不能回答 |
| --- | --- |
| 此刻窗口里装着什么（六色堆叠、占比、压缩余量） | **不能**。窗口在 Claude Code 里，Rho 从未见过 |
| 每次请求的价格、缓存命中、峰谷计费 | **不能**。除非客户端回报，且只能标为“客户端上报” |
| 压缩、裁剪、模型切换、plan-mode 切换 | **不能**。这些事件不经过 Rho |
| Agent 每个工具来自哪个插件/包 | **能，而且更准**：Rho 的边界自己就是来源 |
| 它对文件做了什么 | **部分能**，且现在**不能**（见第 4 节） |
| 谁在被拒、为什么被拒 | **能，而且它做不到**：它有异常，Rho 有类型化的拒绝原因 |

所以“近乎完整的映射”这句话要拆开：**它映射的是“模型窗口”，Rho 能映射的是“边界上的行为”。**
后者不是前者的缩小版，是另一种东西，而且对科学工作台更相关——
真正要回答的是“它读了哪个版本、改了哪个脚本、第几次运行失败、产物核验过没有”，
这些问题 Rho 有据可查，dsh-context 反而没有（它没有执行域）。

## 2. Rho 已经有的、比它强的证据

看一次真实运行（`work/agent-exp-2215`，61 次调用）：

| 事实 | Rho 怎么知道的 | 它怎么知道 |
| --- | --- | --- |
| 调用了哪个操作、属于哪个 owner | `rho_call` 的 `operation` + `contractRef` 摘要 | 只能按 `tool-*` / `dsh-*` / `mcp:<server>` 前缀**猜** |
| 为什么被拒 | 边界返回类型化原因：`stale` 2 次、`invalid` 3 次、`condition` 2 次。其中 `invalid` 3 次和 `condition` 1 次是 agent 适配器在本地拒掉的，没到 Rho；Rho 的 `activity.json` 只有 `stale` 2、`condition` 1 | 无此概念 |
| 给了它哪些技能和契约 | `rho_resolve` 响应的 `bundleRef`、`skillRefs`、`contractRef` | 从日志里认 `skill` 事件，且明说 best-effort |
| 它读的是哪个产物的哪个版本 | 资源 `id` + `version` + 摘要，在调用参数里；Rho 的 `activity.json` 不记 `data.page` 的资源身份 | 靠工具参数推断路径 |
| 运行是失败、完成还是未知 | 退出码状态机 + `operation.observed` | 无执行域 |
| 产物是声明、在盘、已核验还是领域未判 | 三类独立事实并列出 | 无 |
| 它是否取用过人的笔记 | `context.create` + 取用回执 | 无 |

一句话：**它必须插桩才能知道的事，Rho 的结构里本来就写着。**
这是 Rho 把这块做成地基而不是模仿品的理由。

## 3. 账本的五条投影

沿用参考实现的形状（纯折叠、可派生、缺字段不补零），只保留 Rho 能确证的部分：

| 投影 | 回答 | 事实源 | 现状 |
| --- | --- | --- | --- |
| **Given** 给了它什么 | 目录索引、解析出的 bundle、技能与契约摘要、资源版本、选区、问题原文 | `capability.index` / `capability.resolve` 响应、`context.create`、资源注册 | 有数据，无投影 |
| **Did** 它做了什么 | 操作、输入摘要、结果、耗时、字节数、被拒还是返回 | 边界调用记录 | Rho 的 `activity.json` 记了每次到达它的调用：方法、时间、结果、拒绝类型，以及出现时的 operationId / documentId / contextId / returnedVersion；**不记**参数、耗时、字节数，也没有适配器本地拒绝的调用 |
| **Read** 它读了什么 | 最近读、看、核验的对象（注意力的原料） | `document.open`、`data.page`、`action.lookup`、`action.output`、`artifact.check` | 读调用在 `activity.json` 里，但 `document.open` 打开的文档、`data.page` 的资源、`action.output` 的流都没记；**读不是事件，浏览器收不到** |
| **Produced** 产出了什么 | 运行、声明/在盘/已核验/领域、产物版本、来源 | `operation.*`、`artifact.check`、资源注册 | 有数据，视图只在项目页 |
| **Refused** 被拒了什么 | 按对象聚合的拒绝、重试、自我修正 | 调用记录的类型化原因 | 只散在回放轨迹里 |

`src/expression.ts` 的 `express(trace, actions, step) → Screen` 已经是这个形状：
61 条事实折叠成一屏。差别是它折叠的是**离线录制的一次运行**，
参考实现折叠的是**活着增长的日志**。这一步之差就是第 5 节的工作量。

**明确不做：**模型窗口占用、token 与成本、压缩事件。不是难，是没有事实源。
写进产品就会变成“Rho 声称知道 Agent 在想什么”。

## 4. 两个拦路的事实缺口

1. **`detailsRef` 一直为 `null`。** 原生观察账本（`work/phase1-native-artifacts-20261021/real-run-2/grades-a/.rho/plugins/agent/native.json`，
   25 条：`tool.requested` 12、`tool.returned` 10、`tool.rejected` 2、`artifact.ready` 1）
   记下了工具名、`nativeToolUseId`、时刻、结果，**没记参数也没记结果**。
   契约里 `detailsRef` 是必填可空，就是为了挂这个内容，但没人往里写。
   后果：参考实现最实用的那张 File Activity 卡（读了哪些文件、写了多少行）
   **Rho 现在做不出来**，做出来只能是猜。要做得先决定保留多少参数、保留多久、谁来删。
2. **读操作不进事件流。** 真实运行的 `events.json` 只有 64 条、8 种：
   `document.changed` 17、`interaction.selection.changed` 16、`task.map.changed` 9、
   `operation.accepted/delivery/observed` 各 5、`context.changed` 4、`composition.changed` 3。
   没有一条是“Agent 读了什么”。`tool.requested` 等只落在原生账本里，
   只有 `artifact.ready` 会变成服务事件（`src/server.ts:806`）。
   所以注意力只能从**操作记录**反推，不能从事件流观察。

另外，`calls.jsonl` 是实验适配器的证据文件，不是 Rho 的记录。Rho 自己的
`activity.json` 才是地基；S2 对照过：两边共有的 57 个事实操作、结果、顺序一致，
差在 Rho 没记的身份和适配器本地拒绝的 4 次调用上。

## 5. 第一片：先把折叠变成活的（不改任何所有者）

选一个小而可观察的流程，不新增事实源：

1. 把 `Fact` 的读入从 `work/agent-exp-2215` 抽到一个纯模块，
   输入是“Rho 已有的记录”（事件流 + 操作记录 + 文档历史 + 资源注册），输出同一种 `Trace`。
   `prototypes/replay/build-trace.mjs` 已经是这个程序，只是写死在实验目录上。
2. 按第 3 节的五条投影，从 `Trace` 折出 **Given / Did / Read / Produced / Refused**，
   仍然是纯函数、仍然可以逐步喂（`express(trace, actions, step)` 已经支持 `step` 截断）。
3. 四条工程规则照抄：全函数折叠、缺失不等于零、`approximate`/`truncated` 写在界面上、
   拒绝原因按类型分组而不是合并成“失败了”。
4. 在回放原型上加一屏，能看到某一步的这五条投影，以及它们的证据出处。

可观察的完成条件：给定 `work/agent-exp-2215` 的 61 次调用，
一屏能回答“第 44 步时它给了什么、做了什么、读了什么、产出了什么、被拒了什么”，
每一格都能点到产生它的那条记录；7 次拒绝按 `stale 2 / invalid 3 / condition 2` 分组；
任何一格缺少事实时显示“未记录”，不显示 0。

（S2 结果：只从 Rho 的记录折，拒绝是 `stale 2 / condition 1`；另外 4 次没到 Rho，
这个分组只有转录做得到。其余条件已满足，见回放的账本面板。）

**这一步不碰所有者**，因为输入全是已有记录、输出只是读。
之后再决定两个缺口谁来做：`detailsRef` 与读事件属于 agent 插件和服务边界，
按 [架构](ARCHITECTURE.md) 的 owner 表落，不在应用层伪造。

## 6. 未决

1. 账本记到哪个粒度：每次调用都留参数与结果，还是只留摘要 + 引用？保留多久、谁删。
2. 读算不算注意力（[交互模型](INTERACTION-MODEL.md) §7 待定第 3 条），
   以及读是否要脱敏。参考实现的结论是“算，因为它就是从读推断注意力的”。
3. 注意力从操作记录反推够不够，还是要读事件进事件流。
4. 多会话（business / presentation、多个 adapter）要不要做成参考实现的 Fleet。
   Rho 这边的“编队”是**登记的 binding**，不是推断出来的父子关系，这一点不要学它。
