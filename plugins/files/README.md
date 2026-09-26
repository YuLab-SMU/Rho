# Files and Git owner

The ordinary `org.rho.files` backend uses the public plugin protocol and SDK.
`api` owns file, directory, text, search, Git observation and patch
contracts. `backend/engine` owns the existing contained filesystem and Git adapter.
It uses the public process supervision library, without private core dependencies.
`backend/owner` interprets path-search continuations, native patch preconditions
and before/after effects. The retiring `rho-git` adapter and project handlers reuse
these implementations while the default workbench migrates. The ordinary backend
returns commit plans to the same Host Operation gateway; it has no journal of its
own. A native result retains its execution lane until exact original settlement.

Native reads retain normalized project roots, protected-path exclusions, bounded
pages, UTF-8 positions, hashes and native file identities. Changed or replaced text
produces typed diagnostics. Git reads and patches retain their existing command
bounds and project containment. Neither source extraction nor a query installs
software or recovers an R session.

Host path boundaries are available through the public `workspace.paths@1` query,
under `project.read` and an explicit backend requirement. They include the Host's
protected stores, future sidecars and lease. Plugin configuration cannot replace
these boundaries. No initialization fields are added to already-built backends.

Generate language-neutral schemas and TypeScript declarations with
`node plugins/files/generate-sdk.mjs`. The independent contract consumer is
`scripts/test-files-protocol.mjs`. `scripts/test-files-plugin-engine.mjs` copies
only the Files and process libraries outside the repository, checks dependency
containment and runs their native tests with the already-installed Rust toolchain.
It does not rebuild or restart a running Host.

Build an installable source/artifact package using
`node scripts/build-files-plugin.mjs /absolute/new/directory`; see [BUILD.md](BUILD.md).
Its nine contributed capabilities cover directory listing, file search, byte and
text reads, text search, file/Git observations, disk capacity, patch preflight and
explicit patch application. Configuration cannot redirect the normalized project.
Native observation errors retain their exact code through the Host, including
`content_changed`, `observation_expired`, `budget_exceeded` and `busy`. An error
does not become a successful empty page or confirm an operation outcome.
Native preconditions use the public `FilePrecondition` array in
`PluginRequest.preconditions`; apply uses the exact provider returned by
`plugins.resolve`. Queries and installation do not activate a runtime.

`node scripts/test-files-plugin.mjs` compiles a Host acceptance harness, then builds
the package outside the checkout and verifies unchanged Host bytes. It exercises
the public wire, native Files operations, two revisions, original journal fault
recovery and historical replay after release/removal/restart. No R, existing user
project or running Host is used. Manifest generation is checked with
`node plugins/files/generate-manifest.mjs --check`.

The same package contributes a Files view through the public UI SDK. Its directory
and bounded search model lives in `src/files.ts`; the retiring UI delegates to this
model while default composition migrates. The view binds to its own exact backend,
keeps the protocol project ID distinct from the normalized native root, preserves
cached entries on failed reads, and serializes acknowledged presentation state.
Closing captures that state without releasing the backend. Slow read-only refreshes
observe external file changes without coupling to a particular scientific runtime.
Manually loaded continuation pages stay cached until explicit refresh; polling
does not collapse them or expire an explicit search.

View configuration optionally names an exact Editor instance and destination tab
group (`editor` and `editor_group`). Missing Editor configuration disables opening
and creation. An explicit open captures the regular file's native hash/size before
reading layout, then persists the original request before `windows.open_view`.
The Editor receives `{ source: InstanceRef, file: FileObservation | null }`; `null`
means a new draft, not a filesystem creation. It must read the selected file using
the captured SHA. Lost acknowledgements retain the original navigation identity;
copying a view's state cannot replay its old request from a new caller.
The complete ordinary Editor and default scenario remain in progress.

`node scripts/test-files-ui.mjs` compiles and tests the independent model,
connection and actions. After building the current client and Host, run
`RHO_FILES_PLUGIN_PACKAGE=/absolute/built/package npm run test:browser --prefix ui -- files-plugin.spec.ts`.
It uses native Files in a disposable project and the actual generic window; the
Editor destination is explicitly a route fixture, not a document editor. Synthetic
composition events establish close guards, not native input-method acceptance.
