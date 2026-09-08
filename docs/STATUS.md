# Rho: current state and focus

Updated: 2026-09-08. This is the single current status page. Code and reproducible
results establish behavior; Git retains the implementation history.

## Current focus

**Jet dependency consolidation is complete and verified.** The previous full upstream tree has been replaced by
`vendor/jet-core`: the core Cargo manifest, twelve unchanged Rust source files,
original license and generated provenance document. The pinned upstream revision
remains `52ae131dd168fe2e104d306cc4bf5bbeae749200` and the root Cargo.lock is unchanged.

Six ordered patches in `patches/jet` capture standalone manifest packaging and all
previous Rho adaptations: Windows liveness/cleanup/window behavior, environment
removal, shared-client interruption, stdin redaction and watchdog descriptor
isolation. Offline reverse/forward replay and an independent checksum-pinned
archive reconstruction have passed, including effective Cargo manifest comparison.
The updater stages proposals without changing production source, and regression
fixtures exercise corruption, missing/extra files, links, patch failure and manifest
drift. The vendored tree decreased from 109 files / 624,623 bytes to 15 files /
138,750 bytes, excluding the separate patch series and maintainer tooling.

Executed checks passed: offline snapshot verification, independent upstream archive
replay (both supplied archive and fetched cache), a real preparation of the current
pin, verifier regression fixtures, Rust formatting, workspace Clippy/tests, binary
build, generated-client/asset check, all five enabled real Ark/R tests, MCP transport
checks and real-R Workbench checks. Architecture and documentation governance checks
passed. Logs and the before/after source hashes are in `target/jet-vendor-review/`.
The CI workflow is configured for the native platform matrix; only local macOS
execution is claimed here. No upstream version or production lockfile changed.

The Paper-approved Packages redesign remains implemented and verified. Its grouped
package/purpose/version view, inline/wide inspector, cached filtering and per-copy
Source metadata are unchanged by the dependency reorganization. The review design
is in [Paper](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0).

No package manager or installation flow was added. Unknown provenance stays
unrecorded; the local ggplot2 case distinguishes GitHub 4.0.3.9000 from CRAN 3.5.2.
Repository/provider/snapshot fields rely on recorded installed metadata. External
conda databases, arbitrary private servers and renv lockfiles are not used as
unverified substitutes for the installed copy's identity.

Installation and environment-management decisions remain reserved for a future
separate plugin. See [Design section 11](RHO-DESIGN.md#11-read-only-package-inspection)
and [F08](STUDIO-FEEDBACK.md#f08--package-inspection-without-installation-decisions).
Calm Precision's prior acceptance, including the user's macOS Chinese IME check,
remains established.
The frozen baseline remains commit `d5a970b1559c9bd85567073108d05bca21886de4`, tagged
`studio-round1-baseline-2026-09-07`.

## Resume in a new session

Packages was delivered in commit `83b9de6` on branch `wip/rho-next`.
The completed Jet reorganization follows that implementation; use Git for the exact
latest revision. No required work remains from these two authorized tasks.
Repository instructions are consolidated in the root `AGENTS.md`.

The review project is `target/calm-precision-project`, the operation journal is
`target/calm-precision-run/next.sqlite`, and its application store is the sibling
`next.studio.sqlite`. The built executable is `target/debug/rho`. At handoff,
Chrome has the new Packages view open on the real ggplot2 Source inspector.
The preview was restarted only after confirming an idle session with zero user
bindings, no queue and no input request. R memory is not a recovery artifact.

Inspect live Host ownership before launching another process. If the review Host
has stopped, run this from the repository root and open its newly printed private
URL (ports and tokens are ephemeral):

```sh
target/debug/rho --database "$PWD/target/calm-precision-run/next.sqlite" \
  --project "$PWD/target/calm-precision-project" \
  workbench --dev-assets "$PWD/crates/workbench/assets"
```

The review material under `target/` is local and untracked. If it has been cleaned,
use the tracked gapminder fixture and the operator guide to prepare a new review
project; do not treat a missing fixture as a migration or recovery requirement.

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
| Packages | Paper layout, grouped names/purposes/versions, global observed counts and cached search; inline/wide inspection, per-copy Source and recorded metadata, consistent observation/session guards |
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

Package checks cover grouping/counts, pinned pagination/detail identity, observation
expiry, current versus first-library copies, linked/outside-path namespaces,
GitHub/CRAN/R-universe metadata, repository provider/snapshot records, unknown source,
credential removal, safe links and unchanged R namespaces/search path. The new
Chrome scenario exercises grouped copies, Source switching, full commit evidence,
busy cached search, library dialog focus, 1280 px compact and 1440 px wide layouts,
and close/reopen continuity. Verification passed Rust formatting, workspace Clippy
and workspace tests; contract generation, client build and asset checks; 48 frontend
tests; all 23 isolated Chrome scenarios; five real Ark/R tests and the package
fixture; and MCP/Workbench checks both with and without real R. Architecture and
documentation governance checks passed. Logs are in `target/packages-paper-checks/`;
compact and wide screenshots are in `target/studio-browser/packages-paper-compact.png`
and `packages-paper-wide.png`.

The existing review Host was idle with zero user bindings and no queued work or
stdin request before replacing it with the current binary. Native Chrome now shows
the new Packages view with 602 package names / 736 installations. The real ggplot2
Source inspector shows tidyverse/ggplot2, ref HEAD and commit 6870419aa6e1 for the
GitHub copy, alongside the separately recorded CRAN copy. Synchronized documents,
layout and historical output remain in the same application store.

Sources were read from local installed metadata for inspection, and test-only
DESCRIPTION fixtures were written to temporary directories. Package viewing does
not install or load those fixtures. The implementation uses generated Rust contracts
and current embedded assets; older running Hosts need the newly built binary for
the observation protocol.

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
