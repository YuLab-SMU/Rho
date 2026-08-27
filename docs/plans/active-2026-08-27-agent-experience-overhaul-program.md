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

## Owner Decisions

- 2026-08-27, steering semantics: NO interrupt/steering of a running turn
  ("打断啥，不打断"). AGX-1's event vocabulary therefore contains no
  steer/inject types — started, activity, message delta, approval
  requested, terminal. AGX-2 becomes a plain sequential composer queue:
  submissions while a turn runs are queued and dispatched in order as
  turns reach terminal states; cancelling the current turn never consumes
  the queue.

## AGX-1 Contract Cross-review (mandatory stop 1 — resolved 2026-08-27)

Reviewed the AGX-1 contract against the overlapping contracts:

- Approval (`implemented-2026-07-16-wp4-approval-agent-continuation-ux-design.md`
  and the approval lanes in the broker): AGX-1 emits read-only projections
  of persisted facts; approval request/response flow, binding, and single-use
  semantics are untouched. A live "approval requested" frame is exactly the
  persisted approval event the detail view already renders; responses still
  travel the existing invoke path.
- Cancellation/recovery: cancel stays an invoke; the terminal frame is a
  projection of the persisted terminal event. Missed frames reconcile via
  the existing invalidated-refresh; crash/reopen re-reads the store, so no
  recovery semantics change.
- Payload bounds: frames carry bounded body/code (4 KiB per text field
  with a truncation flag; full payloads remain fetchable via
  `getAgentTurnDetail`). This matches the bounded-transport discipline and
  is testable with boundary payloads.
- Project isolation: frames carry project_root and are filtered against
  the active project in the UI; the store remains the isolation authority.
  Two-project coverage is part of the AGX-1 test matrix.
- Public protocol: the new `agent://turn-event` channel is additive; no
  existing command, payload, or hook is renamed or removed. The s3 gate's
  DOM contract is unaffected (AGX-5 re-baselines it).

No conflict found. AGX-1 implementation is authorized to start.

Governance exception (extension of the round-4 record, AGX-1): the lane
registry rejected `agx-1-live-turn-events` because
`startup-info-integration` owns the shared transport files (mock.ts,
tauri.ts, types.ts) while accepting earlier rounds. The owner-authorized
AGX program proceeds on the `codex/studio-agent-ux` branch under the same
recorded exception; integration re-pick plus a full acceptance rerun of the
transport and agent slices is the recorded follow-up.

## AGX-1 Implementation And Evidence (2026-08-27)

Implemented end-to-end as contracted:

- Store (`crates/rho-store`): `AgentTurnEventFrame` /
  `AgentTurnUpdateFrame` projections (specta-typed, 4 KiB field bounds with
  `payload_truncated`), a `broadcast` channel on `StoreExecutor`, and
  emissions after durable `append_turn_event` / `finish_turn` succeed — the
  durable row remains the source of truth (verified: a bounded frame still
  leaves the full payload in the store).
- Broker (`desktop/src-tauri`): `commands/agent_events.rs` forwards the
  broadcast to `agent://turn-event` Tauri events, started once from
  `start_agent_turn`; no coordinator or runner logic was touched.
- Transport (`desktop/ui/src/transport`): `agent-events.ts` (frame types +
  `subscribeAgentTurnEvents`), Tauri listen implementation, mock
  subscription plus an `emitAgentTurnEvent` hook and a scripted
  `?agent_live_demo=1` running-turn sequence for preview/review.
- View-model (`desktop/ui/src/app/agent/useAgentSurface.ts`): frames apply
  incrementally (decisions computed synchronously from refs — React
  updaters are not relied on for side-effect decisions), unknown turns,
  event-id gaps, and terminal updates reconcile through the throttled
  store refresh; the durable detail stays canonical.

Evidence:

- `cargo test -p rho-store --lib agent_repository`: 4 of 4 passed,
  including frames-after-durable-writes and bounded-frame/store-truth;
- `cargo check -p rho-desktop` (includes the forwarder);
- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- focused `AgentSurfaceView.test.tsx`: 15 of 15 passed, adding the
  live-frames test (in-order frame applies without refresh, gap frame
  reconciles, terminal frame + canonical refresh lands);
- full UI suite: 52 files, 344 tests passed;
- `npm run rsr:build --prefix desktop`;
- live preview capture under `target/agx1-live/`: the scripted running turn
  renders `Running` with no rows at t0, gains "Read project metadata"
  (t1), "Run summary statistics" (t2), and completes with the final answer
  and no status chip (t3), while the composer shows "Agent running · mm:ss"
  with Stop until completion.

Worktree note: during AGX-1 the owner consolidated this feature worktree;
the branch `codex/studio-agent-ux` preserved every draft as checkpoints
(`5c5de62`, `ecc5ae7`, `86c9d2c`) and the worktree was re-created at the
same path. No work was lost.

Deferred within AGX-1 (recorded, not silent): token-level message deltas
(final messages still arrive as one event when the runtime emits them) and
`finished_at` on frames (canonical value lands via the reconciling
refresh); both are candidates for a follow-up package if the owner wants
token streaming.

## AGX-2 Contract: Composer Work Queue (sequential, no steering)

Owner decision (recorded above): no interrupt of a running turn. The queue
is therefore a plain sequential follow-up queue:

- Submitting while a turn is running or waiting enqueues the prompt
  (prompt + mode, queued-at) instead of blocking or erroring; the composer
  clears immediately and reports the queued position truthfully.
- Queued items render as one quiet row per item directly above the
  composer input: order index, single-line prompt preview, move-up (except
  the head), and cancel. Cancel removes the item without touching the
  broker — the item never started, so no cancellation semantics exist.
- Dispatch: when no turn is running/waiting and the queue is non-empty and
  the runtime is ready, the head item starts as a normal turn through the
  existing `runAgent` path (same request shape as a direct submit; queued
  items carry no runtime-output context — attachments belong to the live
  composer only). Dispatch is single-flight via the existing busy lane.
- Stopping the current turn never consumes the queue: the terminal update
  (live frame or reconciled refresh) triggers the next dispatch.
- Boundary: the queue is UI-session state and is not persisted; a durable
  cross-session broker-side queue is a separate package if the owner wants
  it. No new transport command, no broker change, no new execution
  authority.

Verification: focused tests for enqueue-while-running (runAgent not
called), dispatch-on-terminal through the existing path with unchanged
arguments, cancel-queued without broker calls, move-up reorder, and
stop-then-dispatch; full suite; preview capture showing
enqueue → terminal → dispatch.

## AGX-2 Implementation And Evidence (2026-08-27)

Implemented as contracted (sequential queue, no steering, UI-session state):

- View-model (`desktop/ui/src/app/agent/useAgentSurface.ts`):
  `AgentQueueItem` queue with refs; `submit` enqueues while a turn is
  running/waiting (composer clears immediately); a single-flight dispatch
  effect starts the head item through the existing `runAgent` path with the
  unchanged request shape when no turn is active and the runtime is ready;
  a failed dispatch restores the item and halts until the user changes the
  queue (no silent retry storm); `cancelQueued`/`moveQueuedUp` never touch
  the broker.
- Composer (`AgentComposer.tsx` + `agent-surface.css`): quiet queued rows
  directly above the input — label, single-line prompt, move-up, cancel.
- Mock demo support: `?agent_health=ready` overrides the degraded fixture
  so review runs can submit through the composer (fixture default stays
  degraded).

Evidence:

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- focused `AgentSurfaceView.test.tsx`: 16 of 16 passed, adding the queue
  test (enqueue while running without runAgent, move-up reorder,
  cancel-queued without broker calls, dispatch-on-terminal through
  runAgent with unchanged arguments, queue drains);
- full UI suite: 52 files, 345 tests passed;
- `npm run rsr:build --prefix desktop`;
- preview capture under `target/agx2-queue/`: submitting while the
  scripted live turn runs shows the "Queued · prompt · ×" row (composer
  already cleared); after the live turn completes, the queued item starts
  as a normal completed turn and the queue empties.

## AGX-3 Contract: True Diff Review (payload-compatibility review — resolved)

Mandatory stop 3 reviewed and resolved WITHOUT a serialized change:

- The proposal payload (`rho.file_edit_proposal`) is unchanged; no
  migration, no fixtures for new fields, no R-side filesystem authority.
  Adding before-content to the payload was rejected: it would give the
  model-facing R adapter new read authority and would freeze the diff
  against proposal-time content anyway.
- The review surface instead computes the diff against the CURRENT file
  content — the honest "what would change if applied now" — through the
  existing confined Resource read lane (`loadResources` → `resolveResource`
  → `readResource` with `shared_document` consistency, the exact call shape
  the apply path uses). The component already holds the full
  `UiKernelTransport`, so no new command, prop, or broker surface is added.
- Fallbacks (truthful copy, never silent): resource unavailable or not
  ready → "Current content unavailable; showing the proposed content";
  `create` operations → all-lines-added diff without a read; legacy
  proposals behave identically because the before-content is read live, not
  stored.
- Bounds: diff rendering is line-based with hunk context (±3 lines); files
  larger than the diff budget (2,000 lines before+after) fall back to the
  raw proposed-content view with the reason stated.
- No new dependency: the line diff is a compact in-repo implementation with
  focused unit tests.

## AGX-3 Implementation And Evidence (2026-08-27)

Implemented as contracted (no serialized change, no new authority):

- `desktop/ui/src/app/agent/diff.ts`: compact LCS line diff with ±3-line
  hunks and the 2,000-total-line budget (over budget the caller falls back
  with the reason shown); no new dependency.
- View-model: `loadProposalDiff` fetches current content lazily through the
  existing confined Resource lane (`loadResources` → `resolveResource` →
  `readResource`/`shared_document`, the apply path's exact call shape),
  cached per proposal key with loading/ready/unavailable states.
- Review surface: each proposal row keeps the plain proposed-content view
  until its disclosure opens (DOM text contract preserved), then swaps to
  the hunk view — summary counts, `@@` headers, sign-led add/remove lines
  with tint support. Append/create compute the after-state; selection-based
  operations fall back to the proposed content with the reason stated;
  unreadable files fall back the same way.
- Mock/demo: the existing mock resource lane serves `analysis.R`, so the
  review surface renders a real two-context-line plus two-add-line diff
  with no fixture changes.

Evidence:

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- `agent/diff.test.ts`: 7 of 7 (all-add, all-remove, context, split/merge
  hunks, trailing-newline, budget);
- focused `AgentSurfaceView.test.tsx`: 17 of 17, adding the resource-lane
  diff test (context lines from current content, proposal lines as adds);
- full UI suite: 52 files, 353 tests passed, including the integration
  lane's broker-path proposal test via the preserved pre-open text
  contract;
- `npm run rsr:build --prefix desktop`;
- preview capture under `target/agx3-diff/`: timeline entry only, then the
  open Diff disclosure shows `+2 −0`, `@@ -1 +1 @@`, two context lines, and
  two sign-led add lines.
