---
paper_id: 10-TreeOfThoughts-2305.10601
source_id: 10-TreeOfThoughts-2305.10601.pdf
review_status: reviewed_with_limitations
source_sha256: 79c5237e3f63953a73f2b0d6894327702ee1f7e981450c251bb1b5cb4f8d7b8f
---

# Tree of Thoughts: Deliberate Problem Solving with Large Language Models

## Question

token-level left-to-right generation 缺少探索、前瞻和回退，复杂问题中单条 CoT 路径容易早期走错。

## Setting and task

- Actor: 通用 problem-solving language agent
- Task: Game of 24、creative writing、Mini Crosswords。
- Environment: 纯语言 thought space，任务各自定义 thought 粒度和状态评估。
- Evaluation unit: thought state、搜索树和任务 instance。

## Method

thought decomposition、candidate generation、state evaluation、BFS/DFS search 四个可插拔模块。

## Evaluation design

- Comparator: CoT、IO、self-consistency 和不同搜索/评估设置。
- Evaluator or ground truth: Game of 24 用规则验证，Mini Crosswords 用字母/词/游戏准确率，creative writing 用人工评价。
- Metrics: Game of 24 accuracy、Mini Crosswords letter/word/game accuracy、人工创作质量。

## Results

Game of 24 CoT 4%→ToT 74%；Mini Crosswords 字母 40.6%→78%、游戏 1%→20%；creative writing 质性提升。

## Ablations and robustness

BFS/DFS、thought 粒度、candidate 数、self-evaluation/vote、任务设置和 oracle 对照。

## Limitations

调用成本高；评估器不可靠；thought 粒度需要任务手工设计；纯内部搜索可能自洽地错；简单任务可能不值得搜索。

## Rho relevance

提供“生成—评估—选择”的评估接口。Rho 的工作状态也需要区分候选解释、已验证结果和最终选择，避免把模型自评当作科学验证。

## Interpretive note

ToT 的核心不是树结构，而是把中间状态变成可比较对象。Rho 可以把研究计划、结果解释和布局建议作为候选状态，但必须由真实资源和领域检查提供评估。

## Locators

- PDF §§3-4 pp.3-8; Figures 1-5; Appendix B
- Source PDF: `../../../../yaoshunyu-phd/papers/10-TreeOfThoughts-2305.10601.pdf`
