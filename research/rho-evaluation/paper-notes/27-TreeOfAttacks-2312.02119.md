---
paper_id: 27-TreeOfAttacks-2312.02119
source_id: 27-TreeOfAttacks-2312.02119.pdf
review_status: reviewed_with_limitations
source_sha256: b0ffafed56bef4937150dcf63ac5379cdc6aeedeac4a83b1af56512d92f9a496
---

# Tree of Attacks: Jailbreaking Black-Box LLMs Automatically

## Question

需要评估黑盒 LLM 的安全边界，自动 jailbreak 方法既要成功率高又要查询成本低。

## Setting and task

- Actor: attacker/evaluator/target LLM system
- Task: 自动生成自然语言 jailbreak prompts，测试多个目标 LLM 和 guardrail。
- Environment: AdvBench subset 和新数据集；目标模型 black-box query access。
- Evaluation unit: harmful prompt 和 attack tree。

## Method

Tree of Attacks with Pruning：attacker branching、evaluator pruning、target attack、继续迭代。

## Evaluation design

- Comparator: PAIR、TAP variants without branching/pruning、不同 evaluator 和 target models。
- Evaluator or ground truth: 自动 GPT-4 evaluator + human judgment 判断目标是否给出有害信息；查询数与 token budget。
- Metrics: jailbreak success rate、target queries per prompt、transferability、monetary cost。

## Results

TAP 在 GPT-4 上约 90% success/28.8 queries，相对 PAIR 60%/37.7；GPT4o 论文版本报告 94% success 且 queries 减少约 60%；branching 提升成功率，pruning 约减半查询。

## Ablations and robustness

branching width、pruning、evaluator choice、binary vs continuous scores、held-out data、guardrails。

## Limitations

安全研究场景；自动 evaluator 与 human judgment 仍有差异；success 定义依赖危害内容判断；不能直接外推一般 agent evaluation。

## Rho relevance

说明生成—评估—剪枝接口可以用于评估器本身，但评估器判断必须独立核验。Rho 的候选工作状态和恢复路径也可用类似思路压缩探索。

## Interpretive note

TAP 是 ToT 思想在安全评估中的应用。它把 query budget 和 evaluator reliability 同时纳入实验，Rho 的实验也应记录资源和人力成本。

## Locators

- PDF §§3-6 pp.8-13; Tables 1-4; Appendices D-E
- Source PDF: `../../../../yaoshunyu-phd/papers/27-TreeOfAttacks-2312.02119.pdf`
