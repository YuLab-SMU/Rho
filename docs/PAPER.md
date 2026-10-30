# Rho 的研究定位：生物信息学场景、相关工作与贡献边界

更新：2026-10-30。本版承接 a0b3bc80 的相关工作核查，将问题进一步限定到 Agent 参与的生物信息学分析。它是一份研究定位备忘录，不是论文初稿、产品规格或实验协议。文献判断对应文末注明的版本；当前产品状态仍以 [Status](STATUS.md) 为准。

## 1. 先看具体分析中，人究竟需要判断什么

下面三个场景是**为论证而构造的例子，不是 Rho 已经观察到的用户案例，也不是实验任务**。其涉及的统计和来源问题有文献依据，但发生频率、实际损失和界面能否改善，不能由例子自行证明。

### 1.1 单细胞分析：显著的是细胞差异，还是供者间的疾病关联

设想一项包含 6 名病例、6 名对照的单细胞 RNA-seq 分析，每名供者贡献许多细胞。研究者关心的是：“病例的单核细胞是否存在更强的干扰素相关表达特征？”工作经过样本整理、细胞质控、类型注释、差异分析和通路解释，由本地 R/Python、集群任务与 Agent 共同推进。

已有一版按供者组织的分析。之后，Agent 修改细胞类型注释并重写差异分析，改为把细胞作为独立观测进行组间检验，没有在该检验中处理供者间变异。输出仍是熟悉的火山图、差异基因表和富集图，文字仍称“病例中上调”。另一名研究者此时接手。

这时不能只问“数算对了吗”。即使逐项重算得到同样的统计量，仍需弄清：

- 当前比较究竟支持样本内这些细胞的描述，还是支持供者层面的组间推断？
- 细胞到供者的映射是否正确？改注释后，各供者在这个细胞群中的贡献是否改变？
- 当前统计设计是否对应研究问题，是否存在批次与疾病分组的混淆？
- 一组表达与通路结果，可以支持怎样强度的生物学表述？

忽略生物学重复可能导致虚假差异，已有直接方法学证据；这不是 Rho 发现的新统计问题。[R25](#r25) 本例也不意味着某一种聚合方法能自动修复所有设计缺陷：如果批次与疾病完全重合，加入一个协变量不能凭空提供区分二者效应的信息。

人需要把**具体材料与具体前提对上**。供者映射问题要查看样本元数据和聚合关系；推断单位问题要查看模型及其输入；细胞类型问题要回到注释依据。仅为配色改图，通常不要求重新检验疾病关联；改变细胞归属则可能影响聚合和下游推断。判断这些范围的依据不同。

若确认计数与上游处理仍可用，修正可能从供者聚合或统计模型开始；若问题在样本身份，则需沿真实依赖继续向上检查。不能把发现一个问题统一翻译为“全部重跑”。同样，表达关联本身不足以证明“该通路驱动疾病”，强因果措辞需要另一类证据。这是分析、计算和学术解释之间的联系，而不是三个彼此独立的检查框。

### 1.2 富集分析：同一张基因表，为什么会讲出不同的生物学故事

设想差异基因表没有改变。第一次过度代表分析采用本次分析中可进入检验的基因作为背景，并固定一版 GO 注释。后来 Agent 更换调用方式，使用工具的默认背景，同时更新了功能注释。新结果出现更多免疫相关条目，报告把它们概括为“多条通路独立支持免疫激活”。

这涉及几种不同的问题：

| 材料或解释的变化 | 实际需要辨别什么 | 可能的处理范围 |
| --- | --- | --- |
| 背景基因集合改变 | 抽样参照是否符合这次数据产生和基因筛选过程 | 核对入选与可检验集合，再决定是否重做富集；不自动要求重做测序比对 |
| 功能注释或基因 ID 映射改变 | 是知识更新、映射丢失，还是分析设置变化造成结果不同 | 保留所用版本、检查映射和注释差异；不能把同时发生的多项变化归因于其中一项 |
| 多个显著条目高度重叠 | 它们是否主要来自同一组基因和相近的功能描述 | 调整证据解释；条目数量不等于独立支持的数量 |
| 报告从“相关表达特征”写成“功能被激活” | 数据实际测量了什么，表述是否越过证据范围 | 回看原始表达和适用的领域证据；未必需要重新计算 |

背景选择和通路冗余已有方法指导。[R26](#r26) 注释版本影响富集解释也已有实证研究；GOtrack 更直接提供历史注释和富集稳定性的分析。[R27](#r27)、[R28](#r28) 因此，这个场景不能用来声称 Rho 首次关注生物知识更新。

它提供的候选问题更具体：研究者如何在自己的连续分析中，把这些诊断与正在使用的结果、此前解释和当前用途联系起来？若现成的富集工具、GOtrack 和明确的分析说明已经足够，Rho 应承接它们的结果，而不是再做一套通路分析方法。

### 1.3 集群运行到论文图表：当前脚本、已完成的计算和方法描述不是同一份事实

设想一个 RNA-seq 工作流已经在集群启动。等待期间，研究者修改了样本表和比较设计；Agent 先按新设计写好方法段落。某个样本任务失败，而一个独立的汇总脚本读取了目录中已经存在的结果。最后，工作区里同时存在当前脚本、部分旧运行输出、若干新输出和看似完整的图表。

这里的首要问题是：**这张图实际上来自哪些样本、哪次执行、哪套参数和参考资源？** 当前编辑器中的脚本不能回答运行当时用了什么。若参考数据库在容器外，固定容器也不等于固定了该参考数据库。

这首先属于已有工作流来源技术的职责。CWLProv 记录执行、资源与环境，并讨论领域注释；RO-Crate 和其他执行记录工具也应被充分使用。[R30](#r30)、[R04](#r04) 如果生产关系没有被记录，仅凭后来观察到的文件，Rho 同样不能补出确定的历史。

在执行来源被澄清之后，仍有一个不同的判断：少掉的样本是否改变配对设计或研究总体？旧结果能否作为一个范围更窄的分析保留？论文方法段落应对应哪次实际完成的分析？这需要把运行事实与科学用途连接起来，而不只是把失败任务标红。

计算环境问题在这里有明确位置：它影响哪些结果确实产生、能否重现、哪些部分仍可继续使用。方法与文献则影响这些结果能支持什么。不能因为工作涉及 HPC、多个语言或长时间运行，就直接推导出新的论文贡献。

## 2. 生信复杂性为何使这个问题具体，但不会自动使它新颖

“高信息密度、知识复杂、逻辑困难”需要落实为不同判断所需的材料，而不能只写成应用领域的形容词。

| 复杂性的来源 | 上述场景中的实际含义 | 单独增加什么仍然不够 |
| --- | --- | --- |
| 高信息密度 | 大量细胞、基因、表格和相关通路中，可能只有供者映射、背景集合或少数驱动基因决定当前解释 | 更多输出、更多屏幕或更长摘要 |
| 领域知识 | 生物学重复、细胞身份、可检测基因、通路含义，需要结合研究问题解释 | 只有文件格式和数值相等 |
| 推断逻辑 | 从观测到组间关联，再到功能或机制主张，每一步需要不同前提 | 一条没有说明依据的“支持”边 |
| 运行与环境 | 当前文件、实际执行、外部参考资源及部分结果可能来自不同时间 | 当前配置、成功退出或容器身份中的任意单项 |
| 学术使用 | 图、方法、限制和结论必须针对同一项实际分析；已有文献也有适用条件 | 引用了文章、保留了版本或生成了流畅的方法段落 |

关键在于这些内容**会相互影响**。技术上很小的改动，例如把供者 ID 换成文库 ID，可能改变推断含义；技术上很大的改动，例如只改变绘图实现，也可能不触及统计结论。字节变化量、节点数量和日志长度都不能直接表示科学影响大小。

这种情况并非生信独有。生信提供的是一组后果明确、依赖领域知识、涉及真实计算与报告责任的任务。不能声称其他数据科学没有类似困难，也不能把“高维数据”本身当作新颖性。

据此，上一版“旧判断是否仍适用”的表述应扩展并收窄：扩展到分析推进、交接和解释的过程；收窄到其中一个明确决定——**一条生物学主张目前由什么支持，哪些前提因变化需要复查，下一步应在哪个范围内介入。**

## 3. 与 InsightLens、Loops、EVI 的差别究竟在哪里

三者解决的问题不同，不能用一张功能打勾表把它们当作同类产品。

| 最近邻 | 已经提供的直接支持 | 在上述场景中还需要确定的事 |
| --- | --- | --- |
| InsightLens [R21](#r21) | 组织洞见及代码、输出、图表和解释，允许新证据修订既有洞见 | 关联到的材料是否支持当前推断单位和用途；关键领域前提没有写进对话时，怎样让人发现并核对 |
| Loops [R15](#r15) | 保留 notebook 历史，显示代码、表格和图像变化，支持回看和比较分析路径 | 某个可见差异触及了哪个科学前提；不同变化分别要求改计算、改解释，还是继续沿用 |
| EVI [R05](#r05) | 表达主张、支持和质疑；通过关系推理传播质疑 | 实际分析中的支持或质疑关系如何被提出、确认、修订，并成为研究者可执行的判断 |

**InsightLens 是重要的交互先例，不是一个只会保存静态答案的系统。** 其正文已有洞见修订和证据关联检查。这里的区分是任务要求：找到某条解释对应的代码，不等于确认该代码中的独立重复单位符合疾病比较。模型可以建议一个前提或关联，但其生成来源与领域判断仍须区分。论文未研究这一具体问题，不意味着给它增加领域材料或交互后也无法解决。

**Loops 对这个候选方向的覆盖比上一版写得更直接。** §5.2 已用肺癌队列的缺失值处理说明重要基因排序变化及解释调整，§5.1 也包含外部数据更新和跨日工作。因此不能用“我们是生信”“数据会更新”或“支持交接”与它区分。领域专家完全可能借助 Loops 完成上述判断。Rho 若要形成增量，必须解释历史和差异已经可用时，仍有哪项有后果的判断难以完成。

**EVI 已经包含影响传播，不能把它简化为静态的引用图。** 其 directlyChallenges 示例把软件缺陷的质疑传播到依赖结果，并明确：受到质疑不等于已经判错。候选差别只能落在关系的建立、维护和使用上，而不是“首次把变化连到结论”。如果相关前提与关系已经可靠编码，已有的表达和推理应当复用。

这三者并不构成“现有方法不可能做到”的证明。比较后能够提出的是一个尚待验证的工作假设：**在真实、持续变化的生信分析中，把已有历史、洞见和证据关系组织成一次范围恰当的科学判断，可能仍有显著的人力与理解成本。**

### 3.1 不能遗漏的生信近邻

BioCompute 的用途域已经要求说明科学用途及结果如何解释，另有执行、参数、输入输出、误差和审阅信息。[R29](#r29) 因此，“为分析记录适用范围”也不是 Rho 的新概念。CWLProv 包含领域注释层；GOtrack 已经把一类知识变化转化为可检查的分析。[R30](#r30)、[R28](#r28)

这些先例决定了研究的起点：尽量继承已有表达、专业检查和历史工具。需要研究的如果只是它们尚未被连到同一个界面，则先把它看作集成问题，不能自动升格为新的科学方法。

### 3.2 THREAD-Bio 已经提出了更接近的研究议程

不能只与三个交互或表示系统比较。THREAD-Bio 已直接提出连接生物学主张、分析决策与执行证据，区分执行与科学推断，并讨论有科学后果的变化、局部复核及维护成本。[R24](#r24) 它尚属概念与报告框架，不能据此断言交互问题已经解决；但也不能把它已提出的需求当作 Rho 新发现的问题。

这比“相关系统缺少生信功能”更严格地限制贡献：**仅提出一条完整的主张—证据链，甚至再加上随变化复核和减少负担的原则，仍然不够。** Rho 需要形成具体、可解释的交互方法，并揭示该方法如何帮助人完成原来难以完成的判断。当前还没有这样的研究结果。

### 3.3 把差别落实到同一次判断

仍以单细胞场景为例。InsightLens 可以帮助研究者找回“病例中干扰素相关表达更高”的解释与所附代码、图表；Loops 可以把两版分析和结果并置；EVI 可以表达这项主张受到某项证据支持，或因某个前提受到质疑。这些都可能成为解决过程的一部分。

接下来，人还需完成一串具体工作：从“病例中更高”识别出供者层面的推断要求；检查样本表与实际模型，确认这里有没有处理供者间变异；再区分“这些细胞的描述可以保留”“疾病组间推断需要重做”和“机制解释还缺独立证据”。同一张结果表不应让这三种主张自动获得相同的支持。

这一串工作不能由“找到了代码”“看到了差异”或“图中存在一条支持关系”单独推出。它也不能被一条固定的“检查生物学重复”提示完整替代，因为当前目的、实际输入和已经核实的条件决定检查什么、改动哪里。**这是候选任务与已有机制之间的区别，不是证明专家使用这些机制就做不成任务。** 若现有机制加上简短说明即可让目标研究者顺畅完成判断，便没有必要另立一个研究贡献。

## 4. 现有方法究竟没有替研究者完成哪一步

必须区分三个层次，否则很容易把已有方法描述得过弱。

### 4.1 已经解决或应由现成方法解决的部分

旧图和旧表的找回、版本差异、洞见导航、已记录的执行依赖、已声明支持关系上的影响传播，都有相应方法。针对某类统计错误的检测，应优先使用领域方法；针对 GO 变化的诊断，应优先使用专业工具。Rho 不需要在这些问题上重新命名已有成果。

来源记录不足也不是一个能靠呈现绕过的问题。如果两段不同的执行历史留下相同的可见文件，后来观察这些文件无法确定实际发生的是哪一段。需要新的可靠信息，或者保留未知。这个认识限制研究目标，不是新的发现。

### 4.2 关系能被表示，不等于关系已被建立且仍适用

回到单细胞场景，“差异表支持疾病关联”这条关系依赖供者映射、统计设计及研究总体等前提。日志可能有全部文件，关系图也可以有一条边，但哪项材料足以说明哪条前提，仍需领域知识和具体分析上下文。

这一步的候选交互问题包括：

- **发现前提。** 当前判断需要核对哪几项条件？哪些已经有记录，哪些仅在人的解释中，哪些尚未说明？
- **核对材料。** 这些条件对应的是本次实际使用的样本、模型和输出，还是另一次分析的描述？模型提出的联系是否有可检查的依据？
- **处理变化。** 新变化触及哪项条件？需要改变统计计算、重新解释现有结果、补取资料，还是对当前主张没有实质影响？

这些是任务分析，不是新本体、界面规格或已经实现的自动判断器。尤其不能承诺从日志中自动恢复全部生物学前提。

### 4.3 一次具体变化对应多种合理行动

以单细胞到富集的分析为例，下表给出判断形状。处理范围均以已核实的依赖为条件，不是通用的自动重算规则。

| 已核实的变化 | 应考虑的科学影响 | 不应无条件要求的动作 |
| --- | --- | --- |
| 仅配色、图例位置改变，数据与统计含义保持一致 | 图文是否仍正确传达结果 | 重做差异分析 |
| 细胞重新归属到不同类型 | 哪些类型的供者聚合及比较改变 | 重做与细胞身份无关且仍有效的上游计算 |
| 供者或配对信息被纠正 | 聚合、设计、差异检验及其下游解释 | 只改报告中的样本数 |
| 仅功能注释更新，上游计数与差异结果未变 | 基因映射、富集和解释是否改变 | 重做原始 reads 的处理 |
| 实际运行缺少部分样本 | 当前结果对应的总体及统计设计是否仍成立 | 因为汇总成功就继续使用完整队列的表述 |
| 支持机制解释的文献被质疑 | 该解释的论据及措辞是否需要修订 | 自动判定计算结果无效 |

一般的依赖传播能帮助圈定受影响的材料。科学上的复查还要判断：依赖变化是否触及当前用途，现有证据是否足够，以及人接下来应做什么。前提充分显式、规则成熟时，这一步可以大量复用已有方法；前提缺失或存在争议时，则需要人的澄清与判断。

## 5. 为什么值得继续研究，何时才能成为独立贡献

### 5.1 重要性来自具体后果

这里已经能论证的问题重要性，是错误推断单位、错误参照背景和执行事实与报告不一致，能够改变科学解释。它们可能与正常完成的计算、正确的数值重算和熟悉的图形同时存在。方法学文献说明其中部分错误有现实后果；上述假设场景不能进一步证明 Rho 用户中有多常见。

研究困难在于，完整展示所有细节和自动压缩成几句解释，都有代价。前者可能使决定性前提淹没在材料中；后者可能省略正是需要人判断的条件。**如何以可承受的查看和记录成本，帮助人完成一次有根据的局部判断**，是值得继续追问的交互问题。

### 5.2 一个更准确的候选问题

> 在 Agent 持续推进、证据分散且可能不完整的生物信息学分析中，研究者如何确定当前生物学主张依赖哪些分析前提，识别变化触及了哪些前提，并据此作出范围适当的修正或保留判断？

对象是一项具体主张及当前决定，不是替整个项目判定“可信”。“前提”包括研究总体、推断单位、测量与参照、方法适用性等与该决定有关的条件，不要求先为整个领域建立完整知识库。Agent 参与是使用场景和可能的困难来源；尚不能声称它创造了此前不存在的统计或推理问题。

新颖性如果能够成立，最可能来自**把领域前提与实际证据联系起来的具体交互方法，以及对它何时有用、为什么有用的解释**。随变化维护联系也是已有议程的一部分，不能单凭这一表述主张新颖性。表示可以沿用标准，运行与领域检查可以由已有工具提供。

Agent 在这里的重要性需要具体说明：当研究者直接完成一个步骤时，他可能同时掌握做出选择的背景；当 Agent 一次推进多个步骤时，后来检查的人可能只面对修改后的代码、输出与压缩过的解释。如何把实际选择重新带回人的判断，是本方向的动机之一。它仍是假设，不能未经观察便声称 Agent 必然增加错误、加重负担或改变所有研究者的工作方式。

### 5.3 哪些知识增量才足够

| 候选贡献 | 必须真正新增什么 | 仍然不足的情况 |
| --- | --- | --- |
| 解释一种实际工作困难 | 说明在历史、差异和专业分析工具已经存在时，研究者为何仍会把某项前提错误沿用、漏查或过度复查 | 只证明生信复杂，或者重复已知统计错误 |
| 支持具体判断的方法 | 让研究者有效提出、核实并更新相关前提，把变化转换为合适的分析行动，同时保留推断与未知的来源 | 多一个摘要面板、一张证据图，或一组固定的生信检查提示 |
| 适用边界与代价 | 解释什么任务需要这种支持，什么任务已有标准流程足够，何时维护关系的成本反而过高 | 只列功能、只展示成功案例，或把诚实声明未知当作有效性 |

这并不要求先发明新统计方法；也不能因为目标是交互，就跳过科学判断本身的准确性。领域专家仍可能更愿意使用 Loops 加一份清楚的分析说明。若这个组合已充分支持目标决定，研究定位就应回到集成与软件贡献。

### 5.4 哪些情形会使方向不成立

若困难主要来自缺少基础统计知识，恰当的教学或专家协作可能比工作台更有效；若唯一问题是没有捕获执行输入，应先补已有来源能力；若使用者已经把前提和关系维护得足够清楚，通用检索与差异工具可能就够用。不能人为堆叠跨工具、缺记录和出错场景来确保 Rho 看起来必要。

因此，目前可以说明**问题有明确的科学后果，值得作为具体的人机交互任务继续研究**；尚未建立一个区别于已有议程的新问题，更未说明 Rho 的实现已经解决它。下一步的思想工作是把一次真实判断讲透，而不是把需求扩展成更大的综合系统。

## 6. 更广的相关工作与检索边界

本轮为定向检索和引文追溯，截止 2026-10-30，不声称穷尽。第一轮覆盖 scientific/script provenance、analytic provenance sensemaking、notebook history、insight evidence association、LLM analysis steering 和外部 Agent 观察；本轮增加 biological replication、enrichment background、annotation evolution、BioCompute 与 CWLProv，并重点重读三个最近邻的具体机制。

核心判断采用论文正文、作者稿、标准及官方项目文档。原型评价、规范表达能力和产品说明各有证据范围；本轮未安装复现这些系统，也未验证所有商业工具。论文没有报告一项能力，不能写成该系统不可能支持它。

| 相关方向 | 直接先例 | 对候选贡献的约束 |
| --- | --- | --- |
| 来源关系与版本状态 | PROV-DM、Web Annotation [R02](#r02)、[R03](#r03) | 版本、归属、状态化意见先尝试用已有表达 |
| 脚本、文件、执行与项目 | noWorkflow、ReproZip、E2ETools、DataLad、StatWrap [R06](#r06)–[R10](#r10) | 不要求统一工作流、不接管原有工具，都已有先例；来源不足先找合适的捕获方式 |
| 从历史恢复理解与形成叙事 | 分析来源研究议程、VisTrails、CLUE、KnowledgePearls、Verdant [R01](#r01)、[R11](#r11)–[R14](#r14) | “有记录不等于易理解”和从历史生成可重返的呈现，不是新发现 |
| 代码、图形、生成过程与修订 | B2、mage、WaitGPT、任务分解、Data Formulator 2 [R16](#r16)–[R20](#r20) | 共享分析上下文、检查中间结果、分支与修订已有方法 |
| 多 Agent 与外部观察 | Treadstone、AgentSight [R22](#r22)、[R23](#r23) | 多 Agent、异步工作与外部观察不足以单独构成新颖性；生信主张与证据的直接先例另见 §3.1–3.2 |

前面的具体比较进一步限制了这一方向。不能再把 transcript + working directory 预定为主要对照，也不能用一张 Rho 开发者截图替代对真实工作困难的说明。Rho 的功能数量、协议操作和验收通过率只说明实现范围，不决定论文规模或研究问题。

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


## 8. 当前判断停在哪里

现在比“旧判断是否过期”更明确的是：以具体生物学主张为对象，研究人如何联系领域前提、实际计算和可用证据，并在变化后作出范围适当的行动。三个构造场景分别揭示推断单位、知识参照以及执行与报告的一致性；它们不承担真实用户观察的责任。THREAD-Bio 等工作已经提出相近议程，本版建立的是任务动机和贡献边界，不是新颖性结论。

还需要澄清的是，这些困难在目标研究者的实际工作中如何出现，已有方法在合理配置下究竟让人承担多少额外工作，以及是否存在可迁移的支持方式。不能把这些尚未知的部分写成“现有方法解决不了”的结论。

本版没有指定实验、样本量、阈值、消融或界面功能。之后若进入研究设计，需围绕已经确认的判断任务，而不是围绕当前模块或为了制造优势而构造的故障。旧版的 E1–E6、固定判据和九周排期继续撤回。

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
**R05 — 主张、证据及其变化。** *FAIRSCAPE* [官方项目说明](https://fairscape.github.io/)；Al Manir and Clark, *EVI: Evidence Graph Ontology*, [规范](https://fairscape.github.io/EVI/index.html)，页面标示 1.6、2026-08-13，访问于 2026-10-30。核查项目说明及 EVI 的 Introduction、Claim、Annotation、directlyChallenges / indirectlyChallenges；本轮特别核对软件缺陷传播示例与“质疑不等于判错”的限制。本条使用项目和本体文档，不据此声称已有人的效果证据。

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
**R15 — notebook 的多种差异与异步协作。** Eckelt et al. *Loops: Leveraging Provenance and Visualization to Support Exploratory Data Analysis in Notebooks*. IEEE VIS, 2024. [作者稿](https://eckelt.info/papers/2024_loops.pdf)。核查 §3–4 的捕获与实现、§5.1 的跨周分析、§5.2 的肺癌队列缺失值处理，以及 §7 的协作讨论。实现位于 notebook 前端，不能笼统归为依赖特定语言解释器的方案。

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
**R24 — 生信主张与证据的直接概念先例。** Ang et al. *Trustworthy Agentic AI in Bioinformatics: From Workflow Automation to Traceable and Validated Biological Inference*. Biology 15(17), 1537, 2026-09-04. [出版社正文](https://www.mdpi.com/2079-7737/15/17/1537)，[开放全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC13565537/)，[版本记录](https://www.mdpi.com/2079-7737/15/17/1537/notes)。重读 §6、§7.4、§9.3，直接约束本文候选贡献。只引用作者提出的概念，不把综述转述的系统表现当作原始证据，也不把其建议的审批流程转化为 Rho 产品要求。

<a id="r25"></a>
**R25 — 单细胞推断中的生物学重复。** Squair et al. *Confronting false discoveries in single-cell differential expression*. Nature Communications 12, 5692, 2021. [开放全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC8479118/)，[DOI](https://doi.org/10.1038/s41467-021-25960-2)。核查 “DE analysis of single-cell data must account for biological replicates” 与 “False discoveries in single-cell DE”。用于支持重复变异与错误推断的后果，不用于宣称某种方法适合所有设计。

<a id="r26"></a>
**R26 — 富集分析的前提与解释。** Reimand et al. *Pathway enrichment analysis and visualization of omics data using g:Profiler, GSEA, Cytoscape and EnrichmentMap*. Nature Protocols 14, 482–517, 2019. [作者稿全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC6607905/)，[DOI](https://doi.org/10.1038/s41596-018-0103-9)。核查 Background gene sets、Stage 2A、结果导航与解释、通路重叠及图表参数说明。背景要求针对相应检验，不把过度代表分析与 GSEA 混为一种方法。

<a id="r27"></a>
**R27 — 注释更新影响解释。** Wadi et al. *Impact of outdated gene annotations on pathway enrichment analysis*. Nature Methods 13, 705–706, 2016. [开放作者稿](https://pmc.ncbi.nlm.nih.gov/articles/PMC7802636/)，[DOI](https://doi.org/10.1038/nmeth.3963)。核查固定基因列表在不同年份注释下的比较；这是历史研究，不据其 2016 年结果评价今天某工具是否过时。

<a id="r28"></a>
**R28 — GOtrack。** Jacobson, Sedeño-Cortés and Pavlidis. *Monitoring changes in the Gene Ontology and their impact on genomic data analysis*. GigaScience 7(8), giy103, 2018. [开放全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC6113503/)，[DOI](https://doi.org/10.1093/gigascience/giy103)。核查 GOtrack 的基因、条目和富集历史，以及不同结果的稳定性；不从该论文推断当前在线服务的可用性。

<a id="r29"></a>
**R29 — BioCompute 的科学用途、误差与审阅。** BioCompute Object Consortium, [User Guide](https://docs.biocomputeobject.org/user_guide/)、[Usability Domain](https://docs.biocomputeobject.org/usability-domain/)、[Error Domain](https://docs.biocomputeobject.org/error-domain/)、[Provenance Domain](https://docs.biocomputeobject.org/provenance-domain/) 和 [Definitions](https://docs.biocomputeobject.org/definitions/)，访问于 2026-10-30。读取的是支持 IEEE-2791-2020 的官方说明，不声称读过付费标准全文，也不把审阅状态等同于独立验证的科学正确性。

<a id="r30"></a>
**R30 — 生信工作流的执行来源与领域注释。** Khan et al. *Sharing interoperable workflow provenance: A review of best practices and their practical application in CWLProv*. GigaScience 8(11), giz095, 2019. [开放全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC6824458/)，[DOI](https://doi.org/10.1093/gigascience/giz095)。核查 provenance levels、执行环境与产物聚合、领域注释及基因组工作流实例；采用论文中说明的实现范围，不把所有建议都当作已实现。
