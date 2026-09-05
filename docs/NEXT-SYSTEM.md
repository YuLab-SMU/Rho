# Rho Next 系统宪章与替换台账

> 状态：Active
>
> 最后更新：2026-09-04
>
> 当前阶段：N1—N3 已验证；下一步 N4 Project/Git
>
> 适用范围：新底座、能力迁移、旧实现退役
>
> 事实优先级：可复现运行结果 > 源代码 > 本文档 > 讨论记录

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
第 3—19 节描述目标边界；实际实现与验证范围以第 20—27 节为准。N1—N3 已在本机验证；生产切换仍未完成。确定性 fake runtime 只用于测试。

## 2. 当前摘要

| 项目 | 当前事实 |
| --- | --- |
| 总体状态 | 真实 Ark/R、Operation、SQLite、Workspace Query 与长期 CLI 会话已贯通；N1—N3 本机验证通过 |
| 当前里程碑 | N4 — Project/Git；之后继续 Environment、Execution 与入口切换 |
| Next 已拥有的 capability | 0 |
| 已退役的旧 capability 实现 | 0 |
| 旧系统策略 | 冻结为行为参考；不作为 Next 的代码依赖 |
| 前端策略 | 延后；需要时仅建立极简统一客户端 |
| 数据策略 | Next 使用独立 schema 和数据目录，切换前不双写 |

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
    - granted scopes
    - connection/session identity
    - optional correlation and causation
    - optional standard trace context

Gateway 可以机械地拒绝 caller 没有资格调用的 capability，但不得发起第二次用户审批。

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

尚未决定所有 Project operation 是否自动创建 Git commit。该决策必须在 project.apply_patch 实现前完成，不能由底层工具函数偶然决定。

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
| Git executable | Project 历史、diff、内容身份 | 原则接受；Project 阶段验证 |
| SQLite + rusqlite | Operation journal、facts、outbox | N1 首选 |
| Tokio | async host、process 与 shutdown | N1 首选 |
| tracing | 结构化运行观察 | N1 首选 |
| Serde | Rust contract serialization | N1 首选 |
| Schemars | 从 Rust contract 生成 JSON Schema | N1 评估 |
| Tower | Gateway middleware composition | 第二个真实 middleware 出现后再决定 |
| Ark / Jet | 权威交互式 R runtime | N2 已复用第三方 Jet transport；本机 Ark 0.1.252 + R 4.5.2 验证通过 |
| rlang | 无求值检查 lazy binding | N3 使用；缺失时仅报告未检查绑定，不强制求值 |
| renv + pak | R environment declaration/realization | Environment 阶段采用 |
| Pixi | 外层科学环境 | Environment 阶段 PoC |
| Slurm / slurmrestd | Remote job truth | Execution 阶段采用 |
| OS containment | 真实隔离 | 按平台、按威胁模型引入 |
| TypeScript generator | 极简前端 contract | Frontend 阶段选择 |

禁止因为“未来也许有用”提前引入 DBOS、Restate、OpenTelemetry、完整 workflow runtime 或通用 policy engine。

## 19. 替换方法

### 19.1 隔离

- Next 使用独立 Cargo workspace、binary 名称、data directory 和 schema。
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

### 19.3 单项迁移流程

1. 列出 capability 的外部可观察行为和真实 owner。
2. 在 Next 中完成一条端到端实现。
3. 通过该 capability 的不变量与真实 acceptance。
4. 原子切换 routing ownership 到 next。
5. 确认所有 edge 不再能到达旧入口。
6. 删除旧实现、旧 schema、旧测试和临时兼容层。
7. 更新 Capability Ledger 和 Work Log。

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
| N4 | Project truth | Git/filesystem preconditions 与 project.apply_patch 完成切换 | Not started |
| N5 | Environment | observe/plan/realize/verify 首条链路完成 | Not started |
| N6 | Execution | local process 后再扩展 SSH/Slurm | Not started |
| N7 | Public edges | MCP 与极简前端使用统一 host ports | Not started |
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
| operation.invoke | Command port | Next 独立 CLI；旧生产入口未切换 | operation | Ready | N2 真实 runtime |
| operation.get | Query port | Next 独立 CLI；旧生产入口未切换 | operation/sqlite | Ready | N7 公共边缘接入 |
| operation.request_cancellation | Command port | Legacy 生产入口；Next Host 已验证 | operation | Ready | N7 公开入口接入 |
| operation.subscribe | Subscription | Legacy 生产；Next cursor page 已验证 | sqlite outbox/host | Building | N7 push/消费进度语义仍待接入 |
| workspace.run_r | Operation | rho-server coordinator | workspace | Ready | Next 真实 R 已验证；待统一入口切换 |
| workspace.snapshot | Query | rho-server + r/rho.bridge | workspace | Ready | 已验证 bounded/busy/无 Operation；待切换入口 |
| workspace.inspect_object | Query | rho-server + r/rho.bridge | workspace | Ready | 已验证不求值绑定与有限预览；待切换入口 |
| project.apply_patch | Operation | desktop + control-plane | project | Deferred | N4 Git precondition |
| environment.observe | Query | desktop/server/workspace | environment | Deferred | N5 owner observation |
| environment.realize | Operation | 未形成单一 live path | environment | Deferred | N5 verified receipt |
| process.run_local | Operation | 多条旧路径 | execution | Deferred | N6 local supervisor |
| slurm.submit/query/cancel | Operation + Query | execution/runner | execution | Deferred | N6 scheduler truth |
| MCP edge | Edge | rho-mcp + Agent Gateway | host adapter | Deferred | N7 no business routing |
| desktop-lite | Edge | desktop | unified client | Deferred | N7 generated contract |
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

## 24. Open Decisions

以下问题尚未决定，不能由实现者顺手固化：

| ID | 问题 | 最晚决定时间 |
| --- | --- | --- |
| N-O004 | 任意 R eval 的最低 containment 保证是什么？ | workspace.run_r 切换前 |
| N-O005 | Project mutation 默认产生 Git commit，还是保留明确 dirty working tree？ | N4 前 |
| N-O006 | SHA-256 与 BLAKE3 分别用于哪些外部兼容和本地内容身份？ | 首个 artifact 前 |
| N-O007 | macOS、Windows、Linux 的 containment capability matrix 是什么？ | 首个受限 process 前 |
| N-O008 | Rust 到 TypeScript 使用哪个单一生成器？ | N7 前 |
| N-O009 | 旧 SQLite 数据是否一次迁移、只读挂载或直接放弃？ | 首个用户数据切换前 |

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
- Git：当前 working tree，尚未提交。
- 验证：node scripts/governance.mjs check 通过（9 pages、13 areas、26 checks）；node scripts/test-governance.mjs 通过。
- 下一步：N1 walking skeleton。

### 2026-09-04 — N1 端到端骨架验证

- 实现：六个 Next crate；共享 Invocation、领域参数解析、caller scope、caller-kind/id/request-id 幂等、session precondition、单一 Workspace 执行 lane。
- 记录：SQLite application ID/schema 检查、原子 terminal commit、只读查询、跨进程写入互斥；源代码没有旧 rho-* crate 依赖。
- 验证：`cargo test --manifest-path next/Cargo.toml --workspace --offline -- --test-threads=1` 通过（包括事务故障、进程强制退出、幂等并发与独立 CLI）。`cargo clippy --manifest-path next/Cargo.toml --workspace --all-targets --offline -- -D warnings` 通过。`node next/scripts/check-architecture.mjs` 通过。
- 限制：CLI 当前返回明确标注的 fake 结果；取消请求已记录，真实 runtime 取消还在 N2；尚未切换任何旧生产能力。
- Legacy 删除：无；还没有满足切换条件的真实能力。
- 下一步：N2 Ark/R adapter，直接复用第三方 Jet 的 Jupyter transport。

### 2026-09-04 — N2 真实 Ark/R 与 CLI 验证

- 实现：新增 r-runtime adapter 和单入口 R bridge；输入/输出 schema 来自 Rust 类型；stdout/stderr 分离，条件和对象摘要有上限；运行任务在调用方断开后继续完成提交。
- 验证：`node next/scripts/test-real-r.mjs` 通过。本机 Ark 0.1.252、R 4.5.2：对象跨操作保留、幂等重试、R error 的实际 partial effects、已确认中断、内核退出 uncertain、CLI 真执行返回 42、只读查询不改变数据库。
- 范围：普通 Next Cargo suite 通过；外部 R acceptance 单独运行。其他操作系统/安装组合尚未验证。
- Legacy 删除：无；Next-ready 与 production ownership 分别记录，尚未删除仍有调用者的旧实现。
- 下一步：N3 Workspace snapshot/object Query，统一 busy/live observation；随后继续 N4—N8。

### 2026-09-04 — N3 Workspace Query 与长期 CLI 会话

- 实现：共享 CapabilityRegistry、独立无 Journal 的 QueryGateway、snapshot/inspect_object 两个 owner handler；typed stdio session 转发五个 Host port。
- 真实验证：`node next/scripts/test-real-r.mjs` 通过，覆盖两个 R 集成场景及实际长期 CLI：对象状态共享、查询不产生日志、惰性/活动绑定不被求值、普通 data frame/向量有限预览、busy 查询、取消、EOF 退出。
- 常规验证：Next workspace tests、session 分帧/超长帧/连续请求测试及 Clippy 通过；本次未运行旧系统全套测试。
- 检查点：N1/N2 代码为 `d0ba58b`；N3 将作为同一 WIP 分支的后续提交。
- Legacy 删除：无；生产消费者尚未迁移。
- 下一步：N4 Project/Git 原生状态与 patch capability。

## 26. 每次工作结束时如何更新

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

## 27. 当前唯一下一步

N4：以 Git 与当前文件字节作为 Project owner 的真实状态。

必须只包含：

- project.snapshot Query：Git HEAD、dirty/untracked 状态和请求文件的内容摘要；
- project.apply_patch Operation：owner 校验原生 precondition，调用 Git，记录实际结果；
- 保留用户已有 dirty/staged/untracked 内容，不能把 HEAD 当作工作树快照；
- Git 退出/进程中断后分别观察是否有 partial effect；不创造另一套 project revision；
- 先在临时 Git 仓库完成真实端到端验证，再切换旧文件入口。

N4 暂不包含：

- Environment；
- MCP；
- Desktop；
- Artifact framework；
- Audit、Evidence、Policy 或 Revision subsystem。

后续里程碑和旧系统删除仍属于完整目标；N1/N2 的局部验证不代表整体替换已完成。
