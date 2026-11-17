---
paper_id: 03-InterCode-2306.14898
source_id: 03-InterCode-2306.14898.pdf
review_status: reviewed_with_limitations
source_sha256: 0555a3f6b3598cf5e38925e7201544cc1b151f54efa17bc800f9a5f834e9ab2c
---

# InterCode: Standardizing and Benchmarking Interactive Coding with Execution Feedback

## Question

静态代码生成忽略了编程中的运行、观察报错和修正。不同数据集缺少统一的交互执行协议和灵活奖励。

## Setting and task

- Actor: 交互式代码 agent
- Task: 在 Bash、SQL、Python 执行环境中通过多轮代码动作解决自然语言任务。
- Environment: Docker 沙箱；Bash 200、SQL 1034、Python 117 个任务；Bash 有四套 file system。
- Evaluation unit: 任务 episode。

## Method

用 Docker、数据集 query/gold 字段和可插拔 reward function 把静态数据集包装成 POMDP；比较 single turn、Try Again、ReAct、Plan & Solve。

## Evaluation design

- Comparator: 单轮生成、不同 prompting strategy、不同模型和文件系统。
- Evaluator or ground truth: Bash 用输出相似度、文件路径变化和 md5；SQL 用输出 IoU、Kendall tau；Python 继承 MBPP unit tests。
- Metrics: Success Rate，Error %，Turns；连续 reward 记录执行结果和状态变化。

## Results

GPT-3.5 在 SQL 上 Try Again 47.3%、ReAct 58.7%、Plan & Solve 49.1%；Bash 分别 46.5%、20.5%、28.0%。GPT-4 SQL single turn 9.1%，Try Again 73.7%。多轮反馈明显提升，但后期出现重复动作和上下文利用失败。

## Ablations and robustness

single/multi-turn、schema 提供与否、file system、prompting strategy、不同 reward 和 robustness standard errors。

## Limitations

环境数量有限；CTF 任务只有少量人工整理；自动 reward 仍主要适合代码结果，不能评价架构可维护性或研究解释。

## Rho relevance

为 Rho 的连续性实验提供了“同一任务跨多轮、观察反馈、纠正错误”的基本单位，也提醒要记录错误率、轮数和恢复路径。

## Interpretive note

InterCode 的关键不是某个模型分数，而是把交互轨迹和执行反馈变成评估对象。Rho 的 handoff 任务需要保留这种轨迹级证据，但增加参与者和资源版本维度。

## Locators

- PDF §§3.1-3.3 pp.3-5; §5 pp.7-9; Tables 1-4; Appendix A.3/B.2
- Source PDF: `../../../../yaoshunyu-phd/papers/03-InterCode-2306.14898.pdf`
