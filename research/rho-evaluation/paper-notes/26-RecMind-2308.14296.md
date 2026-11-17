---
paper_id: 26-RecMind-2308.14296
source_id: 26-RecMind-2308.14296.pdf
review_status: reviewed_with_limitations
source_sha256: 40c723db9a5ebcd83b88df42dc187568458bc76eeb72eaf78ef0e6b072dc4bee
---

# RecMind: Large Language Model Powered Agent for Recommendation

## Question

推荐任务需要用户记忆、世界知识、工具和多步 reasoning，传统输入输出模型不能表达复杂决策。

## Setting and task

- Actor: 推荐 agent
- Task: rating prediction、sequential recommendation、direct recommendation、解释和 review summary。
- Environment: Amazon Reviews/Yelp，personalized database、world knowledge、tool use；Beauty/Sports/Toys 等 domain。
- Evaluation unit: 用户-物品 recommendation instance 和 reasoning task。

## Method

planner、personalized/world memory、database tool、外部工具和 self-inspiring planning；生成多个 reasoning path 再评估选择。

## Evaluation design

- Comparator: ChatGPT/CoT/ToT/P5、不同 LLM、没有 self-inspiring 的 RecMind。
- Evaluator or ground truth: MAE、HR@5/10、NDCG、BLEU2、LLM/human-style rating；Game of 24/Mini Crosswords 作为通用 reasoning test。
- Metrics: MAE、HR@5、BLEU2、accuracy、letter/word/game accuracy。

## Results

RecMind-SI 在 Game of 24 80% vs CoT 4%/ToT 74%，Mini Crosswords game 26% vs 1%/20%；推荐任务上结合 memory/tools/self-inspiring 通常优于 baselines，跨 domain 仍有差异。

## Ablations and robustness

memory/tool/planning、自 inspiring path 数、foundation LLM、domain transfer 和 prompt。

## Limitations

多路径导致 prompt 变长和 position bias；外部工具有限；推荐数据的 user ID 匿名但结果不能代表真实用户价值。

## Rho relevance

展示了 memory、工具和多路径决策如何被组合评价。Rho 的定位可以把“共享工作状态”视为跨参与者的 memory/tool substrate，但需增加真实研究任务和人类理解指标。

## Interpretive note

RecMind 的 self-inspiring 结果复用了 ToT 的任务，提醒我们区分“方法框架的可迁移性”与“具体应用中的实际价值”。

## Locators

- PDF §§3-4 pp.3-9; Tables 1-7; §4.6
- Source PDF: `../../../../yaoshunyu-phd/papers/26-RecMind-2308.14296.pdf`
