# Project Transition Epoch Repair

Status: implemented D3/R3 PROJECT-TRANSITION-EPOCH-1 defect contract; complete
affected validation and merged S0/S3/S9 verification passed for the
undistributed `0.4.1-dev.22` candidate

Date: 2026-08-27
Authorization: a release-blocking integration review on 2026-08-27 found that
the debug-automation-only drain was not product evidence. The owner's existing
emergency-correction and no-shortcut construction authorization requires this
bounded transition barrier and epoch-scoped error repair before the
`0.4.1-dev.22` integration can close
Change class: D3 because project switching, every frontend mutation domain,
and the shared Workbench error projection meet at the composition root
Risk: R3 because stale cross-project mutation and error leakage can make a
newly opened or same-root re-opened project display or accept work from the
previous activation
Work package: PROJECT-TRANSITION-EPOCH-1
Mandatory stop: satisfied 2026-08-27 by the reconciled frontend repair,
focused success/stale/failure/recovery and two-project isolation tests,
complete affected validation, a new immutable rebuilt S0/S3/S9 run, and exact
debug-app review. Exact-candidate distribution and release remain separate.

## Defect And Root Cause

At contract activation, `WorkbenchApp.performProjectSwitch` cleared visible
errors and called the broker without first closing frontend mutation admission
or draining the Studio and Surface controller queues.
`WorkbenchProjectionStore.settled()` observed only mutations that had already
reached the Store and could return early on the first rejection. A Surface
view-state intent admitted in project A could therefore enter the Store after
a same-root reopen or A -> B switch.
Backend project/revision CAS correctly rejects that stale request, but its late
frontend callback writes an unscoped global `actionError` into the newly
installed project. The acceptance bridge hid the product gap by draining UI
mutations before its own `open_project` action; that harness cleanup is not a
normal-UI transition barrier.

The S9 visual scenario also broadly retries any error containing `stale
revision`. That retry can turn a real cross-authority regression into a green
second mutation and must not remain part of acceptance.

The first authorized post-repair S0/S3/S9 run on 2026-08-27 exposed a distinct
same-activation race after a fresh project open. The newly mounted Console
truthfully compacted its legacy view state and advanced the Project UI Profile
from revision 1 to 2 while the user's immediate Vibe mode gesture still held
revision 1. Backend Profile CAS correctly rejected that stale target. The
Workbench reconciler refreshed but accepted only the case where another writer
had already selected Vibe, so it surfaced a failure even though the same
project and local activation remained current and the requested mode was still
available. Delaying S9 after project open would hide a real quick-user-action
race and is not an accepted remedy.

## Ownership And Cross-Review

This package owns only:

- a Workbench session-local mutation-admission barrier;
- quiescence of already-admitted Studio and Surface UI queues before broker
  project switching;
- one monotonic, non-persistent frontend activation epoch; and
- epoch/project/revision-scoped projection of ordinary Workbench action errors;
  and
- one same-epoch Project UI Profile mode-gesture quiescence boundary before a
  single owner mutation uses the latest authoritative Profile revision.

BH2 remains the sole owner of project preflight, blockers, normalized roots,
commit, rollback/restore, response status, durable last-opened truth, and fatal
recovery. Surface Runtime, Studio, Project UI Profile, Runtime Registry,
Resource Registry, Agent, and their brokers retain all identity, revision,
CAS, mutation, permission, and recovery authority. The local epoch is not
persisted or sent over the wire, does not cancel or grant an operation, and is
never accepted as backend truth. Backend CAS is preserved unchanged.

STARTUP-INFO-1 ends before `WorkbenchApp` and owns no part of this repair.
VIBE-1/VIBE-1R retain only their existing save-before-leave and presentation
contracts. The Studio design contract owns the composition-root enforcement
repair as WP16-R3; the implemented RSR construction plan remains historical
and receives only a dated reconciliation note pointing to this implemented
owner.
No schema, migration, command, event, protocol, credential, approval,
filesystem, network, installer, signing, publication, or release authority is
added.

Project UI Profile remains the sole owner of mode truth, profile revision, and
CAS. One Workbench mode gesture captures the exact project identity and local
activation epoch, waits for the already-admitted Studio and Surface controller
queues and then the Store mutation set to settle, revalidates that exact local
activation, and only then reads the latest authoritative Profile. If the mode
already matches, the gesture is complete without a write; otherwise it issues
exactly one owner `set_mode` mutation using that latest revision. A controller
or Store quiescence operation that itself fails, an unavailable Profile, or a
Profile CAS failure does not retry or reinterpret truth. Failures from earlier
Studio/Surface work remain owned by their original scoped sinks; successful
quiescence does not replay them. No error-message parsing, second owner
mutation, broad stale-revision loop, backend retry, cross-activation re-entry,
or harness retry is introduced.

Mode selection and project switching share the existing `runVibeTransition`
mutex. Once either transition begins, the other entry remains disabled and
cannot begin a project barrier or replace the local epoch underneath the first
gesture. This mutual exclusion is the reachable product contract; it is not
weakened to manufacture a synthetic mode-write/project-switch race.

## Required Transition Sequence

For an admitted project-switch request, the exact order is:

1. if the current mode is Vibe, `prepareToLeave()` succeeds while project A is
   still the open activation;
2. synchronously close new Workbench/Studio/Surface mutation admission,
   advance the local epoch, invalidate the previous action-error sink, and
   clear its visible projection;
3. drain the complete already-admitted Studio and Surface controller queues;
   rejected entries still count as settled and cannot make the drain return
   before sibling queues;
4. drain every mutation already registered in
   `WorkbenchProjectionStore.settled()` without early rejection;
5. capture the exact settled source scope after both drains; this is the only
   valid baseline for deciding whether the broker changed the activation;
6. call the existing BH2 broker operation exactly once; and
7. reconcile the exact response before reopening frontend admission.

Rapid duplicate project-switch requests remain ignored by the existing
`ProjectSwitchController`; an ignored request must not start a second epoch or
close/reopen admission owned by the first request.

## Outcome Reconciliation

- `ready`: refresh and validate the exact committed projection. Global
  `projection_generation` must advance beyond the settled source scope. If the
  refreshed opaque `project_id` equals the settled source project identity,
  `project_revision` must also advance before admission reopens. Frontend code
  never compares or normalizes project paths to make this decision.
- `failed_restored`: refresh the exact restored previous project, require its
  opaque identity to equal the settled source identity and its project revision
  to advance beyond the settled source revision, then reopen in the new local
  epoch.
- `blocked`, `cancelled`, or `unavailable`: prove the original projection was
  not replaced after the settled source baseline, report only the broker-owned
  switch result, and reopen that settled source project in the new local epoch.
  Mutations admitted before barrier close may legitimately have advanced A
  during drain; they are never compared with or rolled back to transition-start
  projection data.
- thrown broker/quiescence errors or refresh failure: admission may reopen only
  after a fresh coherent projection proves the previous project is still the
  installed truth. Otherwise it remains closed.
- `fatal` or `restart_required`: keep mutation admission closed. A visible
  restart-required project-switch error remains separate from ordinary
  `actionError`.

Every ordinary action/report callback captures local epoch, project identity,
and project revision when admitted. Only the current open scope may clear or
write `actionError`; a late old-scope rejection may enter the bounded
operation trace but cannot project into B or a later A activation. Current-
scope failures remain visible and recoverable. A multi-step File workflow may
report against the current non-decreasing revision of its captured open epoch
and project after an earlier admitted step advances project truth; that
same-epoch rebase never permits reporting after admission closes or into a new
epoch/project.

One explicit File `Save` or `Run` gesture is one composite pre-transition
admitted Workbench operation. `Save` carries the dirty-draft commit and the
authoritative Resource save through one opaque Store lease. `Run` carries only
the dirty-draft commit and a capability-shaped Console handoff/preparation
through one opaque Store lease. Once either gesture is admitted, transition
quiescence waits for that entire outer composite, including a failing final
outer step, before broker switching may begin.

The actual Runtime start remains a Console-owned, separate epoch-checked Store
admission. It neither inherits nor can retain the File workflow lease. A
transition waits for that Runtime start only if Console independently admitted
it before admission closed; it does not promise to wait for a background start
that Console has not accepted. If close wins that admission race, the old
handoff fails closed and cannot execute in B or A2. These boundaries change no
Resource, Console, or Runtime authority and do not make a failed save, handoff,
preparation, or execution successful: each existing owner still reports its
own stale, rejection, persistence, or execution result truthfully.

The lease remains composition-root implementation state. `FileResourceView`
and other component callers receive only bounded workflow operations, never a
lease value or lease type; the opaque lease cannot be returned, retained, or
used after the admitted workflow callback settles. A component callback cannot
construct a lease, split a single gesture into a post-close second admission,
or reuse one gesture's authority for another mutation.

Keyboard focus transfer from the editor into, or between, the File `Run` and
`Save` controls remains part of that pending gesture and must not trigger an
independent blur admission. Leaving the workflow-action cluster without
activating either control retains the ordinary bounded draft-commit fallback.

The capability-shaped File workflow facade has the same exact callback
lifetime. Its bounded `update`, `save`, and `run`/Console-handoff functions are
live only while the one admitted outer callback is unsettled. The composition
root revokes the complete facade in `finally`, whether that callback fulfills
or rejects. Any function reference returned from the callback, captured in a
closure, saved by an internal caller, or invoked by an existing Console
endpoint after settlement must fail closed before reaching Store, Resource,
Console, or Runtime. Revocation is independent of project identity, so a
retained A facade cannot become valid again in B or same-root A2.

Implementation reconciliation must record this exact split: an internal File
workflow facade owns one non-exported outer lease for commit plus save or
Console handoff/preparation, while Console owns a separate epoch-checked
Runtime-start admission with no File-lease inheritance.

Agent workflows that may establish a new durable conversation identity are
also composition-root composites. An explicit Agent `New` action performs the
raw Agent-owned conversation create, refreshes the coherent Workbench
projection, and persists that returned conversation identity into the exact
Agent Surface view state under one opaque Store lease. A `Send` action with no
current conversation similarly performs the raw Agent-owned run/start, which
may create the authoritative conversation and Turn, refreshes the coherent
projection, and persists the returned conversation identity and completed
composer transition into that exact Surface under one opaque Store lease.
`AgentSurfaceView` and `SurfaceView` receive only capability-shaped callbacks;
neither component receives, constructs, returns, or retains the lease.

Each composite captures the source project identity, Surface instance identity,
and `activation_generation` when admitted. At serialized controller execution,
the exact identity must still match while the request uses the latest
authoritative project and Surface revision for that same project. A composite
admitted before barrier close may finish against source A, and project switching
must wait for the raw Agent operation, coherent refresh, and exact Surface
persist to settle before invoking the broker. It must not re-check the closed
local epoch as a reason to cancel already-admitted source work, and it must not
write through to B or a replacement same-root activation after the broker.

Agent and Surface failures remain truthful and independently durable. If raw
create/run succeeds but exact Surface persistence fails, the created
conversation or Turn remains authoritative Agent history but is not reported
as the selected Surface conversation. Recovery is an explicit later selection
or workflow retry; the frontend neither rolls back Agent truth nor fabricates a
successful selection. Read refreshes list and render current Agent truth only:
they never choose a fallback conversation or persist view state implicitly.
Explicit conversation selection persists first and changes local selection
only after the exact Surface write succeeds. A delayed list/Turn/detail
invalidation generation cannot overwrite a newer explicit selection, `New`, or
`Send` result.

## Implementation Slice

1. Add a pure frontend transition-epoch controller for closed/open admission,
   exact action scopes, ready/restored/no-change validation, and fail-closed
   outcome reconciliation.
2. Gate new Store, Studio, and Surface mutation admissions. An operation
   admitted before close receives an opaque, store-identity-bound epoch lease;
   only that unforgeable live lease may carry its serialized controller or
   multi-step Workbench operation through the closed barrier. Ordinary callers
   cannot pass a boolean or construct a bypass token. Adapt File `Save` and
   `Run` at the Workbench composition root so each user gesture uses one lease
   across dirty-draft commit plus Resource save or capability-shaped Console
   handoff/preparation, without exposing the lease through `FileResourceView`
   props or component callbacks. Keep Runtime start behind Console's separate
   current-epoch Store admission; never forward the File lease to it. Revoke
   every workflow capability in a `finally` boundary when the outer callback
   settles, including capability references retained by an existing Console
   endpoint. Treat editor/`Run`/`Save` keyboard focus as one workflow-action
   cluster so focus traversal does not split the gesture into a raw blur
   admission.
3. Route Agent `New` and no-current-conversation `Send` through Workbench-owned
   capability callbacks. Each callback uses one opaque Store lease across its
   raw Agent owner call, coherent Workbench refresh, and exact Surface
   view-state persistence. The Surface controller verifies captured project,
   instance, and activation generation at execution and then uses the latest
   same-project project/Surface revisions. Keep read invalidation refreshes
   non-selecting and non-persisting, make explicit selection persist-first, and
   generation-guard every post-await local projection. Do not expose the lease
   through `AgentSurfaceView` or `SurfaceView` and do not nest the admission-
   guarded transport inside the outer composite.
4. Make Store settlement rejection-tolerant and stable until every registered
   mutation has completed. Drain controller queues before Store mutations in
   the product switch path.
5. Scope Workbench action-error writers to their captured activation; expose
   project-switch status to the debug automation without adding a command.
6. Make browser/mock accepted project activation advance the coherent project-
   revision vector even when the opaque project identity remains the same.
   Snapshot, layout, Profile, Page, Agent, and other durable owner revisions
   advance only when their existing semantics require it; activation does not
   fabricate domain-content changes.
7. Remove S9's broad stale-revision retry, require one mutation attempt, and
   make same-root visual helpers wait for the full normalized path plus an
   advanced activation revision.
8. Before one explicit Studio/Vibe mode selection reads Profile truth, capture
   its exact project/local-epoch scope, drain the complete Studio and Surface
   controller queues with rejection-tolerant sibling settlement, and then
   drain the Store. Revalidate the same installed activation, read the latest
   Profile, and issue at most one ordinary Store-admitted `set_mode` mutation
   with that revision. Do not retry, parse errors, start a second admission, or
   cross an installed replacement activation. Keep a quiescence-port failure,
   unavailable Profile, and the sole mode mutation's rejection fail-closed and
   recoverable through a later explicit gesture. Preserve the shared Vibe
   transition mutex so a project switch cannot begin while this gesture is in
   flight.

## Acceptance Gate

- Pure/controller tests cover open/closed admission, epoch advance, stale
  scope suppression, current-scope error visibility, ready same-root revision
  advance, A -> B, A -> B -> A, failed-restored, blocked/cancelled/unavailable,
  thrown/refresh failure recovery, fatal closed state, rapid duplicates, and
  recovery after every rejection.
- Surface and Studio tests prove new work is refused after close, every task
  admitted before close finishes in queue order, one rejection does not poison
  or shorten settlement, and a later reopened-epoch mutation succeeds.
- App tests use deferred Navigator view-state work to prove queue -> Store ->
  broker ordering for same-root reopen and A -> B; old A errors never create
  `.rho-action-error` in B or A2; A work cannot mutate B; a current target-
  revision failure remains visible; and successful recovery admits a new
  mutation.
- Focused File workflow tests prove one admitted `Save` gesture serializes
  dirty-draft commit -> Resource save and one admitted `Run` gesture serializes
  dirty-draft commit -> capability-shaped Console handoff/preparation under one
  non-exported lease. For both A -> B and same-root A1 -> A2, the broker is not
  called until that whole outer composite settles. A Runtime start is waited
  only when Console separately admitted it before close. B receives no A draft,
  save, execution, local continuation, or error; A2 may observe only an
  authoritative durable A result completed before switching, and a new A2
  gesture succeeds under a new admission.
- File workflow failure injection covers dirty-draft, Resource-save, Console-
  handoff/preparation, and separately admitted Runtime-start rejection/stale/
  failure as applicable. No failed step is projected as successful, settlement
  still waits for every admitted sibling, no broker call overtakes the outer
  composite, an unaccepted old Runtime start cannot cross into the target,
  old-scope errors do not enter the target, and a current reopened epoch can
  retry successfully. Deferred current-epoch Resource-save and Console-handoff
  failures remain visible after an earlier step advances project revision,
  while the same failures released after transition close remain absent from
  B/A2. Keyboard editor -> `Run` -> `Save` and editor -> `Save` -> `Run`
  paths issue exactly one draft update through the activated outer workflow.
  A static type/entry-path check proves `FileResourceView`
  and component callers cannot receive, retain, or return the opaque Store
  lease, while the internal workflow facade uses one outer lease and Console
  performs the actual Runtime start through a separate epoch-checked admission.
- Capability-lifetime tests capture and return each bounded A workflow facade
  function (`update`, `save`, and `run`/Console handoff), let the outer callback
  settle through both fulfillment and rejection, then attempt to invoke the
  retained reference after A -> B and same-root A1 -> A2. Every invocation is
  rejected before Store or endpoint work, including an invocation retained by
  the existing Console endpoint; B/A2 receives no Resource mutation, Console
  handoff, Runtime execution, local continuation, or action-error projection.
- Agent identity-workflow tests cover `New` and no-current-conversation `Send`
  success, stale exact identity, raw Agent failure, exact Surface persistence
  failure, and recovery. Browser/mock evidence requires the picker and exact
  Surface view state to select the precise conversation identity returned by
  `New`, and no-current `Send` to select the precise conversation identity
  returned with the authoritative Turn. If Agent creation/run succeeds and
  Surface persistence fails, tests require the conversation/Turn to remain
  durably discoverable while the prior Surface selection remains authoritative
  and the current-scope failure remains visible.
- Deferred Agent composite tests cover A -> B and same-root A1 -> A2. The
  broker cannot run until raw create/run, coherent refresh, and exact Surface
  persistence have all settled; no Surface request may target B or the A2
  project revision from the old callback, no old-scope error may enter the
  target, and a target-epoch retry succeeds. Same-root A2 may restore a durable
  A1 selection completed before switching, but receives no post-broker A1
  mutation. Separate exact-activation replacement tests keep project and
  instance identity constant while advancing `activation_generation` and prove
  that the old composite cannot persist into the replacement activation.
- External-invalidation tests defer conversation lists, Turns, and details
  across explicit selection, `New`, and no-current `Send`. Older generations
  cannot replace the newer selected identity or issue a Surface write; a read
  refresh never selects or persists a fallback. Explicit selection writes the
  exact Surface first, leaves local selection unchanged on stale/failure, and
  can recover with a later current-activation selection.
- Mock parity tests require every accepted open, including A -> A, to advance
  the coherent project-revision vector. Profile, Page, layout, Agent, and each
  domain snapshot revision change only under their existing owner semantics;
  activation never fabricates durable content changes.
- App tests deterministically race a current-project Console/Surface Profile
  persistence against an immediate Vibe gesture. While that persistence is
  unsettled, `set_mode` remains uncalled. After settlement advances the exact
  Profile revision with Studio still active, the gesture reads that revision,
  issues exactly one `set_mode`, and reaches Vibe without an action error.
  Shared-transition tests prove project-switch controls remain disabled and the
  broker cannot start while the mode gesture is in flight; the inverse order
  likewise issues no old-project mode write after a project transition starts.
  A quiescence-port failure injection must await every controller sibling and
  the Store, issue zero mode writes, project a current-scope error, and allow a
  later explicit gesture to recover. The sole Profile mutation's rejection is
  not retried. Existing project-transition barrier tests remain the evidence
  for already-admitted Store work, A -> B, same-root A1 -> A2, and old-epoch
  isolation; no unreachable overlapping mode/project transition is fabricated.
- Harness tests inject a Surface project-revision stale error and prove S9
  rejects it after exactly one frontend `set_mode` action. Static enforcement
  prevents a broad harness stale-message retry from returning; the bounded
  Workbench-internal Profile reconciliation above is tested at the product
  boundary and is never supplied by the scenario runner.
- Run focused Vitest and harness checks while iterating, then the complete
  `npm run rsr:check --prefix desktop`, production frontend build, affected
  Rust/debug build, lane/governance checks, and a new immutable real-debug S0
  plus S3 plus S9 visual run from the rebuilt frozen source snapshot, with all
  reviewable frames explicitly reviewed.

## Version And Release Boundary

This is a user-visible application correctness repair. If `0.4.1-dev.22` has
not been distributed, it remains part of that candidate and receives its own
`NEWS.md` bullet after verification; otherwise the application version must
advance. R package versions remain unchanged. Exact-candidate installation,
signing, distribution, and release GO/NO-GO remain separate; this contract
does not turn development acceptance into release approval.

## Integration Verification — 2026-08-27

The implementation matches the reconciled contract. The composition root now
owns the ephemeral local activation epoch, closes admission before project
transition, drains Studio and Surface controller queues before the Store,
keeps settlement rejection-tolerant, captures the settled source baseline, and
projects ordinary action errors only into their accepted activation. The
existing BH2 broker and every Agent, Surface, Profile, Resource, Runtime, and
Store revision/CAS owner remain unchanged.

Focused evidence covers controller and Store queue order, rejected siblings,
closed/reopened admission, ready/restored/no-change/fatal outcomes, A -> B and
same-root A1 -> A2 isolation, late Console start/follow and Agent refresh,
File Save/Run workflow capability lifetime, Agent `New`/no-current `Send`,
exact activation replacement, current-scope failure and recovery, and the
single latest-Profile Studio/Vibe mode write. The final App suite passed
133/133. A separate independent read-only audit of
PROJECT-TRANSITION-EPOCH-1 in-scope behavior on pre-documentation frozen
product fingerprint
`df64bc7de536667641f7aa96c6fcfa5c99a83713701af999c000dcd1b9311dcb`
reported no remaining in-scope P0-P2 finding.

The pre-documentation frozen product snapshot fingerprint was
`df64bc7de536667641f7aa96c6fcfa5c99a83713701af999c000dcd1b9311dcb`.
`npm run rsr:check:resume:stable --prefix desktop` passed typecheck, lint,
generated contracts, 76 Vitest files / 578 tests, the production build,
browser smoke, real interaction acceptance, checkpoint/lane checks, and the
visual-harness self-test. The following locked Rust commands also passed:
`cargo metadata --locked --format-version 1 --no-deps`,
`cargo fmt --all -- --check`, `cargo test --workspace --all-targets --locked`,
`cargo check --workspace --all-targets --locked`, and
`cargo build -p rho-desktop --locked`. The main desktop test set reported 411
passed and 23 ignored.

The exact frozen debug binary had SHA-256
`3fb1693239d2b2f64f1966284dd1dd485fe41afa890b67abf6969a63a8650465`.
The immutable final run at
`target/visual-acceptance/dev22-final-df64bc7d-3fb16932-s0-s3-s9/` finished
`PASS`: S0, S3, and S9 all passed; 35/35 deterministic gates and all 31
captured frames passed individual review, with zero deterministic, visual, or
pending failure. The earlier immutable Keychain-blocked and pre-repair runs
remain failed evidence and were not reclassified.

Lifecycle documentation did not change the frozen product sources or frontend
assets. At that later historical checkpoint, the exact frozen debug binary had SHA-256
`4c9d9b18920d97c0aaea309b61d1bde6ade603f1d3c268d8e3a395f55d02a1cf`.
Its immutable S0/S3/S9 confirmation run at
`target/visual-acceptance/dev22-final-1f476c14-4c9d9b18-s0-s3-s9-r2/`
finished `PASS` with 35/35 gates and 31/31 reviewed frames. This confirms the
historical binary's named presentation scenarios only; the
PROJECT-TRANSITION-EPOCH-1 behavioral closure remains bound to the focused and
complete frozen-product test evidence above. The earlier `3fb169...` run
remains historical pre-documentation PASS evidence. Both runs now remain
historical pre-VA1-INTEGRITY-1 evidence rather than a claim about the current
candidate; a new exact v2 candidate remains pending.

Application version authorities and `NEWS.md` are synchronized at
`0.4.1-dev.22`; R package versions remain unchanged. This verification closes
every in-scope gate and moves the contract to `implemented-`; it does not
perform signing, installation, distribution, or release GO/NO-GO.
