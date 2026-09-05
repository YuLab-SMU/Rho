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

Verify real R (requires Ark, R with jsonlite, and local loopback access):

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

Each one-shot CLI invocation starts a session and closes it on exit. A host
kept alive through the Rust API preserves the R session across invocations.
Long-lived CLI/IPC hosting and Workspace queries are still pending.

Native R runs with the user's OS access; it is not a filesystem/network sandbox.
Effect observations are partial. R errors and cancellation do not roll back
assignments, files, or other effects. Ark result files stay in the selected
data directory for recovery; retention/garbage collection is still pending.

The Jupyter transport reuses the existing third-party
[Jet source](../vendor/jet/crates/core/src/lib.rs); no old Rho crate is linked.
[Ark](https://github.com/posit-dev/ark) owns the R kernel and protocol.

For foundation-only demonstrations use `--demo`; output explicitly says
`deterministic_fake`. The demo does not evaluate R.
