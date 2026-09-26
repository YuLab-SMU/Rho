# Editor source build

The document owner is under migration. Its source currently provides resident
CodeMirror state, byte-preserving text and patches, exact Files observations and
scoped draft synchronization through the public UI SDK. The contributed runtime
view and file/R action controller are still being assembled; this directory is
not yet an installable plugin artifact.

Use Node.js with the exact dependency versions in `package.json` and
`dependencies.lock`. Copy the public UI SDK and protocol sources to
`public/plugin-ui` and `public/plugin-protocol`, and the public Files declarations
to `public/files-protocol`. Run the locked TypeScript compiler with
`--project tsconfig.json`. Compiled modules are emitted under `compiled/`.
No private Host/client source or scientific database connection is required.

In the checkout, `node scripts/test-editor-plugin.mjs` copies these sources and
public declarations to a disposable external directory, verifies existing locked
dependencies, compiles them and exercises document/read/draft recovery behavior.
It installs no tools and does not start R. Native file-save, R execution, iframe
input and visual acceptance remain separate steps once the view is assembled.
