# Rho evaluation map

状态：literature-informed protocol draft。文献深读已经完成，实验仍需先做一次真实 pilot 再锁定最终样本量和时间上限。

## Literature-to-Rho mapping

| Pattern in the corpus | Rho design consequence |
| --- | --- |
| Executable task checks make benchmark scores reproducible | Every scientific task needs a domain-owned result check and a declared resource version |
| Trajectory, turn and query metrics expose process failure | Record reconstruction steps, handoff actions, recovery attempts, turns and elapsed time |
| Human or expert evaluation is needed for open-ended quality | Ask participants to explain what changed and why, and use independent rubric assessment |
| Offline and online performance differ | Separate recorded/replay evidence from live browser or Notebook behavior |
| Ablations isolate the mechanism before a practical comparison | Stage 1 removes one shared-state capability, Stage 2 compares Rho with native workflow |

## Three evidence layers

| Layer | Main question | Primary outcome | Current state |
| --- | --- | --- | --- |
| System behavior | Does Rho preserve and expose shared work state across a handoff or failure? | continuation correctness, resource/version identity, provenance completeness, recovery success | bounded episodes exist, no controlled ablation |
| Researcher use | Can a researcher who did not build the episode understand and continue it? | task completion, correct explanation, mistaken beliefs, help requests, recovery effort | unobserved |
| Scientific work quality | Does the resulting analysis pass domain checks with complete evidence? | result correctness/reproducibility, artifact integrity, input-output provenance | five re-analysis episodes exist, no native-workflow comparison |

## Stage 1: internal capability comparison

- **Protocol ID** `rho-internal-capability-v1`
- **Claim IDs** `rho-candidate-001`, `rho-candidate-002`, `rho-candidate-005`
- **Purpose** isolate the shared work-state mechanism before claiming practical benefit.
- **Primary unit** one complete handoff-and-recovery task run. The analysis unit is the task run, not each click, tool call or cell.
- **Task family** two disposable research projects. One is a literature re-analysis continuation with a changed result table/figure. The other is a failed or partial run that requires identifying the last trusted state and repairing the next step.
- **Condition Rho-full** the current Rho composition with project notes, resource identities, captured actions, results, versions and linked decisions available.
- **Condition Rho-ablation** the same project, data, Agent/model version and task instructions with the selected shared-state capability withheld or replayed as a raw-resource condition. The removed capability must be named before the run.
- **Injected events** lost acknowledgement or unknown outcome, concurrent file edit before save, partial result output, and session/participant boundary. Use one event per run and preserve all partial artifacts.
- **Primary measures** continuation success, correct current-version identification, correct explanation of what changed and why, provenance completeness and recovery success.
- **Process measures** time to first correct continuation action, reconstruction actions, turns/cells/tool calls, failed attempts, help requests and resource/version mismatches.
- **Scientific measures** domain-owned output checks and reproducibility of the declared analysis, reported separately from system outcomes.
- **Analysis** compare condition-level task outcomes and task-level distributions. Treat the project task as the unit. Preserve unknown and partial endpoints. Do not count multiple observations from one run as independent samples.
- **Pilot gate** run both conditions on both task families, inspect failure causes, then set the confirmatory run count and time cap. Advance only when the capability removal is observable and the task remains scientifically valid in both conditions.
- **Evidence threshold** update the mechanism claim only when the direction of the primary outcome is reproduced across both task families and is not driven by a single failure or model turn limit.

## Stage 2: native workflow comparison

- **Protocol ID** `rho-native-workflow-v1`
- **Claim IDs** `rho-candidate-001`, `rho-candidate-003`, `rho-candidate-004`
- **Purpose** test whether Rho improves continuation and understanding for researchers who did not build it.
- **Participants** researchers with the domain skills required by the selected analysis, recruited outside the Rho implementation team. Record prior R/Python, Notebook and Agent experience.
- **Design** within-participant comparison with two matched research tasks and counterbalanced condition order. The same input data, software versions, result checks and task goals are used in both conditions.
- **Rho condition** the Rho project with the declared composition and the same Agent/model permissions.
- **Native condition** the participant's ordinary terminal/editor/Notebook workflow with equivalent files and data. Record the actual tools and versions rather than imposing a synthetic baseline.
- **Task family** one result-comparison task that spans code, table, figure and notes, plus one recovery task with a declared failure and partial output.
- **Primary measures** completion, answer accuracy about current state and change rationale, correct continuation action, recovery success and provenance completeness.
- **Secondary measures** time, interaction count, assistance, mistaken beliefs, participant explanation, perceived workload and domain-owned result checks.
- **Evaluation** use a task rubric with independent scoring for explanation and scientific result. Keep participant self-report, observer coding and system records as separate sources.
- **Analysis** compare paired participant-task outcomes. Report participant and task denominators, condition order, missing runs and carryover. Use a paired non-parametric or permutation analysis selected after the pilot and report effect estimates with uncertainty.
- **Stopping rule** the pilot ends after every participant completes or abandons both matched tasks, the failure and recovery records are preserved, and the research team has reviewed whether the native condition is feasible and fair.
- **Evidence threshold** update researcher-use claims only from direct participant observations. Update scientific-quality claims only when the domain owner confirms the result checks independently of Rho's presentation.

## Required reporting

Each run records task identity, condition, model and tool versions, input data, resource versions, actions, partial results, failures, recovery, final state, reviewer decisions and unresolved uncertainty. Report system, researcher and scientific conclusions in separate sections.
