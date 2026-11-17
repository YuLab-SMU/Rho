# Phase 1 internal capability comparison

## Identity

- `protocol_id`: rho-internal-capability-v0
- `claim_ids`: `rho-candidate-001`, `rho-candidate-003`
- `status`: draft

## Claim and mechanism

- `claim`: The shared work-state capability changes the continuity and recovery of a long-running project task.
- `mechanism`: Explicit state, identity and provenance give the next participant or session enough information to continue from the recorded state.

## Unit and population

- `unit`: one complete project task or Agent run
- `population`: disposable Rho projects and a fixed Agent/model configuration
- `task`: a cross-session task that changes an analysis and links the changed result to the prior question
- `data_and_resources`: one versioned project, fixed input data, fixed Rho source and recorded environment

## Conditions and comparison

- `conditions`: Rho with the selected shared-state capability; comparison condition defined after the literature review
- `comparator`: a reproducible condition that removes or isolates the selected capability
- `carryover_controls`: fresh disposable project, same task order, same input data and same Agent configuration

## Measures and analysis

- `measures`: continuity of task identity, retained resources, provenance completeness, recovery success, partial-result preservation, turns and elapsed time
- `analysis`: compare predeclared outcome and process measures by run, preserving all failures and unknown outcomes
- `missing_or_partial_runs`: retain partial outputs and mark the unknown endpoint
- `failure_and_recovery`: inject the failure supported by the selected claim and record the exact recovery path

## Completion

- `stopping_rule`: pilot ends after the corpus review selects the task, comparator and run count
- `evidence_threshold`: update the claim only when the result is reproduced under the declared conditions
- `limitations`: system behavior does not establish human usability or scientific validity
- `source_locators`: `docs/STATUS.md`, `docs/LITERATURE-REPRO-EPISODE.md`, paper matrix after deep read
