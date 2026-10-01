# Working on Rho

Rho is the operable scientific workspace. Current work concerns product quality
and scientific capabilities. The root Cargo workspace builds `rho`; source lives
in `crates/`, `r/`, `ui/` and `scripts/`.

This is the single repository instruction file, including for `crates/`. Keep
shared rules here; add a nested AGENTS.md only for genuinely different local rules.

## Read for the task

When first joining or resuming project work, use `docs/README.md` and the relevant
parts of `docs/STATUS.md` for orientation. Otherwise read only what the task needs:
`docs/ARCHITECTURE.md` for current ownership or execution boundaries,
`docs/NEXT-VERSION.md` for the target architecture, and `docs/RHO-DESIGN.md`
and `docs/STUDIO-FEEDBACK.md` for Studio interaction changes. Reuse context already
read when it remains current. Design distinguishes approved interactions from
proposals; Status records implementation and evidence. Passing functional tests
does not establish visual quality or close usability feedback.

`docs/STATUS.md` is the single current status summary. Durable constraints belong
in Architecture; interaction principles in Design; user problems in Feedback.
Detailed plans stay with the working issue/branch. Git is the history; do not add
completed-work archives or another progress ledger. Superseded Agent plans and
scenario research remain in Git. Target design does not establish implementation.

Data from abandoned implementations is not a supported input. Do not introduce
migration, import, archive-reader or compatibility work without a new request.

## Architecture rules

- Scientific owners manage files, the live R Workspace, Environment, executions,
  jobs, outputs and recovery. Add capabilities to their real owner.
- The next version uses external Agents through public capabilities; it does not
  require an internal model engine, chat product or task scheduler. The current
  ordinary Agent plugin and Rig engine still exist and retain their validated
  Host boundaries until separately changed. Scientific owners, Operation and
  native adapters do not plan Agent work or call models. Caller authorization
  stays explicit; model output and context cannot expand it or introduce another
  approval decision.
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
  `docs/RHO-DESIGN.md`, under Packages. Read Paper JSX/computed styles for exact values;
  use screenshots to verify the result, not as the only implementation input.
- Give useful content priority: package purpose and version belong in the list;
  full paths and provenance belong in inspection details. Check normal, wide and
  constrained panels with representative real content before claiming completion.
- The Packages plugin is read-only. Package installation and environment-management
  decisions belong to their separate owner. Viewing must not install,
  update, remove, load or attach packages, change library paths or test loadability.
- The active Workspace owns package observations. Grouped counts, index pages and
  copy details must share an observation and native session; label cached/partial
  results while busy. Source belongs to each installed copy. Keep recorded source,
  delivery repository and project links distinct; missing evidence stays unknown.
  Do not infer installation history from current repos, a homepage or a path name.

## Working loop

The following loop applies to tasks that change the repository. Read-only questions
and reviews do not require edits, builds, status updates, or commits.

1. Inspect `git status` and the relevant source/tests. Preserve unrelated changes.
2. Run `node scripts/governance.mjs impact --changed-auto` for scoped L0/L1
   suggestions. Select the closest affected check; this is not a run-all list.
   Use `--phase milestone` for L2 acceptance or `--phase audit` only when a full
   audit is explicitly due. Deferred checks are not passes.
3. Make a coherent change and iterate with the closest useful test. Follow the
   testing tiers and reporting rules in `docs/DEVELOPMENT.md` § Testing SOP; do not
   rerun the entire workspace for every small edit.
4. Run affected checks once behavior settles; inspect the diff and report only
   commands that ran. Investigate a pre-change baseline when needed to attribute
   a failure. Reuse passing results that cover the current changes; rerun only
   when new changes, failures, or unresolved concerns justify it.
5. Update a current document when it clarifies behavior or changes current focus.
   Keep proposed, implemented and verified claims distinct.

## Verification and iteration

- Cargo invocations share `target/`: never run two Cargo build/test/check commands
  in parallel. Type generation invokes Cargo too. Wait for completion; do not
  poll background tests with sleeps.
- Testing is tiered as documented in `docs/DEVELOPMENT.md` § Testing SOP: use
  focused crate/test-file checks while iterating and affected-module or
  cross-boundary checks once behavior settles. The full workspace suite is an
  optional audit; run it only for an explicit release/user request.
- Work in milestones organized as bounded end-to-end flows. Next-version
  capabilities deliver interfaces, data and behavior without requiring a frontend;
  API/CLI/MCP and real-owner checks can establish that scope independently.
  Develop and accept UI separately; shared changes still cover affected consumers.
  Heavy plugin
  acceptance (independent package builds, frozen-Host harnesses, source parity,
  real-R fixtures, browser flows) runs once per milestone on settled source, after
  the preflight in `docs/DEVELOPMENT.md` § Milestone cadence. Harness failures are
  fixed and rerun for that stage; they are not status material. Keep acceptance
  runners tracked in `scripts/`, not as one-off files under `target/`. Incremental
  compilation does not limit `cargo test --workspace` to changed crates; that
  command still executes every workspace test target.
- Before heavy acceptance, fix the required cases, layouts, prerequisites and
  completion condition; follow `docs/DEVELOPMENT.md` § Acceptance execution and
  closure. Make independent flows selectable and able to prepare their own data.
  Before each rerun, identify the failure, changed inputs, invalidated evidence
  and smallest affected stage. A targeted pass does not automatically require
  another full run; shared-boundary changes must still cover affected consumers.
- Keep closure scope fixed. Non-blocking performance work and new coverage ideas
  wait for a separate task. Add a check during closure only for a missing required
  condition or a concrete unresolved risk; explain why existing evidence is
  insufficient. Once required checks pass, inspect the diff and commit.
- Iterate in the workspace with incremental builds. Independent packaging proves
  the distribution boundary at a milestone; do not repeat it for each internal
  module or commit. Agent acceptance requires explicit `--build` or `--package`;
  reuse the retained package/receipt for subsequent stages. A stale receipt calls
  for a new milestone build, not an automatic rebuild during iteration.
- If a build or test waits before doing useful work, distinguish compilation,
  executable startup and test-body time. Inspect the existing process/log once;
  do not launch a second build, clear caches, or restart the Host to mask an
  environment problem. Retain incomplete evidence and continue independent work.
- A timed-out, ignored, skipped, or unavailable check is not a pass. Report the
  exact command and status separately, retain evidence, and do not hide a timeout
  behind a narrower rerun. An incomplete optional workspace audit does not block
  normal completion when the affected checks have passed.
- Rust changes: use `cargo test -p <crate> <filter> --locked` while iterating.
- Contract DTO or generator changes: run `npm run generate --prefix ui` before
  the client checks. Client changes: run `npm run build --prefix ui`, then
  `npm run check --prefix ui`; ordinary client edits do not require type generation.
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
- The native R adapter uses `vendor/jet-core`. Maintain it through the ordered
  patches in `patches/jet`; run `node scripts/vendor-jet.mjs check` after edits.
  Preserve upstream notices and the pinned-source/update workflow in its README.
- Rust contracts generate TypeScript DTOs through ts-rs. Keep generated bindings
  and embedded assets current; use the shared Host ports.
- Studio starts in `ui/src/app.ts`; tokens live in `ui/src/style.css`.
  `crates/workbench/assets/` is generated. The entry mounts generic plugin windows;
  scientific views and document models belong to ordinary plugins through the
  public SDK. Preserve document state across layout changes.
- Product-authored UI uses English. Preserve Unicode user content and native output.
- Skills use standard `.agents/skills` sources and explicit host-provided references.
  Validate each source root and package/resource symlink containment; project links
  cannot expand the project read scope. Do not scan other products' private catalogs.
- Windows GNU Rust commands require Rtools45 at the front of PATH.

## Parallel work and distribution

Use the primary checkout on `main` for routine work. Temporary worktrees are for
genuinely independent work; integrate their changes and remove them when finished.
Register them with `scripts/dev-lanes.mjs`: `start --id NAME --own 'path/**'`,
`check --id NAME --changed-auto`, and `finish --id NAME`.
Keep real workbench runs in the primary checkout.
Before leaving unfinished repository changes to switch to unrelated work, preserve
those changes in a clearly named WIP commit. Answering a question during ongoing
work is not a task switch.

Distribution requires an explicit task and a verified packaging path. Report exact
commit, artifacts, sizes, hashes and executed checks. Build, signing, installation
and publication are separate outcomes; do not install or publish automatically.
Use `docs/RELEASE.md` for the current operator map.

## Session handoff

When a task changes the repository, commit coherent authorized work and check
`git status` before ending. Update `docs/STATUS.md` only when current behavior,
verification conclusions, focus, or unresolved work changes; include relevant
checks and restart guidance where useful. Do not add a status entry merely to
record a completed edit or read-only review. Keep transient process details out.
Update Status at milestone boundaries, not per commit; keep it under about 300
lines and fold verification-only commits into the change they verify.
The next session should read that page and inspect the live processes before
starting another Host for the same project.
