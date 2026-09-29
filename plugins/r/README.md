# R plugin source

The R owner is being moved here as part of the unified-plugin implementation.
The public-protocol executable and package manifest provide explicit session
creation, Console controls, bounded inspection and execution through original
Operations. Object directories, progressive object reads, installed package copies,
static indexes and Help use the exact existing session; see [public interfaces](sdk/README.md).
Read-only inspection readiness includes a session-scoped cache key that changes
around native execution so views can notice short runs between refreshes.
Explicit `r.format` Operations use installed `styler` in the selected existing
session, share execution's queue and original-result retention, and never evaluate
the supplied text or save it to a project file. Oversized inline values remain
available in the complete retained report; Editor application is a separate action.

The R owner also declares ordinary `help` and `viewer` context contributions:

- Help searches a bounded index of the last 100 observed topic identities. Open a
  topic in Help first. Preview rereads text from its exact native session, package
  observation and original index/help file identities; it never selects another
  installed copy. Choose topic text or its first twelve lines. Changed, busy or
  incomplete reads do not become complete Agent input. The index contains no
  content bytes and is cleared when the R instance restarts.
- Viewer searches five visible journal entries per page and retains continuation
  within an operation with multiple outputs. It includes original terminal
  `r.execute` HTML from this exact instance, including failed/cancelled/uncertain
  runs with retained output. Preview verifies the original result and resource;
  text is inert HTML source. Artifact-record inclusion explicitly excludes content
  availability and interactive browser state. It can inspect original records
  after reopening the instance without starting R.

Console and Plots previews also supply owner-defined annotation identities.
Console binds code/transcript inclusions to the original run and recorded outcome;
Plots binds the ordered original outputs and image digests. A later execution
cannot replace either source. Plot text freezing includes artifact metadata only;
image import and browser capture are separate actions. Reads never rerun analysis.
Objects and Packages annotation versions cover their bounded summary/installed-copy
metadata. Their lineage retains the native session/name/path or installed library
and package; versions digest metadata and completeness notices, excluding temporary
observation handles and clocks. They do not fingerprint the full object or package
files. Preview still checks the original handle/copy and refuses expired or changed
sources; viewing never evaluates a binding or loads/installs a package.

Viewer context requires the R instance's optional `operation.get`,
`operation.list_recent` and `resources.read` grants. Context references never grant
access or acquire scientific tools. Agent exposes these as optional grants too;
activation and each input still select their scope explicitly.
Run `cargo test -p rho-r-backend --bin rho-r-backend owner::context --locked` for
the owner checks. Current native and combined Host acceptance remain in Status.
`node scripts/build-r-plugin.mjs DEST` reuses the primary Cargo cache
and assembles the complete package outside the checkout. Add `--independent` for
explicit independent-build acceptance; see [build instructions](BUILD.md). Current acceptance and
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

Public recovery controls retain original uncertain outcomes and support explicit
application or discard through version-2 pin/delete requests. Their exact original
request and latest attempt remain visible through `r.checkpoint_control@1`; see
[public recovery contracts](sdk/README.md). Unpublished capture material can be inspected and explicitly discarded after its
original provider is confirmed released. Missing bytes alone do not confirm that
disposal; a new Core operation preserves the original outcome. Studio recovery
integration remains separate work.

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

Run `node scripts/test-r-plugin.mjs --package DEST` with explicit `RHO_ARK` and `RHO_R_HOME`
to reuse the retained backend and exercise it through the
shared Host Operation/Query ports in disposable projects. The test covers two
coexisting revisions, session fencing, Unicode, HTML/PNG retention, Console input
and queue controls, cancellation and original records after package removal and
Host restart. Its inspection fixture checks reference continuation, non-forcing
binding reads, exact package/help identities and unchanged R search paths and
loaded namespaces. Native checks do not establish UI or complete scientific-owner
migration acceptance.
