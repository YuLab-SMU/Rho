# WP1 Project Opening And Session Restoration Design

Date: 2026-07-16
Status: Approved design baseline
Scope: `docs/0.2x-agent-handoff.md` WP1

## Goal

WP1 makes project selection and recovery a real daily workflow for the desktop
prototype. The implementation must add native project selection, durable
project-scoped session restoration, explicit unavailable-project handling, and
external file change detection without replacing the existing Workspace R
authority or browser-mode fallback.

## Non-Goals

This work package does not add:

- cloud sync;
- multi-user locking;
- a general file manager;
- notebook semantics;
- a second workspace authority;
- broad filesystem merge tooling.

The design keeps Workspace R as the only authority for live R execution and
objects. Agent R remains an `aisdk` host, not a second scientific workspace.

## High-Level Architecture

Rust becomes the authority for project session state in WP1. The desktop layer
already owns `project_root`, runtime startup, and `setwd()` synchronization.
WP1 extends that role with a project session store located under the
application-local data directory.

Session data is split into two levels:

1. A global index that stores `last_opened_project`.
2. A per-project session snapshot keyed by the normalized project root.

Each project snapshot stores:

- open document list;
- active document path;
- per-document cursor positions;
- panel sizes;
- project availability state.

The frontend does not infer project truth on its own. It requests restoration
from Rust during startup and renders the returned state. If the most recently
opened project no longer exists, Rust returns an explicit unavailable-project
result instead of silently falling back to a default directory.

Project switching is also mediated by Rust. The frontend requests a native
directory picker through a narrow Tauri command. Rust validates the selection,
synchronizes `setwd()` in Workspace R, updates the session index, switches the
active watcher, and returns the file tree and any existing session snapshot for
the chosen project.

External file changes are handled through a watcher plus explicit conflict
states. Rust reports change events. The frontend refreshes the file tree and
marks dirty open documents as conflicted instead of silently replacing their
content.

## Component Breakdown

### `desktop/src-tauri/src/project.rs`

This new module isolates WP1 logic from `main.rs`. It owns:

- project path normalization;
- project session read and write;
- `last_opened_project` management;
- project availability checks;
- coordination of project switching and `setwd()` updates.

`main.rs` remains focused on startup, runtime assembly, and command
registration.

### `ProjectSessionStore`

This Rust component persists project session metadata as JSON files under the
application-local data directory. It does not reuse the existing SQLite event
store in WP1.

The store uses:

- one global index file for recent project metadata;
- one session file per normalized project root, named by a stable hash.

The normalized project root remains the logical key. The hash only keeps file
names filesystem-safe and stable on Windows.

### `ProjectWatcher`

This Rust component watches the current project root and emits coarse change
notifications for:

- file tree refresh;
- on-disk file updates relevant to open documents.

It is intentionally simple. It detects and reports changes. It does not attempt
content merging or become a file synchronization engine.

### Frontend State Split

The current monolithic `state` object in `desktop/dist/app.js` is split into:

- `projectState` for Rust-owned project truth;
- `editorState` for transient in-memory editor state.

Restoration, project switching, and watcher events flow through explicit sync
entry points so that old project data cannot leak into a new project view.

### `Session Hydrator`

The frontend adds a small restoration layer that takes the Rust snapshot and
hydrates:

- open tabs;
- active document;
- cursor position;
- panel sizes.

It restores only what Rust returns. It does not guess defaults beyond the
minimal empty-project fallback.

### `Conflict UI`

The frontend adds a thin conflict surface for dirty documents that changed on
disk. It is not a general merge tool. It presents explicit choices and blocks
silent overwrite.

## Data Flow

### Startup Restore

At startup the frontend calls `workspace_start`, then `project_restore_session`.
Rust loads the global session index, reads `last_opened_project`, normalizes the
path, and checks whether the directory still exists.

If the project is available, Rust:

1. loads the per-project snapshot;
2. synchronizes Workspace R with `setwd()`;
3. returns the file tree and restoration payload.

If the project is unavailable, Rust returns an explicit unavailable result with
the saved path and failure reason. The frontend enters an unavailable-project
state instead of silently choosing another directory.

### Project Switch

When the user chooses to open a project, the frontend calls
`project_pick_directory`. Rust opens the native directory picker, validates the
selected directory, updates the active watcher, synchronizes `setwd()`, updates
the global index, and returns:

- normalized project root;
- current file tree;
- any existing project session snapshot.

If this is the first visit to the project, Rust returns an empty snapshot plus
default panel sizes.

### Session Persistence

The frontend updates transient editor state during:

- tab open and close;
- active tab changes;
- cursor movement;
- panel resizing;
- save actions.

At appropriate points it calls `project_save_session` to persist session
metadata only. File contents continue to use `project_write_file`. Session state
and file content remain separate concerns.

### External Changes

When the watcher reports a filesystem change, the frontend refreshes the file
tree. For open documents:

- if the document is not dirty, the frontend may reload the on-disk content and
  show a light notification;
- if the document is dirty, the frontend marks it as conflicted and waits for
  an explicit user decision.

The available actions are:

- keep local content and save later;
- discard local changes and reload from disk.

No automatic merge is attempted in WP1.

### Exit And Switch Flush

Before a normal application exit or before switching to another project, the
frontend flushes the current session snapshot so the next restore is close to
the user’s last state.

## Error Handling And Failure Behavior

### Unavailable Project

Unavailable projects are first-class state. If the saved project path is
missing, inaccessible, or cannot be normalized, the frontend renders an
explicit unavailable state with:

- the saved path;
- the reason;
- a clear action to select another project.

The file tree, editor, and run affordances remain in a safe state until a valid
project is chosen.

### Path Safety

Path traversal remains a hard error. Any relative path that escapes the current
project root, or any path that targets an unsupported file type, is rejected by
Rust without automatic correction.

### `setwd()` Synchronization

Project switching is only complete after Workspace R confirms the working
directory change. A directory selection alone does not mean success. If `setwd()`
fails, Rust does not advance the current project or the recent-project index.
The UI remains attached to the previous project state.

### Dirty Document Conflicts

On-disk changes are split into two cases:

- clean documents may reload automatically with a lightweight notification;
- dirty documents never reload automatically and instead enter a conflict state.

The user must explicitly choose between preserving local edits or discarding
them in favor of the on-disk version.

### Session Metadata Failures

Session metadata write failures are soft failures. If cursor positions or panel
sizes cannot be saved, the application warns that restoration state was not
persisted, but editing may continue.

Project switching, directory selection, and file writes remain hard-failure
paths. If they fail, the operation is not considered successful.

### Watcher Degradation

Watcher events may be noisy or lose detail. The fallback behavior is a full file
tree refresh. The system may become less precise, but it must not present stale
state as authoritative truth.

## Testing Strategy

### Rust Unit Tests

Add focused unit tests for:

- project path normalization;
- stable hashed session file keys;
- global index read and write for `last_opened_project`;
- per-project snapshot serialization and deserialization;
- unavailable-project state detection.

### Rust Integration Tests

Add integration coverage for:

- project opening followed by `setwd()` synchronization;
- restart restoration of project root and active document;
- missing project roots restoring as unavailable;
- rejected out-of-root paths;
- corrupted session metadata degrading to an empty snapshot instead of crashing.

### Frontend High-Value Behavior Tests

Add targeted tests for:

- restoring tabs, active document, cursor position, and panel sizes from a
  session payload;
- project switching without state leakage from the previous project;
- dirty document conflict handling after external file changes.

Avoid low-value tests that simply restate implementation details.

### Manual Acceptance

Run the WP1 acceptance workflows against the desktop build:

1. choose a directory and restart Rho to confirm the same project and document
   return;
2. close and reopen a dirty document and confirm an explicit choice is shown;
3. verify a path outside the project root is rejected;
4. modify a file externally and confirm dirty editor content is not silently
   overwritten;
5. confirm project state survives a normal application restart.

Record the exact commands, test counts, and manual workflow steps for handoff
review.

## Implementation Notes

Implementation should begin with the Rust authority layer and restoration
commands before changing the frontend hydration flow. This sequence reduces the
risk of building more UI state on top of an unreliable persistence model.

The preferred implementation touchpoints are:

- `desktop/src-tauri/src/main.rs`;
- new `desktop/src-tauri/src/project.rs`;
- `desktop/dist/app.js`;
- `desktop/dist/index.html`;
- `desktop/dist/styles.css`;
- `docs/windows-prototype.md`;
- targeted tests.

## Done Criteria For WP1

WP1 is complete when the desktop prototype can:

1. open a project through a native Windows directory picker;
2. restore the last opened project during startup;
3. restore project-scoped open documents, active document, cursor position, and
   panel sizes;
4. show an explicit unavailable-project state when the saved root no longer
   exists;
5. detect external file changes and avoid silently overwriting dirty editor
   content.
