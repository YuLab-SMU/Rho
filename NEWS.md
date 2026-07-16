# Rho NEWS

This file records user-visible changes by release. It is intentionally
separate from the architecture plan: the plan describes intended work, while
this file records behavior that is already available in a released build.

## Unreleased

### Added

- Initial `0.2.x` project-file foundation: a project root, source-file tree,
  multiple open document state, file reads/writes and new source files.
- Project paths are constrained to the selected root and editable extensions
  are explicitly allowlisted.
- Opening a project synchronizes the Workspace R working directory.
- Native Windows project selection now restores the last opened project and
  its per-project session state.
- Project session restore now tracks open documents, active document, cursor
  positions, dirty drafts and panel sizes in the app-local data directory.
- Missing project roots now show an explicit unavailable-project state instead
  of silently falling back.
- External file changes refresh the project tree and avoid overwriting dirty
  editor content without an explicit choice.
- Monaco now provides the primary R source editor with syntax highlighting,
  bracket matching and textarea fallback when advanced loading fails.
- The editor now distinguishes selection, current-line and whole-file
  execution, and whole-file runs retain source-path metadata.
- Executions now persist as durable run records with explicit lifecycle states,
  retry links and restart recovery markers in the broker-owned SQLite store.
- Problems now derive from structured execution records instead of transient
  console-only output, and the Runs sidebar exposes cancellable active runs.

### Planned

- Stabilize the Windows daily-use workflow around real projects and multiple
  R source files.
- Add bounded local completion and richer R language features without pulling
  in a heavyweight language server dependency.
- Turn Agent approvals, errors and retries into durable, user-visible run
  records.
- Add regression coverage for panel layout persistence, workspace restart,
  cancellation and crash recovery.

## 0.2.0-dev.1 - 2026-07-16

### Added

- First `0.2.x` development build for real project files.
- Broker-safe project root and source-file listing.
- File-tree and multiple document-tab state in the workbench.
- Read, save and create-file commands for supported source files.
- Workspace R working-directory synchronization when a project is opened.

### Not Yet Complete

- Native directory picker, durable document restoration, language-aware
  completion, approval dialogs, cancellation and crash recovery remain in the
  rest of the `0.2.x` milestone.

## 0.1.1 - 2026-07-16

### Added

- Draggable horizontal divider between the source editor and the Console,
  Plots and Problems dock.
- Draggable vertical dividers for the Files and Agent/Environment panels.
- Persistent panel sizes, keyboard arrow adjustment and double-click reset.
- Expand/restore control for the execution dock, useful for inspecting plots.
- Mouse and Pointer Event support for panel resizing.
- Windows NSIS installer rebuilt with the resizable workbench.

### Changed

- Prototype version advanced from `0.1.0` to `0.1.1`.
- Windows prototype documentation now describes panel layout behavior and
  the current development boundary.

## 0.1.0 - 2026-07-16

### Added

- First installable Windows Tauri prototype.
- Ark-backed persistent Workspace R session with no Python or Jupyter Server.
- Rust broker using direct Jupyter/ZeroMQ transport.
- R source editor, live Console, Environment object manifest, Plots and
  structured Problems surface.
- Ask, Plan and Act Agent modes backed by `YuLab-SMU/aisdk`.
- DeepSeek end-to-end Agent turn against the same Workspace R session.
- Broker-owned SQLite event store, workspace revisions and stale-context
  rejection.
- Windows installer carrying Ark, `WebView2Loader.dll` and runtime notices.

### Verification

- Rust workspace tests, `rho.agent` tests and `rho.bridge` tests pass.
- Installed release verified to launch Ark from the installation directory.
- Desktop smoke test verified R execution, plot output and Environment state.
