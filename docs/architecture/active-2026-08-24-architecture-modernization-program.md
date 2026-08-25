# Rho Architecture Modernization Program

```json
{
  "schema_version": 1,
  "record_type": "program",
  "program_id": "AM-2026",
  "status": "active",
  "current_wave": 2,
  "authorized_at": "2026-08-24",
  "authorized_by": "repository owner",
  "authorization_source": "2026-08-24 instruction to implement the architecture modernization plan",
  "active_work_packages": ["AM-W2-30"],
  "integration_lane": "AM-W2-30",
  "base_commit": "9a5da6dfb7bf9a50a42bff02dac63f2c2c28dc52"
}
```

Status: active D3/R3 architecture program; Wave 0 control-plane package
authorized 2026-08-24

Date: 2026-08-24

Owner: repository architecture modernization integration lane

Next mandatory checkpoint: each work package's relevant local correctness
checks and truthful evidence record. Bounded child packages covered by this
owner-authorized program activate automatically when their declared dependency
and ownership conditions are true; another human waiting point is required only
for product choice or authority expansion outside this contract.

## Purpose and problem evidence

Rho's accepted architecture remains sound, but several implementation seams no
longer scale safely: command registration has drifted from its checked summary,
large composition files aggregate unrelated authorities, frontend project
activation mutates an external controller during React render, synchronous
coordination boundaries serialize unrelated work, Rust/TypeScript IPC contracts
are repeated manually, and layout and plugin ABI mechanics are expensive to
extend safely.

This program owns the staged removal of those implementation constraints. It
also owns a repository-local tracker so new findings, work-package ownership,
verification, and residual risk remain auditable while the program runs.

The baseline is clean local `main` at
`9a5da6dfb7bf9a50a42bff02dac63f2c2c28dc52`, ahead of `origin/main` by 25
commits. The first reproduced defect is a real command-inventory digest failure:
the registered handler digest is `61fa2ca8...`, while the checker expects
`ec479252...`; the self-test passes and `rsr:check` does not currently run either
the self-test or the repository check.

## Authority and cross-review

This program is subordinate to:

- `docs/project/active-development-governance.md` for lifecycle and evidence;
- accepted ADRs, especially broker/store single-writer and identity boundaries;
- `docs/design/accepted-2026-08-21-plugin-native-surface-runtime-design.md` for
  Scene, Surface, Runtime binding, revision, focus, and accessibility authority;
- `docs/plans/active-2026-08-24-runtime-output-agent-context-closed-loop-spec.md`
  for durable output and Agent-context ownership;
- implemented Phase 2 plugin contracts for identity, digest, grants, quarantine,
  recovery, and the no-ambient-authority boundary;
- `docs/plans/active-2026-08-10-rust-msrv-build-contract.md` for the rolling
  pinned Rust toolchain and locked-build validation;
- active release and platform documents for candidate-specific evidence.

The program owns implementation topology, generated IPC type ownership,
concurrency-lane decomposition, workbench projection composition, layout
adapter mechanics, the additive component ABI, and modernization governance.
It does not own scientific truth, project identity, approval, credentials,
permissions, durable Scene revisions, Runtime execution admission, release
acceptance, signing, installers, publication, or update channels.

Only one project-level row is maintained in
`docs/project/active-document-cross-review.md`. Detailed status belongs to the
records under `docs/architecture/modernization/`.

## Compatibility and authority invariants

1. Rho remains one desktop application; this program does not introduce
   microservices or a second project, approval, permission, scientific-state,
   or persistence authority.
2. Existing Tauri command names and JSON shapes remain compatible during IPC
   migration. New projection commands are additive until their replacement
   gates pass.
3. Rust remains authoritative for project identity, revision/CAS rejection,
   Runtime, Resource, Profile, Scene, Surface, and durable Store state.
4. Layout libraries own rendering and gestures only. Generated bindings own
   code generation only. WIT owns guest/host types only. None gains broker
   authority.
5. Store modularization does not imply a schema migration. Plugin Manifest V4
   is a separately reviewed package-protocol change.
6. Core ABI V2 remains supported throughout this program. Component ABI is
   additive.
7. Browser/mock mode changes in lockstep with Tauri command and visible-state
   changes.
8. No package, push, PR, signing, installation, publication, or release action
   is authorized by this document.

## Record and state model

Every record is Markdown whose first fenced block is strict JSON. The validator
rejects duplicate IDs, missing fields, unknown references, invalid transitions,
non-deterministic ordering, and status claims unsupported by history or
evidence.

Finding states are `observed`, `triaged`, `active`, `verifying`, `resolved`,
`deferred`, and `needs_authorization`. Normal progression is
`observed -> triaged -> active -> verifying -> resolved`; the two terminal
side-lanes require an explicit history reason.

Work-package states are `proposed`, `ready`, `active`, `verifying`,
`implemented`, `paused`, and `blocked`. Normal progression is
`proposed -> ready -> active -> verifying -> implemented`. `paused` may resume
to `active`; `blocked` requires a recorded blocker and cannot be reported as
implemented.

Dynamic discovery follows these rules:

- a finding that invalidates the current package's data, project isolation,
  authority, security, public/serialized contract, recovery or test truth is
  recorded immediately, pauses that package, and receives an independent repair
  package before the original work resumes;
- other findings are recorded immediately without expanding the active package
  and are scheduled by engineering priority rather than severity labels alone;
- authority expansion, network/filesystem/credential broadening, public
  protocol change, or guessed historical data moves the finding to
  `needs_authorization`;
- every TODO, unrun check, exception, and residual risk references a finding;
- a planned wave is scheduling telemetry, not a correctness veto. A wave may
  close with explicitly owned follow-up findings unless one invalidates an
  acceptance invariant of that wave.

## Concurrency and integration lane

Each worktree declares work-package ID, base commit, owned paths, shared write
paths, and integration dependencies. Two simultaneously active packages must
have disjoint expanded owned paths. Central governance, lockfiles, version and
NEWS authorities, and candidate/generated aggregates are written only by the
integration lane. `architecture-program.mjs overlap` checks declarations before
work begins and again before integration.

## Work-package program

### Wave 0 — stable control plane

- `AM-W0-01`: record schema, validator/status/next/overlap, deterministic tests,
  and LOC telemetry.
- `AM-W0-02`: repair the current handler digest and make the command inventory
  self-test plus repository check mandatory in `rsr:check`.
- `AM-W0-03`: move Console project activation to committed React lifecycle and
  prove discarded render, rapid A/B switching, and waiter cleanup behavior.

Wave 0 restores ordinary feature parallelism after all three packages verify.
Until their owning modules are extracted, `main.rs`, `App.tsx`,
`workspace_plugins.rs`, `coordinator.rs`, lockfiles, and central generated
artifacts remain integration-lane single-write paths.

### Wave 1 — one Rust-to-TypeScript contract

`AM-W1-01` begins with the Runtime Output vertical domain. It evaluates locked
`tauri-specta 2.0.0-rc.25`, preserves current command/serde identity, generates
domain-specific command/type modules, and composes narrow transport facets.
The generator is rejected only for correctness failures: non-deterministic
generation, command/serde shape drift, unsupported Channel semantics, or a
material regression that remains unacceptable after profiling. Compatibility
with an older compiler than the repository's pinned toolchain is diagnostic
evidence, not a fallback trigger.

`AM-W1-25` replaces remaining process-only vetoes with a risk-weighted local
feedback policy. Product correctness, data/project isolation, authority,
public/serialized contract identity, deterministic generation and truthful
recovery remain blocking. LOC, schedule waves, build/bundle trends, unaffected
full suites, manual review and release/platform evidence remain visible without
blocking an ordinary local development slice merely because a numeric or
ceremonial threshold was crossed.

`AM-W1-26` closes the last handwritten production Tauri command call by adding
shell build identity to the existing generated Kernel facet. An AST-based local
ratchet rejects any future direct `invoke(...)` call in non-generated transport
production files, including multiline generic calls, while still allowing the
composition root to pass the invoke capability into generated domain adapters.

### Wave 2 — backend modules and concurrency boundaries

`AM-W2-01` separates the Tauri composition root and durable-domain services,
replaces the global Coordinator mutex with a Workspace broker lane and a
project-transition gate, and introduces one asynchronous SQLite execution lane.
`tokio-rusqlite 0.7.0` is evaluated on the repository's pinned Rust toolchain;
the `spawn_blocking` Store executor remains a behavioral fallback only if the
crate cannot preserve the required single-connection transaction and recovery
semantics. Mechanical extraction and behavior changes are separate review
boundaries.

`AM-W2-02` is the first mechanical boundary: move build identity, updater and
product-link/license handlers into a Shell module without changing command
registration, state, responses or tests. It deliberately leaves Coordinator,
Store and concurrency semantics untouched for later behavior packages.

`AM-W2-03` moves the complete Git command adapter set into a dedicated module;
the existing bounded Git execution and review services remain unchanged.

`AM-W2-04` introduces the durable Store execution lane with locked
`tokio-rusqlite 0.7.0` and migrates the complete Evidence persistence domain
off request-thread `Store::open` calls. Existing synchronous Store consumers
remain compatible while later domain packages move onto the same lane; no
schema, transaction, project-scope or serialized response contract changes.

`AM-W2-05` replaces `Arc<Mutex<CoordinatorRuntime>>` with an explicit
`WorkspaceBrokerLane`. Only the lane's Broker/legacy-Store working set is
serialized; a committed identity projection remains readable without waiting
for Workspace R. A publishing guard advances the projection only when a lane
operation releases, so readers never observe a partially applied revision.

`AM-W2-06` makes the existing Store repository implementation reusable over an
owned or borrowed SQLite connection. This is a behavior-neutral seam: open,
migration and recovery remain available only on the owned Store, while the
same domain methods can execute on the already-open asynchronous Store worker
without copying SQL or introducing a second persistence contract.

`AM-W2-07` exposes an asynchronous Agent repository over that worker and moves
the active Agent turn lifecycle, context receipts and admitted context reads
off the Workspace lane. Environment mutation review and actual Workspace R
dispatch intentionally retain their existing authority ordering.

`AM-W2-08` moves desktop Agent conversation, detail, approval-response,
cancellation and history adapters onto the same repository. It removes
per-command synchronous Store opens while retaining project-transition,
active-task, file-mutation and Workspace cancellation gates.

`AM-W2-09` establishes a directory-backed Workspace-plugin module spine and
moves the existing inline regression suite into its own test submodule. This is
a mechanical source-layout boundary: public and crate-visible paths, runtime
state, Store access, permission ordering, discovery, activation, recovery and
guest execution semantics remain byte-for-byte source-equivalent apart from
module placement and rustfmt. Later packages can extract production domains
without repeatedly moving the 6,000-line regression corpus.

`AM-W2-10` extracts the stable plugin command/projection contracts and the
Workspace inspection dispatcher into independent child modules. The parent
facade re-exports the same crate-visible names, while the concrete dispatcher
remains the only extracted component allowed to acquire the Workspace broker
lane. Registry state, Store calls and every lifecycle transition remain in the
existing implementation for later behavior-neutral domain slices.

`AM-W2-11` moves the registry's discovery/list/reconciliation adapters and its
Agent/UI/Surface/Check contribution projection adapters into separate inherent
implementation modules. The same registry and private helper functions remain
authoritative; this slice changes only which source module owns each existing
method and leaves activation, grant and guest-call state transitions untouched.

`AM-W2-12` completes the mechanical registry-method partition by moving enable
and retry, update and rollback, disable/uninstall/restore teardown, permission
decisions/grants, and guest/broker/runtime health methods into five source
modules. All remain inherent implementations on the single registry and retain
the exact method bodies. The combined runtime-call module remains a temporary
diagnostic hotspot until call families can be separated without widening
private crash/admission helpers.

`AM-W2-13` partitions the remaining free helpers into recovery, broker-context,
projection-validation and activation/grant modules. Helpers called by sibling
implementation modules become `pub(super)` only; the `workspace_plugins`
module remains private to the crate and no command or runtime authority changes.

`AM-W2-14` replaces the temporary combined runtime-call module with independent
network/Workspace broker, direct guest, contribution and health/crash inherent
implementation modules. Shared cancellation/admission and crash helpers gain
only private-parent visibility; call order, grant consumption, durable audit and
quarantine behavior remain unchanged.

`AM-W2-15` (`24d4964`/AM-E-0042) removes the first obsolete
Store-to-Workspace lock coupling. Store plugin services are reusable over the
asynchronous worker's borrowed connection, and Agent plugin projection combines
that worker with the Workspace lane's committed identity view under the
existing project-transition gate. Actual Workspace R dispatch remains
serialized by `WorkspaceBrokerLane`.

`AM-W2-16` (`b0af8ca`/AM-E-0043) migrates every plugin Tauri command adapter
from per-request synchronous Store opens to that shared asynchronous worker.
Runtime context uses a short project-transition snapshot plus committed
identity instead of the Workspace lane; only update, rollback, uninstall and
restore retain their existing full-transaction transition gate.

`AM-W2-17` (`8623ba3`/AM-E-0044) migrates plugin boundary teardown, reconciliation, heartbeat
maintenance and Agent contribution persistence onto the same Store worker.
Plugin-only work uses the committed identity projection; reconciliation retains
the Workspace lane only for an actual recovered-file project revision change.

`AM-W2-18` (`4730036`/AM-E-0045) gives Run History a narrow executor-backed repository shared by
legacy Tauri queries and the candidate internal-extension source facade. Query
shape, bounds, failure and stale-generation behavior remain unchanged.

`AM-W2-19` (`1776f7e`/AM-E-0046) moves the cross-domain reproducibility audit onto its own repository
over the Store worker. Panic containment executes inside the submitted
operation, preserving its stable retry message without risking the worker.

`AM-W2-20` (`b041036`/AM-E-0047) gives durable Environment request projections
and non-executing Agent fallback decisions a dedicated Store repository. Real
environment R execution remains in the Workspace broker lane and its separate
approval path.

`AM-W2-21` (`f668d2d`/AM-E-0048) gives Artifact/Plot projections, bounded
retention mutations and render recovery reads one asynchronous durable
repository. File export, Workspace revision mutation, render execution and
interruption remain in their existing authority lanes.

`AM-W2-22` (`47616e7`/AM-E-0049) extends the Run repository to own
project-scoped cancellation and latest-active selection. Console, Render,
restart and Agent controls keep Ark interrupt and task authority while durable
SQLite work uses the Store worker.

`AM-W2-23` (`25c3798`/AM-E-0050) captures the durable half of project-switch
preflight in one Store worker operation and uses that worker for active-root
prepare/commit/rollback. The project-transition gate and all Workspace,
watcher, extension and recovery ordering remain authoritative in the caller.

`AM-W2-24` (`c2c2f08`/AM-E-0051) moves Runtime Output queries, follow reads,
policy maintenance, retention actions and interrupted-execution reconciliation
onto one durable repository. Supervised execution streaming/backpressure stays
intact for its own behavior package.

`AM-W2-25` (`53fcf1f`/AM-E-0052) removes the current Rust release literal from
the toolchain validator. The repository pin remains exact and reproducible, but
a coherent stable-semver advance is evaluated by capability and contract
evidence instead of being rejected by the previous version's embedded
constant.

`AM-W2-26` (`7e11db5`/AM-E-0053) moves bounded Plugin Surface and Check guest
contribution execution plus their Store-backed validation off Tokio request
threads and onto the existing plugin Store service seam.

`AM-W2-27` (`724811a`/AM-E-0054) adds ordered async Ark event callbacks and
moves Runtime execution admission, streaming output and terminal persistence
onto `RuntimeOutputRepository` without introducing a buffer or weakening
backpressure. The local real-Ark probe now exercises the async path.

`AM-W2-28` (`094e00d`/AM-E-0055) phases Agent file proposal/ledger reads and
mutation-event writes through the Store worker while preserving the existing
file lane, durable before/after ledger, Workspace identity ordering and restart
recovery truth. `main.rs` no longer has an ordinary `read_store` path.

`AM-W2-29` routes every network and Workspace plugin broker audit phase through
the shared Store worker instead of reopening SQLite around external awaits;
commit `9c7243e` and `AM-E-0056` preserve the exact permission, grant, failure and
project-isolation behavior.

`AM-W2-30` moves Workspace bootstrap, run, kernel-event, environment-snapshot,
plot and artifact persistence onto that worker while Ark and revisions remain
serialized by the Workspace lane.

### Wave 3 — frontend composition, projection, and layout adapter

`AM-W3-01` reduces `App.tsx` to shell composition, adds additive
`WorkbenchProjectionV1`, replaces duplicate project stores with one coherent
revision-checked projection store, and evaluates locked `dockview-react 8.2.0`.
Rust Scene JSON and CAS remain the sole durable layout authority. Dockview JSON
is never persisted. If controlled Scene conversion fails or initial gzip grows
more than 200 KiB, current mechanics move into an isolated layout-engine module
instead.

### Wave 4 — Wasmtime Component Model and WIT

`AM-W4-01` keeps Wasmtime `38.0.4`, adds the component-model feature, defines
`rho:plugin@1`, and adds typed begin/resume/cancel guest steps while preserving
fuel, epoch, limits, per-plugin Engine, no-WASI, yield/resume, and broker grants.
Manifest V4 requires an explicit `runtime.abi`; V1-V3 retain core behavior and
V4 ABI is never guessed from exports.

### Wave 5 — worktrees and shared generated artifacts

`AM-W5-01` checks overlap admission, introduces change fragments, assigns
NEWS and generated summaries to the integration lane, decides whether
`desktop/dist` is untracked build output or deterministic integration output,
and proves a Runtime/Agent/two-feature-worktree merge-tree scenario.

### Wave 6 — convergence and continuous governance

`AM-W6-01` closes acceptance-critical cleanup findings, removes superseded
facades/duplicate stores/manual types, remeasures architecture, and promotes the
tracker, overlap, generated freshness and dependency checks into normal local
validation. LOC and planned-wave targets remain status telemetry.

## Verification contract

Each package runs focused tests plus the changed boundary, failure and recovery
checks that can actually detect regressions in its scope. Broad affected
matrices run at integration/wave boundaries or when the changed risk spans
those systems; independent review is required for safety, data, authority,
public-contract or release-significant changes, not for every mechanical or
equivalence slice. Evidence records include exact command, result, platform,
source commit, duration when material, and all intentionally unrun checks.

The program-level matrix includes:

- tracker malformed IDs/JSON, duplicates, illegal transitions, missing finding
  dispositions, overdue findings, ownership overlap, implemented packages with
  blocking findings, and deterministic status output;
- command uniqueness, deterministic generation, Rust/TypeScript serialization,
  real/mock parity, and stale generated output rejection;
- Workspace serialization without unrelated DB/Agent/projection blockage,
  mutation failure/recovery, and two-project isolation;
- render purity, projection coherence, rapid switching, stale revision,
  recovery, pointer, keyboard, zoom, and browser scenarios;
- equivalent core-v2/component-v1 lifecycle and security/failure/isolation;
- non-overlapping worktree merge and pre-start rejection of overlap;
- pinned Rust, `npm --prefix desktop run rsr:check`, and `git diff --check`
  before final local program acceptance. R packages run when their source or
  Rust/R bridge contract changes; an unaffected package is recorded as not run.

Windows, installed-app, distribution and remote-CI checks are outside ordinary
local program acceptance. If a future release contract makes one relevant, it
is recorded and run at that candidate boundary; it is never represented as
passed when unrun.

## Architecture completion metrics

- command inventory self-test and real check are mandatory and passing;
- `main.rs` and `App.tsx` become small composition roots with domain-owned
  dependencies; all hotspot LOC, fan-in and change-frequency measurements are
  reported, but no architecture claim is accepted or rejected by LOC alone;
- no global Coordinator mutex and no synchronous SQLite work blocks Tokio;
- Rust owns generated IPC DTOs and mock transport is domain-faceted;
- component-v1 is usable while legacy core plugins continue to run;
- Scene authority is unchanged and generic layout mechanics are delegated to a
  controlled adapter or isolated engine;
- representative architecture, Runtime, and Agent worktrees integrate without
  shared-file conflict;
- all acceptance-critical findings are resolved, remaining follow-ups have an
  owner, and the complete relevant local automation is recorded.

The filename changes from `active-` to `implemented-` only after every product
and architecture invariant is true, acceptance-critical findings are resolved,
and the relevant local automated matrix is recorded. Proxy metrics, unavailable
platforms and release ceremony cannot keep locally correct modernization open.

## Wave 0 checkpoint (2026-08-24)

Wave 0 is implemented in three reviewed packages:

- AM-W0-01 established the strict JSON-in-Markdown records, adversarial
  validator/status/next/overlap commands, deterministic generated dashboard,
  and the initial legacy LOC ratchet in `07b604b` (later refined by AM-W1-02
  and AM-W1-25 into advisory hotspot telemetry);
- AM-W0-02 repaired the 193-command handler digest, made repository resolution
  cwd-independent, and added command plus architecture checks to `rsr:check` in
  `392f114`;
- AM-W0-03 moved Console project activation out of render into committed React
  Effects and added discarded-render, A/B switch, and cleanup regression tests
  in `2110050`.

The complete local frontend gate passes 25 files/229 tests, production build,
generated-asset identity, Chrome smoke, and real interactions. The exact
commands and the first truthful cwd failure are recorded in AM-E-0001 through
AM-E-0003. The integration lane regenerated tracked `desktop/dist` from build
identity `f07d05c35aa2`. No application/R version or NEWS change is required.

Wave 1 is implemented through bounded vertical packages and its AM-W1-01
umbrella is closed by the final integration evidence. AM-W1-03 replaced the
frozen Rust 1.88 veto with a rolling exact 1.97.0 toolchain contract in
`b4f25fb`; the same locked tauri-specta graph passes the complete local workspace
matrix. Generated
verticals are implemented for Runtime Output (`24d1e62`/AM-E-0005), Runtime
lifecycle (`bd6f3a9`/AM-E-0006), Surface/Studio (`00be5e3`/AM-E-0007), Resource
(`e169e9a`/AM-E-0008), Profile/Vibe (`90d67d9`/AM-E-0009), and Agent
conversation inventory (`5467db4`/AM-E-0010), Agent turn detail
(`470a679`/AM-E-0011), and Agent context/turn control
(`f46a283`/AM-E-0012), and Agent runtime diagnostics
(`bb1b827`/AM-E-0013), and Agent settings/capacity
(`c5c5643`/AM-E-0014), and Agent file apply/undo
(`375fce0`/AM-E-0015). The latter also repairs the real-Tauri
`afterSha256`/frontend `after_sha256` drift that browser mock behavior had
hidden. Credential and Provider-network mutations remain separate Agent
contract facets. Workspace-plugin Surface (`157f474`/AM-E-0016), Project
transition (`4cfbe76`/AM-E-0017), UI Kernel (`172f3e2`/AM-E-0018), Check
(`fdfa367`/AM-E-0019), Startup (`26f1e64`/AM-E-0020), History and artifact
reads (`3cb7c3d`/AM-E-0021), Environment reads (`fbcb53b`/AM-E-0022), and
Evidence reads (`c2c3b67`/AM-E-0023), Git reads (`1017454`/AM-E-0024), and
Startup diagnostics (`7b0bb51`/AM-E-0025), and History retry
(`e6fe8b8`/AM-E-0026) now use the same Rust-owned generated boundary.
AM-W1-25 (`b986917`/AM-E-0027) makes LOC, hotspot growth and planned-wave
targets advisory, narrows per-slice validation to relevant risk, and reserves
hard development failures for product correctness, authority, data/contract
identity, deterministic generation and recovery truth.
AM-W1-26 (`f762ae0`/AM-E-0028) moves shell build identity into the generated
Kernel facet and adds an AST ratchet across 29 production transport files. The
final Wave 1 audit reports zero direct `invoke(...)` calls outside generated
commands; Rust owns every current production command name and DTO boundary,
while real and mock transports compose narrow domain facets.

## Wave 2 progress (2026-08-25)

AM-W2-02 (`1ced6ac`/AM-E-0029) mechanically extracts AppInfo, native updater
state/handlers, product URL and bundled-license behavior into `shell.rs`.
`main.rs` drops from 17,970 to 17,677 lines, the 193-command identity/order is
unchanged, and the Kernel generated contract changes only its truthful source
header. Coordinator, Store and concurrency semantics remain untouched for the
next bounded packages.
AM-W2-03 (`0f37ef3`/AM-E-0030) moves all thirteen Git Tauri adapters into
`git_commands.rs`; `main.rs` falls to 17,518 lines while command identity,
bounded subprocess execution, revision guards and project isolation remain
unchanged.

## Version, NEWS, and release decision

Wave 0 is internal governance and defect repair with no distributable behavior
change: no application or R package version bump and no `NEWS.md` entry.
Mechanical refactors retain that decision. Workbench projection behavior,
Dockview interaction, or Component ABI entering a distributable candidate
requires synchronized application version metadata and NEWS at one integration
candidate, not per exploratory package. R package versions remain independent.

Current release decision: NO RELEASE DECISION. This program authorizes no
candidate, installer, signing, publication, or upstream mutation.
