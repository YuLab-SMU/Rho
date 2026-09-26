# Build Editor

This ordinary UI-only package uses the included public plugin protocol and UI SDK,
public Files/R declarations, locked CodeMirror/diff libraries and its own document
owner. It opens captured files, preserves local editing state, synchronizes opaque
drafts and saves through the exact configured Files backend. Disk comparisons
retain their exact observed bytes, verify freshness before applying a choice, and
preserve resident text undo when loading the disk version.

R actions are optional. To use them, explicitly select `r.session@1`, `r.execute@2`,
`r.format@1` and `resources.read@1` in the Editor activation's
`optional_capabilities`, then configure the view's `runtime` with an exact R
instance reference. File-only activation selects none and needs no R provider.
Opening or editing a document never creates an R session; start the configured
instance explicitly in Console. Run Selection / Line captures the selected range
or current line; Run Document captures the whole text. Both use versioned Console
output and retain the originating document label. Code is captured before native
observation, and the original request is synchronized before submission.

Save and Run (Command Shift Enter) captures the text and existing session before
asynchronous work, saves the captured bytes, and verifies the original file result
before submitting that captured code. Later typing remains unsaved in the editor.
Unchanged files are verified without another write. File failure, uncertainty or
unconfirmed admission never starts R. Closing interrupts the unsubmitted part of
this sequence; reopening can inspect the saved file result but cannot automatically
start R or reuse another view's caller identity. The original open view can
explicitly continue its verified saved capture after an interrupted preparation.
Confirmed unsent runs can be dismissed without undoing the file write. Each native
file/R request retains its own identity for original-result recovery.

Formatting uses installed `styler` in the same existing R session. It accepts up
to 64 KiB of UTF-8; running accepts up to 256 KiB. The Editor's independent editing
limit remains 512 KiB. Neither operation truncates input. Formatting verifies the
original result and applies one undoable edit only while the captured document is
unchanged. Later edits remain resident; the retained comparison can be inspected,
discarded or explicitly applied against its displayed version. Applying never
saves the project file. Close retains pending identities and later edits; reopening
can inspect an original request but cannot replay it under another view identity.
Document context contributions and default scenario composition remain in progress.

Use Node.js and the exact dependency versions in `package.json` and
`dependencies.lock`. Select an existing installed dependency directory with
`RHO_PLUGIN_NODE_MODULES`, then run `node build.mjs`; alternatively provide the
same locked dependencies in this package's own `node_modules`. The build checks
direct and transitive versions, requires missing tools to be supplied explicitly,
and never installs dependencies.

The runtime entry is `dist/index.html`; JavaScript and styles are bundled locally.
Available dependency licenses/notices are retained in
`dist/THIRD-PARTY-NOTICES.txt`. `compiled/` contains unbundled modules for owner
checks and is not a runtime entry point. All first-party sources, public SDKs,
locked dependency metadata and these instructions belong in exported packages.

In the checkout, `node scripts/build-editor-plugin.mjs /absolute/new/directory`
assembles the package outside the checkout and selects the existing locked tools.
`node scripts/test-editor-plugin.mjs` independently compiles and checks its document,
Files read, original-operation, R action and draft/save controllers. These include
verified large retained formatting results, exact session/source checks, close
recovery, later edits and version-fenced formatting. Neither check nor build starts R.
Native file saves, isolated iframe input and visual acceptance are separate checks.
