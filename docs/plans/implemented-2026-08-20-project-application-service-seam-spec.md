# Project Application Service Seam

Status: implemented; APP-SVC1 implementation, local verification, PR #99
integration, and exact-main hosted verification complete 2026-08-20

Authorization: project owner requested completion of the preserved concurrent
ProjectQueryService/ProjectMutationService work on 2026-08-20.

Change class: D2 bounded cross-boundary refactor. Risk: R2 because existing
project-owned reads and mutations cross the Tauri/store boundary, although no
new mutation, schema, command, or persistence semantics are introduced.

## Problem

Desktop commands currently normalize project roots in several locally repeated
ways and call `Store` directly. Deterministic headless scenarios therefore test
the store but not the same application seam used by those commands. A partial
concurrent implementation introduced shared query and mutation wrappers, but it
had no owning active contract, exposed unused mutation methods without complete
coverage, and had not passed the required warning-free or desktop validation.

## Authority And Cross-review

This package owns only a thin application-service seam inside `rho-store` and
the behavior-neutral migration of selected Tauri call sites to that seam.

It is cross-reviewed against:

- `docs/project/active-development-governance.md`;
- `docs/plans/accepted-2026-07-31-bh5-incremental-module-boundaries-handoff.md`;
- BH1 project-scoped durable identity and BH4 deletion/retention contracts;
- the implemented Phase 1 Run History source contract;
- Agent conversation/approval, Evidence Workspace, run cancellation, and
  Artifact/Plot retention owners.

This spec narrowly amends BH5's former “no public `rho-store` structure change”
boundary: the owner explicitly authorizes two re-exported service types so
headless scenarios and application adapters share one discoverable seam. Raw
`Store` remains the sole persistence authority. No existing `Store` method is
removed or reinterpreted.

## APP-SVC1 Scope

`ProjectQueryService<'_>` delegates these existing project-scoped reads after
one idempotent `normalize_project_root` call:

- run list, problem list, run detail, and run comparison;
- approval-request list;
- Agent conversation list, turn list, and turn detail.

`ProjectMutationService<'_>` delegates these existing mutations after the same
normalization:

- run cancellation request;
- Agent history clear and conversation deletion;
- Evidence entry creation and deletion;
- Artifact-record and Plot-artifact clear for an explicit project.

Selected Tauri commands use the services without changing command names,
arguments, responses, task/project-transition guards, Workspace interrupts,
frontend state, or browser/mock handlers.

## Invariants

- A caller supplies an explicit project root for every service operation.
- The service never accepts an unscoped/all-project mutation.
- Foreign-project detail, delete, cancel, and clear operations fail closed or
  report the existing truthful zero/false result.
- Existing limits and status filters pass through unchanged.
- Mutation guards owned by Tauri remain outside the service and run before the
  store mutation.
- Store errors propagate unchanged as `StoreError`; Tauri continues to map them
  through `display_error`.
- No schema, migration, transaction, approval, credential, runtime, network,
  command signature, mock response, or public Workbench Protocol changes.

## Verification And Stop Gate

APP-SVC1 stops when:

- normal, empty, bounded, invalid/not-found, normalization, and two-project
  query scenarios pass;
- every mutation has success plus foreign-project/rejection or truthful empty
  coverage, and query-after-mutation confirms durable truth;
- the changed Tauri commands compile and existing command/frontend contract
  tests pass without mock changes;
- `cargo fmt --all -- --check`, `cargo test -p rho-store --locked`,
  scoped Clippy enforcement for unused/dead code in the affected crate,
  `cargo test -p rho-desktop --locked`, `cargo build --workspace --locked`,
  the affected Node contract tests, and `git diff --check` pass;
- an independent review finds no behavior, authority, isolation, or error-truth
  drift.

Repository-wide `rho-store` Clippy with every warning denied is not an APP-SVC1
gate: current stable surfaces extensive pre-existing `result_large_err`,
`too_many_arguments`, and style debt in untouched audit/migration/store code.
APP-SVC1 must introduce no unused imports, dead code, or ordinary compiler
warnings and records the broader Clippy cleanup as out of scope.

## Version, NEWS, And Release

APP-SVC1 is an internal service-boundary refactor over existing commands and
store behavior. No application or R package version bump and no `NEWS.md` entry
are required. It creates no installer, release, publication, or release-GO
authority.

## Implementation And Local Evidence — 2026-08-20

Implemented behavior:

- `ProjectQueryService` and `ProjectMutationService` are re-exported from
  `rho-store`, share one required-project validator, reject blank identity, and
  delegate only the operations listed above;
- mutation clearing requires an explicit project root, including Plot rows;
- selected Tauri commands route through the services while their existing
  transition/task/file-mutation guards and response shapes remain unchanged;
- deterministic scenarios cover normal/empty/bounded/not-found, trailing-slash
  normalization, blank identity rejection, foreign-project isolation,
  cancellation no-op, Agent deletion/history, Evidence mutation, and
  Artifact/Plot clear isolation.

Verification:

- `cargo test -p rho-store --locked --no-fail-fast`: 153 passed;
- scoped unused/dead-code Clippy enforcement: passed;
- `cargo test -p rho-desktop --locked --no-fail-fast`: 204 passed, one existing
  opt-in Keychain smoke ignored;
- `cargo test --workspace --locked --no-fail-fast`: passed;
- `cargo build --workspace --locked`: passed;
- affected Run History, Agent Conversation, concurrency, Evidence, and JS syntax
  contract checks: passed;
- `cargo fmt --all -- --check` and `git diff --check`: passed;
- `rho.bridge`: 575 passed; `rho.agent`: 120 passed;
- independent review found and resolved unscoped Plot clearing, unused wrapper
  methods, incomplete mutation/query coverage, blank project identity, and a
  stale direct-Store UI contract assertion. No blocking finding remains.

No application/R version, `NEWS.md`, mock, frontend, schema, migration, or
release change is required. Exact hosted CI is recorded below, so this bounded
package closes as implemented.

## Hosted Integration Evidence — 2026-08-20

- PR #99 merged as `9c5b8b47c50ca0a4c409a2dfd97c89e3594eee00`.
- PR validation passed Draft Fast plus all six macOS, Windows, and Linux
  stable/MSRV legs.
- exact-main Rust Compatibility run `32364857002` passed all six legs; the
  stable legs also passed the unsigned packaged application smoke for their
  respective platform.
- APP-SVC1 therefore has no remaining implementation, automated integration,
  version, NEWS, manual, installed-app, or release gate. The package remains an
  internal service-boundary refactor and creates no release authority.
