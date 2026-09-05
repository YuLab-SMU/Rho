# Rho Next

Independent Rust workspace for the replacement described in
[the system charter and migration ledger](../docs/NEXT-SYSTEM.md).
The CLI exposes a project-only Host, a real Ark/R Host, or an explicitly selected
deterministic demo. Production capability routing is still owned by the old app.

Build and check the foundation:

```sh
cargo test --manifest-path next/Cargo.toml --workspace --locked
node next/scripts/check-architecture.mjs
```

Verify real R (requires Ark, R with jsonlite/rlang, and local loopback access):

```sh
RHO_NEXT_ARK=/absolute/path/to/ark node next/scripts/test-real-r.mjs
```

The script discovers R home using Rscript, or accepts RHO_NEXT_R_HOME. It tests
a persistent R session through the Host API, then exercises the CLI in a disposable
project. Ordinary Cargo tests explicitly skip this external-runtime acceptance.

Run a real operation:

```sh
cargo run --manifest-path next/Cargo.toml -p rho-next-cli --locked -- \
  --database /absolute/path/to/next-data/next.sqlite \
  --ark /absolute/path/to/ark --r-home /absolute/path/to/R/home \
  --project /absolute/path/to/project \
  invoke --client-request-id example-1 --code 'x <- 21; x * 2'
```

Use the returned operation ID with `get-operation <id>` and the same database.
That query opens a read-only connection and does not start R or recover operations.
Repeating a client request ID with different input is an error. The CLI uses the
local OS user's application context; Invocation cannot supply actor or scopes.

Each one-shot invocation starts a session and closes it on exit. Use `session`
instead of `invoke ...` with the same startup flags to keep one Host/R process
alive. It prints a ready frame with registered capability descriptors, then
accepts one JSON frame per line. Replies carry the same transport id and may
arrive out of order. Wait for an invoke reply before querying its resulting
objects. For example, send these frames in sequence:

```json
{"id":"run-1","request":{"method":"invoke","params":{"client_request_id":"run-1","capability":{"id":"workspace.run_r","version":1},"arguments":{"code":"x <- 21; x * 2"}}}}
{"id":"view-1","request":{"method":"query_snapshot","params":{"capability":{"id":"workspace.inspect_object","version":1},"arguments":{"name":"x","max_items":5}}}}
{"id":"list-1","request":{"method":"query_snapshot","params":{"capability":{"id":"workspace.snapshot","version":1},"arguments":{"limit":100}}}}
```

The five methods are `invoke`, `get_operation`, `request_cancellation`,
`query_snapshot`, and `subscribe`. Cancellation/get parameters contain
`operation_id`. Subscribe accepts `after_sequence` and `limit`; it returns one
durable cursor page, not a live push subscription. End stdin to finish accepted
requests and close the session.

Workspace queries return ready/busy/unavailable, source, session identity,
observation time and completeness. They do not create Operations. The busy
response does not submit R code. Snapshots are limited to 200 bindings; vector
previews to 100 items; plain data frames to 10 columns and 20 rows. Lazy and
active bindings are not forced; other classed objects expose metadata only.
rlang enables non-forcing binding inspection. Without it, bindings remain
uninspected rather than being forced to produce a preview.

Native R runs with the user's OS access; it is not a filesystem/network sandbox.
Effect observations are partial. R errors and cancellation do not roll back
assignments, files, or other effects. Ark result files stay in the selected
data directory for recovery; retention/garbage collection is still pending.

The Jupyter transport reuses the existing third-party
[Jet source](../vendor/jet/crates/core/src/lib.rs); no old Rho crate is linked.
[Ark](https://github.com/posit-dev/ark) owns the R kernel and protocol.

For foundation-only demonstrations use `--demo`; output explicitly says
`deterministic_fake`. The demo does not evaluate R.

Project operations need Git but do not require an R installation. Start a project
session with `--database /path/to/state/next.sqlite --project /path/to/project session`,
omitting `--ark`. The same project capabilities are available in an Ark Host.

```json
{"id":"files","request":{"method":"query_snapshot","params":{"capability":{"id":"project.snapshot","version":1},"arguments":{"paths":["analysis.R"],"limit":100}}}}
{"id":"read","request":{"method":"query_snapshot","params":{"capability":{"id":"project.read_file","version":1},"arguments":{"path":"analysis.R","offset":0,"limit_bytes":32768}}}}
```

Snapshot returns Git HEAD/status when present, discovered entries, and requested
file hashes. A folder without Git reports `git: null`; it is not assigned a
synthetic project revision. File reads return a byte array and a next-page flag,
so binary data and UTF-8 split across pages remain exact. Reads are limited to
64 KiB per page; hashed files to 64 MiB; snapshot paths to 64 and entries to 200.

`project.apply_patch` accepts a unified `patch` string. Generic one-shot calls use
`invoke --client-request-id ID --capability project.apply_patch --arguments JSON`.
Use Invocation preconditions (or one-shot `--preconditions JSON`) for
`{"kind":"git.head","subject":"project","expected":"<commit SHA>"}` and
`{"kind":"file.sha256","subject":"analysis.R","expected":"sha256:<digest>"}`.
A null file digest precondition means that the path must be absent.

Patches modify the working tree only: Git index and HEAD stay unchanged.
Existing staged/dirty/untracked files outside the patch are preserved. Native
Git parses both forward and reverse patch paths, including both sides of
renames. Host-owned data and paths traversing symbolic links are excluded.
R execution and project mutation share one Host lane; external editors are not
locked. A lost process outcome or observed partial change is recorded as
`uncertain`, with a new snapshot as the recovery path. No automatic Git commit
or retry is performed.

Environment support uses an explicit Rscript installation (`--rscript /path/to/Rscript`)
or the R installation selected by `--ark ... --r-home ...`. It registers
`environment.observe` (Query), `environment.plan`, `environment.realize`, and
`environment.verify` (Operations). Example session requests:

```json
{"id":"env","request":{"method":"query_snapshot","params":{"capability":{"id":"environment.observe","version":1},"arguments":{}}}}
{"id":"plan","request":{"method":"invoke","params":{"client_request_id":"env-plan-1","capability":{"id":"environment.plan","version":1},"arguments":{"manager":"pak","packages":["local::pkg"]}}}}
```

Plans also accept `{"manager":"renv","lockfile":"renv.lock"}`. Realize with
`{"plan_operation_id":"<successful plan operation ID>"}`; verify with
`{"realization_operation_id":"<successful realization operation ID>"}`.
References are checked against the project and caller; native lockfile and local
source digests are checked before installation. New libraries live in the
selected data directory, never in the user's existing library.

Verification loads every planned namespace in a separate R process using only
the new library and R's base library. The receipt records actual versions/paths,
a library content digest and a candidate renv.lock. It reports
`available_not_active`; an existing R session is unchanged. Start a new Ark
session with `--environment <realization operation ID>` to use it. Startup
re-verifies the library before selecting it. JSON/inspection support namespaces
load before the scientific library path is switched; other user libraries are
not used as dependency fallbacks.

```sh
node next/scripts/test-environment.mjs
```

This acceptance installs the small local fixture into temporary libraries,
restores its generated renv.lock, checks source/lock/library tampering, and
exercises real CLI selection. It requires renv, pak, jsonlite, R and Ark.
Remote repository behavior follows pak/renv and is not covered by this local
fixture. Native package scripts run with the user's OS permissions. Environment
cancellation and staged-library retention are still pending. Keep the data
directory outside any local source package to avoid self-containing builds.
