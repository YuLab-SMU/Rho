# Rho Next

Independent Rust workspace for the replacement described in
[the system charter and migration ledger](../docs/NEXT-SYSTEM.md).
The current CLI can execute real R through Ark, or run an explicitly selected
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
