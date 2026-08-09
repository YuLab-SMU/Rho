# Agent Conversation Concurrency And Resource Scheduling

Status: active; Issue #5 authorized end-to-end, CONV-1 and CONV-2 source
checkpoints accepted 2026-08-09, CONV-3 is not active

Date: 2026-08-09

Authorization: the project owner explicitly requested implementation of GitHub
Issue #5 through the point where the issue can be closed on 2026-08-09

Change class: D3 shared Agent architecture, persistence, scheduling, approval,
and desktop workflow

Risk class: R3 schema migration, execution admission, cancellation, approval,
project switching, recovery, and project-file mutation

Current work package: none; stopped at the accepted CONV-2 source checkpoint
before CONV-3 activation

Mandatory stop: reached after CONV-2 admission, cancellation, approval,
Workspace-read, recovery, Tauri/browser integration, focused and affected
verification, and independent contract review; CONV-3 remains inactive

## Problem And Reproduction

GitHub Issue #5 records a product-level dead end: while one Agent task is
running, global `Working` state disables the composer, so the user cannot start
or use an unrelated Agent conversation without cancelling the first task.

The current implementation is single-flight at several independent layers:

- the desktop command rejects `run_agent` while `agent_tasks` is non-empty;
- the frontend derives one global `agentBusy`, one `activeAgentTurnId`, and one
  global cancel action from every project turn;
- `recent_agent_conversation()` supplies project-wide recent turns to every
  new turn, so unrelated work is not context-isolated;
- pending approval waiters are keyed only by request ID and per-turn cancel
  currently calls `cancel_all()`;
- Task Rail rows represent turns, not durable conversations;
- project-wide history deletion is the only destructive history action.

Removing only the frontend or backend single-flight check would therefore mix
model context, misroute approvals, and allow cancellation of one task to affect
another. The invariant for this stream is:

> Conversation owns conversational context. Turn owns one execution. The Rust
> broker owns bounded concurrency and resource admission. Workspace R remains
> the only live scientific authority, and file mutation remains exact,
> project-contained, revision-aware, and recoverable.

## Goals

- Let a user create and switch to a second Agent conversation while another
  conversation has a running task.
- Persist conversation identity, output, approval association, state, retry
  lineage, and terminal reason by normalized project root.
- Allow bounded parallel Agent R/model work when it does not require an
  exclusive shared resource.
- Isolate cancellation, approval, retry, and deletion to the selected
  conversation or exact turn.
- Serialize Workspace R access truthfully and reject stale mutations.
- Prevent concurrent file proposals from silently overwriting the same file.
- Preserve deterministic restart recovery and project-switch blocking.
- Keep real Tauri commands and browser/mock behavior in lockstep.

## Non-Goals

- A second authoritative Workspace R session.
- Parallel execution inside Ark or concurrent mutation of live R objects.
- Multi-user, remote, cloud, or cross-device conversations.
- Background operation after Rho exits.
- Unrestricted filesystem, shell, package-installation, Git, environment, or
  credential authority.
- Prompt-classified permission or resource ownership.
- Migrating direct UI environment operations into Agent approvals.
- Increasing model-provider credential exposure.

## Authority And Cross-Review

- ADR-003 retains authenticated single-use Agent R transport. Each concurrent
  turn receives its own listener, token, child process, and credential scope.
- The active roadmap retains Workspace R as the single authority for live
  objects and project execution. This stream adds Agent R processes, never a
  second Workspace R.
- The implemented Agent handoff retains Ask/Plan/Act policy, exact tool
  approval, revisions, event persistence, and restart truth.
- UX4-P2 and the Issue #9 Task Rail specification retain navigation,
  status/mode/risk presentation, keyboard, and accessibility rules. This
  stream changes Task Rail rows from turns to conversations but does not merge
  mode, status, or approval semantics.
- Agent File Editing V1 retains proposal parsing, project containment, stale
  editor anchors, atomic writes, and Undo. This stream adds admission and
  conflict ownership around that existing mutation path.
- AFO-1 retains exact-turn, in-memory Act auto-apply authorization. It never
  transfers to another turn or conversation.
- The environment-operation contract retains its dedicated request table and
  dialog. Direct UI environment operations are not Agent turns and are not
  cancelled by an Agent action.
- BH1 retains normalized project identity and two-project isolation. BH2
  retains broker-owned project switching. BH3 supplies the transactional,
  backup, assertion, and failure-injection migration pattern. BH4 retains
  destructive-history and retention truth.
- Model routing retains one resolved effective route and credential per turn.
  A running turn is unaffected by later settings changes.

No active document authorizes competing conversation, scheduler, approval, or
Workspace R state. The active cross-review matrix records this stream as the
sole owner of Agent Conversation identity and multi-turn admission.

## Terminology And Identity

### Conversation

A Conversation is a durable, project-scoped thread visible in Task Rail. It
has a stable opaque `conversation_id`, a bounded title, creation/update times,
and zero or more turns. Conversation is the product term; `R session` remains
reserved for Workspace R or Agent R process identity.

An empty Conversation is allowed so `New conversation` has a durable target
before a prompt is sent. At most one nonterminal Turn may belong to a given
Conversation. Starting a second turn in that Conversation while one is
running or waiting is rejected at the broker even if the UI is stale.

### Turn

A Turn is one immutable prompt/execution attempt with one recorded mode,
effective model, editor context, events, approvals, output, and terminal
result. Retry creates another Turn in the same Conversation; it never mutates
the original Turn.

### Resource lane

A resource lane is broker-owned transient admission state, not a user-visible
conversation and not a second durable source of project truth. V1 lanes are:

- `model`: bounded concurrent Agent R/model work;
- `workspace`: fair, cancellation-safe exclusive access to Workspace R request
  dispatch;
- `file:<normalized-project-relative-path>`: exclusive apply/undo admission
  for one project file.

## Persistence Contract

Schema v12 adds:

```sql
CREATE TABLE agent_conversations (
  conversation_id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL CHECK (project_root <> ''),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  legacy_unthreaded INTEGER NOT NULL DEFAULT 0
    CHECK (legacy_unthreaded IN (0, 1))
);

CREATE TABLE agent_conversation_turns (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  retry_of_turn_id TEXT,
  terminal_reason TEXT,
  FOREIGN KEY(turn_id) REFERENCES agent_turns(turn_id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id) REFERENCES agent_conversations(conversation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY(retry_of_turn_id) REFERENCES agent_turns(turn_id)
    ON DELETE SET NULL
);
```

Required indexes cover `(project_root, updated_at DESC)` and
`(conversation_id, turn_id)`. Every current-schema Agent turn has exactly one
mapping row. The mapping table is an additive compatibility bridge that avoids
rebuilding `agent_turns` and its approval/event/environment foreign-key graph.
It is authoritative for Conversation ownership.

Conversation creation and first-turn creation are transactions. A first Turn
may replace only the exact default `New conversation` title with its bounded
prompt preview. Later turns never silently rename the Conversation.

### Historical migration

The v11-to-v12 migration creates one synthetic, visibly labelled
`Legacy project history` Conversation for each distinct project root that has
Agent turns, maps those turns in their existing order, and sets
`legacy_unthreaded = 1`. This records only the provable historical fact that
the old implementation supplied project-wide history; it does not infer
separate historical threads. Legacy history is viewable and deletable but not
continuable. A new prompt always uses a new non-legacy Conversation.

The migration uses a same-directory pre-migration backup, one transaction,
copy-count and one-to-one mapping assertions, foreign-key checks, injected
failure rollback, and idempotent reopen. Unsupported or malformed historical
data fails closed without advancing schema version.

### Status and terminal reason

Existing durable Turn statuses remain `running`, `waiting`, `completed`,
`failed`, and `interrupted`. `terminal_reason` distinguishes at least
`user_cancelled`, `desktop_shutdown`, `desktop_restart`, `agent_failure`, and
`resource_stale`. The UI presents `Cancelled` only for
`status=interrupted, terminal_reason=user_cancelled`; other interruption
reasons remain `Interrupted`.

Conversation status is derived, never independently persisted:

1. a nonterminal turn: `running` or `waiting`;
2. otherwise the latest turn terminal status/reason;
3. no turns: `empty`.

## Command And Store Contract

New project-scoped commands:

- `list_agent_conversations(limit)` returns bounded Conversation summaries;
- `create_agent_conversation()` creates and returns one empty Conversation;
- `delete_agent_conversation(conversation_id)` transactionally deletes only
  one inactive Conversation and its turns/events/approvals;
- `retry_agent_turn(turn_id)` starts a new Turn in the same non-legacy
  Conversation using the immutable original prompt, mode, and editor context,
  with the currently resolved compatible model route recorded as effective;
- `list_agent_turns(conversation_id, limit)` lists only the selected thread.

`run_agent` accepts `conversation_id`. Omission creates a new Conversation for
compatibility. A supplied ID must be a non-legacy, non-archived Conversation
owned by the normalized active project and must have no nonterminal Turn.

Every detail, approval, retry, delete, context-history, and cancellation lookup
validates both active project and durable Conversation/Turn ownership at the
store boundary. Frontend filtering is not authorization.

Limits:

- at most 100 returned conversations and 100 returned turns per request;
- Conversation title at most 240 Unicode scalar values after trimming;
- model context at most four prior completed/failed turns from the exact
  Conversation, retaining existing text bounds and redaction;
- no prompt, model response, source, approval argument, or credential is added
  to diagnostics beyond existing bounded records.

## Concurrency And Scheduling Contract

### Model admission

- At most two Agent Turns may be nonterminal across the active project.
- Admission is atomic under the task registry lock and rejects duplicate or
  same-Conversation starts with a stable error code/message.
- Each accepted turn gets an independent Agent R process, transport token,
  child handle, credential override, event stream, and cancellation token.
- A failed spawn or registration releases capacity and durably finishes only
  that turn.

### Workspace R

- Workspace R remains one Ark session.
- Model-only work proceeds concurrently.
- Every Agent tool request that touches Workspace R enters one fair exclusive
  broker lane. Waiting for this lane is cancellable and visible as a bounded
  `resource.waiting` event.
- Authorization and revision checks are repeated after the lane is acquired;
  approval granted against a stale revision is rejected and the Agent must
  refresh/replan.
- Cancellation while queued performs no Workspace operation. Cancellation
  after dispatch uses the existing Workspace run cancellation/interrupt
  contract; completion truth follows the recorded run.

### Files

- Proposal generation remains read-only and may occur concurrently.
- Accept/auto-apply/Undo acquires an exclusive lane for the normalized
  project-relative path.
- Before mutation, the existing editor anchors plus an exact before-content
  digest are revalidated after lane acquisition.
- Different files may be applied independently. Two proposals for the same
  file never overwrite silently: the later proposal either observes the exact
  expected content and proceeds or becomes `resource_stale` with a visible
  regenerate/review action.
- Path lanes are released on success, rejection, failure, cancellation, and
  panic/unwind. They do not survive process restart; durable content/revision
  checks remain the recovery authority.

Direct environment operations remain in their own broker-owned lane and their
own request table/dialog. This stream does not reuse `approval_requests` for
them.

## Approval And Cancellation Isolation

Pending Agent approval waiters are stored as request ID plus owning turn ID.
The registry provides `cancel_turn(turn_id, reason)` in addition to the
shutdown-only `cancel_all(reason)`. Cancelling one turn:

- removes and aborts only that turn's task/process;
- cancels only approval waiters owned by that turn;
- interrupts only durable approvals for that turn;
- releases only that turn's queued resource claims;
- records `interrupted/user_cancelled` only for that turn;
- emits a turn-scoped update event.

Application shutdown and Workspace restart may use explicit global
reconciliation, but they must record truthful terminal reasons for every
affected turn. Direct UI environment-operation waiters are never cancelled by
an Agent-turn action.

## Project Switching And Recovery

- Project switching remains blocked while any Turn is running/waiting, any
  Agent approval is waiting, or an Agent-owned Workspace/file mutation is in
  flight. The blocker reports the total and one representative opaque ID.
- Switching never migrates a running Conversation to another project.
- Startup marks all historically nonterminal Turns interrupted with
  `desktop_restart`, interrupts their waiting approvals, and derives the
  affected Conversation states from those durable Turn records.
- Completed conversations and selected outputs remain available after Agent R
  or desktop restart.
- A crash after an external mutation but before final persistence must not be
  reported as a clean failure. Existing run/revision/file truth is reconciled
  and the UI reports uncertainty or stale state explicitly.

## User Experience Contract

### Task Rail

- Task Rail rows represent Conversations and the header reads
  `Conversations (N)`.
- Each row contains one aggregate status dot, the latest Turn's neutral mode
  icon when present, a one-line title, and accessible status/mode text.
- Selection uses `aria-current`; rows remain keyboard focusable and long
  Unicode titles ellipsize without widening the rail.
- `New conversation` remains enabled while other Conversations run once
  parallel admission is active.
- An empty selected Conversation displays a focused composer and no borrowed
  turn, output, approval, or file proposal.

### Conversation detail and actions

- The timeline shows only Turns belonging to the selected Conversation.
- The header reports aggregate counts such as `2 running · 1 waiting approval`
  while per-row state remains authoritative.
- Cancel, Retry, and Delete act on the selected exact Conversation/Turn.
- Delete is unavailable for an active Conversation, requires an explicit
  destructive confirmation, is transactional, and does not clear other
  Conversations.
- Pending approvals and file proposals display only when owned by the selected
  Turn. Another Conversation's pending decision produces a badge/status on its
  Task Rail row, never a fallback decision panel in the selected thread.
- The composer is disabled only when the selected Conversation has a
  nonterminal Turn or the global two-turn bound is reached. Running work in a
  different Conversation alone does not disable it.
- The model/mode selector configures the next Turn. Existing running Turns keep
  their recorded effective model and mode.

Loading, empty, success, waiting, running, failed, cancelled, interrupted,
stale, unavailable, narrow-window, keyboard, and screen-reader labels are
covered in deterministic mock/browser scenarios.

## Work Packages And Stops

### CONV-1: Durable Conversation identity and switching — source checkpoint complete

- schema v12 additive Conversation/mapping tables and migration;
- Conversation store types, transactional create/list/delete primitives, and
  exact-thread context lookup;
- Tauri commands and browser/mock parity for create/list/select;
- Task Rail Conversation projection and selected-thread timeline;
- `run_agent` binds a Turn to the selected Conversation;
- keep the current global one-running-turn admission rule;
- no concurrent execution, retry command, per-turn waiter redesign, or file
  scheduler yet.

Stop after migration/store/Tauri/frontend tests, two-project isolation,
browser review, migration failure/reopen evidence, and contract review.

The mandatory stop was reached on 2026-08-09. Evidence is recorded in
`docs/verification/agent-conversation-concurrency/conv1.md`. That evidence and
Draft PR #11 were reviewed as the CONV-2 entry gate; no unresolved P0/P1
finding remains.

### CONV-2: Bounded read-only parallel Turns — source checkpoint complete

- atomic two-Turn admission across distinct Conversations;
- per-turn process/task/cancellation and approval waiter ownership;
- aggregate header and selected-Conversation composer logic;
- model-only concurrent Ask/Plan and serialized Workspace reads;
- cancellation/restart/project-switch failure coverage.

Do not activate until CONV-1 is accepted at its mandatory stop.

Activation decision: the CONV-1 source checkpoint is accepted. CONV-2 may
change admission, in-memory task/waiter ownership, read-only Workspace
scheduling, and the matching Conversation UI/mock behavior. It must reject
concurrent Act Turns and must not add mutation scheduling, Retry, or
Conversation Delete behavior owned by CONV-3.

The mandatory stop was reached on 2026-08-09. Evidence is recorded in
`docs/verification/agent-conversation-concurrency/conv2.md`. The accepted
boundary permits two Ask/Plan Turns in distinct Conversations, retains
exclusive Act admission, serializes Workspace R requests, and isolates exact
Turn cancellation and approval ownership. CONV-3 remains inactive pending its
separate activation review.

### CONV-3: Mutation scheduling, retry, and deletion — not active

- revision-rechecked Workspace mutation lane;
- per-path file apply/Undo lane and digest conflict handling;
- exact-turn Retry and selected-Conversation Delete;
- Act concurrency only after approval and resource tests pass;
- installed-app workflow covering two concurrent Conversations.

Do not activate until CONV-2 is accepted at its mandatory stop.

## Verification Matrix

### Migration and store

- empty v12 bootstrap;
- v7, v8, v9, v10, and v11 upgrade fixtures;
- one synthetic legacy history per project and one mapping per legacy Turn;
- no cross-project mapping, duplicate mapping, or unprovable continuation;
- injected failure retains old schema/version and backup; reopen succeeds;
- foreign keys, indexes, copy counts, idempotent current-schema reopen;
- projects A and B with identical Conversation titles and Turn prompts remain
  isolated for list/detail/context/delete/retry.

### Admission, approval, and recovery

- two different Conversations run concurrently; a third is rejected;
- a second nonterminal Turn in one Conversation is rejected;
- two model-only turns finish without context/event/output mixing;
- one spawn/provider/process failure leaves the other running;
- cancel A does not cancel B, B's approval, or direct environment operation;
- cancel while waiting for Workspace/file lane performs no mutation;
- shutdown/restart reconciles each nonterminal Turn exactly once;
- project switch reports all active blocker classes without cross-project data.

### Workspace and file conflicts

- independent read requests are serialized without losing either response;
- approval becomes stale while queued and cannot mutate Workspace R;
- two same-file proposals result in one exact apply and one stale/conflict;
- different-file proposals can apply independently;
- create-existing, edit-missing, changed editor version/digest, command failure,
  cancellation, Undo-after-change, and project switch fail truthfully;
- Act auto-apply authority remains exact-turn and never crosses Conversation.

### UI and mock

- zero, one, many, legacy, long Unicode, running, waiting, failed, cancelled,
  and unavailable Conversation rows;
- switching preserves selected output, activity, approval, and proposal;
- New Conversation works while another model-only Turn runs;
- only the selected active Turn can be cancelled;
- Retry creates a linked Turn without rewriting history;
- Delete rejects active state and removes only the confirmed Conversation;
- exact desktop and narrow viewport, keyboard order/focus restoration,
  accessible mode/status names, overflow, and browser/Tauri command parity.

Required completion evidence includes focused store/server/desktop tests,
complete Rust workspace tests, both R package suites, every affected frontend
contract, JavaScript syntax, formatting, release metadata, `git diff --check`,
deterministic browser review, independent R3 safety/contract review, and a
representative installed macOS application workflow.

## Version, NEWS, Release, And Issue Closure

CONV-1 changes durable behavior and UI but is not independently distributable;
application version and NEWS are deferred to the single reviewed integration
candidate after CONV-3. Schema v12 must never be shipped under the already
published immutable `0.4.0-dev.24` identity.

No R package version change is expected unless implementation demonstrates a
required exported `rho.agent` or `rho.bridge` contract change. Agent R process
parallelism alone is desktop/broker behavior.

Issue #5 may close only when:

1. CONV-1 through CONV-3 are implemented and contract-reviewed;
2. every issue expectation and acceptance item has direct automated and
   installed-app evidence;
3. schema/recovery, approval/cancel isolation, Workspace/file conflict, and
   two-project tests pass;
4. application version metadata and NEWS are synchronized;
5. exact source is committed, pushed, and integrated into upstream `main`;
6. required CI checks pass;
7. an Issue comment links the exact commit/PR, tests, and installed evidence;
8. the GitHub Issue is then closed as completed.

Passing only CONV-1 or CONV-2 is progress and must not close the Issue.
