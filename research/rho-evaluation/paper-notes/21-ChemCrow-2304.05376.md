---
paper_id: 21-ChemCrow-2304.05376
source_id: 21-ChemCrow-2304.05376.pdf
review_status: reviewed_with_limitations
source_sha256: 28be4990cf5fc5fa50b379684a9d4c31c3a0ad36aeab1759d324ee428b29de16
---

# Augmenting large language models with chemistry tools

## Question

LLM 在化学计算、反应规划和实验安全上缺少精确工具与外部知识，单纯语言生成不可靠。

## Setting and task

- Actor: 化学领域 tool-using agent
- Task: 有机合成规划、药物/材料设计、分子搜索、实验执行和数据分析。
- Environment: 18 个专家设计工具、文献/网络搜索、分子和反应工具、RoboRXN 云实验平台。
- Evaluation unit: 化学 use case、合成任务和 human-AI collaboration episode。

## Method

GPT-4 ReAct-style Thought/Action/Observation 循环，工具调用、验证、修正和人机协作。

## Evaluation design

- Comparator: GPT-4 without ChemCrow、不同工具链和 human/expert assessment。
- Evaluator or ground truth: LLM-based judge、专家化学家评分、实验/合成结果和成功任务检查。
- Metrics: 任务完成、专家/LLM preference、实验产物、RMSE、工具错误和安全检查。

## Results

ChemCrow 在 DEET、三个 organocatalysts 等合成中通过 RoboRXN 成功执行；在人机协作的 chromophore 任务中提出并实验验证了新分子。论文也发现 GPT-4 evaluator 无法可靠区分明显错误的 GPT-4 答案和 ChemCrow。

## Ablations and robustness

工具类别、GPT-4 vs ChemCrow、14 use cases、专家评价、错误处理和安全 workflow。

## Limitations

任务异质且缺少统一 benchmark；工具和实验平台有 owner-specific 条件；LLM judge 可靠性不足；真实实验成本高。

## Rho relevance

说明科学工作需要把 Agent 行动、工具输出、领域验证和人类决策连成一条可追溯记录。Rho 的 scientific quality 层必须由领域 owner 验证。

## Interpretive note

ChemCrow 是 Rho 科学场景定位的重要近邻。它展示了“Agent 产生候选—工具执行—专家确认”的闭环，也暴露自动 judge 不能承担所有科学判断。

## Locators

- PDF §§2-3 pp.2-6; §§5.1-5.3 pp.8-11; Appendices B-G
- Source PDF: `../../../../yaoshunyu-phd/papers/21-ChemCrow-2304.05376.pdf`
