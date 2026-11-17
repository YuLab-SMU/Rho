---
paper_id: 18-HumanEval-2107.03374
source_id: 18-HumanEval-2107.03374.pdf
review_status: reviewed_with_limitations
source_sha256: ebae72ea0e8a5eb2ecbccdb985aec6cc1254a7c4d29e6d4de7866db1e66c4855
---

# Evaluating Large Language Models Trained on Code

## Question

代码模型需要功能正确性 benchmark，BLEU 等表面相似度不能替代执行测试；已有短题可能很快饱和。

## Setting and task

- Actor: 代码生成模型
- Task: 根据 function signature 和 docstring 生成 Python 函数。
- Environment: 164 hand-written HumanEval problems，sandbox 执行生成代码和 unit tests。
- Evaluation unit: 函数题和 completion samples。

## Method

Codex/GPT family 代码微调，采样多个 completion，计算 pass@k；另有 Codex-S 和选择策略。

## Evaluation design

- Comparator: 模型规模、GPT-Neo/GPT-J、TabNine、不同 sampling temperature、mean log-probability selection。
- Evaluator or ground truth: 隐藏 unit tests，functional correctness；严格使用 unbiased pass@k estimator。
- Metrics: pass@1/10/100、BLEU 与 functional correctness 对比。

## Results

Codex-12B pass@1 28.81%、pass@100 72.31%；GPT-J 6B 11.62%/27.74%；BLEU 与功能正确性分布重叠，不能作为可靠替代。

## Ablations and robustness

temperature、k、model size、sampling selection、fine-tuning corpus、BLEU validity。

## Limitations

题目短、合成感较强、容易饱和；pass@k 允许 oracle 从多样本选正确答案；不能评价仓库级、多参与者或研究过程。

## Rho relevance

提供了“结果验证必须由任务真实语义定义”的基准原则。Rho 的图、表和分析结果不能用表面相似度或 Agent 自述代替 domain checks。

## Interpretive note

HumanEval 是饱和与指标设计的警示。Rho 的实验不能只追求一个容易提高的成功率，应选择能区分连续性、理解和科学正确性的指标。

## Locators

- PDF §§2.2-2.3 pp.2-3; §3.3 pp.3-4; Table 1-2; Figure 5-8
- Source PDF: `../../../../yaoshunyu-phd/papers/18-HumanEval-2107.03374.pdf`
