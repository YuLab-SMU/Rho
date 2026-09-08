# Working on Rho

Rho is the operable scientific workspace. Current work concerns product quality
and scientific capabilities. The root Cargo workspace builds `rho`; source lives
in `crates/`, `r/`, `ui/` and `scripts/`.

This is the single repository instruction file, including for `crates/`. Keep
shared rules here; add a nested AGENTS.md only for genuinely different local rules.

## Read for the task

Start with `docs/README.md` and `docs/STATUS.md`. Read `docs/ARCHITECTURE.md` for
ownership and execution constraints. For Studio work, read `docs/RHO-DESIGN.md`
and `docs/STUDIO-FEEDBACK.md`. Design distinguishes approved interactions from
proposals; Status records implementation and evidence. Passing functional tests
does not establish visual quality or close usability feedback.

`docs/STATUS.md` is the single current status summary. Durable constraints belong
in Architecture; interaction principles in Design; user problems in Feedback.
Detailed plans stay with the working issue/branch. Git is the history; do not add
completed-work archives or another progress ledger. `docs/SCENARIO-PLUGINS.md` is
research, not an implementation commitment.

Data from abandoned implementations is not a supported input. Do not introduce
migration, import, archive-reader or compatibility work without a new request.

## Architecture rules

- Scientific owners manage files, the live R Workspace, Environment, executions,
  jobs, outputs and recovery. Add capabilities to their real owner.
- External Agent platforms own conversation, intent, planning, tool choice,
  model/provider settings, permissions and continuation. Rho receives requests
  and reports facts; it does not run another Agent behavior loop.
- Agent requests are trusted subject to mechanical identity, schema, scope,
  containment, quota and native-precondition checks. Do not add Rho approvals or
  re-prompt for Agent-authorized operations. Extension isolation is a separate concern.
- `rho-operation` owns registration, idempotency and commit discipline. Domain
  handlers interpret observations and return CommitPlan. Adapters do not own
  independent result databases or commit scientific truth.
- `rho-host` is the composition root. CLI, browser and official MCP share its five
  ports; edges must not contain a second scientific operation flow.
- Use native identities and owner-specific preconditions instead of a global
  scientific revision counter. A mutation succeeds only when authoritative state
  agrees. Cancellation requests, confirmed cancellation and rollback are distinct.
- Queries are bounded observations; they must not start a runtime or recover work
  simply to read it. Preserve partial/uncertain outcomes and recovery material.
- Preserve project containment and caller/principal visibility through every edge.

## Studio design and package inspection

- For substantial Studio layout or component redesign, develop the interaction
  in Paper before implementation and obtain user review. Reuse approval already
  given in the conversation; routine fixes within that scope need no new approval.
- The approved Packages designs are in the Paper file **Rho · 工作台交互草稿**,
  page **Packages · 查看体验设计评审**. Its link and specifications are in
  `docs/RHO-DESIGN.md`, section 11. Read Paper JSX/computed styles for exact values;
  use screenshots to verify the result, not as the only implementation input.
- Give useful content priority: package purpose and version belong in the list;
  full paths and provenance belong in inspection details. Check normal, wide and
  constrained panels with representative real content before claiming completion.
- Core Packages is read-only. Package installation and environment-management
  decisions are reserved for a future separate plugin. Viewing must not install,
  update, remove, load or attach packages, change library paths or test loadability.
- The active Workspace owns package observations. Grouped counts, index pages and
  copy details must share an observation and native session; label cached/partial
  results while busy. Source belongs to each installed copy. Keep recorded source,
  delivery repository and project links distinct; missing evidence stays unknown.
  Do not infer installation history from current repos, a homepage or a path name.

## Working loop

1. Inspect `git status` and the relevant source/tests. Preserve unrelated changes.
2. Run `node scripts/governance.mjs impact --changed-auto` for mapped checks.
3. Make a coherent change and iterate with the closest useful test.
4. Run affected checks once behavior settles; inspect the diff and report only
   commands that ran. Compare failures against a pre-change baseline.
5. Update a current document when it clarifies behavior or changes current focus.
   Keep proposed, implemented and verified claims distinct.

## Verification and iteration

- Cargo invocations share `target/`: never run two Cargo build/test/check commands
  in parallel. Type generation invokes Cargo too. Wait for completion; do not
  poll background tests with sleeps.
- Rust changes: use `cargo test -p <crate> <filter> --locked` while iterating.
- Contract/client changes: run `npm run generate --prefix ui`, then
  `npm run build --prefix ui`, then `npm run check --prefix ui`.
- UI behavior: use `npm run test --prefix ui` and relevant isolated Chrome tests.
  Build the current binary before `npm run test:browser --prefix ui`.
- Real R checks use `node scripts/test-real-r.mjs`; skipped external checks are not
  passes. Full checks and prerequisites are in `docs/DEVELOPMENT.md`.
- For a real visual run, build the client and `cargo build --locked`, then open the
  private workbench URL through an available browser connection. Development assets
  support browser refresh without restarting R; see `docs/OPERATIONS.md`.
- A client refresh cannot add a new Host capability. Before replacing a running
  Host, inspect its current work and session state and respect existing restart
  authorization. Preserve synchronized drafts/layout/history; R memory does not
  survive restart. Do not reuse an old PID, port or token without checking it.
- Navigate private Workbench URLs directly. If using a native address bar, paste
  the complete URL and verify it before Enter so it cannot become a web search.
  Never put launch tokens in tracked files or handoff documents.

## Implementation details worth preserving

- Pass the normalized Host/project root to R environment helpers; do not infer it
  from the process working directory.
- In R, test name membership before indexing a named atomic vector.
- The native R adapter uses Jet under `vendor/jet`; preserve the existing adapter
  boundary and upstream notices when changing that integration.
- Rust contracts generate TypeScript DTOs through ts-rs. Keep generated bindings
  and embedded assets current; use the shared Host ports.
- Studio starts in `ui/src/app.ts`; tokens live in `ui/src/style.css`.
  `crates/workbench/assets/` is generated. Panels use the shared Studio/Document
  models and HostClient; preserve document state across layout changes.
- Product-authored UI uses English. Preserve Unicode user content and native output.
- Project skill discovery must validate the `.rho/skills` root itself, including
  symlink containment.
- Windows GNU Rust commands require Rtools45 at the front of PATH.

## Parallel work and distribution

Register only genuinely independent worktrees with `scripts/dev-lanes.mjs`:
`start --id NAME --own 'path/**'`, `check --id NAME --changed-auto`, and
`finish --id NAME`. Keep real workbench runs in the integration checkout.
Before switching tasks, preserve unfinished work in a clearly named WIP commit.

Distribution requires an explicit task and a verified packaging path. Report exact
commit, artifacts, sizes, hashes and executed checks. Build, signing, installation
and publication are separate outcomes; do not install or publish automatically.
Use `docs/RELEASE.md` for the current operator map.

## Session handoff

Before ending a session, commit coherent authorized work and check `git status`.
Record the current implementation, executed checks, unresolved work and useful
restart paths in `docs/STATUS.md`. Keep transient process details out of this file.
The next session should read that page and inspect the live processes before
starting another Host for the same project.
