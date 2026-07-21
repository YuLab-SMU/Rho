# WP4 Approval And Agent Continuation UX Design

Date: 2026-07-16
Status: Approved design baseline
Scope: `docs/plans/0.2x-agent-handoff.md` WP4

## Goal

WP4 makes Act mode reviewable instead of implicitly trusted. Agent-initiated
mutation must pass through an explicit broker-owned approval state machine that
survives Agent restarts and keeps Workspace R unchanged until approval is
granted.

The design must preserve these constraints:

- Workspace R remains the only authority for scientific execution and live
  objects.
- Agent R remains distinct from Workspace R and must not become a second
  scientific workspace.
- Rust broker remains the authority for approvals, revisions, persistence,
  continuation, and recovery behavior.
- `rho-store` remains the only event database.
- Ask and Plan remain read-only by broker policy, not only by prompt wording.
- Act may propose mutation, but mutation executes only after explicit approval.

## Non-Goals

WP4 does not add:

- unrestricted shell access;
- MCP child processes;
- autonomous package installation;
- a second event database;
- broad debugger features;
- remote execution infrastructure.

## High-Level Architecture

WP4 upgrades Agent execution from prompt-level trust to a broker-owned approval
contract. The authoritative flow becomes:

1. the frontend starts an Agent turn with prompt, mode, and expected workspace;
2. Rust broker creates a durable Agent turn record;
3. Agent tool intentions are normalized by broker policy;
4. mutation requests in Act mode become durable approval requests before any
   workspace execution occurs;
5. the frontend renders exact tool/code and current approval state from durable
   records;
6. after explicit user response, broker either continues execution or returns a
   continuation outcome to Agent R.

The UI no longer treats approval as transient timeline decoration. Approval
requests, approval decisions, rejection, stale revision, and continuation all
become durable records that survive Agent-side failure or restart.

Persistence remains single-store. `events` remains the append-only audit stream.
WP4 adds queryable approval and Agent-turn summaries on top of `rho-store`,
such as `agent_turns` and `approval_requests`, or equivalent projection tables.
These are query layers, not a second event system.

Mode policy must be enforced by broker code:

- `ask`: read-only, never executes `run_r`;
- `plan`: read-only plus proposal, never executes mutation before
  confirmation;
- `act`: may request mutation, but broker pauses at approval before execution.

Completed Agent history must survive Agent R restart independently of Workspace
R lifecycle. Agent timeline is therefore durable system history, not ephemeral
chat memory.

## Component Breakdown

### `ApprovalStore`

This extends `rho-store` to persist:

- Agent turns;
- approval requests;
- approval responses;
- continuation outcomes.

At minimum it must support querying:

- `turn_id`
- `mode`
- `request_id`
- `tool`
- exact tool arguments and exact code
- workspace revision snapshot at request time
- approval decision
- approval/request status
- continuation outcome
- execution result summary

### `AgentTurnCoordinator`

This lives in the broker-side Agent message loop. It receives and normalizes:

- `tool.approval_required`
- `tool.call_started`
- `tool.call_completed`
- `tool.call_failed`
- `chat.message_completed`

It assembles these into a durable turn lifecycle rather than forwarding them as
temporary UI events only.

### `ApprovalPolicy`

This is the hard policy layer for Ask/Plan/Act. It decides, per tool request:

- allow immediately;
- deny by policy;
- pause and create approval request.

This ensures Ask/Plan read-only behavior is broker enforced rather than left to
model compliance.

### `ContinuationManager`

This handles continuation after:

- approval granted;
- approval rejected;
- stale revision or replan requirement;
- tool failure.

Continuation must itself be durable and visible in timeline history.

### `AgentHistory API`

This is the narrow desktop-facing broker API. It should expose at least:

- `list_agent_turns`
- `list_approval_requests`
- `respond_approval`
- `get_agent_turn_detail`

The frontend should not reconstruct durable approval history by replaying raw
event blobs itself.

### `AgentTimelineViewModel`

This is the frontend state layer. It introduces:

- `agentTurns`
- `pendingApprovals`
- `selectedTurn`
- `approvalDetail`

Timeline rendering and approval surfaces should project from this state.

### `ApprovalPanel`

This is the frontend interaction surface for Act mode approval. It must show:

- exact tool name;
- exact code or arguments;
- request id;
- revision snapshot;
- approve, reject, and cancel controls.

Its purpose is to let the user review what will actually enter Workspace R,
rather than merely confirming that “something” is about to run.

## Data Flow

### Agent Turn Start

When the user submits an Agent prompt, the frontend sends:

- `prompt`
- `mode`
- current workspace identity

Rust broker immediately creates a durable Agent turn record in `running`
state. Timeline rendering is then driven from durable turn state rather than
transient process memory.

### Read-Only Tool Calls

When Agent R emits a read-only tool call, broker evaluates it through
`ApprovalPolicy`.

- If the tool is allowed in the current mode, broker records tool call start
  and completion in the turn history and continues.
- If Ask or Plan attempts `run_r`, broker records a policy-denied outcome and
  blocks execution.

### Approval Request Creation

When Act mode emits `run_r`, broker does not execute immediately. It creates an
approval request that records:

- `request_id`
- `turn_id`
- `tool`
- exact arguments
- exact code
- expected workspace revision snapshot

The request enters `waiting_for_approval`. Workspace R remains unchanged at
this point.

### User Response

The frontend displays the pending request in the timeline and approval panel.
The user answers through `respond_approval(request_id, decision)`.

Broker then:

- rechecks current workspace revision;
- if still current and approved, marks request `approved` and continues tool
  execution;
- if rejected, marks request `rejected` and sends explicit rejection
  continuation to Agent R;
- if stale, marks request `stale` or `replan_required` and sends explicit
  refresh/replan continuation.

### Tool Execution And Result

After approval, broker records:

- tool call start;
- tool call completion or failure;
- duration;
- success/error;
- revision transition.

These records remain attached to the same turn and approval request.

### Recovery

If Agent R restarts or the desktop restarts, durable Agent turn history and
approval requests remain queryable. Pending approval requests remain pending
until explicitly answered or marked interrupted by recovery logic. Completed
turns remain visible after Agent-side failure or restart.

## Error Handling And Failure Behavior

### Mode Policy Violation

If Ask or Plan attempts `run_r`, broker must produce a hard policy denial and
persist it with reason such as `mode_policy_denied`. This must be visible in the
turn history.

### Approval Boundary

Once an approval request exists, Workspace R must remain unchanged until a
durable approval response is recorded. Frontend failure or Agent R failure must
not cause request execution to leak through.

### Stale Revision

If approval is granted after the expected revision has changed, broker must not
execute the old code. Instead it marks the request stale or replan-required and
returns explicit continuation to Agent R.

### Rejection Continuation

When the user rejects a request, broker records the rejection with request id
and reason, then returns a durable `approval_rejected` continuation outcome.
Agent R must not be left to guess what happened.

### Persistence Failure

If approval response persistence or final tool-outcome persistence fails, the
system must treat that as a hard failure. WP4 cannot accept ambiguous approval
state where execution may have happened without a trustworthy durable record.

### Recovery State

On Agent restart, desktop restart, or broker recovery:

- completed turns remain visible;
- pending approvals remain pending;
- interrupted tool executions are marked explicitly as interrupted or abandoned.

The system should report where flow stopped rather than pretending it completed.

## Testing Strategy

### Rust State Machine Tests

Add tests for:

- Ask cannot execute `run_r`;
- Plan cannot execute mutation before confirmation;
- Act creates approval request before execution;
- approval executes only after approval response;
- rejection preserves history and blocks execution.

### Revision And Continuation Integration Tests

Add integration tests for:

- stale revision at approval time triggering replan/refresh continuation;
- rejection producing explicit continuation rather than silent failure;
- tool results recording duration, success/error, and revision transitions.

### Persistence And Recovery Tests

Add tests for:

- completed Agent turns remain visible after Agent R restart;
- pending approvals survive restart;
- interrupted turns enter explicit recovery state;
- Workspace R and Agent timeline lifecycles remain decoupled.

### Frontend Behavior Tests

Add targeted tests for:

- timeline shows exact tool/code and request id;
- pending approval surface exposes approve/reject/cancel controls;
- stale revision does not silently execute old code;
- completed tool cards show result and revision transition.

### Manual Acceptance

Manual acceptance must cover the WP4 handoff scenarios:

1. Ask cannot execute `run_r`;
2. Plan cannot execute mutation before confirmation;
3. Act shows exact R code before approval;
4. rejection leaves Workspace R unchanged;
5. stale revision causes refresh/replan rather than silent execution;
6. completed Agent turns remain visible after Agent R restart.

## Implementation Notes

Recommended implementation order:

1. extend `rho-store` with Agent turn and approval summary persistence;
2. enforce Ask/Plan/Act policy in broker-side Agent coordination;
3. add approval request, approval response, and continuation persistence;
4. expose `list_agent_turns`, `list_approval_requests`,
   `respond_approval`, and `get_agent_turn_detail`;
5. replace transient Agent timeline rendering with durable turn-backed
   timeline state;
6. add approval panel and stale/rejection continuation UX.

Preferred implementation touchpoints:

- `crates/rho-store/src/lib.rs`
- `crates/rho-server/src/coordinator.rs`
- `desktop/src-tauri/src/main.rs`
- `r/rho.agent/R/aisdk_adapter.R`
- `desktop/dist/app.js`
- `desktop/dist/index.html`
- `desktop/dist/styles.css`
- targeted tests and updated documentation

## Done Criteria For WP4

WP4 is complete when the desktop prototype can:

1. surface broker-owned approval request and response state in the Agent
   timeline;
2. show approve, reject, and cancel controls with request id and exact
   tool/code;
3. enforce Ask read-only and Plan read-only-plus-proposal at broker level;
4. allow Act mutation only after explicit approval;
5. continue correctly after rejection or stale revision;
6. persist Agent turn history independently from Workspace R lifecycle;
7. show tool results with code, duration, success/error, and revision
   transition;
8. keep Workspace R unchanged until an approved Act request is executed.
