# R plugin source

The R owner is being moved here as part of the unified-plugin implementation.
This source tree is not yet an installable plugin archive; the backend RPC entry
and package manifest are the next integration step. Current product acceptance
and the remaining migration are recorded in `docs/STATUS.md` at the repository root.

- `api/` owns R data contracts and the native owner port. It depends on the public
  plugin protocol, without any Host, Operation journal or application implementation.
- `backend/engine/` owns Ark startup and shutdown, native input, R inspection,
  package/help queries, captured outputs and recovery-copy artifacts. Its embedded
  R bridge travels with the engine. It receives an original operation identity
  and returns observations; it cannot commit an Operation or publish scientific facts.
- `vendor/jet-core` at the repository root remains the pinned third-party transport,
  maintained through the existing ordered `patches/jet` workflow. No upstream
  notices or patches are replaced by this relocation.

The existing Host temporarily uses a thin adapter outside this package. There is
only one implementation of native R behavior. That adapter and the old scientific
composition are removed as the full plugin path replaces them.

Run `node scripts/test-r-plugin-engine.mjs` from the repository root to build and
exercise this engine outside the checkout with only its public contracts and
pinned Jet dependency. The script rewrites development-relative dependency paths
inside the disposable copy and reuses the existing dependency lock offline.
It selects the repository’s already-installed compiler before changing directories;
no compiler or dependency installation is attempted.
With `--real-r`, explicitly configured `RHO_ARK` and `RHO_R_HOME` additionally run
native R in a disposable project, verify retained HTML output and confirm shutdown.
The test never connects to an existing user session.
