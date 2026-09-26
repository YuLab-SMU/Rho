# Build Editor

This ordinary UI-only package uses the included public plugin protocol and UI SDK,
public Files declarations, locked CodeMirror/diff libraries and its own document
owner. It opens captured files, preserves local editing state, synchronizes opaque
drafts and saves through the exact configured Files backend. Disk comparisons
retain their exact observed bytes, verify freshness before applying a choice, and
preserve resident text undo when loading the disk version. R execution,
formatting and document context contributions are still under migration.

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
Files read, original-operation and draft/save controllers. Neither action starts R.
Native file saves, isolated iframe input and visual acceptance are separate checks.
