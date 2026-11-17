---
paper_id: 25-WebArena-2307.13854
source_id: 25-WebArena-2307.13854.pdf
review_status: reviewed_with_limitations
source_sha256: f9731b92bc3d29a2ea7b5f9cb46b48540c76bc3f84a57e0c48fc37ea73107f95
---

# WebArena: A Realistic Web Environment for Building Autonomous Agents

## Question

现有 web benchmark 环境与真实网站脱节，任务、工具、知识源和功能正确性需要可复现的综合环境。

## Setting and task

- Actor: web automation agent
- Task: 在购物、论坛、GitLab、地图和工具网站上完成日常自然语言任务。
- Environment: 四个 self-hosted web apps、utility websites、knowledge bases、可复现任务和视频。
- Evaluation unit: web task。

## Method

构建真实感环境、从人类需求收集任务、标注可验证目标，比较 ReAct-style baseline agents。

## Evaluation design

- Comparator: 不同 agent、reasoning before acting、human performance。
- Evaluator or ground truth: functional correctness，任务目标是否满足；另有 human success。
- Metrics: task success rate、action trajectory、human success。

## Results

最佳 baseline task success 14.41%，human 78.24%；环境强调真实功能、任务多样性和可复现 self-hosting。

## Ablations and robustness

不同 agent、reasoning、网站/任务类型和 baseline context。

## Limitations

功能正确性仍无法覆盖用户满意度、解释和长期工作；self-hosted 网站与真实互联网仍有差异；任务 annotation 成本高。

## Rho relevance

支持 Rho 将真实研究任务、可复现项目和 owner-defined checks 结合。WebArena 的 self-hosted、任务目标和功能正确性结构可用于设计 Rho disposable projects。

## Interpretive note

WebArena 将“真实性”和“可复现性”同时作为环境设计目标，这正是 Rho 科学实验需要的平衡。

## Locators

- PDF §§2-5 pp.2-9; Figure 1; Tables/Appendix A
- Source PDF: `../../../../yaoshunyu-phd/papers/25-WebArena-2307.13854.pdf`
