# P2-4 Plugin Lifecycle, Recovery, Uninstall And Upgrade

Status: active under the owner-approved local-first exception; P2-4A schema v14
state/transition/event/tombstone persistence activated 2026-08-20 after local
P2-3E closeout; P2-1/P2-2/P2-3 hosted and cross-platform installed gates remain
open and mandatory before final Phase 2 acceptance

Active work package: P2-4A only. P2-4B through P2-4G remain inactive until the
v14 migration/persistence/recovery stop gate passes. P2-4A creates no package
cache, live restart activation, disable/uninstall/upgrade route, UI or new
privileged operation.

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
artifacts and manual UI evidence. P2-0 through P2-4 documents, roadmap and
cross-review matrix must distinguish implementation, hosted validation,
installed acceptance and release decision.

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
