# Phase 1 internal capability comparison

## Identity

- `protocol_id`: rho-internal-capability-v1
- `claim_ids`: `rho-candidate-001`, `rho-candidate-002`, `rho-candidate-005`
- `status`: pilot-ready after selecting the exact capability to withhold

## Claim and mechanism

- `claim`: Explicit shared work-state continuity reduces reconstruction and recovery work after a long-running task crosses a session or participant boundary.
- `mechanism`: Stable resource/version identities, recorded actions, linked results, decisions and uncertainty provide the next participant with a usable continuation state.

## Unit and population

- `unit`: one complete handoff-and-recovery project task
- `population`: repeated Agent runs with a fixed Agent/model configuration and disposable projects
- `task`: a literature re-analysis continuation and a partial/failing result-repair task
- `data_and_resources`: fixed project snapshot, input data, packages, R/Python versions, Agent permissions, selected Rho source and task prompt

## Conditions and comparison

- `Rho-full`: current composition with shared work-state records available
- `Rho-ablation`: the same project, data, Agent/model and task with one selected shared-state capability withheld or replayed as a raw-resource condition
- `failure`: one of lost acknowledgement/unknown outcome, concurrent edit, partial output or session boundary
- `carryover_controls`: fresh disposable project, same task seed, same model route, same package versions and one injected event per run

## Measures and analysis

- `primary`: continuation success, current-version identification, change-rationale accuracy, provenance completeness, recovery success
- `process`: time to first correct continuation, reconstruction actions, turns/cells/tool calls, failed attempts, help requests and mismatches
- `scientific`: domain-owned result check and reproducibility of the declared analysis
- `analysis`: task-level condition comparison, preserving all partial and unknown endpoints. Do not count clicks or repeated observations as independent samples.

## Failure and recovery

Record the injected event, the last acknowledged state, every recovery attempt, the state reached, partial artifacts and the reviewer decision. A missing acknowledgement does not authorize a new execution identity.

## Completion

- `stopping_rule`: pilot covers both task families and both conditions, with a reviewed failure record for every injected event
- `evidence_threshold`: the mechanism claim can move from proposed only when the primary outcome direction repeats across both task families and is not explained by one run or a model limit
- `limitations`: system behavior does not establish researcher usability, scientific correctness or general benefit
- `source_locators`: `paper-matrix.csv`, `docs/STATUS.md`, `docs/LITERATURE-REPRO-EPISODE.md`, `evaluation-map.md`
