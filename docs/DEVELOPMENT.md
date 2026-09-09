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

Panels consume module-specific hooks and commands; HostClient owns transport behind
narrow ports. Domain snapshots are read-only. Document and undo state survive panel
lifecycle changes. Layout changes must not execute code. Keep visual feedback tied
to actual owner state. Studio only composes and manages the client lifecycle.

## Checks

| Change or verification need | Closest entry point |
| --- | --- |
| Rust behavior | `cargo test -p <crate> <filter> --locked` |
| Shared capability contracts and result validation | `cargo test -p rho-contract --locked`, then `cargo test -p rho-operation --locked` |
| Application windows, captures and CAS receipts | `cargo test -p rho-application --locked`, SQLite tests and `ui/tests/application-bridge.test.ts` |
| Skill sources, resource identity and method binding | `cargo test -p rho-adapter-skills --locked`, then `cargo test -p rho-host --test skills --locked` |
| Frontend model/component behavior | `npm run test --prefix ui` |
| Client types and embedded assets | Generate, build, then check as above |
| Studio interaction and real local R | `npm run test:browser --prefix ui` |
| Rust architecture/dependency ownership | `node scripts/check-architecture.mjs` |
| Frontend ownership and dependency boundaries | `npm run check:boundaries --prefix ui` and `npm run test:boundaries --prefix ui` |
| Vendored Jet snapshot / verifier | `node scripts/vendor-jet.mjs check` and `node scripts/test-vendor-jet.mjs` |
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
| `test-real-r.mjs` | Installed Ark and R with jsonlite, rlang, lintr and styler; real R, progressive object/package queries, non-forcing inspections, cancellation and code tools |
| `test-workbench.mjs`, `test-mcp.mjs` | Real local transports; add `--real-r` for Ark/R and Environment observations |
| `test-environment.mjs` | R/Ark with pak, renv, ps and jsonlite; installs small local fixtures into temporary libraries, checks user-library preservation and recovery |
| `test-process-recovery.mjs` | R-free native process crash/reconciliation |
| `test-remote-protocol.mjs` | Local SSH/Slurm transcript fixtures; does not validate a remote cluster |
| `test-remote-live.mjs` | Opt-in real jobs on an explicitly selected host/scratch directory; see Operations |
| `test-agent-interface.mjs` | Independent local Codex sessions with prebuilt Rho/Ark, installed R, Chrome, UI dependencies and authenticated pinned Codex; self-test/debug modes are not acceptance |
| `test-agent-clients.mjs` | Opt-in native Codex/Kimi/DeepSeek: two same-model tasks, request deduplication, same-ID resume and fresh MCP reads; installed/authenticated CLI and current binary required |
| `test-deepseek-inbox.mjs` | Checks the installed, lock-matched native Inbox replay/clear implementation with a disposable journal; no provider calls or session scan |
| `test-agent-task-recovery.mjs` | Disposable Host crash, explicit same-ID resume, retained draft/uncertain receipt, refreshed MCP and images; local ACP fixture by default, `--real-kimi`, `--real-codex`, `--real-deepseek` use the documented configured development models and verify fresh MCP delivery |

These scripts live in `scripts/`. R tests accept `RHO_ARK` and `RHO_R_HOME` where
applicable. Ignored or unavailable external-runtime checks are not passes.
Playwright uses isolated Chrome and disposable projects; build the current client
and `rho` binary before running it. Keep real interactive workbench sessions in
the integration checkout, separate from disposable test projects.

The approved workspace Agent task UI is in Design section 13. Focused Chrome tests
are `ui/e2e/agent-tasks.spec.ts`; local native protocol fixtures never call a model.
For the configured Kimi development model, explicitly run:

```sh
node scripts/test-agent-clients.mjs --real-model --provider kimi --kimi-model b-ai/glm-5.3-flash --allow-overview
node scripts/test-agent-task-recovery.mjs --real-kimi
# Other configured runtime recovery checks:
node scripts/test-agent-task-recovery.mjs --real-codex
node scripts/test-agent-task-recovery.mjs --real-deepseek
```

Both create and clean up independent test Hosts and preserve native config hashes.
They must not be pointed at an existing research Host. The exact reviewed Kimi source
is tag `@moonshot-ai/kimi-code@0.41.0`, commit
`95478e8c7ba248fd2470d5bb151555ec7fedd19d`; adapter behavior is checked against actual
handshake metadata and that version's ACP/session source. A live-model failure is
not converted to a retry of its uncertain original request.

## Contract and source changes

Add capabilities to their owner and register them through Host. Keep input,
concrete payload/recovery schemas, documentation, examples and related read paths
in the same descriptor. Query schemas describe `QuerySnapshot.data`; operation
schemas describe `OperationRecord.output`. Shared helpers generate envelopes.
Validate actual results as well as requests; do not disguise a known result shape
as generic JSON. Dynamic native values and host-owned metadata must be explicitly
identified as such.

Continuation tests must cover identity changes and exhausted work budgets, including
zero-result search pages and Unicode/long-value boundaries. Source tests distinguish
strict local standard Skills from host-attested native discovery semantics. Fixtures
must not rewrite, rename, execute or install a host's method package. Application
checks must retain window/incarnation/resource identity and original Agent actor
through capture, save verification, execution and lost-acknowledgement recovery.
Add affected paths/checks to governance and dependency maps, then regenerate DTOs
and assets before verifying the current binary.

## Independent Agent acceptance

[`test-agent-interface.mjs`](../scripts/test-agent-interface.mjs) and
[`scripts/agent-interface/`](../scripts/agent-interface/) are development tests,
not a product Agent harness. They run isolated Codex sessions via `codex exec --json`
and temporary MCP configuration. Scientific fixtures and answers are outside the
Agent working directory; scientific reads/actions must use Rho. Only the native
Skill-equivalence case grants access to its explicitly listed method resources.
The runner does not install prerequisites or restart existing user Hosts.

Inspect available categories and validate the deterministic harness separately:

```sh
node scripts/test-agent-interface.mjs --list
node scripts/test-agent-interface.mjs --self-test
```

After committing a clean tree and building matching DTOs/assets/binaries, run:

```sh
node scripts/test-agent-interface.mjs --final \
  --binary /absolute/path/to/Rho/target/debug/rho \
  --ark /absolute/path/to/ark --r-home /absolute/path/to/R/home \
  --codex /absolute/path/to/pinned/codex
```

`--final` requires ten core categories repeated three times, native/Rho Skill
resource equivalence and two adaptation cases: 34 runs. Model/reasoning, Codex
version and binary digests are fixed by the runner and recorded with the source
tree. Each task has an 80-call, 1 MiB UTF-8 text and ten-minute budget; native image
bytes and actual token usage are counted separately. Read-only investigation cases
cannot use `run_r` to bypass query interfaces. Programming/analysis cases can use
the scientific execution capabilities their task permits.

`--filter` and `--runs` are debugging options; their results do not establish final
acceptance. Preserve every attempt, JSONL/tool/resource trajectory, original
operation record, assertion, screenshot and artifact hash. Missing prerequisites,
exceeded budgets, identity mixing, repeated execution, silent overwrites or false
completeness are failures. Fix the interface/implementation and rerun on a new
fixed version; do not encode an answer or mandatory tool sequence into the task
prompt. Evidence defaults to `target/agent-interface/acceptance/`; summaries and
outstanding verification belong in [Status](STATUS.md).

## Review quality

Use sustained scientific scenarios alongside focused regression tests. Preserve
realistic accumulated files, objects, output history and layout changes. Check
focus, keyboard navigation, accessibility, cancellation, conflicts and recovery,
not only the successful screenshot. Do not automatically expand the feature scope
to match every feature of a reference application or tutorial.

`STATUS.md` is the single current progress summary. Architecture owns durable
technical constraints, design owns proposed interaction principles, and feedback
owns the user's reported problems. Replace obsolete explanation; Git keeps history.


## Maintain the Jet core snapshot

`vendor/jet-core` is generated third-party source, not a second Rho workspace.
Maintain the ordered patches and checksums in `patches/jet`; the
[patch README](../patches/jet/README.md) documents offline checking, independent
upstream replay, rebuilding and preparing an explicit upstream commit for review.
The original upstream license must remain intact.

Run `node scripts/vendor-jet.mjs check` for offline integrity and reverse/forward
replay, and `node scripts/vendor-jet.mjs verify` to rebuild independently from the
checksum-pinned archive. `prepare` writes a proposal under `target/`, so a patch
failure or changed inherited dependency cannot silently update production source.
Verification/preparation and the script regression tests can invoke Cargo metadata;
serialize them with other Cargo invocations. CI is configured to run offline
integrity and regression checks on each native build platform.
