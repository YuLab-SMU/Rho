# Runtime Output, Console, History, And Agent Context Closed-Loop Contract

Status: active incomplete; explicitly authorized by the project owner on
2026-08-24; implementation, independent source review, and the complete current
local automated matrix pass; earlier exact-debug v15 reopen/startup evidence
exists, while the current merged-build owner interaction workflow and Windows
Rust matrix remain open

Date: 2026-08-24

Authorization: the whole contract is authorized as one continuous program,
not as independently accepted backend, frontend, Agent, migration, or release
phases. Implemented user-visible behavior and the affected local verification
now exist, so synchronized application metadata and `NEWS.md` use
`0.4.1-dev.15`; this is a development source identity, not packaging or release
authority.

Concurrency boundary at activation: a separately running owner-authorized
sidebar/icon/CSS visual construction occupies `desktop/ui/src/app/App.tsx`,
Navigator/toolbar/menu components, `desktop/ui/src/styles/`, generated
`desktop/dist/` assets, and screenshot evidence. This contract must not edit,
reformat, delete, regenerate, or stage those paths while that construction is
active. Store/Runtime/Agent work proceeds only in non-overlapping files; each
later frontend edit requires a fresh worktree/hash collision check and merges
against the completed visual result rather than replacing it.

Change class: D3 shared Runtime, Store, IPC, Console, History, Agent-context,
retention, and migration architecture

Risk: R3 because this contract adds project-owned schema, changes execution
transport and restart recovery, and controls which project data may enter a
model Provider request

Delivery model: one continuously executed, non-releasable work package with one
final acceptance gate. There are no separately accepted product phases, no
partial feature handoffs, and no declaration that schema, streaming, Console,
History, or Agent context is complete until the entire contract passes.

## 1. Product Decision And Completion Rule

The owner rejected a sequence of small visible patches followed by separately
deferred architecture. This contract therefore closes the whole loop:

```text
Runtime admission
  -> durable execution identity
  -> ordered output capture
  -> live delivery with replay
  -> focused Console projection
  -> durable History review
  -> explicit Agent context reference
  -> capacity-aware Provider context
  -> auditable context receipt
  -> retention/restart/project-switch recovery
```

The implementation may use continuous buildable commits and automated safety
checkpoints. Those are rollback controls, not product phases. After one explicit
authorization, work continues through every obligation without asking the owner
to approve backend, frontend, Agent, migration, or test layers separately. A
safety failure pauses only long enough to repair the same contract. A product
scope or authority change still requires review under development governance.

The package has only two terminal states:

- **accepted complete**: every automated gate, exact-debug workflow, contract
  review, version/NEWS decision, migration/reopen check, and owner interaction
  workflow passes;
- **active incomplete**: any required element is absent or failed. Partial code
  may exist, but it is not described as a completed capability or released.

## 2. Problem And Current Evidence

Current execution output crosses incompatible ownership boundaries:

- `runtime_execute` buffers all events and returns one monolithic
  `RuntimeExecutionResultV1`, bounded to 2 MiB and 2,048 events;
- Workspace R additionally serializes a complete structured result through an
  8 MiB temporary JSON frame;
- Console previously copied those events into a generic 64 KiB Surface
  `view_state`; WP16-R2 correctly removed that copy but now keeps only a bounded
  session transcript;
- Workspace R Runs persist final stdout/value/messages/warnings/error, while
  auxiliary Runtime output has no durable execution record;
- History, Console, raw kernel events, Plot/Artifact records, and Agent tool
  results expose related data through different bounded projections;
- Agent context uses one conservative character ceiling and four exact prior
  turns, but has no model-capacity contract, user-visible context plan, durable
  receipt, or exact output-reference workflow.

The defect is not that bounds exist. Memory, IPC, model windows, and disk capture
must be bounded. The defect is using a presentation or transport bound as an
execution-result boundary and then losing the ability to replay, inspect, or
explain what was omitted.

### Engineering precedents reviewed

AnySearch and current upstream documentation were used to check that the
contract follows production patterns rather than merely raising local limits:

- Tauri 2 explicitly recommends [`ipc::Channel` for ordered, high-throughput
  delivery](https://v2.tauri.app/develop/calling-frontend/) instead of treating
  the global event bus as a bulk stream. The journal remains the durable owner;
  the Channel is only a live projection.
- VS Code gives persistent terminals separate
  [attach, detach, revive and replay operations](https://github.com/microsoft/vscode/blob/03e0f5ddfb3b387ba074581690838f7b07e272a4/src/vs/workbench/contrib/terminal/common/remote/terminal.ts#L49-L89).
  Rho adopts the same separation between execution lifetime and renderer
  lifetime without turning the Console into a shell terminal.
- Jupyter's messaging guidance says reconnecting clients retain session
  identity and discusses
  [out-of-order output handling](https://jupyter-client.readthedocs.io/en/stable/messaging.html).
  Rho therefore makes execution identity, sequence, deduplication, gap repair
  and terminal reconciliation explicit contract fields.
- Established Agent memory implementations use a
  [token-constrained recent-message buffer](https://reference.langchain.com/python/langchain-classic/memory/token_buffer/ConversationTokenBufferMemory)
  instead of unbounded transcript copies. Rho goes further by binding the
  budget to declared model capacity, preserving the current request, requiring
  explicit project-data references, and recording an auditable inclusion
  receipt.

These sources are engineering precedents, not new product authorities. Rho's
Store, Runtime, Run, Conversation, retention and privacy contracts below remain
normative.

## 3. Goals

- Stream ordered output without buffering the whole execution in a Tauri
  response or Surface state.
- Persist a project-scoped, replayable output journal for every admitted Runtime
  execution while keeping Workspace R Run outcome authority unchanged.
- Recover Console output after renderer release, frontend reload, application
  restart, and a dropped/duplicated/reordered delivery notification.
- Give Console and History the same typed output source without turning UI text
  into scientific truth.
- Store large text as chunks and rich/binary output as Artifact/Plot references,
  never as repeated base64/JSON copies in frontend state.
- Make output-capture limits configurable and truthful: computation outcome is
  not changed merely because capture or presentation reaches a budget.
- Let users explicitly attach an exact output range, Run, Problem, editor range,
  Artifact, Skill, or plugin source to Agent; do not automatically exfiltrate
  Console or History content.
- Build Provider context from the selected model's declared capacity, count all
  system/tool/request/attachment material, expose the plan before dispatch, and
  persist a metadata-only receipt of what was included or omitted.
- Preserve exact Conversation identity while replacing the fixed four-turn
  prompt limit with capacity-driven recent context plus bounded on-demand reads.
- Complete schema migration, compatibility, retention, mock parity,
  accessibility, failure injection, developer launch, and final acceptance in
  the same continuous program.

## 4. Non-Goals

- No second Workspace R, alternative scientific truth, shell terminal, xterm,
  remote/cloud synchronization, collaboration, or cross-device history.
- No automatic attachment of Console, Run, file, object, credential, private
  prompt, or plugin output to a Provider request.
- No vector database, embedding service, background model summarization, hidden
  model call, or semantic-memory authority.
- No public Workbench Protocol/CLI/MCP change. A later public projection may read
  this store only after its own versioned contract.
- No automatic deletion of durable output. BH4 remains authoritative and
  `auto_prune_enabled` remains false by default.
- No `.app`, installer, signing, publication, updater, or public-release action.
  Release remains a separate D4 decision after this development package.

## 5. Authority And Ownership

| Concern | Sole authority after completion |
| --- | --- |
| Workspace R scientific outcome, revisions, final Run status | existing broker and `runs` record |
| Runtime admission, generation, busy/cancel/restart | Runtime Registry and execution supervisor |
| Ordered display output for every Runtime | new Store-backed Runtime Output Journal |
| Plot/binary/generated-file payload | existing Plot/Artifact authority; journal stores references |
| Console draft and command recall | project-isolated in-memory Console session state |
| Console reading position/filter/start anchor | lightweight Surface view state |
| History execution list/detail | Store query service over execution records, Runs, and output pages |
| Conversation identity and retry lineage | existing Agent Conversation contract |
| Provider context selection and capacity | broker-owned Agent Context Planner |
| Provider credentials and model route | existing Agent model settings/runtime-profile authority |
| Retention, prune, tombstone, delete vocabulary | accepted BH4 contracts |
| Project identity and switching | BH1/BH2 normalized project authority |

The output journal records ordered observable output; it does not reinterpret a
Run as successful or failed. `runs` remains the final scientific result. A
Runtime execution may link to one Run, but a Run is not duplicated into another
outcome table.

## 6. Durable Data Contract

Schema v15 adds four project-owned tables. The fourth is the normalized,
revisioned authority for the configurable capture policy already required by
section 7.4; keeping that policy as an in-memory default would make restart and
project-switch behavior unverifiable. Names may change only before
activation if cross-review finds an existing collision; semantics may not drift
silently.

Activation hardening review on 2026-08-24 added `workspace_id`, durable
`submitted_code`, a nonterminal `collecting` output state, composite project
foreign keys, required producer sequence identity, and typed Plot/Artifact
references before the first schema edit. These close project-isolation,
History/reload, retention-summary, idempotency and truthful-live-state gaps in
the proposal; they do not add a second authority or expand the authorized
scope.

```sql
CREATE TABLE runtime_executions (
  execution_id TEXT NOT NULL,
  project_root TEXT NOT NULL CHECK (project_root <> ''),
  run_id TEXT,
  runtime_provider_id TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  runtime_activation_generation INTEGER NOT NULL CHECK (runtime_activation_generation > 0),
  console_instance_id TEXT NOT NULL,
  workspace_id TEXT,
  source_path TEXT,
  execution_mode TEXT,
  document_version INTEGER,
  submitted_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'admitted', 'running', 'completed', 'failed', 'interrupted'
  )),
  terminal_reason TEXT,
  output_state TEXT NOT NULL CHECK (output_state IN (
    'collecting', 'complete', 'partial', 'unavailable', 'pruned'
  )),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (execution_id, project_root),
  FOREIGN KEY (run_id, project_root)
    REFERENCES runs(run_id, project_root) ON DELETE RESTRICT,
  CHECK (
    (status IN ('admitted', 'running') AND finished_at IS NULL AND output_state IN ('collecting', 'partial')) OR
    (status IN ('completed', 'failed', 'interrupted') AND finished_at IS NOT NULL AND output_state <> 'collecting')
  )
);

CREATE TABLE runtime_output_chunks (
  execution_id TEXT NOT NULL,
  project_root TEXT NOT NULL CHECK (project_root <> ''),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  producer_sequence INTEGER NOT NULL CHECK (producer_sequence >= 0),
  projection_slot INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL,
  presentation_kind TEXT NOT NULL CHECK (presentation_kind IN (
    'stdout', 'value', 'message', 'warning', 'error', 'status', 'display_ref'
  )),
  media_type TEXT,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN (
    'inline_text', 'inline_json', 'record_ref', 'tombstone'
  )),
  text_payload TEXT,
  json_payload TEXT,
  reference_kind TEXT CHECK (
    reference_kind IS NULL OR reference_kind IN ('plot', 'artifact')
  ),
  reference_id TEXT,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, project_root, sequence),
  UNIQUE (execution_id, project_root, producer_sequence, projection_slot),
  FOREIGN KEY (execution_id, project_root)
    REFERENCES runtime_executions(execution_id, project_root) ON DELETE CASCADE,
  CHECK (
    (storage_kind = 'inline_text' AND text_payload IS NOT NULL AND json_payload IS NULL AND reference_kind IS NULL AND reference_id IS NULL) OR
    (storage_kind = 'inline_json' AND text_payload IS NULL AND json_payload IS NOT NULL AND reference_kind IS NULL AND reference_id IS NULL) OR
    (storage_kind = 'record_ref' AND text_payload IS NULL AND json_payload IS NULL AND reference_kind IS NOT NULL AND reference_id IS NOT NULL) OR
    (storage_kind = 'tombstone' AND text_payload IS NULL AND json_payload IS NOT NULL AND reference_kind IS NULL AND reference_id IS NULL)
  )
);

CREATE TABLE agent_turn_context_items (
  context_item_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  project_root TEXT NOT NULL CHECK (project_root <> ''),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_kind TEXT NOT NULL,
  source_id TEXT,
  source_revision TEXT,
  source_sha256 TEXT NOT NULL,
  trust_class TEXT NOT NULL,
  capacity_source TEXT NOT NULL,
  original_bytes INTEGER NOT NULL CHECK (original_bytes >= 0),
  included_bytes INTEGER NOT NULL CHECK (included_bytes >= 0),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'complete', 'projected', 'truncated', 'omitted', 'unavailable', 'rejected'
  )),
  reason_code TEXT,
  UNIQUE (turn_id, ordinal),
  FOREIGN KEY (turn_id, project_root)
    REFERENCES agent_turns(turn_id, project_root) ON DELETE CASCADE,
  CHECK (included_bytes <= original_bytes)
);

CREATE TABLE project_runtime_output_policies (
  project_root TEXT NOT NULL PRIMARY KEY CHECK (project_root <> ''),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  max_runtime_output_bytes_per_execution INTEGER CHECK (
    max_runtime_output_bytes_per_execution IS NULL OR
    max_runtime_output_bytes_per_execution >= 0
  ),
  runtime_output_project_warning_bytes INTEGER CHECK (
    runtime_output_project_warning_bytes IS NULL OR
    runtime_output_project_warning_bytes >= 0
  ),
  max_runtime_execution_rows INTEGER CHECK (
    max_runtime_execution_rows IS NULL OR max_runtime_execution_rows > 0
  ),
  auto_prune_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_prune_enabled = 0),
  updated_at TEXT NOT NULL
);
```

Required indexes cover `(project_root, started_at DESC)`,
`(project_root, console_instance_id, started_at DESC)`, and
`(project_root, execution_id, sequence)`, plus unique parent keys on
`runs(run_id, project_root)` and `agent_turns(turn_id, project_root)` for the
composite foreign keys. `record_ref` inserts validate that the referenced Plot
or Artifact belongs to the same project before commit. Every query validates
normalized project identity at the Store boundary. Frontend filtering is never
authority.

`agent_turn_context_items` stores provenance, bounds, trust and disposition but
does not duplicate source text, prompts, output, files, object values, hidden
policy, or credentials.

## 7. Output Ingress And Persistence Semantics

### 7.1 Execution supervisor

`runtime_execute` is replaced internally by a supervisor-owned start/follow
workflow:

1. `runtime_execution_start(request)` validates project, Runtime generation,
   Console binding/revision, source provenance, and admission; transactionally
   creates `runtime_executions(status='admitted')`; and returns an immutable
   execution identity immediately.
2. A broker-owned execution task changes the row to `running`, owns cancellation
   and Runtime gates, and continues even if the renderer or Channel disconnects.
3. `runtime_output_follow(execution_id, after_sequence, Channel)` performs a
   race-free persisted replay and then follows committed chunks until terminal.
4. `runtime_output_page(execution_id, after_sequence, page_size, byte_limit)`
   provides deterministic recovery, History reads, search, and tests.
5. `runtime_execution_get/list` exposes bounded execution summaries and links
   Workspace executions to their existing Run.

Source cursor advancement occurs only after `runtime_execution_start` admits
the exact request. A later output/store/provider failure never moves it again.

### 7.2 Durable before visible

Output is normalized by one Rust projector. Chunks are appended in a Store
transaction, execution `last_sequence/output_bytes` advances in the same
transaction, and only committed chunks are emitted to a follower. The frontend
never treats an uncommitted Channel message as durable.

The projector uses `(execution_id, producer_sequence, projection_slot)` for
idempotency. Duplicate kernel events, reconnect replay, delayed final results,
and mock reordering cannot create duplicate transcript rows.

Small adjacent stdout/stderr fragments may be coalesced within a bounded 50 ms
or 64 KiB batch before commit. The final transaction flushes every pending
fragment before terminal state. Coalescing cannot cross kind, origin, or
execution boundaries.

### 7.3 Large and rich output

- Inline text is split automatically into chunks no larger than 64 KiB encoded;
  reaching that implementation bound never rejects the Runtime operation.
- Page responses are limited to 200 chunks and 1 MiB encoded. `has_more` and
  `next_sequence` make the omission explicit.
- Plot, image, HTML, and other binary/rich output uses existing Plot/Artifact
  records. Journal chunks carry typed references, media type, digest and
  fallback text, not base64 payload copies.
- Workspace R's result publisher becomes a V2 manifest plus host-owned sidecar
  files for oversized known fields. The 8 MiB framed JSON limit remains only
  for the small control manifest. Sidecars are streamed, hashed, imported,
  verified as regular non-symlink files under an execution-owned temporary
  directory, and then removed.
- Auxiliary Runtime kernel events and Workspace R final fields use the same
  projector. Final-result reconciliation fills missing value/message/warning/
  error chunks but does not repeat content already captured from kernel events.

### 7.4 Capture policy

The project retention policy gains configurable fields:

- `max_runtime_output_bytes_per_execution`, default 128 MiB;
- `runtime_output_project_warning_bytes`, default 1 GiB warning threshold per
  project;
- `max_runtime_execution_rows`, default 5,000;
- `auto_prune_enabled` remains false.

The per-execution capture value is a safety budget, not an execution quota. If
it is reached, the supervisor appends one durable `tombstone` describing bytes
captured and dropped, marks `output_state='partial'`, stops collecting further
display payload, and lets the Runtime finish. The UI says the computation
outcome and transcript completeness separately. Users may change the policy or
select unlimited capture explicitly; disk-full and filesystem errors still
produce truthful partial-output diagnostics.

## 8. Streaming And Replay Contract

Tauri 2 `Channel` is selected for typed ordered streaming. Official Tauri 2
documentation states that the global event system is intended for small
multi-producer notifications and is not suitable for high-throughput ordered
data; Channels are the optimized streaming path.

Frames are versioned and contain `project_id`, `execution_id`, and monotonic
sequence/cursor data:

```text
admitted    { execution, committed_through }
chunks      { first_sequence, last_sequence, chunks[] }
checkpoint  { committed_through }
gap         { expected_sequence, committed_through }
terminal    { receipt, committed_through }
```

The TypeScript controller processes Channel callbacks through one serial queue.
It ignores exact duplicates, detects gaps, pauses live projection, fetches the
missing page from Store, and resumes from the durable cursor. Channel send
failure detaches only that follower; it never cancels or changes the execution.

Follow admission uses snapshot-then-subscribe under the execution supervisor so
no chunk can fall between replay and live follow. A stale/foreign-project
follower is rejected before content is read. Project switching clears frontend
caches and rejects late frames with the old project identity.

## 9. Console And History Interaction

### Console

- Console mounts from `runtime_execution_list` plus paged chunks, not Surface
  transcript state. Renderer release, Stack switching and frontend reload do
  not lose committed output.
- The default view follows the active execution tail. Scrolling upward disables
  follow-tail without snapping the user back; `Jump to latest` restores it.
- Older pages load upward with scroll-anchor preservation. Only a bounded page
  window is mounted, avoiding an unbounded DOM while keeping keyboard selection
  and screen-reader order coherent.
- Filter/search queries the durable normalized chunks and reports searched
  execution range and omitted/pruned payload truthfully.
- Each execution groups submitted code, human output, terminal state, source
  provenance, elapsed time and `Open in History`; bridge IDs/raw envelopes remain
  under Diagnostics.
- `Clear this Console` is replaced by `Start new transcript`. It changes only a
  lightweight per-Surface start anchor. It never deletes Runs or output.
- `Prune output payload` and `Delete execution record` remain separate BH4-owned
  actions with explicit effects, confirmation and tombstone behavior.

Surface view state V3 contains only filter, start/read cursor, follow-tail and
scroll anchor. Draft and command recall remain project-isolated session state.
No output text, result event, or Provider context is serialized there.

### History

- History lists every user/Agent/plugin Runtime execution admitted through this
  path. Workspace R rows link the authoritative Run; auxiliary rows truthfully
  state that no Workspace Run exists.
- Detail and Console use the same `runtime_output_page` projection, so wording,
  order, errors and rich-output links cannot drift.
- Existing pre-v15 Runs remain visible through a read-only `legacy_projection`
  synthesized from proven Run fields. Historical generic events are not
  guessed into ordered output.
- Retry creates a new execution/Run lineage and never mutates original chunks.

Loading, empty, streaming, paused-follow, partial-capture, failed, interrupted,
pruned, unavailable, stale, narrow-window, keyboard, zoom and high-contrast
states are part of the same acceptance contract.

## 10. Agent Context Manager

### 10.1 Explicit references

Agent receives Console/History output only through an explicit user action such
as `Use in Agent`, `Fix with Agent`, or a selected Context chip. The reference
contains project identity, execution ID, exact sequence range and digest; it
does not copy text into frontend state.

`Fix with Agent` may automatically bind the exact failed Run/Problem because
that explicit action already names the repair target. An ordinary Agent prompt
does not attach recent output merely because it is visible.

The Agent composer shows removable Context chips for editor selection, Problem,
Run/output range, Artifact, Skill and plugin source. A `Review context` control
shows source, trust, size, projected size, disposition and reason before any
Provider request.

### 10.2 Capacity-aware planning

Agent model profiles gain validated `context_window_tokens` and
`reserved_output_tokens` capability values with source
`catalog`, `user_declared`, or `conservative_default`. The settings migration
preserves existing providers and routes; known catalog models receive known
values, while unknown custom models use a visible editable conservative default
instead of pretending capacity is known.

The planner counts system policy, tool schemas, current request, exact
Conversation material and every attachment. Provider adapters may supply an
exact tokenizer. Otherwise the UTF-8 byte count is used as a safe upper-bound
estimate and the preview labels it conservative.

Priority is deterministic:

1. system/developer policy and tool schemas;
2. complete current user request;
3. explicit user-pinned output/Problem/Artifact references;
4. explicit editor selection/problem context;
5. newest exact turns from the selected Conversation;
6. project Skills and active workspace-plugin context.

The current request is never silently truncated. If required policy, tools,
reserved response and request alone do not fit, dispatch is rejected before the
Provider call with an actionable capacity message. Lower-priority attachments
are projected or omitted with reasons.

The fixed four-turn prompt limit is superseded only after this contract becomes
active. The planner considers up to the existing bounded 100-turn query from
the exact Conversation, newest first, and includes as many as capacity allows.
Older turns remain available through a project-scoped, read-only, bounded
`conversation.read_turn` tool; no cross-conversation history is considered.

Long selected output uses deterministic head/tail/error/warning projection with
sequence counts and digests. Agent may request additional exact pages through a
read-only `workspace.read_runtime_output` tool. No hidden summarization model or
embedding service is introduced.

### 10.3 Preview, admission and receipt

`agent_context_preview` returns a digest-bound plan containing model/profile
revision, Conversation revision, editor/document revision, attachment ranges,
capacity source, estimated tokens, and every disposition. `run_agent` carries
the plan digest. The broker recomputes the plan and rejects stale context before
Provider dispatch; it never silently sends material different from the preview.

On admission, metadata-only rows are written to `agent_turn_context_items`.
Agent Activity exposes the same safe manifest as `Context used`; diagnostics do
not contain source text, output, complete prompts, object values or credentials.

## 11. Failure, Cancellation And Recovery

- Runtime rejection before admission creates no execution row, output, History
  item, cursor advance, or Agent context reference.
- Runtime failure after admission finishes the execution truthfully and retains
  every committed chunk.
- Output persistence failure does not report computation failure or abort R
  after side effects may have occurred. The execution becomes
  `output_state='partial'`, the Run outcome remains authoritative, and one
  bounded diagnostic describes recovery options.
- A malformed/rich payload is tombstoned with digest/type/size; siblings and
  later output remain readable.
- Interrupt is execution-scoped, idempotent and terminal. Late output after the
  terminal cursor is rejected and diagnosed.
- Closing Console, losing Channel, reloading the webview or moving the Surface
  does not cancel execution. Reattach starts from the last committed cursor.
- Desktop shutdown asks active executions to interrupt, flushes committed
  output, and marks unresolved rows interrupted. On reopen, rows left
  admitted/running are reconciled once with `desktop_restart`; they are never
  shown as completed.
- Project switching retains existing BH2 blockers. Forced process death cannot
  attach old-project output to the newly active project.
- Context preview rejection, stale digest, foreign project, pruned range,
  insufficient model capacity, redaction failure and Provider rejection are
  distinct and never create a false Provider call or successful turn.

## 12. Migration And Compatibility

### Store v14 -> v15

- Create a same-directory pre-migration backup.
- Create all three tables and indexes in one transaction.
- Do not backfill ambiguous generic `events` rows.
- Existing Runs stay unchanged. The compatibility projection reads only proven
  Run fields and labels itself `legacy_projection`; it does not invent stream
  timing or order.
- Assert schema, foreign keys, indexes, zero orphan context/output rows, current
  record counts and unchanged existing Run/Agent/Artifact counts before version
  advance.
- Injected create/copy/index/assertion failures roll back to v14, retain the
  backup, and reopen successfully after the fault is removed.
- Current v15 reopen is idempotent. Unsupported/malformed historical stores fail
  closed with bounded migration diagnostics.

### Agent settings V2 -> V3

- Back up the exact settings file before writing V3.
- Preserve provider/model IDs, credentials references, routes, capabilities and
  selected model.
- Add context capacity values with truthful provenance; do not infer a custom
  model's capacity from its display name.
- Failure before/after temporary write retains a recoverable V2 source and does
  not expose credentials.

### Cutover

During development, a compatibility adapter may keep the tree buildable, but no
candidate ships two output authorities. The final cutover removes buffered
`RuntimeExecutionResultV1.events` from the frontend execution path, removes
legacy transcript persistence/recovery, regenerates contract fixtures, updates
browser mock parity, and proves no raw Runtime payload enters Surface state.

## 13. Retention And Privacy

- Project retention summary includes Runtime execution rows, inline output
  bytes, referenced Artifact bytes and pruned/tombstoned counts.
- Starting a new transcript hides older output from one Console view only.
- Pruning payload keeps execution identity, Run/Artifact links, sequence,
  digest, size, type and one tombstone; it never deletes another project.
- Deleting an execution record is explicit, refuses active/referenced records,
  follows BH4 terminology and transactionality, and never deletes a Run or
  Artifact unless the separately named action owns that effect.
- Automatic pruning remains disabled. Crossing a project warning threshold
  produces a non-blocking storage action, not silent deletion.
- Provider context requires explicit reference, exact project validation and
  context-plan admission. Redaction runs before preview and again before model
  transport. Credentials, URLs with secrets, environment values, private paths
  and hidden policy never enter context receipts or operation diagnostics.

## 14. Continuous Construction Method — Not Product Phases

The following obligations remain open simultaneously and close together. They
are not independently accepted stages:

| Obligation | Continuous integration requirement |
| --- | --- |
| contracts | Rust/TypeScript fixtures and negative bounds compile with every related change |
| migration/store | v15, backup, rollback, isolation, journal queries and receipts land with their consumers |
| supervisor/Runtime | start/follow/page/cancel/restart and Workspace/Aux ingress remain executable |
| frontend/mock | Console, History, context chips and every real command have deterministic mock parity |
| Agent | model capacity, preview digest, explicit references, read tools and receipt share one planner |
| retention/privacy | measurement, warning, prune/tombstone, redaction and delete wording match actual effects |
| integration | old buffered path is removed only when the complete replacement is green |
| evidence | docs, NEWS, version, debug identity, screenshots and manual ledger describe the same source |

No integration boundary may contain a schema unused by current code, a command
without mock parity, a UI depending on future persistence, or an Agent receipt
that differs from the dispatched context. Continuous commits must remain
buildable and revertible, but no commit is a product completion checkpoint.

## 15. Automated Acceptance Matrix

### Contract and pure logic

- normal, boundary, just-over-boundary, Unicode, control characters, malformed
  JSON, rich reference, split/coalesce, dedupe and terminal reconciliation;
- sequence gaps, duplicates, reorder, stale generation, wrong Console, foreign
  project, late terminal event and cursor pruning;
- context capacity known/unknown, exact/conservative token count, full request,
  explicit attachment priority, stale preview, redaction and omission receipt.

### Store and migration

- fresh v15, v14 backup/migrate/reopen, idempotent reopen, every injected
  failure, unsupported schema and malformed legacy records;
- projects A/B with identical execution IDs/source names proving list, detail,
  page, search, context, prune, delete, retry and recovery isolation;
- concurrent append/read/follow, duplicate append, transaction rollback,
  output-capture tombstone, disk/write failure and restart reconciliation;
- BH4 summary and manual prune preserve Run/Artifact/context references.

### Runtime and desktop

- Workspace R stdout/message/warning/value/error/plot plus auxiliary kernel
  stream, cancellation and restart;
- renderer/channel disconnect while execution continues, reattach replay, gap
  fetch, frontend reload and application reopen;
- structured-result sidecar normal/oversized/missing/tampered/symlink/digest/
  cleanup cases;
- Runtime success with partial output remains success; pre-dispatch rejection
  remains no execution.

### Agent

- no automatic Console/Run attachment;
- explicit output range and Problem repair attach the exact digest-bound source;
- pruned/stale/foreign range rejects before Provider dispatch;
- exact Conversation isolation, capacity-driven older-turn inclusion and
  bounded `conversation.read_turn`/`workspace.read_runtime_output` tools;
- context preview equals receipt and dispatched pack under fake Provider;
- Provider failure, cancellation and retry do not reuse stale context authority.

### Frontend and interaction

- loading/empty/live/follow-paused/partial/failed/interrupted/pruned/unavailable/
  no-match states;
- upward paging preserves reading position; new output does not steal it;
- Stack release, drag, resize, narrow viewport, 200% zoom, keyboard, screen
  reader status, reduced motion, high contrast and long multilingual output;
- `Start new transcript` does not alter History; explicit prune wording matches
  durable effects; Agent Context review is reachable and removable;
- real Chrome interaction uses delayed/rejected/duplicate/reordered/gapped
  scenario transport and validates visible truth, not internal JSON only.

### Full affected gate

At final acceptance, run and record:

```text
cargo fmt --all -- --check
cargo test --workspace --locked
npm --prefix desktop run rsr:check
Rscript -e "testthat::test_local('r/rho.bridge')"
Rscript -e "testthat::test_local('r/rho.agent')"
git diff --check
cargo build -p rho-desktop
```

Windows repeats the Rust matrix with the documented Rtools GNU path. Required
checks are not retried until green or waived because they are slow.

## 16. One Final Product Acceptance

One exact debug build, launched through `npm run rsr:dev:desktop`, must complete
this uninterrupted owner workflow:

1. run an R script that emits incremental stdout, a warning, a value and a plot;
2. keep reading while output arrives, scroll upward, and verify new output does
   not steal position;
3. switch Stack tabs, resize/move Console, reload the renderer, then reconnect
   and recover the same ordered transcript;
4. interrupt a long execution and confirm committed output plus truthful
   terminal state survive restart;
5. open the same execution in History and verify identical human output and
   Plot/Artifact links;
6. start a new transcript and verify History remains intact;
7. select an output range, choose `Use in Agent`, inspect the context plan, and
   run against the deterministic fake Provider; verify exact context receipt;
8. send an ordinary Agent prompt and verify Console/Run content is absent;
9. switch projects A -> B -> A and prove no output, context chip, receipt or
   reading cursor crosses the boundary;
10. exercise configured capture overflow and a deterministic persistence
    failure; computation, partial-output message, recovery and Diagnostics must
    remain truthful.

Failure of any item keeps the whole package active incomplete. There is no
Console-only, backend-only, or Agent-only acceptance.

## 17. Independent Review And Closure

After tests pass, a separate review pass checks:

- one authority for Run outcome and one authority for ordered display output;
- project identity, foreign-key direction, migration rollback and historical
  non-inference;
- durable-before-visible sequencing, cancellation, late output, restart and
  partial persistence truth;
- context preview/dispatch/receipt equality, explicit attachment authority,
  credential redaction and model-capacity provenance;
- BH4 wording and no silent delete/prune;
- frontend default focus, reading position, keyboard/accessibility and action
  consequence;
- mock/Tauri parity, added dependency/license/build impact and dirty-worktree
  preservation.

Every blocking finding is resolved and the complete affected gate reruns before
closure. Code presence and green unit tests alone do not close the contract.

## 18. Version, Documentation, Commit And Release Decision

- Activation allocates one new synchronized application development candidate;
  do not reuse `0.4.1-dev.14` after this schema/contract program begins.
- `rho.bridge` changes only if the final structured-result manifest requires an
  exported package contract; if so its package version and compatibility record
  move in the same candidate. The exported `rho_create_workspace_tools()` API
  gains the two broker-bound read tools, so `rho.agent` advances independently
  from `0.1.6` to `0.1.7` with its own package NEWS entry.
- `NEWS.md` is updated only after the complete implementation and affected
  validation exist, never from this proposal.
- The Studio design, Agent Conversation, Agent result transport, BH4, roadmap
  and cross-review records are reconciled at activation and again at closure.
- Commits remain scoped and buildable. The final handoff identifies exact
  commits, migrations, generated assets, tests, manual evidence, residual risk
  and dirty-worktree state separately.
- The development decision is `COMPLETE` or `INCOMPLETE`. Packaging,
  publication and public release remain `NO-GO` until separately authorized.

## 19. Definition Of Ready

Implementation readiness was satisfied on 2026-08-24 as follows:

- the owner explicitly authorized this complete contract, not an isolated
  subset, in the instruction to begin construction;
- this file is `active-` and records that authorization;
- the Agent Conversation, Agent result transport, and accepted BH4 contracts
  carry the activation amendments that preserve their current authority until
  the tested final cutover;
- the schema fixture source is the programmatically constructed current v14
  store used by `rho-store` migration tests; settings fixtures cover valid V2,
  malformed V2, unsupported versions, and injected write/rename failure;
- application candidate `0.4.1-dev.15` was allocated and was written to
  synchronized metadata only after reviewed user-visible behavior and affected
  local verification existed; it cannot be distributed by this contract; and
- no competing construction owns Store schema, Runtime output IPC, Agent
  context capacity, or Runtime-output retention. The concurrent visual
  construction is isolated by the path boundary recorded above.

## 20. Definition Of Done

The package is done only when the complete end-to-end loop is implemented,
legacy buffered transport is removed from the production frontend path, every
positive/negative/isolation/recovery test passes, independent review has no
blocking finding, the exact-debug owner workflow is accepted, version/NEWS/docs
are reconciled, commits are scoped, and release remains truthfully separate.

There is no deferred D3/R3 output journal, later Agent-context phase, or “next
stage” inside this contract.

## 21. Implementation And Verification Evidence — 2026-08-24

The complete source loop described by sections 6–13 is now present:

- schema v15 owns project-scoped executions, ordered output chunks, context
  receipts, and revisioned capture policy; v14 migration backup, injected
  rollback, reopen, project isolation, capture tombstones, manual prune, and
  receipt reference guards are covered by Store tests;
- Runtime admission creates durable execution truth before Channel delivery,
  Workspace R uses verified result-manifest sidecars, Console and Runtime
  History read the same paged journal, and the production Tauri/frontend invoke
  surfaces no longer expose the legacy buffered `runtime_execute` path;
- Console follow/pause/replay/search/transcript anchors and History paging,
  pruning, deletion, and exact `Use in Agent` ranges have deterministic mock
  parity and real Chromium interaction coverage; and
- Agent model settings V3, capacity planning, explicit digest-bound references,
  bounded read tools, preview/dispatch equality, omission reasoning, and
  metadata-only receipts share one broker-owned planner. Ordinary prompts do
  not automatically attach Console or Run content.

The post-review affected matrix passed again from the current worktree after
the protected sidebar/icon/CSS result was merged on 2026-08-24:

```text
cargo fmt --all -- --check                                  PASS
cargo test --workspace --locked                             PASS
  rho-desktop: 329 passed, 1 opt-in Keychain smoke ignored
  rho-store: 172 passed; rho-server: 111 passed
npm --prefix desktop run rsr:check                          PASS
  Vitest: 24 files, 226 tests
  build/assets/cutover/Chrome smoke/real interactions       PASS
Rscript -e "testthat::test_local('r/rho.bridge')"           PASS 581
Rscript -e "testthat::test_local('r/rho.agent')"            PASS 138
git diff --check                                            PASS
cargo build -p rho-desktop --locked                         PASS
```

An earlier exact one-click developer path built frontend build
`35f25f04f4a6` and launched the checkout's `target/debug/rho-desktop`. Its real
application log records schema v15 opening as current, Workspace startup
completion, and restoration of the acceptance fixture project. A stale
same-checkout debug `.app` discovered during that verification correctly
rejected v15 because it contained old code; the launcher regression now treats
both the raw debug binary and that checkout's debug bundle as owned development
instances, while refusing to signal installed or foreign-checkout paths.
Startup failure projection preserves the bounded, credential-redacted context
chain instead of showing only its outer label.

The later protected visual merge changed the current deterministic frontend
identity to `4bf73091856d`. The complete automated matrix and locked desktop
build above bind to that current identity, but the one-click exact-debug launch
has not yet been repeated for it. The earlier launch evidence therefore proves
the v15 startup/reopen path at its recorded source identity only; it is not
silently reused as current exact-app or owner-interaction acceptance.

This evidence does **not** close the contract. The current merged build has not
completed the one-click exact-debug launch or the uninterrupted ten-item owner
interaction workflow in section 16, and the Windows Rust matrix has not been
run from this macOS worktree. No `.app`, installer, signing, publication,
updater, or public-release action was performed. The development decision
therefore remains `INCOMPLETE` and release remains `NO-GO`.
