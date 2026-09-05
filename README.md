# Rho

Rho is a local scientific workspace: a persistent R session, project files,
reproducible environments and native process/job execution, available to people
and external Agents through the same Host. The Agent owns conversation and
planning; Rho executes requested capabilities and reports what actually happened.

The repository now builds the new system by default. Source currently lives in
`next/`; the remaining old `crates/`, `desktop/` and `r/` implementations are
excluded from the production workspace and are being retired. There are no real
legacy users and no legacy-data migration or compatibility work.

## Run

Build with the pinned Rust toolchain:

```sh
cargo build --locked
target/debug/rho --database /absolute/path/to/state.sqlite workbench
```

Open the private local URL printed by the command, then select a project folder.
Without an R configuration, Project and local-process capabilities are available.
For a persistent real R session, use an installed Ark and R:

```sh
target/debug/rho --database /absolute/path/to/state.sqlite \
  --ark /absolute/path/to/ark --r-home /absolute/path/to/R/home \
  workbench
```

The workbench is embedded in the binary and only listens on `127.0.0.1`; running
it does not require Node. Its `/mcp` endpoint shares the same Host and live R
session. `rho ... mcp` also supports standalone stdio MCP. See the
[operator guide](next/README.md) for flags, capabilities, authentication and
real-runtime verification.

## Develop

```sh
cargo test --workspace --locked -- --test-threads=1
node next/scripts/check-architecture.mjs
npm ci --ignore-scripts --prefix next/ui
npm run check --prefix next/ui
```

Start with [Architecture](docs/ARCHITECTURE.md), the
[development loop](docs/DEVELOPMENT.md), and the
[system charter and replacement ledger](docs/NEXT-SYSTEM.md).
The ledger distinguishes implementation, verified behavior, entrypoint cutover
and source retirement; a green unit test is not full product acceptance.

## Boundaries and status

Native R and processes run with the local user's OS access. They are not an OS
sandbox. Operations preserve partial/uncertain outcomes and support explicit
reconciliation; a cancellation request is not proof that work stopped.

Local Rust, HTTP/MCP and real Ark/R acceptance are available. Browser visual
acceptance and real SSH/Slurm acceptance remain separate requirements. The old
Tauri installer, updater and release workflows are retired; the current manual
build workflow produces a CLI/workbench binary only. No automatic publishing or
installation occurs. See [Build and release](docs/RELEASE.md).

## License

Rho-original code is licensed under [AGPL-3.0-only](LICENSE). Bundled upstream
dependencies retain their licenses; see [LICENSES.md](LICENSES.md).
Security reports belong through [SECURITY.md](SECURITY.md).
