# WP2 Monaco Editor And Source Execution Design

Date: 2026-07-16
Status: Implemented in `0.2.0-dev.2`
Scope: `docs/plans/implemented-0.2x-agent-handoff.md` WP2

## Goal

WP2 replaces the textarea-based source editor with a real R editing surface
that supports syntax-aware editing, selection execution, current-line
execution, and whole-file execution while preserving the existing workbench
architecture.

The design must preserve these constraints:

- Workspace R remains the only authority for execution and live objects.
- Rust broker remains the protocol boundary for execution and provenance.
- Agent R remains separate from Workspace R.
- The workbench protocol must stay independent of editor internals.
- The installed application must not require a runtime Node process.
- Browser-mode fallback must continue to work.

## Non-Goals

WP2 does not add:

- notebook semantics;
- Python syntax or Python execution;
- an xterm-based R Console;
- full language-server integration as a delivery gate;
- heavy remote completion infrastructure;
- a second document authority outside the existing document model.

Completion is optional and may only be added if it stays bounded, local, and
does not put the rest of WP2 at risk.

## High-Level Architecture

Monaco becomes the new editing surface, but it does not become the application
core. The existing three-layer shape remains:

1. Workspace R executes all code.
2. Rust broker commands and state boundaries remain authoritative.
3. The frontend document model remains the authority for tabs, dirty state,
   cursor restoration, and session persistence.

Monaco is integrated through an editor adapter rather than being wired directly
into workbench logic. This keeps execution, restoration, and project/session
behavior independent from Monaco-specific APIs.

Monaco must load as a frontend asset. Its workers and runtime resources are
served from static workbench files so that the Tauri build and browser fallback
both work without starting a Node process in the installed application.

Execution remains a Rust command flow, but WP2 makes execution intent explicit:

- execute selection;
- execute current line;
- execute whole file.

Whole-file execution must include source path and document version information
so that provenance and later run-tracking work in WP3 without redesign.

Dirty state, save state, and cursor/selection restoration remain attached to
the document model, not the Monaco instance. The editor may be recreated; the
document session state must survive it.

## Component Breakdown

### `EditorAdapter`

This frontend layer wraps Monaco behind a stable interface. It exposes only a
small set of editor actions:

- `loadDocument`
- `getSelectionOrCurrentLine`
- `getCursorState`
- `setCursorState`
- `onContentChange`
- `onExecuteSelection`

It owns editor instance lifecycle, model binding, content subscriptions, cursor
state synchronization, and shortcut registration. It does not directly invoke
Rust commands or decide execution policy.

### `DocumentModel`

The existing document model becomes the authoritative editing-session model. It
stores at least:

- `content`
- `savedContent`
- `cursor/selection`
- `versionId`
- `path`
- `language`
- `lastExecutedRange`

Monaco models are views over this state, not the state itself.

### `ExecutionController`

This layer translates editor actions into Rust execution commands. It
distinguishes three execution modes:

- selection execution;
- current-line execution;
- whole-file execution.

It is responsible for attaching path and document-version metadata for file
execution and for refusing unsafe fallbacks such as silently executing the
entire document when the user requested current-line execution.

### `MonacoBootstrap`

This layer handles Monaco resource loading:

- main editor bundle;
- workers;
- R language wiring;
- theme registration;
- shortcut initialization.

All resource-path logic is isolated here so editor bootstrapping changes do not
spread into workbench logic.

### `LanguageFeatures`

This layer stays intentionally thin in WP2. It provides:

- syntax highlighting for R;
- bracket matching;
- indentation behavior;
- file-type recognition.

Completion, if added, must remain optional, local, and degradable.

### `EditorShell`

This is the workbench integration layer. It connects:

- tabs;
- save and run actions;
- status bar cursor display;
- panel resize and redraw hooks;
- Monaco lifecycle and the current workbench layout.

It integrates Monaco into the existing workbench rather than redesigning the
entire UI.

## Data Flow

### Startup Restore

WP1 session restoration restores the project and document model first.
`EditorShell` then asks `EditorAdapter` to bind Monaco models to the restored
documents and the active document.

This order matters. The document session state must exist before Monaco binds to
it so that cursor position, selection, and content restoration remain stable.

### Tab Switch

When the user switches tabs:

1. the active Monaco model writes current content, selection, and scroll state
   back to `DocumentModel`;
2. the target document model becomes active;
3. Monaco swaps to the target model.

Tab switching is a model swap, not an editor recreation.

### Editing

Monaco content changes flow into `EditorAdapter`, which updates
`DocumentModel.content` and `versionId`. Existing dirty-state, save-state, and
session-persistence behavior remain attached to the document model.

WP2 therefore upgrades the editor without replacing the WP1 restoration chain.

### Execution

`ExecutionController` determines execution mode:

- if a selection exists, execute the selected text only;
- if no selection exists and current-line execution is requested, compute and
  execute only the current line;
- if whole-file execution is requested, execute the document content and attach
  file path plus document version metadata.

Whole-file execution must preserve source identity for later run provenance.

### Execution Result Handling

Execution responses continue through the existing Console, Problems,
Environment, and Plots renderers. `DocumentModel` additionally records:

- `lastExecutedRange`;
- last whole-file execution version.

This makes the user-visible editor state less opaque without waiting for WP3.

### Resize And Redraw

Panel resizing, layout switches, and window resizes call a Monaco layout update
only. These events must not clear selection, cursor state, or editor models.

## Error Handling And Failure Behavior

### Monaco Load Failure

If Monaco fails to load, the workbench degrades to the existing textarea editor.
The user receives an explicit notice that the advanced editor failed to load and
the application is running in basic mode.

The workbench must not white-screen because editor assets fail.

### Resource And Worker Failure

Monaco asset-path and worker failures are contained inside `MonacoBootstrap`.
They must not cascade into project restoration, Workspace R startup, or general
file operations.

### Current-Line Execution Guard

If the current line has no executable content, the action is blocked with a
clear message such as `Current line is empty`. It must never silently execute
the entire file.

### Selection Execution Guard

Selection execution runs the literal selected text only. WP2 does not attempt
smart expansion to inferred blocks. The system must remain predictable.

### Editor And Document Desynchronization

If Monaco state and `DocumentModel` diverge, `DocumentModel` wins. Monaco may
be recreated from document state; document state must not be reconstructed from
an unstable editor instance.

### Completion Degradation

If completion is implemented and its provider fails, times out, or harms typing
latency, the editor immediately degrades to no-completion mode. Completion is a
weak dependency, not a hard requirement.

## Testing Strategy

### Frontend Adapter And Controller Tests

Add focused tests for:

- `EditorAdapter` cursor and selection state synchronization;
- `ExecutionController` separation of selection, current-line, and whole-file
  execution;
- tab switching writing state back into `DocumentModel`.

Do not add tests that merely restate Monaco behavior itself.

### Integration Coverage

Add integration coverage for:

- project restoration followed by Monaco binding to the active document;
- tab switches preserving dirty state and cursor state;
- selection execution not executing unrelated code;
- current-line execution rejecting empty lines;
- whole-file execution carrying path and version metadata.

### WP1 Regression Coverage

Add regression checks that confirm Monaco integration does not break:

- project/session restoration;
- dirty draft restoration;
- external-change conflict handling;
- panel-size restoration.

### Manual Acceptance

Run manual acceptance against the workbench:

1. open multiple R files and restart the application to confirm restoration;
2. execute a selection without executing surrounding code;
3. execute the current line without executing the whole file;
4. execute an entire `.R` file and confirm source-path linkage;
5. resize panels and confirm cursor and selection state stay coherent;
6. save, close, and reopen a document and confirm content plus cursor restore.

### Performance And Degradation

Verify that:

- Monaco load failure degrades to the textarea editor;
- larger `.R` files do not visibly freeze the workbench;
- disabled or failing completion does not block typing or execution.

## Implementation Notes

Implementation should proceed in this order:

1. static Monaco resource loading and bootstrap;
2. `EditorAdapter` and document-model integration;
3. execution controller for selection/current-line/file execution;
4. status bar, resize, and recovery integration;
5. optional bounded completion only if earlier steps are already stable.

The preferred implementation touchpoints are:

- `desktop/dist/app.js`;
- `desktop/dist/index.html`;
- `desktop/dist/styles.css`;
- `desktop/src-tauri/src/main.rs` only where execution metadata must expand;
- targeted tests and updated documentation.

## Done Criteria For WP2

WP2 is complete when the desktop prototype can:

1. open an R document in Monaco with syntax-aware editing;
2. execute a selection without executing unrelated code;
3. execute the current line without executing the whole file;
4. execute a full `.R` file with visible source-path linkage;
5. preserve content and cursor position across save and reopen;
6. preserve editor correctness during panel resize and layout changes;
7. degrade safely if Monaco or optional completion features fail.
