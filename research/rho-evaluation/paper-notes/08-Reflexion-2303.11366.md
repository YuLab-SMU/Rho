---
paper_id: 08-Reflexion-2303.11366
source_id: 08-Reflexion-2303.11366.pdf
review_status: reviewed_with_limitations
source_sha256: 6059b6f89fea9959bd3dab553fbb97756a3dfb1b15e3cbab2fbf3ab6664333bd
---

# Reflexion: Language Agents with Verbal Reinforcement Learning

## Question

传统 RL 需要大量样本和微调，language agent 缺少从试错中快速学习的机制。

## Setting and task

- Actor: decision、reasoning 和 programming language agent
- Task: ALFWorld 决策、HotpotQA 推理、HumanEval/LeetcodeHardGym 编程。
- Environment: 外部环境或 self-evaluation 产生反馈，反思文本写入 episodic memory。
- Evaluation unit: 跨试验 episode 或编程题。

## Method

Actor、Evaluator、Self-Reflection 三模块。每次失败后生成 verbal reflection，追加到记忆缓冲区供下一次尝试。

## Evaluation design

- Comparator: ReAct/CoT actor、不同 evaluator、反馈类型和 memory incorporation。
- Evaluator or ground truth: 环境 binary/scalar feedback、heuristics、LLM self-evaluation 和 self-written unit tests。
- Metrics: ALFWorld success、HotpotQA accuracy、HumanEval pass@1 和迭代次数。

## Results

摘要报告 HumanEval 91% pass@1，超过 GPT-4 80%；ALFWorld 12 次迭代绝对提升约 22%，HotpotQA 提升约 20%，编程最高提升约 11%。

## Ablations and robustness

feedback source、reflection model、memory usage、actor type、trial count 和 additional models。

## Limitations

反思依赖 self-evaluation/credit assignment；错误反思会累积；记忆增加上下文成本；没有 formal success guarantee。

## Rho relevance

Reflexion 是跨试验状态保留的直接参考。Rho 的记忆对象由模型反思扩展为人、Agent、资源版本、结果和决策的共享记录，需要检验错误记忆是否会误导后续参与者。

## Interpretive note

它把“失败后的文字总结”当作学习动作。Rho 可以把失败、未知和恢复路径作为一等记录，但不能把模型生成的解释自动升级为事实。

## Locators

- PDF §§1-4 pp.1-9; Figure 2; Appendices B-D
- Source PDF: `../../../../yaoshunyu-phd/papers/08-Reflexion-2303.11366.pdf`
