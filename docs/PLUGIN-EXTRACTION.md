# 可复用插件边界与后端解耦

Updated: 2026-10-16

Rho 的基础插件提供可复用系统能力。具体分析的问题、数据、设计公式、contrast、步骤和
领域判断属于项目脚本或 recipe；`Real R analysis: paired dexamethasone response`
是验收样例，不是插件目录中的功能单元。插件能力与可选 UI entry 的完整定义由
[Rho-plugins 插件模型](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PLUGIN-MODEL.md)持有。

0.2 已按该边界完成后端代码解耦，交付 `/api/v2`、客户端和无副作用状态夹具。
普通 base-R 项目和原 paired 分析均通过同一套能力运行，实际检查及安装状态见
[解耦验收](EXTRACTION-ACCEPTANCE.md)。本轮不做 UI。
原 [BP-01–BP-06 验收](BACKEND-ACCEPTANCE.md)继续证明固定 v1 组合中的真实执行、
共享文档、Agent 接管和连续性；该组合不是已经完成的通用插件底座。
可复用契约的解耦验收是插件 UI 接入的前置条件。

## 抽象依据

插件按可复用行为、状态 owner 和生命周期划分。一个文档能力可以贡献代码查看、编辑和
diff entry；撤销或每个按钮不独立成为插件。图像预览与交互图表各有独立资源契约，
不依赖某个分析流程。先按明确模块组合交付，不预设每个能力必须独立 npm 包，
也不因此建设动态插件市场或通用流程引擎。

| 能力边界 | 插件负责 | Rho 消费的通用事实 |
| --- | --- | --- |
| 文档与代码 | 单一 buffer、事务、undo、条件保存、执行/上下文快照 | 文档引用、版本、修改事实；View 不再持有另一份内容 |
| 文件与产物 | 包含关系内的文件、字节快照、格式声明、清单与完整性 | 文件/资源引用、来源、独立版本、可用性和有界读取 |
| R 执行与对象 | 代码快照和运行参数、R 适配器、显式导出或受支持的对象观察 | 执行计划、原生环境身份、对象描述/快照和预览范围 |
| 依赖管理 | 所选能力/动作的要求、原生检查和显式准备 | 实际环境、检查时点、present/missing/unknown 与准备结果 |
| 表格 | 声明列类型/缺失值、稳定 key、有界排序筛选和所选双输入变换 | 数据页、key 空间、两份输入版本与覆盖范围 |
| 图片与 PDF | 文件或页资源、原图、缩放/平移等呈现所需信息 | 图像版本、页/坐标信息；像素范围不冒充表格实体 |
| 交互图表 | 真实数据/spec、显式字段与实体映射、采样信息 | 数据引用、字段约束、mark 到稳定 key 的映射 |
| Agent 接入与上下文 | 工具/资源适配、上下文序列化、调用方原始意图 | 实际连接能力、版本化引用、工具回执；外部对话仍归实际客户端 |

Rho 持有认证、项目可见性、受理请求与 Core 身份的映射、组合/布局和交互路由。
Core 继续通过公开 CLI 提供执行事实与 resident Host。
领域 adapter 可以提供可复用的参数化操作或对象 reader；固定数据、公式和流程的 recipe
不会因改名为“分析插件”而成为基础能力。Agent evaluator 保持独立开发工具身份。

变量查看必须由真实运行时能力支持。现有 batch Rscript 可以显式导出对象摘要和快照；
驻留 Core Host 不代表驻留 R 解释器。实时变量查看、对象修改和 R 内存恢复需要另行验证的
原生会话能力。读快照不能隐式启动 R、执行任意表达式或重建会话。

## 审计起点与实现结果

下表保留 0.1 审计起点。0.2 已落实右列边界：旧 schema 移至
[legacy-protocol.ts](../src/legacy-protocol.ts)，新工作使用 [v2 JSON](../protocol/v2.json)；
`r.execute` 接收显式脚本、依赖与产物声明，表格和选区使用声明的类型、key、namespace。
科学脚本和 checker 留在 Plugins examples，基础 tarball 不含它们。

| 当前位置 | 耦合 | 解耦后的 owner / 契约 |
| --- | --- | --- |
| [公共 schema](../src/protocol.ts)及生成的 [v1 JSON](../protocol/v1.json) | 动作限于 `airway.analyze` / `airway.shrink`；比较入参固定 `baseline` / `shrinkage` | Rho 校验通用 envelope；所选插件提供动作/资源 schema 和版本 |
| [请求协调](../src/requests.ts) | 直接调用 `planAnalysis`、科学产物收集与 checker | Rho 保留受理/身份/执行桥；通过所选 owner 的执行计划和产物/检查入口分派 |
| [服务路由](../src/server.ts) | selection/context 硬编码 `gene_id` | reader 声明 key 与坐标；Rho 路由带资源版本的选区 |
| [组合与恢复](../src/workspace.ts) | 比较视图检查 shrinkage/baseline 的科学关系；恢复选区要求基因 ID | 通用 entry/props/binding 校验；领域关系由领域 owner 检查 |
| [Plugins catalog](https://github.com/YuLab-SMU/Rho-plugins/blob/main/headless/src/catalog.ts)与 requirements | 固定两条科学动作和 R 包集 | 可复用能力/entry 声明；recipe 显式提供所需依赖 |
| [Plugins analysis](https://github.com/YuLab-SMU/Rho-plugins/blob/main/headless/src/analysis.ts) | 默认选择内置 airway 脚本；固定数据、contrast、模型路径、基因数及 checker | 运行时接收显式项目脚本快照；科学选择与检查留在 recipe |
| [Plugins resources](https://github.com/YuLab-SMU/Rho-plugins/blob/main/headless/src/resources.ts) | owner 固定 airway；按科学列名推断类型；散点和比较固定 fold change | provider 声明格式、类型、key 和字段映射；通用文件/表/图 reader 不推断分析含义 |
| [Plugins 包清单](https://github.com/YuLab-SMU/Rho-plugins/blob/main/package.json)及 [Rho 打包](../scripts/pack-local.mjs) | 基础包携带并依赖科学样例 | 基础能力可独立安装；科学样例由验收 consumer 或项目显式选择 |

测试中的科学数据和 gene ID 可以保留。问题是它们进入了应用路由和基础能力的必需语义。
原脚本、产物、失败和已验收 tarball 都保留，避免把旧证据误记为新架构验收。

## 实施顺序与完成条件

下面工作插入 BP-06 与功能插件 UI 实施之间。PX-01–PX-05 的通用后端已实现并检查；
源码及实际 npm 安装中的双消费者、恢复均已通过，并单独冻结候选身份。功能插件 UI 后续独立实施，
继续遵守现有设计审阅与浏览器验收要求。

| 工作 | Owner | 可观察的完成条件 |
| --- | --- | --- |
| PX-01 · 分离 recipe 与基础目录 | Plugins；Rho 选取组合 | 基础包/目录不携带 airway recipe 或注册固定科学动作；普通文件/文档操作不要求 DESeq2；样例入口与历史验收仍可定位 |
| PX-02 · 通用调用与 R 适配 | Plugins 交付显式脚本、依赖 provider、产物/检查入口；Rho 分派 | 任意选中的项目 R 脚本使用真实磁盘或未保存快照执行；依赖来自所选声明；Rho 的请求协调不按科学动作分支 |
| PX-03 · 资源、选区与呈现契约 | Plugins 文件/表/媒体/图表/对象能力；Rho 路由 | 非基因 key 的表格可排序、选择、传上下文；双输入显式声明 key/字段/join；原图和交互数据分别可读；对象快照有真实来源与预算 |
| PX-04 · 版本化交付与组合 | Rho 公共协议、client/fixtures/恢复/打包；Plugins entry schemas | 组件/entry 类型、版本、bindings 与 availability 可发现；缺失组件保留引用；旧请求仍可观察，恢复不执行；不兼容协议有显式版本 |
| PX-05 · 两种消费者与安装验收 | 各 owner 先验收，Rho 验收真实组合 | 无科学样例的基础安装、普通 R 项目和 paired recipe 共用相同能力；实际通过下面的检查；之后再验收插件 UI |

PX-03 的对象支持首先限定为 batch 的显式导出快照；不把实时 R 会话作为已有能力交接。
基础实现优先复用现有 Documents、原始字节和执行桥，按具体缺口拆分依赖与数据 reader，
不为抽象重新实现已有原生执行或搭建另一套运行日志。

新接口、同步版本客户端、无副作用状态夹具和无界面验收已交付。实际 API 和预算见
[HEADLESS](HEADLESS.md)，设计目录中的其他 entry 不因此变成已实现接口。

## 协议与存量状态

保留 `/api/v1` 已接受候选的定义与证据。不在原版本下静默删除动作、改写 comparison 字段，
或给原请求补上另一种执行含义。涉及这些不兼容变化的新组合使用新的主版本路径和迁移说明；
可兼容的新增能力也必须有明确 schema、实际客户端和检查。

存量记录保留原 owner/版本、参数字节、调用方/项目、Core caller/request 和原生身份。
迁移读取与必要的旧格式 reader 不引入新执行；进行中的请求继续使用可观察其原实现的版本。
缺少旧插件或资源时报告不可用/未知并保留引用，不通过安装组件或重跑分析修复画面。
兼容读取、禁用新调用、取消任务和关闭 Host 是不同操作。

原来的 tarball 与 [v0.1.0 证据](backend-acceptance/v0.1.0.json)保持不可变。
新的基础包和显式科学 consumer 分别记录源版本、组件及产物摘要；重新做组合安装验收。
文档的新 HEAD 不替换已验收候选的身份。

## 新增验收门槛

1. **去掉样例仍可工作。** 从不含该 recipe 的基础包安装，且不要求 airway/DESeq2/apeglm。
   打开项目、编辑/undo/条件保存、读取普通表格和图像；这些读操作不启动 Host 或 R。
2. **第二个真实消费者。** 普通项目 R 脚本导出以 `sample_id` 为 key 的小表、一张图片和有界
   对象快照。复用相同执行、依赖、表格、图像和上下文入口，基础源码不增加样例分支。
3. **原科学流程成为消费者。** paired recipe 显式给出数据、方法、依赖、产物描述和 checker，
   使用同一能力完成分析；执行、字节完整性、领域检查和解释保持分开。
4. **类型与映射可检验。** 保留字符串 `001` 和 provider 声明的字面 `NA`；无稳定 key 的表
   仍可读但不能伪造实体联动。跨资源链接需要显式映射；双输入保留各自版本、缺失和来源。
5. **缺失与连续性。** 缺少可选能力、UI entry 或运行时后，仍能读适用资源、保留草稿、
   查原请求和恢复组合意图；旧版本、预算超限、partial/unknown 由 owner 如实返回。
6. **UI 单独验收。** 在上述实际公共契约上实现插件 View，验证英文产品界面、Unicode/IME、
   键盘/辅助访问、真实数据选择、关闭/重建 View 和目标宽度。后端契约通过不替代浏览器验收。

前五项的后端结果、实际安装和保留失败统一见[解耦验收](EXTRACTION-ACCEPTANCE.md)。
第六项仍待 UI 实施。原 BP 证据保持原范围；[Status](STATUS.md)记录当前状态，
[首版交付清单](WEBUI-FIRST.md)继续持有全部产品发布条件。
