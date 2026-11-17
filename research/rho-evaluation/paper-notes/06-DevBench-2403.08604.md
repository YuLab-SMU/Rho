---
paper_id: 06-DevBench-2403.08604
source_id: 06-DevBench-2403.08604.pdf
review_status: reviewed_with_limitations
source_sha256: e486fa73a8b0e027f66d8576ce3d798d61d9906d63f97bba4d48dcf54f3e3b10
---

# Prompting LLMs to Tackle the Full Software Development Lifecycle

## Question

代码 benchmark 常只测函数或实现，不能覆盖需求、设计、环境、实现和测试之间的连续关系。

## Setting and task

- Actor: 全生命周期软件开发 agent
- Task: 从 PRD 开始，完成 UML/架构设计、环境搭建、实现、验收测试和单元测试。
- Environment: DevEval，22 个仓库、四种语言和多种工程领域。每阶段可独立评估，也可串联端到端。
- Evaluation unit: 软件生命周期子任务、仓库和生成文件。

## Method

No-Review、Normal-Review 和 Execution-Feedback prompting，使用 LLM-as-a-Judge 和执行测试。

## Evaluation design

- Comparator: 不同模型、prompting mode、是否提供源代码、是否提供执行反馈。
- Evaluator or ground truth: 设计阶段用 general principles/faithfulness 的 judge 与人类标注；环境和实现用 example/acceptance/unit tests；测试任务用 Oracle Test 与 coverage。
- Metrics: Pass@、Oracle Test、Coverage、judge win rate 和与人类多数意见的一致性。

## Results

GPT-4-Turbo 在环境搭建 41.7%、实现 acceptance/unit 7.1%/8.0%；设计 judge 与 GPT-3.5 的 win rate 接近 100%，但与人类多数意见只有约 79.2%/83.2%（不计 tie）。Execution-Feedback 可提升实现，但普通 review 对复杂代码不稳定。

## Ablations and robustness

No-Review/Normal-Review/Execution-Feedback、是否给 source code、不同模型和语言。

## Limitations

只有 22 个 curated repositories；LLM judge 与人类存在差异；测试覆盖和环境任务分布不均。

## Rho relevance

这是最接近 Rho“跨阶段工作状态”的 benchmark。它支持把设计、执行反馈、结果和后续测试作为连续但可分解的评价单位。

## Interpretive note

DevBench 把“中间产物是否能被下一阶段使用”纳入任务结构。Rho 可将其扩展到人与 Agent 之间的中间产物理解和继续工作。

## Locators

- PDF §§3-4 pp.2-8; Tables 1-7; Appendices D/E
- Source PDF: `../../../../yaoshunyu-phd/papers/06-DevBench-2403.08604.pdf`
