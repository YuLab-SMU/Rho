# Visual Acceptance Automation

Status: implemented VA1 contract; product acceptance remains FAIL

Date: 2026-08-26
Authorization: user directed on 2026-08-26 to remove the human-executed
`test/acceptance-project/MANUAL-ACCEPTANCE.md` acceptance lane and replace it
with automated visual verification
Change class: D1 acceptance tooling and governance records; one debug-only
desktop automation bridge
Risk: R2 the bridge widens the debug build's execution surface and is held to
fail-closed compile-time and runtime gates
Work package: VA1
Mandatory stop: after the bridge, cross-platform fixtures, core-journey
scenarios, one complete local evidence run with per-frame visual review,
governance reconciliation, and an independent commit

## Problem

The remaining open release items are six manual acceptance validations staged
under `test/acceptance-project/`. Human execution against an installed
candidate is the bottleneck, cannot run in automation, and its evidence cannot
be regenerated on demand. The legacy `scripts/windows-installed-focus-acceptance.mjs`
predates the React interface (its page-context globals no longer exist) and is
not registered in any check, so no executable installed-app acceptance lane
currently exists.

## Authority And Evidence Contract

- Automated visual verification replaces the human-executed manual acceptance
  gate. The evidence class is: deterministic in-app assertions plus per-frame
  screenshots reviewed against recorded visual criteria by a vision-capable
  reviewer (the acceptance agent), both persisted in one evidence ledger.
- Visual review must be recorded frame by frame. A blanket default pass is not
  evidence. Each frame carries its own criteria list and verdict.
- Deterministic assertions and visual verdicts stay separate fields. A scenario
  passes only when both layers pass; a truthful SKIP (missing optional
  prerequisite such as model credentials or Quarto) is recorded with its reason
  and never as a pass.
- The six human manual-validation items are closed as human gates by this
  authorization. Windows-installer-specific human checks (SmartScreen wording,
  Windows Credential Manager contents, uninstall behavior) are recorded as
  removed manual gates; the distribution decision and the affected-suite rerun
  remain separate open items and are not replaced by this lane.
- Browser/mock evidence remains a distinct, weaker class and does not close
  real-application gates.
- This consolidated development lane does not replace exact-candidate
  installation, signing, distribution, or release GO/NO-GO gates owned by an
  active release contract.

## Bridge Contract (Debug Only)

- The desktop application exposes an acceptance bridge only when
  `cfg!(debug_assertions)` holds and `RHO_ACCEPTANCE_BRIDGE=1` is set in the
  environment. Release builds compile without the listener. When the
  environment variable is absent, no socket is bound and the result command is
  inert.
- The bridge binds `127.0.0.1` on an ephemeral port only, writes the selected
  port and process identity to `$RHO_ACCEPTANCE_OUTPUT/bridge.json`, and
  refuses to start when `RHO_ACCEPTANCE_OUTPUT` is unset or not a writable
  directory.
- The bridge supports exactly three operations:
  - `eval`: retains the bridge route/field name for compatibility but forwards
    only a JSON-encoded `AutomationRequest` to the frontend acceptance surface
    over a Tauri event; no source string is evaluated. The structured result
    returns through `acceptance_bridge_result` with a bounded wait;
  - `screenshot`: captures the application window's webview content into
    `$RHO_ACCEPTANCE_OUTPUT/screenshots/<name>.png` (on macOS via
    `WKWebView.takeSnapshot`, which needs no screen-recording permission for
    the process's own webview);
  - `window`: sets the main window's logical size for the documented
    900x700 / 1024x680 / 1920x1080 review frames.
- The frontend acceptance surface `window.__rhoAutomation` is installed only
  after the backend confirms an active bridge. It exposes a readiness probe,
  a read-only state snapshot, and a bounded action vocabulary built from the
  existing controllers and DOM event dispatch, including debug-only component
  isolation through the same close-placement action as visible surface chrome.
  It adds no new mutation authority beyond what the UI already exposes.
- Negative coverage is mandatory: a release-profile source audit shows the
  bridge listener is compile-gated; a behavior test shows no listener and an
  inert result command without the environment variable.

## Fixture Contract

- `test/acceptance-project/tools/prepare-fixtures.mjs` is the cross-platform
  entry point and is behaviorally equivalent to
  `tools/prepare-manual-fixtures.ps1`: the independent `working-project` Git
  repository, the pre-conflicted `conflict-project` (`UU
  examples/git-review-demo.txt`), the Unicode/space project
  (`路径 含 空格/acceptance-project`), `large-project-2100`, and the 9 MiB
  oversized-file project. An existing output root fails closed.

## Product Model Reconciliation

- The manual guide's UI vocabulary predates the 2026-08 Surface Runtime
  workbench. The current interface has no Human-first/Agent-first postures, no
  Data Viewer component, no Git mutation controls (`rho.git` is read-only), and
  no dual Plots Session/History tabs, although the backend commands for data
  views and Git mutations still exist. Manual gates that target removed
  surfaces are closed by the 2026-08-26 authorization as removed gates; they
  are not replaced by automated evidence. The automated suite verifies the
  current product only.

## Scenario Contract (Slice 1)

- `scripts/visual-acceptance.mjs` launches the debug application with the
  bridge enabled, generates fixtures, and executes the core journey in the
  real application with the real Workspace R backend:
  - S0 startup, project open, Navigator file tree (visual);
  - S1 workbench tour: console markers `RHO_TOUR_ROWS=24` /
    `RHO_TOUR_MISSING_NOTES=8`, live Workspace object probes, package
    Environment observation, Plots visibility, and a failed Run/Problem;
  - S2 single-cell QC workflow with deterministic expectations (240 cells,
    217 of 240 passing, two plots);
  - S7 Git read-only review: status/log/diff visibility on real edits and the
    conflicted project's conflict presentation (visual). Hunk stage/restore/
    commit have no current-UI surface and are recorded as removed gates;
  - S8 persistence across restart, Unicode-path project switching isolation,
    the large-project bound warning, the 9 MiB refusal, and the three
    documented window sizes (visual);
  - S3 Agent scenarios record a truthful SKIP when no model credential is
    configured.
- Every visual gate emits a named screenshot plus deterministic assertions into
  `target/visual-acceptance/<run>/`: `evidence.json`, `screenshots/`,
  `visual-review-manifest.json`, and `report.md`. Each output directory is
  immutable. A failing gate stops only its current scenario; the driver
  continues with the next independent scenario, preserves all evidence, and
  does not clean up after itself.
- The slice-2/3 scenarios (editor intelligence, Claims/Evidence,
  Chunks/Render, full Agent flows, recovery injection, Windows CDP adapter)
  are recorded as follow-up packages and are not implemented here.

## Registration And Governance

- `rsr:accept:visual` runs the lane on demand. It is not part of `rsr:check`
  because it requires a built debug application and a local R runtime.
- `scripts/test-visual-acceptance.mjs` covers the harness without launching
  the application (scenario registry completeness, evidence schema, fixture
  generation equivalence, bridge fail-closed static assertions) and is
  registered as `rsr:test:visual-acceptance` at the end of `rsr:check`.
- `test/acceptance-project/MANUAL-ACCEPTANCE.md` is reduced to a stable
  retirement notice, while `VISUAL-ACCEPTANCE.md` describes the automated
  lane, scenario coverage, evidence interpretation, and removed manual gates.
  `docs/acceptance/manual-acceptance-checklist.md`, the acceptance project
  `README.md`, and `docs/plans/active-2026-08-02-remaining-work-follow-up.md`
  are reconciled to the new evidence model.
- No application version metadata or `NEWS.md` changes: the bridge is excluded
  from release builds and is not user-visible application behavior.

## VA1 Local Baseline Evidence

The first complete integrated run was captured and reviewed on 2026-08-26 at
`target/visual-acceptance/va1-integrated-final3`. All 17 screenshots received
an explicit frame verdict; no frame remains pending. The final ledger records
35 gates: 12 PASS, 15 FAIL, and 8 authorized removed-gate SKIPs. The run is
truthfully FAIL and does not close any of the six real-application validation
items in the remaining-work record.

The lane itself completed its acceptance purpose: it launched the real debug
application with Workspace R, generated isolated fixtures, continued across
independent scenario failures, captured deterministic and visual evidence,
and finalized a reproducible report without widening release authority. The
baseline exposed current-product defects rather than harness failures:

- Plots records exist, but the surface renders `PREVIEW UNAVAILABLE` and raw
  metadata; same-run plot identity is also not visually distinct.
- Problems can open as a blank surface with a visible `missing reference`
  error.
- The default Agent composer overlaps at ordinary and narrow widths; the
  integrated real Ask reached the provider but retained only `R` instead of
  the requested `RHO_AGENT_OK`.
- Git history renders, but status and diff records do not reach the read-only
  surface; conflict presentation becomes severely compressed in the full
  workbench layout.
- An unsent Console draft is lost on restart, Workspace R state leaks across a
  project switch, the 2,000-resource bound has no visible warning, and the two
  narrow window frames overlap or clip controls.

These findings are outside VA1's tooling-only scope. Each product repair needs
its own authorized contract and regression coverage before implementation.
The committed evidence index is
`docs/verification/visual-acceptance-va1-baseline.md`; raw PNG and JSON output
stays under ignored `target/` storage.

## Completion Evidence

VA1 completed on 2026-08-26 after implementation review against this contract.
The final affected matrix was run from the reviewed worktree:

- `cargo test -p rho-desktop --locked`: 378 passed, 22 ignored, 0 failed;
- `cargo check -p rho-desktop --release --locked`: passed, confirming the
  release-profile bridge remains compile-gated;
- `npm run rsr:check --prefix desktop`: passed, including TypeScript and lint,
  50 Vitest files / 319 tests, generated contracts, production build, browser
  smoke, interaction acceptance, development-lane tests, and the visual-harness
  self-test;
- `target/visual-acceptance/va1-integrated-final3`: finalized FAIL with 35
  gates (12 PASS, 15 FAIL, 8 authorized removed-gate SKIP), six deterministic
  failures, and 17 of 17 frames reviewed (5 PASS, 12 FAIL, 0 PENDING).

The implementation matches the accepted debug-only authority and evidence
contract. The baseline failures are product findings and remain open under the
remaining-work record; they are not VA1 implementation deviations. The change
has no application-version or `NEWS.md` impact because the listener and
frontend automation surface are unavailable in release builds. Exact-candidate
installation, distribution, signing, publication, and release decisions remain
outside this completed contract.
