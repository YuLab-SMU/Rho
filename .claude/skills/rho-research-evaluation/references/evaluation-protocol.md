# Evaluation protocol

Use this reference when converting a positioning claim into an experiment.

## Three evidence layers

### System behavior

Measure whether the system preserves and exposes shared work state under the selected conditions. Candidate measures include task-path completion, continuity across sessions or participants, retained identity, provenance completeness, recovery success, failed-action visibility and time or turns to recover. A measure belongs here only when the system can record it directly.

### Researcher use

Measure whether people who did not build the episode can follow the work. Record task completion, explanation of what changed and why, mistaken beliefs about current state, help requests, recovery effort and points where a participant stops. Use the actual target researchers and state the task scope. A builder's successful walkthrough is an engineering observation.

### Scientific work quality

Measure the result with the domain's own checks. Candidate measures include reproducibility of a specified analysis, agreement with a predeclared reference under the same data and assumptions, completeness of input and output provenance, and validity checks chosen by the domain owner. Rho's display or continuity cannot supply these checks.

## Two-stage comparison

Use both stages when a claim concerns a mechanism and a practical benefit.

### Stage 1: internal capability comparison

Hold task, project, data, Agent or model and operator conditions constant. Remove or isolate one proposed Rho capability, then compare the recorded system behavior and work trace. Name the exact capability and the failure behavior of the comparison condition.

### Stage 2: native workflow comparison

Hold the research task, data, result checks and participant or Agent capability constant. Compare Rho with the workflow the target user normally uses. For human studies, counterbalance task order when task learning can affect the result. Record the actual setup and any carryover.

## Required protocol fields

Every protocol must state:

- `claim`: the sentence the experiment can support or weaken;
- `mechanism`: why the condition should change the outcome;
- `unit`: participant, Agent run, project, task, result or other unit;
- `population`: who or what is sampled and why;
- `task`: concrete work with an observable completion condition;
- `data_and_resources`: inputs, versions, environment and permissions;
- `conditions`: exact system or workflow configurations;
- `comparator`: the condition that makes the claim testable;
- `measures`: outcome, process, comprehension and failure measures;
- `analysis`: aggregation, comparison and treatment of missing or partial runs;
- `failure_and_recovery`: what counts as a failure and how recovery is recorded;
- `stopping_rule`: when the pilot or run ends;
- `limitations`: what the result cannot establish;
- `evidence_threshold`: the observation required before updating the claim register.

Choose sample sizes, statistical tests and task variants from the literature review and pilot evidence. Record them once selected. The protocol must reject a claim when it has no feasible comparator or no observable outcome.

## Rho-specific candidate tasks

Candidate tasks may include a shared analysis that crosses an Agent session boundary, a result comparison that requires retained provenance, a recoverable failed run, and a literature re-analysis such as the existing single-cell examples. Keep the scientific method in the project or plugin that owns it. The evaluation records the work and its evidence.

## Analysis and reporting

Report the state actually reached. Preserve partial files, unknown outcomes, failed runs and deviations from the protocol. Attribute differences to the condition only when the design supports that interpretation. Keep system, human and scientific conclusions in separate sections of the experiment record.
