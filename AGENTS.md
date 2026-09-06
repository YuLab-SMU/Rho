# Rho agent notes

Code and reproducible command output are the source of truth. Documentation is
a compact map of the current implementation; Git is the history. Plans and
status stay with the working issue or branch rather than becoming repository
documents.

The user-authorized exception is `docs/NEXT-SYSTEM.md`: the single living
design, replacement ledger and milestone record for Rho Next. Read it before
Next work; keep target, implemented, verified, production cutover and legacy
retirement distinct. Do not create a parallel plan or status document.
There are no real legacy users. Legacy architecture data assets are abandoned:
do not build data migration, import, archive-reader or compatibility work. Next
starts with fresh application state; focus on capabilities, entrypoints and
removing replaced code, not preserving old runtime or application data.

The root Cargo workspace now builds the new system only, with `rho` as its
default binary. Source remains under `next/` during directory cleanup. Old
`crates/`, `desktop/` and `r/` code has been removed; do not restore it as
a production dependency or run retired desktop/release gates for new changes.

## Architecture Philosophy

**Rho is the operable scientific space. The Agent platform owns conversation
and behavior. ACP is the thin boundary between them.**

Most product code belongs to Rho's scientific space:

- project files, editors, resources and user-visible scientific assets;
- the live Workspace R session, Environment state and runtime lifecycle;
- tools, executions, jobs, outputs, artifacts, evidence and revisions;
- capability schemas, containment, audit facts and recovery/rollback;
- truthful state snapshots, tool events and execution results.

The external Agent platform (Claude Code ACP, Codex, etc.) owns the smaller
agency layer:

- Conversation and Agent-session lifecycle;
- understanding intent, planning and choosing actions;
- model/provider configuration and private reasoning;
- permission modes, risk decisions and user prompting;
- retry, continuation and behavioral policy.

Rho's Agent integration should remain a small ACP adapter. For an Agent-facing
operation, Rho receives the request, validates protocol shape and mechanical
execution constraints, dispatches it to the scientific-space owner, and returns
the real state, tool events and run result. Rho must not rewrite the goal,
construct an internal plan, imitate an Agent loop, or introduce a second
permission decision.

Conversation content is not Rho authority. Persist only the minimal correlation
identities or visible audit projection required by the product; do not build a
parallel Conversation, planning or behavioral subsystem inside Rho.

### Key Principles

1. **Scientific space first** - Put capabilities in their real Rho owner, not
   in an Agent subsystem.
2. **Agent owns agency** - Conversation, planning, tool choice and behavioral
   control remain in the external Agent platform.
3. **Respond, don't orchestrate** - Rho reacts to requested operations and
   reports facts; it does not run a competing Agent loop.
4. **Expose the whole usable space** - Agents receive discoverable state and
   executable capabilities for Workspace, Environment, files, assets, evidence
   and runtimes.
5. **Validate mechanics, not intent** - Validate identity, schema, containment,
   quotas and revision integrity, not whether an action seems reasonable.
6. **No double approval** - The Agent platform's permission flow is
   authoritative. Rho does not create approval records or re-prompt the user.
7. **Return owner truth** - State, tool events and results come from the
   component that performed or observed the operation, never UI inference.
8. **Recover truthfully** - Preserve rollback/reconciliation material and
   report partial or uncertain outcomes instead of claiming success.

### Operation and Host Role

`rho-next-operation` registers capabilities and enforces schema, scope,
idempotency and commit discipline. Domain handlers interpret native observations
and return CommitPlan; they do not own independent result databases. Native
identities and owner-specific preconditions replace global revision counters.
`rho-next-host` is the composition root. CLI, browser and official MCP use its
five shared ports; none contains a second scientific operation flow.

**Removed concepts** (legacy from internal Agent era):
- ~~PermissionPosture~~ - Agent has its own permission modes
- ~~ApprovalBinding~~ - Agent's RequestPermission carries user approval
- ~~BrokerAdmissionOutcome::Ask~~ - Rho never prompts users, only Agent does

## Working loop

1. Inspect `git status` and the relevant source/tests.
2. Use `node scripts/governance.mjs impact --changed-auto` to see mapped areas
   and checks.
3. Make a small coherent change and run the closest test while iterating.
4. Run the affected checks when the behavior settles, inspect the diff, and
   report only results that actually ran.
5. Update a current document only when it explains something the code cannot
   express clearly. Delete obsolete explanation instead of archiving it.

Preserve unrelated working-tree changes. A mutation reports success only when
its authoritative state agrees. Keep identity, capability, schema, containment
and revision checks at the execution boundary, contain project data and
secrets, bound external data, and leave truthful recovery after failure. Agent
permissions belong to the Agent platform; extension sandbox permissions remain
a separate component concern. These are implementation properties, not
paperwork gates.

Documentation starts at `docs/README.md`. Its machine-readable page and source
maps live in `governance/registry.json` and `governance/source-map.json`.

## Verification

- Cargo invocations share one `target/` directory. Never run two
  `cargo test` or `cargo build` processes in parallel; the build lock
  serializes them and both appear hung until they time out.
- Iterate with the closest fast gate; run full suites once at the end.
  - Contract or client change: `npm run generate --prefix next/ui`,
    `npm run build --prefix next/ui`, then `npm run check --prefix next/ui`.
  - Rust change: filtered `cargo test -p <crate> <filter>`; reruns take
    seconds once the test binary is built.
- Do not poll background test runs with sleeps; wait for completion.
- When tests fail, compare the failing set against a pre-change baseline
  before attributing it to the current change.

## Repository details

- **Agent requests are trusted** - Rho validates mechanical constraints,
  dispatches to the owning scientific component, and never re-prompts users.
- New scientific capabilities belong in Workspace, Environment, project,
  runtime, artifact, evidence or other domain owners. The ACP/MCP layer only
  exposes and forwards them.
- Direct UI and Agent-triggered operations must report the same owner truth;
  neither path creates Rho-owned Agent approval records.
- Pass the normalized broker/store project root to Workspace R environment
  helpers. Do not rely on the process working directory.
- In R, test name membership before indexing a named atomic vector.
- Client types come from Rust contract through ts-rs. Keep generated types and
  embedded app.js current; do not reintroduce per-capability Tauri commands.
- The current client uses `next/workbench/assets/style.css` tokens and
  `next/ui/src/app.ts`; do not extend the retired desktop UI.
- Project skill discovery validates the `.rho/skills` root itself, including
  symlink containment.
- Windows GNU Rust commands require the Rtools45 toolchain at the front of
  `PATH`.

## Parallel work

Register only genuinely independent worktrees:

```bash
node scripts/dev-lanes.mjs start --id example --own 'path/**'
node scripts/dev-lanes.mjs check --id example --changed-auto
node scripts/dev-lanes.mjs finish --id example
```

Keep real workbench runs in the integration checkout. Before changing
tasks, preserve unfinished work in a clearly named WIP branch commit.

## Visual and installer operations

For a real visual run, build the embedded client and current binary, then open
its private local workbench URL through an available browser connection:

```bash
npm run build --prefix next/ui
cargo build --locked
```

The old installer/updater workflows are retired, not evidence of new packaging.
When distribution is explicitly requested, use a verified new-system packaging
path and report exact paths, sizes and hashes. Do not install or publish
automatically. See `docs/RELEASE.md` for the current operator map.
