# Rho positioning brief

状态：draft。当前内容来自 Rho 的架构、状态和文献复现记录，28 篇论文尚未完成深读。

## Target reader

研究工作台与 HCI 读者，关心人和 Agent 如何在长时间、跨会话的研究任务中共同理解和继续工作。

## Problem

长程研究工作会跨越文件、Notebook、表格、图、运行、对话和决策。参与者需要知道当前目的、已经发生的动作、结果由什么产生，以及下一位参与者可以从哪里继续。现有系统和 Agent 评估是否覆盖这一连续性，需要由完整相关工作核对。

## Candidate contribution

Rho 可以被表述为一个共享工作状态层。它把目的、资源、动作、结果、进展和开放问题连接起来，并让人和外部 Agent 在同一项目中继续工作。这个表述目前是概念候选，尚未构成经过独立实验验证的效果主张。

## Current evidence

- 架构文档描述了 Rho、Rho-core 和 Rho-plugins 的所有权边界以及共享工作状态。
- 现有 episodes 记录了跨参与者、资源、Notebook、结果和回复的系统行为。
- 五篇开放论文的分析复现记录了 Rho 对运行、文件、图、笔记和不一致结果的保留。
- 当前状态明确把独立研究者使用、创新性和人类收益列为未建立的证据。

## Literature questions

1. 相关工作把研究连续性、共享状态、 provenance、long-horizon work 和 human-Agent collaboration 分成了哪些问题？
2. 哪些论文用任务成功、轨迹、人工判断、结果质量或恢复行为来评估？
3. 哪些比较设计能区分系统机制、使用体验和科学结果？
4. Rho 的主张应落在哪个已有讨论中，具体新增了哪一个可证伪的区分？

## Candidate experiments

阶段一用 Rho 内部能力比较定位共享状态和连续性机制。阶段二用同任务原生工作流比较实际研究收益。两阶段都需要在 paper matrix 完成后确定任务、单位、指标、样本和统计方法。

## Boundary

当前材料支持系统行为的有限观察。它还不能支持独立研究者可用性、一般研究效率、科学结论正确性或普遍创新性的结论。

## Sources

- `docs/ARCHITECTURE.md`
- `docs/STATUS.md`
- `docs/ROADMAP.md`
- `docs/LITERATURE-REPRO-EPISODE.md`
- `/Users/xiayh/Projects/yaoshunyu-phd/papers/00-INDEX.md`
