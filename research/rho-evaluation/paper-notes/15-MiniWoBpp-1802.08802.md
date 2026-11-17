---
paper_id: 15-MiniWoBpp-1802.08802
source_id: 15-MiniWoBpp-1802.08802.pdf
review_status: reviewed_with_limitations
source_sha256: 7a7ce9d5f8f31c7f7c01a35271c5bdfdf2697dfe17e72ff090a9465d55f7f60d
---

# Reinforcement Learning on Web Interfaces Using Workflow-Guided Exploration

## Question

网页任务奖励稀疏、动作空间大，behavioral cloning 容易过拟合演示轨迹，RL 很难发现成功路径。

## Setting and task

- Actor: 网页 UI RL agent
- Task: 在 MiniWoB、MiniWoB++、FormWoB 和 QAWoB 任务中完成点击、输入和表单操作。
- Environment: Selenium browser；多数任务终点才给 ±1 reward；MiniWoB++ 40 个支持任务。
- Evaluation unit: web task episode。

## Method

从人类 demonstrations 诱导 workflow lattice，workflow policy 约束探索并把成功 episode 写入 replay buffer，再训练 DOMNET neural policy。

## Evaluation design

- Comparator: Shi17、DOMNET+BC+RL、workflow policy only 和不同 demonstrations 数量。
- Evaluator or ground truth: 任务终点 reward；success rate，Alaska 等任务另有 partial reward。
- Metrics: success rate、test reward、training sample efficiency。

## Results

WGE 在 MiniWoB++ 复杂任务上比 BC+RL 平均高约 42 个百分点；10 demos 的 WGE 在困难任务上超过 BC+RL 的 1000 demos，报告超过 100x sample efficiency；Alaska 1 demo average reward 0.97，扩展版 10 demos 0.86。

## Ablations and robustness

workflow vs BC+RL、DOMNET 架构、natural language goals、training demos、πw only、不同网站任务。

## Limitations

workflow policy 本身不理解环境状态；失败恢复依赖演示分布；Web 任务的 success reward 仍由环境定义，不能评价开放式工作质量。

## Rho relevance

展示了将人类演示转换成可执行工作流和探索约束的方法。Rho 可将研究步骤和交接记录作为工作流证据，但要验证它是否帮助人继续，而不是只提升 agent success。

## Interpretive note

WGE 的对照设计很适合 Rho 的机制实验：固定任务和环境，只改变是否提供结构化工作状态约束，然后比较恢复和完成。

## Locators

- PDF §§3-6 pp.3-9; Figure 1-4; Table 1
- Source PDF: `../../../../yaoshunyu-phd/papers/15-MiniWoBpp-1802.08802.pdf`
