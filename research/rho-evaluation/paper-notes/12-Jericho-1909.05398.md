---
paper_id: 12-Jericho-1909.05398
source_id: 12-Jericho-1909.05398.pdf
review_status: reviewed_with_limitations
source_sha256: 4d3ccdb4d8673ac5cf09f5e5ce2769893345c45f7355207be4b7b145e6ce7a6a
---

# Interactive Fiction Games: A Colossal Adventure

## Question

需要一个可复现的、真实文本互动、动作空间组合爆炸且带长期状态的 language-agent 环境。

## Setting and task

- Actor: 文本游戏 RL agent
- Task: 在人工 interactive fiction 游戏中导航、推理、收集物品和完成故事目标。
- Environment: 开源 Python Gym-like 环境，支持多种类型的人造 IF 游戏、模板动作、world object tree、save/load 和随机种子。
- Evaluation unit: 游戏和完整 episode。

## Method

提供 template-based action space、valid action/world-change 检测和 DRRN、TDQN、NAIL 三类 agent。

## Evaluation design

- Comparator: RAND、NAIL、单游戏 DRRN/TDQN；有无 handicap。
- Evaluator or ground truth: 游戏 point score、最大分数归一化、跨游戏平均完成度。
- Metrics: normalized score、每游戏 raw score、训练曲线和动作空间大小。

## Results

32 个支持游戏上 RANDOM 1.8%、NAIL 4.9%、TDQN 6.1%、DRRN 10.7% completion；五个游戏所有 agent 无分数。

## Ablations and robustness

choice-based vs template-based、handicap、单游戏 vs unseen game、模型和游戏难度。

## Limitations

仍是游戏模拟器，支持的游戏有 score/world-change 条件；评估目标由游戏分数定义，不覆盖开放式协作或研究工作。

## Rho relevance

提供“可复现环境 + 长程状态 + 轨迹”的早期基准范式。Rho 的评估要把游戏状态类比为项目工作状态，同时加入人和 Agent 的交接。

## Interpretive note

Jericho 把世界状态、动作合法性和分数显式化。它说明可复现状态对研究有效评估很重要，但无法回答工作状态是否被下一个人理解。

## Locators

- PDF §§2-6 pp.2-7; Table 1-2; Figure 3
- Source PDF: `../../../../yaoshunyu-phd/papers/12-Jericho-1909.05398.pdf`
