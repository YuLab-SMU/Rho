# P2-4 Plugin Lifecycle, Recovery, Uninstall And Upgrade

Status: implemented and accepted for Phase 2 integration; P2-4A through P2-4G
are complete at `0.4.1-dev.11`; exact implementation head
`dbd51d18038820c0ead6f1d3006ef28d164d2df3` passed Draft Fast run
`32456277341` and all six hosted/package legs in run `32456281744`; the owner
explicitly removed the Browser visual review from this integration gate and
moved visual modularization to a separate follow-on design stream

Active work package: none. PR #2 merge to `main` is authorized. No release,
publication, distribution, plugin install/catalog, Phase 2.5 execution,
Phase 3, or visual-redesign authority is included.

Change class: D3 schema, project switching, destructive file mutation,
execution lifecycle, crash recovery, upgrade and rollback. Risk: R3.

## Purpose

P2-4 makes Phase 2 lifecycle truth durable and recoverable:

- exact-package enablement and restart;
- quiesce, disable and forced non-routability;
- host crash/hang recovery;
- recoverable uninstall from the discovery root;
- local package replacement, candidate validation, expected-old publication;
- immutable accepted-package backup and rollback;
- complete bounded audit and user-facing recovery state.

This is the final Phase 2 implementation package. Phase 2 is not accepted until
P2-4 plus all prior package and installed-platform gates pass.

## Authority And Cross-review

- P2-0 owns discovery, package inventory/digest and symlink-safe roots;
- P2-1 owns Wasm host lifecycle and quarantine;
- P2-2 owns grant/request/event state and revocation;
- P2-3 owns live contribution effects and their reverse-order teardown;
- BH1/BH2 own project identity/switching/recovery and cannot be blocked by a
  non-cooperative plugin;
- rho-store owns transaction/migration truth;
- BH4 owns retention/tombstones and secure deletion timing;
- project file mutation and Git review remain separate; plugin uninstall is a
  dedicated trusted system action, never an Agent Accept/file-edit operation;
- release/update systems do not update third-party plugins;
- Phase 3 owns install/catalog/signing/publisher/remote update.

P2-4 does not add generic plugin key/value storage. Its package backup is a
broker-owned rollback asset with no guest read/write interface.

## Schema V14

P2-4 owns transactional `v13 -> v14` after P2-2 schema acceptance. No historical
plugin enablement is inferred. Existing project packages are discovered as
disabled unless an exact durable P2-4 decision is created.

### `workspace_plugin_states`

```text
project_root TEXT NOT NULL
plugin_id TEXT NOT NULL
directory_name TEXT NOT NULL
plugin_version TEXT NOT NULL
accepted_digest TEXT
pending_digest TEXT
rollback_digest TEXT
runtime_kind TEXT NOT NULL
desired_state TEXT NOT NULL
observed_state TEXT NOT NULL
last_activation_generation INTEGER NOT NULL
last_host_session_id TEXT
transition_id TEXT
last_error_code TEXT
enabled_at TEXT
disabled_at TEXT
updated_at TEXT NOT NULL
PRIMARY KEY(project_root, plugin_id)
```

`desired_state` is `disabled|enabled|uninstalled`. `observed_state` is
`discovered|disabled|resolving|activating|active|quiescing|disposing|stopped|
crashed|update_pending|rollback_pending|uninstalled|blocked`. A UI request
changes desired state durably; observed state changes only after the named
runtime transition. Neither column alone proves completion.

Activation generation is monotonic per project/plugin and never reused after
restart, failure or rollback. Host session IDs are diagnostic identities, not
persisted reusable authority.

### `workspace_plugin_transitions`

```text
transition_id TEXT PRIMARY KEY
project_root TEXT NOT NULL
plugin_id TEXT NOT NULL
kind TEXT NOT NULL
expected_old_digest TEXT
candidate_digest TEXT
rollback_digest TEXT
phase TEXT NOT NULL
status TEXT NOT NULL
requested_at TEXT NOT NULL
updated_at TEXT NOT NULL
completed_at TEXT
reason_code TEXT
backup_path_key TEXT
```

Kinds: enable, disable, uninstall, retry, upgrade, rollback, project_teardown,
shutdown. Phases are append-only/monotonic. Duplicate request IDs are
idempotent; a different request cannot take over an active transition.

### `workspace_plugin_lifecycle_events`

Bounded audit records discovery, user request, preflight, grant state,
activation, routing publication, call drain/cancel, handle revoke, contribution
dispose, host dispose/quarantine, package backup, pointer CAS, rollback,
recovery and terminal outcome. It stores stable IDs/digests/codes/durations and
counts, never raw handles, file/network/Workspace payloads, credentials, Wasm
memory, complete private paths or plugin logs.

### `workspace_plugin_package_tombstones`

Records packages moved out of discovery for uninstall/cleanup: exact project,
plugin, digest, opaque backup key, original directory component, moved/deleted/
restored timestamps, retention class and reason. It never guesses a missing
package's identity.

Migration tests cover v7-v13, empty v14, backup, injected failure, rollback,
reopen/idempotency, checks/indexes/FKs, malformed plugin rows and no premature
version advance.

## Internal Immutable Package Cache

Before first enable and every accepted replacement, the broker copies the exact
validated package inventory into app-local protected storage:

```text
plugin-package-cache/<project-hash>/<plugin-id>/<package-digest>/
```

Rules:

- source discovery root and every file are revalidated immediately before copy;
- destination names derive only from validated IDs/digests, never plugin paths;
- temp directory + fsync files/metadata + atomic rename + read-back digest;
- no symlinks/reparse points, hard-link tricks, sockets/devices, sparse size
  escape, executable fetch or post-copy mutation;
- permissions restrict to the current OS user; no credential or project data
  beyond package files;
- maximum 32 MiB/package, three retained digests/plugin, 256 MiB/project;
- accepted and rollback digests are never evicted; rejected/obsolete backups
  follow BH4 retention and tombstone rules;
- guest code cannot list/read/write the cache directly;
- cache is local rollback evidence, not an install source, marketplace or
  publisher trust signal.

If backup cannot be proven exact, enable/upgrade fails before routing changes.

### Activated P2-4B contract

The existing P2-3 enable path is intentionally not accepted as durable
lifecycle behavior: it allocates generation in process memory, loads Wasm and
Skill text from the mutable discovery directory, and loses enabled intent on
restart. P2-4B replaces that behavior without adding a new permission class or
command surface.

P2-4B is divided into three local integration stops:

1. **P2-4B1 — exact snapshot and cache foundation (locally complete).** Discovery exposes
   one bounded read-only snapshot of the canonical package inventory only after
   the project root, `.rho/plugins` root, single-component directory, manifest,
   every file and expected digest are revalidated. The Rust Broker owns an
   app-local cache rooted at `plugin-package-cache/<project-hash>/<plugin-id>/
   <digest>/`; callers receive typed evidence/file bytes, never an authority
   handle exposed to guest code. Copy uses a same-parent temporary directory,
   exclusive files, per-file sync, directory sync where supported, atomic
   rename and full read-back digest validation. Existing exact entries are
   idempotently revalidated. Links/reparse points, non-files, case collisions,
   traversal, unexpected cache entries, partial targets and cross-project path
   reuse fail closed. B1 enforces 32 MiB/package, three digests/plugin and 256
   MiB/project by refusal; it performs no eviction or deletion. Deterministic
   failure injection covers write, pre-rename and post-rename/read-back points.
2. **P2-4B2 — durable first enable (locally complete).** The existing trusted
   `request_workspace_plugin_enable` command will persist one exact enable
   transition before permission work, prepare/cache the package before host
   construction, allocate generation through schema v14, load Wasm and bounded
   Skill text from the verified cache snapshot, stage host/handles/
   contributions while hidden, publish with expected-old `None`, and report
   enabled only after accepted digest/active state commits. A post-publication
   persistence failure closes the route/revokes handles and records or leaves
   recoverable nonterminal truth; it never reports success. Permission-required
   continuation retains the same transition ID/digest/revision.
3. **P2-4B3 — restart reconstruction (locally complete).** Workspace/project startup
   will discover packages disabled first, reconcile nonterminal transitions,
   and reconstruct only durable desired `enabled` + exact accepted digest using
   fresh host/generation/handles. Missing/changed source, invalid cache,
   expired/missing grants or malformed history remains non-routable and becomes
   truthful `blocked`, `update_pending` or permission-required state. A plugin
   recovery failure is audited but cannot block Workspace R or project switch.

B2 is the first user-visible P2-4 slice and therefore must synchronize the
application development version after `0.4.1-dev.4`, update `NEWS.md`, preserve
the existing command/mock inventory, and expose desired/observed/transition
truth without claiming that disable/uninstall/upgrade are available. B3 must
add restart/reopen, A-B-A and two-project installed-smoke probes. Each sub-slice
requires contract review and its own local stop before the next activates.

For B2 the durable order is fixed: discovery upsert → transition request →
preflight → exact cache backup → permission continuation (if any) → durable
generation allocation → hidden candidate/handles/contributions →
`candidate_activated` journal → expected-old contribution publication →
`pointer_swapped` journal → accepted digest/active terminal commit. The same
transition ID is carried through permission-required continuation. Before the
terminal commit, list state may say `enabling` or `permission_required`, never
`enabled`. If any durable write after publication fails, the exact route is
removed and handles invalidated before an error is returned; recovery keeps the
nonterminal transition rather than manufacturing completion.

For B3, startup first performs ordinary permission recovery, then discovers
packages without execution and reconciles lifecycle state before publishing any
plugin route. A nonterminal transition from a prior broker session is closed as
failed/reconciled because no in-memory host, handle or route survives process
restart; reconstruction uses a new transition and strictly higher generation.
Completed desired-enabled state may reactivate only when source directory,
manifest/runtime, accepted digest, immutable cache and all durable project
grants still match. A prior nonterminal first-enable with no accepted pointer
may use its exact pending digest only after the old journal is closed and the
same source/cache/grants revalidate. Terminal denial/crash/blocked state never
auto-retries.

Missing or changed packages stay non-routable and persist Blocked or Update
pending. Missing/expired grants create bounded fresh permission requests on the
new transition but do not activate. Reconciliation returns a bounded per-plugin
report; failures are logged/audited and startup/project switch continues. The
same reconciliation entry point is used by application start, Workspace R
restart and successful project switch. Tests must cover reopen, permission
continuation, post-publication crash recovery, missing/changed/corrupt package,
two projects, A-B-A, one-plugin failure isolation and no generation/host/handle
reuse.

## Enable And Restart

### First enable

1. persist exact enable transition and desired state;
2. rediscover/revalidate manifest, inventory, digest and compatibility;
3. create immutable package backup;
4. complete P2-2 permission decisions and fresh handles;
5. build/activate P2-1/P2-2/P2-3 candidate hidden from routing;
6. transactionally publish contribution generation with expected-old `None`;
7. persist accepted digest/observed active;
8. report success only after durable commit.

Failure before publication leaves disabled. Failure after publication but
before persistence is `completion_uncertain`; recovery compares exact routing
generation, transition journal and package digest before deciding. UI never
guesses active from optimistic state.

### Application/project restart

- discover project packages disabled first;
- load exact durable desired/accepted state;
- same directory, package digest, runtime, manifest contract, policy revision
  and valid grant decisions may create fresh host/generation/handles and
  reactivate;
- missing/changed/unprovable package becomes `blocked` or `update_pending`, never
  silently active;
- a transition left nonterminal is reconciled before routing;
- a previously crashed/hung plugin remains disabled until explicit Retry;
- restart never reuses host IDs, raw handles, Workspace identity, contribution
  leases or activation generation.

Two projects with identical plugin/digest names reconstruct separate hosts,
grants, contributions, desired states and audits.

## Disable And Forced Teardown

Disable order:

1. persist desired disabled + transition;
2. close contribution routing/quiesce;
3. reject new guest/broker calls;
4. cancel/drain in-flight calls within bounded deadlines;
5. cancel permission requests and revoke live handles;
6. dispose P2-3 effects in reverse order;
7. invoke guest dispose under P2-1 limits, then drop Store/Instance regardless
   of guest result;
8. persist stopped/disabled terminal truth.

A trap, hang, cancellation refusal, effect failure or audit failure cannot leave
a route or handle live. Cleanup errors are reported individually; remaining
cleanup continues. If terminal persistence fails, routing stays closed and the
state is `completion_uncertain` for recovery.

### Activated P2-4C contract

P2-4C is divided into three local stops:

1. **P2-4C1 — explicit Disable and exact-host teardown (locally complete).** The trusted
   shell sends plugin ID plus current project revision. Rust persists desired
   disabled before closing routes, then cancels the exact yielded guest call
   where present, cancels that plugin's pending permission requests, revokes
   live handles, disposes contributions, invokes bounded guest quiesce/dispose
   and drops/quarantines the host regardless of guest outcome. Journal phases
   are monotonic through `routing_closed`, `calls_drained`, `handles_revoked`,
   `contributions_disposed`, `host_disposed`, and terminal disabled. Cleanup
   errors are stable-code-only and remaining cleanup continues. A persistence
   failure after route closure returns truthful `completion_uncertain` and never
   restores routing.
2. **P2-4C2 — project switch, Workspace restart and shutdown reuse (locally complete).**
   Replace abrupt `invalidate_project` at trusted lifecycle boundaries with the
   same bounded teardown for every active/pending project plugin; BH2 continues
   after forced quarantine and records uncertainty without waiting forever.
3. **P2-4C3 — crash/hang classification and explicit Retry (locally complete).** Route,
   handle and contribution removal precedes durable crashed/blocked state;
   three crashes in ten minutes block automatic eligibility; only trusted Retry
   creates a fresh exact transition/generation/host/handles.

C1 is user-visible and must allocate the next synchronized development version
after `0.4.1-dev.5`, update NEWS, preserve the dedicated plugin command/mock
inventory, and receive Browser plus packaged installed-smoke evidence. C1 tests
cover already-disabled idempotency, active and permission-pending disable,
in-flight cancellation, guest quiesce/dispose rejection/trap, persistence
failure after route closure, two projects, concurrent disable/call/enable, and
no stale route/handle/contribution or false durable completion.

C2 distinguishes runtime teardown from user Disable. `project_teardown` and
`shutdown` transitions preserve durable desired `enabled` while moving observed
state to terminal `stopped`; this is required so exact packages can reconstruct
on return/restart. They may preserve desired `disabled`, but never revive
uninstalled intent. The completed system transition, exact accepted digest and
stopped state are the evidence B3 requires before reactivation. Every project
boundary enumerates durable/active/pending plugin IDs, attempts the full C1
cleanup independently, forcibly invalidates any plugin whose durable request or
cleanup fails, records a bounded stable-code report, and lets BH2 continue.

Tests cover Workspace restart fresh reconstruction, A→B→A project switching,
shutdown followed by reopen, pending permissions, two active plugins with one
guest failure, transition persistence failure, deadline/forced quarantine, and
the invariant that no old route/handle/host remains after the boundary.

Project switching and application shutdown use the same sequence but are not
held indefinitely: after deadlines the host is forcibly quarantined/dropped,
effects/handles are invalidated, uncertainty is persisted where possible, and
BH2 continues or truthfully reports its own recovery outcome.

## Crash, Hang And Retry

- guest trap/fuel/epoch violation, Wasmtime-contained panic, missed heartbeat,
  invalid ABI output or unexpected host loss closes routing and revokes handles
  before `crashed` is reported;
- broker, Workspace R, Agent R, project selection and other plugin/project hosts
  continue;
- crash diagnostics expose stable code, phase and bounded support detail only;
- no automatic restart loop. User Retry revalidates exact package, grants,
  project and recovery state and creates a fresh generation/host/handles;
- three crashes within ten minutes leave `blocked` until explicit disable/
  review; counters are durable and bounded;
- a crash during a mutating external operation is impossible in Phase 2 because
  all permissions are read-only; network completion uncertainty is still
  recorded and `allow once` is consumed fail-closed when dispatch occurred.

## Recoverable Uninstall

Phase 2 has no install command, so uninstall is an explicit trusted removal of
an already discovered local package from Rho's discovery root. It is not
callable by the plugin or Agent.

UI shows exact project, plugin/version/digest, grants, contributions and the
consequence that project files move to a recoverable Rho trash location.
Confirmation requires the current directory/digest and project revision.

Sequence:

1. complete disable/forced teardown;
2. revoke durable grants and cancel pending requests;
3. revalidate `.rho/plugins` root, exact single-component directory, complete
   inventory/digest, no symlink/reparse/root replacement and expected revision;
4. atomically rename the directory to
   `.rho/plugin-trash/<opaque-transition-id>` within the same filesystem;
5. create tombstone and desired/observed uninstalled state in one recoverable
   transition record;
6. refresh project files/revision and report success after durable truth.

If atomic rename or persistence fails, recovery proves whether the source or
trash path owns the exact digest and restores one truthful state. No recursive
delete occurs in the user action. Permanent deletion is a later BH4 retention
action with expiry, exact tombstone and separate failure recovery. Restore from
trash is explicit and returns the package disabled; it never auto-enables.

### Activated P2-4D contract

P2-4D is divided into three local stops:

1. **P2-4D1 — exact package move/restore foundation (locally complete).** A Broker-owned
   filesystem service accepts only normalized project root, validated
   single-component directory, exact plugin/digest and opaque transition key.
   It revalidates `.rho`, `.rho/plugins`, `.rho/plugin-trash`, source package and
   every inventory entry immediately before an atomic same-filesystem rename.
   Source and trash cannot both own the package; links/reparse points,
   replacement roots, preexisting targets, wrong digest and cross-project keys
   fail closed. Restore revalidates the tombstoned trash inventory and requires
   the original source component to be absent. Deterministic pre/post-rename
   failure points prove idempotent ownership recovery. D1 exposes typed evidence
   only and creates no Store/UI lifecycle truth.
2. **P2-4D2 — trusted Uninstall/Restore commands and tombstone transaction
   (active).** Uninstall confirms exact project revision/directory/digest,
   completes C1 teardown, revokes durable grants, atomically moves to trash and
   records tombstone plus uninstalled state. Restore uses exact tombstone/digest,
   moves back and returns disabled without authority.
3. **P2-4D3 — BH4 retention handoff (locally complete).** Expiry and purge-pending are
   explicit Store transitions; permanent removal uses exact tombstone ownership,
   safe recursive deletion inside trash only, failure recovery and no user-action
   delete claim.

### Activated P2-4D3 contract — 2026-08-21

D3 owns a retention service boundary, not a new user action. It does not infer a
clock policy or silently schedule deletion. A trusted caller must supply an
explicit RFC 3339 cutoff, bounded batch limit, current normalized project and
exact tombstone identity. Product scheduling/policy remains a later BH4-owned
decision; D3 makes the safe transition and purge mechanism available and
testable.

The Store sequence is fixed:

1. one immediate transaction marks only current-project, non-restored,
   non-deleted `recoverable` tombstones with `moved_at <= cutoff` as `expired`
   and appends bounded retention events;
2. exact project/tombstone/plugin/digest/backup-key comparison changes one
   `expired` tombstone to `purge_pending`; replay is idempotent, while
   recoverable/restored/deleted/foreign/mismatched evidence fails closed;
3. only after Broker filesystem evidence proves the exact trash package absent
   does one immediate transaction set `deleted_at`, return the retention class
   to `expired`, and append the terminal event. A persistence failure leaves
   replayable `purge_pending` truth and never recreates the package.

The Broker filesystem sequence is fixed:

- accept only the D1 validated project/plugin/directory/digest/trash key plus a
  derived same-component purge key; re-open real `.rho`, plugins and trash
  roots and reject symlink/reparse/root replacement;
- require discovery source absent, validate the exact trash inventory, rename
  it atomically to the derived purge key, sync the trash directory, then delete
  only that exact quarantined directory using a bounded no-follow tree walk;
- replay after pre-rename, post-rename, mid-delete or post-delete interruption
  proves one of exact-trash, exact-purging or absent ownership. Dual ownership,
  unexpected entries, links/non-files, source collision, digest mismatch,
  foreign project and over-budget trees fail closed;
- never call recursive deletion on `.rho`, `.rho/plugins`, `.rho/plugin-trash`,
  the project root, an unresolved variable/glob, an accepted package cache or a
  restored/discovery package.

D3 tests must cover cutoff boundaries, bounded batches, idempotency,
concurrency, Store failure rollback/reopen, all filesystem interruption points,
two-project isolation, root/link replacement, malformed identity and exact
terminal audit. Installed smoke must prove an uninstalled package can be
expired, made purge-pending, removed only from trash and terminally tombstoned,
while a sibling project and discovery source remain untouched.

D3 is internal and does not change visible application behavior, so the
application remains `0.4.1-dev.8` and `NEWS.md` is unchanged. Its mandatory
stop is source tests, stable/MSRV checks, exact-package installed smoke,
contract review and a local commit before P2-4E activation.

### P2-4D3 local checkpoint — 2026-08-21

The explicit retention/purge mechanism is locally complete:

- Store expiry accepts only a normalized project, caller-supplied canonical
  cutoff and 1–100 batch limit; an immediate transaction changes only eligible
  current-project recoverable tombstones to Expired and appends bounded
  recovery audit. Exact purge request and terminal completion are immediate,
  idempotent transactions with plugin/digest/directory/backup-key comparison,
  failure rollback, reopen retry and concurrent convergence.
- Broker purge refuses any discovery source, validates the full exact trash
  inventory, writes and syncs a deterministic bounded identity marker, renames
  the exact package to a derived purging component, and performs a bounded
  no-follow/reparse-rejecting walk. The small marker is retained as deletion
  evidence, allowing safe post-delete replay and making absent foreign-project
  paths fail closed instead of being mistaken for prior completion.
- Rename-before/after, mid-delete and post-delete interruption tests recover;
  source collision, dual ownership, wrong digest/key/project, link/reparse,
  marker tampering, over-depth trees and sibling-project mutation fail closed.
  The orchestration service fixes Store pending → filesystem purge → Store
  terminal order and exposes no UI, Tauri command, Agent/plugin call or schedule.
- Full Rust workspace tests passed: desktop 256/one opt-in Keychain ignored,
  Store 159, Server 101 library plus one binary, extension-runtime 126 unit/26
  contract/13 discovery/34 lifecycle, and all remaining suites. Stable and
  Rust `1.88.0` all-target checks passed; capped Clippy showed only existing
  broad `StoreError` warnings in affected files. D3 positive/negative contract,
  D2 contract, command inventory, formatting and diff checks passed.
- Source, unpacked App candidate/legacy and read-only mounted DMG
  candidate/legacy smoke all passed the D2 fields plus
  `retention_expired`, `purge_pending_durable`, `exact_trash_purged`,
  `purge_tombstone_terminal`, `purge_sibling_project_preserved` and
  `purge_replay_idempotent`.

The final local D3 rehearsal build remains internal `0.4.1-dev.8` because D3
adds no visible behavior. Its exact unsigned artifacts are:

- arm64 executable: 48,119,984 bytes, SHA-256
  `0ece222d73b0b27a7dca440cdb5f84a7b9fce67bcabbeb7c3cf6236f00070971`;
- DMG: 26,410,028 bytes, SHA-256
  `77d44578c8620f340025940e277a3fb9a8ab7bcd915dfd2f72a21f7bfd79646d`;
- updater archive: 27,153,054 bytes, SHA-256
  `ac134aadb0d1c13934f38f4d8f43abdca0e48cb6edb50b1df76f3cb2aa7275ee`.

The updater signature again uses an ephemeral rehearsal key and does not match
the production public key. No signing, notarization, installation, publication
or release readiness is claimed. D2 Browser visual review and all hosted/
cross-platform installed gates remain open.

D1 tests cover source/trash root replacement, directory/digest mismatch,
symlink/reparse/non-file inventory, preexisting target, rename failure,
post-rename interruption, reopen/idempotency, restore collision and two-project
isolation. D2 is the next user-visible versioned slice, not D1.

### P2-4D1 local checkpoint — 2026-08-20

The recoverable filesystem foundation is locally complete:

- exact project/plugin/directory/digest/trash-key validation and canonical real
  `.rho`, plugins and trash roots precede every same-filesystem rename;
- source and trash dual ownership, neither ownership, wrong digest, traversal,
  symlinked trash, preexisting restore target and cross-project lookup fail
  closed;
- move/restore and replay are idempotent; deterministic before/after-rename
  interruption recovers to one exact owner without deletion;
- rho-server passed 95 library plus 1 binary test, stable and Rust 1.88
  all-target workspace checks, the positive/negative D1 contract and capped
  Clippy with no warning from the new module.

Application version remains `0.4.1-dev.7`: D1 is broker-only and not wired to a
command, Store lifecycle or installed user behavior. D2, hosted and installed
gates remain open.

D2 ordering is fixed: validate confirmation → C1 exact teardown → cancel
pending and revoke every durable grant for that exact plugin/digest → request
uninstall transition with expected accepted digest → D1 atomic move → persist
`package_moved` → atomically insert/replay tombstone and terminal uninstalled
state. If final persistence fails, source remains absent, trash owns the exact
package and the nonterminal transition is recoverable; success is never claimed.

Restore requires the exact recoverable tombstone plus current project revision,
uses D1 restore, then atomically marks `restored_at` and returns desired/observed
disabled with no host, route, pending request or live/durable grant. A stale
directory/digest/tombstone/revision, source collision or foreign project fails
closed. The next synchronized application version after `0.4.1-dev.7`, NEWS,
trusted confirmation copy, mock parity, Browser review and packaged smoke are
mandatory.

### P2-4D2 local implementation checkpoint — 2026-08-21

The trusted recoverable Uninstall/Restore implementation is locally integrated:

- Store terminal completion now uses one immediate transaction for the exact
  `package_moved` uninstall transition, recoverable tombstone, lifecycle event,
  and desired/observed Uninstalled state. Standalone tombstone creation was
  removed from the application service so the product path cannot claim trash
  ownership without the matching transition. Restore atomically marks the exact
  tombstone restored and returns desired/observed Disabled.
- The command validates explicit confirmation, current project revision,
  single-component directory and accepted digest; reuses exact C1 teardown;
  cancels pending permission requests; revokes all active durable grants for the
  exact plugin/digest; revalidates discovery; uses D1 same-filesystem rename;
  persists `package_moved`; and reports success only after terminal Store truth.
  Restore rejects a foreign/stale/deleted/non-recoverable tombstone, source
  collision, live/pending host state or surviving durable grant.
- The trusted UI contains fixed recoverable-Uninstall consequence text and exact
  project/directory/full digest identity, plus a fixed Restore-disabled action.
  Tauri command/mock inventory is 133 commands with exactly one mock handler per
  command. Update, Rollback and permanent purge commands remain absent.
- Application version metadata and browser cache keys are synchronized at
  `0.4.1-dev.8`; `NEWS.md` records the visible behavior. R package versions are
  unchanged because no `rho.bridge` or `rho.agent` contract changed.

Verification completed on local Apple Silicon macOS:

- `cargo test --workspace --all-targets`: desktop 256 passed/one opt-in Keychain
  test ignored; Store 156; Server 95 library plus one binary; extension-runtime
  126 unit, 26 contract, 13 discovery and 34 lifecycle tests; all remaining
  workspace suites passed;
- stable and exact Rust `1.88.0` workspace all-target checks passed; capped
  Clippy completed on both toolchains with only the repository's existing broad
  `StoreError`/legacy warnings and no D2-specific non-baseline warning;
- D2 self-negative/positive contract, Phase 1 acceptance, MSRV, MAC4 and command
  inventory contracts passed; JS syntax and Rust formatting passed;
- source `--smoke-test`, unpacked App candidate/legacy, and read-only mounted DMG
  candidate/legacy all reported `recoverable_uninstall`,
  `uninstall_tombstone_atomic`, `uninstall_package_in_trash`, and
  `restore_disabled_no_authority` true, with project-switch and Workspace-restart
  isolation true.

Local build evidence for the unsigned `0.4.1-dev.8` rehearsal candidate:

- arm64 executable: 48,026,848 bytes, SHA-256
  `19c41128f249705ad75259058be0df1707956a962301fb9f9ae827daa143f1d8`;
- DMG: 26,364,434 bytes, SHA-256
  `100d10912cd5d2fd69a57987d5cf4422e9894cbd1fca8140225e6008541c5dd8`;
- updater archive: 27,122,027 bytes, SHA-256
  `6fa01d252b5f9bb32a5f5bfb5677dfe5413e1dd0e9a6cc0dc75e4e3419ba237c`.

The updater archive used an ephemeral rehearsal key and intentionally does not
match the production updater public key. `codesign --verify --deep --strict`
did not pass for this unsigned local App, so none of this is signing,
notarization, release or publication evidence.

Browser visual review remains explicitly open: the in-app Browser rejected the
local `file://` preview under its URL security policy. The agent did not bypass
that policy or substitute another browser surface. Deterministic preview
evidence hooks and mock parity are present, but they are not recorded as a
visual pass. Hosted/cross-platform installed acceptance and final Phase 2 review
also remain open.

## Upgrade

A changed digest discovered for an active plugin creates `update_pending`; it
does not receive old grants/handles or replace routing.

1. persist transition with exact expected-old/candidate digests;
2. validate candidate package/Manifest/API/dependencies and immutable backup;
3. obtain fresh permission decisions for the candidate digest;
4. activate/evaluate candidate host and contributions hidden from routing;
5. ensure storage is absent and no migration is required in Phase 2;
6. quiesce old generation and close its new-call admission;
7. publish candidate with expected-old CAS;
8. persist accepted/rollback pointers and observed active;
9. dispose old effects/handles/host after old leases drain.

Candidate failure before CAS leaves old active. Stale CAS disposes the loser.
Failure after old quiesce but before candidate publication reopens old routing
only if its exact host/effects/grants remain valid; otherwise both stay closed
and recovery uses the durable accepted pointer. Code never live-patches.

### Activated P2-4E contract — 2026-08-21

E is split into three mandatory local stops:

1. **P2-4E1 — replacement/pointer foundation (locally complete).** Store atomically
   completes an exact `pointer_swapped` Upgrade/Rollback transition by comparing
   project/plugin/transition kind, expected accepted digest, candidate digest,
   and current state pointer; then sets accepted=candidate,
   rollback=expected-old, clears pending, persists the fresh host identity and
   Active terminal event. Runtime preparation loads only a fully verified cache
   snapshot, stages host/handles/contributions hidden, and publishes through
   `ContributionStore::publish(candidate, Some(expected_old_identity))`. No
   command or UI is added.
2. **P2-4E2 — trusted Update (locally complete).** The current discovered changed digest
   is the only candidate. The command confirms current project revision and
   exact expected-old/candidate digests, creates/caches the candidate, obtains
   fresh candidate-digest grants, prepares hidden authority, quiesces/cancels
   the old host, performs expected-old CAS, commits pointer truth, and disposes
   old authority. Candidate denial/failure/stale CAS keeps or reconstructs old
   routing when exact; post-CAS persistence failure closes both and remains
   recoverable. UI/mock/version/NEWS/Browser/packaged smoke are required.
3. **P2-4E3 — trusted Rollback and restart truth (locally complete).** Rollback target is
   exactly `rollback_digest` from verified immutable cache, never an arbitrary
   path. It always creates a fresh generation/host/handles and requires fresh
   permission review for any nonempty permission envelope. Durable rollback may
   run from cache while the newer discovery package remains visible as a future
   Update candidate; restart reconstructs the accepted cached digest without
   granting authority to the changed source. Fixed UI/mock, failure recovery,
   two-project/A-B-A and installed smoke are required.

E1 Store tests cover success/idempotency, wrong kind/phase/digest/project,
concurrent stale completion, event failure rollback and reopen. Runtime tests
cover hidden preparation, expected-old CAS winner/loser, old route preservation
on pre-CAS failure, new route only after CAS, no generation/host/handle reuse,
and post-CAS terminal persistence failure closing the candidate. E1 remains
internal `0.4.1-dev.8`; no `NEWS.md`, command/mock, R package or schema change.
Its local commit is mandatory before E2 activation.

### P2-4E1 local checkpoint — 2026-08-21

The replacement foundation is locally complete without a product command:

- Store now completes only an exact Upgrade/Rollback transition already at
  `pointer_swapped`; one immediate transaction compares expected accepted and
  pending candidate pointers, writes accepted=candidate and
  rollback=expected-old, clears pending, records the fresh host and Active
  terminal event. Wrong kind/phase/project/digest/host is stale or rejected;
  duplicate completion converges, concurrent completion has one winner, and an
  injected event failure rolls back both pointers and reopens cleanly.
- Runtime preparation takes a verified cache snapshot, allocates a strictly
  higher durable generation, creates a fresh host/handles and stages
  contributions hidden. It compares the exact active runtime and contribution
  identity before quiesce, then publishes through expected-old contribution
  CAS. Candidate activation failure preserves the exact old route; success
  replaces it and disposes old authority; terminal persistence failure removes
  candidate routing, invalidates old authority and leaves `pointer_swapped`
  recovery truth rather than reporting Enabled.
- Full Rust workspace tests passed: desktop 259/one opt-in Keychain ignored,
  Store 162, Server 101 plus one binary, extension-runtime 126 unit/26
  contract/13 discovery/34 lifecycle and all other suites. Stable and exact
  Rust `1.88.0` workspace all-target checks passed. The E1 positive/negative
  contract, all prior P2-4 contracts, command inventory, formatting and diff
  checks passed.

E1 adds no command, UI/mock state, schema, R contract, installed user behavior
or version/NEWS impact. Application metadata remains `0.4.1-dev.8`; D2 Browser
visual review plus hosted/cross-platform and final Phase 2 gates remain open.

### Activated P2-4E2 contract — 2026-08-21

The frozen command is `accept_workspace_plugin_update`. Its deny-unknown-fields
input contains only plugin ID, exact expected-old digest, exact discovered
candidate digest and expected project revision. The command holds the project
transition gate and fails stale before mutation. It accepts only durable
desired Enabled + observed Update pending, exact active old runtime, current
discovery candidate and verified immutable candidate cache.

Update order is fixed: validate input/state/discovery → request exact Upgrade
transition → journal preflight/cache backup → plan permissions for the candidate
digest → create fresh requests or prepare candidate immediately → E1 hidden
activation/old quiesce/expected-old CAS/pointer terminal → revoke every active
durable grant for the old digest → report Enabled. Candidate-digest project
grants may exist only if produced by this fresh review; no old-digest grant or
live handle is reused. Permission continuation retains transition ID,
expected-old/candidate digest and project revision.

Deny, request persistence failure, changed candidate, candidate host failure or
pre-CAS stale state leaves the exact old route active and Update pending where
safe. A post-CAS failure closes old and candidate routes and reports recovery
required; success is never inferred. Old durable grants are revoked only after
candidate pointer completion, so a pre-terminal failure can still reconstruct
the accepted old digest.

The fixed UI shows exact old/new digests, project and plugin identity, explicitly
states that this is a local project package rather than marketplace/publisher
update, and uses plugin text only as escaped identity text. Update pending has
one trusted Update action; permission review remains the existing separate
trusted grant surface. Stale, malicious text, keyboard/focus, narrow viewport,
mock parity and one-handler command inventory are required.

E2 is user-visible and must synchronize the next development version after
`0.4.1-dev.8`, `NEWS.md`, frontend cache keys and all version contracts. Tests
cover zero/multi-permission success and denial, old-grant non-reuse/revocation,
changed digest during review, candidate failure, terminal persistence failure,
concurrency, two projects/A-B-A and packaged candidate/legacy smoke. Browser
visual evidence must be attempted and any tool-policy block reported truthfully.
E2 stops at its own local commit before E3 activation.

### Activated P2-4E3 contract — 2026-08-21

The frozen command is `rollback_workspace_plugin`. Input is deny-unknown-fields
and carries plugin ID, exact current accepted digest, exact `rollback_digest`
target and expected project revision. The project transition gate is held. The
current discovery package must still equal the current accepted digest; target
bytes come only from `PluginPackageCache::load_exact` for the same normalized
project/plugin/rollback pointer.

Rollback never reuses an existing durable grant, including a project grant
issued when the target was previously accepted. Every target permission creates
a new trusted request and fresh grant/handle; zero-permission targets may
continue immediately. Permission continuation is typed Rollback with exact
current/target/revision. Success uses E1 hidden activation and expected-old CAS,
then atomically sets accepted=target and rollback=previous current, revokes
current-digest grants and disposes current authority.

On restart/project return, the only source/cache mismatch eligible for cached
rollback reconstruction is the exact durable pair:

```text
accepted_digest != discovered_digest
rollback_digest == discovered_digest
```

The accepted cache must revalidate to the same plugin/manifest/digest. Recovery
then follows the normal fresh generation/host/handle path using target-digest
grants; changed discovery remains visible as Update pending and receives no
authority. Any other mismatch stays non-routable Update pending/Blocked. No
arbitrary cache digest, another project, absent pointer or raw path is accepted.

The fixed Roll back review shows current and target full digests, project and
escaped plugin identity, and states that cached code receives fresh permission
review and a fresh host. It does not imply source-file rollback, marketplace,
publisher/signature or automatic update. Tests cover zero/multi-permission,
forced non-reuse, denial, missing/corrupt/wrong-project cache, stale pointers,
success/failure/CAS, restart and A-B-A/two-project isolation. E3 is visible and
must bump the next development version after `0.4.1-dev.9`, update NEWS/cache
keys/contracts, attempt Browser evidence, pass packaged candidate/legacy smoke,
and stop at a local commit before P2-4F.

### P2-4E3 / P2-4E local checkpoint — 2026-08-21

Exact cached Rollback and the complete E replacement package are locally
complete at application `0.4.1-dev.10`:

- `rollback_workspace_plugin` is deny-unknown-fields, project-transition gated
  and exact revision/current/rollback-pointer bound. Current discovery must
  still equal accepted; the target is loaded only by same-project/plugin/digest
  immutable cache lookup and converted to a typed candidate without a raw path.
- Rollback permission planning deliberately ignores all durable target grants
  and always creates fresh requests. Tests prove a previously accepted target
  receives a different new grant/handle, current-digest grants revoke after
  terminal completion, denial/stale/missing-cache paths preserve current route,
  and zero-permission Rollback advances with fresh generation/host.
- Success reuses E1 hidden activation/expected-old CAS and atomically reverses
  accepted/rollback pointers. Project source stays newer. Restart recognizes
  only the exact durable pair `accepted != discovery && rollback == discovery`,
  revalidates accepted cache, reconstructs fresh authority and continues to
  project the newer source as Update pending; other mismatches remain closed.
- The fixed trusted Roll back review shows full current/target digests, project
  and escaped plugin identity, requires fresh authority, and explicitly states
  source is not rewritten. Mock uses the same fresh permission and pointer
  reversal behavior. Command inventory is 135; no install command/UI exists.
- Full Rust workspace tests passed: desktop 266/one opt-in Keychain ignored,
  Store 162, Server 101 plus one binary, extension-runtime 126 unit/26
  contract/13 discovery/34 lifecycle and all other suites. Stable and exact
  Rust `1.88.0` all-target checks, every P2-4 contract, Phase-1/MAC4/version/
  command contracts, JS syntax, formatting and diff checks passed.
- Source, unpacked App candidate/legacy and read-only mounted DMG
  candidate/legacy smoke passed all prior fields plus
  `rollback_exact_cache_only`, `rollback_fresh_authority`,
  `rollback_pointer_reversed`, `rollback_source_unchanged` and
  `rollback_restart_cached`.

Exact unsigned local rehearsal artifacts:

- arm64 executable: 48,373,456 bytes, SHA-256
  `da78e220b8f238f58cb7b2234c30c0de0295ac34e481a4ac0b67c94e31869bf3`;
- DMG: 26,491,911 bytes, SHA-256
  `6ce01ebd468aa7fdfb341269eed967540180606750a94083bfe541e6c278238a`;
- updater archive: 27,235,343 bytes, SHA-256
  `0e5a91ff498473d7c0bc844683c6b19bd47fe54e67b0712054af5664a5aafb7f`.

The updater signature remains ephemeral rehearsal evidence and is not
production valid. Browser visual review remains blocked by the selected
Browser's local-file URL policy; no retry/workaround/alternate browser was used.
Deterministic preview/mock evidence is not claimed as visual acceptance. D2/E2/
E3 Browser, hosted/cross-platform installed and final Phase 2 gates remain open.

### P2-4E2 local checkpoint — 2026-08-21

Trusted exact local Update is locally complete at application `0.4.1-dev.9`:

- `accept_workspace_plugin_update` is deny-unknown-fields, project-transition
  gated and exact revision/old/candidate bound. The only candidate is the
  currently discovered changed local package; it is revalidated into immutable
  cache before permission or host work. Update pending is also inferred
  truthfully in the list when discovery changed before lifecycle reconciliation.
- Candidate permissions are planned for the new digest. Permission continuation
  retains Upgrade kind, transition, candidate, expected-old and revision. Old
  digest grants/handles cannot authorize the candidate; after terminal pointer
  commit, every active durable old-digest grant is revoked. Denial or candidate
  mutation during review preserves old accepted pointer and route.
- E1 hidden activation and expected-old contribution CAS now back the product
  path. Success commits candidate accepted, old rollback, clears pending and
  uses fresh generation/host/handles. Candidate failure leaves old route;
  terminal persistence failure closes both and retains `pointer_swapped` truth.
- The fixed trusted review surface renders exact full old/new digests, project
  and escaped plugin identity, and explicitly disclaims marketplace, publisher,
  signature, download and automatic-update trust. Mock has one exact command
  handler and fresh candidate permission flow; command inventory is 134.
- Tests cover permission success/deny, changed candidate during review, stale
  revision/old/candidate, old-grant revoke/non-reuse, hidden candidate failure,
  terminal persistence failure, atomic/concurrent Store pointers and exact
  installed Update. Full Rust workspace passed: desktop 263/one opt-in Keychain
  ignored, Store 162, Server 101 plus one binary, extension-runtime 126 unit/26
  contract/13 discovery/34 lifecycle and all other suites. Stable and exact
  Rust `1.88.0` all-target checks, every P2-4 positive/negative contract,
  Phase-1/MAC4/version/command contracts, JS syntax, formatting and diff checks
  passed.
- Source, unpacked App candidate/legacy, and read-only mounted DMG
  candidate/legacy smoke passed all prior fields plus
  `update_local_candidate_only`, `update_expected_old_cas`,
  `update_pointer_durable` and `update_generation_fresh`.

Exact unsigned local rehearsal artifacts:

- arm64 executable: 48,182,272 bytes, SHA-256
  `2cf5700932eca4e60f186735b33c880fbd457f0ded6cabe2ffd4f44d85fb074f`;
- DMG: 26,425,295 bytes, SHA-256
  `f2567807c523cfe8c5e2bf0df9e2f1870ca4df24d76b91c973a5deea80ad2951`;
- updater archive: 27,177,029 bytes, SHA-256
  `10c430fc1e435843c1ca19a7acc3206a099440a116581c418e4112ab133f22ac`.

The updater signature is again an ephemeral rehearsal key and not production
valid. Browser visual review could not be run because the already-selected
Browser blocks this local `file://` preview; policy forbids retrying through a
workaround or another browser surface. Deterministic preview evidence/mock
parity exists but is not claimed as visual acceptance. D2/E2 Browser, hosted,
cross-platform installed and final Phase 2 gates remain open.

## Rollback

Rollback is an explicit trusted action to one retained exact prior digest.

- requires current accepted digest as expected-old and verified cached target;
- builds target as a new generation/host; historical raw handles never return;
- nonempty permission envelopes require a fresh trusted grant review even when
  the target digest was previously accepted;
- publication uses the same CAS/journal as upgrade;
- failed rollback leaves current accepted active when safe, otherwise closed
  with truthful recovery;
- rollback cannot select arbitrary package files, unsigned remote content,
  another project/plugin, or a digest absent from exact cache evidence.

## Transition Recovery

On Store open/project open, reconcile every nonterminal transition before
activation. Recovery uses only durable desired/accepted/pending/rollback
pointers, exact discovery/cache digests and currently routable generation.

Examples:

- backup prepared, pointer old: remove/retain temp under retention; old remains;
- candidate validated, old active: resume or reject candidate; no routing swap;
- old quiesced, pointer old: restore old only if exact state valid, else disabled;
- pointer candidate, publication unknown: reconstruct candidate fresh, never
  infer that old is authorized;
- package moved to trash, tombstone missing: restore source or finish tombstone
  based on exact transition ID/digest, never delete both;
- terminal state persisted, effects leaked: keep routing closed and retry
  idempotent cleanup.

Every recovery action is bounded, idempotent and failure-injected. An
unprovable historical row is disabled/blocked with diagnostics, not repaired by
guessing ownership.

## Trusted Lifecycle UI

Plugins surface shows discovered/disabled/enabling/permission-required/active/
disabling/crashed/blocked/update-pending/upgrading/rollback-pending/uninstalled/
recovery-required states, exact digest changes, grant summary and one truthful
next action.

- Disable, Retry, Update, Roll back, Uninstall and Restore are trusted fixed
  controls; plugin text cannot name/style them;
- destructive Uninstall confirmation identifies recoverable move, not delete;
- progress distinguishes runtime teardown, durable commit and uncertain result;
- stale tabs/actions cannot target a new project/digest/generation;
- keyboard/focus/accessibility, narrow viewport, long Unicode paths/labels,
  malicious content and browser/mock parity are required;
- no claim of marketplace update, publisher trust, signature or automatic
  plugin update.

Proposed commands:

```text
enable_workspace_plugin
disable_workspace_plugin
retry_workspace_plugin
uninstall_workspace_plugin
restore_workspace_plugin
accept_workspace_plugin_update
rollback_workspace_plugin
get_workspace_plugin_transition
```

Exact names freeze only on activation; requests never accept caller-supplied
authority beyond opaque transition/user-intent fields.

## Work Packages And Stop Points

Ordinarily P2-4 activates only after P2-3 acceptance. The owner-approved
local-first exception permits sequential local engineering after the recorded
P2-3E local stop gate while all hosted/cross-platform evidence remains
mandatory before final acceptance:

1. **P2-4A — schema v14 + state/transition/event/tombstone persistence**;
2. **P2-4B — exact package cache + first enable/restart reconstruction**;
3. **P2-4C — disable/project-switch/shutdown/crash/retry**;
4. **P2-4D — recoverable uninstall/restore + BH4 retention handoff**;
5. **P2-4E — upgrade candidate/CAS/backup/rollback**;
6. **P2-4F — exhaustive crash-point recovery + trusted UI/mock**;
7. **P2-4G — three-platform installed acceptance and Phase 2 final review**.

Each is a separate integration boundary with complete vertical tests. No later
slice repairs a half-authoritative earlier commit.

### Activated P2-4F contract — 2026-08-21

F runs one bounded recovery pass before ordinary plugin discovery activation on
application start, Workspace restart, successful project switch and failed-
switch restoration. Its report adds recovered Uninstall, purge, replacement,
recovery-required and project-files-changed counts with bounded per-plugin
stable reason codes; it contains no raw path, handle, credential, payload or
Wasm data.

Recovery rules are exact:

- a nonterminal Uninstall with expected digest + backup key revalidates current
  state/directory and calls D1 `move_exact`. Source ownership finishes the
  requested move; trash ownership replays it. The transition advances to
  `package_moved` if necessary and D2 atomically creates a deterministic
  recovery tombstone plus terminal Uninstalled truth. Dual/neither/wrong
  identity becomes recovery-required and never deletes;
- every exact `purge_pending`, non-restored/non-deleted tombstone replays D3
  purge service. Exact marker/absence completes terminal deletion; failure
  remains purge-pending and recovery-required;
- nonterminal Upgrade/Rollback is closed as restart-reconciled because no host,
  route or handle survives. Accepted remains authoritative. If source differs,
  accepted cache may reconstruct only when the failed replacement transition
  proves accepted-old/candidate-source, or the completed Rollback pointer pair
  already defined by E3. Candidate never gains authority from an incomplete
  CAS journal;
- terminal Uninstalled/expired/deleted facts and already terminal transitions
  are idempotent. Malformed/missing identity, changed cache, missing roots and
  persistence failure never guess ownership and cannot block Workspace R,
  project switch, another project or a sibling plugin.

If recovery actually moves a package source↔trash, the caller advances and
persists project revision before returning the reconciliation event. Replaying
without a new file move does not advance revision again.

The fixed UI projects `recovery_required` with no unsafe action and exposes one
read-only `get_workspace_plugin_transition` command for bounded stable support
state. It distinguishes recovery-required from Blocked/Crashed/Update pending
and never claims completion from UI state. Mock and command inventory stay exact.

F tests inject every recorded phase for enable/disable/uninstall/update/
rollback, package move/purge and terminal event persistence; cover source/trash/
purging ownership, reopen/idempotency, concurrent recovery, two projects/A-B-A,
one-plugin failure isolation, project revision once-only, malicious rows/text,
and packaged candidate/legacy smoke. Because recovery status is visible, F must
bump the next development version after `0.4.1-dev.10`, update NEWS/cache keys/
contracts, attempt Browser evidence, and stop at a local commit before G.

### P2-4F local checkpoint — 2026-08-21

Exhaustive recovery ordering and recovery-required product truth are locally
complete at application `0.4.1-dev.11`:

- every reconciliation pass now begins with bounded nonterminal/tombstone file
  recovery. Incomplete Uninstall deterministically replays source/trash
  ownership and atomic tombstone completion; purge-pending replays the retained
  exact marker; interrupted Update/Rollback is closed and only accepted-old
  cache can reconstruct. The pass runs before ordinary discovery activation and
  failures remain isolated per plugin/project.
- report fields separately count recovered Uninstall, purge, replacement,
  recovery-required and project-file changes. Actual move/purge advances and
  persists project revision once, then wrappers immediately rerun reconciliation
  with the fresh identity. Idempotent replay has no second revision.
- Store recovery-required state/event is exact, idempotent and atomic. Dual or
  neither ownership, missing identity/cache/root and persistence failure remain
  non-routable. UI projects Recovery required with no action/no completion
  claim. `get_workspace_plugin_transition` is project-scoped and read-only; mock
  and command inventory contain exactly one handler among 136 commands.
- Tests cover incomplete source-owned and already-moved Uninstall, purge pending,
  interrupted replacement accepted-cache reconstruction, Store event rollback,
  dual ownership UI state, idempotent replay and exact Update/Rollback recovery.
  Full Rust workspace passed: desktop 270/one opt-in Keychain ignored, Store
  163, Server 101 plus one binary, extension-runtime 126 unit/26 contract/13
  discovery/34 lifecycle and all remaining suites. Stable and exact Rust 1.88
  all-target checks, every P2-4 contract, Phase-1/MAC4/version/command contracts,
  JS syntax, formatting and diff checks passed.
- Source, unpacked App candidate/legacy and read-only mounted DMG
  candidate/legacy smoke passed all prior fields plus
  `recovery_incomplete_uninstall`, `recovery_project_revision_once` and
  `recovery_purge_pending`.

Exact unsigned local rehearsal artifacts:

- arm64 executable: 48,449,072 bytes, SHA-256
  `f8d949ba2c383f65165dbb696d71dbbd1b63207732148793326de4d534ca62b7`;
- DMG: 26,495,483 bytes, SHA-256
  `ee47d4a8112beee4242b7d8a0721f00e0ac7d860da0968d1118875781be48a8d`;
- updater archive: 27,257,004 bytes, SHA-256
  `9bdaf4975d8354df4783cab32f5b30c1eb59a8f86f34d82a450928c91eb7362e`.

Updater signing remains ephemeral and not production valid. Browser visual
review remains blocked by the selected Browser's local-file URL policy, and no
prohibited retry/workaround/alternate browser was used. Deterministic preview/
mock evidence is not claimed as visual acceptance. Browser, hosted,
cross-platform installed and final Phase 2 gates remain open for G.

### Activated P2-4G contract — 2026-08-21

G adds no product behavior. It may add one `workflow_dispatch` trigger to Rust
Compatibility so the exact feature-branch head can run the existing six-leg
stable/MSRV matrix without marking the Draft PR ready or touching main. The job
condition must explicitly admit `workflow_dispatch`; permissions stay
`contents: read`; installed Windows/macOS/Linux stable legs, ephemeral updater
keys, cleanup and existing smoke commands remain unchanged. No release,
notarization, signing secret, artifact publication or deployment is authorized.

Before remote work, G reruns all local contracts, formatting, full Rust/R
affected tests, stable/MSRV checks, candidate/legacy source smoke and final
worktree/diff/security review. It records the exact head and pushes only the
feature branch, reuses any matching PR or creates one Draft PR, then runs/waits
for Draft Fast and the explicit Rust Compatibility workflow on that exact head.
Failures are diagnosed and fixed locally with a new reviewed commit before one
bounded rerun; passing or open external checks are never inferred.

Final review maps every Phase 2 requirement and non-goal to code/tests/evidence,
checks no ambient authority/credential/storage/install/remote-update expansion,
and distinguishes implementation complete, local packaged acceptance, Browser
visual acceptance, hosted six-leg acceptance and Phase 2 final acceptance.

Phase 2 may be marked implemented/accepted only if all mandatory gates are true.
If Browser remains blocked by the selected tool's URL policy, the implementation
and hosted gates may close but final visual/Phase 2 acceptance stays explicitly
open; no workaround or manual claim is manufactured. G then leaves the Draft PR
and exact residual gate for owner/reviewer handoff rather than merging.

### P2-4G hosted Windows compatibility repair — 2026-08-21

The first exact-head six-leg run exposed a Windows stable compiler failure in
the P2-2 `project.fs.read` identity guard: Rust's Windows
`MetadataExt::volume_serial_number` and `MetadataExt::file_index` remain behind
the unstable `windows_by_handle` feature. This is a D1/R3 portability defect,
not new product behavior or authority.

The bounded repair preserves the existing before/opened-handle/after identity
comparison while obtaining the Windows volume serial and file index through
stable `windows-sys 0.60` `GetFileInformationByHandle`. Directory/root probes
request only `FILE_READ_ATTRIBUTES` with `FILE_FLAG_BACKUP_SEMANTICS`; no
generic content read, write/create/truncate, path enumeration or new filesystem
authority beyond exact identity probes is admitted. The P2-2
contract rejects the unstable metadata methods, missing Win32 features,
missing directory-open flag and any write-capable probe. Local macOS tests plus
stable/MSRV Windows-target compilation must pass before the feature branch is
updated; the exact repaired head then receives one bounded Draft Fast and
six-leg rerun under the active G contract.

Initial exact-head run `32454144138` at
`f791abe2eeb3433b1456398688e54d4631c4ca32` passed both macOS legs, both Linux
legs including stable AppImage smoke, and failed both Windows legs only at the
same unstable calls; the stable leg also reported the Windows-only unused
`File` import repaired in this slice. Before commit, the repaired source passed
the P2-2 positive/negative contract, 101 `rho-server` unit tests, current stable
and exact Rust 1.88 `x86_64-pc-windows-gnu` all-target `rho-server` checks, and
candidate plus legacy source smoke. The first run remains failed evidence and
is not composed into the repaired-head acceptance result.

### Owner Phase 2 integration acceptance and visual-gate disposition — 2026-08-21

This later owner decision supersedes G's earlier instruction to leave the PR
Draft when the Browser gate is policy-blocked; intermediate checkpoint records
remain historical evidence and are not rewritten as if visual review passed.

The repaired implementation head
`dbd51d18038820c0ead6f1d3006ef28d164d2df3` passed Draft Fast run
`32456277341` and explicit read-only Compatibility run `32456281744`. All six
macOS arm64, Windows x64 GNU and Linux x86-64 stable/Rust-1.88 legs passed.
Stable legs built and exercised the platform packages: Windows completed NSIS
install, installed candidate/legacy smoke and uninstall cleanup; macOS built,
mounted and smoked App/DMG; Linux built, extracted and smoked AppImage.

Hosted rehearsal hashes are:

- Windows binary
  `6f4e908f02a119c1dc075f90beab106d70dba6f9bebfef419eacca1a6fe357e1`
  and NSIS
  `4c6390b04bd7e768c649a27be8d103e8adae74ef9baf7f8e18dc45a73d480559`;
- macOS binary
  `6a3b4ffa724ab39cd1f456708221255fde5419d2af6f081d2fe93aac3ca7706a`
  and DMG
  `09db0af0bdefba3e4688aadcfa0e8a466fcb371333613aad5299b865b1289388`;
- Linux extracted binary
  `bbe34792d6138a59d4a1c977b47cac37f9314d64525a04514be6c4420996918f`
  and AppImage
  `783632fc58b96d1693e8a1fbdcb07717bcfdb025f2cfe3aa1ce3db6de55a54e3`.

After reviewing that evidence, the owner explicitly authorized direct PR #2
merge to `main` and removed the policy-blocked Browser visual review as a Phase
2 integration acceptance requirement. This does not manufacture a visual pass
or claim the current presentation is final. Visual modularization is a separate
follow-on design stream with its own proposal, component boundaries, visual
acceptance and implementation authorization.

This disposition accepts P2-0 through P2-4 engineering integration only. It
does not authorize release, publication, distribution, production signing,
plugin install/catalog/marketplace, remote plugin update, Phase 2.5 execution,
Phase 3, or visual redesign. The lifecycle-only closeout changes no runtime,
schema, command, application/R-package version, or `NEWS.md` behavior.

### Windows Ready validation critical-path repair — 2026-08-21

The owner authorized direct workflow optimization after exact-head Ready run
`32460167558` passed but took 31 minutes 49 seconds on Windows stable. Step
timing proves the bottleneck: setup took about one minute, locked workspace
validation took 14 minutes 1 second, Windows release/NSIS install acceptance
took 15 minutes 13 seconds, and cache finalization took 1 minute 23 seconds.
Run `32456281744` showed the same two serial 14/15-minute phases, so the delay
is structural rather than a transient runner anomaly.

The bounded repair keeps the six existing macOS/Windows/Linux stable/MSRV
source identities and every command they run. It adds one separate Windows
stable `installed` matrix lane so release build, NSIS install, candidate/legacy
smoke and uninstall cleanup execute in parallel with the Windows stable
`source` lane instead of after its complete workspace tests. The installed lane
uses the same GNU Rust host, Rtools45 path, R 4.6.1/jsonlite setup, ephemeral
updater key, checksum output and cleanup assertions. It has no `needs` edge to
the source lane; the workflow succeeds only when both independent lanes pass.

The first v2 migration run then showed that restoring the historical 1.99 GB
full-target Windows cache took more than nine minutes in all three Windows
lanes. That bridge is therefore rejected rather than normalized as a permanent
cost. Non-Windows caching remains unchanged. Windows cache ownership moves to
fresh lane-specific v3 keys: source stores only Cargo inputs plus
`target/debug/`, installed stores only Cargo inputs plus `target/release/`, and
neither restores the rejected v1/v2 full-target archive. Source and installed
lanes cannot race to publish incompatible debug/release contents under one
immutable key.

Permissions remain `contents: read`; no secret, artifact upload, signing
service, release, publication or deployment authority is added. The repair
changes CI topology and deterministic contracts only, with no runtime, schema,
command, version or `NEWS.md` impact. Acceptance requires positive/negative
workflow-contract tests and a fresh exact-head Ready run whose seven required
lanes pass; measured critical-path improvement is recorded without weakening
any gate.

### P2-4A local checkpoint — 2026-08-20

The schema-v14 persistence boundary is locally complete:

- empty stores and every supported v7-v13 historical schema migrate to v14;
  v12/v13 migrations create no inferred plugin lifecycle facts;
- state, monotonic transitions, bounded lifecycle events, opaque tombstones and
  per-project activation generations are implemented behind explicit-project
  query/mutation services;
- discovery/state/audit and transition/state/audit commits are atomic;
  injected event failures leave no partial durable truth;
- duplicate concurrent request IDs converge to `Applied`/`Unchanged`, competing
  transition IDs converge to `Applied`/`Conflict`, and stale digests fail
  closed;
- current-schema checks reject malformed lifecycle state/event rows, missing
  constraints/indexes/FKs and forbidden live-authority columns;
- complete `rho-store` validation passed: 151 unit, 5 base scenarios, 11
  extended scenarios, 15 mutation scenarios, 2 lifecycle scenarios and 3
  permission scenarios; the P2-4 contract passed in positive and negative
  modes;
- stable Rust 1.97 and MSRV Rust 1.88 all-target workspace checks passed.
  Capped Clippy completed with only the crate-wide pre-existing
  `result_large_err` family; a strict zero-warning Clippy result is not claimed.

Application metadata remains `0.4.1-dev.4`: P2-4A is persistence-only and has
no installed user-visible lifecycle control. Hosted CI and installed-platform
acceptance remain deliberately open.

### P2-4B1 local checkpoint — 2026-08-20

The exact snapshot/cache foundation is locally complete:

- discovery now returns a bounded path-relative inventory only after exact
  project/plugin/digest validation and repeats discovery after the read;
- cached-directory read-back reparses the Manifest, revalidates all declared
  paths and recomputes the complete canonical package digest;
- the Broker cache uses project-hash/plugin/digest isolation, exclusive file
  creation, file/directory sync, same-parent atomic rename, exact read-back and
  current-user read-only sealing;
- identical concurrent prepares converge on one exact target; same plugin and
  digest in two projects receives different project cache keys;
- write, pre-rename and post-rename interruptions, source mutation, symlinked
  cache root, unexpected entries, changed/cross-plugin content and package/
  digest/project bounds fail closed; no eviction or recursive user action was
  added;
- `rho-extension-runtime` passed 126 unit, 26 contract, 13 discovery and 34
  lifecycle tests (199 total); `rho-server` passed 91 library and 1 binary test;
  the B1 contract passed positive and negative modes;
- stable Rust 1.97 and MSRV Rust 1.88 all-target workspace checks passed;
  extension-runtime strict Clippy passed, and capped server Clippy reported no
  warning in the new cache module.

Application metadata remains `0.4.1-dev.4`: B1 is a broker-only foundation and
has no user-visible or installed runtime effect. Hosted and installed-platform
gates remain open.

### P2-4B2 local checkpoint — 2026-08-20

Durable first enable is locally complete at application `0.4.1-dev.5`:

- explicit enable persists discovery, one exact transition and desired state
  before package/permission/host work; permission continuation retains the same
  transition identity;
- activation generation is allocated monotonically from schema v14; Wasm and
  bounded Skill content come from the fully read-back cache snapshot;
- candidate host, fresh handles and contributions remain hidden until the
  candidate journal; first publication requires expected-old `None`; accepted
  digest/active terminal truth commits before Enabled is returned;
- failures before publication persist disabled/failed when possible. Injected
  failure at routing-journal and terminal-commit boundaries removes the exact
  contribution route and invalidates handles, then leaves respectively
  `candidate_activated` or `pointer_swapped` nonterminal recovery truth;
- concurrent identical enable calls converge on one transition/generation;
  changed accepted packages remain `update_pending` and keep the old exact
  route rather than using first enable as an upgrade;
- trusted UI/mock expose desired/observed/transition/accepted state. Browser
  review at 951×811 verified Enabling, Update pending and Blocked are one
  in-viewport modal with exact reason text and no unauthorized action;
- all 235 desktop tests ran: 234 passed and the opt-in disposable-Keychain smoke
  remained explicitly ignored. The complete locked Rust workspace, stable
  all-target and Rust 1.88 all-target matrices passed; all P2-1/P2-3/P2-4,
  version and UI contracts passed. Capped desktop Clippy reported only the
  pre-existing `record_call_event` argument-count warning outside this slice;
- debug candidate/legacy smoke and packaged macOS arm64 candidate/legacy smoke
  both proved `schema_v14_lifecycle`, `exact_package_cache`,
  `durable_first_enable`, generation 1 and completion-after-routing;
- local arm64 artifacts: executable 47,539,008 bytes SHA-256
  `89f20b72300caab1522f70d192b3a5822f631a365814e35544551212be89bc1d`;
  DMG 26,219,179 bytes SHA-256
  `b9ed563b65f9c1268a92ac96cf8af92d6e3b6f746bff5df7421ef9707ad92b66`;
  updater archive 26,966,496 bytes SHA-256
  `c26773e5efa8dd0193122f569018d94ced2c2789bf173c6f87df3105ad20477d`.

The local updater signature used an ephemeral rehearsal key and intentionally
does not match the production updater public key. It is build evidence, not a
publishable update. Hosted CI, Windows/Linux installed acceptance and final
Phase 2 acceptance remain open.

### P2-4B3 / P2-4B local checkpoint — 2026-08-20

Restart and project-open reconstruction are locally complete at
`0.4.1-dev.5`:

- application/Workspace start performs permission recovery before exact plugin
  reconciliation; successful project switch uses the same entry point after
  the target project becomes authoritative;
- a completed exact desired-enabled package with valid project grants gets a
  fresh transition, strictly higher generation, new host and new handles;
  repeated reconciliation of the live exact route is idempotent;
- a prior nonterminal enable is closed as failed/reconciled because process
  authority cannot survive restart, then rebuilt from exact pending/accepted
  digest evidence. Recovery audit uses `recovery`, not a forged user-request
  event;
- allow-once authority is revoked and returns to a fresh bounded permission
  request; valid project grants may be reused only to mint new live handles;
- missing packages, invalid discovery roots and corrupt cache become visibly
  Blocked; changed digests become Update pending; terminal denial/crash/blocked
  state never auto-retries. Durable missing identities remain visible in the
  trusted list even when no package can be discovered;
- reconciliation reports are stable-code-only and capped at 256 entries. One
  invalid plugin does not stop an exact sibling; two-project and A-B-A tests
  preserve independent hosts, caches, states and monotonic generations;
- all 243 desktop tests ran: 242 passed and the opt-in disposable-Keychain test
  remained ignored. The full locked Rust workspace, stable all-target and Rust
  1.88 all-target matrices passed, as did all P2-4 contracts and UI syntax/mock
  checks. The run-history A-B-A concurrency test keeps its exact stale-result
  assertion with a five-second scheduler-only bound after the prior one-second
  bound proved flaky under the full parallel matrix;
- debug and packaged macOS arm64 candidate/legacy smoke both proved restart
  reactivation, generation 2, fresh authority and changed-package
  update-pending behavior;
- final local B3 executable: 47,644,640 bytes, SHA-256
  `ad68abc39f44c4aef8047ea8b2d882a1712d68fe4241100a179e100adf9c5a27`;
  DMG: 26,263,682 bytes, SHA-256
  `63fdad62861fcefefa9028052919aa882d3ad5d988cfa6090898b466ecd97b4a`;
  updater archive: 27,002,967 bytes, SHA-256
  `599b73491d31daa5cb36de2677e8c47550cc3d2c6a46699547c11c099631ee49`.

The updater archive again uses an ephemeral rehearsal signature and is not
publishable. Hosted CI, Windows/Linux installed evidence and all P2-4C+ gates
remain open; P2-4B local completion is not Phase 2 acceptance.

### P2-4C1 local checkpoint — 2026-08-20

Explicit Disable is locally complete at application `0.4.1-dev.6`:

- one revision-bound trusted command persists disabled intent before removing
  the exact contribution generation from routing;
- yielded guest calls are cancelled by their exact request ID; plugin-specific
  pending permission requests are cancelled, live handles invalidated,
  contribution effects cleared, and the guest is quiesced/disposed or forcibly
  quarantined/dropped;
- monotonic lifecycle events record routing close, call drain, handle revoke,
  contribution disposal, host disposal and terminal disabled truth with bounded
  counts. Durable project grants remain reusable facts but the UI now labels
  them `Active grant · not live` after Disable;
- guest dispose trap still reaches durable disabled-with-errors and no route;
  injected lifecycle-event failure after route close yields non-routable
  `completion_uncertain`, preserves the same transition on replay, and never
  claims disabled completion;
- tests cover active, already-disabled, permission-pending, exact yielded call,
  guest trap, persistence failure, concurrent duplicate Disable and two-project
  isolation. All 249 desktop tests ran: 248 passed and the opt-in disposable
  Keychain test remained ignored; extension-runtime 199 tests and the complete
  locked workspace passed, as did stable/Rust-1.88 all-target checks and all
  C1/UI/version contracts;
- Browser review at 951×811 verified the sole Enabled action is Disable; after
  activation it shows durable `disabled/disabled`, removes the action, disables
  all contribution controls, exposes no raw handle, and shows active durable
  grants as not live in one in-viewport modal;
- debug and packaged macOS arm64 candidate/legacy smoke both proved explicit
  Disable, route closure, host disposal and durable terminal truth;
- local C1 executable: 47,670,592 bytes, SHA-256
  `d6b3a70cdf0478414e37065fafb29b9d70bf701ac7c213ba3e50fc227cdb82cf`;
  DMG: 26,276,236 bytes, SHA-256
  `4257fa455a4993f6bab5a54200fab4f4c22410063c65af9083d4738400ae38ed`;
  updater archive: 27,020,485 bytes, SHA-256
  `a00646550cd3c4b84ac869df660ae5e721a0003cf7c56a95be4960ec6e054854`.

The updater signature is rehearsal-only and not publishable. C2 project/
shutdown reuse, C3 crash/Retry, hosted CI and Windows/Linux installed evidence
remain open.

### P2-4C2 local checkpoint — 2026-08-20

Boundary teardown reuse is locally complete at `0.4.1-dev.6`:

- `project_teardown` and `shutdown` now preserve desired enabled/disabled while
  moving runtime truth to stopped; B3 reactivation requires that exact completed
  system transition and accepted digest before creating fresh authority;
- Workspace restart and shutdown call the same per-plugin C1 teardown before
  process/session disposal. Project switch tears down the previous project only
  after target preparation succeeds, reconciles the target after commit, and
  reconciles the old project again after a failed switch is restored;
- boundary reports are capped, stable-code-only and include completed,
  uncertain and forced counts. Transition insertion or one guest cleanup
  failure forcibly removes routes/handles and does not stop other plugins or
  BH2;
- tests cover stopped-intent reconstruction, three plugins with one dispose
  trap plus one pending permission, transition persistence failure, project
  switch and shutdown regressions. The full locked workspace passed with 252
  desktop tests (251 passed, one opt-in Keychain test ignored), stable and Rust
  1.88 all-target checks, Store lifecycle tests and the C2 contract;
- debug and packaged candidate/legacy smoke prove boundary teardown reuse,
  enabled-intent preservation and fresh reactivation;
- local C2 executable: 47,755,296 bytes, SHA-256
  `59b5090f7b299e2b03dc9515921322a9a9be622ffc3e099e4930bf9ea77e9105`;
  DMG: 26,298,155 bytes, SHA-256
  `4e9a163bbe6d15e14457ed33b7f5268454892390a53aa458f0e03a7f00b7d6ca`;
  updater archive: 27,047,570 bytes, SHA-256
  `fd96ae1fa6363d130fa33b1dd03b67ac65d40471d9721e8fa0ddc854a1052912`.

The updater signature is rehearsal-only. C3 crash/Retry, hosted CI and
Windows/Linux installed acceptance remain open.

### P2-4C3 / P2-4C local checkpoint — 2026-08-20

Crash/hang classification and explicit Retry are locally complete at
`0.4.1-dev.7`:

- contribution/direct-call guest failures and the periodic broker-owned
  heartbeat sweep remove exact routes/handles before recording crash truth;
  heartbeat calls run under the existing Wasmtime fuel/epoch bounds;
- crash writes verify current project, accepted digest and host session, append
  stable `host_quarantined` audit and derive the ten-minute count from SQLite;
  crash three persists Blocked/`crash_loop_blocked`. A crash-event persistence
  failure leaves the route closed and falls back to durable Blocked recovery;
- trusted Retry accepts only exact desired-enabled Crashed state. It uses kind
  retry, revalidates source/cache/grants, allocates a higher generation and new
  host/handles, or returns to permission review. Blocked exposes only Disable;
- tests cover three-crash loop, stale host identity, heartbeat trap, crash
  persistence injection, Retry generation/permission behavior, guest resume
  trap and restart refusal for crashed/blocked. The full locked workspace passed
  with 255 desktop tests (254 passed, one opt-in Keychain test ignored), 152
  Store unit tests, stable/Rust-1.88 all-target checks and all C3/UI/version
  contracts;
- Browser review at 951×811 verified Crashed has only Retry, Retry returns to
  active plus Disable without raw handles, and Blocked has only Disable in one
  in-viewport modal;
- debug and packaged candidate/legacy smoke prove durable crash state,
  heartbeat-timeout classification, fresh Retry authority and third-crash
  blocking;
- local C3 executable: 47,800,032 bytes, SHA-256
  `497c74ed8e483a0bc911caf72d3b7fe7bdd16ca6de565e51ef2895e9d6338fb6`;
  DMG: 26,309,703 bytes, SHA-256
  `791a4eb3cf2f108cfc6632d76d5d73304d002727701ea58f49dd9f6cec5f3c35`;
  updater archive: 27,058,374 bytes, SHA-256
  `bc31e6d87de44a7fde445d6b993542a0797f11c69ea001b7a499d9671644104f`.

The updater signature is rehearsal-only. P2-4D+, hosted CI and Windows/Linux
installed acceptance remain open; local C completion is not Phase 2 acceptance.

For C3, every host trap, invalid ABI/guest output, fuel/epoch violation,
heartbeat timeout or unexpected loss first removes the exact contribution route
and invalidates live handles, then atomically records `host_quarantined` plus
observed `crashed`. Crash count is derived from durable events for the exact
project/plugin in the preceding ten minutes; the third event records
`crash_loop_blocked` and observed `blocked`. A stale host/digest cannot record a
crash for the current generation. Failure to persist crash truth never restores
the removed route.

Trusted Retry is accepted only for desired-enabled observed-crashed state with
the unchanged accepted source/cache digest. Blocked, disabled, update-pending,
missing or foreign state rejects. Retry uses kind `retry`, a new transition,
strictly higher generation, fresh host/handles and current grants; missing grants
return to permission review. Successful Retry returns active and clears the
current error but does not erase crash audit history. C3 allocates the next
synchronized application development version after `0.4.1-dev.6`, updates NEWS
and mock/UI/installed evidence. Tests cover each crash class, stale identity,
three-in-window block, two projects, persistence failure, Retry success/failure,
permission review, concurrent crash/Disable/Retry and restart never auto-retrying
crashed or blocked state.

## Verification Matrix

Required automated evidence covers every state/transition and crash point:
success, invalid/policy denial, stale project/digest/revision/generation/host,
persistence failure, cancellation, timeout, panic/trap, duplicate/idempotency,
restart/reopen, two projects, two plugins, same IDs/paths, A-B-A switch, rapid
disable/enable/update, revoke during call, partial effect disposal, backup copy/
fsync/rename/digest failure, source/trash/cache root replacement, disk full,
malformed historical rows, cache eviction bounds, expected-old CAS losers,
rollback failure and no false completion.

Full source evidence includes Store historical migrations, extension runtime,
broker/desktop integration, command inventory, frontend/mock, R suites,
stable/MSRV all-target workspace and independent security/recovery review.

Installed Windows x64, macOS arm64 and Linux x86-64 acceptance runs hostile
fixtures for no ambient authority, enable/restart, grant, Tool/Source/Skill/
Command/Viewer, project switch, crash/hang, disable, update rejection/success,
rollback, uninstall/restore, app restart and clean removal. Exact candidate
hashes and evidence are required; browser/source tests cannot substitute.

## Phase 2 Final Acceptance Audit

Before lifecycle status advances to implemented/accepted, audit every Definition
of Done item in the active Phase 2 design against exact source, tests, installed
artifacts and the recorded owner disposition for any manual visual gate. P2-0
through P2-4 documents, roadmap and cross-review matrix must distinguish
implementation, hosted validation, installed acceptance, visual-design scope
and release decision.

Phase 2 acceptance explicitly excludes marketplace, publisher signatures,
catalog, global plugins, remote code/update, write/process/arbitrary R,
credentials, Provider/runtime contributions, generic plugin storage and
Agent-authored evolution.

## Version, NEWS, And Release

P2-4A persistence contracts alone do not change a version. The first
user-visible P2-4 candidate uses a fresh application development version after
`0.4.1-dev.4` and truthful NEWS. R packages bump only for exported bridge
changes.

Final Phase 2 acceptance is not public release authority. A separate release
contract selects an exact clean commit, builds immutable artifacts, completes
installed/manual evidence and records GO/NO-GO. Phase 3 remains separately
proposed.
