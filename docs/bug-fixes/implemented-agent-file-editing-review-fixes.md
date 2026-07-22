# Agent File Editing Review Fixes

## Serialized proposal boundary

The `propose_file_edit` executor must return a newly constructed plain list
containing only `kind`, `path`, `operation` and `content`. aisdk may attach an
internal `.envir` value to its arguments; copying the full argument object makes
`jsonlite` reject the tool result and prevents the desktop from rendering the
review panel. As a compatibility fallback, the desktop may reconstruct a
successful proposal from the validated `details_json.arguments` recorded with
the tool event.

Status: implemented in `0.2.0-dev.10`

Related design: `docs/design/implemented-agent-file-editing-design.md`

Implementation note: the blocking instructions below are retained as the
original repair and regression contract; the listed P1 fixes are implemented.

## 1. Purpose

This document records the release-blocking findings from the first review of
the Agent file editing implementation and gives a concrete repair plan for the
next implementation Agent.

Do not rebuild the installer until every P1 item and its regression test are
complete.

## 2. Current State

The implementation currently includes:

- `@` project file autocomplete;
- a `+` project context menu;
- `propose_file_edit` in Agent R;
- editor context transport;
- a Before/After proposal panel;
- Accept, Reject and one-step Undo;
- Monaco range highlighting;
- safe project-relative create, write and delete commands;
- stale selection and cursor anchor checks.

The following checks passed before this document was written:

```text
R tests: 27 passed
Rust workspace tests: passed
JavaScript syntax: passed
cargo fmt: passed
git diff --check: passed
```

Browser interaction verification was not completed because the current
browser policy rejected the local preview URL.

One review fix has already been applied in
`crates/rho-server/src/coordinator.rs`:

- the complete model prompt is no longer passed as a Windows command-line
  argument;
- Agent R reads the authentication token from the first stdin line and the
  complete prompt from the remaining stdin content.

The next Agent must preserve that fix.

## 3. P1: Prevent Reapplying Accepted Proposals

### Problem

`renderFileEditPanel()` currently treats a proposal as applied only when it is
both marked `accepted` and matches the single current `state.fileEditUndo`.

Current logic near `desktop/dist/app.js:3023`:

```js
const applied = decision === "accepted" && state.fileEditUndo?.key === proposal.key;
```

After accepting proposal B, proposal A no longer matches `fileEditUndo`, so A
shows `Accept` again. An append proposal can therefore append the same content
twice in one session.

`hydrateProject()` also resets `state.fileEditDecisions` to a new empty Map.
After application restart, every historical proposal becomes actionable
again.

### Required Behavior

- An accepted proposal must never show `Accept` again.
- Only the latest accepted proposal may show `Undo`.
- An older accepted proposal should show an informational state such as:

```text
Already applied. Undo is no longer available.
```

- Rejected proposals must remain rejected.
- Undone proposals may be accepted again only if their anchors still validate.
- Decisions must survive application restart and project switching.
- Decisions must be isolated by project.

### Recommended Implementation

Use project-scoped local persistence for V1:

```js
function fileEditDecisionStorageKey() {
  return `rho.fileEditDecisions:${state.project.root || "default"}`;
}

function loadFileEditDecisions() {
  try {
    const value = JSON.parse(
      localStorage.getItem(fileEditDecisionStorageKey()) || "{}"
    );
    return new Map(Object.entries(value));
  } catch (_) {
    return new Map();
  }
}

function persistFileEditDecisions() {
  localStorage.setItem(
    fileEditDecisionStorageKey(),
    JSON.stringify(Object.fromEntries(state.fileEditDecisions.entries()))
  );
}
```

In `hydrateProject()`:

1. Set `state.project` first.
2. Load `state.fileEditDecisions = loadFileEditDecisions()`.
3. Do not replace the decisions with an empty Map after the root is known.

After Accept, Reject and Undo, call `persistFileEditDecisions()`.

When Agent history is explicitly cleared, remove the current project decision
storage entry.

Update `renderFileEditPanel()`:

```js
const accepted = decision === "accepted";
const undoAvailable = accepted && state.fileEditUndo?.key === proposal.key;

acceptButton.classList.toggle("hidden", accepted);
rejectButton.classList.toggle("hidden", accepted);
undoButton.classList.toggle("hidden", !undoAvailable);
```

Do not define `accepted` as `undoAvailable`.

### Regression Tests

Required browser or frontend harness cases:

1. Accept append proposal A.
2. Accept proposal B.
3. Select proposal A.
4. Confirm A does not show `Accept`.
5. Reload the application.
6. Select A again.
7. Confirm A still does not show `Accept`.
8. Reject proposal C, reload, and confirm C remains rejected.

## 4. P1: Preserve Closed Unsaved Drafts

### Problem

`projectFileContent()` checks open documents and then reads disk:

```js
if (state.documents[path]) return state.documents[path].content;
const result = await invoke("project_read_file", { path });
```

It ignores `state.closedDrafts[path]`.

If a user closes a dirty file and later accepts an Agent append targeting that
file, the Agent edit is calculated from stale disk content. When the file is
opened afterward, `restoreDraftChoice()` offers the old draft again. The user
can then overwrite the Agent edit or discard their own draft.

### Required Behavior

- An unsaved closed draft is authoritative for Agent file editing.
- Accept must preserve the complete draft and apply the proposal on top of it.
- After successful write, the old closed-draft recovery entry must be removed.
- Opening the accepted target must not prompt to restore the superseded draft.
- Undo must restore the exact pre-edit draft content.

### Required Changes

Update `projectFileContent()`:

```js
if (state.documents[path]) return state.documents[path].content;
if (state.closedDrafts[path]) return state.closedDrafts[path].draft_content;
```

Continue to read disk only when neither an open document nor a closed draft
exists.

In `acceptFileEditProposal()`, after the project write succeeds and before
`updateDocumentAfterFileEdit()` opens the file:

```js
delete state.closedDrafts[proposal.path];
```

The captured `beforeContent` stored in `state.fileEditUndo` must be the closed
draft content, not the prior disk content.

### Regression Tests

1. Open `analysis.R`.
2. Add unsaved text.
3. Close the document so the text moves into `state.closedDrafts`.
4. Accept an append proposal for `analysis.R`.
5. Confirm the saved file contains both the draft and Agent content.
6. Confirm reopening does not show the draft recovery prompt.
7. Undo and confirm the exact draft content is restored.

Also test an externally modified disk file while a closed draft exists. The
implementation must not silently discard the closed draft.

## 5. P2: Render a Real Contextual Diff

### Problem

The current proposal panel displays:

```text
(cursor at line N)
```

for cursor insertion, and:

```text
(end of current file)
```

for append. The After block contains only the inserted text. This is not enough
for the user to verify the insertion location before Accept.

### Required Behavior

For replace-selection and cursor insertion, the panel must display nearby
source context and show the proposal content inside that context.

For append, show the tail of the target file when available. If the target is
not the active file, load a bounded preview before rendering the panel or state
clearly that the latest content will be loaded on Accept.

### Recommended Synchronous Rendering

The editor context already contains:

```text
nearby_before
nearby_after
selection_text
cursor_line
```

Use them as follows:

```js
if (operation === "replace_selection") {
  before = nearbyBefore + selectionText + nearbyAfter;
  after = nearbyBefore + proposedContent + nearbyAfter;
}

if (operation === "insert_at_cursor") {
  before = nearbyBefore + "\n| cursor |\n" + nearbyAfter;
  after = nearbyBefore + proposedContent + nearbyAfter;
}
```

Add a bounded `file_tail` field to editor context for the active file:

```js
file_tail: content.slice(Math.max(0, content.length - 2000))
```

Use it for active-file append previews.

For a non-active append target, it is preferable to make
`renderFileEditPanel()` asynchronous and call `project_read_file` to obtain a
bounded tail. If this is deferred, the panel must not imply that it is showing
the complete Before state.

### Rendering Requirements

- Keep content text-only through `textContent`.
- Preserve line breaks.
- Bound Before and After independently.
- Do not render raw proposal JSON.
- Do not display only the proposed fragment as if it were the complete After
  state.
- Keep the panel usable at the minimum right-panel width.

### Regression Tests

1. Cursor insertion shows code before and after the cursor.
2. Replacement shows the original selection in Before and replacement in
   After.
3. Active-file append shows the file tail and appended content.
4. Very long context remains bounded and scrollable.
5. HTML-like proposed text is rendered as text, not markup.

## 6. P2: Make `@` and `+` Context Equivalent

### Problem

The `+` project picker sets `context_source` and `context_path`, but ordinary
`@` completion currently uses `contextSource: null`. The visible prompt still
contains the path, but the structured editor context differs between the two
entry points.

### Required Behavior

Selecting a file from `@` autocomplete must set:

```text
context_source = project_file
context_path = selected path
```

unless another explicit context source such as `selection` was already chosen.

The `+` menu and `@` autocomplete must continue inserting the same token:

```text
@path/to/file.R
@"path with spaces/file.R"
```

### Suggested Change

When constructing the normal mention state in `updateAgentFileMentions()`, set:

```js
contextSource: "project_file"
```

If multiple files are allowed in the prompt, document that
`context_path` identifies the primary edit target in V1.

## 7. Prompt Transport Fix Verification

The command-line-length fix must remain in
`crates/rho-server/src/coordinator.rs`.

Expected R bootstrap behavior:

```r
input <- file("stdin", open = "r", encoding = "UTF-8")
token <- readLines(input, n = 1L, warn = FALSE)
model_prompt <- paste(readLines(input, warn = FALSE), collapse = "\n")
close(input)
```

Rust must write:

```text
token + newline + complete model prompt
```

and must not call:

```rust
.arg(model_prompt)
```

Add or extend a Rust test/helper so a prompt larger than 32 KB is not placed in
the child command argument list. A full process test is optional, but the
prompt transport should be isolated enough to test.

## 8. Safe Delete Test Gap

`project_delete_file` is used to undo new-file proposals but currently has no
direct regression test.

Add tests for the underlying safe-delete behavior or extract a testable helper.
Required cases:

- deletes one supported project file;
- rejects a missing file;
- rejects unsupported extensions;
- rejects `..` path escape;
- rejects paths resolving outside the project through a symlink;
- never recursively deletes a directory.

## 9. Final Validation

Run:

```powershell
Rscript -e "testthat::test_local('r/rho.agent')"
node --check desktop\dist\app.js
cargo fmt --all -- --check
git diff --check
```

Then run Rust tests with the repository GNU toolchain:

```powershell
$env:CARGO_HOME='E:\software-data\scoop\persist\rustup\.cargo'
$env:RUSTUP_HOME='E:\software-data\scoop\persist\rustup\.rustup'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-gnu'
$env:PATH='C:\rtools45\x86_64-w64-mingw32.static.posix\bin;' + $env:PATH
cargo test --workspace
```

Browser or desktop manual validation must cover:

1. `@` and `+` file selection.
2. Accept and Reject.
3. Multiple accepted proposals without repeated Accept.
4. Persistence after application restart.
5. Closed dirty draft preservation.
6. Stale selection and cursor rejection.
7. New-file Accept and Undo.
8. Undo refusal after later edits.
9. Contextual Before/After rendering.
10. Narrow right-panel layout.

## 10. Release Gate

Do not build or distribute a new installer until:

- accepted and rejected proposal states survive restart;
- no accepted proposal can be applied twice accidentally;
- closed drafts are preserved;
- the review panel displays meaningful source context;
- the prompt is not transported through Windows command-line arguments;
- all automated checks pass;
- the core interaction is manually verified in the desktop application.
