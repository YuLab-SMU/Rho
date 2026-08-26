# Startup Unavailable-Project Recovery Repair

Status: implemented STARTUP-RECOVERY-1 contract

Date: 2026-08-26
Authorization: the project owner reported that the optimized local development
build no longer starts and supplied the `PROJECT_RESTORE_INCOMPLETE` screen on
2026-08-26; this authorizes the bounded startup-blocking defect repair below
Change class: D1 emergency startup/recovery correction
Risk: R3 because startup admission, durable last-opened-project truth, and the
real-app acceptance lane are safety-critical recovery boundaries
Work package: STARTUP-RECOVERY-1
Mandatory stop: after the focused frontend/Rust/harness regressions, complete
affected validation, contract review, version/NEWS synchronization, and one
repaired local debug-app launch

## Reproduction And Root Cause

The local application data index contains this last-opened project:

`/Users/xiayh/Projects/Rho/target/visual-acceptance/va1-integrated-final3/fixtures/working-project`

That directory was a disposable fixture created by the real-app visual
acceptance lane and no longer exists. `project_restore_session` correctly
returns `unavailable`, and Workspace R remains healthy. The startup shell then
incorrectly renders only `Retry` and `Choose Rscript`, even though changing
Rscript cannot repair a missing project and the existing
`project_pick_directory` command is the contractually required recovery path.

The acceptance harness launches the normal debug application against the
developer's real Tauri application-data directory. Every acceptance project
switch therefore updates the real `project-sessions/index.json`; fixture
cleanup converts the saved path into a guaranteed failure on the next ordinary
launch. The same contamination can affect the Store, UI Profile, runtime cache,
and other device-local development state.

## Invariants And Scope

- A healthy Workspace R plus an unavailable saved project is recoverable from
  the startup screen through the existing native project picker. It never
  offers Rscript selection as the project-recovery action.
- Only a broker-returned `ready` project response admits the Workbench. Picker
  cancellation leaves the unavailable screen intact; blocked, unavailable,
  failed-restored, fatal, and invocation failures remain visible and never
  fabricate readiness.
- Runtime bootstrap failures keep `Retry` and `Choose Rscript`; the repair does
  not weaken the R discovery/startup contract.
- The unavailable response projects its bounded saved path and reason so the
  technical detail explains the actual recovery failure.
- A debug application launched with `RHO_ACCEPTANCE_BRIDGE=1` uses an isolated
  application-data directory below the validated `RHO_ACCEPTANCE_OUTPUT` root.
  The directory persists across harness-driven process restarts in one run but
  never reads or writes the ordinary Rho application-data directory.
- Acceptance data isolation is compile-gated with the bridge. An enabled but
  invalid acceptance output fails shell setup closed instead of silently
  falling back to real user data. The isolated directory must be a real
  directory contained by the canonical output root and must not be a symlink.

## Ownership And Cross-Review

- `implemented-2026-07-16-wp1-project-opening-session-restoration-design.md`
  remains the owner of unavailable-project truth and the explicit select-
  another-project recovery requirement.
- `active-2026-08-22-studio-design-language-and-ux-overhaul-design.md` WP9
  remains the owner of truthful frontend projection for the existing project
  picker and switch response states.
- `implemented-2026-08-26-visual-acceptance-automation-spec.md` remains the
  owner of the debug-only bridge and real-app lane. This repair narrows its
  persistence impact; it does not widen bridge operations or acceptance
  authority.
- BH2 project transition code and `ProjectSessionStore` remain unchanged. No
  schema, migration, command, approval, credential, execution, project
  identity, release, or public protocol authority changes.

No owning-document conflict was found. The implementation amends the visual
acceptance contract to record isolated app-data behavior and its regression
evidence after that behavior is verified.

## Implementation Slice

1. Project `ProjectRestoreResponse.unavailable` path/reason through the Tauri
   startup preparation issue without changing the response schema.
2. Add a bounded startup project-picker transition in `App.tsx`, with distinct
   runtime and project recovery actions and generation guards against stale
   asynchronous results.
3. Resolve a debug-only isolated app-data directory from the already validated
   acceptance output before any project/session/store setup, and launch every
   acceptance process/restart against that same directory.
4. Add focused frontend transport/component regressions, Rust containment and
   fail-closed tests, and harness source-contract enforcement.

## Acceptance Gate

- Frontend transport: ready restore; unavailable restore including path/reason;
  runtime bootstrap failure remains Rscript-actionable.
- Frontend App: unavailable startup exposes `Choose project`, successful pick
  admits the Workbench, cancellation preserves recovery, picker failure is
  visible, and runtime failure still exposes `Choose Rscript` only.
- Rust: disabled isolation returns no override; enabled valid output creates a
  contained app-data directory; missing/invalid output and symlinked app-data
  fail closed. Tests avoid process-global environment races by exercising the
  pure resolver with explicit inputs.
- Harness: the self-test enforces compile-gated isolation resolution and that
  normal Tauri `app_local_data_dir` is only the non-acceptance fallback.
- Run focused Vitest/Rust/harness checks, then `cargo test -p rho-desktop
  --locked`, `npm run rsr:check --prefix desktop`, `cargo fmt --all -- --check`,
  and `git diff --check`.
- Rebuild and launch the checkout debug application. This is local development
  acceptance only; no installer, signing, publication, or release GO is in
  scope.

## Version, NEWS, And Completion

The corrected recovery action is user-visible and enters a new development
candidate, so all application version authorities advance from
`0.4.1-dev.18` to `0.4.1-dev.19` after verification and `NEWS.md` records the
fix. R package versions do not change because their exported contracts and
contents are unaffected.

The regression cause is covered, the affected validation passed, the repaired
debug build launched, and the visual-acceptance contract now records isolated
application data. R package versions remain unchanged because their exported
contracts and contents are unaffected.

## Implementation, Verification, And Review

STARTUP-RECOVERY-1 completed on 2026-08-26:

- the startup shell now distinguishes a healthy Workspace R with an
  unavailable saved project from a runtime bootstrap failure, offers `Choose
  project` for the former, and keeps `Choose Rscript` exclusive to the latter;
- only a `ready` picker result admits the Workbench; cancellation preserves the
  original recovery screen and every rejected or failed result stays visible;
- the unavailable saved path and reason are included in bounded technical
  detail; and
- debug acceptance launches resolve a canonical run-local `app-data`
  directory before any persistent service is constructed. Invalid, non-
  directory, or symlinked paths fail closed, while ordinary debug and all
  release launches retain the normal Tauri application-data path.

The final affected validation matrix passed from the reviewed worktree:

- focused frontend coverage: 2 Vitest files / 100 tests passed;
- `cargo test -p rho-desktop --locked`: 390 passed, 22 ignored, 0 failed;
- `cargo check -p rho-desktop --release --locked`: passed;
- `npm run rsr:check --prefix desktop`: passed, including 50 Vitest files /
  323 tests and the visual-acceptance harness self-test;
- `cargo fmt --all -- --check`, `git diff --check`, and the standalone
  `node scripts/test-visual-acceptance.mjs`: passed.

The exact `0.4.1-dev.19` debug executable (SHA-256
`698ec7e0e317814a09884c07859553c029e0bcc7cf314fa23803d33150e813dc`)
was launched from the checkout bundle. It displayed `Choose project` for the
stale saved fixture, preserved the healthy Workspace R, opened the native
folder picker, and admitted the Workbench only after the owner project
`/Users/xiayh/Projects/Rho` returned `ready`. The broker transaction restored
that path as the durable last-opened project.

This bounded R3 repair used the governance-authorized deliberate self-review
path: the accepted contract, complete diff, fail-closed negative coverage, and
fully deterministic focused tests were reviewed together after the matrix
passed. No ownership conflict, implementation deviation, unresolved finding,
or release-authority expansion remains. The immutable VA1 35-gate product
baseline was not rerun because this slice repairs harness persistence and
startup recovery rather than the recorded product findings; its registered
harness self-test and the exact real-app recovery workflow are the applicable
acceptance evidence. Installer construction, signing, publication, and release
GO/NO-GO remain out of scope.
