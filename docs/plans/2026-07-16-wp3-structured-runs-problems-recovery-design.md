# WP3 Structured Runs, Problems And Recovery Design

Date: 2026-07-16
Status: Approved design baseline
Scope: `docs/plans/0.2x-agent-handoff.md` WP3

## Goal

WP3 upgrades the current prototype from transient execution output to durable,
recoverable, auditable run records. Each user, agent, or system execution must
produce a structured run lifecycle that survives broker restarts and can drive
Runs, Problems, Console, and later provenance surfaces.

The design must preserve these constraints:

- Workspace R remains the only authority for execution and live objects.
- Agent R remains separate from Workspace R and must not become a second
  scientific workspace.
- Rust broker remains the authority for Ark transport, revision checks,
  approvals, persistence, and recovery behavior.
- `rho-store` remains the only event database. WP3 must not introduce a second
  event store.
- Problems must derive from structured execution results, not terminal-text
  scraping.

## Non-Goals

WP3 does not add:

- a second event database;
- terminal-output parsing as the source of truth for errors;
- broad debugger support;
- unrestricted shell access;
- full agent approval UX from WP4;
- cloud or remote execution infrastructure.

## High-Level Architecture

WP3 makes run records the center of the execution model. The authoritative flow
becomes:

1. the frontend issues an execution intent;
2. Rust broker creates or advances a durable run;
3. `rho-store` persists run state transitions plus append-only events;
4. the frontend renders Runs, Problems, Console, and later provenance surfaces
   from structured run data.

The UI no longer treats execution as ad hoc DOM side effects. Console text,
Problems, and plot output become projections of durable run state rather than
the only surviving trace of what happened.

`rho-store` remains the single persistent backing store. Its append-only
`events` stream remains the audit trail. Its `runs` data becomes a queryable
execution summary layer. If problem records need their own projection, they may
be added as a narrow derived table or an equivalent query model, but not as a
second event system.

Run state is made explicit:

- `queued`
- `running`
- `waiting`
- `completed`
- `failed`
- `cancelled`
- `interrupted`
- `crashed`

This separation matters. A user cancellation, a bounded interrupt, and a
process crash are operationally different outcomes and must not collapse into a
single vague failure bucket.

Run truth is broker-owned. Runs may originate from `user`, `agent`, or
`system`, but only Rust broker code may create run IDs, advance run states, and
write durable summaries.

The frontend adds a run domain model that becomes the source for:

- Runs panel;
- Problems panel;
- execution-related Console entries;
- recovery state.

## Component Breakdown

### `RunStore`

This is the `rho-store` extension layer. It owns durable run creation, status
transitions, query APIs, and recovery marking. At minimum each run must record:

- `run_id`
- `origin`
- `status`
- `started_at`
- `finished_at`
- `terminal_reason`
- `source_path`
- `execution_mode`
- `document_version`
- workspace identity snapshot

It remains UI-agnostic.

### `ExecutionCoordinator`

This lives around `dispatch_workspace_request()` and normalizes all user,
agent, and system executions into one run lifecycle. It is responsible for:

- entering `queued`;
- entering `running`;
- entering `waiting` when a workflow blocks on recovery or future explicit user
  action;
- finishing in a terminal state;
- projecting bridge results into durable run summaries and append-only events.

This is the main orchestration layer of WP3.

### `ProblemProjector`

This component derives structured problem records from structured execution
results. It is responsible for producing:

- `message`
- `call`
- `traceback`
- `source_path`
- `execution_id`
- workspace identity
- action metadata for `Retry`, `Explain`, and `Open Source`

It must only consume structured execution results. It must not infer problems
from plain Console text.

### `RecoveryManager`

This component handles:

- broker startup recovery;
- incomplete-run interruption/crash marking;
- Workspace R restart detection;
- user-visible recovery state;
- future Agent R restart integration without changing the Workspace R contract.

It is responsible for telling the truth after interruptions rather than hiding
or erasing incomplete work.

### `RunRepository API`

This is the narrow Tauri-facing query layer for the frontend. It must provide
at least:

- `list_runs`
- `list_problems`
- `get_run_detail`
- `retry_run`
- `cancel_run`

The frontend does not read SQLite directly and does not reconstruct run history
from raw event blobs on its own.

### `RunViewModel`

This is the frontend state layer. It adds:

- `runs`
- `runById`
- `activeRunId`
- `recoveryState`
- `problemIndex`

It becomes the source of truth for execution history on the UI side.

### `RunRenderer`

This is the frontend projection layer. It replaces static run placeholders and
transient problem rendering with views derived from durable run data. Console
rendering also becomes run-aware rather than a pure append-only text sink.

## Data Flow

### Execution Start

When the user, Console, or Agent issues code, the frontend packages one
execution intent:

- `origin`
- `code`
- `sourcePath`
- `executionMode`
- `documentVersion`
- current workspace identity

Rust broker receives it and immediately creates a `queued` run in `RunStore`.
Run IDs therefore exist from the beginning of the lifecycle, not only after the
execution result arrives.

### Execution Active Phase

When broker begins the Workspace R request, the run enters `running`. During
execution, stdout, warnings, messages, display data, and structured errors are
recorded in two synchronized ways:

- append-only event records in `events`;
- summarized run projections in the run summary layer.

`events` remain the fine-grained audit trail. The run summary remains the
queryable user-facing view.

### Successful Completion

If execution finishes without structured error, the run enters `completed`.
Revision-after data and any output summary are persisted with the run.

### Failed Completion

If the bridge returns a structured error, the run enters `failed`.
`ProblemProjector` creates problem records bound to the run and its
`execution_id`. Problems are therefore not “latest error text”; they are
execution-linked records.

### Cancellation

The frontend does not issue a naked global interrupt as its primary action.
Instead, it asks broker to `cancel_run` for a specific active run.

Cancellation is two-step:

1. attempt cooperative cancel;
2. if needed, issue bounded Ark interrupt.

The final state becomes `cancelled` or `interrupted` depending on outcome and
Workspace R survivability.

### Startup Recovery

On desktop startup or broker reconstruction, `RecoveryManager` first scans for
non-terminal runs and marks them as `interrupted` or `crashed` as appropriate.
The frontend then restores recent runs and problem summaries and enters an
explicit recovery state when necessary.

### Retry

Retry never mutates an old run. It creates a new run with a `parentRunId` link
to the original record. The original run remains unchanged and auditable.

## Error Handling And Failure Behavior

### RunStore Failure

Run persistence failure must be treated according to severity:

- if auxiliary summary or problem projection fails, the current run must still
  become a terminal failure with an explicit incomplete-record indication;
- if run creation or final-state persistence fails, the execution must be
  treated as a hard failure because the audit chain is broken.

WP3 must not silently succeed when no trustworthy record exists.

### Workspace And Broker Failure

Workspace crash, Ark disconnect, and broker reconstruction must not collapse
into the same vague UI message. Recovery state should distinguish:

- user-requested restart;
- execution interrupted by broker restart;
- execution lost because the workspace crashed.

### Cancel Failure

`cancel_run` uses a bounded two-phase strategy:

1. cooperative cancel with a short explicit timeout;
2. bounded interrupt if needed.

If Workspace R survives and returns to idle, the run may enter `cancelled` or
`interrupted`. If the workspace dies during the cancel path, the system must
enter crash recovery rather than claiming cancellation succeeded.

### Problem Projection Guard

Only structured bridge-returned error data may become a problem record.
Warnings, messages, and arbitrary printed text must never be guessed into a
problem item.

### Retry Failure

Retry failure never overwrites the original run. Any retry attempt that fails
creates or attempts to create its own linked run. History remains append-only.

### Frontend Degradation

The frontend must degrade by surface, not by total collapse:

- if runs load but problems fail, Runs still render and Problems display a
  partial-unavailable state;
- if summaries load but run detail fails, detail view alone may degrade;
- one broken projection must not blank the whole workbench.

## Testing Strategy

### Rust Storage And Transition Tests

Add tests for:

- legal run creation and status transitions;
- recovery marking of incomplete runs on broker startup;
- retry creating a new linked run rather than mutating the old one;
- distinction between cancelled and interrupted terminal states.

### Coordinator Integration Tests

Add integration tests for:

- user, agent, and system executions all producing durable runs;
- structured execution errors producing problem records;
- whole-file execution metadata flowing into the run summary;
- follow-up execution succeeding after interrupt;
- recovery behavior after workspace restart or broker reconstruction.

### Frontend State Tests

Add targeted tests for:

- Runs panel restoration from durable summaries;
- Problems bound to specific runs;
- Retry creating a new visible linked run;
- recovery state visibility after restart;
- no regression in WP1/WP2 project/session/editor flows.

### Manual Acceptance

Manual acceptance must cover the WP3 handoff scenarios:

1. trigger an R error and verify it appears as a Problems record, not only as
   Console text;
2. run Retry and verify a new linked run appears while the original remains
   unchanged;
3. cancel an execution and confirm Workspace R returns to idle and accepts a
   follow-up expression;
4. simulate broker restart and verify incomplete runs become interrupted;
5. restart the Agent path without losing Workspace R objects and prior run
   records.

### Regression Boundaries

Regression verification must explicitly confirm:

- no second event database is introduced;
- no problem record depends on text scraping from Console output;
- WP1 project/session behavior still works;
- WP2 editor execution entry points still work with run-backed rendering.

## Implementation Notes

Recommended implementation order:

1. extend `rho-store` run schema and query APIs;
2. normalize run lifecycle in `dispatch_workspace_request()`;
3. connect startup recovery into the desktop startup path;
4. project structured problems and expose run/problem query commands;
5. replace frontend placeholder Runs/Problems rendering with run-backed state;
6. add retry and cancel wiring on top of the durable run model.

Preferred implementation touchpoints:

- `crates/rho-store/src/lib.rs`
- `crates/rho-server/src/coordinator.rs`
- `desktop/src-tauri/src/main.rs`
- `r/rho.bridge/R/execute.R`
- `desktop/dist/app.js`
- `desktop/dist/index.html`
- targeted tests and updated documentation

## Done Criteria For WP3

WP3 is complete when the desktop prototype can:

1. persist user, agent, and system executions as durable run records;
2. represent `queued`, `running`, `waiting`, `completed`, `failed`,
   `cancelled`, `interrupted`, and `crashed` as explicit run states;
3. show structured Problems records with execution linkage and provenance;
4. retry a failed run by creating a new linked run;
5. cancel an active run with bounded interrupt semantics;
6. mark incomplete runs after broker restart and surface recovery state to the
   user;
7. preserve Workspace R authority while allowing Agent-facing history to remain
   visible across Agent-side failure or restart;
8. keep WP1/WP2 project, editor, and execution workflows intact.
