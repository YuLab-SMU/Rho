# Build Console

This UI-only package uses the included public protocol, R declarations and UI SDK.
Use Node.js and the exact TypeScript, Vite and CodeMirror dependencies in
`package.json` and `dependencies.lock`. Select an existing installed dependency
directory with `RHO_PLUGIN_NODE_MODULES`, then run `node build.mjs`. Alternatively
provide the same locked dependencies in this package's own `node_modules`.
The build checks installed direct versions and never installs tools or dependencies.

The runtime artifact starts at `dist/index.html`; all JavaScript is bundled locally.
Installed transitive versions are checked against the lock, and their available
license/notice files are retained in `dist/THIRD-PARTY-NOTICES.txt`.
`compiled` contains unbundled modules for independent model tests. It is not an entry
point. Source, dependency metadata and these instructions belong in exported packages.

In the Rho checkout, `node scripts/build-console-plugin.mjs /absolute/new/directory`
assembles the package outside the checkout and selects the existing dependency tools.
It copies public SDK sources, not the private client or a scientific core implementation.
