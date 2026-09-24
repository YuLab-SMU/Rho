# R plugin source

The R owner is being moved here as part of the unified-plugin implementation.
The public-protocol executable and package manifest provide explicit session
creation, Console controls, bounded inspection and execution through original
Operations. Object directories, progressive object reads, installed package copies,
static indexes and Help use the exact existing session; see [public interfaces](sdk/README.md).
Read-only inspection readiness includes a session-scoped cache key that changes
around native execution so views can notice short runs between refreshes.
`node scripts/build-r-plugin.mjs DEST` assembles and builds a self-contained package
outside the checkout; see [build instructions](BUILD.md). Current acceptance and
the remaining migration are recorded in `docs/STATUS.md` at the repository root.

- `api/` owns R data contracts and the native owner port. It depends on the public
  plugin protocol, without any Host, Operation journal or application implementation.
- `backend/src/` owns the public RPC connection, one native session and its lane.
  It receives normalized Host paths independently of user configuration, freezes
  native session preconditions, handles cancellation concurrently and retains
  original reports, output events, HTML and images through the public data channel.
  Initialization and queries never start R. Failed launches cannot be retried in
  the same instance, and release requires confirmed native shutdown.
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

Run `node scripts/test-r-plugin.mjs` with explicit `RHO_ARK` and `RHO_R_HOME`
to build the complete backend outside the checkout and exercise it through the
shared Host Operation/Query ports in disposable projects. The test covers two
coexisting revisions, session fencing, Unicode, HTML/PNG retention, Console input
and queue controls, cancellation and original records after package removal and
Host restart. Its inspection fixture checks reference continuation, non-forcing
binding reads, exact package/help identities and unchanged R search paths and
loaded namespaces. Native checks do not establish UI or complete scientific-owner
migration acceptance.
