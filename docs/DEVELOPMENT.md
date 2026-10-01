# Developing Rho

Use [Status](STATUS.md) for current work, [Architecture](ARCHITECTURE.md) for
ownership, and [Next Version](NEXT-VERSION.md) for the agreed direction. This guide
contains the working loop; the generated [source/check index](SOURCE-INDEX.md)
contains the full command catalog. Plugin READMEs and tracked runners own detailed
fixture setup. Reading this guide does not require running all listed checks.

## Working loop

1. Inspect `git status`, the affected owner and existing tests. Preserve unrelated
   edits; routine work uses the primary checkout on `main`.
2. Run `node scripts/governance.mjs impact --changed-auto`. Choose the closest
   relevant L0/L1 check; suggestions are not a run-all list.
3. Build a coherent change and iterate with that check. Prefer native public
   interfaces and real owner data to private frontend or adapter shortcuts.
4. Once behavior settles, run affected checks, inspect the diff, update current
   documentation when needed, and commit the coherent authorized change.
5. Report only executed commands and their results. A narrower pass does not erase
   a failed, timed-out, skipped or unavailable required check.

Read-only investigation requires no edit, build, status entry or commit. Temporary
worktrees are for independent work; register/finish them through
`scripts/dev-lanes.mjs`. Keep real Workbench runs in the primary checkout.

### Milestone cadence

A milestone delivers a bounded user flow. For next-version capabilities, the first
complete flow is headless: interface, data, state transitions and actual results
through CLI/MCP/API. A browser or newly built frontend is not a prerequisite.
Frontends consume that same contract and have separate interaction milestones.
Existing UI changes still require their affected frontend checks.

Use L0/L1 during iteration. Run heavy independent packaging, frozen-Host acceptance,
real-R integration and browser flows once on settled milestone inputs, then rerun
only stages invalidated by changes or unresolved failures. Keep acceptance runners
in `scripts/`, never as one-off product tests under `target/`.

Before heavy acceptance, fix the required cases and completion condition. Check:
exact capability names/schemas, caller grants, generated declarations, retained
artifact receipts, toolchains and explicit Ark/R paths. UI stages additionally
need actual Ready/paint, focused controls and representative layouts. A fixture
or source check is not real-R or native keyboard/IME evidence.

### Acceptance execution and closure

Make independent flows selectable and able to prepare their own data. Share costly
setup only where isolation permits. Keep failures from independent cases when the
fixture remains healthy; mark dependent cases unrun when prerequisites fail.

Before a rerun, identify the failure, changed input, invalidated evidence and
smallest affected stage. Shared-boundary changes still cover affected consumers.
Do not keep adding optional coverage or performance work during closure. Once
required checks pass, inspect and commit; full workspace audits are optional unless
explicitly requested for a release or audit.

Test at the real effect: original caller/provider/session/request, one native
execution, verified output, and recovery without replay. Neither a synthetic model
peer nor a later receipt establishes real-model quality or the original uncertain
operation's success. UI rendering and scientific correctness have separate evidence.

### Planning and evidence reuse

Keep one active work order in Status and detailed steps with the issue/branch.
State the flow, owner/public port, required inputs, closest check and finish line.
Use evidence only for the source/artifact/dependency closure it actually covers.

| Change | Required scope |
| --- | --- |
| Documentation | Map/link/render review and diff; no native build |
| UI or shared view SDK | Affected model/consumer checks, build/check and relevant interaction flow; reuse valid native artifacts |
| Skills or source-only package content | Validate a new source revision and unchanged runtime bytes; no claim of a new native build |
| Native backend | Serial workspace build, retained package/receipt, affected owner and boundary checks |
| Public contract or generator | Generate bindings, rebuild changed consumers and verify affected crossings |
| Fixture | Correct the fixture and rerun its affected stage with valid retained artifacts |

## Testing SOP

| Tier | Purpose | Typical entry |
| --- | --- | --- |
| L0 | Closest useful iteration | `cargo test -p <crate> <filter> --locked` or one UI test file |
| L1 | Affected module after behavior settles | Crate/plugin model tests, client type/build checks |
| L2 | Changed cross-boundary flow | Real owner/Host, independent package, real R or browser as required |
| L3 | Explicit release or full audit | Serial full-workspace and product gates |

Cargo commands share `target/`: never run concurrent build/test/check commands.
Type generation also invokes Cargo. Use one invocation with multiple relevant
`-p` selections when a boundary check needs several packages. A workspace test
still executes every target even when compilation is incremental.

### Client and contract checks

```sh
# Only when Rust contracts or their generators change:
npm run generate --prefix ui

# Current affected-client completion checks:
npm run build --prefix ui
npm run check --prefix ui

# Focused iteration examples:
npm run typecheck --prefix ui
npm run test --prefix ui -- path/to/affected.test.ts
```

Current `build` does not invoke Cargo. Current `check` does regenerate/compare Rust
contracts and invokes Cargo; `generate` does too. Do not describe the proposed
Cargo-free local check path as implemented. `typecheck` and focused tests provide
current lightweight iteration. `crates/workbench/assets/` is generated output.

Relevant isolated browser checks use `npm run test:browser --prefix ui -- <file>`.
Build the current client and core first when their inputs changed. Reuse a retained
binary/package only when its evidence and dependency closure remain valid.
Headless capability acceptance does not certify UI behavior or remove tests for
existing frontends affected by a shared-contract change.

### Plugin builds and retained packages

Use each package's `BUILD.md`, `build.mjs` and `scripts/build-*-plugin.mjs` runner.
Workspace-native builds are the normal iteration path. Independent source-closure
builds prove the distribution boundary at a milestone, not at every internal edit.
UI-only changes reuse unchanged native binaries after the package builder's checks.

Agent acceptance in the current implementation requires an explicit choice:

```sh
node scripts/test-agent-plugin.mjs --build --evidence target/agent-acceptance.json
node scripts/test-agent-core-tools.mjs --package /absolute/retained/package
```

The first command retains its package and receipt. Reuse requires the exact current
input-source digest and package bytes; a stale receipt is a preflight failure,
not permission to silently rebuild. R uses the analogous
`scripts/build-r-plugin.mjs` and `scripts/r-plugin-artifact.mjs` workflow.
Package reuse proves artifact identity, not that a later test passed.

For the ordinary Agent UI, `node scripts/test-agent-view.mjs --build-ui` compiles
and checks the view without Cargo; its separate `--browser` mode checks rendering.
Current Agent implementation remains maintenance scope; next-version capability
work must not depend on expanding the built-in Agent.

### Real execution and evidence

Use `node scripts/test-real-r.mjs` and the affected ordinary-plugin runner listed
in [Source Index](SOURCE-INDEX.md). Supply explicit `RHO_ARK`, `RHO_R_HOME` and
retained package paths where the runner requires them. Validate prerequisites
before launching. Missing external prerequisites mean unavailable, not passed.

Select the affected flow, such as Files patch/recovery, R observation, Console
queue/input, Editor capture or Objects inspection. Use disposable projects and
prepared data. Do not use a user's live session as a test fixture or install R
packages merely to make a test start.

Record compile/assembly, process startup and test-body time separately, with
artifact identity and restart/rebuild counts. Keep reports with their run under
`target/`; summarize only meaningful conclusions and limitations in Status.

### Timeouts and reporting

If a build or test stalls, inspect the existing process/log once and distinguish
compilation, executable startup and test-body time. Do not launch duplicate Cargo
work, clear caches or restart a user Host to hide an environment problem.
Retain incomplete evidence. Report the exact command and outcome separately from
any narrower later check. Cache maintenance needs all Cargo/rustc work stopped
and an explicit maintenance reason; it is not routine test recovery.

## Frontend iteration

The current shell starts in `ui/src/app.ts`; tokens live in `ui/src/style.css`.
Scientific views and models belong to ordinary plugins and the public UI SDK.

```sh
npm run dev --prefix ui
# At initial launch of an authorized development Host:
target/debug/rho --project /absolute/project workbench \
  --dev-assets /absolute/Rho/target/studio-assets
```

This is a watched Vite build, not HMR. Reload after a rebuild. The running Host
serves bounded shell assets from the selected directory. This does not hot-swap
immutable plugin artifacts, add Host capabilities or replace a running backend.
A separate Node backend delivery path remains a next-version validation task.

For future frontend work, use shared contracts, representative fixtures and
component tests first, then the smallest real integration flow. Keep visual
quality, keyboard, focus, clipboard and system IME checks with the UI milestone.
Substantial redesign still uses reviewed Paper interactions. Inspect normal,
wide and constrained layouts with actual content; fixtures are not scientific facts.

Before replacing a Host, inspect current work and session state and respect the
existing restart authorization. Preserve acknowledged drafts/layout/history; R
memory does not survive Host shutdown. Do not reuse a PID, port or token without
checking it. Navigate private URLs directly and never record launch tokens in Git.

## Documentation and handoff

### Status discipline

Status is the only current summary, under 300 lines. Update it when behavior,
verification conclusions, focus or unresolved work changes, not merely for every
commit. Keep proposed, implemented and verified statements distinct. Git retains
history; do not create completed-work archives or another status ledger.

Documentation changes run:

```sh
node scripts/governance.mjs generate
node scripts/governance.mjs check
node scripts/test-governance.mjs
git diff --check
```

Check local links and affected anchors. Render after a coherent batch and inspect
the changed documents, including tables and code blocks; recheck affected content
after fixes. A documentation pass does not establish a new runtime result.

Commit coherent authorized work and check `git status` before ending. Distribution
is separately scoped: [Release](RELEASE.md) distinguishes build, signing,
installation and publication. Preserve unfinished work in a named WIP commit
before switching to an unrelated task.

## Native maintenance

Pass the normalized project root to R/environment helpers; do not infer it from
process cwd. In R, test name membership before indexing a named atomic vector.
Windows GNU Rust commands require Rtools45 first in PATH.

Jet uses the pinned source and ordered patches in [its maintenance guide](../patches/jet/README.md).
After edits run `node scripts/vendor-jet.mjs check`; preserve upstream notices and
source provenance. Other architecture/containment checks are mapped in Source Index.
