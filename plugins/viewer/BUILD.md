# Build the Viewer package

Assemble outside the checkout with `node scripts/build-viewer-plugin.mjs DEST`.
The assembly contains only this package and the public protocol/UI SDK. It uses
the existing TypeScript compiler without downloading dependencies or tooling.
Inside the assembled directory, run `node build.mjs` with an existing `tsc` on PATH
or `RHO_PLUGIN_TSC` pointing to its JavaScript entrypoint. Failed builds preserve
existing immutable artifacts and do not change an applied instance.

Snapshot and import the result with the ordinary plugin CLI. Activate its exact
revision and artifact under `ui-web`. Open contribution `viewer` with configuration
`{"source": INSTANCE_REF}` and state `{}`. Copy the full producing R instance
identity into `source`; it does not change when another revision activates.
The generic view container opens the resulting view through its ordinary private
Workbench URL. No special Viewer token or scientific route is used.

The package declares only `operation.list_recent`, `operation.get` and
`resources.read`. It reads original terminal R output contracts, verifies the
resource identity/length/digest, and displays saved HTML in a nested opaque iframe.
History, refresh and following the latest output never invoke R or recover work.
User selection is saved through the public self-state interface. Up to 200 outputs
are shown per open view; earlier operations are paged explicitly. HTML documents
are limited to 16 MiB. R-owned local dependency retention runs before this viewer;
remote services and network-dependent content are not recreated.
