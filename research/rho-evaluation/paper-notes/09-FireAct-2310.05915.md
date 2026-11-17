---
paper_id: 09-FireAct-2310.05915
source_id: 09-FireAct-2310.05915.pdf
review_status: reviewed_with_limitations
source_sha256: f25210a50e197285f404c5a17e437fa93c21f3ab6a9db8687985b6d8613a773f
---

# FireAct: Toward Language Agent Fine-tuning

## Question

多数 language agent 依赖 few-shot prompting，模型参数没有针对 agent 轨迹进行训练。

## Setting and task

- Actor: 搜索增强问答 language agent
- Task: HotpotQA、FEVER、StrategyQA 和其他 QA 任务中的 ReAct 推理与工具使用。
- Environment: Google Search API 或检索环境，轨迹包含 Thought-Action-Observation。
- Evaluation unit: QA question 和 agent trajectory。

## Method

用 GPT-4 生成多任务、多方法 ReAct 轨迹，微调小模型；比较单任务/单方法、多任务/多方法组合。

## Evaluation design

- Comparator: prompt-only、single-task/single-method fine-tuning、不同模型和 LoRA/full fine-tuning。
- Evaluator or ground truth: QA exact match、F1 或 task-specific answer metrics，另有效率和 robustness。
- Metrics: EM/F1、相对提升、推理成本、跨任务泛化和噪声鲁棒性。

## Results

论文报告 Llama2-7B 在 500 条 GPT-4 轨迹微调后 HotpotQA 提升约 77%；多任务、多方法轨迹通常优于单一方法，数据多样性重要。

## Ablations and robustness

轨迹数量、任务数、方法数、模型大小、LoRA/full、噪声和跨任务泛化。

## Limitations

轨迹生成成本高；性能受示范轨迹质量影响；QA exact match 对开放研究工作不够充分；不测试长期人类接续。

## Rho relevance

它把 agent 行为轨迹当作可复用的程序记忆。Rho 需要评估“记录能否帮助下一次工作”，同时检查记录是否把一次性错误固化。

## Interpretive note

FireAct 与 Reflexion 的差别支持 Rho 的状态分层：技能可沉淀为程序规则，具体项目经历应保留为情景记录。

## Locators

- PDF §§3-8 pp.3-10; Tables 1-4; Appendices A-B
- Source PDF: `../../../../yaoshunyu-phd/papers/09-FireAct-2310.05915.pdf`
