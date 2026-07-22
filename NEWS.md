# Rho NEWS

This file records user-visible changes by release. It is intentionally
separate from the architecture plan: the plan describes intended work, while
this file records behavior that is already available in a released build.

## Unreleased

## 0.2.0-dev.12 - 2026-07-22

### Added

- Added a `0.2.0` release-hardening specification, version/tag/resource
  validation and a one-command Rust, R and frontend verification runner that
  writes machine-readable release evidence.
- Added Windows publish gates that verify a clean source checkout, build the
  installer, run bounded Workspace and optional Agent smoke tests, and attach
  the installer checksum and evidence JSON to the GitHub release.
- Added project regression coverage for paths containing spaces and non-ASCII
  text, session and atomic-write behavior under those paths, and deterministic
  truncation at the 2,000-file discovery limit.

### Fixed

- Windows release checks now materialize the bootstrapped Ark executable and
  notices before validating release metadata, fixing clean-checkout CI builds
  where ignored Tauri runtime resources do not exist yet.
- Agent R now receives an explicit stdin EOF after its broker token, model
  profile and prompt are written. This prevents Windows Agent turns from
  stalling before local broker authentication.
- Agent authentication failures now terminate the child process and retain
  bounded, credential-redacted startup stdout and stderr, making pre-provider
  failures diagnosable.
- Windows installer builds now skip copying Ark and its notices when the
  bundled resources already have the expected SHA-256, avoiding a false build
  failure when an identical runtime executable is in use.
- Closing Rho now shuts down the Ark-backed Workspace R session and terminates
  its process tree if graceful shutdown cannot complete, preventing orphaned
  `ark.exe` processes on Windows.
- Rho now keeps a recovery window open when R discovery or runtime preparation
  fails, with Retry, Rscript selection and diagnostic actions instead of a
  silent startup exit.
- Base R startup checks no longer load `aisdk` in the required probe. A broken
  or missing Agent dependency now disables only the Agent panel and can be
  retried without blocking the editor or Workspace R.
- Rho now resolves and explicitly loads the user's `~/.Rprofile` and
  `~/.Renviron` in Workspace R, preserving custom library paths and user-level
  configuration without allowing project startup files to take precedence.
- Missing user `~/.Rprofile` and `~/.Renviron` files are now treated as absent
  optional configuration. Rho no longer exports placeholder paths for them,
  while still preventing project startup files from being loaded implicitly.
- R runtime and Agent configuration probes now execute UTF-8 temporary `.R`
  scripts instead of passing multiline code through `Rscript -e`, avoiding a
  Windows argument-handling failure observed with R 4.4.2.
- Windows startup diagnostics now retain subprocess exit codes, bounded stdout
  and stderr, elapsed time and append-only error history.
- Kept the Agent model selector menu within the visible Agent panel when the
  panel is narrow, instead of allowing the menu to be clipped on its left edge.

## 0.2.0-dev.11 - 2026-07-21

### Fixed

- Fixed a frontend initialization ordering error that left the application at
  `Starting R` and `Loading project files` before Workspace startup could run.

## 0.2.0-dev.10 - 2026-07-20

### Improved

- Agent prompts now support project file references through both `@` mentions
  and the composer `+` menu, including current file, current selection,
  project file, and new-file context badges.
- Proposed Agent file edits now render as a review panel instead of raw JSON in
  the timeline, with explicit Accept, Reject, and one-step Undo actions.
- Accepted Agent edits now reopen the target file, highlight the inserted
  range, and clear stale highlights when you edit, switch files, or dismiss the
  review state.
- File edit proposals now carry explicit editor context source metadata, so
  stale selection and cursor anchors remain reviewable before any write occurs.
- The Agent composer now uses a configurable model selector instead of a
  hardcoded DeepSeek label, and `Manage LLMs...` adds provider/model editing,
  user `.Renviron` opening, credential refresh and bounded connection tests.

## 0.2.0-dev.9 - 2026-07-20

### Improved

- The Agent composer now resizes from a separator along its upper edge, with
  mouse, keyboard and double-click reset support consistent with other panels.
- `get_workspace_snapshot` tool events now show a compact workspace summary
  instead of escaped raw JSON, including R, project, objects, packages and
  rendering capabilities.

## 0.2.0-dev.8 - 2026-07-18

### Fixed

- Plot history is now isolated by project and defaults to the current
  Workspace R session when the Plots panel opens.
- The Plots panel now provides Session/History views and explicit actions to
  clear session plots or all plots in the current project.
- Startup package messages and warnings are rendered correctly when R returns
  a single string instead of a JSON array.
- Running selected R source no longer fails on a leading UTF-8 BOM or editor
  zero-width marker; the marker is removed without changing ordinary Unicode
  inside the code.
- Act mode now offers a session-level authorization switch for `run_r`, so
  approved sessions do not prompt for every individual execution.
- The Act authorization checkbox now reaches Tauri using the correct command
  argument name, and approved `run_r` calls compare their exact R code instead
  of rejecting harmless argument normalization performed by aisdk.
- Agent `run_r` executions use the same Ark Workspace R as manual Console
  commands and now mirror their code, output, warnings and errors into Console.
- Agent history can be cleared explicitly when no Agent turn is active.
- Agent R failures now return a structured failure event and preserve the
  underlying error instead of surfacing only an incomplete-loop message.
- The Code, Analyze and Agent workbench buttons now switch to distinct layouts;
  Code hides the context panel so it no longer opens on the Agent view.
- Agent responses are shown in full in the selected turn, and Monaco is
  relaid out after execution-panel resizing so the editor restores correctly.
- R selections normalize Windows CRLF line endings before parsing, fixing the
  `unexpected invalid token` error caused by a selected leading newline.

## 0.2.0-dev.7 - 2026-07-18

### Fixed

- Agent turns now receive a bounded history of recent user requests, outcomes
  and failure reasons instead of starting with only the latest message.
- Short follow-ups such as `再试一下`, `重试`, `继续`, `retry` and `try again`
  explicitly continue the most recent unresolved goal, preserving dataset,
  variable, output and formatting details rather than inventing an unrelated
  diagnostic action.
- Retried mutations still create a fresh approval request; conversation context
  never reuses a previous approval token.

## 0.2.0-dev.6 - 2026-07-18

### Fixed

- The Files panel now renders an expandable directory hierarchy instead of
  flattening project files into one list.
- Project discovery now includes common R package and scientific text files,
  including `DESCRIPTION`, `NAMESPACE`, `.Rbuildignore`, `.Rd`, Markdown,
  YAML, JSON and compiled-language sources, while excluding binary files and
  generated dependency directories.
- Useful project structure is scanned up to eight directory levels while the
  existing file-count and directory-entry bounds remain enforced.
- Left and right panel limits now preserve the editor's minimum width, restore
  safely after window resizing, and cap the right context panel at 520 pixels.
- Plot, editor and Agent containers now shrink within their grid tracks instead
  of overflowing across the right resize boundary or placing scrollbars inside
  the adjacent panel.

## 0.2.0-dev.5 - 2026-07-17

### Fixed

- Windows runtime probes, Ark Workspace R and Agent R now start with
  `CREATE_NO_WINDOW`, preventing intermittent terminal windows from flashing
  during startup, Workspace restarts and Agent turns.

## 0.2.0-dev.4 - 2026-07-17

### Fixed

- Windows project roots no longer expose the internal `//?/` extended-path
  prefix in the Files panel or project session metadata.
- Agent and run-history commands now pass Tauri's required camel-case command
  arguments, fixing Act history loading, Agent cancellation, run cancellation
  and failed-run retry actions.
- The Files panel now expands `OUTPUTS > plots` into the durable plot history;
  each entry opens its corresponding plot and shows its source when available.

## 0.2.0-dev.3 - 2026-07-17

### Fixed

- Rendering now requires the active `.Rmd` or `.qmd` document to be saved, so
  output and provenance cannot silently refer to different source content.
- Project file notifications advance `project_revision`, while duplicate or
  self-generated save events no longer trigger false external-change prompts.
- Project discovery skips symbolic links and out-of-root directory targets.
- Source editor reads and writes reject files larger than 8 MiB with a clear
  error instead of loading an unbounded CSV, TSV or text file into the UI.
- Source files and project-session JSON now use same-directory atomic writes,
  preventing a failed save or shutdown from truncating the previous content.
- File-watcher events are coalesced, and externally deleted files now close
  clean tabs while preserving dirty drafts that can be recreated with Save.
- A timed-out Workspace restart restores the previous session handles instead
  of leaving the desktop in a disconnected half-restarted state.
- Only one Agent turn can run at a time, preventing accidental concurrent model
  calls and competing Agent R processes.
- Running Agent turns can now be cancelled from the Agent panel without
  restarting Workspace R; pending approvals are marked interrupted as well.
- Rho probes Agent R at startup and reports the installed aisdk version or a
  dependency-loading error before the user sends a prompt.
- Runtime discovery now carries the user's effective `.libPaths()` into the
  profile-free Workspace R, so installed bioinformatics packages remain
  available without executing project or user startup code inside Ark.
- Startup now rejects R versions older than 4.4 with the documented minimum
  version in the error message instead of failing later during Ark launch.

### Changed

- Project discovery reports depth/file-count truncation and stops after 2,000
  supported files or 10,000 scanned directory entries instead of allowing a
  large results tree to block the UI.
- File, Edit, Session and Tools menus now invoke real workbench commands, and
  the Plots shortcut opens the plot dock; unimplemented Settings chrome was
  removed.
- Monaco now provides bounded local completion for R keywords, common
  functions and live Workspace objects, plus document symbols for simple R
  assignments and functions.
- The development roadmap now reflects the implemented `0.2.x` surface and
  identifies clean-install acceptance as the remaining M1 release gate.

## 0.2.0-dev.2 - 2026-07-16

### Added

- Native project selection with per-project restoration of open and closed
  document drafts, cursor positions and panel sizes.
- Monaco-based R editing with selection, current-line and complete-file
  execution in the authoritative Workspace R.
- Durable Runs, Problems, retry links, cancellation state and restart recovery.
- Broker-owned Agent turn history and explicit Act approval controls showing
  the exact tool, code, request id and workspace revision.
- Project environment diagnostics for R, library paths, `renv`, Bioconductor
  and attached packages.
- Bounded object previews, durable plot history with provenance, and optional
  Quarto/R Markdown render diagnostics.

### Fixed

- Agent mutations now require a single-use broker approval bound to the exact
  request arguments; Ask and Plan cannot bypass the mutation policy.
- Cancel and Interrupt no longer wait behind the active Workspace execution
  lock, and restart cancels Agent tasks and stale approvals before relaunch.
- Project file and render paths are rejected before any out-of-root filesystem
  side effect or document execution can occur.
- Closed dirty drafts have synchronous browser fallback persistence so recent
  edits survive normal application close and restart.
- Project file writes and project switches now advance `project_revision`.
- Object previews cap long strings and nested cells instead of bounding only
  row and column counts, including long list element names.
- Render and plot provenance now use the editor's actual document version and
  no longer mark Console-only plots as complete source provenance.

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
