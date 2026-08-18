# P1-1 Internal Extension Runtime Lifecycle Specification

Status: active; P1-1 authorized 2026-08-18; implementation pending

Date: 2026-08-18
Authorization: after accepting the P1-0 and CI-FAST1 stop gates, the user
explicitly authorized continued P1 development; under the accepted package
discipline this activates P1-1 only

Owning architecture:
[`accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md`](../design/accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md)
Predecessor:
[`active-2026-08-18-p1-0-extension-runtime-contracts-spec.md`](active-2026-08-18-p1-0-extension-runtime-contracts-spec.md)
PR: [#75](https://github.com/YuLab-SMU/Rho/pull/75)
Upstream baseline: `95d7d2c7774519ef956637aeff678ed4f2752ab5`
P1-1 branch baseline: `f5b85519d63d6bd9e4778cff1659764ecdb7e692`

Change class: D3 shared lifecycle and project-switch architecture
Risk: R3 project identity, concurrent publication, cancellation, resource
cleanup, shutdown, and failure recovery
Authorized work package: `P1-1`
Mandatory stop: lifecycle/project-switch implementation, local/fast-CI
verification, independent contract review, and explicit P1-2 authorization

P1-2, P1-3, and P1-4 are not authorized by this contract.

## Purpose

P1-1 turns the pure P1-0 graph contract into a host-owned lifecycle runtime for
compiled-in first-party plugins. It adds reversible effects, transactional
activation, scope trees, candidate publication, quiesce/dispose, bounded broker
calls, task cancellation, and typed diagnostics.

The only desktop integration is an empty extension scope following existing
application/project lifecycle. No user capability moves into the runtime. The
default remains legacy, so candidate mode must produce no user-visible
difference.

## Non-Goals

P1-1 does not:

- migrate Run History, Workspace Snapshot, Project File Viewer, Agent tools,
  commands, viewers, panels, services, or sources;
- change a Tauri command, command schema, browser/mock handler, frontend state,
  project response shape, SQLite schema, R package, or public protocol;
- add dynamic discovery, `inventory`, third-party code, Wasm, Extism, Wasmtime,
  WASI, Tauri Plugin, JavaScript loading, marketplace, or public SDK behavior;
- implement Execution Targets, runtime hosts, Compute Environments, Jobs,
  Conda, containers, SSH, Slurm, or remote transport;
- create a second project identity, project transition gate, approval lane,
  process supervisor, durable store, policy engine, or credential path; or
- make candidate mode the default.

## Cross-Review And Authority

### BH2 project switching

`accepted-2026-07-29-bh2-b-switch-commit-recovery-spec.md` remains the sole
authority for:

```text
preflight → workspace root → watcher → store root → last-opened/UI publication
```

P1-1 cannot reorder, duplicate, or weaken that chain. The extension candidate
is prepared inside the existing `project_transition_gate` after blockers and
target validation but before the first BH2 side effect. BH2 failure recovery
continues to restore workspace/store/watcher/UI truth exactly as today.

### Agent/conversation admission

`active-2026-08-09-agent-conversation-concurrency-spec.md` retains ownership of
turn, approval, Workspace/file claim, cancellation, and project-switch blocker
admission. Extension task/lease tracking is internal to one extension scope and
does not replace those broker blockers.

### Trusted Kernel and transport

ADR-002/ADR-003 and the current broker/coordinator remain authoritative for
processes, Workspace R, Agent R, store access, policy, approvals, credentials,
project identity, revisions, filesystem/network execution, and transport.
`BrokerFacade` is only a bounded adapter contract over those existing owners.

### CI and compatibility

CI-FAST1 owns Draft feedback. P1-1 requires exact-head Rust Fast, focused/local
MSRV evidence, and affected local workspace validation. The six-leg hosted
matrix remains deferred to P1-4/Ready as explicitly directed by the user.

No ownership, persistence, approval, schema, or public-contract collision
remains inside P1-1.

## Dependency Contract

Add only:

| Dependency | Feature/version contract | Purpose | Review |
| --- | --- | --- | --- |
| `arc-swap` | workspace `1.x`; no optional feature | lock-free active `Arc` snapshot publication | current 1.9.2; MIT OR Apache-2.0; maintained upstream; Rust 1.88 compile is mandatory because crate metadata declares no MSRV |
| `tokio-util` | direct workspace `0.7`, `default-features = false`, `features = ["rt"]` | `CancellationToken` and `TaskTracker` | already locked at 0.7.18; MIT; declared Rust 1.71; maintained Tokio project |
| `tokio` | existing workspace dependency | async mutex/notify/timeouts/tests | already workspace-owned; no new feature change |

`tokio-util` is already transitive in the lockfile, but P1-1 makes the `rt`
feature a direct owned dependency. Lockfile churn must be limited to `arc-swap`
and any unavoidable new transitive entry. No `async-trait`, `futures-util`,
`tracing`, or alternative runtime dependency is authorized.

Context7 verification on 2026-08-18 established:

- `ArcSwapOption<T>` is `ArcSwapAny<Option<Arc<T>>>`;
- `compare_and_swap` returns the previous pointer regardless of success, so Rho
  must determine success by pointer identity and never value equality;
- `CancellationToken::cancel()` propagates to children and guarantees all are
  cancelled when it returns;
- `TaskTracker::wait()` completes only when the tracker is closed and empty;
  and
- `TaskTracker::close()` does not prevent later `spawn` calls.

Therefore Rho owns a separate task-admission gate. Closing the tracker is not
accepted as rejection of new tasks.

## Public-Within-Workspace Lifecycle API

Object-safe first-party contracts:

```rust
trait InternalPlugin: Send + Sync {
    fn descriptor(&self) -> &PluginDescriptor;
    fn activate<'a>(&'a self, ctx: PluginContext<'a>)
        -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>>;
}

trait Disposable: Send {
    fn dispose<'a>(&'a mut self)
        -> Pin<Box<dyn Future<Output = Result<(), DisposeError>> + Send + 'a>>;
}
```

Activation returns no disposer. Every registration/resource must enter the
current `EffectSink` immediately. The sink is not clonable and is committed to
the scope only after plugin activation succeeds.

`PluginContext` exposes only:

- host-owned `RegistryHub`;
- object-safe bounded `BrokerFacade`;
- the current `EffectSink`;
- typed `DiagnosticSink`;
- `CancellationToken`; and
- a Rho task facade backed by `TaskTracker` plus an independent admission gate.

No raw coordinator, store, Tauri handle, socket, process, filesystem handle,
credential, DOM object, or plugin concrete implementation is exposed.

## Bounded Broker Contract

Generic broker calls contain a validated `OperationId` plus a serde JSON
payload serialized and byte-checked before dispatch.

Limits:

- generic request/response: 1 MiB;
- Workspace Snapshot response class: 2 MiB; and
- Project File Viewer HTML class: the existing 32 MiB ceiling.

P1-1 provides the typed bounds and rejection errors only. It does not wire an
actual broker operation. Oversize and malformed response paths fail truthfully
before a plugin can consume the value.

## Effect Contract

Each effect record binds:

- plugin instance (`PluginId + ScopeIdentity`);
- scope kind/ID and activation generation;
- monotonically increasing creation order within that plugin activation;
- `registered | disposing | disposed | failed` state; and
- bounded cleanup error/timeout detail.

Rules:

- stacks dispose in reverse creation order;
- activated plugins roll back/dispose in reverse activation order;
- a second or concurrent dispose returns the already recorded report and never
  invokes a disposer twice;
- one failure or timeout does not stop later cleanup;
- timeout drops the in-flight cleanup future, marks the effect failed/leaked,
  and never retries it implicitly;
- any failed/leaked effect makes the final report `failed` with exact effect
  details; and
- failed cleanup never reopens routing or returns a scope to active.

## Registry, Lease, And Task Admission

A scope-local routing gate starts closed for a candidate. Publication opens it.
Quiesce closes it before cancellation.

Lease admission uses check/increment/recheck so a close racing acquisition
cannot leave a newly accepted lease. Existing leases are counted and wake the
quiesce waiter on drop.

The Rho task facade owns an atomic `accepting` flag in addition to
`TaskTracker`. Its `spawn` path checks admission before registering a task.
Quiesce first closes this flag, then calls `TaskTracker::close()`. Tests must
prove that raw Tokio semantics would allow spawn-after-close while the Rho
facade rejects it.

## Scope Tree And State

`ScopeManager` owns the Phase 1 host policy:

```text
application
  └── project
        ├── workspace
        └── agent
```

It issues non-zero monotonically increasing activation generations, validates
parent identity through P1-0 `ScopePolicy`, and attaches children only to their
validated parent. Plugins cannot create/register/reparent a scope kind.

One scope snapshot contains immutable identity/plan plus scope-local registry,
cancellation, task tracking, activated plugin effect stacks, children, and
serialized lifecycle state:

```text
ready → active → quiescing → disposing → disposed | failed
```

Candidate activation is invisible while `ready`. Publication is the only path
to `active`.

## Candidate Activation And Publication

Activation:

1. resolve the complete P1-0 graph;
2. create closed registry/routing/task state and cancellation token;
3. activate plugins in stable plan order;
4. record effects immediately;
5. on plugin failure, dispose its recorded effects, then previously activated
   plugins in reverse order; and
6. return a ready snapshot only after all plugins succeed.

Each active slot uses `ArcSwapOption<ScopeSnapshot>`. Publication receives an
expected old `Option<Arc<ScopeSnapshot>>` and a ready candidate:

1. call `compare_and_swap` with the expected pointer;
2. compare the returned old pointer by `Arc::ptr_eq`/null identity;
3. on success, open candidate routing and return the old snapshot for teardown;
4. on failure, keep the actual winner untouched, rollback/dispose the rejected
   candidate, and emit a stable CAS diagnostic.

Value equality, scope ID equality, or generation equality cannot substitute
for pointer identity. A late generation never overwrites a newer winner.

## Quiesce And Dispose Order

Default injectable deadlines:

- routing/task/lease quiesce: 5 seconds;
- one effect: 2 seconds; and
- total scope disposal: 10 seconds.

Order is fixed:

1. enter `quiescing`;
2. close routing and reject new calls/leases/tasks;
3. call `TaskTracker::close()`;
4. cancel the scope token;
5. boundedly wait for tracked tasks and existing leases;
6. quiesce/dispose children in reverse attachment order;
7. dispose dependent plugins in reverse activation order;
8. dispose each effect in reverse creation order; and
9. finish `disposed` only with no reported leak, otherwise `failed`.

The scope remains non-routable after every failure path.

## Runtime Mode

The host reads private `RHO_INTERNAL_EXTENSION_RUNTIME` once:

```text
legacy | candidate
```

- missing value: `legacy`;
- `legacy`: current product behavior;
- `candidate`: empty P1-1 extension scopes follow application/project
  lifecycle; and
- any other value: `legacy` plus one typed bounded diagnostic.

The mode is not persisted, returned by a command, or exposed in UI/browser
mock state. P1-1 through P1-3 default to legacy.

## Desktop Integration And BH2 Sequencing

`AppState` owns one `ExtensionHost`. Setup constructs/publishes an empty
application scope. Application shutdown quiesces/disposes the extension tree
before process exit; cleanup failure is logged but cannot resurrect routing.

Legacy project switching remains byte-for-byte on its current path.

Candidate-mode project switching, inside the existing transition gate:

1. run existing blocker/target validation;
2. load the expected current extension project snapshot;
3. build a complete empty target project candidate with a host-derived bounded
   scope ID and fresh generation;
4. only then begin the unchanged BH2 workspace/watcher/store/last-opened/UI
   sequence;
5. if Workspace, watcher, store, or last-opened recovery fails, rollback the
   unpublished candidate before returning the existing BH2 result;
6. after the existing project state commits, CAS-publish the candidate;
7. on CAS success, quiesce/dispose the old extension project scope;
8. on CAS failure, dispose the losing candidate and retain the newer winner;
   never overwrite it or roll project authority backward; and
9. report extension cleanup/CAS diagnostics without changing existing project
   response schema.

An injected candidate activation failure occurs before Workspace/store/watcher/
UI mutation and returns an error with the old project and extension generation
untouched. With the real empty inventory, activation is deterministic and no
such product failure is expected.

## Diagnostics

Extend `ExtensionDiagnostic` with typed lifecycle codes and bounded context for
activation, rollback, publish CAS, quiesce, task/lease timeout, disposal, and
invalid runtime mode. A `DiagnosticSink` receives records synchronously; the
desktop adapter forwards them to existing startup logging/event facilities.

No direct `tracing` dependency, durable table, public event, credential,
absolute project path, raw payload, or unbounded error is introduced.

## Test Matrix

Pure/synthetic runtime tests:

- activation success;
- failure before any effect and after multiple effects;
- rollback across dependent plugins in exact reverse order;
- registration ownership and duplicate rejection;
- double/concurrent dispose idempotence;
- one cleanup failure continuing the remaining stack;
- per-effect timeout and total-scope leak reporting;
- routing/lease/task rejection before cancellation;
- cooperative task cancellation/drain and non-cooperative timeout;
- `TaskTracker::close()` caveat protected by Rho admission;
- child-before-parent and dependent-before-provider teardown;
- CAS success, stale expected-old race, rejected-candidate rollback, and newer
  winner preservation;
- late generation rejection and A/B/A switch order;
- two project scopes with identical contribution IDs remaining isolated;
- application shutdown cascade;
- generic 1 MiB and Workspace 2 MiB boundary/over-limit payloads;
- invalid runtime mode falling back to legacy with one diagnostic; and
- deterministic diagnostics/reports across equivalent activation inventories.

Desktop/BH2 tests:

- legacy switch path unchanged;
- candidate empty A→B and A→B→A generation isolation;
- candidate prepared before BH2 side effects;
- watcher, store-root, and last-opened failure roll back candidate and preserve
  previous active scope/project;
- injected candidate activation failure touches no Workspace/store/watcher/UI
  state;
- CAS race does not overwrite a newer generation;
- shutdown disposes project before application; and
- existing full project-switch, blocker, failure-recovery, and two-project
  tests remain green.

No browser/mock change is expected because P1-1 adds no Tauri command or
visible state. `desktop/dist/app.js` syntax is still checked; a mock edit would
be a contract deviation and requires review.

## Verification

Required local checkpoint:

```text
cargo fmt --all -- --check
cargo test -p rho-extension-runtime --locked
cargo +1.88.0-aarch64-apple-darwin test -p rho-extension-runtime --locked
cargo test -p rho-desktop --bin rho-desktop --locked
cargo check --workspace --all-targets --locked
cargo test --workspace --locked --no-fail-fast
node --check desktop/dist/app.js
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
git diff --check
```

Exact-head Rust Fast is the hosted Draft gate. The six-leg matrix remains
deferred to P1-4/Ready.

## Version, NEWS, And Release Impact

P1-1 defaults to legacy, activates only empty internal scopes in opt-in
candidate mode, adds no user capability, and changes no public/distributed
contract. No application or R package version bump and no `NEWS.md` entry are
required.

No candidate, installer, installed-app, signing, publication, or release
decision is authorized.

## Definition Of Done

- lifecycle, rollback, generation, bounds, diagnostics, and cleanup match this
  contract;
- BH2/Agent ownership and switch ordering are unchanged;
- candidate mode is empty and user-equivalent to legacy;
- all focused/affected tests and exact-head Rust Fast pass;
- independent review has no blocking lifecycle, project-isolation, cleanup,
  credential, or authority finding;
- actual deviations, unrun checks, dependency versions, worktree, commit, and
  version/NEWS decision are recorded;
- this document remains active because P1-2 through P1-4 are incomplete; and
- work stops for explicit P1-2 authorization.
