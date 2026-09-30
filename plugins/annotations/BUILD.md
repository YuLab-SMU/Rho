# Build Annotations

Use the existing pinned Rust toolchain, Cargo lockfile and TypeScript compiler.
This package includes its API, domain owner, private SQLite store, native RPC entry,
ordinary browser view and public protocol/SDK source. No private Host or Agent
implementation is needed.

An assembled source package has a root Cargo workspace. Run `node build.mjs` to
compile the browser view, build it offline, export its manifest and place the
executable and view assets under `dist/`. Missing registry dependencies or tools are errors; the build does not
install anything. The native executable is trusted local code, not an OS sandbox.

Repository development uses `node scripts/build-annotation-plugin.mjs /new/path`
from the repository. This reuses its workspace cache by default, then assembles a
closed source package and copies the exact built executable. `--independent`
explicitly selects a standalone-source build; it is not the iteration default.
Building a package does not install, activate or publish it. A native backend
requires the normal local target artifact during activation (currently macOS
Apple Silicon).
