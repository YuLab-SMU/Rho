# Rho 内置组件 Agent：实施计划

日期：2026-09-12。计划代码基线：`3f0d2d70`。状态：**已授权实施，当前进度见 STATUS**。

本文定义具体实施范围；接入与运行证据以 STATUS 为准，新的 Studio 交互仍须单独审阅。
需求依据是用户提供的架构评议及后续讨论，最终约束为：采用现成 Agent 引擎，
避免自研循环，让各组件拥有有范围限制的助手，并共享 Rho 的真实科研系统。
实施进度只记录在 [STATUS](STATUS.md)，本文件不追加完成历史。

## 1. 实施结论与第一版完成定义

采用 **Rig 的现成 AgentRunner + 一个 `rho-agents` 集成 crate + 组件配置**。
Rho 负责上下文、授权范围、工具入口、应用记录与 UI；Rig 负责模型/工具循环和流式驱动。
使用现有 Tokio、Serde/Schemars、tracing、ApplicationStore 与 rusqlite。

第一版完整范围：

1. Objects、Packages、Plots、Documents、Console/Workspace、Files/Project、
   Environment/R Sessions 七类入口都有可用的组件助手。
2. 所有入口共享模型连接和一个助手呈现区域；按需创建运行，不为每个面板常驻一个进程。
3. 支持有证据的解释、代码建议、授权范围内修改草稿、保存并运行、核验输出。
   只完成只读演示不算整个第一版完成。
4. 支持流式反馈、停止、预算、过期上下文、并发窗口冲突、断线与 Host 重启后的核实。
5. 外部 Codex/Kimi/DeepSeek 接入继续工作；关闭或未配置内置 Agent 时，科研工作台完整可用。
6. 一条真实闭环可以完成：选中失败执行 → 解释错误 → 在授权下修改脚本 →
   保存并在明确会话运行 → 读取真实图像 → 在 Plots 中定位 → 返回证据链接。

采用以下默认产品选择，实施时不必重新进行技术选型：

- 用户主动发起；浏览对象、切换面板、启动 Rho 不触发模型请求。
- 先提供用户配置的远程模型服务，以及已有本地推理服务的连接。
  “内置”指引擎内置；第一版不承诺附带权重或免配置离线推理。
- 每次运行固定一个明确模型；不自动转发到第二家服务。
- 组件助手可以将超出范围的工作形成带来源的交接草稿，由用户继续到项目助手或外部任务；
  第一版不运行 Agent 互相聊天、递归委派或后台长期目标。
- Environment 助手负责解释版本、依赖与恢复条件，保留现有包管理产品边界。
  本计划不开放安装、升级、清理环境或切换运行环境的自动操作。

## 2. 必须明确改变的架构边界

现行 [Architecture](ARCHITECTURE.md) 和根 `AGENTS.md` 将 Agent 行为全部交给外部平台。
本提案有意增加一个**可选、内置的组件助手入口**。不能一边保留原规则的绝对表述，
一边把推理循环隐藏在 Host、Workspace 或适配器中。

实施 P1 时同步修改这两处为：

> 科研 owners 负责观察、解释原生状态、执行与恢复。Agent 行为由外部平台或可选的
> 内置组件助手负责。内置助手复用 Rig 驱动，通过同一套受校验的 Host 端口工作。
> 科研 owners、Operation、运行时适配器不承担 Agent 规划或模型调用。

授权归属也随之明确：外部任务仍由原生平台决定权限；内置任务的授权范围由
Application 的用户发起记录确定，科研层只执行机械校验。同一已授权动作不增加第二次批准。
模型不能修改自己的工具范围、目标窗口、用户身份或模型服务设置。

继续保留以下规则：

- Owner 是相应领域的解释与协调者；文件、R 和作业仍可能受到外部修改。
- 所有科研写操作进入现有 OperationGateway，查询进入 QueryGateway。
- Application 命令继续使用窗口、文档版本和捕获关联；不让模型直接操作浏览器 DOM。
- 采用现有 `workspace_instance_id`、原生 `session_id`、文档版本和文件摘要。
  不添加全局 scientific revision，也不把示意的 generation 名称强行替换现有身份。
- 使用已有 `Accepted / Running / Reconciling / Succeeded / Failed / Cancelled / Uncertain`。
  不为接入 Rig 重写科研操作状态机。
- Agent 对话是应用记录，科研成功仍由原始 Operation、原生状态和产物证明。
- 内置 Agent 不直接依赖 R、Git、SQLite、SSH 适配器，也不通过本机 MCP/HTTP 绕一圈。

补充两处材料中的概念校正：当前 R 的常驻执行由 Workspace 的 R 适配器完成，
并非必须通过 `Execution` 模块；Objects/Plots 等组件 profile 也不意味着新建同名后端 owner。

## 3. 技术选型及已核实的事实

| 位置 | 决定 | 依据与限制 |
| --- | --- | --- |
| Agent 引擎 | 首个验证版本锁定 `rig = "=0.42.0"` | 使用公开 facade，不照搬旧版 rig-core 包别名示例；P0 验证当前工具链与具体 features |
| 循环与流式执行 | `AgentRunner` 的现成 driver | 不手写 Thought/Tool/Observation 循环；应用生命周期记录不等于自研 Agent 状态机 |
| 动态工具 | `DynamicTool`、`ToolContext` | 从既有能力描述生成工具，并注入 Host 可信上下文 |
| 持久化 | 现有 `rho-sqlite` / rusqlite | 不新增 sqlx，不启用 Rig 的独立 SQLite memory store |
| 内部调用 | Rust 端口 → Host dispatch | 保留校验与调用者；不直接调用 handler/runtime |
| 外部协议 | 现有 `rho-mcp` | 本轮不升级 rmcp，不给组件助手另开 MCP server |
| 模型 | Rig 支持的 provider，经实际协议验证后启用 | 第一版落地一个兼容服务配置和一个本地 endpoint 配置；模型 ID 不写死 |
| 本地模型加载 | 后续独立工作 | 不引入 Python sidecar、mistral.rs 权重管理或 GPU 调度作为首版依赖 |

2026-09-12 通过 Context7 与版本化官方文档核实：

- [Rig 0.42 facade](https://docs.rs/rig/0.42.0/rig/) 区分可移植核心与 classic Agent runtime。
  首版只启用实际使用的引擎/网络功能，不引入向量库、搜索代理等附加集成。
- [AgentRunner](https://docs.rs/rig-agent/0.42.0/rig_agent/agent/runner/struct.AgentRunner.html)
  提供 stream、hooks、tool_context、tool_concurrency 与 max_turns。
  `max_turns` 计算模型调用总数，包含初始调用、重试和续接，不能误当成工具调用数。
- [ToolContext](https://docs.rs/rig-agent/0.42.0/rig_agent/tool/struct.ToolContext.html)
  的类型化输入和结果元数据不发送给模型，适合承载可信调用上下文。
- [DynamicTool](https://docs.rs/rig-agent/0.42.0/rig_agent/tool/struct.DynamicTool.html)
  是已发布接口；具体构造与 JSON Schema 兼容性在 P0 编译验证。
- [AgentRun](https://docs.rs/rig-agent/0.42.0/rig_agent/agent/run/struct.AgentRun.html)
  有可序列化运行状态。这不证明 Rho 科研调用能安全自动续跑；首版不持久化并自动回放它。

以上是制定计划时的文档证据；后续编译和真实模型验证结果只记录在 STATUS。
已有外部 Kimi/GLM 验收证明原生 CLI 路线可用，不证明同一服务能被 Rig 直接调用。
P0 必须验证流式工具、多模态和取消行为，不能用“OpenAI-compatible”标签代替验收。

## 4. 模块与依赖设计

```mermaid
flowchart TB
    UI[Studio 组件入口] --> APP[Application：用户请求、范围、记录]
    APP -.执行端口.-> ENG[rho-agents：Rig driver / profiles / tools]
    ENG --> MODEL[共享 provider client]
    ENG --> PORT[RhoToolAccess：受限 Rust 端口]
    PORT --> HOST[Host dispatch]
    HOST --> QUERY[QueryGateway]
    HOST --> OP[OperationGateway]
    HOST --> AC[Application commands / captures]
    QUERY --> OWNER[现有 owners]
    OP --> OWNER
    AC --> OP
    EXT[外部 Agent / MCP] --> HOST
```

Host 负责装配实现与生命周期；上图不是要求每个 domain 再新增 Host 业务函数。

拟修改位置：

| 文件/模块 | 具体工作 |
| --- | --- |
| `crates/agents/`，包名 `rho-agents`（新增） | `lib.rs` 接入 Application 执行端口；`registry.rs`/`profiles.rs` 定义角色；`tools.rs` 转换工具；`context.rs` 整理模型上下文；`runner.rs` 包装 Rig driver；`provider.rs` 构造 provider |
| `crates/contract/src/component_agent.rs`（新增） | 请求、来源引用、授权范围、运行摘要、事件和设置 DTO；不暴露 Rig 类型 |
| `crates/application/src/component_agents.rs`（新增） | 组件会话、请求准入、CAS、运行/工具记录、查询与停止语义；定义执行器/工具访问/记录端口 |
| `crates/adapters/sqlite/` | 给 ApplicationStore 增加组件助手表与事务实现，沿用当前项目/principal 可见性 |
| `crates/host/src/component_agents.rs`（新增） | 装配服务；实现受限工具端口；连接项目、会话及 Host 生命周期 |
| `crates/host/src/agent_context.rs` | 提取可复用的来源验证/媒体读取；对原生输入转换继续保留其原有出口 |
| `crates/workbench/src/component_agents.rs`（新增） | 经过现有认证和窗口校验的薄路由 |
| `ui/src/component-agents.ts`、`component-agent-ports.ts`（新增） | 单一客户端状态模型、范围、事件游标、草稿和请求命令 |
| `ui/src/host-client.ts`、`studio.ts`、组件 renderer | transport 接线、生命周期、Ask 入口和共享助手视图；面板不直接发请求 |
| `ui/src/panels/` 与设置页 | 共用已有输入、上下文、活动和证据呈现组件；内置助手设置 |
| Cargo workspace、架构/前端 boundary checker、governance | 注册新 crate、允许依赖、源区域和对应检查 |

依赖方向：`rho-agents → rho-application + rho-contract`；
`rho-host → rho-agents`；`rho-sqlite → rho-application` 保持不变。
Application 仅持有执行端口定义，不依赖具体引擎。Rig 类型仅存在于 `rho-agents` 内部。
不会新增 `AgentGateway`、科研 `AgentOperation`、跨 Agent bus 或并行事实库。

### 为什么不把 Builtin 塞进现有 AgentProvider

目前 `AgentProvider` 是 Codex/Kimi/Deepseek 原生程序枚举。
`AgentTask`、`AgentAttachment`、`StoredAgentTask` 分别包含原生会话、连接、进程所有权、
原生 quiet/resume 等语义；AgentTaskEvent 也要求原生会话身份。

首版新增 Application 内的组件助手记录与端口，保留原生任务模型。
复用窗口控制、草稿 CAS、请求摘要和可组合 UI 的机制；不复制整份原生任务服务。
统一的是日常入口和显示组件，不是伪造 PID/native_session_id 或先重写所有外部接入。

现有 `AgentContextReader::query` 将非 ready 转为错误并只取 data，不能直接作为
通用模型工具出口。新工具端口保留完整 QuerySnapshot，包括状态、来源、时间、完整性和续读。

## 5. 七个组件 profile 与实际工具范围

profile 仅保存说明、能力允许列表、来源类型、可用动作、模型需求和预算。
它引用共享注册表中的真实能力，不复制输入/输出 schema，也不编造不存在的 `objects.compare`。

| Profile / 入口 | 用户场景 | 读取与动作 |
| --- | --- | --- |
| Objects | 解释结构、大小、维度，比较两个已选对象 | `workspace.list_objects/observe_object/read_object`；比较由读取结果推理，不能偷跑 summary/print |
| Packages | 解释版本、安装副本、函数用法或来源 | `workspace.packages/package_index/read_help`；不加载、安装、更新包，不从当前仓库推断安装历史 |
| Plots | 解释选中图、比较两张图、查产生它的执行 | `workspace.list_outputs/read_output`、`output.view`、原操作；显示原始媒体引用，有视觉能力才做图像判断 |
| Documents | 解释选区、改写函数、修复代码 | `application.read_document/context`；获授权后 EditDocument/Save/RunFile，保留文档版本与捕获 |
| Console / Workspace | 解读错误，定位失败队列，运行明确代码 | runtime/console 状态、原操作、包与有界对象观察；执行模式下 `workspace.run_r` 或 captured Run；只控制本次关联操作 |
| Files / Project | 找相关脚本、解释项目、完成一段跨组件分析 | `project.list_directory/read_text/search_text`、原操作与所选来源；获授权后受限 patch 或应用文档动作；不默认开放任意进程/SSH |
| Environment / R Sessions | 解释会话版本、环境绑定、恢复副本限制 | `environment.observe`、运行会话/恢复目录的既有查询；建议可定位到管理页，本 profile 不执行生命周期或包管理变更 |

所有 profile 可在范围内读取 `host.describe`、`host.resolve_context`、`skill.list/read` 和
原始 Operation。具体能力的可用性与参数以 Host 注册表为准；恢复/会话查询沿用其真实名称。
Packages 等缺少活 R 的场景应解释不可用原因，不启动另一个 R 来填补观察。
模型工具名若需将点转换为下划线，记录可逆映射并检查重名；最终校验仍用真实 capability ID。
Provider 需要展开 `$ref`、限制 schema 深度或去掉不支持的展示关键字时，只生成派生 schema，
不修改 Host 原始契约；派生失败就标记该工具不可用。调用时对完整输入再次按 Host schema 校验。
由 Host 注入的身份/目标字段不允许被模型参数覆盖，原始字段与实际送模字段的映射可检查。

### 授权方式

启动请求包含明确的能力模式与目标范围：

- **Explain**：有界查询，输出解释、建议和可检查的代码草稿。
- **Edit**：在指定文档内通过 Application 修改草稿；额外保存权由请求单独注明。
- **Run**：在明确项目、文档/代码与 R 会话上执行已授权的保存/运行及结果核实。

用户选择“修复并运行”可以一次授予这段工作需要的权限，不逐工具重复询问。
单纯询问“为什么报错”不会默认为可以改文件或运行代码；不足时返回具体操作提案。
上下文文本、Skill 正文和模型输出都不能创建授权。

`application.control` 必须进一步按 action 和目标检查；不能因为允许 SelectPlot 就放开
EditDocument、Save 或 RunFile。直接 Project patch 也绑定明确路径与原摘要。
`workspace.run_r` 能产生任意 R 副作用；Run 模式应如实说明这一点，不能宣传为只修改某对象的沙箱。

## 6. 一次运行的具体协议

新增以下名字均为计划 DTO/接口，不是现有能力：

1. Studio 以稳定 `request_id` 发 `ComponentAgentStart`：组件、用户文本、当前窗口引用、
   来源引用、模型配置引用、能力模式。请求去重的身份在发送前可靠保存。
2. Application 验证项目/principal、窗口 incarnation/控制权、允许范围、已有运行与预算，
   持久化规范化请求与摘要后返回 `run_id`。同 ID 同内容返回原记录，内容不同拒绝。
3. 服务从现有 owners 读取上下文，记录实际观察来源。模型看到必要内容；Host 可信 CallContext
   留在 ToolContext，调用者标为 Agent，principal 继承已认证用户，工具范围取交集。
4. Registry 以 profile、用户授权及当前能力可用性生成本次 ToolSet；首版一轮内工具调用串行。
   不把公共模型参数设计成可任填的 HostRequest、scope 或当前窗口。
5. Rig AgentRunner 驱动多轮。模型发起工具时，RhoToolAdapter 再验证范围、身份与原生前置条件，
   先记录工具意图，再调共享端口。长 R 操作先得到 accepted receipt，后续只观察原 Operation。
6. 结果保留原始错误、busy/stale/uncertain、产物身份和续读信息，再交给模型。
   UI 工具状态来自记录；流出的“我完成了”不构成科研成功。
7. 回答与有类型的 evidence references 一起存入 Application。
   UI 的成功标记必须关联已核实的终态；解释性结论仍标为模型推断。

HTTP 控制面提案：`/api/agents/components/query`（列表、运行、事件、原回执），
`/command`（start、stop、continue、draft/control），`/settings`（非秘密配置与当前连接状态）。
端点属于 Application 控制，不把模型推理登记成科研 Operation，也不让外部 MCP 默认触发内置模型。
复用 loopback、bearer、Origin、窗口与项目检查；原 MCP 专用凭证不能控制这些端点。

### 上下文与证据

每次绑定 canonical project、principal、window/incarnation、组件/view、
`workspace_instance_id` 和 `session_id`（适用时）、文档/选区版本、文件摘要、对象观察、媒体引用。
来源不存在、过期或权限不足时保留原因。点击发送之后切换面板，不会改变已接受请求的目标。
后续每次工具执行仍核实当前状态，不把“开始时检查过”当作全程有效。

不发送全局 Environment、整个大表或完整库列表。按问题读取小块；长文本与大表继续使用 owners
的分页规则。图像从 Output owner 的已验证原件/预览读取，不能把本机存储路径交给 provider 抓取。
Skills 只读取已声明和可访问的源，正文作为方法上下文；不会调用 Rig 的文件 loader 扫描私有目录。

Evidence references 复用 OperationId、MediaReference、ApplicationDocumentRef、观察引用和文件摘要。
回答不拥有对象/产物副本，也不新增 PROV 数据库。过期的对象引用可用于解释历史，但不能当作活引用调用。

## 7. 应用记录、停止和恢复

在现有 ApplicationStore 中增加四组语义明确的记录，物理表名在 P1 固定：

| 记录 | 关键字段与事务 |
| --- | --- |
| Component conversation / draft | project、principal、组件、controller、版本、短对话、草稿；CAS 更新；不绑定面板挂载 |
| Run | run/request ID、输入摘要、profile 版本、模型配置、scope、context refs、Host incarnation、状态、usage、终态原因 |
| Tool receipt | run + 模型调用序号 + tool_call_id、参数摘要、稳定 client_request_id、application command/Operation ID、原始结果引用、未确认阶段 |
| Bounded events | sequence、run_id、文本片段/工具/状态/证据、时间；终态即时提交，其余合并；游标只指向已持久化事件 |

科学 journal 与 ApplicationStore 不假设跨库原子事务。
通过“工具意图先落盘 → 使用同一稳定请求 ID → 记录关联回执 → 查原始结果”跨越崩溃窗口。
Rig 原生会话状态不进入长期数据库格式。新增表采用 additive schema change，
保留当前有效原生任务记录，不添加废弃实现的数据导入。

运行展示状态使用 Queued、Running、Waiting for R、Needs input、Stopping、Completed、
Stopped、Failed、Interrupted 等应用状态；科学操作终态始终分开显示。
Completed 表示助手运行完成，不能覆盖失败/不确定的科学证据。

| 时点/事件 | 行为与验收依据 |
| --- | --- |
| 工具意图尚未落盘失败 | 不 dispatch；不得执行一个无法追踪身份的写操作 |
| 意图已存，dispatch 前崩溃 | 先查同 request ID 的 owner 回执；只有确认原请求未提交才允许显式继续，不猜测 |
| R 已接受，但回执丢失 | 查同 request/Operation，不提交第二段代码；不能把超时转换成新请求 |
| Tool 已完成，模型回答丢失 | 保留实际结果；显式 Continue 可基于原结果做新模型调用，不回放工具 |
| 模型用新 call ID 重复请求相同 mutation | 不仅做 call ID 去重；对同 run、同规范化动作/目标/前置条件识别可疑重复，返回原记录；有意重复需新的明确动作身份 |
| 页面断线/关闭 | 已接受运行由 Host 管理；重连观察原 run；默认不自动取消科学操作 |
| Stop | 先禁止后续模型/工具 dispatch；停止模型等待；对本次绑定的活动/排队 Operation 按现有取消协议处理并核实；绝不停止同会话的其他工作 |
| 模型请求取消后 | provider 可能已处理或计费；本地拒收旧代输出，不宣称远端已撤回 |
| Host 崩溃 | 非终态 run 标 Interrupted；显式 Continue 先核实 tools/科学操作和新上下文，不自动恢复 AgentRun |
| R 重启/文档变化 | 原请求目标失效，拒绝继续写入；保留提案及旧证据，不悄悄改投当前会话 |
| 两窗口/重新控制 | CAS 与 controller generation 排除旧窗口写入/停止；模型晚到回包按原代隔离 |
| stdin | 显示现有原生输入请求交给用户；不让模型代填秘密，不把输入写入 Agent 历史 |
| Quit / 关闭内置功能 | fence 新运行和晚到工具，处理关联操作后使用原有 Quit 保护链；接受过的科研记录不随开关删除 |

科学调用一经接受，必须由 Host 保持所有权；取消 Rig future 不得同时丢弃对原操作的跟踪。
所有带副作用步骤都必须通过上述持久回执门，不能只依赖 prompt、Rig hook 或内存去重。

## 8. 模型设置、预算与退化

第一版设置字段：启用开关、provider 类型、base URL、model ID、图像/工具能力的验证状态、
凭证引用、当前请求预算。只接受明确配置的 endpoint，不扫描原生 CLI 的私有认证。
用户未配置时展示入口及配置引导，普通工作台无错误弹窗、无模型请求。

凭证首版支持 Host 环境变量引用或仅驻留当前 Host 内存的会话密钥；设置库只存引用和非秘密字段。
不把原始密钥写入 SQLite、Studio 同步片段、日志或 evidence；浏览器提交后的字段立即清空。
持久系统凭证保险库可作为后续增强，不把它作为首版必须搭建的新子系统。
远程 endpoint 使用 HTTPS；已有本地服务可显式使用 loopback HTTP。

Test 由用户明确触发，使用固定的非项目内容，验证模型连接、schema/tool-call 与流式模式；
图像支持另有明确的合成图验证。失败保留诊断，不假装支持，不自动安装服务或模型。
“已安装 Kimi CLI”不能被解释成“已有可读取的 provider API Key”。

发往模型的内容在发送前可从上下文预览看见；明确标示所选服务。
流式推理仅呈现忙闲阶段，不持久化私密 reasoning；内容 tracing 默认关闭，保留耗时与 usage。
模型输出、文档、包帮助和图内文字均视作数据，不能改变执行范围。

以下为建议默认值，P0/P5 根据测量调整，并由服务端发布：

| 限制 | 默认 | 规则 |
| --- | --- | --- |
| 同时活跃运行 | 每 Host 2、每 conversation 1；等待最多 8 | 不占用外部 Agent 的原生进程连接槽；超额明确拒绝 |
| 模型调用 | Explain 4、Edit 6、Run/Project 12 | 包括失败格式修复；预算耗尽保留已有结果，不重新起循环 |
| 工具调用 | 分别 8 / 12 / 16；并发 1 | 页数和字节另外计量；禁止无限 tool batch |
| 单模型请求上下文 | 64 KiB 文本上限，并满足实际模型 token 上限 | 两种限制取更严格值；UTF-8 字节不能冒充 tokens |
| 单运行工具文本累计 | 256 KiB | 已有 owner 限制仍生效；截断标注并保留续读 |
| 输出/图像 | 每模型调用 2,048 输出 tokens；至多 2 张图，每张最多 2 MiB | 受 provider 更小限制约束；缺视觉能力拒绝看图结论 |
| 时限 | 每模型请求最长 120 s；运行计算/观察活动最多 10 min | 等待用户输入单独标记；到期停止新工具并按 Stop 处理已有操作，不制造成功/自动重试 |
| 留存 | 每 conversation 32 条短消息；最多 500 事件 / 1 MiB，项目 64 MiB | 沿用受限应用观察理念；活动和未确认回执不得因事件淘汰丢失 |

实现测量修订：Run 默认从 8 调整为 12 次模型调用。真实模型的失败修复验收在
8 次调用时已完成诊断、恢复队列和草稿修改，但尚未提交修复后的运行及最终回答；
其他字节、工具数量、时限和并发限制不变。验证结果记录在 Status。

usage 缺失时写 unknown，不填零；不展示没有价格证据的费用估算。
过载、网络失败或模型不可用时，用户仍能编辑、运行、查看、保存和恢复 R。

## 9. Studio 交互提案与设计门

采用各组件的 **Ask about…** 入口，激活现有 Agent 区域里的 **Rho Assistant** 视图。
七个组件不各自增加一套聊天面板。入口附带当前选择，用户仍能查看、移除或补充上下文。
每条组件对话保留来源与固定目标；新运行重新核实，切换组件不会把旧对话静默改绑定。
现有外部任务保持原名称、历史、草稿和原生权限呈现。

界面显示：问题/来源 → 当前活动 → 解释或代码提案 → 真实执行与证据。
Explain/Edit/Run 是可见能力选择，不显示 Rust trait、Operation envelope 等实现概念。
对象比较、图像证据打开、文档修改沿用现有组件命令。

实现 UI 之前，在现有 Paper 文件新增独立 Built-in Assistant 评审页，至少准备：

1. B01：Objects 入口、已选来源和一个有证据的短回答。
2. B02：Documents/Console 中建议、授权编辑运行、失败与成功证据。
3. B03：Plots 比较、视觉模型不可用、源图定位。
4. B04：外部任务与 Rho Assistant 的导航关系，关闭/重开不丢草稿。
5. B05：模型设置、未配置与错误状态、清晰的远程数据去向。
6. B06：窄面板、过期目标、停止/断线/恢复、双窗口冲突。

需要用户审阅 Paper 后才能实现这项较大的交互扩展，这是根 AGENTS.md 的现有要求。
当前计划不需要提前请求该批准；P0 后端可行性验证和本计划可先完成。
设计验收检查 320 px 组件区域以及 600/1024/1440/1920 px 窗口，使用真实长度内容。
产品文案用英文，中文输入保留已修复的原生 IME 组合行为。

## 10. 分阶段实施和可评审交付

以下按熟悉本仓库的一名开发者串行估计，含阶段测试，不含等待 Paper 反馈、
外部服务故障、签名发行及额外跨平台修复。预计 **17–26 个开发日**；P0 后重估。
数百行可以做演示，不能据此估算可靠持久化、取消、模型设置和七组件验收。

| 阶段 | 工作与交付 | 退出门 | 估计 |
| --- | --- | --- | --- |
| P0：Rig 可行性 | 在隔离试验中锁定 0.42；现成 runner + 动态只读工具 + ToolContext + 假 provider；测 build/features、流式、回调、取消、schema、图像与 max_turns | G0：不自研循环即可满足工具意图持久化/调用身份注入；fake tests 全过；一个实际配置服务的工具/图像 smoke 有独立记录，缺配置明确未验证 | 1–2 日 |
| P1：边界与应用基础 | 更新架构规则；新 crate/contract/ports/store；run 与 tool receipt 准入、去重、模型配置及禁用路径 | G1：无模型也可测试全部准入与隔离；新表不影响原生 Agent 数据；依赖检查、契约/SQLite/应用测试通过 | 3–4 日 |
| P2：只读纵向闭环 + Paper | Objects 起步，随后 Packages/Plots；共享上下文与证据，真实模型读真实 R；制作 B01–B06 并评审后实现共享 UI | G2：三类读取与来源定位可用；不新增科研 Operation；视图操作零模型请求；审阅与浏览器证据齐全 | 3–5 日 |
| P3：授权执行闭环 | Documents、Console/Workspace、Files/Project；Edit/Save/captured Run、直接受限 R 执行；原操作等待/失败与图像核验；Environment/R Sessions 解释入口 | G3：七入口可用；真实失败→修复→运行→图闭环；越权、过期草稿和跨会话请求均拒绝且不产生副作用 | 4–6 日 |
| P4：恢复与资源纪律 | Stop、超时、重复模型 call、崩溃点、重连、双窗口、输入等待、禁用/Quit；预算和事件淘汰 | G4：每个崩溃窗口最多一次科研 dispatch；所有不确定状态保留；不取消他人工作，核心分析可独立运行 | 3–4 日 |
| P5：完整验收与文档 | 回归现有外部 Agent/科学/Studio 能力；七 profile 场景、真实模型重复验收、性能比较、使用说明 | G5：下节矩阵全部有合适范围的证据；未测项如实列出；构建和安装/发布明确分开 | 3–5 日 |

P0 若发现具体 provider 或必要 Rig hook 不能满足约束，先记录最小复现并调整适配方式/锁定版本。
不得以失败为由悄悄改为自研 Agent、引入 Python sidecar 或跳过写操作持久化。
需要更改选型时，将可比较的实验结果带回此设计决策。

第一笔实现提交应是 P0 试验和最小集成边界，不应先批量创建七套 agent 文件或重构外部任务。
后续每阶段形成可单独评审的提交；不把尚未验证的所有组件一次合入。

## 11. 验收矩阵与测试入口

| ID | 必须证明什么 | 权威证据 |
| --- | --- | --- |
| A01 | Rig 被复用，依赖不泄漏 | 锁定 Cargo.lock；P0 编译；architecture allow/reject fixtures；其他 owners 无 Rig import |
| A02 | 关闭/未配置时没有模型开销 | fake provider 请求计数为 0；正常编辑/执行/查看测试与打开组件网络记录 |
| A03 | 内外 Agent 同一科研事实 | 同一 fixture 的 direct-port/MCP 查询逐字段核对（排除明确不同的时间/传输字段）；同一操作读回一致 |
| A04 | profile/授权约束真实生效 | 故意构造 run_r、泛化 application.control、路径越界、改 session、Skill 注入；拒绝后检查 journal/文件/R 没有目标副作用 |
| A05 | 状态与范围持续准确 | busy、expired、partial、R restart、文档版本变化；不能拼接新旧观察或覆盖后来输入 |
| A06 | 写入不盲目重放 | 对 intent 前后、accepted 前后、tool result 前后注入崩溃；统计原生执行/文件追加次数与回执身份；含模型新 call ID 重复动作 |
| A07 | Stop 与 Quit 后果准确 | 排队、运行、stdin、provider 静默、晚到工具、另一个 session 同时执行；核实真正终态与未受影响工作 |
| A08 | 产物与结论有来源 | 真实合成图/对象与 manifest 摘要；仅保存文件却无 Plots 产物时不能宣称已显示；误报成功不能变成 UI 成功 |
| A09 | 七 profile 完整 | 每个 profile 至少一条成功、一条不可用/范围不足场景；Documents/Workspace/Project 包含授权写入，Environment 保持既定只读边界 |
| A10 | 交互可用 | Paper 审阅；Chrome 的窄/正常/宽、键盘、IME、上下文固定、多窗口、关闭重开、外部任务切换及截图 |
| A11 | Provider 与数据处理 | 假服务收到的请求不含 secrets/私有身份；远程/本地连接测试分记；图像能力失败不冒充成功；内容 telemetry 关闭 |
| A12 | 资源与历史有界 | 超并发、超调用、超 byte/token、巨大工具批次、事件上限；控制读取仍可响应；回执与活动引用不被淘汰 |
| A13 | 旧能力不回归 | 原生 CLI 任务、MCP、R 运行、包/对象观察、恢复与草稿的既有测试；没有导入或改写原生用户配置 |

拟新增测试位置：`crates/agents/tests/`、`crates/host/tests/component_agents.rs`、
`ui/tests/component-agents.test.ts`、`ui/e2e/component-agents.spec.ts`。
新增 `scripts/test-component-agents.mjs`：默认 fake provider；`--real-model` 为显式真实模型验收，
使用临时项目/Host，输出原始模型请求摘要、工具轨迹、Operation 回读、图像摘要与判定。
后端与脚本现已实现；`--real-sources` 还会运行真实 R 来源、文档修复、Continue 和生成图像验收。
UI 测试入口仍待 Paper 评审后的界面实现。各项实际执行记录以 Status 为准。

A03 的 `crates/mcp/tests/component_fact_parity.rs` 使用真实 R、本地 HTTP 假模型和
真实 Rig 驱动，对比内置工具、直接 Host、MCP 的原生操作与查询结果；仅排除观察时间。
测试同时核对只新增一次执行、后续读取不新增科学事件，已纳入 `scripts/test-real-r.mjs`。

真实模型验收至少包含七 profile 各一例，以及两条完整修复/运行场景；每例重复三次，
共 27 次，固定模型配置和代码版本，保留所有尝试。越权、重复执行、错误目标、伪造产物
属于任一发生即不通过；不能用问候成功或总体成功率掩盖这些失败。
只测一个 provider 时，只声明该 provider 已验证；本地服务独立记录，不能挪用远程通过结果。

后端完整矩阵入口现为 `node scripts/test-component-matrix.mjs --run`：七 profile
加文档修复、修复后生成并读取图像两条场景，各三轮。运行前明确配置
`RHO_ARK`、`RHO_R_HOME`、`RHO_COMPONENT_MODEL_BASE_URL`、`RHO_COMPONENT_MODEL_ID`、
`RHO_COMPONENT_MODEL_PROTOCOL` 和 `RHO_COMPONENT_MODEL_KEY_ENV` 指向的密钥环境变量。
默认调用与 `--self-test` 不访问模型；`--run --case=ID` 只复测指定场景，不能宣称完整矩阵通过。
脚本串行构建/执行，固定后端源码指纹，逐次保存日志与 `target/component-matrix/*/summary.json`，
记录模型配置与密钥引用名，不记录密钥。失败尝试保留；该矩阵不代替 Studio 和性能验收。

Anthropic 兼容服务的图像排查可使用 `node scripts/test-component-image-wire.mjs --run`。
它要求已构建 `component_source_probe`，沿用上述 R/模型环境变量，并仅支持 HTTPS 根服务地址。
本地转发器保留原始请求/响应，只记录图像哈希、尺寸、块顺序和 HTTP 状态，不记录密钥、
请求头或提示词正文。该诊断不能代替直连模型矩阵。图片及来源标签位于长问题/上下文之前，
采用[官方视觉接口的建议顺序](https://platform.claude.com/docs/en/build-with-claude/vision)；
兼容服务上的效果须单独验证。

实施期间使用现有命令，Cargo 与类型生成串行：

```sh
node scripts/governance.mjs impact --changed-auto
cargo test -p rho-contract --locked
cargo test -p rho-application --locked
cargo test -p rho-sqlite --locked
cargo test -p rho-host --locked
node scripts/check-architecture.mjs
npm run generate --prefix ui
npm run build --prefix ui
npm run check --prefix ui
npm run test --prefix ui
npm run check:boundaries --prefix ui
npm run test:boundaries --prefix ui
cargo build --locked
npm run test:browser --prefix ui
node scripts/test-real-r.mjs
node scripts/test-workbench.mjs --real-r
node scripts/test-mcp.mjs --real-r
node scripts/test-agent-task-recovery.mjs
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
node scripts/governance.mjs check
node scripts/test-governance.mjs
```

新增 crate 后补 `cargo test -p rho-agents --locked`。触及 Quit/会话恢复时补
`node scripts/test-r-checkpoints.mjs`；环境功能改动补 `node scripts/test-environment.mjs`。
实际原生 Agent 回归按 [Development](DEVELOPMENT.md) 的显式模型命令执行，
至少覆盖配置可用的客户端；缺少外部依赖是未验证，不能计为通过。

性能使用同机同脚本对照基线：未启用时模型调用数为零；启用并运行时测打字、frame p95、
Stop 首次本地反馈、内存、provider 首 token 和工具耗时。沿用 Studio 的既定测量方法，
新增门为打字/frame p95 相对匹配基线退化不超过 10%，Stop 本地反馈不超过 250 ms；
provider 延迟单列，不把它算成 UI 卡顿，也不伪装固定模型响应时限。
P0 记录发行构建大小和依赖增量，P5 对照；不预先编造开销结论。

## 12. 计划完成审计与后续入口

| 用户材料要求 | 本计划的具体落实 |
| --- | --- |
| 各组件的小 Agent | §1、§5、P2/P3、A09：七 profile，不缩成单个聊天演示 |
| 使用现成引擎，避免重造工程 | §3、§4、G0/A01：Rig driver 与一个集成 crate |
| 内部直接调用真实能力 | §2、§6、A03/A04：共享 gateways 和 Application 捕获 |
| Owner 与 Agent 分离 | §2/§4：依赖图、原生状态与应用记录分开 |
| 工具与上下文受限、运行有界 | §5/§6/§8、A04/A05/A12 |
| 不膨胀成多 Agent 平台 | §1/§4：按需 profile，结构化交接草稿，无递归循环/私有向量库 |
| 能继续工作且真实反映执行 | §7、P4、A06/A07/A08 |
| 适配当前仓库而非空泛技术清单 | §4 文件级改动、§10 分阶段依赖和估算、§11 测试命令 |

执行顺序从 P0 开始；具体完成情况和下一步入口只记录在 STATUS。
需要实施时取得的是真实模型配置与 Paper 交互审阅，不需要为普通科研查询添加新的批准层。
本计划不以附带本地权重、环境管理插件、跨平台发行或无限项目 Agent 作为隐藏前置条件。
