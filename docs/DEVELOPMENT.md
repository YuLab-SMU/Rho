# Development

The root workspace builds Rho. Do not use the retired desktop commands or create
a second Cargo workspace. Legacy source is retired; do not restore old owners or compatibility paths.

1. Inspect `git status`, the current entrypoint and relevant tests.
2. Run `node scripts/governance.mjs impact --changed-auto` for mapped checks.
3. Make one coherent change; use `cargo test -p <rho-crate> <filter> --locked`
   or the closest native acceptance while iterating.
4. Run affected checks once behavior settles, inspect the diff and record only
   commands that actually ran. Never run Cargo builds/tests in parallel against
   the shared target directory.

Core checks:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
node scripts/check-architecture.mjs
node scripts/governance.mjs check
node scripts/test-governance.mjs
```

The client uses React, CodeMirror and FlexLayout in `ui/src/`, generated Rust
contracts, and a deterministic Vite bundle embedded by the workbench. Treat
`crates/workbench/assets` as generated output:

```sh
npm ci --ignore-scripts --prefix ui
npm run generate --prefix ui
npm run build --prefix ui
npm run check --prefix ui
npm run test --prefix ui
npm run test:browser --prefix ui
```

For frontend iteration, `npm run dev --prefix ui` writes watched assets to
`target/studio-assets`; start the workbench with `--dev-assets` pointing there.
A browser reload updates the UI while the Host/R session stays alive. Panel
components consume the shared Studio model; HostClient owns requests and polling.
Document/undo state must survive panel mount, unmount and layout changes.

Real HTTP/MCP checks are `scripts/test-workbench.mjs` and `test-mcp.mjs`.
Add `--real-r` for actual Ark/R. `test-real-r.mjs` and `test-environment.mjs`
exercise native R behavior, not a fake kernel. External prerequisites and flags
are in [the operator guide](OPERATIONS.md). Ignored tests are not passes.

Keep ownership and bounded-input constraints in code and tests. No Agent policy
loop, risk workflow or second approval layer belongs here. Legacy data inventory,
migration, import and archive-read compatibility are out of scope.

[NEXT-SYSTEM.md](NEXT-SYSTEM.md) is the only design/progress ledger. Git retains
file history. Update the ledger for decisions, verified milestones and retirement,
not for every edit or as a substitute for actual behavior.
