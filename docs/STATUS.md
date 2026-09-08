# Rho: current state and focus

Updated: 2026-09-08. This is the single current status summary. Code and executed
checks establish behavior; Git retains implementation history.

## Current focus

**The modular Studio and reliable information-flow delivery is implemented and
locally verified.** The integration baseline was `8b4f1e4ed1b242dbc9714436ccddf8be949c6c19`
with a clean worktree, 48 passing frontend tests and passing type checks.

Session, Operations, Console, Objects, Packages, Files, Documents, Outputs,
MediaCache, Plots and Layout now own their state behind read-only snapshots,
subscriptions and explicit commands. Studio only composes modules and coordinates
startup/switch/stop. Generic `useStudio`, global string commands, mutable callback
slots, the old polling implementation and scientific state forwarding are removed.
The built-in registry owns panel metadata, render keys, menus and restore validation.
Frontend dependency/mutation checks and their allow/reject fixtures run in CI.

The Operation owner provides `operation.events_checkpoint` and exact operation-ID
summary lookup. Project/principal filtering precedes checkpoint aggregation and
subscription pagination. Startup establishes an event baseline before restoring
state and observing recent/current/pending/pinned work; it retries failed stages
without skipping drafts or request identities. Existing clients resume completed
page cursors; cold clients do not restore the obsolete persisted event cursor.

The runtime coordinator serializes/coalesces native observation demand, isolates
failures and retains control/event cadence. A ready, exhausted output read can
finish only if it began after terminal was already observed. Packages retries
retain observation identity; expiry needs explicit Refresh. View tokens preserve
same-name preview demand, including expanded rows below the scroll viewport,
while inactive panels suspend reads. Console and Plots share validated originals.

One optimistic SQLite application-state write combines module fragments. Captured
save/run text, dirty edits during writes, formatting comparisons, acknowledgement
loss and multiwindow conflicts retain their semantics. A native-session change
cannot turn the client's own unacknowledged save into a false window conflict.
If another window changes the Host's project, local drafts stay editable and the
client reports the mismatch while withholding native availability.

Durable boundaries and protocol details are in [Architecture](ARCHITECTURE.md).

## Executed verification

| Check | Result |
| --- | --- |
| Frontend typecheck and all units | Passed; 226 tests across 17 files |
| Frontend boundaries and allow/reject fixtures | Passed; 24 fixtures |
| Client generate → build → check | Passed; generated DTOs and embedded assets current |
| Rust fmt / workspace Clippy / workspace tests | Passed; 84 default tests |
| Real Ark/R tests and native code/package queries | Passed; all five real-R tests executed, including package read-only invariants |
| Real environment tests and CLI recovery | Passed; both opt-in environment tests executed in temporary libraries |
| Workbench and MCP, ordinary and real R | Passed; actual local transports and shared principal/session paths |
| Process recovery and local SSH/Slurm protocol fixtures | Passed; no live remote-cluster claim |
| All Chrome scenarios | Passed; original 23 plus three new scenarios, 26 total |
| Governance, Rust dependency graph and Jet integrity/fixtures | Passed |

The seven tests ignored by the ordinary Cargo invocation were executed separately:
five real-R tests and two environment tests. They are not counted as passes merely
because the default workspace invocation skipped them. All Cargo invocations,
including client generation and script-internal builds, were serialized.

The Chrome run uses the pinned gapminder dataset (1,704 rows), existing analysis
script and installed R/packages. The performance workload retains eleven historical
plots, a 4,000-line file and 200 streamed lines with 25 ms pauses. It collects 120
input samples on Apple M4 Pro / 24 GiB, Chrome 152, 1440 × 900 at device scale 1.
Input P95 passed `<50 ms`; frame-interval P95 passed `<33 ms` during typing, zoom
and splitter movement. Equal four-second windows each invalidate the same R state;
adding a second visible Console and Plot view does not multiply observation/control
requests and makes no duplicate read of the selected original. Exact measurements
and request counts are in the performance JSON, separate from native R latency.

Visual inspection covers 1280 × 800, 1440 × 900, maximized and constrained panels.
Gapminder screenshots wait for the exact producing operation's last plot to decode.
Package compact/wide inspection preserves the approved Paper interaction and styles,
including purpose/version priority and installed-copy Source details. The previous
macOS IME approval remains the established manual evidence; native Chrome CDP
composition and the Console composition regression are also exercised here.

Local evidence lives in `target/modularization-review/` and `target/studio-browser/`.
The final committed-tree verification writes command logs, commit/tree identity,
screenshot/performance copies and artifact hashes to
`target/modularization-review/final/manifest.json`. Earlier failed regression runs
are retained only as local test evidence; they are not current acceptance results.
CI is configured for the existing platform matrix; local macOS execution is the
verified platform here.

## Resume and scope

The built executable is `target/debug/rho`. The acceptance harness uses disposable,
isolated projects and closes its Hosts. Existing user Hosts and R memory were not
restarted or replaced. Inspect live ownership, current work, queue and stdin before
restarting an existing review Host; new query capabilities require the current
binary and cannot be added by a client refresh.

The earlier user review paths remain `target/calm-precision-project` and
`target/calm-precision-run/next.sqlite`, with the sibling application store
`next.studio.sqlite`. They were not used as destructive test fixtures. Ports, PIDs
and launch tokens are transient and must be observed again. See
[Operations](OPERATIONS.md) for launching and [Development](DEVELOPMENT.md) for checks.

The approved Packages design remains in
[Paper](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0).
One local R session, current project data and the existing scientific owners remain
supported. Core Packages is read-only; viewing does not install, attach or load
packages or alter library paths. Third-party plugin loading, independent R sessions,
package management, abandoned-data migrations, installation and publication were
not added. The pinned Jet core and ordered patches remain intact.
