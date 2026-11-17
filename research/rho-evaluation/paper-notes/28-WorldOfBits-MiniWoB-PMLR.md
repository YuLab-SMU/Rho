---
paper_id: 28-WorldOfBits-MiniWoB-PMLR
source_id: 28-WorldOfBits-MiniWoB-PMLR.pdf
review_status: reviewed_with_limitations
source_sha256: 087008efb9d056df5fd9fbc724413d6a3f20cb14c7f1597d00bacac53d8342d6
---

# World of Bits: An Open-Domain Platform for Web-Based Agents

## Question

网页提供开放域、长尾、真实 UI 行为，但 RL agent 缺少能规模化构造和评估 web tasks 的平台。

## Setting and task

- Actor: web RL agent
- Task: 通过鼠标键盘和网页请求完成 MiniWoB、FormWoB 和 crowdsourced QAWoB 任务。
- Environment: MiniWoB hand-crafted tasks、FormWoB live websites、QAWoB crowdsourced websites；支持截图、DOM、raw events 和 cache。
- Evaluation unit: web task/query episode。

## Method

三层任务构造：最小任务、真实网站 proxy、众包任务；比较 CNN supervised learning、RL 和 human。

## Evaluation design

- Comparator: random、human、LocalCNN/GlobalCNN、SL、SL+RL，训练/测试 query split。
- Evaluator or ground truth: 网站终点 reward，success/reward；按 query 80/20 split，测试训练和新 query 泛化。
- Metrics: test likelihood、average reward、success rate、human-normalized reward。

## Results

FormWoB flight task 训练 query 约 20–30% human，test 约 16%；QAWoB GlobalCNN 优于 LocalCNN，但与 human 差距显著。论文提出网页任务构造进阶而非单一 benchmark 分数。

## Ablations and robustness

Local/Global CNN、SL vs SL+RL、FormWoB/QAWoB、train/test query、任务网站和 cache。

## Limitations

真实网站 cache 和代理环境仍不完全等同；动作和 reward 受任务设计限制；失败常因偏离 demonstration state distribution。

## Rho relevance

提供了“可控最小任务—真实网站代理—众包任务”的实验梯度。Rho 可按同样顺序从系统机制 pilot 走向真实研究者任务。

## Interpretive note

World of Bits 的分层环境设计是 Rho 两阶段实验的直接先例：先在可复现、低风险环境隔离机制，再逐步进入真实工作场景。

## Locators

- PDF §§2-4, 6; Figures 8-11; Table 1; PMLR pages 3135-3144
- Source PDF: `../../../../yaoshunyu-phd/papers/28-WorldOfBits-MiniWoB-PMLR.pdf`
