---
paper_id: 02-WebShop-2207.01206
source_id: 02-WebShop-2207.01206.pdf
review_status: reviewed_with_limitations
source_sha256: 131e93080bc8d9ff801ff40bf69b7d12bfd9db018c223fdf03e622928f7ec032
---

# WebShop: Towards Scalable Real-World Web Interaction with Grounded Language Agents

## Question

真实网页任务很实用，但过去环境规模小、动作空间受限或需要人工评估，难以规模化比较 agent。

## Setting and task

- Actor: 网页购物 agent
- Task: 根据自然语言购物指令搜索、点击商品和选项并完成购买。
- Environment: 1.18M 真实商品、12k 人工指令；搜索/结果/商品/购买组成的模拟网页，可渲染 HTML 或 simple mode。
- Evaluation unit: 购物指令 episode。

## Method

Rule baseline、human demonstration 的 imitation learning，以及 IL 后用环境奖励进行 RL。

## Evaluation design

- Comparator: 规则、IL、IL+RL 和人类参与者；另有 choice oracle、图像、搜索等消融。
- Evaluator or ground truth: 商品属性与自然语言指令约束的自动匹配。Task Score 是平均 reward 的 100 倍，Success Rate 要求完全匹配。
- Metrics: Task Score、Success Rate、轨迹长度和人类完成时间；另有 sim-to-real Amazon/eBay 结果。

## Results

模拟环境 IL+RL Score 62.4、SR 28.7%，人类 SR 59.6%；零样本 real-world transfer 中 IL+RL 在 Amazon Score/SR 65.9/25%，eBay 62.3/21%。人类在 Amazon/eBay 的 SR 为 65%/40%，但每回合约 815 秒，模型少于 8 秒。

## Ablations and robustness

choice oracle、top-1 search、图像观察、搜索轨迹、sim-to-real 和不同方法。

## Limitations

购物目标和属性可结构化，奖励不能覆盖开放式质量；模拟网页动作类型有限；人类基线是小规模众包；真实网页存在安全和页面变化问题。

## Rho relevance

说明实用任务、连续奖励和真实环境迁移可以同时设计。Rho 可借鉴 Score/SR 的软硬结果区分，但共享工作状态的价值不能由单一 task success 代替。

## Interpretive note

WebShop 的核心设计是把真实目标转换成可自动评分的约束。它为 Rho 的科学评估提供“结果可判定性”和“过程成本”两个分开维度。

## Locators

- PDF §§3.1-3.3 pp.3-5; §5 pp.7-10; Tables 1-5; Appendix E
- Source PDF: `../../../../yaoshunyu-phd/papers/02-WebShop-2207.01206.pdf`
