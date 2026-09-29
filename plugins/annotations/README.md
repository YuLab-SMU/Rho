# Annotation owner

Version-bound notes, frozen source evidence, captured images, append-only revisions,
compare-and-swap updates, tombstones and durable idempotent receipts belong here.
The API, owner and SQLite store depend on public libraries only; they do not depend
on an Agent implementation, a scientific owner or a private Host crate.

The native RPC entry, typed capability manifest, text-source freeze and contributed
note context are implemented in source. **Native compilation and acceptance are
incomplete; no installable package has been verified.** Capture/image RPC and UI
remain unimplemented. AN01–AN05 remain a UI proposal pending user review. See the
repository's current Status for executed checks and retained timeout evidence.

## Ownership and admission

The containing runtime validates the live caller, principal, project and window
before creating `AnnotationActor`. Request fields cannot create authority.
Source observation and normalization happen through the contributing source owner;
`FrozenEvidence` must be that owner's actual bounded observation, never a caller's
claim about a file, document, R session or content version. These crates do not
read, modify, start or recover any scientific source.

`AnnotationSelection` and `AnnotationSession` are captured reference values, not
Agent task types or dispatch credentials. The native adapter resolves contributed
sources using exact provider, artifact, window and original caller grants. The
owner supplies `ContextPreview.data.annotation_source` with stable `source_id`
and content `source_version`; missing identity is refused, never inferred from a
selector. Editor uses draft lineage and document bytes, Help uses installed-topic
lineage and retained help-file digests, and Viewer uses the original output and
resource digest. A fresh observation alone is not a content change.

Freezing requires a complete text inclusion; quote offsets refer to that inclusion
and preserve UTF-8/UTF-16/scalar boundaries. Exact request replays read the original
receipt without querying the source again. Note context reads frozen evidence and
labels the current underlying source status unknown: neither a retained note nor
a failed read proves current availability. Agent grants and real-provider/Host
acceptance remain to be connected; deterministic native peer tests do not replace
that acceptance. The framed principal supplies author identity without guessing
whether the initiating actor was human or Agent.

`AnnotationStore::open` receives a private data path from its trusted container.
Each transaction rechecks receipt identity, revision CAS and the total retained
project budget across principals. Evidence and old revisions survive a tombstone.
Captured bytes remain separate from JSON records. Successful local metadata
transactions do not replace the Host's original Operation settlement.

## Transitional fixed entry

The retiring Application and SQLite adapters only convert typed records, validate
the current window and call this owner/store. Their new storage is a separate
`*.annotations-v1.sqlite` file. They never read, migrate or import annotation
tables from an older Application database, and never delete the older database.
Remove those adapters with the fixed Host annotation service in M6, after the
ordinary RPC/context flow has its acceptance evidence. There is one domain and
transaction implementation, not separate fixed and plugin implementations.

## Checks

During iteration, reuse the root workspace cache:

```sh
cargo test -p rho-annotation-store --test annotations --locked
cargo test -p rho-annotation-backend --lib --locked
cargo test -p rho-sqlite --test annotations --locked
node scripts/check-plugin-boundaries.mjs
```

Run Cargo serially. `node scripts/test-annotation-plugin-store.mjs --source-check`
checks the actual assembled package layout without compilation. Its six local
crates are API, backend, owner, store, public protocol and backend SDK; none import
private Host or Agent code. An explicit `--independent` additionally runs the
owner/store tests from that source tree; it does not run native RPC acceptance.
Use the workspace builder in [BUILD.md](BUILD.md) during iteration. Registry
dependencies remain pinned by the lockfile; their source is not copied here.
