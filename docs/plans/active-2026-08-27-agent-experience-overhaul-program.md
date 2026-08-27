# Agent Experience Overhaul Program (AGX)

Status: active program; AGX-1 contract drafted below, implementation NOT yet
authorized (mandatory stop before code — see Package AGX-1)

Date: 2026-08-27
Authorization: the product owner abandoned the bounded surface work package
and ordered a program-level overhaul on 2026-08-27: "是的，放弃所谓的工作
包。我们需要一个非常大的革新". Rounds 1-7 of the surface rebuild
(`63914e1`…`4db8b6b`) stand as shipped increments this program builds on.
Change class: D3 program (shared architecture across broker, transport, and
UI), staged stop points per package
Risk class: per package (AGX-1 is R2 cross-boundary workflow with a new
public event channel; AGX-3 touches a serialized payload contract)

## Vision

The Agent in Rho must feel and work like a first-class agent product, not a
form over a request/response API:

1. **Live**: a turn narrates itself as it happens — streaming activity and
   message growth — and can be interrupted or steered at any moment.
2. **Continuous**: the composer is a work queue, never a gate. The user can
   send follow-ups while the agent runs, reorder or cancel them, and stop
   the current turn without losing the queue.
3. **Reviewable**: file changes are reviewed as real diffs in one place,
   with conversation-scale batch decisions and a truthful undo story.
4. **Calm authority**: permission posture is an explicit, user-visible
   preset (Ask every time / Auto-approve project tools / Full access for
   this conversation), broker-enforced per action; individual approvals
   interrupt only when the posture requires it, and then as the compact
   strip, never a wall.

## Why Now (evidence)

- Owner review of the surface rebuild: presentation rounds were "换汤不换
  药"; the request is redesign "不只是外表的", then "放弃所谓的工作包".
- Reference products (owner-supplied screenshots): ChatGPT agent's live
  narration and Review panel; Alma's composer-first model with popover
  engineering controls.
- Current architecture already supports the spine of this: the broker
  spawns a task per turn and appends immutable turn events to the store
  (`desktop/src-tauri/src/commands/agent_execution.rs:525,447`); the app
  already has Tauri emit/listen infrastructure (`rho://…` topics); the
  surface module is freshly decomposed into a view-model + regions
  (`desktop/ui/src/app/agent/`) so each package has a clean landing site.

## Design Pillars And Non-negotiables

- Store truth first: the event log in the store remains authoritative;
  every live stream is a replayable projection, never the source of truth.
  UI must survive missed frames by refetching detail (the existing
  invalidated-refresh path stays as the reconciliation lane).
- No new execution authority without an explicit owner decision inside the
  package that introduces it. Approval, cancellation, file mutation, and
  retry keep their broker-checked semantics end to end.
- Bounded payloads everywhere: stream frames, diffs, and queues carry
  byte/shape budgets with truncation metadata, matching existing transport
  discipline.
- Two-project isolation for every new persisted or streamed fact.
- Browser/mock parity in the same package as any new transport surface
  (mock.ts changes ride with their command/channel; AGX packages own
  mock.ts slices explicitly in their lane registrations).

## Packages

### AGX-1 — Live turn events end-to-end (D3, R2) — contract below

Turn lifecycle and activity stream from broker to timeline: the UI watches
a turn run instead of refreshing after the fact.

- Broker: emit `agent://turn-event` Tauri events at every persisted turn
  append (started, activity, message delta, approval requested, terminal),
  carrying turn id, event id, type, bounded payload, and the store event
  ordinal; emission is additive — persistence semantics unchanged.
- Transport: `subscribeAgentTurnEvents(handler)` in the UI transport +
  mock parity with scripted frames.
- View-model: apply frames incrementally (running turn's events append,
  message deltas coalesce) and reconcile with the store on gaps via the
  existing refresh path.
- Timeline: render the live running turn (narration rows grow, answer
  streams in, elapsed runs) with truthful copy for connecting/streaming/
  reconciling states.
- Stop point: this contract is cross-reviewed against the approval,
  cancellation, and recovery contracts before any code (see Mandatory
  stops).

### AGX-2 — Composer work queue and steering (D2/D3, R2)

Send while running: submitted prompts become queued follow-ups attached to
the conversation; the composer never locks. Queue inspect/reorder/cancel;
"stop" cancels the current turn and offers the queue head next; steering a
running turn lands as an interrupt-turn if the broker contract allows, else
as cancel+queued. Requires an owner decision on interrupt semantics before
implementation (new broker behavior if steering is real).

### AGX-3 — True diff review set (D3, R2)

File proposals carry before-content (or a content reference) so the review
surface renders real line diffs with hunks; the review set persists
per-conversation across turns; batch actions gain an honest "Undo all"
where the existing undo contract covers it. Serialized-payload change:
requires fixtures and backward-compatibility rules for proposals recorded
without before-content.

### AGX-4 — Permission posture presets (D2/D3, R3)

Conversation-scoped posture (Ask every time / Auto-approve project tools /
Full access) visible as one composer chip; broker evaluates posture per
action, unchanged per-action approval objects for the escalate case. R3
because it touches approval/policy: negative tests from the threat model,
per-action binding evidence, and no posture inference from UI state alone.

### AGX-5 — Program integration and acceptance

s3/visual-acceptance gates updated to the live model (streaming assertions
replace refresh assertions where applicable), App-level suites re-aligned,
NEWS + version decision at the named candidate, program close-out review.

## Ownership And Lanes

- UI packages land in the `codex/studio-agent-ux` worktree under the
  recorded governance exception (the integration lane owns the current
  agent files while accepting earlier rounds).
- Broker (`desktop/src-tauri`) and store/R-runtime slices register their
  own lanes per package before code; no package starts while its paths are
  owned by another active lane.
- `Cargo.lock`, `Cargo.toml`, `NEWS.md`, version metadata, and the shared
  cross-review/index documents converge only through the integration lane.

## Mandatory Stops

1. AGX-1 contract cross-review (this section) against the approval,
   cancellation, recovery, and payload-bound contracts — before any
   AGX-1 code.
2. AGX-2 interrupt-semantics owner decision — before any AGX-2 code.
3. AGX-3 payload-compatibility review — before any AGX-3 code.
4. AGX-4 threat-model review — before any AGX-4 code.
5. Program close: full affected matrix + visual acceptance + owner review.

## Definition Of Done (program)

All packages implemented and verified at their own gates; the Agent
experience demonstrably streams, queues, reviews diffs, and carries an
explicit posture; program-level acceptance (AGX-5) complete; no unowned or
half-wired state at any integration boundary.
