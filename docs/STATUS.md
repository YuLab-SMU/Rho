# Rho: current state and focus

Updated: 2026-09-08. This is the single current status page. Code and reproducible
results establish behavior; Git retains the implementation history.

## Current focus

**Read-only R package inspection is implemented and verified.** Open **Panels → Packages** to inspect the active session's installed
metadata, loaded namespaces, attached packages and library paths. Installation and
environment-management decisions are reserved for a future separate plugin.
The interaction contract is in [Design section 11](RHO-DESIGN.md#11-read-only-package-inspection),
with the user requirement in [F08](STUDIO-FEEDBACK.md#f08--package-inspection-without-installation-decisions).
Calm Precision's prior acceptance, including the user's macOS Chinese IME check,
remains established.
The frozen baseline remains commit `d5a970b1559c9bd85567073108d05bca21886de4`, tagged
`studio-round1-baseline-2026-09-07`.

## Implemented

| Area | Current behavior |
| --- | --- |
| Studio shell | English product UI, local Inter, three-column defaults, common menus/commands, accurate session/queue/draft status |
| Views | Close View/Group, space recovery, empty workspace, remembered reopening, 38 px collapse, maximize/restore and twenty committed layout undo steps |
| Placement | Native FlexLayout dragging plus named parent/workspace targets; separate-model preview and keyboard Move To |
| Files / Editor | Lazy directory tree, hidden-file option, bounded project search; pinned R grammar, stable CodeMirror state/Compartments, plain text mode, captured digest-verified save/run |
| Console | Continuous selectable transcript, ordered text/ANSI interpretation, compact plot links/thumbnails, independent drafts/history/scroll for multiple views |
| Execution | Workspace-owned FIFO queue, at most 32 pending runs, optional acceptance reply, guarded pending cancellation, pause/resume and final-commit fencing |
| Input | Jupyter stdin control bound to session/operation/native request; separate answer field, transient password handling, timeout suspension and single-answer validation |
| Objects | Multiple inline previews, explicit new viewer, bounded standard data frame/tibble/vector values and special-value metadata; no forced active/lazy bindings or user methods |
| Packages | Read-only current-session metadata; installed/loaded/attached modes, search and bounded pages, duplicate versions/library precedence, physical-path matching for linked copies, stale/session guards |
| Plots | Fit/100%/1–800% manual zoom, anchored zoom and bounded pan, per-output transforms, follow/history, pinned comparison, original export and shared byte-budgeted cache |
| Historical output | Independent stored-media queries, including a project-only Host without live R |
| Recovery | Current drafts/layout/view state in SQLite with optimistic concurrency; accepted requests are observed rather than replayed; native session identities isolate observations |
| Other scientific owners | Project/Git, isolated environments, local processes and configured SSH/Slurm continue through the same Host ports |

Console views share one local R session. They do not create parallel R evaluation
or another Agent loop. The five scientific ports retain their defaults; stdin is
a sibling control to the same running operation. Read/control capacity is separate
from waiting execution calls. The native R watchdog closes inherited descriptors,
so one Host cannot retain another project's ownership lock.

## Evidence and limits

Package inspection checks cover temporary double-library DESCRIPTION fixtures,
Unicode and literal HTML-like text, pagination, incomplete metadata, changed
`.libPaths()`, base and linked package paths, and disk/loaded-version disagreement.
The query preserves loaded namespaces and the search path, produces no Operation,
returns immediately when R is busy and rejects stale session identities. Browser
checks cover the visible view, busy observations, refresh and close/reopen state.
Verification passed Rust formatting, workspace Clippy and workspace tests;
contract generation, client build and embedded-asset checks; 43 frontend tests;
23 isolated Chrome scenarios; the five explicitly enabled real Ark/R tests and
native package metadata fixture; and MCP/HTTP Workbench checks both with and
without real R. Architecture and documentation governance checks also passed.
The final command logs are in `target/package-checks/`; package screenshots are
`target/studio-browser/packages-panel.png` and `packages-runtime.png`.
The Chrome suite now waits for Console readiness before the Enter/history test;
its first full run exposed a startup timing assumption in that existing test.

Current binaries/assets are built. An already running older Host requires an
explicit restart to acquire the new query; the user's active R session was not
restarted as part of this change.

Calm Precision's broader acceptance included Rust workspace checks, frontend and
Chrome scenarios, native R, MCP/HTTP, environment isolation, process recovery and
local remote-protocol fixtures. Those original logs remain in
`target/calm-precision-run/checks/`. Skipped external tests are not passes; remote
protocol fixtures do not establish live SSH/Slurm behavior.

The fixed gapminder CSV is pinned to upstream version 1.0.1, commit
`5864ccaf4d4d59ca578c098a1400d2fed20584c0`; source and converted CSV checksums are in
`ui/e2e/fixtures/gapminder/source.json`. The same scenario imports 1,704 rows,
transforms/summarizes them, fits an `lm`, and prints scatter/facet/trend plots.
It uses installed R 4.5.2, dplyr 1.2.1, tibble 3.3.1 and ggplot2 4.0.3.9000.
The analysis does not install dependencies.

The Calm Precision acceptance performance run on Apple M4 Pro / 24 GiB, isolated Chrome 152 at
1440 × 900 and device scale 1, used a 4,000-line file, 200 streamed lines with
25 ms pauses and eleven existing plots. It recorded 120 input samples: P95 32.9 ms
from keydown capture to the second animation frame; 192 frame samples had P95
16.8 ms during typing, wheel zoom and splitter movement. This is a browser
measurement under the stated workload, separate from native R execution latency.
Final metrics and 1440 × 900 / 1280 × 800 screenshots are in
`target/studio-browser/`.

The same native Chrome analysis project was used across a review window exceeding
30 minutes for import/model/plots, independent Console drafts, cross-view stdin,
failure pause/resume, inline objects, historical plots and refresh. This is not a
claim of uninterrupted input or measured performance throughout that window.
Restarting the review Host with the current binary retained the application store.
After a saved-file digest check, explicitly running the script in the new R session
changed its binding count from zero to eight and produced three new plot originals;
six historical operations remained available. The recovery observation is in
`target/calm-precision-run/recovery-verification.json`.

Chrome's native IME composition path is exercised through CDP, in addition to
composition-event regression tests. Native macOS keyboard/menu use and the same
analysis project have also been inspected through Chrome. On 2026-09-08, after
reviewing the expected candidate selection, Enter-to-confirm without Console
submission, and stable Chinese text/cursor behavior, the user reported the manual
test successful and accepted it. This closes the native OS candidate-window check;
its evidence is user confirmation, separate from the automated browser composition
tests. Acceptance applies to the stated scope, not every input method or platform.

## Scope

This round targets macOS Chrome, one local project and one R session. It preserves
current application data and the existing scientific owner boundaries. Independent
R sessions, LSP/DAP, full data/package management, Quarto, plugins, a desktop shell
and distribution remain outside this work. No abandoned implementation data is
supported. [Scenario plugins](SCENARIO-PLUGINS.md) remain research.

Read-only package inspection is now included; package installation and environment
management UI remain outside this work.

Current check entry points and prerequisites are in [Development](DEVELOPMENT.md).
The native capability registry owns exact schemas. Keep new evidence and unresolved
focus here; do not append another progress ledger or completed-work archive.
