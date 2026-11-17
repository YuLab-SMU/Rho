---
paper_id: 04-SWEbench-2310.06770
source_id: 04-SWEbench-2310.06770.pdf
review_status: reviewed_with_limitations
source_sha256: f7e8e1df64129742b8199a21a042734519a823a1dafd6f48f8f3ddcfb48ee296
---

# SWE-bench: Can Language Models Resolve Real-World GitHub Issues?

## Question

HumanEval 一类短函数题容易饱和，不能体现真实软件工程的仓库规模、问题定位和多文件修改。

## Setting and task

- Actor: 仓库级代码修复 agent
- Task: 读取真实 GitHub issue 和完整仓库，生成能解决问题并通过测试的 patch。
- Environment: 12 个热门 Python 仓库，约 90k PR 候选过滤为 2,294 个任务；平均非测试代码 438k 行。
- Evaluation unit: GitHub issue/task instance。

## Method

以真实 PR 构造任务，采用 BM25 或 oracle retrieval 提供上下文，生成 patch 后运行测试。

## Evaluation design

- Comparator: 不同模型、BM25 context 长度、oracle retrieval、SWE-bench Lite 和 oracle-collapsed context。
- Evaluator or ground truth: patch 能否应用，fail-to-pass 和 pass-to-pass 测试是否通过。
- Metrics: % Resolved、% Apply、BM25 recall、fail-to-pass 和总测试状态。

## Results

BM25 下 Claude 2 最好约 1.96% resolved，GPT-4 约 1.31%；oracle retrieval 下 Claude 2 约 4.8%。任务平均改 1.7 个文件、3 个函数、32.8 行，约 40% 有至少两个 fail-to-pass 测试。

## Ablations and robustness

retrieval context 长度、oracle vs BM25、oracle-collapsed 只保留改动附近代码、不同仓库和 Lite 子集。

## Limitations

只覆盖 Python；主实验不含人类受试者；测试通过仍不能完全证明需求满足、代码质量或维护性。

## Rho relevance

提供真实长程工作、可持续更新 benchmark 和执行证据的范例。Rho 需要把“解决结果”与“为什么改变、由谁改变、下一步如何继续”分开测量。

## Interpretive note

SWE-bench 的价值来自真实工程 provenance 和 fail-to-pass 测试。它仍把任务主体放在单个 Agent 和仓库状态，尚未测量跨参与者工作状态的理解。

## Locators

- PDF §§2.1-2.4 pp.2-4; §§4-5 pp.5-7; Tables 1-6; Appendix A.4/A.7
- Source PDF: `../../../../yaoshunyu-phd/papers/04-SWEbench-2310.06770.pdf`
