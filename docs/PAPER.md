# Rho 的研究定位：相关工作、问题选择与贡献边界

更新：2026-10-30。本文替代 c9fdd669 中从现有实现出发的论文计划。它是一份研究定位备忘录，不是论文初稿、产品规格或实验协议。文献判断对应文末注明的版本；Rho 的实现边界对应本次阅读的仓库状态，当前产品状态仍以 [Status](STATUS.md) 为准。

## 1. 重新判断

**现阶段不能把“记录＋派生呈现”当作 Rho 已经成立的研究贡献。** 来源记录、版本保留、历史比较、从历史组织叙事、洞见与证据关联、对 Agent 分步监督，都有直接先例。把这些能力组合成一个工作台可以有产品价值，但不能靠功能数量、验收通过率或一个失败截图证明研究新颖性。

最值得继续追问的方向是：

> 分析被人或 Agent 改动后，研究者如何判断先前结论和审阅意见还适用于什么，并据此决定继续采用、局部复查、补取证据或重新分析？

这个问题涉及分析过程中的理解、判断和介入。历史保存只是其中的条件之一。更具体的候选场景是：研究者离开一段时间后重新进入工作；代码、数据、输出和解释可能分别改变；部分操作由外部工具完成；可获得的历史并不完整。

**这仍是候选问题，不是已经发现的文献空白。** 本轮检索能够排除原计划中的几项宽泛主张，也能指出最接近的研究；还不能证明这个场景普遍、代价显著，或现有工具的合理组合处理不了它。Rho 目前提供的是研究载体，还没有证明独特的方法贡献。

因此，先确定值得解决的判断困难和相对已有工作的增量，再决定是否需要新的表示、交互或捕获方法。暂不确定论文规模、投稿类型、标题、实验数量和样本量。

## 2. 本轮相关工作查到了哪里

这是一轮面向问题定位的定向检索与引文追溯，截止日期为 2026-10-30，不声称是穷尽性或系统综述。检索从原计划的主张出发，也主动查找能够否定新方向的工作。

| 检索方向 | 使用的关键词或追溯入口 | 要排除的误判 |
| --- | --- | --- |
| 科学来源与可复算记录 | scientific provenance、script provenance、workflow run crate、R provenance、DataLad | 把保存执行、输入输出和版本说成新问题 |
| 分析历史与意义恢复 | analytic provenance sensemaking、notebook history、visualization retrieval、provenance storytelling | 把“有记录但难理解”说成首次发现 |
| 主张与证据 | insight evidence association、claim evidence graph、provenance uncertainty | 把答案中心组织、证据链接或未知状态说成新概念 |
| 人与分析 Agent 的交互 | LLM data analysis steering verification、interactive task decomposition、data threads、multi-agent collaborative data analysis | 把非线性界面、可检查中间结果或多 Agent 协作本身当贡献 |
| 外部工具与长期变化 | system-level agent observability、non-invasive research project inventory、analysis evolution | 把不接管运行、跨工具或异步工作本身当新颖性 |

核心判断优先采用论文正文、标准条款和作者提供的原文。文末逐项记录来源、阅读版本和支撑位置。原型论文、研究议程、规范及产品文档承担不同的证据责任；产品文档可以证明已有设计，不能证明用户效果。Treadstone 和 AgentSight 按所读预印本讨论，不把预印本当作已完成的同行评审结论。

本轮未安装并复现这些系统，也未调查商业工具的全部最新能力。因此，下文使用“该文研究了什么”“该评价未覆盖什么”，不使用“这个系统绝不支持什么”。论文没有报告某项能力，不等于系统不存在这项能力。

## 3. 已有工作改变了哪些判断

### 3.1 记录、版本、归属与证据包装已有成熟基础

| 工作 | 已有能力或概念 | 对 Rho 定位的约束 |
| --- | --- | --- |
| W3C PROV-DM [R02](#r02) | 实体、活动、主体、派生、修订，以及记录来源本身的 bundle；示例包含不同观察者在不同时间提供的描述 | 事实分层、版本关系和记录归属不能直接作为新模型；应先尝试映射已有标准 |
| Web Annotation [R03](#r03) | 注释可以指向资源片段，并通过 State / TimeState 指定资源状态 | 把问题或意见绑定到特定版本不是新概念；新意若存在，应来自如何使用这些绑定 |
| Workflow Run RO-Crate [R04](#r04) | 用分层配置文件包装执行及输入输出；Process Run Crate 也能描述不属于统一工作流的程序执行 | 不能把对手概括成只支持预先声明的工作流；离线证据包本身不足以构成贡献 |
| FAIRSCAPE / EVI [R05](#r05) | 证据图连接研究结果、数据、软件与计算；EVI 明确区分主张和事实，容纳后续支持、质疑与注释 | “主张—证据图”“新证据改变旧主张的依据”已有概念基础 |
| noWorkflow、R 的 E2ETools [R06](#r06)、[R08](#r08) | 在所支持的脚本执行范围内采集来源，检查依赖，比较运行，解释结果差异 | 不要求统一工作流不等于缺乏来源工具；同语言内的细粒度记录可能比 Rho 的文件观察更强 |
| ReproZip、DataLad [R07](#r07)、[R09](#r09) | 前者从执行中追踪依赖并打包；后者联合管理代码、数据和关系，并为受其记录的命令保留可再执行的调用信息 | “普通文件＋Git”不是能力上限；应考虑已有工具增强后的实际工作方式 |
| StatWrap [R10](#r10) | 非侵入地盘点研究项目资产，支持文件关联笔记，关注数据、软件和人员变化 | 保留原有工具、在外围组织研究项目，也已有产品先例 |

这些工作解决的层次并不相同：可表达一种关系、可靠地捕获它、让人理解它，是不同的问题。不能因为规范能表达某个概念，就认定使用问题已经解决；也不能因为某个界面没有直接显示它，就把底层概念重新包装为发明。

### 3.2 “记录完备不等于容易理解”不是 Rho 的主发现

Xu 等人在 2015 年的分析来源研究议程中，已经区分捕获、呈现与使用，并讨论低层事件难以恢复人的目的、协作中的意义恢复，以及来源信息带来的认知成本。[R01](#r01) Rho 的屏幕问题可作为本项目的设计观察，不能承担领域发现的责任。

| 工作 | 已有研究对象 | 需要承认的直接重叠 |
| --- | --- | --- |
| VisTrails [R11](#r11) | 保留分析工作流的变化及执行历史，支持探索不同版本 | 分析会演化；需要比较历史选择，而不只是重跑最终脚本 |
| CLUE [R12](#r12) | 从探索来源图编排可返回原分析状态的叙事，并允许读者继续探索 | “呈现由记录派生”已有直接先例，且叙事可以包含人的选择与说明 |
| KnowledgePearls [R13](#r13) | 从来源历史中检索先前的可视化状态，支持个人及团队找回分析 | 历史可检索、可重返，与历史是否保存完整是不同的研究对象 |
| Verdant [R14](#r14) | 研究数据科学家如何在他人的分析历史中寻找过去的选择，设计 notebook 历史浏览 | 找回分析理由和过去结果已有人的任务证据，不能只与裸日志相比 |
| Loops [R15](#r15) | notebook 中代码、文本、表格、图像的版本差异与历史概览；讨论异步协作 | “多种产物一起比较”已有先例；也不能把已有历史界面都说成只面向单人同步工作 |
| B2、mage [R16](#r16)、[R17](#r17) | 在 notebook 中连接代码与图形交互，支持两种方式之间往返 | 共享工作区和代码、表格、图形联动是已有研究方向 |

所以，2026-10-25 的两张表没有形成易读答案，能够说明当时的 Rho 需要改进。它不能推出一般系统必须采用某种架构，更不能单凭研究者自己的截图推出用户无法理解。

### 3.3 LLM 分析界面已经研究“理解、检查、修订”

| 工作 | 直接相关的方法 | 所读工作提供的边界 |
| --- | --- | --- |
| WaitGPT [R18](#r18) | 把生成代码解析为操作图，结合运行时中间表状态，供人监控和干预 | 实现在自己的 Python 沙箱中，解析主要面向 Pandas / Matplotlib；已有检查与纠错任务 |
| Interactive Task Decomposition [R19](#r19) | 比较对话、分阶段、分步骤的分析方式，让人检查和修改假设、计划及代码 | 明确报告修改在上下游传播时的不一致；不是只问用户喜欢哪种界面 |
| Data Formulator 2 [R20](#r20) | 用 data threads 管理迭代的数据转换和图表，支持回退、分支及复用 | 针对可视化创作；对长期使用的评价有限 |
| InsightLens [R21](#r21) | 抽取洞见，关联代码、输出、图表和解释；新证据可用于修订既有洞见 | 自动关联由 LLM 完成；技术评价检查关联正确性，并记录遗漏及错误解释 |
| Treadstone [R22](#r22) | 用共享讨论组织人和多个 Agent 的分析；区分假设、证据、问题及洞见，并推断支持或反驳关系 | 所读版本评价短时开放探索；长期工作、目标明确的判断任务仍待研究，单 Agent 对照混合了多个因素 |
| AgentSight [R23](#r23) | 在系统边界观察 Agent 的通信及执行，结合进程、时序、参数和模型分析建立关联 | 面向安全、性能及多 Agent 运行观察；这些评价不等同于研究者理解分析结果的评价 |

这张表使两个看似可行的替代定位也不够充分：

- **“从文件转向答案或主张”**：InsightLens 已把洞见及其证据作为交互对象；Treadstone 已组织讨论中的主张关系。仅换组织单位不足以建立新颖性。
- **“从接管执行转向观察外部 Agent”**：AgentSight 已采用外部观察；更早的 ReproZip 也不依赖研究者先建工作流。这是有用的部署选择，不能直接充当研究发现。

“计算完成”和“科学主张成立”之间的区别也不是新的。除 EVI 的明确区分外，2026 年的 THREAD-Bio 概念框架已经讨论分析决策、验证与主张证据之间的关系。[R24](#r24) 它是待验证的报告框架，不是有效性的实验依据；但足以阻止 Rho 把这一原则写成自己的首次贡献。

## 4. 真正需要与最近邻比较什么

这里的比较用来确定问题，不是提前选定实验条件。

**与 InsightLens 比较的重点是历史适用范围。** 它已处理洞见提取、证据关联和修订。因此不能说它只处理静态答案。需要进一步核实的是：外部数据或代码变化后，历史洞见和人的审阅意见如何保留各自的依据，哪些迁移需要人工判断。其论文中的证据关联错误也提醒我们：把一条模型关联保存下来，并不会使它变成可靠的执行事实。

**与 Loops、Verdant、KnowledgePearls 比较的重点是找回历史之后的判断。** 如果困难只是找不到旧图或看不清差异，已有历史浏览方法已非常接近。候选增量只能出现在更具体的一步：找回这些材料之后，人仍然无法判断什么需要复查、什么可以继续采用。不能预先断言这一增量存在。

**与 WaitGPT、任务分解及 Data Formulator 2 比较的重点是已有上下文的变化。** 它们已经支持检查和修订；任务分解论文还直接报告了修改传播问题。Rho 应关注研究者重新进入已经变化的分析时，哪些判断得到了这些方法的支持，哪些仍需额外材料。外部工具增加了记录的不完整性，但“更开放”本身不是优越性的证明。

**与 PROV、EVI、RO-Crate、DataLad 比较的重点是表示和现成组合是否已经够用。** 如果标准关系、版本化文件和一页明确的审阅说明就能支持目标判断，便没有理由先发明新的图模型。Rho 应解释剩余的交互困难，或承认它主要提供便利的集成。

**与 Treadstone、AgentSight、StatWrap 比较的重点是采用条件。** 多 Agent、异步活动、外部观察和项目变化都已有先例。必须找到这些条件下某个有后果的具体判断困难，而不是用它们组成一个只有 Rho 匹配的功能交集。

因此，不能再把 transcript + working directory 预定为唯一或主要对照。它仍可能代表一部分人的真实做法；是否有代表性、是否足以回答问题，需要另行判断。也不需要把每个相关系统都搬进同一个比较：应先确定任务，再选择最接近的已有方法或合理组合。

## 5. 候选研究问题：分析变化后，哪些判断需要重做

### 5.1 研究对象与具体后果

候选对象是需要对分析负责、能够理解领域问题，但没有跟随每一步操作的研究者。关注的时刻是其重新检查或继续一段已经变化的分析，而不是每个工具调用的批准时刻。

下面是用于界定问题的**假设例子，不是已经观察到的用户案例**：

一个人审阅了某组样本、某条排除规则下的结果，并认为它可用于组内讨论。之后，Agent 修改排除规则并覆盖结果文件，另一项外部操作又改变了输入；报告中的结论没有同步修改。几天后，研究者看到旧讨论、当前文件和一部分历史快照，需要决定能否继续使用这段结论。

这里至少有几种不同的判断：

| 眼前变化 | 不能自动推出的结论 | 人实际需要判断的事 |
| --- | --- | --- |
| 当前结果和旧结果不同 | 旧结果在当时就是错的 | 旧判断针对哪个问题、材料和用途；当前用途是否还被覆盖 |
| 一个文件发生变化 | 所有结论都必须重新审阅 | 变化是否触及该结论的依据，哪些局部判断需要重做 |
| 输出字节没有变化 | 方法、输入和解释都没有变化 | 相同产物是否足以支持现在的主张；还缺哪些上下文 |
| 快照与一次运行时间接近 | 那次运行使用或产生了这些字节 | 关系是直接记录、人的说明、模型推断，还是暂时未知 |
| 来源暂时无法确认 | 分析一定失败或科学结论一定错误 | 哪项不确定性影响当前决定，是否值得补取证据 |

这不是要求系统自动判断全部科学结论的真假。研究目标是让人能够作出范围合适的判断：避免把旧认可不加区分地继承给新结果，也避免因为任何变化都从头审阅全部分析。

### 5.2 为什么可能值得研究

文献已经支持三个相邻需求：从历史恢复分析上下文、在生成过程中检查与修订、组织洞见及其证据。候选问题处在它们衔接的地方：**历史材料找回之后，当前决定还缺什么？** 这个衔接是否困难，必须由实际工作证明，不能由上述论文没有覆盖某个场景就推出。

潜在难点有三个。

第一，变化的技术单位与判断的单位不同。哈希、文件、命令或 cell 可以界定改变发生在哪里；“这足以改变哪个结论”还需要问题、方法和用途的语义。仅显示更多差异可能增加负担。

第二，可获得的关系强弱不一。执行记录、文件观察、人的解释和模型生成的关联各有来源。界面需要帮助人使用它们，同时避免让一种关系看起来比证据实际支持的更强。把所有缺失标为未知可以避免过度断言，却可能仍然没有帮助人继续工作。

第三，解释不可简单地排除。模型摘要可能帮助人快速定位重要变化；人写的理由也无法都从运行日志机械恢复。研究的是如何使用这些解释、如何检查其依据，以及何时仍需人的判断。一个模型复述错误的案例不能证明“呈现必须全部确定性生成”。

这三个难点也可能被很小的改进解决，例如更好的历史导航、明确的版本引用或现成工具间的连接。不能预先规定它们必须需要 Rho 的完整架构。

### 5.3 需要保留的反方向

- 如果主要困难来自领域方法知识不足，补充来源记录可能作用很小；问题应转向方法解释或专家协作。
- 如果人已经能可靠判断影响范围，只是材料难找，应优先承接历史检索工作，不再主张新的判断机制。
- 如果记录不足是决定性瓶颈，而选择已有执行捕获工具就能解决，应采用该工具；外围观察未必是合适方案。
- 如果任务全部位于 notebook 或受控分析环境中，现有分支、回退与差异方法可能足够；不能人为加入跨工具变化来制造优势。
- 如果“明确未知”只让人更犹豫，却没有改善下一步行动，它是诚实的描述方式，还不是有用方法的证明。

## 6. 哪些贡献有可能成立

现在能写的是贡献的成立条件，不能把下表改成完成时的贡献清单。

| 候选贡献 | 真正需要新增的知识 | 什么不算这项贡献 |
| --- | --- | --- |
| 对实际判断困难的解释 | 找出哪些变化会导致旧判断被错误沿用或不必要地重做，说明发生条件、后果，以及已有支持为何不足 | 开发者觉得页面拥挤；几个系统截图；重新命名已有的 provenance 分类 |
| 支持判断的方法 | 提出与上述困难对应的表示或交互，说明为什么它帮助人确定复查范围，哪些推断仍须由人完成 | 新建一张图；把所有功能装到一个屏幕；保存模型生成的边就称为事实 |
| 可迁移的适用边界 | 解释在何种任务、观察条件和使用成本下方法有价值，何时简单方案或更强的捕获工具更合适 | 只展示最佳案例；把功能验收、主观信任或记录数量当成人的收益 |

若最终贡献是交互方法，就应正面研究人如何理解和继续分析；不能为了避免人的证据而把它改写成存储性质。若最终贡献是来源模型或捕获算法，则必须指出已有标准或机制无法满足的具体要求。二者都不能由当前模块边界决定。

值得考虑的方法假设是：**围绕当前需要作出的判断选择相关的变化与依据，并让历史判断保持其原来的范围，可能比持续增加记录或摘要更有帮助。** 这句话尚未确定界面形式，也没有证明因果关系。“变化摘要”“版本绑定”“未知提示”各自已有先例，真正的增量只能由其针对的困难和实际效果建立。

也应接受另一种结果：Rho 是有价值的研究软件，但这轮问题定位没有找到足够清晰的研究增量。此时可以继续做好工具和软件论文所需的贡献说明，不必把每次工程改进升格为新的科学主张。

## 7. 重新安放 Rho 已有材料

现有实现用于判断能否开展探索，以及哪些证据不能被误读。它不负责决定研究问题。

| 已有材料 | 可以支持什么 | 不能支持什么 |
| --- | --- | --- |
| 保留的文件版本和原文件被覆盖后的读取 | 探索历史材料如何被找回和并置 | 证明该版本就是某次原生进程实际读取或生成的内容 |
| Graph 中 reported / named / observed 关系 | 区分报告、提及和观察到的变化 | 把这些关系直接升级为生产或因果关系 |
| 版本绑定的问题、回复与决定 | 探索一次审阅针对哪些保留材料 | 判断该人的意见科学上正确，或新版本必然需要重新批准 |
| notes、文件描述与 meaning layer | 探索生成解释如何帮助定位材料，保留其来源 | 把语句的正确性当作已被系统检查 |
| 离线导出与 verifyEvidence | 检查包内文件的清单、大小和摘要一致性 | 验证科学正确性、作者归属或完整的执行依赖 |
| 真实运行记录、开发者截图和功能检查 | 提供设计线索、缺陷案例及实现能力证据 | 证明用户困难的普遍性、新方法的有效性或论文应有的规模 |

这些边界可从 [review 的捕获说明](REVIEW-EVIDENCE-EPISODE.md#capture-and-review)、[历史 Graph](REVIEW-EVIDENCE-EPISODE.md#historical-graph)、[离线阅读器](REVIEW-EVIDENCE-EPISODE.md#offline-reader)、[原生工具的边界](NATIVE-TOOLS-EPISODE.md) 和 [verifyEvidence 实现](../src/evidence-export.ts) 直接核查。模拟项目中 [meaning layer](SIMULATED-PROJECT-EPISODE.md#meaning-layer) 与 [图像描述](SIMULATED-PROJECT-EPISODE.md#figures-cost-and-a-switch) 的记录，也保留了生成句子未被验证及描述错误。

旧计划中的性质 P 不再作为主结果：如果“成功解析到正确关系”和“明确声明缺失”都算通过，全缺失的记录也可能满足它。诚实报告缺失很必要，但还需分别回答关系是否真实、材料是否足够、是否帮助当前判断。现有哈希验证器不能替代这些问题。

同样，独立数值 oracle 可以判定某个定义明确的计算结果是否正确，却不能单独判定人是否理解了方法、历史归属或结论的适用范围。胶囊能否公开影响未来材料的可复核性，但不是眼下研究定位最根本的缺口；增加公开数据集也不能自动修复问题定义。

已有成本和负面案例继续保留在各自 episode 中。它们约束实现选择，不能预先决定哪一种错误更常见、哪一种交互最有价值。本文不因方向变化而重新解释旧记录，也不改变产品当前的执行与授权边界。

## 8. 进入研究设计之前，还必须澄清什么

下一份材料应当是一份简短的问题说明，而非实验排期。至少能清楚回答以下事项：

1. **谁在什么时刻作什么决定？** 用一段真实工作说明，错误沿用旧判断或过度重审会产生什么后果；区分领域知识问题、材料检索问题和变化理解问题。
2. **已有方法已经帮助到哪一步？** 对最接近的方法做针对该任务的核查，包含合理配置和轻量组合。记录确切版本和采用成本，避免把“未安装”“没有集成”误写为理论缺陷。
3. **剩余困难要求新增什么？** 先说明判断所需的信息和交互，再考虑由哪个软件实现。若只是通用历史浏览或版本标注不足，直接继承已有方法。
4. **什么证据能区分事实、推断和人的判断？** 预先澄清问题的可判定部分；历史关联、数值正确性和科学解释需要各自的依据，不能共用一个 oracle 名称。
5. **什么结果会使这个问题不再值得追？** 例如实际工作没有明显后果、现成方法已足够、外围观察无法支持关键判断，或新增呈现成本超过收益。方向改变应由这些实质判断触发，而不是任意的解析率阈值。

这五项不要求立即运行新的 Agent、组织用户实验或新增捕获功能。它们也不是给未实现界面写验收标准。缺少其中的关键答案时，继续收窄问题，比先排一组大而全的对照更有价值。

旧版的 E1–E6、五种预定消融、固定样本量、80% 判据和九周排期在本版撤回。以后选择研究方法时，应从这里确定的具体问题出发，不能把它们原样搬回来。

## 9. 来源与核查位置

以下编号用于追溯上文判断，不代表质量排序。阅读范围以所列位置为准；“论文”不等于已复现其实现或独立验证其效果。作者稿与正式发表信息分开注明，滚动文档标明访问时点。

<a id="r01"></a>
**R01 — 分析来源与意义恢复。** Xu et al. *Analytic Provenance for Sensemaking: A Research Agenda*. IEEE CG&A 35(3), 2015. [机构库与作者稿](https://openaccess.city.ac.uk/id/eprint/15535/)，[DOI](https://doi.org/10.1109/MCG.2015.50)。核查引言、§2 Capture 及协作、uncertainty/trust 的讨论。这是研究议程，不是某种界面有效性的证明。

<a id="r02"></a>
**R02 — 来源模型。** W3C, *PROV-DM: The PROV Data Model*, Recommendation, 2013-04-30. [规范](https://www.w3.org/TR/prov-dm/)。核查 §5 的 entity/activity、derivation/revision，以及 §5.4 bundles 的不同观察者示例。规范定义表达能力，不保证每条来源断言为真。

<a id="r03"></a>
**R03 — 状态相关的注释。** W3C, *Web Annotation Data Model*, Recommendation, 2017-02-23. [规范](https://www.w3.org/TR/annotation-model/)。核查 Specific Resources、Selectors、States / TimeState。状态引用是基础机制；其存在不等于科学审阅的语义已经被解决。

<a id="r04"></a>
**R04 — 执行证据包。** Leo et al. *Recording provenance of workflow runs with RO-Crate*. PLOS ONE, 2024. [正文与 DOI](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0309210)。核查 Process Run、Workflow Run、Provenance Run 三层配置及实现。尤其注意 Process Run 对不属于统一工作流的程序执行的支持。

<a id="r05"></a>
**R05 — 主张、证据及其变化。** *FAIRSCAPE* [官方项目说明](https://fairscape.github.io/)；Al Manir and Clark, *EVI: Evidence Graph Ontology*, [规范](https://fairscape.github.io/EVI/index.html)，页面标示 1.6、2026-08-13，访问于 2026-10-30。核查项目的 RO-Crate / evidence graph 说明，以及 EVI 的 Introduction、Claim、Annotation、支持与质疑关系。本条使用项目和本体文档，不据此声称已有人的效果证据。

<a id="r06"></a>
**R06 — 脚本来源。** Pimentel et al. *noWorkflow: a Tool for Collecting, Analyzing, and Managing Provenance from Python Scripts*. PVLDB 10(12), 2017. [原文](https://www.vldb.org/pvldb/vol10/p1841-pimentel.pdf)。核查 §2–3：采集粒度、输入输出保存、查询、运行比较及恢复；这是 demo 论文，不能外推为任意外部执行的完整观察。

<a id="r07"></a>
**R07 — 执行依赖捕获。** Chirigati, Shasha and Freire. *ReproZip: Using Provenance to Support Computational Reproducibility*. TaPP, 2013. [USENIX 原文](https://www.usenix.org/system/files/conference/tapp13/tapp13-final16.pdf)。核查 execution tracing、依赖识别和 packaging。本条对应 2013 年论文，不混用后续产品版本的能力。

<a id="r08"></a>
**R08 — R 来源的实际使用。** Lerner et al. *Making Provenance Work for You*. The R Journal 14(4), 141–159. [正文](https://journal.r-project.org/articles/RJ-2023-003/)，DOI 10.32614/RJ-2023-003。页面出版日期标为 2022-12-31，故不从 DOI 中的年份反推出版日期。核查 E2ETools、rdtLite，以及 debugging、结果差异和复算的例子。

<a id="r09"></a>
**R09 — 代码、数据及调用关系。** Halchenko et al. *DataLad: distributed system for joint management of code, data, and their relationship*. JOSS 6(63), 3262, 2021. [论文](https://joss.theoj.org/papers/10.21105/joss.03262)。核查 Git / git-annex 基础与 “Re-executable annotation of changes”；自动调用记录对应通过该机制执行的命令，不等于任意未记录的操作。

<a id="r10"></a>
**R10 — 非侵入的项目盘点。** StatWrap, [官方仓库 README](https://github.com/StatTag/StatWrap)，访问于 2026-10-30。核查 About 与 Design：资产盘点、关联笔记、变化及被动观察。官网访问失败后使用官方仓库；没有从宣传或 README 推导用户效果。

<a id="r11"></a>
**R11 — 分析过程的演化。** Koop, Freire and Silva. *Enabling Reproducible Science with VisTrails*, 2013. [作者稿](https://arxiv.org/abs/1309.1784)。核查 change-based provenance、工作流变化和参数探索。这里引用变化历史的机制，不声称它覆盖任意工作区中的科学推理。

<a id="r12"></a>
**R12 — 从探索历史到叙事。** Gratzl et al. *From Visual Exploration to Storytelling and Back Again*. Computer Graphics Forum / EuroVis, 2016. [出版平台原文](https://diglib.eg.org/server/api/core/bitstreams/33a979ab-213a-4551-9110-e5812f01fdef/content)，[DOI](https://doi.org/10.1111/cgf.12925)。核查 CLUE 的 §3–4 及 §7：探索、编排、展示和返回分析的联系；数据与应用版本集成仍有明确边界。

<a id="r13"></a>
**R13 — 找回先前的分析状态。** Stitz et al. *KnowledgePearls: Provenance-Based Visualization Retrieval*. VAST 2018 / TVCG 25(1), 2019. [作者稿](https://data.jku-vds-lab.at/papers/2018_vast_knowledge-pearls.pdf)，[DOI](https://doi.org/10.1109/TVCG.2018.2865024)。核查引言、状态检索方法及案例。作者稿有未填的出版占位字段，书目信息按 DOI 和作者出版页核对。

<a id="r14"></a>
**R14 — 在历史中寻找分析选择。** Kery et al. *Towards Effective Foraging by Data Scientists to Find Past Analysis Choices*. CHI, 2019. [作者稿](https://www.cs.cmu.edu/~NatProg/papers/paper092-Kery-CHI2019.pdf)，[DOI](https://doi.org/10.1145/3290605.3300322)。核查历史检索任务、参与者研究、Verdant 的设计和讨论。不把该任务的表现当作另一种研究任务的阈值。

<a id="r15"></a>
**R15 — notebook 的多种差异与异步协作。** Eckelt et al. *Loops: Leveraging Provenance and Visualization to Support Exploratory Data Analysis in Notebooks*. IEEE VIS, 2024. [作者稿](https://eckelt.info/papers/2024_loops.pdf)。核查 §3–4 的捕获与实现、§7 的协作讨论。实现位于 notebook 前端，不能笼统归为依赖特定语言解释器的方案。

<a id="r16"></a>
**R16 — 代码与可视化共享操作。** Wu, Hellerstein and Satyanarayan. *B2: Bridging Code and Interactive Visualization in Computational Notebooks*. UIST, 2020. [作者项目页](https://vis.csail.mit.edu/pubs/b2/)，[DOI](https://doi.org/10.1145/3379337.3415851)。本轮核查项目页摘要与流程图说明：以查询连接代码与交互。未据此对论文的研究设计作进一步评价。

<a id="r17"></a>
**R17 — 图形操作与代码往返。** Kery et al. *Mage: Fluid Moves Between Code and Graphical Work in Computational Notebooks*. UIST, 2020. [作者稿](https://arxiv.org/abs/2009.10643)。核查工具 API、图形操作与代码的双向联系；用来确认问题先例，不作为 Rho 有效性的间接证据。

<a id="r18"></a>
**R18 — 生成过程的监控与干预。** Xie et al. *WaitGPT: Monitoring and Steering Conversational LLM Agent in Data Analysis with On-the-Fly Code Visualization*. UIST, 2024. [所读 v1 全文](https://arxiv.org/html/2408.01703v1)，[DOI](https://doi.org/10.1145/3654777.3676374)。核查 §5–8 的操作表示、沙箱插桩、检查任务与局限。

<a id="r19"></a>
**R19 — 分解任务以支持检查和修改。** Kazemitabaar et al. *Improving Steering and Verification in AI-Assisted Data Analysis with Interactive Task Decomposition*. UIST, 2024. [所读 v2 全文](https://arxiv.org/html/2407.02651v2)，[DOI](https://doi.org/10.1145/3654777.3676345)。核查 §4–6 的三种交互及评价、§8.2 的修改传播限制；采用 v2，不沿用早期稿的研究规模。

<a id="r20"></a>
**R20 — 迭代的数据转换与图表。** Wang et al. *Data Formulator 2: Iterative Creation of Data Visualizations, with AI Transforming Data Along the Way*. CHI, 2025. [所读 v2 全文](https://arxiv.org/html/2408.16119v2)，[DOI](https://doi.org/10.1145/3706598.3713296)。核查 §3 data threads、§4–5 的使用研究和 §6 的适用边界。

<a id="r21"></a>
**R21 — 洞见与证据的自动组织。** Weng et al. *InsightLens: Augmenting LLM-Powered Data Analysis with Interactive Insight Management and Navigation*. TVCG, 2025. [所读 v2 全文](https://arxiv.org/html/2404.01644v2)，[DOI](https://doi.org/10.1109/TVCG.2025.3567131)。核查 §4.1 的洞见修订和证据关联、§6 的关联检查及失败、§8.3 的局限。作者网站的 PDF 也标为 arXiv v2，不能因文件名含 2025 就称为最终出版全文。

<a id="r22"></a>
**R22 — 多 Agent 分析讨论。** Lee et al. *Treadstone: A Social-Media-Inspired Platform for Multi-Agent Collaborative Data Analysis*. [arXiv:2609.19774v1](https://arxiv.org/html/2609.19774v1)，2026 年预印本。核查 §3–4 的界面和 Agent 架构、§4.4 的模型语义关联、§8.3 的评价限制。本条只对应这一标题和版本，不与会议日程中的标题自动合并。

<a id="r23"></a>
**R23 — 外部观察 Agent。** Zheng et al. *AgentSight: System-Level Observability for AI Agents Using eBPF*. [arXiv:2508.02736v1](https://arxiv.org/html/2508.02736v1)，2025 年预印本。核查 §3–5 的边界追踪、关联策略及案例；进程关系、时间匹配与模型语义推断需要分别理解，论文的因果措辞不能替代独立的因果证据。

<a id="r24"></a>
**R24 — 科学解释与执行的区别。** Ang et al. *Trustworthy Agentic AI in Bioinformatics: From Workflow Automation to Traceable and Validated Biological Inference*. Biology 15(17), 1537, 2026-09-04. [出版社正文](https://www.mdpi.com/2079-7737/15/17/1537)，[版本记录](https://www.mdpi.com/2079-7737/15/17/1537/notes)。核查 §1、§6 的主张—证据概念及 §9 的 THREAD-Bio 提议；只引用作者提出的概念，不把综述中的系统转述用作性能或功能的原始证据。
