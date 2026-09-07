# Developing Rho

Read [current focus](STATUS.md) and the relevant [architecture](ARCHITECTURE.md).
For Studio interaction work, also read [design principles](RHO-DESIGN.md) and
[user feedback](STUDIO-FEEDBACK.md). A proposed design is not implemented behavior.

## Working loop

1. Inspect `git status`, the relevant code and existing tests; preserve unrelated work.
2. Run `node scripts/governance.mjs impact --changed-auto` for mapped areas and checks.
3. Make a coherent change and iterate with the closest meaningful check.
4. Once behavior settles, run affected checks, inspect the diff and record actual
   results. Compare a failing test with the pre-change baseline before attributing it.
5. Update current documentation where it explains behavior or constraints. Keep
   detailed task plans with the issue/branch and run artifacts with the run.

Cargo commands share `target/`. Run only one Cargo build/test/check process at a
time, including client type generation, which invokes Cargo. Wait for background
commands to complete instead of polling them with sleep loops.

## Frontend iteration

The client uses React, FlexLayout and CodeMirror with Rust-generated contracts.
Edit `ui/src/`; treat `crates/workbench/assets/` as generated output.

```sh
npm ci --ignore-scripts --prefix ui
npm run generate --prefix ui
npm run build --prefix ui
npm run check --prefix ui
```

For iteration without ending the R session, run `npm run dev --prefix ui`. This
writes watched assets to `target/studio-assets`. Start the workbench with
`--dev-assets /absolute/path/to/target/studio-assets` after the `workbench`
subcommand. Reload the browser after a rebuild. Production uses embedded assets.

Panels consume the shared Studio model; HostClient owns transport. Document and
undo state must survive panel lifecycle changes. Layout changes must not execute
code. Keep visual feedback tied to actual owner state.

## Checks

| Change or verification need | Closest entry point |
| --- | --- |
| Rust behavior | `cargo test -p <crate> <filter> --locked` |
| Frontend model/component behavior | `npm run test --prefix ui` |
| Client types and embedded assets | Generate, build, then check as above |
| Studio interaction and real local R | `npm run test:browser --prefix ui` |
| Architecture/dependency ownership | `node scripts/check-architecture.mjs` |
| Documentation/map only | `node scripts/governance.mjs check` and `node scripts/test-governance.mjs` |

Broader Rust checks, run sequentially when affected:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
```

Native/transport verification:

| Script | Scope and prerequisites |
| --- | --- |
| `test-real-r.mjs` | Installed Ark and R with jsonlite, rlang, lintr and styler; real R, queries, cancellation and code tools |
| `test-workbench.mjs`, `test-mcp.mjs` | Real local transports; add `--real-r` for Ark/R and Environment observations |
| `test-environment.mjs` | R/Ark with pak, renv, ps and jsonlite; installs small local fixtures into temporary libraries, checks user-library preservation and recovery |
| `test-process-recovery.mjs` | R-free native process crash/reconciliation |
| `test-remote-protocol.mjs` | Local SSH/Slurm transcript fixtures; does not validate a remote cluster |
| `test-remote-live.mjs` | Opt-in real jobs on an explicitly selected host/scratch directory; see Operations |

These scripts live in `scripts/`. R tests accept `RHO_ARK` and `RHO_R_HOME` where
applicable. Ignored or unavailable external-runtime checks are not passes.
Playwright uses isolated Chrome and disposable projects; build the current client
and `rho` binary before running it. Keep real interactive workbench sessions in
the integration checkout, separate from disposable test projects.

## Review quality

Use sustained scientific scenarios alongside focused regression tests. Preserve
realistic accumulated files, objects, output history and layout changes. Check
focus, keyboard navigation, accessibility, cancellation, conflicts and recovery,
not only the successful screenshot. Do not automatically expand the feature scope
to match every feature of a reference application or tutorial.

`STATUS.md` is the single current progress summary. Architecture owns durable
technical constraints, design owns proposed interaction principles, and feedback
owns the user's reported problems. Replace obsolete explanation; Git keeps history.
