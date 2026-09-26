# Build Files

Use the installed Rust toolchain (Rust 1.97 or later), Node.js, Git and the cached
dependencies pinned in Cargo.lock, plus installed UI dependencies matching
package.json and dependencies.lock. Missing tools/dependencies are diagnostics;
the build does not install them.

From the Rho checkout, assemble into a new directory outside the checkout:

```sh
node scripts/build-files-plugin.mjs /absolute/new/files-package
```

That package contains all first-party Files, shared process supervision, public
protocol/SDK sources, the standalone workspace and its locked dependencies. From
that directory, repeat the build with `node build.mjs`. Cargo is locked/offline.
The generated manifest inventories sources. `dist/rho-files-backend` is the native
artifact; `dist/ui/` is the isolated UI artifact. The build copies public UI SDK
and protocol declarations into the source package. From a standalone package, set
`RHO_PLUGIN_NODE_MODULES` to an existing matching dependency directory, or supply
its own `node_modules`. `node build-ui.mjs` rebuilds only the UI, leaving the native
artifact intact. All installed dependency versions are checked against the lock.
Import never builds or activates the backend. The initial delivery target is macOS
Apple Silicon.

The backend requires the public `workspace.paths@1` query with `project.read`.
File patch calls additionally require `project.write`. The caller selects an exact
provider, keeps native expectations in `PluginRequest.preconditions` as an array
of public `FilePrecondition` values, and retains the original request identity.
Preflight fixes the normalized root; native hash/head/absence checks occur again
at execution. Patch completion never means a Git commit or an automatic rollback.

No configuration can change Host path exclusions. Reads do not start R. After
transport loss inspect the original Operation and current files; never replay a
patch automatically. Public cancellation is unsupported. Transport cancellation
can stop waiting work before native execution; an already-started Git patch runs
to its bounded native result. A cancellation acknowledgement alone is not proof
that the native work stopped. Returning
a result does not release the execution lane: original journal settlement does.
