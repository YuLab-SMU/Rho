# Agent File Editing V1 Design

Status: implementation handoff

Target release: `0.2.0-dev.10` or later

## 1. Goal

Add a human-controlled file editing workflow to the Agent panel. The Agent may
prepare an edit, but it must not write a project file directly. The desktop
shows the exact proposed change and writes it only after the user selects
`Accept`.

The first version supports one file edit proposal per Agent turn:

- replace the current editor selection;
- insert at the current editor cursor;
- append exact text to an existing project file;
- create a new project file;
- review a before/after diff;
- accept or reject the proposal;
- open the changed file and highlight the inserted text;
- undo the accepted edit as one operation.

File references have two equivalent entry points:

- type `@` in the Agent input and select a project file from autocomplete;
- select the `+` button and choose a project file, the current file, the
  current selection, or a new project-relative path.

Both entry points must produce the same structured project-relative file
reference. There must not be separate `@` and attachment semantics.

## 2. Product Principles

### 2.1 Human remains authoritative

Rho is a copilot inside the user's live editor and Workspace R. The Agent may
generate a proposed change, but only the desktop application may apply it, and
only after an explicit user action.

`propose_file_edit` is therefore a read-only proposal tool. It must never call
`project_write_file`, `project_create_file`, or another filesystem API.

### 2.2 Project boundary is mandatory

V1 may reference and modify only files inside the active project root. Paths
must be project-relative and must pass the existing checks in
`desktop/src-tauri/src/project.rs`:

- `project_path()` prevents escaping the project root;
- `ensure_editable_file()` restricts supported text file types;
- `ensure_editable_content_size()` enforces the editor size limit;
- writes use `atomic_write()` or `atomic_write_new()`.

Do not add unrestricted filesystem access to Agent R.

### 2.3 No silent semantic placement in V1

The supported operations are explicit:

```text
replace_selection
insert_at_cursor
append
create
```

The Agent must ask a clarification question when it cannot determine the
destination or placement. Semantic insertion into a function or Markdown
section is deferred to a later version.

### 2.4 Preserve user edits

An edit proposal is anchored to the editor state captured when the Agent turn
starts. If the relevant selection or cursor context changes before the user
selects `Accept`, the desktop must reject the stale proposal and request a new
one. It must not guess a new insertion location.

## 3. User Experience

### 3.1 `@` file autocomplete

Typing `@` in `#agentInput` opens a list of files from
`state.project.files`. The list:

- filters by project-relative path;
- uses case-insensitive substring matching;
- shows at most eight results;
- supports Arrow Up, Arrow Down, Enter, Tab, Escape, pointer and click;
- prioritizes the active file, then recently open files, then other matches;
- inserts `@path/to/file.R`;
- inserts `@"path with spaces/file.R"` when the path contains whitespace.

The autocomplete must not query the operating system or scan outside the
already loaded project file list.

### 3.2 `+` context button

Add a small `+` icon button in the left side of `.composer-footer`. It opens a
compact menu with:

```text
Choose project file...
Use current file
Use current selection
New file...
```

Expected behavior:

- `Choose project file...` opens an internal project file picker populated
  from `state.project.files`. It may reuse the same list component as `@`
  autocomplete.
- `Use current file` inserts the active project file reference.
- `Use current selection` inserts the active file reference and marks the
  captured editor context as selection-oriented. Disable this action when the
  selection is empty.
- `New file...` requests a project-relative path, validates its basic shape in
  the frontend, and inserts it as a reference. Actual validation remains in
  the Tauri command when the proposal is accepted.

The menu must close on Escape, outside click, file selection, Agent send, or
layout change.

Do not open a general operating-system file picker in V1. An internal project
picker is safer, deterministic, and consistent with the project boundary.

### 3.3 Visible context indicator

After choosing through `+`, show a compact indicator in the composer footer,
for example:

```text
analysis.R
analysis.R · selection
new-report.qmd · new
```

The reference must also remain visible in the text input as an `@` reference,
so the prompt remains understandable when stored in Agent history.

### 3.4 Proposal review panel

Place a `#fileEditPanel` between `#approvalPanel` and
`#agentComposerResizeHandle`. It is not a Workspace R approval dialog. It is a
file diff review surface.

The panel shows:

- target project-relative path;
- operation label;
- `Before` content;
- `After` content;
- `Accept` and `Reject` actions;
- `Undo` after a successful accept.

The Agent timeline should render a concise message for the completed proposal
tool event:

```text
Review the proposed file edit below. No file has been changed yet.
```

Do not render the raw proposal JSON or duplicate the full proposed content in
the timeline.

### 3.5 Applying and locating the edit

After `Accept`:

1. Validate the proposal and its editor anchors.
2. Apply it through the existing Tauri project commands.
3. Open the target file.
4. Place the cursor at the end of the inserted content.
5. Reveal the changed range in the editor.
6. Add a temporary Monaco decoration to the inserted range.
7. Show `Undo` in the proposal panel.

The inserted range should be highlighted, not left as a real text selection.
A real selection makes the user's next keystroke overwrite the entire inserted
block.

Clear the highlight when the user edits the document, opens another file,
accepts another proposal, or presses Escape.

### 3.6 Reject and undo

`Reject` makes no project change and hides or marks the proposal as rejected.

`Undo` is allowed only while the target file content still exactly matches the
content produced by the accepted proposal. If it changed afterward, stop and
show:

```text
The file changed after the Agent edit, so automatic undo was stopped.
```

For an edited existing file, undo writes the captured pre-edit content.

For a newly created file, undo deletes that file through a dedicated safe
Tauri command. That command must:

- resolve the path through `project_path()`;
- call `ensure_editable_file()`;
- require `is_file()`;
- remove only that one file;
- advance `project_revision`;
- update the persisted broker identity;
- return the refreshed `ProjectState`.

## 4. Agent Tool Contract

Add a fourth tool in `r/rho.agent/R/aisdk_adapter.R`:

```r
aisdk::tool(
  name = "propose_file_edit",
  description = paste(
    "Propose one project file edit for user review.",
    "This tool never writes the file; the desktop shows a diff and requires explicit acceptance."
  ),
  parameters = aisdk::z_object(
    path = aisdk::z_string("Project-relative file path"),
    operation = aisdk::z_enum(
      c("replace_selection", "insert_at_cursor", "append", "create")
    ),
    content = aisdk::z_string("Exact proposed text"),
    .required = c("path", "operation", "content")
  ),
  execute = function(args) c(list(kind = "rho.file_edit_proposal"), args),
  meta = list(validate_arguments = TRUE, rho_approval = "automatic")
)
```

The returned object is a proposal envelope:

```json
{
  "kind": "rho.file_edit_proposal",
  "path": "R/plot.R",
  "operation": "insert_at_cursor",
  "content": "plot(x, y)\n"
}
```

The proposal tool is automatic because it has no side effect. File writing is
authorized by the later desktop `Accept` action, not by the Workspace R Act
authorization checkbox.

The tool result preview must preserve the complete structured proposal. Do not
use the ordinary 4,000-character preview limit. A bounded limit such as
100,000 characters is acceptable for V1, but the desktop must still enforce
the normal project content size limit on acceptance.

## 5. Editor Context Contract

Add an optional `editorContext` argument to the frontend `run_agent` invoke.
Tauri maps it to `editor_context: Option<Value>`.

Example payload:

```json
{
  "project_root": "D:/Rho",
  "files": ["analysis.R", "R/plot.R", "report.qmd"],
  "active_path": "R/plot.R",
  "document_version": 12,
  "selection_start": 120,
  "selection_end": 168,
  "selection_text": "old_plot <- function(x) { ... }",
  "cursor_line": 9,
  "cursor_column": 1,
  "anchor_before": "...up to 160 characters...",
  "anchor_after": "...up to 160 characters...",
  "nearby_before": "...up to 2,000 characters...",
  "nearby_after": "...up to 2,000 characters...",
  "context_source": "selection"
}
```

`context_source` should be one of:

```text
editor
current_file
selection
project_file
new_file
```

The frontend must call `syncDocumentFromEditor()` before capturing this
context, so unsaved editor content is authoritative.

Store the context in the `agent.user_prompt` event `details_json`, but keep the
visible event body as the original user prompt. This lets a proposal survive
normal Agent polling and makes the exact anchors available to the review UI.

Pass the context to `rho-server::coordinator::run_agent_turn()` and include it
in the model prompt after recent conversation context and before the current
user request.

## 6. Agent System Prompt Rules

Add instructions to the Agent R system prompt:

```text
When the user explicitly asks to write, insert, replace, append, or create a
project file, use propose_file_edit exactly once.

propose_file_edit creates a reviewable diff and never writes a file. Do not
claim the edit was applied.

Use replace_selection only for a non-empty selection in the same path. Use
insert_at_cursor only for the active path. Use append only when the user asks
to append. Use create only for a new path.

Treat @file references as project-relative paths. If the destination or
placement is ambiguous, ask instead of guessing.
```

Ask and Plan modes may produce a file proposal because the proposal is
read-only. `run_r` remains forbidden in those modes.

## 7. Proposal Resolution

The desktop derives the selected proposal from the selected Agent turn:

1. Find the latest event where:
   - `event_type == "tool.call_completed"`;
   - `tool == "propose_file_edit"`.
2. Parse `event.body` as JSON.
3. Require `kind == "rho.file_edit_proposal"`.
4. Find the `agent.user_prompt` event.
5. Parse `details_json.editor_context`.
6. Build a proposal key from `turn_id` and the proposal event ID.

If the result is malformed, show an Agent tool error and do not expose an
`Accept` button.

## 8. Edit Calculation

### 8.1 Replace selection

Requirements:

- proposal path equals captured `active_path`;
- `selection_start < selection_end`;
- the current buffer substring still equals `selection_text`.

Calculation:

```text
new = before[0:start] + proposal.content + before[end:]
highlight = start .. start + proposal.content.length
```

### 8.2 Insert at cursor

Requirements:

- proposal path equals captured `active_path`;
- captured range is valid;
- the text immediately before the range still ends with `anchor_before`;
- the text immediately after the range still starts with `anchor_after`.

Use the captured start offset. Do not silently search for a similar anchor.

### 8.3 Append

Read the latest buffer or disk content when the user selects `Accept`, then
append `proposal.content` exactly. The Agent is responsible for including any
required leading newline. The desktop must not alter the proposed text.

### 8.4 Create

Require that the path does not already exist in `state.project.files`. Write
`proposal.content` exactly through `project_create_file`.

## 9. Open Buffers and Saving

If the target file is already open, use its current in-memory content as the
pre-edit content. This preserves unsaved user work.

After acceptance, the complete resulting buffer is saved atomically. Update:

- `documentState.content`;
- `documentState.savedContent`;
- `documentState.conflictDiskContent`;
- cursor offsets;
- Monaco model;
- project file tree;
- document tabs;
- session snapshot.

Use `state.internalProjectWrites` before invoking a write so the project file
watcher does not report the application's own write as an external conflict.

## 10. Frontend State

Recommended additions to `state` in `desktop/dist/app.js`:

```js
fileEditProposal: null,
fileEditUndo: null,
fileEditDecisions: new Map(),
agentFileMention: { items: [], index: 0, start: -1, end: -1 },
agentContextSource: "editor",
agentContextPath: null,
```

Recommended editor state:

```js
highlightDecorations: [],
```

V1 may keep decisions in memory. A later version may persist accepted and
rejected proposal status in the Agent event store.

## 11. Expected File Changes

### `r/rho.agent/R/aisdk_adapter.R`

- add `propose_file_edit`;
- keep its result preview structured and sufficiently large;
- do not route it through the Workspace broker.

### `r/rho.agent/tests/testthat/test-adapter.R`

- expect four tools;
- verify proposal approval policy is automatic;
- round-trip proposal preview JSON;
- preserve the existing snapshot preview regression test.

### `crates/rho-server/src/coordinator.rs`

- accept optional editor context in `run_agent_turn()`;
- include context in the model prompt;
- add file proposal system rules;
- keep desktop Agent request authorization unchanged because the proposal tool
  does not send a broker request.

### `desktop/src-tauri/src/main.rs`

- accept optional `editor_context` in `run_agent`;
- persist it in the prompt event details;
- pass it to `run_agent_turn()`;
- add safe `project_delete_file` for undoing a newly created file;
- register the new command;
- update smoke-test call sites with `None` editor context.

### `desktop/dist/index.html`

- add `#fileEditPanel`;
- add `#agentContextButton`;
- add `#agentContextMenu`;
- add `#agentFileMentions`;
- add optional `#agentContextBadge`.

### `desktop/dist/styles.css`

- style the proposal panel and compact diff;
- style the `+` menu and project file list;
- style inserted-range Monaco decoration;
- keep the composer usable at the minimum right-panel width.

### `desktop/dist/app.js`

- capture editor context;
- implement `@` completion;
- implement `+` context menu;
- parse proposal events;
- render proposal diff;
- accept, reject and undo;
- open and highlight target file;
- hide raw proposal JSON in the timeline;
- add mock-mode behavior for browser verification.

### `NEWS.md`

Add an Unreleased or next-version entry describing:

- project file references through `@` and `+`;
- reviewable Agent file edits;
- stale-anchor protection;
- post-apply highlight and one-step undo.

## 12. Current Partial Implementation

At the time this document was written, the working tree already contains an
incomplete implementation. The next Agent must inspect the diff before editing
and work with it rather than starting over.

Already present or partially present:

- `propose_file_edit` in the R adapter;
- structured proposal preview support;
- R adapter tests for the fourth tool and proposal preview;
- editor context parameter plumbing in Rust;
- system prompt rules for proposal generation;
- `project_delete_file` in Tauri;
- initial proposal panel HTML and CSS;
- initial `@` autocomplete functions;
- initial proposal parsing, apply, reject, highlight and undo functions;
- mock Agent proposal generation for prompts containing `@`.

Still incomplete and required:

- wire `renderFileEditPanel()` into Agent data loading and turn selection;
- replace raw proposal JSON in timeline rendering;
- attach Accept, Reject and Undo event listeners;
- attach `@` input and keyboard event handling;
- implement and wire the `+` project context menu;
- clear highlights on subsequent user editing and file switching;
- reset proposal state when Agent history or project changes;
- verify create-file undo closes and removes the document cleanly;
- add Rust tests for safe deletion if practical;
- update NEWS and version only after the implementation passes tests;
- complete browser interaction and responsive visual verification.

Do not revert the previously completed `0.2.0-dev.9` changes for Agent composer
resizing and workspace snapshot summaries. They share some of the same files.

## 13. Tests

### 13.1 R tests

Run:

```powershell
Rscript -e "testthat::test_local('r/rho.agent')"
```

Required cases:

- tool order includes `propose_file_edit`;
- proposal tool is automatic;
- proposal preview parses back to the same list;
- large proposal content is not truncated at 4,000 characters;
- snapshot summary tests still pass.

### 13.2 Rust tests

Run using the repository GNU toolchain:

```powershell
$env:CARGO_HOME='E:\software-data\scoop\persist\rustup\.cargo'
$env:RUSTUP_HOME='E:\software-data\scoop\persist\rustup\.rustup'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-gnu'
$env:PATH='C:\rtools45\x86_64-w64-mingw32.static.posix\bin;' + $env:PATH
cargo test --workspace
```

Required cases:

- coordinator prompt contains supplied editor context;
- existing retry-context test still passes;
- delete command cannot escape the project root;
- delete command rejects unsupported or missing files;
- existing project safety tests remain green.

### 13.3 JavaScript and formatting

```powershell
node --check desktop\dist\app.js
cargo fmt --all -- --check
git diff --check
```

### 13.4 Browser verification

Run the desktop preview and verify at normal and narrow right-panel widths:

1. Type `@` and select a file with mouse and keyboard.
2. Open `+` and choose each supported context source.
3. Confirm current-selection action disables when selection is empty.
4. Send a mock file-edit prompt.
5. Confirm raw JSON is not visible.
6. Confirm the Before/After panel is readable without horizontal page overflow.
7. Reject a proposal and confirm no file changes.
8. Accept a proposal and confirm file content, cursor and highlight.
9. Undo and confirm exact restoration.
10. Modify the target after acceptance and confirm undo refuses to overwrite.
11. Change the selected text while the Agent is working and confirm Accept
    rejects the stale proposal.
12. Create a new file, accept, then undo and confirm the file disappears from
    the tree and editor tabs.

## 14. Acceptance Criteria

The feature is ready only when all statements are true:

- `@` and `+` both produce project-relative file references.
- The `+` flow never exposes project-external files.
- The Agent cannot write a file without an explicit desktop `Accept` action.
- A proposal shows a readable diff before any write.
- Selection and cursor proposals reject stale anchors.
- Open unsaved buffers are preserved and used as the edit base.
- Accepted edits open and highlight the exact inserted range.
- Reject produces no project mutation.
- Undo restores the exact previous content or safely deletes a newly created
  file.
- Undo refuses when later user edits would be overwritten.
- Workspace R authorization remains separate from file edit acceptance.
- R, Rust, JavaScript, formatting and browser verification all pass.

## 15. Deferred Work

Do not include these in V1:

- semantic insertion into functions or document sections;
- multi-file proposals or batch acceptance;
- project-external file editing;
- binary output export;
- automatic acceptance based on Act session authorization;
- persistent proposal decisions across application restarts;
- full side-by-side Monaco diff editor;
- automatic fuzzy relocation of stale insertion anchors.

