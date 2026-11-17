# Rho evaluation map

状态：draft。每个空白项都要由论文深读或真实实验填充。

| Evidence layer | Question | Current evidence | Missing evidence | Next comparison |
| --- | --- | --- | --- | --- |
| System behavior | Rho 是否保留共享工作状态并支持跨会话继续？ | 现有 continuity、graph、review 和 literature reproduction episodes | 相同任务下的机制消融与重复运行 | Rho capability present vs selected capability absent |
| Researcher use | 没有构建 Rho 的研究者能否理解发生了什么并继续任务？ | 当前没有独立研究者观察 | 完成、误解、求助、恢复和解释质量 | Rho vs native workflow with counterbalanced tasks |
| Scientific work quality | 共享状态是否改善分析可复现性、证据完整性或结果检查？ | 五篇复现记录保留了运行事实和不一致结果 | 领域拥有者定义的结果质量比较 | Rho vs native workflow under the same domain checks |

## Stage 1 internal capability comparison

- Claim IDs: `rho-candidate-001`, `rho-candidate-003`
- Unit: one complete project task or Agent run, to be fixed after corpus review
- Candidate task: cross-session continuation with a changed analysis result and linked evidence
- Main outcomes: continuity, retained identity, provenance completeness, recovery success and partial-state visibility
- Open design choices: capability removal, repetition count, model control and stopping rule

## Stage 2 native workflow comparison

- Claim IDs: `rho-candidate-001`, `rho-candidate-002`
- Unit: researcher task or matched Agent run, to be fixed after corpus review
- Candidate task: a literature re-analysis or result comparison that spans code, table, figure and notes
- Main outcomes: task completion, understanding of what changed and why, recovery effort and domain-owned result checks
- Open design choices: participant population, native tool baseline, counterbalancing, sample size and statistical analysis

## Evidence rule

A system pass updates the system behavior layer. It does not update researcher use or scientific work quality until those layers have their own observations.
