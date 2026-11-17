# Phase 2 native workflow comparison

## Identity

- `protocol_id`: rho-native-workflow-v1
- `claim_ids`: `rho-candidate-001`, `rho-candidate-003`, `rho-candidate-004`
- `status`: pilot-ready after the phase-1 task review

## Claim and mechanism

- `claim`: Rho helps a researcher who did not build it understand and continue a long-running research task compared with the native workflow used for the same task.
- `mechanism`: Explicit work-state and provenance records reduce the effort required to reconstruct purpose, current version, changed resources, results and next actions.

## Unit and population

- `unit`: participant-task pair
- `population`: researchers with the domain skills required by the selected analysis, recruited outside the Rho implementation team
- `task`: one result-comparison task spanning code, table, figure and notes, and one declared failure-recovery task
- `data_and_resources`: same input data, software versions, project snapshot, result checks and task goals in both conditions

## Conditions and comparison

- `Rho`: the declared Rho composition and the same Agent/model permissions
- `Native`: the participant's ordinary terminal, editor or Notebook workflow with equivalent files and data
- `design`: within-participant, counterbalanced condition order using matched tasks
- `carryover_controls`: fresh project state, record prior exposure and keep task order balanced

## Measures and analysis

- `primary`: completion, current-state explanation, change-rationale accuracy, correct continuation action, recovery success and provenance completeness
- `secondary`: time, interaction count, assistance, mistaken beliefs, participant explanation, perceived workload and domain-owned result checks
- `evaluators`: system record, observer coding, independent rubric scorer and domain owner remain separate sources
- `analysis`: participant and task denominators, paired condition differences, missing/abandoned runs, order effects and uncertainty. Select the paired non-parametric or permutation analysis after the pilot.

## Failure and recovery

Use a failure that both conditions can expose and classify. Preserve the last valid state, every recovery action, the final state, partial output and the participant's explanation of what happened.

## Completion

- `stopping_rule`: pilot ends after every participant completes or abandons both matched tasks and the research team confirms that the native condition is feasible and fair
- `evidence_threshold`: update researcher-use claims only from direct participant observations; update scientific-quality claims only after independent domain checks
- `limitations`: the participant group, task domain, model route and local workflow define the scope of the result
- `source_locators`: `docs/ROADMAP.md`, `docs/DEVELOPMENT.md`, `paper-matrix.csv`, `evaluation-map.md`
