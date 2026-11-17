---
paper_id: 20-ChainOfThought-2201.11903
source_id: 20-ChainOfThought-2201.11903.pdf
review_status: reviewed_with_limitations
source_sha256: 7d9f878c23b460e4566aa4ec9201b1abfb3b8faefb2b1356e411cb90fef72a12
---

# Chain-of-Thought Prompting Elicits Reasoning in Large Language Models

## Question

大模型在多步算术、常识和符号推理上需要中间推理，直接答案会丢失分解过程。

## Setting and task

- Actor: prompted language model
- Task: GSM8K、AQuA、SVAMP、commonsense 和 symbolic reasoning。
- Environment: few-shot prompt，示例包含自然语言 chain of thought；主要是静态问题。
- Evaluation unit: 问题 instance。

## Method

在示例中提供逐步 reasoning，再要求模型生成 rationale 和 answer。

## Evaluation design

- Comparator: standard few-shot、zero-shot、self-consistency、不同模型规模。
- Evaluator or ground truth: 数据集答案 exact match，另有错误类别和人工检查。
- Metrics: accuracy、self-consistency vote、错误类型。

## Results

CoT 在足够大模型上显著提升 GSM8K 和多类推理任务，且 self-consistency 进一步提升；能力依赖模型规模。

## Ablations and robustness

模型大小、prompt exemplars、self-consistency samples、OOD/robustness 和 rationale 错误分析。

## Limitations

纯内部推理可能幻觉，只有静态问题，rationale 正确不保证答案正确；成本随 samples 增长。

## Rho relevance

CoT 提供工作步骤外显的先例，但 Rho 要把文字推理与真实行动、文件版本和结果验证分开。

## Interpretive note

CoT 的贡献是让中间推理可观察，不是让推理成为可靠证据。Rho 的记录应保留 reasoning 作为解释材料，同时要求结果和资源状态独立核验。

## Locators

- PDF §§2-6 pp.2-9; Figures 1-2; Appendix B/G
- Source PDF: `../../../../yaoshunyu-phd/papers/20-ChainOfThought-2201.11903.pdf`
