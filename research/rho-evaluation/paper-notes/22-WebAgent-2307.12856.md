---
paper_id: 22-WebAgent-2307.12856
source_id: 22-WebAgent-2307.12856.pdf
review_status: reviewed_with_limitations
source_sha256: 23b1129aa8b95ee0555d27fb5a5711717c482451b31dd1c4df64ad8cc2267d1a
---

# A Real-World WebAgent with Planning, Long Context Understanding, and Program Synthesis

## Question

真实网页自动化需要长程规划、HTML 理解和可执行程序生成，单个通用 LLM open-loop 计划会累积错误。

## Setting and task

- Actor: 真实网页 automation agent
- Task: 在房地产、社交媒体和地图网站完成自然语言多步指令。
- Environment: 真实网站、HTML-T5 planning/summarization、Flan-U-PaLM grounded program synthesis；20 条评测指令。
- Evaluation unit: 网页任务 episode。

## Method

self-experience supervision 训练 HTML-T5，把任务分解、HTML 总结和程序合成模块化。

## Evaluation design

- Comparator: single Flan-U-PaLM、只 planning、只 summarization、regex summarization 和不同 HTML-T5。
- Evaluator or ground truth: 任务属性覆盖 score 和 100% 属性满足的 success；真实网站由人监督，另在 Mind2Web/MiniWoB++ 离线验证。
- Metrics: success rate、attribute score、element accuracy、operation F1、step success。

## Results

WebAgent 在 real-estate/social-media/map success 65%/70%/80%，score 87.6/85.8/93.8%；Mind2Web 上 HTML-T5 跨任务/网站/领域优于基线；真实评测失败常由长程 planning 导致。

## Ablations and robustness

HTML-T5 architecture、HTML denoising、self-experience、planning/summarization/program synthesis 模块、网站和任务泛化。

## Limitations

真实评测成本高，需要人工监督；模块化增加延迟；长程 planning 仍是主要失败点；网站变化和安全风险。

## Rho relevance

提供了实际环境、多阶段工作和线上人工监督的评估模板。Rho 可以把“继续工作”当作长程任务的一部分，而不是只记录最终网页 success。

## Interpretive note

WebAgent 的 online task success 与模块化过程指标结合，适合借鉴到 Rho 的 system layer。它没有评价任务交给下一个研究者后的理解成本。

## Locators

- PDF §§3-5 pp.3-9; Tables 1-4; Appendix A/G
- Source PDF: `../../../../yaoshunyu-phd/papers/22-WebAgent-2307.12856.pdf`
