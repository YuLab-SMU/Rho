# Rho 的研究定位：一次单细胞判断能否支撑独立贡献

更新：2026-10-30。本版沿同一个单细胞场景审查贡献，不再通过增加应用场景扩张问题。结论是：**当前“连接科学前提、计算证据与变化后判断”的表述，尚不足以作为独立研究贡献，应撤下它作为论文主张的地位。** 以下说明这个结论如何得出。本文不是产品规格或实验协议；当前实现以 [Status](STATUS.md) 为准。

## 1. 固定一个决定，先给已有方法充分的条件

一项单细胞 RNA-seq 研究包括 6 名病例和 6 名对照，每名供者贡献许多细胞。研究者要判断：

> 在所研究的供者群体中，病例单核细胞的干扰素相关表达是否更高？

这是为分析任务而构造的场景，没有实际数据、效应量或用户观察。目标研究者了解供者、细胞和研究设计，但没有逐行编写 Agent 生成的分析。

上一版按供者组织比较；Agent 随后换成把细胞作为独立观测的组间检验，没有处理供者内依赖，仍报告“病例中上调”。**只改变这一项统计处理。** 样本身份、细胞注释、质控范围和计数保持不变；先不叠加批次混淆、文件丢失和注释更新。

同时假定两版代码、实际输入与输出、执行归属均可获得，且工作已处于已有工具能够观察的环境。这样不能靠“另一工具没有保存文件”制造 Rho 的优势。供者内依赖与错误差异检验的后果已有方法学证据。[R25](#r25)

研究者最后需要给出的决定是：**当前结果是否足以支持供者层面的关联；若不足，具体撤回哪项解释、修正哪部分分析，以及哪些材料仍可使用。** 不要求他判断疾病关联事实上一定存在或不存在。

## 2. 研究者具体怎样完成这次判断

### 2.1 先确定这句话究竟在声称什么

研究者读到“病例中上调”，先把它还原为分析目的：比较的对象是独立供者，关注的是某个细胞类型中的表达差异。“本次测到的细胞中存在表达差异”“供者层面的疾病关联”“干扰素机制参与致病”是不同主张。

这里不是给文字贴三个标签就完成了。研究者要确认原始问题、纳入的供者群体、目标细胞类型及比较方向。无法从一句话确定目的时，应由提出问题的人澄清；模型不能代替研究者选定目的。

这一步的产物是一句足够明确的目标，例如“比较这组病例与对照供者的单核细胞表达，评估疾病关联”。它不是机制验证，也不自动推广到未被研究的总体。

### 2.2 找到支撑这句话的那次实际分析

研究者找到报告引用的差异表、产生它的模型调用、实际输入和样本映射。他需要看到的关系是：

- 每个细胞属于哪个供者，哪些供者属于病例或对照；
- 当前模型接受的是细胞级记录还是供者级汇总；
- 如果使用细胞级记录，模型有没有以其他恰当方式处理供者内依赖。

不能因为模型代码里出现了 `donor` 字样，就认为依赖已处理；也不能因为没有这几个字符，就判定没有处理。需要理解有效模型、输入构造和实际调用。封装函数中的实现同样属于要核对的材料。

这一阶段只建立“实际做了什么”。若这些材料缺失，得到的是未确定，而不是“方法错误”。补捕获和查执行来源是已有来源技术的工作，不构成本场景的新交互贡献。

### 2.3 把实际分析与目标推断相比较

在本例已给定的事实下，研究者发现：疾病分组属于供者，多个细胞来自同一供者，当前检验却把细胞作为独立的重复。问题在于该检验的依赖结构与目标推断不相称，不在于细胞数量多或统计量算错。

能把这一步说清，需要一条具体理由：“同一供者贡献的多个细胞不能在这个疾病比较中直接充当相互独立的生物学重复。”结合实际模型，这足以质疑当前检验对供者层面结论的支持。[R25](#r25)

研究者此时可以说“这项检验不能为所要求的关联提供合适的统计支持”，但不能说“疾病关联不存在”。错误方法可能给出错误的不确定性估计，纠正后结论是否保留仍未知。

### 2.4 选择修正，而不是把错误发现等同于答案

后续分析应处理供者层面的重复与依赖。选择供者聚合还是适当的细胞级模型，需要结合数据、目标量和模型条件；不是发现问题后统一套用一个模型。

若供者身份和设计已明确，这主要是领域统计建模工作。若 `sample_id` 的含义不明确，则需要查明它是供者、组织样本还是技术文库。同一供者的两个文库不会因为 ID 不同就成为两个生物学重复。这是另一种信息条件下的分支，不能偷偷加进主例来扩大困难。

缺少真实身份映射时，更多图表、更多模型解释或更肯定的界面提示都不能补出事实。合理行动可能是补元数据，暂不作相应推断。

### 2.5 分别处理结果、解释和保留范围

研究者不能把整张图简单判为“可用”或“不可用”。即使原始表达和一些描述性汇总仍可使用，图中的显著性标记、当前检验的不确定性解释，以及依赖它们的疾病关联句子，都需要分别处理。

一个范围恰当的决定可以是：

| 对象 | 在本例中可以作出的决定 | 仍不能推出什么 |
| --- | --- | --- |
| 原始计数、供者映射、固定的细胞选择 | 在这些输入确实未变且仍适用的条件下继续使用 | 整个上游分析已经科学验证 |
| 当前独立细胞检验及其显著性标记 | 不作为供者层面疾病关联的统计支持 | 纠正后一定不显著，或真实关联不存在 |
| 描述性图表 | 检查其具体计算与标签后，按实际描述范围保留 | 原图的所有元素均可原样保留 |
| 疾病关联解释 | 等待符合设计的分析，再判断支持强度 | 换了模型就必然成立 |
| 机制性表述 | 单独核对所需证据 | 一次表达关联已经证明致病机制 |

局部修正通常不要求重做与该统计错误无关且仍适用的原始 reads 处理。这个范围来自依赖与科学判断，而不是“重新运行”按钮的大小。

### 2.6 将理由保留下来，供下一次变化重新使用

应保留的是“为什么作出这个决定”，以及它针对的主张、材料与条件。下一次若只是调整图例，这条关于重复单位的理由没有因此自动失效；若供者映射或模型依赖结构改变，则相关判断需要重新核对。

这一步仍是已有的来源、审阅记录和变化影响问题。把理由保留下来很有用，但“有用”不能直接充当新颖性。

## 3. InsightLens、Loops、EVI 与 THREAD-Bio 已经帮到哪里

以下区分论文报告的机制与本例中的合理应用。没有运行这些系统完成本例，也没有假定它们之间已存在可直接使用的集成。

### 3.1 InsightLens：材料被找到后，专家确实可能看出问题

InsightLens 提取和修订洞见，关联代码、输出、图表及解释；其证据选择本身就追求相关的关键片段，不能把“只呈现决定性证据”另算创新。[R21](#r21)

在相关内容已进入对话的条件下，它能够帮助 §2.1–2.2 的定位，也能随着修正更新洞见。研究者看到实际检验与数据上下文后，可能直接完成 §2.3 的诊断。论文对关联质量的人工评价还检查了处理、图表及关联的正确性；这不是系统自动核验任意科学前提的能力。

但关联到一段代码，不会自动建立“该方法适合这个供者层面问题”的结论。这个边界说明其支持范围，不证明必须出现新的交互。加一句正确的追问、补一张样本层级表，可能已足够帮助目标研究者完成判断。

### 3.2 Loops：可见差异可以成为诊断依据，不只是历史档案

Loops 支持 notebook 历史、代码及多类输出的比较。本例中，两版模型的比较可能直接暴露处理重复单位的变化；修正后，它也能帮助并置新旧结果。[R15](#r15)

论文已有肺癌队列缺失值处理、模型重要特征变化与解释调整的案例。因此，“技术选择会改变生物解释”“帮助专家比较后重新判断”均不是与 Loops 的有效区别。

Loops 不会因为显示了差异，就独立裁定哪个模型对应研究目的；但是专家可以用差异完成这件事。若此处只需一次代码比较和领域判断，另做一个“科学影响视图”很可能只是重新组织已有信息。

### 3.3 EVI：判断和质疑可以被表达，如何得出它们仍需依据

EVI 可以表达主张及支持、质疑关系，并沿已声明的支持关系传播质疑；规范明确，受到质疑不等于已被判错。[R05](#r05)

在本例中，研究者对重复结构的判断可以成为一条质疑，连接到受影响的检验与结论；原始数据并不因此自动全部无效。这使 EVI 能承接 §2.3、2.5、2.6 的记录与关系推理。

EVI 本体不会替研究者查明样本身份、读懂任意模型实现或判断生物学前提。关系图可以容纳“为什么支持”，不等于它已经自动找到了这个理由。可是，补一个编辑这些关系的界面，也还不是新的科学判断方法。

### 3.4 正面对照 THREAD-Bio：本例的主要原则已经被写出

THREAD-Bio 对本例的覆盖非常直接：[R24](#r24)

| 本例中的判断 | 原文位置与已提出的要求 |
| --- | --- |
| 把描述、关联和机制分开 | §6.2 区分需要不同证据的主张 |
| 检查供者重复和模型依赖 | §7.2 直接列举把单个细胞当生物学重复的问题 |
| 不把分析失败等同于所有输出作废 | §7 讨论限制主张后继续描述或探索 |
| 根据变化复核相关部分 | §7.4 讨论有科学后果的变化与复核范围 |
| 避免记录和人工审阅失去成本约束 | §9.3 讨论负担、事件记录及框架需要验证的边界 |

因此，不能再把“主张—前提—证据”“限制解释而非全盘作废”或“只在相关变化后复核”列为 Rho 新提出的原则。

THREAD-Bio 主要给出概念与报告要求，没有提供一个完成本例全部步骤的交互实现。**这个实现空白不能直接等同于方法空白。** 若 Rho 只是把其要求做成可填写的记录、可展开的证据和可点击的审阅动作，得到的是框架实现或集成，仍需另行说明研究知识增量。其审批建议也不改变 Rho 现有授权边界。

## 4. 把最强的剩余候选写具体，再检查它是否新

### 4.1 剩余候选只能是“核对意图与实际分析是否相称”

比“帮助人理解”更具体的候选，是帮助研究者核对两类内容：

- **研究意图：**要比较什么总体，以什么作为生物学重复，试图作出什么强度的结论；
- **实际分析：**哪些单位进入计算，怎样分组或聚合，模型如何处理依赖。

设想一个交互过程：人先澄清目标推断；系统从实际材料提出观测单位和模型结构的描述；人核对这些描述，解决含义不明的字段；随后共同检查二者是否一致，并标明受影响的主张。这个过程的输入、人工决定和可能输出都已比一张“证据面板”具体。

但它依然只是方法草图。关键操作是如何获得足够准确的语义、选择需要澄清的歧义，以及据何规则确定不一致。不能把这三步写成“由模型理解”后就视为已提出方法。

### 4.2 “把隐含前提说出来”已有直接的交互先例

Tisane 已让人声明观测单位、测量与嵌套关系，并据此推导候选统计模型、通过追问消除歧义。其重复和层级结构的处理，对本例尤其直接。[R31](#r31)

rTisane 又提供概念模型澄清与统计模型推导的两阶段交互，让人表达假设、处理含义不确定的关系并修订模型。[R32](#r32) 因此，“让领域专家把知识变成明确前提，再由交互帮助选择模型”不是尚无人提供的方法。

这些工作并不等于现成的单细胞差异分析工具，也不保证可以诊断任意外部代码。它们在这里的作用是约束交互新颖性。不能因为需要适配单细胞数据，就把同样的澄清机制重新当作贡献。

同样，如果再加“把几个分析选择的结果并排比较”，Boba 已提供分析选择与结果、敏感性和模型拟合之间的交互联系。[R33](#r33) 将无效的独立细胞检验与恰当方法并排，不会使二者都成为同等合理的备选；方法适用性仍要先有依据。

### 4.3 在本例中，剩余工作分别落在哪里

| 试图新增的操作 | 在这个场景中的实质 | 当前能否据此主张独立方法 |
| --- | --- | --- |
| 提醒“注意供者重复” | 已知的方法学规则或领域提示 | 不能 |
| 让人确认细胞、样本、文库和供者的关系 | 概念澄清与数据语义补充；已有交互先例 | 不能只凭这项操作主张 |
| 对照明确的供者结构与明确的独立细胞检验 | 针对已知条件的相容性检查 | 目前只是规则检查，未给出新的方法 |
| 从任意外部代码恢复实际依赖结构 | 语义提取与程序分析，且需要运行证据 | 本方案尚未给出解法，不能由界面设想代替 |
| 自动选择最值得问人的问题 | 需要说明候选歧义、选择依据和停止条件 | 本文尚未给出具体机制，不能直接交给 LLM 后宣称贡献 |
| 把诊断转成局部修正与受影响主张 | 结合领域规则、来源关系与已有复核原则 | 当前解释可由已有方法承接，尚无独立知识增量 |

“任意代码恢复语义”和“选择必要的澄清问题”可能涉及研究，但本例没有迫使我们提出一个新解法，也没有说明一个可成立的新解法是什么。把这些难题列进待办清单，会再次退回问题描述。

### 4.4 为什么不能以“仍然需要人”为研究缺口

一个支持科学分析的交互系统，本来就可能把科学判断留给研究者。证明人还要读模型、查元数据或决定解释，不等于证明工具失败。

要区分的至少有三种情况：

- 人已经能借助历史和证据完成判断，只是各工具尚未集成；
- 人缺少关键事实或统计知识，需要补材料或获得专业帮助；
- 人具备知识和材料，但某个具体交互障碍仍妨碍正确使用它们。

上一版实际想主张的是第三种困难，但当前构造场景没有把它与前两种情况分开。前两种也可能值得研究，不过工具整合和统计学习需要各自具体的方法与论证。不能把“高信息密度”“Agent 一次做了很多步骤”或“理解成本可能很高”当作这一区分已经完成的证据。

## 5. 贡献判断：当前方向不能承担论文主线

**按目前给出的场景和方法描述，这个方向撑不起独立研究贡献。** 原因不是尚未安排实验或尚未实现界面，而是最关键的研究增量还不存在于论证中：

1. 科学问题是已知的重复结构与推断适用性问题。
2. 历史查找、洞见与证据组织、质疑传播和变化后复核均有直接先例。
3. 将领域前提通过交互澄清并联系到统计模型，也已有 Tisane/rTisane 的具体方法。
4. 当前剩余内容是工具集成、领域适配，或尚未给出解法的语义恢复任务。

这不等于这些工具已经作为一个整体解决所有生信工作，也不等于集成或领域适配永远不能产生研究贡献。它意味着：**不能从现有组合尚不方便，直接跳到新交互方法已经成立。** 本例目前没有给出整合过程中新增的机制或认识。

因此，应把这一方向从“候选论文贡献”降为“已知科学判断任务及实现参考”。本文保留任务分解和原始文献，停止给它增加更宽的场景、概念名称或贡献措辞。若未来有真实工作暴露出更具体且已有方法不能充分解释的障碍，再重新判断；当前不预留一个必然属于 Rho 的新颖性位置。

## 6. 更广的相关工作与检索边界

检索截止 2026-10-30，为定向检索和引文追溯，不声称穷尽。前两轮覆盖来源记录、分析历史、洞见管理、Agent 分析及生信方法；本轮从单细胞判断中的具体操作出发，重读 InsightLens、Loops、EVI 与 THREAD-Bio，并补查 Tisane、rTisane 和 Boba，以检验“澄清领域前提、比较分析选择”是否真是空白。

核心判断采用论文正文、作者稿、标准及官方项目文档。原型评价、规范表达能力和产品说明各有证据范围；本轮未安装复现这些系统，也未验证所有商业工具。论文没有报告一项能力，不能写成该系统不可能支持它。

| 相关方向 | 直接先例 | 对候选贡献的约束 |
| --- | --- | --- |
| 来源关系与版本状态 | PROV-DM、Web Annotation [R02](#r02)、[R03](#r03) | 版本、归属、状态化意见先尝试用已有表达 |
| 脚本、文件、执行与项目 | noWorkflow、ReproZip、E2ETools、DataLad、StatWrap [R06](#r06)–[R10](#r10) | 不要求统一工作流、不接管原有工具，都已有先例；来源不足先找合适的捕获方式 |
| 从历史恢复理解与形成叙事 | 分析来源研究议程、VisTrails、CLUE、KnowledgePearls、Verdant [R01](#r01)、[R11](#r11)–[R14](#r14) | “有记录不等于易理解”和从历史生成可重返的呈现，不是新发现 |
| 代码、图形、生成过程与修订 | B2、mage、WaitGPT、任务分解、Data Formulator 2 [R16](#r16)–[R20](#r20) | 共享分析上下文、检查中间结果、分支与修订已有方法 |
| 多 Agent 与外部观察 | Treadstone、AgentSight [R22](#r22)、[R23](#r23) | 多 Agent、异步工作与外部观察不足以单独构成新颖性；生信主张与证据的直接先例见 §3，概念模型交互见 §4 |

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

## 8. 当前决定

本轮没有识别出足以区分已有研究的核心交互方法。单细胞场景说明一项重要判断如何进行，也说明 InsightLens、Loops、EVI、THREAD-Bio 与概念模型工具分别覆盖了什么；它没有证明必须出现新的综合工作台。

旧版把“仍需人核对科学前提”当作剩余研究空间，论证不够。本文撤回这一步推断，并暂不把该方向作为论文主线。没有新增实验协议、功能要求或实现任务，也不以 Rho 的现有模块决定后续研究。

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
**R24 — 生信主张与证据的直接概念先例。** Ang et al. *Trustworthy Agentic AI in Bioinformatics: From Workflow Automation to Traceable and Validated Biological Inference*. Biology 15(17), 1537, 2026-09-04. [出版社正文](https://www.mdpi.com/2079-7737/15/17/1537)，[开放全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC13565537/)，[版本记录](https://www.mdpi.com/2079-7737/15/17/1537/notes)。重读 §6、§7.2、§7.4、§9.3，直接约束本文候选贡献。只引用作者提出的概念，不把综述转述的系统表现当作原始证据，也不把其建议的审批流程转化为 Rho 产品要求。

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

<a id="r31"></a>
**R31 — 领域、数据层级与统计模型的交互推导。** Jun, Seo, Heer and Just. *Tisane: Authoring Statistical Models via Formal Reasoning from Conceptual and Data Relationships*. CHI, 2022. [所读 arXiv v1 作者稿](https://arxiv.org/pdf/2201.02705v1)，[DOI](https://doi.org/10.1145/3491102.3501888)。核查 motivating example、Units / Measures、nesting 与 interactive compilation；作者稿为 25 页，不据此推断正式出版页数。本文引用机制先例，不声称它已验证任意单细胞分析或外部代码。

<a id="r32"></a>
**R32 — 领域假设的交互澄清。** Jun, Misback, Heer and Just. *rTisane: Externalizing Conceptual Models for Data Analysis Prompts Reconsideration of Domain Assumptions and Facilitates Statistical Modeling*. CHI, 2024. [作者出版页](https://idl.uw.edu/papers/rtisane)，[所读 CHI 作者全文](https://idl.cs.washington.edu/files/2024-rTisane-CHI.pdf)，[DOI](https://doi.org/10.1145/3613904.3642267)。核查 §5.1–5.2 的声明、概念模型修订与统计模型推导。2023 年 arXiv 稿标题不同，本条采用 2024 年出版页与所链全文；不把局部模型支持推广为通用生物学判断器。

<a id="r33"></a>
**R33 — 分析选择与结果的交互比较。** Liu, Kale, Althoff and Heer. *Boba: Authoring and Visualizing Multiverse Analyses*. TVCG 27(2), 2021. [作者出版页](https://idl.uw.edu/papers/boba)，[DOI](https://doi.org/10.1109/TVCG.2020.3028985)。本轮读取作者页摘要和交互图说明，用于核实已有的选择—结果比较机制；不据此评价全文的研究设计，也不声称列出的所有备选分析都科学有效。
