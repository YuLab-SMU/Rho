# Annotation owner

Version-bound notes, frozen source evidence, captured images, append-only revisions,
compare-and-swap updates, tombstones and durable idempotent receipts belong here.
The API, owner and SQLite store depend on public libraries only; they do not depend
on an Agent implementation, a scientific owner or a private Host crate.

The native RPC entry, typed capability manifest, text-source freeze and contributed
note context are implemented. The workspace-built package passes a frozen generic
Host flow with a real Editor provider, source changes, historical notes and an
actual graceful Host restart of the same annotation instance. Agent Rho Send and
its existing browser context picker also pass with this real provider; retained
Send context survives Host restart while the provider remains suspended. Native Agent
read/create/update, version-conflict refusal and original child Operations also pass;
both Sends replay after restart without reactivating the note provider or external peer.
Capture import/read RPC accepts bounded immutable PNG/JPEG resources, decodes and
verifies their bytes, and retains images separately from note context. Annotation UI
remains incomplete; AN01–AN05 await user review. Help and
Viewer source identities have focused tests, not real annotation-flow acceptance.
See the repository's current Status for executed checks and retained timeouts.

## Ownership and admission

The containing runtime validates the live caller, principal, project and window
before creating `AnnotationActor`. Request fields cannot create authority.
Source observation and normalization happen through the contributing source owner;
`FrozenEvidence` must be that owner's actual bounded observation, never a caller's
claim about a file, document, R session or content version. The domain/store do not
read scientific sources; the native adapter uses declared bounded public queries.
Neither layer modifies, starts or recovers a scientific source.

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
a failed read proves current availability. Reads require `application.read` and
writes require `application.control`, both alongside `plugins.read`; the original
caller and this instance must also hold the source query's declared grants. No
annotation-specific Host registration or scope is introduced. Agent declares all
six capabilities as optional grants; activation must select them explicitly.
`annotations.capture.import` additionally requires `resources.read` from both the
instance and original caller. It reads an exact public resource in 64 KiB chunks,
checks its digest, fully decodes PNG/JPEG within the image budget, and derives
actual dimensions. Imports are at most 8 MiB; retained captures are always labeled
`original_media: false`. Captured-view anchors reference that retained exact image;
they do not certify the pixels as a scientific original or as the context source's
rendering. Import replay reads its original receipt without contacting the resource
provider. `annotations.capture.read` returns bounded chunks of that exact stored
capture. Default `note_and_evidence` context identifies the capture without pixels.
Explicit `note_evidence_and_image` publishes the exact retained capture as an
annotation-owned public resource, alongside the note, frozen evidence and marks.
Consumers must separately validate resource read authority, owner, bytes and digest;
the image remains a captured view, not certified scientific original media.
The framed principal supplies author identity without guessing
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

`node scripts/test-annotation-plugin.mjs` requires retained packages through
`RHO_ANNOTATION_PLUGIN_PACKAGE`, `RHO_EDITOR_PLUGIN_PACKAGE` and
`RHO_FILES_PLUGIN_PACKAGE`. It snapshots them into a disposable database, uses
the existing `RHO_TEST_BINARY` (default `target/debug/rho`), and never compiles.
`RHO_ANNOTATION_EVIDENCE` selects its JSON report. The real Editor check covers
freeze, current-source refusal, continuation, revision CAS, tombstones, historical
context and same-instance graceful Host recovery with the source still suspended.
The fixture retains its disposable project and original records.

Add `--agent` with `RHO_AGENT_PLUGIN_PACKAGE` to verify exact note context through
real Agent/Rig Send and same-instance restart without source or model replay. It also
checks Native Agent read-only vs read/write Send selections, authenticated note
creation/update, stale-version refusal, exactly three original write Operations
(including the failed stale update), and recovery while the provider remains suspended.
Malformed native arguments are refused before dispatch and cannot poison Send settlement.
The HTTP model and external ACP peers are deterministic local fixtures; this is not
third-party model evaluation. Add `--browser` alongside `--agent` to exercise the existing ordinary
Agent picker, draft retention after reload and constrained panel layouts. Inspect
the retained screenshots separately.

Add `--captures` for a language-independent Python resource peer publishing a real
multi-chunk PNG through the generic native resource channel. It checks import,
Editor-bound captured-view evidence and marks, exact chunk readback, damaged-image
refusal and same-instance restart while the resource provider remains suspended.
Together with `--agent`, this also checks explicit captured-image context through
Native and Rho Send, the Rho image diagnostic, text-only followup and restart with
no image/source/model replay. `--browser` checks the actual thumbnail and draft.
This does not establish browser screenshot/upload capture, real R image provenance,
annotation editor UI or abrupt-crash recovery.
