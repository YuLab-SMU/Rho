---
paper_id: 13-ALFWorld-2010.03768
source_id: 13-ALFWorld-2010.03768.pdf
review_status: reviewed_with_limitations
source_sha256: 4be2e61e875ca34f19befa92e8a117347fc380a2076d6e829e22e2a4c03dc9e1
---

# ALFWorld: Aligning Text and Embodied Environments for Interactive Learning

## Question

视觉 embodied agent 难以在有限交互中学习复杂语言任务，纯静态 demo 不能提供错误恢复和抽象策略。

## Setting and task

- Actor: 跨文本/视觉 embodied agent BUTLER
- Task: 六类 household task：找物、清洁/加热/冷却、放置和组合操作。
- Environment: 3,553 个 ALFRED 任务，TextWorld 与 ALFRED/THOR 共享潜在世界结构；seen/unseen 房间和任务。
- Evaluation unit: 任务 episode，按 task type 和 seen/unseen split。

## Method

BUTLER::BRAIN 在 TextWorld 学高层语言动作，VISION 将图像转成文字观察，BODY 将高层动作转成低层导航/操作。

## Evaluation design

- Comparator: Seq2Seq 静态 demonstration、embodied-only、hybrid、oracle state/controller 和 human goals。
- Evaluator or ground truth: 任务 success 和 goal-condition success，分别在 TextWorld、seen/unseen embodied settings。
- Metrics: success rate、goal-condition success、训练速度和跨模态 transfer。

## Results

All Tasks 上 TextWorld success 40/35（seen/unseen），BUTLER embodied 19/10，oracle 37/26；TextWorld 训练约快 7 倍，abstract-only 对 unseen generalization 更好。

## Ablations and robustness

interactive TextWorld vs static corpus、DAgger、beam search、oracle detector/controller、human-annotated goals、training strategy。

## Limitations

state estimator、导航和物理 domain gap 仍是主要瓶颈；templated language 对 human goals 泛化有限；仿真结果不等于真实机器人。

## Rho relevance

展示了用共享潜在状态连接抽象任务和具体执行的评估方法。Rho 的资源、动作和结果也需要稳定 identity，才能比较跨视图或跨参与者连续性。

## Interpretive note

ALFWorld 的“抽象环境训练、具体环境执行”与 Rho 的“共享工作状态、不同参与者继续”有结构相似性，但 Rho 的目标是工作理解而不是控制迁移。

## Locators

- PDF §§2-5 pp.2-9; Table 1-4; Figure 2
- Source PDF: `../../../../yaoshunyu-phd/papers/13-ALFWorld-2010.03768.pdf`
