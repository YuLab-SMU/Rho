# Rho Next 系统宪章与替换台账

> 状态：Active
>
> 最后更新：2026-09-05
>
> 当前阶段：N7 本机工作台、生成类型与共享 HTTP/MCP Host 已实现；接口/真实 R 已验证，浏览器交互与视觉、远程实测、生产切换仍待完成
>
> 适用范围：新底座、能力迁移、旧实现退役
>
> 事实优先级：可复现运行结果 > 源代码 > 本文档 > 讨论记录

Rho Next 的定位：站在成熟工具之上的薄科学工作空间协调层。Operation 串联动作，各领域返回真实结果；不另造版本、审批、审计或 Agent 行为系统。

## 1. 文档职责

本文档是 Rho Next 替换工作的唯一长期入口，同时承担三种职责：

1. 系统宪章：记录所有新代码必须服从的稳定原则。
2. 目标地图：描述下一代底座的边界、信息流和契约。
3. 替换台账：记录 capability 所有权、里程碑、关键决策和阶段性验证。

本文档不是第二套代码事实，也不复制 Git 历史。Git 记录具体改动；本文档只记录：

- 为什么采用某项长期设计；
- 当前哪条能力由谁拥有；
- 哪些结果真实实现并验证过；
- 哪些旧实现已经可以删除；
- 下一项可执行工作是什么。

文档中的陈述必须属于以下一种：

- Target：目标设计，尚不能据此声称功能存在。
- Implemented：代码已经存在，但不代表运行验证通过。
- Verified：有本地可复现命令和结果支持。
- Retired：旧入口和实现已经不可达并删除。

禁止把 Target 写成当前能力，禁止用“应该可用”代替验证结果。
第 3—19 节描述目标边界；实际实现与验证范围以第 20—27 节为准。N1—N5、N6 的本机部分与 N7 的协议部分已有验证记录；远程实测、极简客户端的浏览器验收和生产切换仍未完成。确定性 fake runtime 只用于测试。

### 阅读导航

| 要回答的问题 | 阅读位置 |
| --- | --- |
| 我们到底在做什么，哪些东西坚决不做？ | [目标与非目标](#3-任务目标与非目标)、[系统宪章](#4-系统宪章) |
| 一次请求如何流动，各模块在哪里交接？ | [信息流](#6-两条公开信息流)、[依赖方向](#7-编译依赖与运行流向)、[提交边界](#11-handleradapter-与-commit) |
| 已经做到哪里，哪些旧代码可以删？ | [当前摘要](#2-当前摘要)、[里程碑](#20-里程碑)、[能力台账](#21-capability-ledger) |
| 为什么这样设计，什么还没有决定？ | [决策记录](#23-decision-log)、[待决问题](#24-open-decisions) |
| 如何接手工作，结束后记什么？ | [工作记录](#25-work-log)、[更新规则](#26-每次工作结束时如何更新)、[当前下一步](#27-当前唯一下一步) |

新加入的开发者先读目标、宪章和当前摘要，再按任务阅读相关契约；不必每次重读历史。
具体运行命令只维护在 [Next README](../next/README.md)，本页只引用阶段性验证命令。
现有 [架构文档](ARCHITECTURE.md) 和 `programs/rho-rebuild/` 描述旧系统，不是 Next 的进度来源。

### 接手一项工作的最短路径

1. 查看 Git 状态、[当前摘要](#2-当前摘要)与[当前下一步](#27-当前唯一下一步)，保留未完成的用户改动。
2. 在 [Capability Ledger](#21-capability-ledger) 找到本次范围，核对实际入口、共享资源和 owner；不从目录名称推断所有权。
3. 阅读相关源码、最近的验证证据和对应 N-D/N-O。每次只推进一个可运行的能力闭环；尚未决定的范围不能由实现者顺手扩大。
4. 用最接近改动的检查验证，按[最小记录模板](#最小记录模板)更新有实质变化的字段；未运行的测试和未切换的旧入口保持未完成。

本文档回答“为什么、到哪里、还缺什么”；代码回答“怎么做”，运行证据回答“是否有效”，Git 回答“具体改过什么”。不另设周报、审批表或平行进度数据库。

## 2. 当前摘要

| 项目 | 当前事实 |
| --- | --- |
| 总体状态 | 真实 Ark/R、Project/Git、环境计划/隔离安装/验证/新会话绑定及长期 CLI 已贯通；仍未替换旧生产入口 |
| 当前里程碑 | N7 Building；本机 HTTP/MCP 共用 Host，真实 R 与生成类型已验证；浏览器交互/视觉尚未验收，远程目标尚待指定 |
| 已完成生产切换的 capability | 0；独立 Next CLI 的可用能力不计为旧生产入口已切换 |
| 已退役的旧 capability 实现 | 0 |
| 旧系统策略 | 冻结为行为参考；不作为 Next 的代码依赖 |
| 前端策略 | 已实现本机浏览器客户端；纯 TypeScript、嵌入式静态资产和五端口，完整桌面仍延后 |
| 数据策略 | 无真实旧用户；放弃旧架构全部数据资产。Next 使用全新应用状态，不做迁移、导入、只读兼容或会话接力（N-D025） |

已提交检查点：N1/N2 `d0ba58b`，N3 `0abf441`，N4 `0f4c951`，N5 `e23bd05`，N6 本地执行 `56beff1`、Environment 恢复 `9ec0837`、无 R 的进程恢复 `9b0131f`、SSH/Slurm 协议 `2f9ce6b`、材料回收 `e1820f1`，N7 MCP `f4f502c`、本机工作台 `3e20d78`。
这些引用对应下方历史验证记录，不代表当前工作树已重新通过全部测试。
N6 的本地执行、取消、输出收集已在 Host/CLI 验证；Git 和 Environment 复用同一进程执行器。Environment 与普通本地命令分别通过真实 Host 强制退出验收；后者不需要 R，并覆盖脱离进程组的子进程。验证只覆盖本机可观察、保留标记的进程，不代表远程任务或任意逃逸方式也已覆盖。

Environment 实际验证入口：`node next/scripts/test-environment.mjs`。
当前已验证本机 R 4.5.2、pak 0.11.1、renv 1.1.8 与隔离本地 fixture；
没有据此声称远程仓库、全部包或所有平台都已验证。

已存在的操作说明见 [Next README](../next/README.md)，真实运行验证入口是
`node next/scripts/test-real-r.mjs`。普通 Cargo 测试明确跳过需要外部 R 安装的验证；
该验证必须单独运行，不能把 skipped 算作 passed。

## 3. 任务目标与非目标

### 3.1 目标

Rho Next 要成为一个薄的科学工作空间协调层：

- 使用一条不可绕过的 Command 信息流；
- 使用统一的 Operation identity、幂等和终态语义；
- 让各 domain 解释自己的状态和真实结果；
- 让 runtime adapter 只接触真实世界；
- 让一个事务边界提交 operation、domain fact 和待发布事件；
- 优先引用 Git、R、renv、filesystem、Slurm 等真实系统已有的 identity；
- 按 capability 逐项取得所有权，并立即删除已替代的旧实现；
- 随着迁移推进，总代码与概念数量持续下降。

### 3.2 非目标

Rho Next 不追求：

- 保持旧 crate、旧数据库或旧内部 API 兼容；
- 盘点、迁移、导入、只读挂载或恢复旧架构数据资产；没有真实旧用户，不为旧数据延续投入开发资源；
- 一次性移植所有旧功能；
- 在实现之前创建所有未来模块；
- 自建 Agent planning、model loop 或第二套用户审批；
- 创建独立的 audit、provenance、evidence 或 revision 宇宙；
- 把所有状态做成 event sourcing；
- 替代 Git、Ark、renv、pak、Pixi 或 Slurm 已经拥有的职责；
- 为尚无消费者的抽象预先设计完整框架；
- 在核心后端稳定前恢复完整桌面应用。

## 4. 系统宪章

以下规则是新底座的硬约束。修改它们必须新增一条明确的 Decision 记录。

1. Command 不等于 Query。
   会产生外部效果、需要幂等、取消、恢复或 reconciliation 的请求进入 Operation 生命周期。可重复、有限、无副作用的读取走 Query 路径。

2. OperationId 是唯一因果主线。
   Run、process、job、artifact 和 transport request 都只能作为 Operation 的子引用，不能各自成为互不关联的顶层身份。

3. Handler owns meaning；Foundation owns commit discipline。
   Domain Handler 判断 observation 的业务含义并形成 CommitPlan。Foundation 只保证合法生命周期与原子提交，不解释领域事实。

4. 真实系统拥有真实状态。
   Git 拥有项目版本历史，R 拥有当前 session 状态，renv 或其他 lockfile 拥有环境声明，filesystem 拥有当前字节，Slurm 拥有 job 状态。

5. Rho 只创造自己确实拥有的 identity。
   OperationId 是 Rho 的一等 identity。其他 identity 优先引用其真实 owner。

6. Preconditions 取代全局 Revision 模型。
   每个 domain 自己解释 Git HEAD、content hash、session ID、lock digest 或 scheduler state 等前置条件。

7. 一个 capability 任意时刻只有一个 owner。
   Legacy 与 Next 可以同时存在，但禁止同一 capability 双路执行或双写。

8. Edge 不包含业务流程。
   CLI、MCP、桌面和 Agent Gateway 只能认证调用上下文、转换 transport 并调用统一端口。

9. Adapter 不拥有 domain truth。
   Adapter 返回对真实世界的 observation；只有 Domain Handler 能解释 observation 并形成可提交事实。

10. 忠实观察不等于安全隔离。
    安全底座只保留 Identity、Containment、Observation。已经发生的危险动作不能靠事后日志补救。

11. 不完整必须显式。
    无法证明完整性的 observation、effect capture 或外部执行结果必须携带 completeness，必要时进入 uncertain。

12. 删除是迁移完成的一部分。
    新路径上线但旧入口仍可达，不算迁移完成。兼容层没有明确删除条件时不得引入。

13. 没有代码，就没有模块。
    不为远期功能创建空 crate、空 service 或占位框架。出现第二个真实消费者后再抽象。

14. 文档不替代约束。
    重要依赖方向、唯一入口和所有权规则必须由类型可见性、Cargo dependency 或 architecture test 强制执行。

## 5. 真相与身份

| 对象 | 真相 owner | Next 中保存或引用的内容 |
| --- | --- | --- |
| Operation | Rho Operation Journal | OperationId、caller、capability、状态、时间、结果引用 |
| Project history | Git | HEAD commit、必要的 parent、操作产生的 commit |
| Working tree | Filesystem + Git index | dirty/untracked 状态、path、content hash、diff 摘要 |
| 单个文件 | Filesystem / Git object database | path、Git blob 或当前 content hash |
| R runtime | 真实 R process | session ID、process handle、带时间的 observation |
| R Workspace | 真实 R session | object/package/options 等有限 observation；不伪装成完整版本 |
| R environment declaration | renv.lock 或选定环境工具 | lock digest、工具版本、目标平台 |
| R environment realization | 实际 runtime/library | 已安装集合与 verification observation |
| Artifact | 内容寻址存储 | content digest、大小、媒体类型、producing OperationId |
| Local process | OS | process identity、exit status、stdout/stderr observation |
| Remote job | Scheduler | Slurm JobID、scheduler observation、提交幂等标记 |
| Trace | tracing / 标准 Trace Context | 运行时诊断上下文，不作为业务 identity |

Git 只负责它实际知道的项目事实。未提交、未跟踪、被忽略文件和运行时对象不能伪装成 Git 已经记录的版本。

## 6. 两条公开信息流

### 6.1 Command / Operation

    UI / CLI / MCP / Agent
              |
              v
       Operation Gateway
       - bind caller identity
       - resolve capability
       - enforce caller scope
       - normalize input
       - enforce idempotency
       - allocate OperationId
              |
              v
         Domain Handler
         - check preconditions
         - prepare RuntimeAction
              |
              v
        Runtime Adapter
         - touch real world
         - return RuntimeReport
              |
              v
         Domain Handler
         - interpret
         - reconcile
         - produce CommitPlan
              |
              v
         Atomic Commit
         - operation state
         - domain facts
         - lifecycle event
         - outbox
              |
              v
       Result / Subscription

### 6.2 Query

    UI / CLI / MCP / Agent
              |
              v
          Query Gateway
       - bind caller identity
       - validate scope/input/bounds
              |
              v
       Projection or bounded
       live runtime observation
              |
              v
      Snapshot + observed_at
      + source + completeness

Query 默认不创建 Operation，不进入 timeline。若读取本身长时间运行、需要取消、需要恢复，或可能产生外部效果，则升级为只读 Operation。

## 7. 编译依赖与运行流向

编译依赖方向：

    host / edges
          |
          v
    concrete adapters
          |
          v
        domains
          |
          v
       operation
          |
          v
       contract

运行时调用方向：

    edge
      -> gateway
      -> registered handler
      -> domain port
      -> adapter
      -> runtime report
      -> handler
      -> transaction boundary

具体规则：

- contract 不依赖 Tokio、SQLite、Ark、Git、Tauri 或 domain。
- operation 不依赖具体 domain。
- domain 可以依赖 contract 和 operation，并定义自己需要的 port。
- adapter 实现 domain port；domain 不得 import adapter。
- SQLite adapter 实现 journal、query 和 transaction ports。
- host 是唯一知道 registry、handler、adapter 和 store 具体实现的地方。
- edge 只依赖 host 暴露的稳定端口。

## 8. 最小 Contract

### 8.1 Invocation

Invocation 是调用方可以提供的内容：

    Invocation
    - client_request_id
    - capability_id + version
    - arguments
    - preconditions

调用方不能自行声明 actor、target、effect、handler 或 OperationId。

### 8.2 CallContext

CallContext 由 transport edge 创建：

    CallContext
    - caller identity
    - optional authenticated principal (defaults to caller)
    - granted scopes
    - connection/session identity
    - optional correlation and causation
    - optional standard trace context

Gateway 可以机械地拒绝 caller 没有资格调用的 capability，但不得发起第二次用户审批。
Caller 记录实际执行者，principal 表示连接背后的账户；同一账户的 CLI/Agent 共享结果可见性，但不抹去 actor。principal 只能由可信 Edge 绑定，不能来自 Invocation 参数。见 N-D023。

### 8.3 CapabilityDescriptor

每个 capability 的注册项至少包含：

    CapabilityDescriptor
    - stable id
    - version
    - domain
    - input and output schema
    - target resolver
    - required caller scopes
    - potential effect hints
    - precondition contract
    - idempotency class
    - retry class
    - cancellation class
    - registered handler

Capability Registry 是唯一 capability 路由表。Gateway 中禁止出现不断增长的 capability match 分支。

### 8.4 Operation

Operation 由 Gateway 创建：

    Operation
    - OperationId
    - idempotency identity
    - caller
    - capability
    - resolved target
    - normalized argument digest
    - preconditions
    - potential effect hints
    - correlation / causation
    - accepted_at

### 8.5 Preconditions

Precondition 是 domain-owned 的开放集合，例如：

- Git HEAD 等于某 commit；
- 文件内容 hash 等于某值；
- R session ID 等于某值；
- environment lock digest 等于某值；
- artifact digest 存在；
- Slurm job 处于允许状态集合。

Gateway 只验证 precondition 的 contract 形状。Domain Handler 解释并检查其含义。

## 9. 幂等、生命周期与取消

### 9.1 幂等

幂等键定义为：

    caller identity + client_request_id

数据库必须具有唯一约束。同一个幂等键：

- 参数 digest 相同：返回原 Operation；
- 参数 digest 不同：拒绝为 idempotency conflict；
- 不得创建第二个 OperationId。

OperationId 永远由 Rho 分配。外部系统已有幂等键时，Domain Handler 应将 OperationId 或其稳定派生值传给该系统。

### 9.2 稳定状态

对外持久化状态保持很少：

    accepted
      -> running
      -> reconciling
      -> succeeded | failed | cancelled | uncertain

validated、prepared、submitted、observed、committing 等细节是追加式 OperationEvent，不扩张成大量可恢复状态。

规则：

- external effect 尚未开始的确定错误可以是 failed；
- external effect 可能已经发生但无法确认时必须是 uncertain；
- uncertain 必须带 recovery/reconciliation 提示；
- terminal 状态不可覆盖；
- 同一 Operation 只能有一个 terminal outcome。

幂等约束保证重复请求关联同一个 Operation，不等于任意外部效果都能 exactly-once。
R 执行或远程提交结果丢失时，先核对真实 owner，不能以“重试请求”之名再次执行。
后续 reconciliation 必须保留原 uncertain 结果；新的核对或修复记录引用原 Operation，不改写当时未知的事实。

### 9.3 取消

公开 API 使用 requestCancellation，而不是宣称 cancel 已完成。

取消流程：

    cancellation requested
      -> adapter acknowledgement or later observation
      -> cancelled | succeeded | failed | uncertain

发送取消信号不等于真实工作已经停止。

## 10. Effect 与 Observation

Effect 只服务于真实消费者，不发展成安全本体论。初始提示集合：

- needs_network
- may_write_project
- may_mutate_runtime
- may_spawn_process
- uses_secret
- produces_artifact

每个 capability 有保守的 potential effect hints。执行后记录 EffectObservation：

    EffectObservation
    - kind
    - source
    - detail or reference
    - observed_at
    - completeness

没有观察到某个效果，不代表该效果没有发生。只有 containment 或完整 supervisor 能证明的 effect domain 才能标记 complete。

任意 R eval 必须：

- 保守声明它可能具有的效果；或
- 在真实 containment 下执行。

不得通过静态扫描 R 字符串来推断安全性。

## 11. Handler、Adapter 与 Commit

标准 domain 操作：

    prepare(invocation, context)
      -> PreparedAction

    runtime_port.execute(PreparedAction)
      -> RuntimeReport

    reconcile(PreparedAction, RuntimeReport)
      -> CommitPlan

CommitPlan 至少能够表达：

- terminal operation outcome；
- domain-owned fact mutations；
- artifact references；
- effect observations；
- owner-native identity；
- recovery material；
- emitted events。

Handler 决定事实含义，但不能分别提交 operation、domain fact 和 event。Transaction runner 必须在一个数据库事务中：

    BEGIN
      apply domain fact mutations
      transition operation
      append operation event
      append outbox message
    COMMIT

CommitPlan 不应演变成全系统通用事实本体。每个 domain 保留自己的 typed commit payload；Foundation 只要求它能在统一 transaction boundary 内应用。

对数据库外的内容，例如 artifact bytes：

1. 先写入临时或内容寻址 staging；
2. CommitPlan 原子提交引用；
3. 未被引用的内容由回收过程清理。

## 12. Persistence

Next 初始只需要一个 SQLite 数据库和少量表：

| 表 | 用途 |
| --- | --- |
| operations | 当前 Operation 状态与幂等唯一约束 |
| operation_events | 追加式生命周期事实 |
| outbox | 与事实同事务提交、尚待投递的事件 |
| workspace_sessions | 必要的 session metadata，不复制完整 R 状态 |
| domain-specific tables | 只有真实 capability 需要时才创建 |

明确禁止：

- 第二套 SemanticStore；
- audit_events 与 operation_events 双写；
- 从 event replay 重建世界上一切状态；
- 为 UI 再维护一套权威数据库；
- 在新旧数据库之间持续双写。

operation_events 是运行历史，不是全量 Event Sourcing。Domain 当前事实可以直接存储并在同一事务更新。

SQLite 的原子性只覆盖数据库内的记录和引用，不会把 Git 工作树、R 内存、包安装或 Slurm 提交变成同一个可回滚事务。外部效果成功但记录失败时，必须保留可恢复材料并核对 owner。

tracing 用于诊断，不替代持久化 Operation 结果；采样、丢失或关闭 exporter 不能影响业务结果查询。
Outbox 的原子提交也不等于事件只投递一次：客户端按事件 identity/cursor 去重，断线后可重新读取快照；不能因没有收到通知就判断操作未执行。

## 13. R Runtime 边界

初始只创建一个 R bridge：

    r/bridge
    - execute
    - inspect
    - help
    - lint
    - format

Rust transport 只有一个入口：

    rho_dispatch(request)

一个入口仍然必须是 typed protocol：

    BridgeRequest
    - protocol_version
    - request_id
    - action enum
    - typed payload

    BridgeResponse
    - request_id
    - outcome
    - value
    - conditions
    - runtime observations
    - output references
    - completeness

R bridge 不知道：

- Operation lifecycle；
- Store；
- Git 提交；
- Agent session；
- permission；
- UI。

Environment 能力出现时再创建独立 r/environment，并限制为 observe、plan、realize、verify。不要提前创建。

## 14. Project 与 Git

Project domain 使用 Git 作为版本历史和内容身份来源，不建立 Rho project_revision 计数器。

Project operation 应记录：

- 执行前 Git HEAD；
- 执行前 working tree observation；
- 实际修改的 path；
- 执行后 Git HEAD；
- 执行后 working tree observation；
- 如果创建 commit，则记录 commit SHA；
- 如果未创建 commit，则明确记录 dirty/untracked 结果。

默认 patch 只修改工作树，不自动提交或改变 index。需要创建 Git commit 时应成为独立、明确请求的能力。见 N-D015。

## 15. 安全边界

新底座只保留三类安全机制：

1. Identity：谁通过哪个连接调用。
2. Containment：进程实际能访问什么。
3. Observation：运行中实际观察到什么，以及观察是否完整。

不建立：

- Rho-owned Agent approval；
- 风险评分工作流；
- 为审计而存在的第二执行路线；
- 无实际 enforcement 消费者的 policy DSL。

优先使用真实机制：

- OS 用户和文件权限；
- 进程隔离；
- filesystem scope；
- network namespace 或明确网络边界；
- 最小 secret injection；
- scheduler 自身的 identity 和状态。

跨平台 containment 必须按平台明确能力；Linux 的机制不能被文档假装成 macOS 或 Windows 也已实现。

## 16. Edge 与极简前端

Host 最终只公开稳定端口：

    invoke
    getOperation
    requestCancellation
    querySnapshot
    subscribe

CLI、MCP、Agent Gateway 和未来前端都调用这些端口。

极简前端只包含：

- 项目选择；
- R Console；
- Workspace 对象浏览；
- Operation 时间线与详情；
- Environment 状态。

前端规则：

- contract 从 Rust 类型生成；
- 不为每个 capability 创建新的 Tauri 业务命令；
- 不在前端推断 operation 成功、runtime 状态或 owner truth；
- subscription 事件只用于失效通知和增量呈现，最终状态可以重新 query；
- requestCancellation 返回“请求已接收”，不能显示为“任务已停止”；
- 完整桌面体验在核心后端稳定后再恢复。

## 17. 初始目录

只创建第一条真实垂直链所需模块：

    next/
    ├── contract/
    │   ├── invocation
    │   ├── operation
    │   ├── capability
    │   ├── identity
    │   └── observation
    ├── operation/
    │   ├── gateway
    │   ├── registry
    │   └── journal
    ├── workspace/
    │   ├── model
    │   ├── handler
    │   └── ports
    ├── adapters/
    │   ├── r-runtime/
    │   └── sqlite/
    ├── host/
    ├── cli/
    └── r/
        └── bridge/

暂时不创建 project、environment、execution、artifact、secret、sandbox、MCP、desktop 或 extension 模块。出现第一条真实能力时再创建。

next 是迁移期名称。旧系统全部退役后，应把它提升为正常仓库结构，不能永久保留 old/next 二元世界。

## 18. 外部依赖原则

依赖只在当前垂直链真正需要时引入。候选方向：

| 项目 | 可能职责 | 当前决定 |
| --- | --- | --- |
| Git executable | Project 历史、diff、内容身份 | N4 已采用；本机 Git 2.52.0 实际仓库测试通过 |
| SQLite + rusqlite | Operation journal、facts、outbox | 已采用；实际依赖以 Next manifest/lockfile 为准 |
| Tokio | async host、process 与 shutdown | 已采用 |
| tracing | 结构化运行观察 | 已引入；不替代持久化结果 |
| Serde | Rust contract serialization | 已采用 |
| Schemars | 从 Rust contract 生成 JSON Schema | 已采用 |
| Tower | Gateway middleware composition | 第二个真实 middleware 出现后再决定 |
| Ark / Jet | 权威交互式 R runtime | N2 已复用第三方 Jet transport；本机 Ark 0.1.252 + R 4.5.2 验证通过 |
| rlang | 无求值检查 lazy binding | N3 使用；缺失时仅报告未检查绑定，不强制求值 |
| renv + pak | R environment declaration/realization | N5 使用 pak 原生 lockfile_create/install 和 renv lockfile_read/restore/snapshot；本机真实验证通过 |
| Pixi | 外层科学环境 | Environment 阶段 PoC |
| Slurm CLI / 可选 slurmrestd | Remote job truth | 已实现 OpenSSH 上的原生 CLI；尚未远程实测，未引入 REST 服务依赖 |
| OS containment | 真实隔离 | 按平台、按威胁模型引入 |
| process-wrap | 本地进程生命周期封装 | N6 已采用 10.0.0；Unix 进程组在本机验证，Windows Job Object 分支未实测 |
| R ps | Environment 中跨进程组的子进程清理 | N6 已采用；本机 ps 1.9.3，复用原生 marker/find/kill/wait |
| sysinfo | 无 R 依赖的本机进程观察与恢复 | N6 已采用 0.39.6；只启用 system，结果不包含进程环境 |
| OpenSSH executable | 远程连接、认证与主机密钥核对 | N6 已接入；复用用户已有 alias/known_hosts，不自建 SSH 协议或凭证库 |
| ts-rs | Rust 到 TypeScript 的唯一 contract 生成器 | N7 已采用 12.0.1；包含 optional 字段与 JSON number 的编译/漂移检查 |
| Axum | 本机工作台 HTTP transport | N7 已采用 0.8.9；只绑定 loopback；复用 rmcp HTTP，不承接 Gateway 业务 |

禁止因为“未来也许有用”提前引入 DBOS、Restate、OpenTelemetry、完整 workflow runtime 或通用 policy engine。
讨论中的推荐清单不是安装清单，也不是可靠性背书。采用时只核对当前能力所需的接口、维护状态、许可、平台支持和最小验证；不预先创建这些工具的通用替代层。

## 19. 替换方法

### 19.1 隔离

- Next 使用独立 Cargo workspace、binary 名称、data directory 和 schema。
- Next 从全新应用状态启动。旧数据库、历史、会话、草稿、缓存与派生资产全部放弃；不建立迁移、导入、旧数据浏览器或跨版本会话接力。这里的“迁移”只指能力和代码收敛，不指数据迁移。
- 旧源码可以暂时并存作为行为参考，但不要求两个版本在线共存。切换采用关闭旧入口、启动全新 Next 状态的方式，不开发跨版本项目占用或热迁移协议。
- Next 不通过 path dependency 调用旧 rho-* crate。
- 已有第三方 vendor/jet 是共享上游依赖，不是旧 Rho owner；目前只有 r-runtime adapter 可以依赖它，不复制一份 vendor，也不引用旧 rho-kernel。
- 旧代码可以作为行为证据和算法参考，但移入 Next 的代码必须服从新 contract。
- 不为了让旧测试通过而污染新边界。

### 19.2 Capability ownership fence

Host 维护唯一 routing table：

    capability + version -> owner

允许的 owner 状态：

- legacy：生产入口仍走旧系统；
- next：生产入口只走 Next；
- retired：旧入口与实现已删除。

building 只是开发进度，不是运行时 owner。禁止 shadow execution 和 dual-write。

路由唯一还不够：如果多个 capability 共享同一个 R session、包库或 working tree，必须一起核对它们的写入入口。不能让 Next 接管 `workspace.run_r`，却让 Legacy 继续通过另一个入口修改同一会话。具体首批切换集合仍由 N-O010 跟踪，本文档不预先声称该边界已经解决。

### 19.3 单项迁移流程

1. 列出 capability 的外部可观察行为、真实 owner 和共享资源；据此确定需要一起切换的最小能力集合。
2. 在 Next 中完成一条端到端实现。
3. 通过该 capability 的不变量与真实 acceptance。
4. 原子切换 routing ownership 到 next。
5. 确认所有 edge 不再能到达旧入口。
6. 删除旧实现、旧 schema、旧测试和临时兼容层。
7. 更新 Capability Ledger 和 Work Log。

切换批次只在对应 Work Log 记录以下信息，不另建计划文件：

| 字段 | 必须能回答的问题 |
| --- | --- |
| 范围 | 本批哪些 capability 和调用入口一起切换？哪些明确不动？ |
| 共享资源 | 哪个 R session、工作树、包库或数据库在切换后只有一个写入 owner？ |
| 应用状态 | 使用全新 Next 状态；不安排旧数据迁移、导入、保留兼容或双写任务 |
| 切换依据 | 哪条真实验收、路由变更和旧调用者检查证明可以接管？ |
| 退役与恢复 | 哪些旧源码/测试可以删除？若切换失败，如何先停止新写入再恢复入口，并核对已发生的外部效果？ |

Git 可恢复源码，不代表已经撤销包安装、R 内存修改或远程作业；回退代码不能被记录为运行状态已回滚。

### 19.4 Capability 完成定义

一项 capability 只有同时满足以下条件才算完成：

- 使用统一 Invocation 和 OperationId；
- caller scope、schema、bounds、idempotency 已执行；
- precondition 由 owner 检查；
- external effect 只有一个执行 owner；
- terminal outcome 明确且不可覆盖；
- uncertainty 有 reconciliation 路径；
- operation、domain facts 和 outbox 保持一致；
- CLI 或其他 edge 有一条真实端到端验证；
- routing table 指向 Next；
- 旧入口编译层不可达；
- 旧实现和仅服务旧实现的测试已删除；
- 本文档记录验证命令和 Git commit。

## 20. 里程碑

| ID | 目标 | 完成条件 | 状态 |
| --- | --- | --- | --- |
| N0 | 宪章与台账 | 本文档进入治理索引并通过文档检查 | Complete |
| N1 | Walking skeleton | Invocation 经 Gateway、假/内存 Handler、SQLite atomic commit 后可由 CLI 查询 | Verified |
| N2 | 真实 Workspace R | workspace.run_r 贯通真实 R，支持结果、条件、取消请求和 uncertain | Verified（本机 Ark/R；生产未切换） |
| N3 | Workspace Query | querySnapshot 返回有来源、时间和 completeness 的 Workspace observation | Verified（含长期 CLI 会话；生产未切换） |
| N4 | Project truth | Git/filesystem preconditions 与 project.apply_patch 完成切换 | Next 实现 Verified；生产切换未完成 |
| N5 | Environment | observe/plan/realize/verify 首条链路完成 | Next Verified（隔离本地 fixture、renv restore、新 Ark 绑定）；生产未切换 |
| N6 | Execution | local process 后再扩展 SSH/Slurm | Building（本机已验证；SSH/Slurm 已实现并通过协议测试，未远程实测） |
| N7 | Public edges | MCP 与极简前端使用统一 host ports | Building（HTTP/MCP/真实 R、生成类型已验证；浏览器交互与视觉未验收） |
| N8 | Legacy removal | 旧运行主线、旧 schema 与旧 crate 全部退役 | Not started |

N1 不创建真实 R、前端、MCP、Environment 或 Project 功能。它只证明操作骨架、幂等、提交纪律和查询能够工作。

N2 是第一条真实 capability。workspace.inspect 作为 Query 在 N3 实现，不用它伪装 Operation walking skeleton。

## 21. Capability Ledger

状态词：

- Planned：仅有目标。
- Building：Next 实现中，运行 owner 仍为 Legacy。
- Ready：Next 已验证但尚未切换。
- Next-owned：所有生产入口只进入 Next。
- Retired：Legacy 实现已删除。
- Deferred：明确不在当前阶段。

| Capability / Port | 类型 | 当前 owner | Next owner | 进度 | 下一出口条件 |
| --- | --- | --- | --- | --- | --- |
| operation.invoke | Command port | Next 独立 CLI；旧生产入口未切换 | operation | Ready | N7 公共入口与旧消费者切换 |
| operation.get | Query port | Next 独立 CLI；旧生产入口未切换 | operation/sqlite | Ready | N7 公共边缘接入 |
| operation.request_cancellation | Command port | Legacy 生产入口；Next Host 已验证 | operation | Ready | N7 公开入口接入 |
| operation.subscribe | Subscription | Legacy 生产；Next cursor page/HTTP 已验证 | sqlite outbox/host | Ready（游标协议） | 前端消费已实现；浏览器验收与生产切换，不声称 live push |
| workspace.run_r | Operation | rho-server coordinator | workspace | Ready | Next 真实 R 已验证；待统一入口切换 |
| workspace.snapshot | Query | rho-server + r/rho.bridge | workspace | Ready | 已验证 bounded/busy/无 Operation；待切换入口 |
| workspace.inspect_object | Query | rho-server + r/rho.bridge | workspace | Ready | 已验证不求值绑定与有限预览；待切换入口 |
| project.snapshot | Query | 旧生产文件入口；Next CLI 已验证 | project | Ready | Git/文件原生观察已验证；待迁移消费者 |
| project.read_file | Query | 旧生产文件入口；Next CLI 已验证 | project | Ready | 分段精确字节读取已验证；待迁移消费者 |
| project.apply_patch | Operation | desktop + control-plane | project | Ready | Next 已验证；待旧入口切换 |
| environment.observe | Query | 旧生产入口；Next 已验证 | environment | Ready | 原生 R/library 观察及 active library 字段已实现 |
| environment.plan | Operation | Next CLI/Host | environment | Ready | pak/renv 原生锁与来源摘要；待公共入口切换 |
| environment.realize | Operation | Next CLI/Host | environment | Ready | 新隔离库安装与 namespace verification；现有会话不变 |
| environment.verify | Operation | Next CLI/Host | environment | Ready | 校验包库内容及实际 namespace；新 Ark 绑定前重验 |
| environment.reconcile | Operation | Next 独立 CLI/Host；生产未接入 | environment | Ready（本机 Host 崩溃验收） | 统一入口切换；仅清理本机已标记资源，不改写原结果 |
| environment.retention / cleanup_status | Query | Next 独立 CLI/Host | environment | Ready（本机材料验收） | 公共入口接入；查询不改变材料或 Operation |
| environment.cleanup / restore_cleanup / purge_cleanup | Operation | Next 独立 CLI/Host | environment | Ready（本机材料验收） | 公共入口接入；隔离、恢复与永久删除分别记录 |
| process.run_local | Operation | 多条旧生产路径；Next Host/CLI 已接入 | execution | Ready（本机正常/崩溃路径） | 公共入口切换 |
| process.reconcile | Operation | Next 独立 CLI/Host；生产未接入 | execution | Ready（本机无 R 验收） | 公共入口切换；仅针对当前可见的同用户标记进程 |
| process.run_remote | Operation | 旧执行路径；Next Host/CLI 已注册 | execution / ssh adapter | Building（本地协议测试通过） | 指定目标后进行真实 SSH 验收 |
| slurm.submit | Operation | 旧 execution/runner；Next 已接入 | execution / ssh adapter | Building（本地协议测试通过） | 验证真实集群提交与原生回执 |
| slurm.snapshot | Query | 旧执行路径；Next 已接入 | execution / ssh adapter | Building（本地协议测试通过） | 验证真实 squeue/sacct 状态与版本 |
| slurm.reconcile | Operation | Next 独立入口 | execution / ssh adapter | Building（本地协议测试通过） | 真实丢回执/状态核对；不重提作业 |
| slurm.request_cancel | Operation | 旧执行路径；Next 已接入 | execution / ssh adapter | Building（本地协议测试通过） | 真实取消请求与后续状态观察 |
| MCP edge | Edge | 旧 rho-mcp/Agent Gateway；Next stdio/本机 HTTP 已接入 | host adapter | Ready（真实 SDK/本机 R） | 浏览器验收与生产路由切换；HTTP 与 UI 共享同一 Host |
| desktop-lite | Edge | desktop；Next 独立本机入口已实现 | workbench / unified client | Building（接口/R Verified） | 浏览器交互与视觉验收后再切换生产入口 |
| evidence projection | Query projection | rho-evidence-graph | 未决定 | Deferred | 出现真实消费者 |
| extensions | Capability source | extension runtime | 未决定 | Deferred | 核心稳定后评估 |

此表是 capability 所有权的唯一人工台账。运行时 routing table 才是实际 owner 真相；两者不一致时，以代码为准并立即修正文档。

## 22. 永久不变量测试

新底座不继承全部旧测试，只保留高价值系统不变量：

1. 同一 caller + client_request_id 不会创建两个 Operation。
2. 同一幂等键携带不同输入时被拒绝。
3. 每个 child process/job/artifact 都能追溯一个 OperationId。
4. 一个 Operation 只能进入一个 terminal outcome。
5. terminal outcome 不可被后续事件覆盖。
6. precondition 失败不会触碰 runtime。
7. external effect 可能发生后崩溃不能被标记为普通 failed。
8. uncertain 一定包含 reconciliation material。
9. cancellation request 不会直接伪造 cancelled。
10. domain fact、operation transition 和 outbox 原子提交。
11. Edge 无法绕过 Gateway 调用 effectful handler。
12. Adapter 无法提交 domain truth。
13. 一个 capability 在 routing table 中恰好有一个 owner。
14. Next 不依赖 legacy crate。
15. 每项 Next-owned capability 至少有一个真实端到端测试。

测试报告只记录实际运行的命令和结果。未运行的 suite 不得写为通过。

## 23. Decision Log

Decision 记录长期约束，不记录普通代码选择。每条决定必须包含状态、理由和后果。

### N-D001 — 绿色底座而非原地重构

- 日期：2026-09-04
- 状态：Accepted
- 决定：在独立 next workspace 建立新底座，按 capability 切换并删除旧实现。
- 理由：旧系统同时存在目标架构和实际运行架构，原地调整会长期维持双重概念。
- 后果：Next 不依赖旧 crate；迁移必须设置 ownership fence。

### N-D002 — Command 与 Query 分离

- 日期：2026-09-04
- 状态：Accepted
- 决定：只有需要生命周期语义的动作进入 Operation；有限无副作用读取走 Query。
- 理由：避免打开面板或刷新状态产生无意义 Operation 和 timeline 噪声。
- 后果：workspace.run_r 是首个真实 Operation；workspace.snapshot 是 Query。

### N-D003 — OperationId 是唯一因果主键

- 日期：2026-09-04
- 状态：Accepted
- 决定：Rho 只为一次动作创建 OperationId；其他执行身份作为 owner-native 子引用。
- 理由：消除 monitor ID、execution ID、run ID 和 job ID 之间无法关联的问题。
- 后果：所有结果、observation、artifact 和日志必须携带 OperationId。

### N-D004 — Preconditions 取代 Rho Revision

- 日期：2026-09-04
- 状态：Accepted
- 决定：不建立全局 project/workspace/environment revision 计数器。
- 理由：不同真实系统已经拥有更高信息密度的并发和版本事实。
- 后果：各 domain 定义并检查 Git SHA、content hash、session ID、lock digest 等条件。

### N-D005 — 不建立独立 Audit 或 Provenance 主线

- 日期：2026-09-04
- 状态：Accepted
- 决定：审计与 provenance 是真实 Operation、observation 和 owner reference 的 projection。
- 理由：避免复制同一次运行形成第二套事实系统。
- 后果：不得为“审计需要”双写等价事件；新增字段必须有真实消费者。

### N-D006 — Identity、Containment、Observation

- 日期：2026-09-04
- 状态：Accepted
- 决定：安全核心压缩为调用身份、真实隔离和忠实观察。
- 理由：工作流审批不能替代 OS/runtime enforcement。
- 后果：Rho 不做 Agent 二次审批；不完整观察不能宣称没有副作用。

### N-D007 — Handler 解释，Foundation 原子提交

- 日期：2026-09-04
- 状态：Accepted
- 决定：Handler 产生 typed CommitPlan；统一 transaction boundary 提交 operation、facts、event 和 outbox。
- 理由：既保留 domain ownership，又防止各 Handler 自行形成不同提交纪律。
- 后果：Foundation 不解释领域事实，Handler 不分别提交多个 truth surface。

### N-D008 — 一个 Capability 一个 Owner

- 日期：2026-09-04
- 状态：Accepted
- 决定：迁移期运行 routing table 对每个 capability 只允许 legacy 或 next 一个 owner。
- 理由：dual execution 和 dual-write 会立即重新制造两套 truth。
- 后果：切换必须原子完成；新路径验证后立即使旧入口不可达。

### N-D009 — SQLite Journal，不做全量 Event Sourcing

- 日期：2026-09-04
- 状态：Accepted
- 决定：使用 operations、operation_events、domain facts 和 outbox。
- 理由：需要忠实历史和 crash discipline，但不需要 replay 世界上一切状态。
- 后果：operation_events 是历史；domain tables 可以保存当前权威事实。

### N-D010 — 前端延后且只有统一端口

- 日期：2026-09-04
- 状态：Accepted
- 决定：核心后端稳定前只使用 CLI；之后建立极简统一前端。
- 理由：先验证真实信息流，避免 UI 命令再次成为业务入口。
- 后果：未来 UI 只能使用 invoke/getOperation/requestCancellation/querySnapshot/subscribe。

### N-D011 — 本地 Host 单写者与只读查询

- 日期：2026-09-04
- 状态：Accepted；N1 Verified
- 决定：先使用同进程 Host API；SQLite 邻接锁文件使用 OS 文件锁，写入 Host 整个生命周期独占。只读 CLI 使用只读连接，绝不触发恢复。
- 证据：跨进程强制退出与重启测试、独立 CLI 请求/查询测试。
- 后果：第二个 Host 返回 busy；锁文件存在不代表活跃，OS lock 才是依据。未来 IPC 复用同一 Host，查询不能创建第二个运行时。

### N-D012 — Typed fact 在领域内生成，SQLite 仅存不透明记录

- 日期：2026-09-04
- 状态：Accepted；N1 Verified
- 决定：Workspace 用具体 Rust struct 构造 fact，跨提交边界只传 domain/schema/key/value。事务限定 fact 与 event 的 domain，并原子提交 Operation、facts、events、outbox。
- 证据：SQLite trigger 故障注入验证终态、fact、event、outbox 一起回滚；成功提交后拒绝覆盖终态。
- 后果：当前结果保存在 Operation 中，fact 只引用它；不把同一个输出复制到另一个结果库。此处是持久化封装，不是通用领域 DSL。

### N-D013 — 复用 Ark/Jet，Host 持有执行

- 日期：2026-09-04
- 状态：Accepted；N2 Verified
- 决定：r-runtime 复用 vendor/jet 的 Jupyter transport 与子进程生命周期，新增 typed R bridge；Host 持有独立执行任务，调用方放弃等待不能取消执行或丢弃提交。
- 证据：真实会话连续赋值/读取、R error 后保留已发生的赋值、来自 R 的开始信号之后取消、内核 quit 后 uncertain、CLI invoke 与只读查询；另有调用方断开后的持久化验证。
- 后果：执行与取消信号分离。只收到中断请求不能报告 cancelled；未收到完整 execute_reply/idle/result 则保留 uncertain。Ark startup 使用规范化项目目录和显式 R_HOME。
- 边界：当前是 native user process，不声称具备 OS sandbox；observations 标记 partial。严格 containment、输出 retention、长期 host/IPC 仍需完成。

### N-D014 — Query 不持有 Journal，命令与查询共享 capability 注册和 Workspace lane

- 日期：2026-09-04
- 状态：Accepted；N3 Verified
- 决定：QueryGateway 没有 journal 或 OperationId generator；与 OperationGateway 使用同一个 CapabilityRegistry。Workspace 查询只尝试获取同一个运行 lane，忙时返回 busy，不另起 R。
- 证据：真实 R 查询前后 outbox 完全一致；lazy/active binding 和自定义 length/print 的副作用计数仍为 0；长期 CLI 在 R 阻塞时能查询 busy、读取 Operation 并取消。
- 后果：新增 Query 通过注册 handler 扩展。session edge 只转发五个 typed Host port；stdin 分帧有字节和并发上限，关闭输入后等待已接受操作结束。
- 限制：观察是 partial；复杂 classed/S4 对象仅暴露元数据；subscribe 当前只读 cursor page，不宣称已实现 live push。

### N-D015 — Git 工作树修改与原生文件前置条件

- 日期：2026-09-04
- 状态：Accepted；Next 实现 Verified
- 决定：Project 使用系统 Git；patch 只改 working tree，默认不 staging/commit。HEAD 和文件 SHA-256 是前置条件，文件 null digest 表示必须不存在。
- 证据：真实仓库验证 dirty/staged/untracked 保留、index 字节不变、创建/删除/重命名、冲突 patch、子目录、无 Git 的目录、二进制分页、跨项目幂等冲突。
- 发现与修复：git apply 的 numstat 对 rename 只报告目标；现在组合正向和反向 numstat，先校验两端再 apply，避免漏掉受保护的源路径。
- 后果：Project 与 Workspace 共享 Host lane；外部编辑器不受锁保护，所有快照标为 partial。原生 Git 身份在执行中变化或出现未确认/部分效果时报告 uncertain。
- 范围：只引入 project domain 和 Git adapter；无新 ProjectJournal、project revision 或 audit route。文件读取返回原始字节页；时间戳直接引用文件系统元数据。

### N-D016 — 幂等范围绑定实际项目

- 日期：2026-09-04
- 状态：Accepted；Verified
- 决定：handler 提供原生 idempotency_scope（项目根目录），加入 invocation digest 并保存。Foundation 不解释该范围的业务意义。
- 理由：同一数据库切换项目时，不能把相同代码/patch 和 client_request_id 误认成另一个项目的重试；R session 重启不改变项目范围。
- 后果：不同项目复用同一 caller/request-id 返回冲突。旧未绑定范围的记录仍可读取，但不承诺与新的范围绑定请求等价；不得通过静默重跑消除冲突。

### N-D017 — 原生环境锁、隔离 realization 与显式新会话绑定

- 日期：2026-09-04
- 状态：Accepted；Next 本机链路 Verified
- 决定：pak 使用公开 lockfile_create/lockfile_install；renv 使用 lockfile_read/restore/snapshot。计划以 Operation output 保存元数据并引用原生 lockfile，没有独立 plan 数据库或 environment revision。
- 实际发现：本机 renv 1.1.8 没有 renv::plan。仅设置 snapshot library/type 仍可能使用不适合的发现范围；当前显式传入安装包集合，候选 lockfile 写在 staging。pak 的 local 元数据通过 renv 原生 Path 字段保留可恢复来源。
- 实现：每个 realization 有新的 library；锁、来源和包库内容都有摘要。namespace probe 在单独的 R 进程中执行，禁用用户库 fallback，验证真实版本与路径。
- 绑定：realize 返回 available_not_active；旧 R 会话保持原有库。新 Host 使用 --environment 引用成功 receipt，先复验再启动 Ark；JSON/检查支持 namespace 先载入，再切换科学库路径。
- 证据：临时本地包计划/安装、renv 恢复、完整 helper/Host/CLI、源码/锁/包库变更拒绝、原用户库存不变、R 中真实调用 fixture_answer 返回 42。
- 限制：包脚本仍是 native user process；N6 已补充正常取消、显式恢复及 N-D022 的材料回收。成功产物与不确定恢复材料默认保留，没有全局自动清扫。远程仓库与其他平台尚未实测。

### N-D018 — 共享进程执行器，领域补充原生子进程清理

- 日期：2026-09-05
- 状态：Accepted；本机正常执行/取消 Verified，Environment 崩溃恢复见 N-D019
- 决定：process.run_local、Git 和 Environment 使用同一个 process-wrap 执行器，统一字节输出、超时、取消和退出收集；不引入调度器或新的审批层。
- 发现：真实 pak 安装测试证明 processx/callr 会创建独立会话；主 R helper 退出和原进程组清理成功，不能证明安装子进程已停止。
- 修正：Environment 复用 ps 的原生进程树 marker、find、kill、wait。取消后完成独立清理；清理失败必须是 uncertain。恢复材料保留 marker、实际进程报告和 stage；取消的安装不能产生可激活 receipt。
- 证据：临时包在真实安装子进程中通过 TCP 报告 OperationId；取消后连接关闭，原请求重试仍返回同一 cancelled 结果。未用 fake RuntimeReport 或固定睡眠推断退出。
- 边界：进程组和环境 marker 不是防恶意逃逸的 OS sandbox。强制杀死 Host 时清理代码不能运行；Environment 和普通进程分别通过 N-D019、N-D020 补充恢复。不能据此宣称 Linux/Windows 或任意包行为已验证。

### N-D019 — 持久化原生恢复引用，通过新 Operation 核对与清理

- 日期：2026-09-05
- 状态：Accepted；Environment 本机 Verified
- 决定：效果开始前保存 ps 原生 marker，附带 OperationId 与规范化 project root；文件先同步再原子替换，Unix 同步所在目录。不新增任务、审计或结果数据库。
- 提交边界：每个 helper 只有在前一个 helper 已确认清理后才替换引用。原生 marker 保留供事后核对，不把“没有文件”解释成“进程已停止”。Query 的标记不持久化为 Operation 记录。
- 恢复入口：environment.reconcile 只接受当前 caller/project 范围内已经终止的 plan/realize/verify。它走原 Gateway、共享 lane 和事务；原生清理在发信号前检查进程的 Operation tag。
- 真相：新 Operation 返回停止的本机进程与保留的 staging。旧 Operation 的 uncertain、output 与时间记录不被改写，旧 Invocation 不重跑。清理不等于回滚、环境激活或取消远程作业。
- 证据：真实 CLI 在安装子进程报告开始后被 SIGKILL；只读查询保持数据库不变。错项目与错 marker 拒绝清理，原生 ps 检查确认进程仍活着；正确请求使连接关闭。丢失引用仍为 uncertain，重复恢复可观察到空进程集合。
- 限制：目前验证范围为 macOS、本机 R/ps 和临时 fixture。普通 process.run_local 恢复由 N-D020 单独验证，材料保留/回收见 N-D022；其他平台仍未完成。

### N-D020 — 从当前原生进程状态恢复，不信任历史 PID

- 日期：2026-09-05
- 状态：Accepted；本机无 R 的 CLI 崩溃验收 Verified
- 决定：复用执行前已持久化并注入环境的 OperationId；process.reconcile 通过同一 Gateway 查询源操作，不创建 PID 表或新状态库。
- 机制：sysinfo 只检查当前同用户进程的 Operation 标记，发信号前再次刷新标记、用户与启动时间；不使用旧结果中的 PID，也不调用可能无限等待的 Process::wait。观察轮次受时间与数量限制。
- 范围：结果是 observed/signalled/remaining 和 no_matching_processes_observed，completeness 明确为 partial；它不证明不可观察、清除标记或远程进程已经停止。原生查询与 POSIX 信号也不是原子隔离机制。
- 约束：仅可恢复当前 caller/project 下已经终止的 process.run_local。运行中源操作在等待 lane 前就被拒绝；源结果不被覆盖，旧 Invocation 不重新执行。
- 收敛：Environment 与 Execution 现在共用 OperationRecords 只读接口；移除原先仅属于 Environment 的同形接口，依然读取同一个 Journal。
- 证据：真实 CLI 被强制终止后，父进程及独立进程组中的子进程被清理，无关标记的进程仍活着；只读查询不恢复数据库，旧结果保持 uncertain，副作用文件只写一次。

### N-D021 — OpenSSH 与 Slurm 原生操作，不复制调度器

- 日期：2026-09-05
- 状态：Accepted；代码已接入，本地协议 Verified，真实远程未验证
- 决定：OpenSSH 管连接、认证及 known_hosts；Next 只构造有边界的命令与数据流。Host 可同时装配 Workspace、Environment 和远程能力，启动不会连接 SSH。
- 原生身份：sbatch --parsable 返回 cluster/JobID；Operation 派生作业名是恢复标记，comment 只是附加关联，因为会计注释保存取决于集群配置。
- 操作约束：提交一次，不自动重试或 requeue；丢回执后原结果保持 uncertain。reconcile 查询唯一匹配作业，缺失或歧义不构成重新提交的依据。
- 查询与取消：squeue 读取当前状态，必要时查 30 天内 sacct；缺失记录不证明作业不存在。request_cancel 使用当前用户/作业名过滤，取消回执与后续调度器状态分开返回。
- 机械边界：显式 Bash body 与 typed 资源选项；脚本中的 SBATCH 指令和继承的 Slurm CLI 选项不能偷偷改变分配。连接使用严格主机密钥检查，关闭 agent forwarding 与共享控制连接。
- 证据：本地假 SSH/调度器运行了真实 argv、stdin 和 POSIX 引用路径，验证成功/丢回执、查询纯度、歧义拒绝、取消回执不等于终态。没有连接服务器或提交真实作业。
- 限制：版本 1 是单节点/单任务分配；真实目标、工具版本、远程权限及运行行为仍需验收。SSH 超时、本地取消或 255 状态只能留下远程结果不确定，不能宣称远端已停止。

### N-D022 — 引用保护下的显式材料回收

- 日期：2026-09-05
- 状态：Accepted；本机真实 R/Environment Verified
- 保留规则：成功产物、运行中和 uncertain 来源保留；只考虑 failed/cancelled 的 plan/realization 暂存。缺失原生标记、仍有进程、引用扫描不完整或当前 R 使用情况不可观察时，不回收。
- 使用事实：成功环境输出通过原 Journal 的有界只读页检查；当前 R 返回实际 .libPaths 与已加载命名空间路径，不用启动配置推断实际使用。没有新增引用数据库或 Evidence 图。
- 操作：retention/cleanup_status 是 Query；cleanup、restore_cleanup、purge_cleanup 是独立 Operation。先将单个受控目录移入隔离区；永久删除必须显式请求，不触碰 Project 文件、成功库、Workspace 报告/日志或未识别的孤立材料。
- 前置条件：预览给出元数据 fingerprint；变更前重新核对引用、进程与 fingerprint。它不是科学内容版本或 Rho revision。目录枚举有数量上限，不跟随内部符号链接，特殊文件阻止回收。
- 恢复：隔离路径由 cleanup OperationId 定位。真实重命名后事务失败，重启仍可 query/restore/purge 已隔离材料，不重放移动、不改写旧结果。原生恢复标记在永久删除暂存后仍保留。
- 证据：真实取消安装后，手动加入 .libPaths 会阻止回收，移除后允许；过期预览拒绝；隔离/恢复/永久删除及提交故障恢复通过，外部 symlink 目标不变。
- 边界：保护 Rho 声明的引用与可观察 R 使用情况，不声称追踪所有外部进程或分析任意代码里的未来文件引用。默认不自动删除科学产物。

### N-D023 — 官方 MCP SDK、共享 principal 与 Host 持有执行

- 日期：2026-09-05
- 状态：Accepted；真实 rmcp stdio 与本机 Ark/R Verified
- 决定：复用 rmcp 1.8；Capability Registry 派生 MCP 工具及 schema，所有调用进入 Host 五端口。没有自建 MCP 协议、Agent Conversation、sampling/规划循环或二次审批。
- 身份：MCP actor 是 agent/local-mcp，本机账户 principal 由 stdio Edge 绑定；CLI/Human 和 Agent 可以读取并引用同一账户的科学结果。其他 principal 不可见，clientInfo 与工具参数不能声明账户权限。
- 兼容事实：旧记录没有 principal 时沿用 caller。principal 与 caller 等价时不改变已有幂等 digest；不同 principal 复用同 actor/request key 会冲突，不能返回另一个账户的结果。
- 生命周期：SDK 的有界 codec 限制输入；能力调用有并发上限。RPC cancellation/EOF 不伪造 runtime cancellation，显式取消工具仍验证源能力 scopes。Host 使用 TaskTracker 等待已接受工作提交。
- 证据：真实 MCP 握手、发现、文件修改、查询纯度、幂等、输入越界、取消与断开后提交通过；真实 R 返回 42、对象 Query 不产生日志，Agent 实现 Human 创建的包计划，Human 读取同一结果。
- 边界：当前是本机 stdio binding，不是网络鉴权或全平台验收。事件工具是 cursor page，不是 live push；前端与旧生产入口切换仍未完成。

### N-D024 — 本机薄客户端、生成契约与共享 Host

- 日期：2026-09-05
- 状态：Accepted；类型生成、本机 HTTP/MCP 与真实 R 已验证，浏览器交互/视觉尚未验收
- 决定：使用 ts-rs 12.0.1 从 Rust 生成 TypeScript contract；plain TypeScript 客户端与静态资产嵌入 Axum 本机服务。没有第二个前端业务服务器、旧 Tauri 依赖或外部网站部署。
- 类型纪律：沿用 JSON number，客户端拒绝不安全游标；显式映射省略的 optional 字段。生成内容和嵌入 JS 有漂移检查，只有 app.js 是实际脚本资源。
- 所有权：HostProfile 统一 CLI/stdio MCP/工作台的启动装配。`/api/host` 转发原五端口，`/api/info` 与 `/api/project` 只处理原 Host 启动/项目选择，不新增科学业务路由。`/mcp` 使用官方 rmcp，与 UI 共用同一个 Arc<NextHost>。
- 切换：活跃请求、未提交任务和 MCP 会话阻止切换项目；旧浏览器的 project root 不匹配时拒绝请求。切换结束旧 R session，并清除项目特定的库/remote binding；启动失败报告没有打开项目，不声称内存已回滚。
- 边界：只监听 127.0.0.1，使用每次启动的 bearer、精确 Host/Origin、请求大小上限与同源静态资源。不创建账户、Agent approval 或权限审批数据库；native R/进程仍拥有当前用户的 OS 权限。
- 客户端：事件仅驱动重新查询；结果来自持久化 Operation 与 owner observation。断线后的同 ID 重试需要显式触发；关闭等待提示不取消运行。MCP 与 UI 保留各自 actor，共享 principal 的事实。
- 证据范围：测试已从 HTTP 执行真实 R 得到 42，再由 MCP 查询同一对象；跨入口取消、查询纯度、断开后提交和项目切换边界已验证。电脑交互连接启动失败且浏览器列表为空，未据此声称界面已通过视觉验收。

### N-D025 — 放弃旧数据，专注代码替换

- 日期：2026-09-05
- 状态：Accepted；用户明确决定
- 决定：尚无真实用户，放弃旧架构的全部数据资产。Next 使用全新应用状态，不做数据盘点、迁移、导入、只读挂载、历史兼容或跨版本会话接力。
- 后果：关闭 N-O009；旧数据和未保存草稿不再是切换门槛。删除刚新增但未提交的旧数据检查工具及测试，不为此另建恢复或保留工具。
- 开发范围：继续收敛科学能力、切换调用入口、删除被替代的旧实现。新系统自身的事务、幂等、项目互斥和真实故障处理仍然需要，但不能借此重新引入旧数据迁移工程。
- 边界：本决定不要求现在扫描或清理旧应用数据目录，也不改变对无关源码改动的保护。当前不执行额外的数据处理工作。

## 24. Open Decisions

以下问题尚未决定，不能由实现者顺手固化：

| ID | 问题 | 最晚决定时间 |
| --- | --- | --- |
| N-O004 | 任意 R eval 的最低 containment 保证是什么？ | workspace.run_r 切换前 |
| N-O006 | SHA-256 与 BLAKE3 分别用于哪些外部兼容和本地内容身份？ | 首个 artifact 前 |
| N-O007 | macOS、Windows、Linux 的 containment capability matrix 是什么？ | 首个受限 process 前 |
| N-O010 | 首批代码切换要关闭哪些旧调用入口、删除哪些旧实现？按全新 Next 状态冷启动，不设计数据或活跃会话交接 | 首次入口切换前 |
| N-O011 | SSH/Slurm 真实验收使用哪个已配置目标及临时目录？已向用户询问；未指定前不连接或提交远程作业 | N6 远程实测前 |

解决 Open Decision 时：

1. 记录可观察需求；
2. 运行最小 PoC；
3. 把结果转为新的 N-Dxxx；
4. 从本表删除对应 N-Oxxx；
5. 提交验证命令或 artifact 引用。

## 25. Work Log

Work Log 记录里程碑和切换，不复制每个 commit。每条记录引用 Git commit、实际命令或 artifact；Git 保留逐文件历史。

### 2026-09-04 — 架构审查与替换方向

- 观察：现有代码具有较严格的静态 crate 边界，但生产 Workspace 路径没有使用已有的统一 Operation contract。
- 观察：Operation、execution、run、monitor 和 semantic event identity 没有形成一条实际因果链。
- 观察：rho-server coordinator 是事实上的 Workspace application core。
- 观察：旧 Store 与 SemanticStore 形成两套持久化语言。
- 决定：停止原地逐层重构，采用独立 Next 底座和 capability-by-capability replacement。
- 验证：cargo test -p rho-architecture-tests --locked -- --test-threads=1，15 tests passed。
- 代码变化：无。

### 2026-09-04 — 创建本宪章与台账

- 目标：将长时间讨论压缩为一个可执行、可维护的开发入口。
- 变化：新增本文档；加入文档 registry、index 和 governance area。
- Next 实现：尚未开始。
- Legacy 删除：无。
- Git：随 N1/N2 检查点 `d0ba58b` 提交。
- 验证：node scripts/governance.mjs check 通过（9 pages、13 areas、26 checks）；node scripts/test-governance.mjs 通过。
- 下一步：N1 walking skeleton。

### 2026-09-04 — N1 端到端骨架验证

- Git：`d0ba58b`（与 N2 同一检查点）。
- 实现：六个 Next crate；共享 Invocation、领域参数解析、caller scope、caller-kind/id/request-id 幂等、session precondition、单一 Workspace 执行 lane。
- 记录：SQLite application ID/schema 检查、原子 terminal commit、只读查询、跨进程写入互斥；源代码没有旧 rho-* crate 依赖。
- 验证：`cargo test --manifest-path next/Cargo.toml --workspace --offline -- --test-threads=1` 通过（包括事务故障、进程强制退出、幂等并发与独立 CLI）。`cargo clippy --manifest-path next/Cargo.toml --workspace --all-targets --offline -- -D warnings` 通过。`node next/scripts/check-architecture.mjs` 通过。
- 限制：CLI 当前返回明确标注的 fake 结果；取消请求已记录，真实 runtime 取消还在 N2；尚未切换任何旧生产能力。
- Legacy 删除：无；还没有满足切换条件的真实能力。
- 下一步：N2 Ark/R adapter，直接复用第三方 Jet 的 Jupyter transport。

### 2026-09-04 — N2 真实 Ark/R 与 CLI 验证

- Git：`d0ba58b`。
- 实现：新增 r-runtime adapter 和单入口 R bridge；输入/输出 schema 来自 Rust 类型；stdout/stderr 分离，条件和对象摘要有上限；运行任务在调用方断开后继续完成提交。
- 验证：`node next/scripts/test-real-r.mjs` 通过。本机 Ark 0.1.252、R 4.5.2：对象跨操作保留、幂等重试、R error 的实际 partial effects、已确认中断、内核退出 uncertain、CLI 真执行返回 42、只读查询不改变数据库。
- 范围：普通 Next Cargo suite 通过；外部 R acceptance 单独运行。其他操作系统/安装组合尚未验证。
- Legacy 删除：无；Next-ready 与 production ownership 分别记录，尚未删除仍有调用者的旧实现。
- 下一步：N3 Workspace snapshot/object Query，统一 busy/live observation；随后继续 N4—N8。

### 2026-09-04 — N3 Workspace Query 与长期 CLI 会话

- 实现：共享 CapabilityRegistry、独立无 Journal 的 QueryGateway、snapshot/inspect_object 两个 owner handler；typed stdio session 转发五个 Host port。
- 真实验证：`node next/scripts/test-real-r.mjs` 通过，覆盖两个 R 集成场景及实际长期 CLI：对象状态共享、查询不产生日志、惰性/活动绑定不被求值、普通 data frame/向量有限预览、busy 查询、取消、EOF 退出。
- 常规验证：Next workspace tests、session 分帧/超长帧/连续请求测试及 Clippy 通过；本次未运行旧系统全套测试。
- 检查点：N1/N2 代码为 `d0ba58b`；N3 为 `0abf441`。
- Legacy 删除：无；生产消费者尚未迁移。
- 下一步：N4 Project/Git 原生状态与 patch capability。

### 2026-09-04 — N4 Project/Git 的 Next 实现

- Git：`0f4c951`。
- 实现：project.snapshot、project.read_file、project.apply_patch；Project-only Host 无需启动 R；CLI 支持 generic capability/arguments/preconditions。
- 验证：Next workspace suite 通过；Project 实际 Git 用例覆盖 staged/dirty/untracked、原生前置条件、重命名、创建/删除、子目录与 symlink 边界。故障注入执行真实第一文件修改后丢失返回，验证持久化 uncertain 和无自动重试。
- 真实 R：Project busy 与 Workspace 共用 lane；通过 Project patch 改文件后，现有 R session 直接读到新字节；原有 R/长期 CLI 验证通过。
- 进度边界：这是 Next-ready，尚不满足 N4 的生产切换条件。旧生产文件命令仍存在，不能把它们标成 Retired。
- 下一步：N5 Environment；之后完成公共入口切换与旧代码删除。

### 2026-09-04 — N5 原生环境链路

- Git：`e23bd05`。
- 新增 Environment domain 与固定 Rscript adapter，注册 observe/plan/realize/verify，复用共享 Host lane 和既有 Operation journal。
- 验证：`node next/scripts/test-environment.mjs` 通过，覆盖 pak/renv 实际包流程、独立 namespace 检查、摘要变化、原用户库存、新 Ark 绑定，以及真实 CLI 的 --rscript/--environment。
- Next 常规测试通过；外部运行时测试单独执行，未把 ignored 计为 passed。新系统仍未完成旧入口替换。
- 后续：N6 的进程与远程执行；补齐取消/回收、公共入口及旧代码退役，不能仅以 N5 链路成功宣布整体完成。

### 2026-09-04 — 主文档整理与进度核对

- 结果：沿用本页作为唯一主文档，补齐阅读导航、检查点、轻量记录模板与幂等/外部事务边界说明；没有新增平行进度系统。
- 进度核对：N1—N5 对应已提交检查点；N6 有工作树代码但未接入 Host，状态修正为 Building；生产切换和 Legacy 删除仍为 0。
- 验证：本次仅运行 `node scripts/governance.mjs check`（9 pages、13 areas、30 checks）和 `node scripts/test-governance.mjs`，均通过；`git diff --check -- docs/NEXT-SYSTEM.md` 通过。没有重跑 Rust、R 或旧系统测试。
- 变更范围：仅本文档，尚未提交；保留现有 Execution 工作树，不改变运行代码，不删除旧实现。
- 下一步：N6 local process 验证与 Host 接入；新增 N-O010 跟踪共享状态的切换范围。

### 2026-09-05 — N6 本地执行与安装取消

- Git：`56beff1`；这是 N6 的本地执行检查点，不是整个 N6 或 Next 的完成提交。
- 实现：新增 execution domain 和 process adapter，注册 process.run_local；CLI、持久化查询和幂等重试真实贯通。共享 lane 防止 Host 内的本地命令与 Workspace/Project/Environment 并发修改。
- 收敛：删除 Next Git/Environment 中各自的子进程 spawn、输出读取和 timeout/kill 实现，复用一个有上限且持续排空输出的执行器。
- 失败与修复：第一次真实安装取消验收失败，发现独立会话中的 R 子进程仍存活；引入 ps-native tree 清理后，同一测试通过。没有把主进程退出或连接等待超时当成整个安装已停止。
- 已运行：Next workspace tests、Clippy（-D warnings）、architecture check 通过；`node next/scripts/test-environment.mjs` 通过，包括真实安装取消和原有 pak/renv/Ark/CLI 验证；`node next/scripts/test-real-r.mjs` 通过。普通 Cargo suite 中的外部 R 测试仍明确 ignored，由独立入口执行。
- 生产所有权：未切换；Legacy 删除：无。以上删除仅涉及 Next 内重复机制，不把旧生产实现记为已退役。
- 下一步：保留可定位的 native process-tree 恢复材料，并验证 Host 强制退出后的真实收敛；之后完成 SSH/Slurm、公共入口和旧系统退役。

### 2026-09-05 — Environment Host 崩溃恢复

- Git：`9ec0837`；这只完成 Environment 的本机恢复部分，不代表 N6 或整体 Next 完成。
- 实现：原生 marker 在 helper 启动前落盘；新增 environment.reconcile，通过原有 Operation 主线读取来源、核对范围、清理并提交新观察。没有增加 Journal 表或平行状态系统。
- 验证：Next workspace tests、Clippy（-D warnings）、architecture check 通过；`node next/scripts/test-environment.mjs` 通过，包括新增真实 CLI 崩溃恢复、范围拒绝、原生存活检查、缺失引用与不重放；`node next/scripts/test-real-r.mjs` 通过。文档检查通过。
- 进度边界：恢复 Environment 的本机子进程，不代表恢复所有本地命令或远程任务。测试保留并检查 staging，没有把部分安装当成成功 receipt。
- 生产切换：无；Legacy 删除：无。普通本地命令恢复、SSH/Slurm、公共入口、staging 回收和旧系统退役继续保留在完整目标内。
- 下一步：完成普通本地命令的 Host 崩溃收敛，再扩展远程执行。

### 2026-09-05 — 普通本机命令的崩溃恢复

- Git：`9b0131f`；本机恢复检查点，不代表整个 N6 或 Next 已完成。
- 实现：新增 process.reconcile；复用原 OperationId 与 sysinfo 原生观察，Project-only Host 不需要 R。两类恢复 handler 共享只读 OperationRecords，不新增数据库表。
- 验证：Next workspace tests、Clippy、architecture check 通过；`node next/scripts/test-process-recovery.mjs` 通过，覆盖真正的 CLI Host 强制退出、父/脱离进程组子进程、无关进程保留、源结果不可变与不重放。新验收已加入 governance 映射。
- 回归：`node next/scripts/test-environment.mjs` 和 `node next/scripts/test-real-r.mjs` 通过，原有包安装、取消、绑定、崩溃恢复与 Workspace 查询仍工作。其他平台和远程执行没有被据此记为通过。
- 生产切换：无；Legacy 删除：无。移除了重复的领域专用读取接口，Git 保留改动历史。
- 下一步：SSH/Slurm 原生执行适配；真实目标尚待用户指定，先继续本地及协议实现。

### 2026-09-05 — SSH/Slurm 客户端路径与本地协议验收

- Git：`2f9ce6b`；这是协议实现检查点，不是远程验收或整体完成。
- 实现：新增 ssh adapter，以及 process.run_remote、slurm.submit/snapshot/reconcile/request_cancel；通过既有 Host 五端口暴露。Host 用明确的领域装配结构组合能力，不扩张一串位置参数或在 Edge 编写业务路由。
- 验证：Next workspace tests、Clippy、architecture check 通过；`node next/scripts/test-remote-protocol.mjs` 本地协议测试通过。测试明确替换了 SSH/Slurm executable，没有网络连接或真实调度器作业。
- 发现：初始 sed 模式在测试平台不兼容，已修正；查询纯度现在在同一已启动 Host 内比较，避免将 Host 初始化的数据库头变化误算成 Query 写入。
- 回归：真实 R 与 Environment 验证仍通过。生产切换：无；Legacy 删除：无。
- 下一步：等待目标信息期间完成本机 staging/恢复材料保留与回收；目标获指定后补真实 SSH/Slurm 验收，再继续公共入口和旧系统退役。

### 2026-09-05 — Environment 材料保留与回收

- Git：`e1820f1`；本机材料回收检查点，远程实测与整个替换仍未完成。
- 实现：统一的预览、隔离、恢复和永久删除；成功输出引用页与实时 Workspace 库使用检查。所有变更仍由原 Operation 事务提交，未新增材料状态数据库。
- 发现与修正：base 内建命名空间不能像普通包一样查询 path，最初误报使用情况不完整；明确处理后验证了真正的活跃库保护，而不是依靠查询错误阻止回收。
- 验证：Next workspace tests、Clippy、architecture check 通过；真实 Environment 测试覆盖 stale preview、引用保护、隔离/恢复/永久删除、链接目标保留和重命名后提交失败恢复；真实 R 验收通过。
- 范围：只对私有测试目录执行删除，未清理实际用户材料。恢复标记及原结果被保留；生产切换与 Legacy 删除均无。
- 下一步：N7 统一 MCP 入口和极简客户端；真实 SSH/Slurm 目标仍待指定。

### 2026-09-05 — MCP 入口与共享账户视图

- Git：`f4f502c`；MCP 入口检查点，不代表前端或整体替换完成。
- 实现：`rho-next ... mcp` 复用同一个 Host 启动配置；动态工具由 registry 生成，查询与 command 分路，控制工具只转发 get/cancel/events。
- 验证：`node next/scripts/test-mcp.mjs` 与 `--real-r` 通过，包含真正的 rmcp 服务、真实本机进程/R 与包安装。Next workspace tests、Clippy、architecture 和文档检查通过；原 Environment 验收通过。
- 身份验证：保留 Agent actor，跨入口按同一 principal 看事实；隔离其他账户。缺少能力 scope 的 caller 不能借助取消端口获得写能力。
- 进度：N7 的 MCP 部分已验证，前端未完成；生产切换与 Legacy 删除均无。远程 SSH/Slurm 未进行实际连接或提交。
- 下一步：从 Rust contract 生成唯一客户端类型，接入极简前端，然后完成能力路由切换与旧实现删除。

### 2026-09-05 — 统一文档入口与切换记录

- 结果：沿用本页，不新增平行文档；根 AGENTS.md 明确此任务台账的例外与入口，补齐接手路径及切换批次字段。
- 范围：仅文档和开发指引。核对现有源码、manifest 与 Git 检查点；没有将历史测试记录当作本次重新验证。
- 所有权：未切换；Legacy 删除：无。共享状态的具体首批切换集合仍为 N-O010，尚未决定。
- 验证：`node scripts/governance.mjs check` 通过（9 pages、13 areas、34 checks）；`node scripts/test-governance.mjs` 与 `git diff --check` 通过。没有改动运行代码，未重跑 Rust、R 或旧系统测试。
- 下一步：N7 generated contract 与极简客户端；本次文档整理不改变其未完成状态。

### 2026-09-05 — 本机工作台与共享 HTTP/MCP Host

- Git：`3e20d78`；本机客户端实现与协议验证检查点，不是 N7 或整体替换的完成提交。
- 实现：新增本机 workbench edge、生成 TypeScript contract 与极简客户端；抽出 Host 启动装配，CLI 不再自行组装 Ark/Environment config。所有科学能力仍来自 Registry 和 Host 五端口。
- 验证：`cargo test --manifest-path next/Cargo.toml --workspace --locked --offline -- --test-threads=1`、Next 全目标 Clippy（`-D warnings`）、architecture check、`npm run check --prefix next/ui` 通过。工作台四项 Rust 测试覆盖本机边界、幂等、查询纯度和切换互斥。
- 真实验收：`node next/scripts/test-workbench.mjs` 及 `--real-r` 通过，含真正的 HTTP/MCP 服务、Ark/R 共享对象、Environment 观察、跨入口取消、断开后提交和同 ID 重试；没有把浏览器点击或视觉检查算在内。
- 回归：`test-real-r.mjs`、`test-environment.mjs`、`test-mcp.mjs`（含 `--real-r`）、`test-process-recovery.mjs`、`test-remote-protocol.mjs` 全部通过，脚本位于 `next/scripts/`。远程脚本仍明确是本地协议 fixture。文档检查（9 pages、13 areas、37 checks）与 `git diff --check` 通过，未运行旧系统全套测试。
- 发现：Fetch 会规范化 Host 头，安全验收改用实际原始 HTTP 请求；SDK 的 DELETE 返回 202，不能把它写成另一个预设回执。类型生成补齐省略 optional 与 JSON number 映射。
- 未完成：电脑交互连接启动失败、可用浏览器列表为空，直接创建内置浏览器也返回不可用，不能进行真实点击与视觉验收。临时本机服务已关闭、临时凭证已清理。远程实测和生产切换仍未完成；没有删除旧生产实现。
- 下一步：浏览器条件恢复后完成客户端交互验收；继续核对首次入口切换与旧源码删除范围，不以接口测试替代整个 N7。旧数据处理工作已由 N-D025 取消。

### 2026-09-05 — 取消所有旧数据迁移工作

- 用户补充：尚无真实用户，放弃旧架构全部数据资产，不投入迁移资源。
- 变化：删除未提交的 `inspect-legacy-data.mjs`、`test-legacy-data.mjs`；移除旧数据待决项，更新根与 Next 开发指引。没有读取、导入或清理实际旧应用数据目录。
- 后续：按全新状态切换入口、收敛能力并删除旧代码；保留正在实现的新系统自身项目互斥，它不是跨版本数据兼容机制。

## 26. 每次工作结束时如何更新

本文档是协作入口，不是新的审批流程。不要求日更、打分或逐次填写表单；普通实现过程保留在 Git，只有下面的实质变化进入台账。

只有发生以下情况才更新本文档：

- 宪章规则改变；
- Capability owner 或进度改变；
- 里程碑状态改变；
- Open Decision 得到结论；
- 旧入口或模块退役；
- 发生影响恢复语义的重要失败；
- 新增或删除基础依赖。

一次有效更新应包含：

1. 更新顶部当前摘要。
2. 更新对应 Capability Ledger 行。
3. 如改变长期约束，新增 Decision。
4. 如完成有意义阶段，追加 Work Log。
5. 写明真实执行的验证命令和结果。
6. 写明删除了哪些旧入口、代码、schema 或测试。
7. 保持下一步只有一个清晰的可执行出口。

不要在本文档记录：

- 每个小 commit；
- 临时 TODO；
- 可从 git diff 直接得知的文件列表；
- 未运行的验证；
- 无消费者的未来设想；
- 已被新决定取代但仍作为“备选架构”保留的长篇内容。

过时说明应直接删除；历史由 Git 保存。

### 最小记录模板

阶段完成、切换或遇到影响恢复语义的问题时，用下面一条记录即可；没有变化的字段可以省略，但不能省略验证范围和剩余工作：

```text
日期 / capability / 阶段
结果：本次实际改变了什么；Target / Implemented / Verified / Retired
依据：commit 或明确标注的工作树 + 实际命令/结果 + 验证平台与限制
所有权：旧入口 -> 新入口；未切换则写“未切换”
退役：删掉的旧实现/兼容层；没有则写“无”
决定或发现：只写影响后续实现的原因；必要时引用 N-D / N-O
下一步：一个可执行出口；其余要求仍留在里程碑或待决问题中
```

Ready 必须有行为证据；Next-owned 必须有入口切换证据；Retired 必须有删除证据。三者不能用同一个“完成”代替。
提交后补上实际 commit 引用即可，不为文档建立独立版本号、另一份 JSON 进度库或独立审计流水线。

## 27. 当前唯一下一步

N7：让外部 Agent 与极简客户端使用同一套科学空间端口。

工作台与 MCP 已共用一个本机 Host；生成类型、HTTP 入口及真实 Ark/R 已验证。浏览器交互连接当前不可用，项目选择、R 执行、对象刷新、操作详情、取消/重连与桌面/窄屏布局的真实浏览器验收仍未完成。

当前可执行出口：完成新系统自身项目互斥的验证，随后直接推进首次代码入口切换（N-O010）和旧实现删除。Next 从全新应用状态启动，不再盘点或处理任何旧数据，也不建立新旧会话交接机制。浏览器条件恢复后补 N7 交互验收；真实远程目标未指定前仍不连接或提交作业。

必须只包含：

- 保留已验证的本地进程 stdout/stderr、退出码、取消与退出后收集；不复制一套 scheduler；
- 保留两条已验证的本机显式恢复路径，不把 scoped observation 扩张成全系统隔离承诺；
- SSH/Slurm adapter 使用原生 job/host identity，未知提交结果不得自动重提；
- 未提供真实远程运行条件时明确区分协议测试与实际远程验收；
- 保留明确的材料保留策略，不用全局清扫替代引用判断；
- 并行保留远程实测、N7 公共入口与 N8 旧代码删除的未完成要求。

此阶段不创建：

- 完整旧桌面体验；
- Artifact framework；
- Audit、Evidence、Policy 或 Revision subsystem。

后续里程碑和旧系统删除仍属于完整目标；N1/N2 的局部验证不代表整体替换已完成。
