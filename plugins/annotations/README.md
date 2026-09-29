# Annotation owner

Version-bound notes, frozen source evidence, captured images, append-only revisions,
compare-and-swap updates, tombstones and durable idempotent receipts belong here.
The API, owner and SQLite store depend on public libraries only; they do not depend
on an Agent implementation, a scientific owner or a private Host crate.

This directory currently contains the extracted domain and storage components.
It is **not yet an installable plugin**: the native RPC entry, ordinary capability
manifest, contributed context and UI remain to be connected. AN01–AN05 remain a
UI proposal pending user review. See the repository's current Status for evidence.

## Ownership and admission

The containing runtime validates the live caller, principal, project and window
before creating `AnnotationActor`. Request fields cannot create authority.
Source observation and normalization happen through the contributing source owner;
`FrozenEvidence` must be that owner's actual bounded observation, never a caller's
claim about a file, document, R session or content version. These crates do not
read, modify, start or recover any scientific source.

`AnnotationSelection` and `AnnotationSession` are captured reference values, not
Agent task types or dispatch credentials. The later ordinary RPC adapter must
resolve contributed sources using their exact provider and window. A visible
annotation must not grant access to its source; missing current-version evidence
must stay unknown. That source resolution is not implemented by these crates.

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
cargo test -p rho-sqlite --test annotations --locked
node scripts/check-plugin-boundaries.mjs
```

Run Cargo serially. `node scripts/test-annotation-plugin-store.mjs --source-check`
checks that the copied component source resolves without private repository crates
and performs no compilation. An explicit `--independent` also runs its tests from
that temporary source tree; it is an architecture milestone check, not the routine
iteration path. The public component closure consists only of `api`,
`backend/owner`, `backend/store`, the root Cargo lockfile and license, with the
three crate paths registered in an ordinary Cargo workspace. Registry dependencies
remain pinned by that lockfile; no registry dependency source is copied here.
