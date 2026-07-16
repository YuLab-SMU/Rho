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

### Planned

- Stabilize the Windows daily-use workflow around real projects and multiple
  R source files.
- Replace the prototype textarea editor with a language-aware editor and add
  project/file operations.
- Turn Agent approvals, errors and retries into durable, user-visible run
  records.
- Add regression coverage for panel layout persistence, workspace restart,
  cancellation and crash recovery.
- Persist document/session state across application restarts and add a real
  project-directory picker.

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
