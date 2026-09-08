# Rho: current state and focus

Updated: 2026-09-08. This is the single current status page. Code and reproducible
results establish behavior; Git retains the implementation history.

## Current focus

**Calm Precision implementation and acceptance are complete for this round.**
The automated and native R checks below passed, and the user confirmed the final
macOS Chinese input-method manual check passed on 2026-09-08. The interaction
specification is in [Design](RHO-DESIGN.md#10-studio-interaction-contract), with
repeatable checks mapped to the seven reported issues in
[Studio feedback](STUDIO-FEEDBACK.md#acceptance-map-for-the-calm-precision-implementation).
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

The final run passed all 20 check entry points: Rust formatting, workspace Clippy
and tests; contract generation, client build and asset checks; 39 frontend tests;
the current binary build; 22 isolated Chrome scenarios; five explicitly enabled
native Ark/R tests; MCP and HTTP Workbench checks with and without real R;
environment isolation, process recovery, remote protocol fixtures, architecture,
documentation governance and its tests. The command manifest and individual logs
are in `target/calm-precision-run/checks/`. Skipped external tests are not counted
as passes. Remote protocol checks use local fixtures, not a live SSH/Slurm cluster.

Native checks cover per-expression Console printing, stdin identity and single
answer handling, shutdown while waiting for input, original media reads without
live R, and input/control access with 32 waiting MCP execution calls. Environment
checks use temporary fixture libraries and verify the user library is unchanged.

The fixed gapminder CSV is pinned to upstream version 1.0.1, commit
`5864ccaf4d4d59ca578c098a1400d2fed20584c0`; source and converted CSV checksums are in
`ui/e2e/fixtures/gapminder/source.json`. The same scenario imports 1,704 rows,
transforms/summarizes them, fits an `lm`, and prints scatter/facet/trend plots.
It uses installed R 4.5.2, dplyr 1.2.1, tibble 3.3.1 and ggplot2 4.0.3.9000.
The analysis does not install dependencies.

A final performance run on Apple M4 Pro / 24 GiB, isolated Chrome 152 at
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

Current check entry points and prerequisites are in [Development](DEVELOPMENT.md).
The native capability registry owns exact schemas. Keep new evidence and unresolved
focus here; do not append another progress ledger or completed-work archive.
