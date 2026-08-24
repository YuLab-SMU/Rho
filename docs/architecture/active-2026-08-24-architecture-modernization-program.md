# Rho Architecture Modernization Program

```json
{
  "schema_version": 1,
  "record_type": "program",
  "program_id": "AM-2026",
  "status": "active",
  "current_wave": 1,
  "authorized_at": "2026-08-24",
  "authorized_by": "repository owner",
  "authorization_source": "2026-08-24 instruction to implement the architecture modernization plan",
  "active_work_packages": [],
  "integration_lane": "AM-W0-01",
  "base_commit": "9a5da6dfb7bf9a50a42bff02dac63f2c2c28dc52"
}
```

Status: active D3/R3 architecture program; Wave 0 control-plane package
authorized 2026-08-24

Date: 2026-08-24

Owner: repository architecture modernization integration lane

Next mandatory checkpoint: each work package's automated gate, contract review,
and evidence record. A later package may become active only after its entry
conditions are true.

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
- `docs/plans/active-2026-08-10-rust-msrv-build-contract.md` for Rust 1.88 and
  locked-build validation;
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

- a blocking or high-risk finding is recorded immediately, pauses the current
  package, and receives an independent repair package before the original work
  resumes;
- a medium/low finding is recorded immediately without expanding the active
  package and is assigned to a wave cleanup package;
- authority expansion, network/filesystem/credential broadening, public
  protocol change, or guessed historical data moves the finding to
  `needs_authorization`;
- every TODO, unrun check, exception, and residual risk references a finding;
- a wave cannot close while it has an untreated due finding.

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
  and LOC ratchet.
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
Fallback to locked `ts-rs 12.0.1` is mandatory if Rust 1.88 fails, two clean
generations differ, shapes change, clean Rust check time grows over 20%, or the
release binary grows over 10%.

### Wave 2 — backend modules and concurrency boundaries

`AM-W2-01` separates the Tauri composition root and durable-domain services,
replaces the global Coordinator mutex with a Workspace broker lane and a
project-transition gate, and introduces one asynchronous SQLite execution lane.
`tokio-rusqlite 0.7.0` is admissible only after the Rust 1.88 gate; otherwise a
single Store executor backed by `spawn_blocking` is used. Mechanical extraction
and behavior changes are separate review boundaries.

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

`AM-W5-01` enforces overlap admission, introduces change fragments, assigns
NEWS and generated summaries to the integration lane, decides whether
`desktop/dist` is untracked build output or deterministic integration output,
and proves a Runtime/Agent/two-feature-worktree merge-tree scenario.

### Wave 6 — convergence and continuous governance

`AM-W6-01` closes cleanup findings, removes superseded facades/duplicate stores/
manual types/expired exceptions, remeasures architecture, and promotes the
tracker, LOC, overlap, generated freshness, finding completeness, and dependency
checks into normal local and CI validation.

## Verification contract

Each package runs focused tests, affected package checks, boundary/failure
tests, the complete affected matrix, then an independent contract review.
Evidence records include exact command, result, platform, source commit,
duration when material, and all intentionally unrun checks.

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
- stable/MSRV Rust, `npm --prefix desktop run rsr:check`, both R packages, and
  `git diff --check` before final program acceptance.

Windows, installed-app, or owner-feel checks that have not run remain explicit
open evidence. They are never represented as passed.

## Architecture completion metrics

- command inventory self-test and real check are mandatory and passing;
- `main.rs <= 600`, `App.tsx <= 800`, and no non-generated production file is
  over 1,500 lines;
- no global Coordinator mutex and no synchronous SQLite work blocks Tokio;
- Rust owns generated IPC DTOs and mock transport is domain-faceted;
- component-v1 is usable while legacy core plugins continue to run;
- Scene authority is unchanged and generic layout mechanics are delegated to a
  controlled adapter or isolated engine;
- representative architecture, Runtime, and Agent worktrees integrate without
  shared-file conflict;
- all due findings are resolved and complete automation plus required manual
  acceptance is recorded.

The filename changes from `active-` to `implemented-` only after every program
metric, full automated matrix, independent review, and required manual gate is
true.

## Wave 0 checkpoint (2026-08-24)

Wave 0 is implemented in three reviewed packages:

- AM-W0-01 established the strict JSON-in-Markdown records, adversarial
  validator/status/next/overlap commands, deterministic generated dashboard,
  and exact legacy LOC ratchet in `07b604b`;
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

Wave 1's umbrella remains proposed and must be split into the first Runtime
Output vertical contract/dependency spike before product code is activated.

## Version, NEWS, and release decision

Wave 0 is internal governance and defect repair with no distributable behavior
change: no application or R package version bump and no `NEWS.md` entry.
Mechanical refactors retain that decision. Workbench projection behavior,
Dockview interaction, or Component ABI entering a distributable candidate
requires synchronized application version metadata and NEWS at one integration
candidate, not per exploratory package. R package versions remain independent.

Current release decision: NO RELEASE DECISION. This program authorizes no
candidate, installer, signing, publication, or upstream mutation.
