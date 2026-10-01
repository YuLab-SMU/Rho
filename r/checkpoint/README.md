# Native object checkpoints

`checkpoint.c` is a private Rho component, not an installed R package. Build it for
an explicitly selected R installation with:

```sh
RHO_CHECKPOINT_R=/absolute/path/to/R node scripts/test-r-checkpoints.mjs --build-only
```

The script creates `target/rho-checkpoint/<version>-<platform>/rho_checkpoint.*`
and an identity/hash manifest. Supply the exact component path in the runtime
launch binding. The adapter checks the artifact hash and R home, then the native
bootstrap checks actual R version/platform before loading it. Opening a catalog
or automatic capture never invokes a compiler or installs anything.

Without `--build-only`, the script additionally exercises the classifier and a
capture/restore round trip in separate disposable `R --vanilla` processes. These
tests never attach to an existing user's session. `--print-library` implies
`--build-only` and prints only the component path, which is how
`scripts/test-real-r.mjs` supplies `RHO_CHECKPOINT_HELPER`.

The classifier traverses one shared graph, retaining alias identity and cycles.
It never reads active binding values or forces promises. Top-level unevaluated
bindings are omitted; nested promises retain their expression, environment and
value only when that complete graph is supported. Native resources and unknown
ALTREP providers exclude the containing root. Known base compact sequences and
base storage wrappers are handled without foreign provider accessors. The graph
walk has depth/node/byte limits, a shared time budget, and cooperative interrupt
checks. Published payloads use one native R serialization stream with bounded
writes and unwind cleanup. This is object storage, not a suspended process image.

Class namespace requirements are recorded from primitive class attributes.
Restore verifies artifact integrity and recorded R/library/package metadata,
prepares the exact installed namespaces in an empty candidate, and records any
initializers that run. It does not install packages or replay analysis/startup
scripts. Unexpected global bindings from package initialization reject the
candidate. Structural validation never establishes arbitrary model equivalence.

Captured context contains `.Random.seed` when present, a project-contained working
directory and validated scalar `digits`, `width`, `scipen`, `OutDec`, and `warn`
options. Other options, devices, callbacks, external files and search-path replay
are not implied. `.Last.value` and `.Traceback` are transient exclusions; user
names such as `rho_result` are ordinary eligible roots.

Artifacts and manifests remain native evidence until the shared Operation journal
commits their manifest. Staging files and orphan manifests never appear as saved
checkpoints. An explicit reconciliation can adopt a verified original published
manifest/payload into a new operation and independent immutable copy; it cannot
replay capture or change the original operation's terminal outcome. Catalog reads
use scoped journal pages and file metadata only. Digests are streamed on a blocking
worker for capture sealing, restore verification, and explicit reconciliation.
