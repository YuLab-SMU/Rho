# Tauri Runs Command Module

Status: active; TCMD-RUNS1 implementation, local verification, versioning, and
independent contract review complete 2026-08-20; hosted CI pending

Authorization: the project owner requested completion of the unfinished
architecture work on 2026-08-20. Development governance requires one bounded
package and stop point, so this contract activates only the first behavior-
neutral Tauri command-domain extraction.

Change class: D2 bounded cross-boundary refactor. Risk: R2 because the existing
commands cross the Tauri, extension-runtime, and Store boundaries even though
the package introduces no new behavior, authority, state, or persistence.

## Problem

`desktop/src-tauri/src/main.rs` is 14,250 lines and still owns most command
implementations directly. The Runs read surface is a coherent first extraction:
it already shares the project application-service seam, has deterministic
extension-runtime isolation and stale-generation tests, and has a browser/mock
contract. Keeping it in `main.rs` makes command ownership hard to discover and
causes text-based contract tests to assume that every command lives in one
file.

The accepted BH5 boundary contract requires per-domain command modules and a
generated command inventory, but the current source has neither a Runs command
module nor a general inventory check.

## Authority And Cross-review

This package is governed by and cross-reviewed against:

- `docs/project/active-development-governance.md`;
- `docs/plans/accepted-2026-07-31-bh5-incremental-module-boundaries-handoff.md`;
- `docs/plans/implemented-2026-08-20-project-application-service-seam-spec.md`;
- `docs/plans/implemented-2026-08-18-p1-2-run-history-source-spec.md`;
- the accepted run comparison/audit, Problems, project identity/switching, and
  Rust stable/MSRV CI contracts;
- `docs/project/active-document-cross-review.md`.

BH5 owns behavior-neutral module extraction. APP-SVC1 and `rho-store` retain
project normalization, query, mutation, and persistence authority. Phase 1
retains capability/scope/generation and broker-facade semantics. This package
does not redefine any of them.

## TCMD-RUNS1 Scope

Create `desktop/src-tauri/src/commands/runs.rs` and move these existing command
implementations there without semantic edits:

- `list_runs` and its legacy/candidate routing helpers;
- `list_problems`;
- `get_run_detail`;
- `compare_runs`;
- `audit_reproducibility` and its panic-containment helper.

Add a generated Rust command-inventory contract that discovers command
definitions across the source tree and proves that the Tauri
`generate_handler!` inventory contains each command exactly once. Update the
Run History contract test to read the new ownership path and preserve the
existing browser/mock assertions.

The pre-change inventory exposed one existing structural mismatch:
`shutdown_application` was annotated as a Tauri command even though it was not
registered or invoked by the frontend and is called only as an internal Rust
shutdown helper. TCMD-RUNS1 removes that stray annotation so the generated
inventory can remain fail-closed; the helper name, signature, callers, and
shutdown behavior remain unchanged.

The following remain deliberately deferred:

- `retry_run` and `cancel_run`, because they cross execution-admission,
  interruption, and durable mutation boundaries;
- Agent/approvals, Evidence, Artifacts/Plots, Environment, Project/Session, and
  frontend module extraction;
- changes to the public Workbench Protocol, extension host, Store API, SQLite,
  frontend state, or browser/mock response shapes.

## Invariants

- Tauri command names, arguments, return types, serialization, and registration
  order remain unchanged.
- Removing the unused `shutdown_application` command annotation does not add or
  remove a registered/invocable command; the function remains an internal Rust
  helper with the same callers.
- `list_runs` preserves legacy/candidate selection, exact project scope,
  activation-generation validation, late-result rejection, bounded payloads,
  and fail-closed candidate errors.
- Project queries still use `ProjectQueryService`; audit still uses the existing
  Store audit path and limits.
- The extracted module receives no new filesystem, execution, persistence,
  approval, credential, network, or Workspace R authority.
- Browser/mock handlers and frontend consumers remain byte-for-byte unchanged.
- Tests may change only to follow the ownership path or enforce inventory; no
  behavioral assertion may be weakened.

## Verification And Stop Gate

TCMD-RUNS1 stops when:

- the generated command inventory self-tests and repository check pass;
- the Run History contract self-tests and repository check pass;
- all existing Runs extension, stale-generation, bounds, two-project, query,
  audit, and panic-containment Rust tests pass unchanged;
- `cargo fmt --all -- --check`, scoped desktop Clippy enforcement for unused,
  dead, unreachable, and unused-variable code, `cargo test -p rho-desktop
  --locked --no-fail-fast`,
  `cargo test --workspace --locked --no-fail-fast`, `cargo build --workspace
  --locked`, `node --check desktop/dist/app.js`, both R package suites, and
  `git diff --check` pass;
- an independent contract review finds no signature, registration, authority,
  isolation, bounds, error-truth, frontend/mock, or version drift.

No later domain extraction is authorized by completion of this package.

## Version, NEWS, And Release

The accepted BH5 contract requires each command-domain extraction commit to
advance the application development suffix. After verification, TCMD-RUNS1
will synchronize application version metadata at `0.4.1-dev.2`. The refactor
does not change user-visible behavior, so no `NEWS.md` feature entry or R
package version bump is required.

No installer, publication, update manifest, installed-app acceptance, or
release decision is in scope. The new version must not be distributed until a
separate exact-candidate gate is authorized and completed.

## Implementation And Local Evidence — 2026-08-20

Implemented:

- created `commands/runs.rs` with the five authorized read commands and their
  existing routing/audit helpers; `main.rs` registers the same names in the
  same order through module paths;
- removed only the stray, unregistered `#[tauri::command]` annotation from the
  internal `shutdown_application` helper;
- added a recursive command-definition/handler inventory with duplicate,
  missing, extra, ownership, five-Run-mock, and exact ordered-inventory digest
  checks plus negative self-tests;
- wired the inventory into Draft Fast and all stable/MSRV compatibility legs
  and extended the Rust CI policy self-tests;
- updated the Run History contract reader for the new ownership path without
  changing its assertions or `desktop/dist/app.js` behavior;
- synchronized all application version authorities and browser cache/mock
  fixtures at `0.4.1-dev.2`; R package versions and `NEWS.md` are unchanged.

Verification:

- generated inventory: 118 definitions/registrations across 9 Rust source
  files; self-tests and repository check passed;
- pre-change `upstream/main` and the new handler inventory both contain 118
  commands with ordered SHA-256
  `47e37bd1f93a989e629875fdf11c6ebbcc0e841a6363b5a647d0279cc0610629`;
- Run History contract self-tests/repository check and Rust stable/MSRV policy
  self-tests/repository check passed;
- `cargo test -p rho-desktop --locked --no-fail-fast`: 204 passed, one existing
  opt-in Keychain smoke ignored;
- `cargo test --workspace --locked --no-fail-fast`: passed, including all Runs,
  audit, extension-runtime, store service, project-isolation, bounds, stale,
  restart, and panic-containment coverage;
- `cargo check --workspace --all-targets --locked`, `cargo build --workspace
  --locked`, `cargo fmt --all -- --check`, and `git diff --check`: passed;
- scoped `cargo clippy -p rho-desktop --all-targets --no-deps --locked -- -D
  unused-imports -D dead-code -D unused-variables -D unreachable-code`: passed;
- `rho.bridge`: 575 passed; `rho.agent`: 120 passed;
- JS syntax, version/release agreement, Phase 1 acceptance, Outputs, Git review,
  workbench hierarchy, interface foundation, Act outputs, and scientific/Agent
  surface contracts passed.

The broader `cargo clippy -p rho-desktop --all-targets --locked -- -D warnings`
was run and is not a passing gate: it fails on 153 pre-existing `rho-store`
lints. Adding `--no-deps` still exposes 21 pre-existing desktop lints (23 for
the test target) in untouched code. No reported lint points to
`commands/runs.rs` or another TCMD-RUNS1 addition; the focused unused/dead-code
gate above passes. The broader cleanup remains out of scope.

Independent review found and resolved two structural gaps: the unregistered
shutdown annotation and an inventory implementation that initially proved set
parity but not exact order. The final ordered digest equals the pre-change
baseline; command signatures, return/error paths, registration order,
project/generation checks, Store/Broker authority, bounds, frontend consumers,
and browser/mock responses show no drift. No blocking finding remains.

Manual/installed acceptance is not required for this behavior-neutral source
refactor. Hosted Draft/Ready/main evidence has not run for this branch, so the
document remains active and no release or distribution decision is made.
