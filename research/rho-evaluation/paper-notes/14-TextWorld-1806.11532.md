---
paper_id: 14-TextWorld-1806.11532
source_id: 14-TextWorld-1806.11532.pdf
review_status: reviewed_with_limitations
source_sha256: 2dd45425bcbe08b7695d79fd32d3c7ed8dc3020a956316b4f1c278288a8c1e1d
---

# TextWorld: A Learning Environment for Text-based Games

## Question

文本游戏中部分可观测、语言动作、长程 quest 和稀疏奖励让 RL 难以训练，需要可控、可生成、可验证的环境。

## Setting and task

- Actor: 文本游戏 RL agent
- Task: 在程序生成的文本游戏中完成 quest，支持地图、物品、容器、动作依赖和文本变体。
- Environment: TextWorld engine、逻辑状态和 Inform 7；可控地图大小、物体数、quest 长度、主题和文本生成。
- Evaluation unit: 程序生成游戏和 quest episode。

## Method

用逻辑规则生成有效游戏，提供 final reward 和基于 winning policy 的 intermediate reward，并在 Treasure Hunter benchmark 上评估。

## Evaluation design

- Comparator: 随机/规则和不同 RL agent/设置；one-life benchmark。
- Evaluator or ground truth: 是否达到逻辑 winning state、最终 reward、intermediate reward 和任务完成。
- Metrics: discounted return、success/quest completion、sample efficiency 和不同难度配置。

## Results

论文重点建立可生成环境和 reward 机制，展示 Treasure Hunter 任务可用于比较 agent；中间奖励可以根据 winning policy 纠正偏离。具体 benchmark 分数依配置而变。

## Ablations and robustness

world/quest/text generation 参数、intermediate reward、不同 quest 长度和 one-life evaluation。

## Limitations

文本和规则生成的分布可能与真实工作脱节；目标可验证但开放式质量无法表示；生成器的先验会影响难度。

## Rho relevance

为 Rho 的实验任务生成提供了“可控输入、状态、过程反馈和最终条件”的设计思想。Rho 需要把科学任务的 domain checks 保留在项目 owner 中。

## Interpretive note

TextWorld 证明了可规模化环境需要把 state transition、reward 和 text realization 分开设计。Rho 的实验也应分开任务内容、工作状态记录和结果验证。

## Locators

- PDF §§2-6 pp.3-20; Figures 3-7; §5.2; Appendix A-C
- Source PDF: `../../../../yaoshunyu-phd/papers/14-TextWorld-1806.11532.pdf`
