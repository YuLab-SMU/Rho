# Rho Development Roadmap

Status: active

Date: 2026-08-09
Current source baseline: `0.4.0-dev.26`
Active published identity: `0.4.0-dev.24` (authoritative candidate,
owner-installed acceptance, MAC5 GO, protected public prerelease, and live
development update manifest pass)
Implemented successor correction: Issue #9 `TASK-RAIL-SEMANTICS-1` separates
mode shape, status color, and risk ownership. It advances the user-visible
source identity rather than relabelling the historical `dev.23` source.
Active successor stream: Issue #5 Agent Conversation concurrency is governed
by `plans/active-2026-08-09-agent-conversation-concurrency-spec.md`. CONV-1
through CONV-3 reached their source checkpoints on 2026-08-09, including
bounded two-Conversation Act admission, per-path file scheduling and recovery,
exact Retry/Delete, and project-transition ordering. Upstream integration and
replacement two-platform candidate run `31337666426` pass; owner-installed
acceptance and Issue closure remain open.

Progress: Waves 1-14 implementation code is present in the current source
baseline. BH1-BH5, RA-RC1, WB1, WB2, UX4, RA-RC2, WS2 (Air backend selected),
WS3 (sortable viewer), WS9 (lintr diagnostics), WS4 (git via CLI),
WS6 (async Quarto job), and WS6A (targets inspection) all have committed
implementations. The `0.2.0-dev.12` release checklist and About/update
acceptance remain in progress.

The four scoped `0.3.x` implementation packages have also landed: reviewed
environment operations, bounded data viewers, artifact export/provenance, and
bounded project skills. The `0.3.x` milestone remains active because its
representative-project reproducibility workflow and manual UI review have not
yet been accepted. The final cross-package automated suite passed on 2026-07-26
and is recorded in `verification/0.3x-milestone/verification.md`.

Note: the implementation sprint of 2026-08-01 delivered Waves 4-14 in a single
branch, deviating from the "one wave at a time" governance rule. The code is
committed; per-wave verification and manual acceptance evidence are still
required for each wave's exit gate.

## Direction

The next objective is not another architecture spike. It is a reliable
Windows daily-use slice in which a scientist can open a real R project, run
code, inspect objects and plots, ask the Agent for help, review proposed
changes and recover from ordinary errors without losing the Workspace R state.

The two-session architecture remains the boundary:

- Workspace R is the only authority for live scientific objects and project
  execution.
- Agent R runs `aisdk`, model calls and orchestration.
- Rust broker owns transport, revisions, approvals, persistence and process
  lifecycle.
- The Tauri frontend consumes broker/workbench events and does not talk to Ark
  or `aisdk` directly.

No aisdk family change is required for the next milestone. We will continue
with the Rho adapter shims until a missing upstream seam is demonstrated by a
concrete workflow and covered by an isolated compatibility test.

## Milestones

### M1: Windows daily-use slice (`0.2.x`)

Priority: highest. This is the next development target.

Deliverables:

- Open a local project directory and display a real file tree.
- Edit and save multiple `.R` files; preserve the active document and cursor
  position across restarts.
- Replace the prototype textarea with a language-aware editor, completion and
  source/run selection commands.
- Keep Console, Plots, Problems, Environment and the resizable panel layout
  working with real project files.
- Add explicit user/agent/system execution origin, timestamps and run links.
- Add a real approval surface for Act-mode `run_r` and reviewed Agent file
  edits.
- Persist the Agent timeline and restore it after Agent R restarts while
  preserving the independent Workspace R session.
- Add user-facing cancellation, timeout, crash and restart states.

Completed in the current `0.2.x` candidate:

- native project selection and project-scoped session restoration;
- broker-safe file listing, reads, writes, new files and render paths;
- Monaco multi-document editing and selection/current-line/file execution;
- resizable Files, Agent, Environment, Console, Plots and Problems panels;
- durable runs, retry links, cancellation, restart recovery and plot provenance;
- Ask/Plan read-only enforcement and exact single-use Act approval for `run_r`;
- Environment diagnostics for R, libraries, `renv`, Bioconductor and rendering;
- bounded object previews and optional Quarto/R Markdown render diagnostics;
- atomic source/session persistence, coalesced file watching and bounded file
  discovery for large projects;
- bounded local R completion and simple document-symbol navigation.
- version/tag/resource validation, one-command source verification,
  machine-readable release evidence and pre-publication workflow gates;
- automated project regressions for spaces, non-ASCII paths and the 2,000-file
  discovery boundary.

Still required to release M1:

- clean-install acceptance on Unicode paths, paths with spaces and large projects;
- a repeatable manual acceptance record for the complete QC correction workflow;
- an explicit decision about unsigned internal versus signed public distribution.

Post-release `0.2.x` quality work:

- file rename/delete commands;
- paged plot-history payload loading and retention controls;
- package-aware completion, package-management workflows and an explicit policy
  for future shell-like tools.

Acceptance gate:

> A user can open a small single-cell R project, execute a QC script, inspect
> an object and plot, ask DeepSeek to explain an error, approve a correction,
> and restart either R process without losing the project or audit trail.

### M2: Scientific workflow foundation (`0.3.x`)

Priority: high after the M1 implementation and automated regression baseline
are stable. Remaining `0.2.0` installer/manual-publication acceptance may run
in parallel with `0.3.x` development, but it remains an independent release
gate and cannot be satisfied by `0.3.x` evidence.

Implementation contract:
[`plans/active-2026-07-25-0.3x-scientific-workflow-handoff.md`](../plans/active-2026-07-25-0.3x-scientific-workflow-handoff.md).

The `0.2.x` candidate already provides read-only `renv`/Bioconductor
diagnostics, bounded object previews, project-scoped plot history and basic
`.qmd`/`.Rmd` rendering. The `0.3.x` work extends those foundations; it must not
reimplement them as parallel subsystems.

Implementation status: WP1-WP4 are present in the current source baseline.
Focused package evidence exists, but the M2 acceptance gate below is still
open. Do not treat implementation presence as milestone or release acceptance.

Deliverables:

- reviewed `renv` status, initialize, restore and snapshot workflows with
  durable environment-operation evidence;
- Bioconductor/package drift diagnostics beyond the current version summary;
- paged bounded viewers for data frames and selected common bioinformatics
  objects;
- plot/render/table artifact export and provenance inspection building on the
  current plot history and render results;
- reproducibility evidence for existing Quarto `.qmd` and `.Rmd` rendering and
  structured Problems output;
- bounded project-scoped skills treated as untrusted Agent context, without an
  `aisdk.bioc` or default Bioconductor dependency.

Acceptance gate:

> A second user can reproduce a selected QC result from the project files,
> environment metadata, run record and generated artifacts without relying on
> chat text alone.

### M3: Cross-platform beta (`0.4.x`)

Priority: after the Windows contract is stable.

Active implementation contract:
[`plans/active-2026-08-05-macos-arm64-support-spec.md`](../plans/active-2026-08-05-macos-arm64-support-spec.md).
The project owner authorized the complete Apple Silicon direction on
2026-08-05. MAC1 and MAC2 implementation, macOS automated verification, and
the unsigned arm64 debug-app Ark/R runtime smoke are present. MAC3's Apple
Keychain adapter, native/UI parity, bounded bridge repairs, complete affected
automation, and isolated unsigned development-app workflow acceptance also
completed on 2026-08-05. Its two portability gates and WS1-L2 containment
conformance gate are closed. Windows CI, signed exact-candidate acceptance, and
release work remain open. MAC4's bounded candidate/update/signing/draft
workflow package was authorized, implemented, locally verified, versioned at
`0.4.0-dev.1`, and contract-reviewed on 2026-08-05. Its credentialed fork
rehearsal passed automation on 2026-08-06, but installed-app evidence rejected
the DMG because hardened-runtime library validation blocked official CRAN R.
The bounded `0.4.0-dev.2` entitlement repair and replacement fork rehearsal
passed. Upstream `main`, independently versioned through `0.4.0-dev.15`, is now
integrated without rewriting the macOS branch history; the combined source is
`0.4.0-dev.16`. MAC4-R3 asynchronous notarization orchestration is authorized
and locally implemented/verified. Its first two exact-commit fork rehearsals
failed closed on Apple's newly observed exact S3 log-delivery host and then a
missing fresh-finalizer `jsonlite` dependency; both bounded repairs are covered.
Replacement run `31163017077` at exact `0.4.0-dev.16` fork commit
`8de3dcc1dafc9e8562d239a6051a9113b778f1c3` passed the full Windows/macOS
review-only rehearsal, independent seven-file evidence validation, and zero-
publication audit while using 13 minutes 51 seconds of macOS runner time.
Upstream then advanced through `b5800ae`; ordinary merge `9d3086e` and its
complete affected local matrix passed. Post-merge exact-commit run
`31165265090` then passed the full review-only rehearsal and independent
seven-file audit while using 12 minutes 10 seconds of macOS runner time.
Issue #4's CRED-UX2 completion subsequently advanced the application baseline
to `0.4.0-dev.17`; its provider-card Model settings workflow was implemented
and passed the complete affected local matrix, deterministic browser review,
and unsigned arm64 app/DMG smoke on 2026-08-07. CRED-UX3 and CRED-UX4A then
advanced the live baseline to `0.4.0-dev.18` with bounded Provider discovery,
schema V2 capability routing, and the existing one-route/one-credential
Ask/Plan/Act boundary. The owner installed and rejected that exact DMG because
a failed settings read disabled the only Model settings entry. CRED-UX4A-R1 is
the authorized Provider-first recovery package: it advances the replacement
baseline to `0.4.0-dev.19`, keeps settings reachable and retryable, pins
explicit `aisdk.providers` adapters, exposes optional Base URL and default
capability cards/switches, and links Connections with Model routing. Its
complete affected automation, independent security/contract review,
deterministic browser review, and local unsigned arm64 replacement-DMG
verification pass. Owner-installed recovery plus live Provider/Keychain
acceptance remained open when Issue #6 superseded that candidate identity.
PROBLEMS-AGENT-REPAIR-2 advances the live baseline to `0.4.0-dev.20`: exact
Workspace R expression ranges are persisted by project in schema v10; Problems
binds the same failed run, traceback and source into a read-only tool-capable
Repair task; known ranges no longer require manual selection; and no-range
parse/history cases have an explicit user-selection fallback. The complete
affected Rust/R/frontend matrix, deterministic browser behavior review, and
exact local unsigned arm64 DMG verification pass; owner-installed acceptance
then rejected `dev.20`: the registered Agent runtime alias did not match the
canonical Act-route model, and the selected Data Viewer retained its previous
view token after Workspace R changed. PROBLEMS-AGENT-REPAIR-3,
CRED-UX4A-R2, and WS3-Q1-R1 advance the corrective baseline to
`0.4.0-dev.21`. Registered Provider sessions now keep one canonical routed
identity, while Environment re-inspects the selected object on revision change
and preserves compatible query/sort/page state under monotonic project-bound
guards. The complete affected automation, deterministic desktop/narrow browser
behavior matrix, and exact clean-source local unsigned arm64 artifact
verification pass; owner-installed/live-Provider acceptance remains open.
Owner workflow review then rejected `dev.21` because the just-failed Console
had no repair entry and required navigation to Problems. PROBLEMS-AGENT-
REPAIR-4 advances the baseline to `0.4.0-dev.22`: Console waits for and binds
the exact durable failed run, exposes the same repair/setup/selection action as
Problems, bounds refresh recovery, rejects duplicate dispatch, and permanently
disables an old action after project switch. The complete affected
Rust/R/frontend matrix, formatting, deterministic desktop/narrow browser
review, and exact local unsigned arm64 artifact verification pass;
owner workflow acceptance then rejected `dev.22` because an R parse error with
a parser-reported file position still required manual code selection.
PROBLEMS-AGENT-REPAIR-5 produced `0.4.0-dev.23`: the R bridge may admit only a
strictly bounded parser-owned `<text>:line:column:` coordinate that names an
actual submitted Unicode scalar, the coordinator translates it through the
admitted file range, and schema v11 durably distinguishes `r_parse_token` from
`r_expression`. EOF/ambiguous locations remain explicit-selection fallbacks;
implementation and complete affected automation/browser evidence pass. Before
an artifact was built, Issue #9 advanced the combined source to
`0.4.0-dev.24`: Task Rail status remains the sole status-color slot while
Ask/Plan/Act use independently labelled neutral shapes. Its affected frontend
and exact `1440 x 900` / `900 x 700` browser evidence pass; complete candidate
matrix, signing/notarization, and mounted-DMG smoke pass in fork rehearsal
`31294667960` and authoritative run `31295799312`. The immutable candidate, exact
owner-installed acceptance, bounded MAC5 GO evidence, and public-release
authorization pass. Protected publish run `31297205980` fails closed before
mutation because draft-by-tag lookup returns 404; the owner authorized a
release-only ID-based lookup repair. Correction `f30b1ae` and protected retry
`31297462728` pass without asset replacement; automatic update run
`31297482853` publishes and verifies the live `0.4.0-dev.24` manifest.
`rho.agent` advances independently to `0.1.5` for its canonical registered
runtime identity contract (after `0.1.4` introduced explicit provider adapters).
`rho.agent` `0.1.4` remains historical for its explicit provider-adapter
contract. `rho.bridge` independently advances through `0.1.12` for structured
expression ranges and to `0.1.13` for the bounded parser-token result.
CRED-UX4B/C workers and media consumers remain
unauthorized. The
`dev.18` and `dev.20` artifacts are rejected and cannot serve as acceptance
evidence. All
earlier runs and artifacts remain historical exact-source evidence and cannot
validate the replacement behavior. Exact `dev.24` owner acceptance and MAC5 GO
pass; broader milestone-native accessibility and future-platform acceptance
remain separately open. MAC4-R3 and MAC5 are complete for the published Apple
Silicon candidate, whose accepted assets remain immutable. This stream
delivers macOS arm64 first; macOS x64 and Linux x64 remain required before the
full M3 acceptance gate can close.

Deliverables:

- macOS arm64/x64 and Linux x64 process and packaging probes.
- One generated Workbench Protocol contract across Tauri and browser mode.
- Platform-specific R discovery, paths, signals, permissions and WebView
  behavior.
- Signed internal builds and a dependency/license manifest.
- Cross-platform fixtures for Unicode, paths with spaces, plots, HTML and
  large object summaries.

Acceptance gate:

> The same project workflow and protocol tests pass on Windows, macOS and
> Linux without platform-specific frontend behavior leaking into Workspace R
> semantics.

### M4: Advanced execution and reproducibility (`0.5.x`)

Priority: after local workflows are dependable.

Deliverables:

- Debugger/DAP integration where Ark and R support it.
- Long-running jobs with checkpoints and resource monitoring.
- Exportable run reports with code, environment, artifacts and approvals.
- Remote Workspace R, SSH and Slurm adapters behind the same broker contract.
- Optional containerized workspace backend.

Acceptance gate:

> Local and remote runs have the same execution/revision/provenance semantics,
> and disconnect/reconnect cannot duplicate a scientific execution.

## Implementation Program

This section is the authoritative cross-proposal implementation order. Local
phase or work-package numbering in a design document describes only that
document. It does not override this program or authorize product-code work.

Each wave has a mandatory evidence review before the next dependent wave. An
unfinished proposal remains `proposed` until one bounded package is explicitly
authorized under
[`active-development-governance.md`](active-development-governance.md). At that
point, create or activate a focused implementation handoff, record the entry
evidence and next stop point, and update
[`active-document-cross-review.md`](active-document-cross-review.md). Do not
activate a whole multi-package proposal at once.

Current program state: **Waves 1-14 implementation code is committed (2026-08-01).
Per-wave verification gates are pending for Waves 4-14.** Waves 1-3 (BH1-BH5,
RA-RC1) have prior acceptance evidence.

| Wave | Primary implementation or acceptance track | Permitted parallel track | Exit gate |
| --- | --- | --- | --- |
| 0 | Close the active `0.3.x` milestone | Complete the exact `0.2.0-dev.12` installed-app release acceptance and About/update live and installed acceptance as independent tracks | Each track has its own recorded automated, manual, installed-app, documentation, and release facts |
| 1 | BH1 canonical project identity and two-project isolation | UX1 contract/copy inventory and usability baseline; modernization Phase 1 visual tokens and component inventory only | BH1 isolation gate passes; parallel work makes no unsupported backend or navigation claim |
| 2 | BH3 transactional schema v8 migration, then BH2 project-switch state machine | UX1 may finish; no UI may promise switching, retention, or recovery behavior before its owning backend gate | Historical migration, rollback/failure injection, and atomic project-switch evidence pass |
| 3 | RA-RC1 deterministic run comparison | Behavior-neutral visual foundation work only | RA-RC1 is accepted at its mandatory review stop |
| 4 | UX2 first use, files, Run scope, and result handoff | Finish modernization Phase 1 without structural navigation changes | Novice task protocol and browser/Tauri parity pass |
| 5 | WB1 read-only public Workbench Protocol | Maintenance and accepted non-conflicting presentation work only | Versioned protocol, bounds, redaction, project isolation, and rejection behavior pass. **Implemented 2026-08-01.** |
| 6 | WB2 authenticated local CLI, MCP, and event replay | Begin cross-platform transport validation against the accepted protocol | Local authentication, compatibility, replay, redaction, and platform evidence pass. **Implemented 2026-08-01** (CLI + MCP + event replay). |
| 7 | RA-RC2, UX4 (Agent-first posture) — both selected | BH4 must precede any retention, prune, hide, or delete behavior | Each package is separately authorized, accepted, and stopped for review. **Implemented 2026-08-01** (RA-RC2 audit engine + UI, UX4 posture + task rail + Monitor/Review). Issue #9 Task Rail mode/status presentation correction was authorized as the separate D1/R1 `TASK-RAIL-SEMANTICS-1` package on 2026-08-08. |
| 8 | WS2 editor-intelligence checkpoint: Air selected as primary backend | Local Help contract refinement only | Air selected; bounded protocol, process, recovery, license and Windows evidence. **Implemented 2026-08-01.** |
| 9 | WS2 Air backend + WS9 `lintr` Problems integration | Behavior-neutral editor presentation work only | Completion/navigation/help and normalized diagnostics pass. **Implemented 2026-08-01** (Air completions + hover help + lintr). |
| 10 | WS3 TanStack Table interaction layer over the implemented bounded viewer | Accepted Artifact presentation work only | Server-owned paging/sort/filter/export limits remain authoritative. **Implemented 2026-08-01** (sortable columns + keyboard nav). |
| 11 | WS4 git read-only repository status, diff and history | No Git mutations or credentials | Repository identity, replacement, nested/worktree, bounds, redaction and two-project isolation gates. **Implemented 2026-08-01** (via git CLI); guarded review, adversarial hardening, and replacement fixtures verified through WS4-G1-G3 on 2026-08-03. |
| 12 | WS4 staging/commit mutations | Quarto local-job contract design may proceed without code | Exact diff/repository revision, dirty-worktree preservation, hook policy, rejection, failure and recovery evidence. **Implemented 2026-08-01.** |
| 13 | WS6 narrow local-job contract with Quarto as the first adapter | WS5 chunk discovery and source-linked diagnostic fixtures | Saved-input revision, environment, cancellation, restart reconciliation, bounded logs and Artifact provenance. **Implemented 2026-08-01** (async render_document_job). |
| 14 | WS6A read-only `targets` inspection | Package-development job design only after the Quarto job gate | `_targets` ownership is preserved. **Implemented 2026-08-01** (read-only inspection only; pipeline execution not yet authorized). |
| 15 | Issue #5 Agent Conversation concurrency, beginning with CONV-1 durable identity and switching | Immutable `0.4.0-dev.24` release evidence remains maintenance-only | Each CONV package stops for its own schema/admission/approval/resource evidence; no second Workspace R or cross-conversation authority is introduced. **CONV-1 through CONV-3 source checkpoints, replacement integration, and exact `dev.26` two-platform candidate run `31337666426` pass; the rejected `dev.25` evidence remains historical, while owner-installed acceptance and Issue closure remain open.** |

### Wave 0: Close Current Acceptance Work

Finish the representative-project `0.3.x` workflow, final cross-package suite,
manual UI review, and documentation/release reconciliation. The cross-package
suite, WP3 runtime DOM disposition, and current WP4 package checks passed on
2026-07-26; retain their evidence and rerun only when affected. Only integration
findings and repairs inside the accepted WP1-WP4 contract are permitted without
amendment.

The `0.2.0-dev.12` release checklist and About/update acceptance may proceed in
parallel because they have independent candidate and deployment authority.
Evidence from one track cannot close another track.

### Waves 1-2: Establish The Safe Baseline

BH1 was authorized on 2026-07-26 under
[`plans/active-2026-07-26-bh1-project-scoped-durable-identity-handoff.md`](../plans/active-2026-07-26-bh1-project-scoped-durable-identity-handoff.md).
BH1-A through BH1-C are accepted. The complete Rust workspace, affected R
suites, JavaScript syntax check, `git diff --check`, and current-source desktop
smoke passed. Independent review found no unresolved BH1-scope P0/P1 privacy,
ownership, execution, migration-boundary, or recovery issue, and the smoke now
records representative two-project switching/restart isolation; see
[`verification/bh1/verification.md`](../verification/bh1/verification.md).
BH3 was authorized on 2026-07-27 under
[`plans/active-2026-07-27-bh3-transactional-schema-v8-migration-handoff.md`](../plans/active-2026-07-27-bh3-transactional-schema-v8-migration-handoff.md).
Its scope was limited to transactional `v7 -> v8` migration, fail-closed
historical rejection, same-directory recoverable backup, and bounded migration
diagnostics; it did not authorize recovery UI or BH2 switching behavior. BH3
is now accepted on the evidence in
[`verification/bh3/verification.md`](../verification/bh3/verification.md). BH2
was authorized on 2026-07-28 under
[`plans/active-2026-07-28-bh2-project-switch-state-machine-handoff.md`](../plans/active-2026-07-28-bh2-project-switch-state-machine-handoff.md).
Its scope is limited to one broker-owned preflight result, blocked/synchronized/
committed/failed-restored outcomes, and deterministic switch recovery; it does
not authorize retention, recovery UI, or destructive blocker-clearing
behavior. The affected automated matrix and desktop smoke now pass on
current-source evidence, and BH2 closeout review found no unresolved P0/P1
switching, ownership, execution, blocker, or recovery finding; see
[`verification/bh2/verification.md`](../verification/bh2/verification.md).
BH4 was authorized on 2026-07-29 under
[`plans/active-2026-07-29-bh4-retention-privacy-artifact-lifecycle-handoff.md`](../plans/active-2026-07-29-bh4-retention-privacy-artifact-lifecycle-handoff.md).
Its scope is limited to project-scoped retention, truthful hide/prune/delete
semantics, artifact/plot lifecycle rules, tombstones or retained metadata for
removed payloads/files, and privacy-facing documentation/tests. BH4 closeout
review found no unresolved P0/P1 finding; see
[`verification/bh4/verification.md`](../verification/bh4/verification.md).
It does not authorize BH5 refactoring, recovery UI, or any later feature package.

BH5 was authorized on 2026-07-31 under
[`plans/active-2026-07-31-bh5-incremental-module-boundaries-handoff.md`](../plans/active-2026-07-31-bh5-incremental-module-boundaries-handoff.md).
Its scope is limited to behavior-neutral extraction of store and command modules
by durable domain (runs, Agent, Artifacts, environment, project/session). Each
extraction is a separate commit with its own regression evidence. It does not
change any test assertion, command signature, or frontend state key.

UX1 may run in parallel because it inventories language and defines testable
interaction contracts without claiming new behavior. Interface modernization
Phase 1 may establish tokens, icons, dimensions, focus treatment, and a
component inventory. Neither track may introduce structural Human/Agent
navigation or present unimplemented switching, retention, undo, or recovery.

After BH1-BH3, rerun affected `0.3.x` evidence because project ownership,
queries, migration, and switching are shared foundations.

### Waves 3-4: Deliver Evidence And Novice Workflow Value

RA-RC1 is the first new post-`0.3.x` capability. It remains a read-only derived
view over authoritative runs, snapshots, Problems, and Artifacts and stops for
review before RA-RC2.

After RA-RC1 acceptance, implement UX2 as a vertical novice workflow covering
first use, project files, exact Run scope, persistent results, and recovery.
Modernization Phase 1 may finish alongside UX2, but structural layout remains
blocked by the posture decision.

### Waves 5-6: Stabilize Local Interoperability

WB1 freezes the bounded, project-scoped, read-only semantic contract before a
transport is treated as public. WB2 then adds authenticated local CLI, MCP, and
replayable events without adding external execution. Cross-platform transport
validation begins only against these accepted boundaries.

WB3 is not part of Waves 5-6. External execution requires a separate security,
approval, credential, and admission decision after read-only interoperability
has demonstrated value.

### Wave 7 Selection

Authorize RA-RC2 after RA-RC1, then select only one of EW-CR1, UX3, UX4, or
UX5 for product implementation at a time.

EW-CR1 owns the first project-scoped scholarly evidence workspace and bounded
claim-review package. It is intentionally narrower than a general literature
platform: the core package may use only small-footprint permissive-license
utilities and open-data scholarly metadata providers, and it must not make a
commercial or heavyweight hosted service the sole dependency. EW-CR1 requires
accepted `0.3.x` artifact/environment provenance, BH1-BH3 project identity and
query isolation, and RA-RC1's first read-only internal evidence view so the new
external-evidence layer does not compete with unresolved internal evidence
semantics.

UX3 requires the relevant BH1-BH3 switching and history behavior. UX4 requires
an accepted posture implementation contract. UX5 requires accepted `0.3.x`
behavior and BH4 before any retention or deletion operation.

### Waves 8-10: Complete Daily Scientific Editing And Inspection

Wave 8 is a compatibility and contract checkpoint, not permission to ship both
Air and R `languageserver`. Monaco remains the editor. The checkpoint selects
one primary broker-managed language backend using representative base-R,
package and Bioconductor projects on Windows. Wave 9 integrates the selected
backend and then adds `lintr` as a separate optional producer normalized into
the existing Problems model. Neither service may become Workspace R, Agent R,
a second Problems store, or a direct file-mutation channel.

Wave 10 may use TanStack Table for frontend table interaction only after the
implemented viewer contract is accepted as the data authority. Server-side
paging, sorting, filtering, search, payload bounds, stale-object rejection and
export provenance remain Workspace/broker behavior.

### Waves 11-12: Add Reviewable Local Git

Wave 11 evaluates and integrates `gitoxide` for bounded read-only status, diff
and history. Wave 12 adds only separately reviewed staging and commit mutations
bound to exact repository and diff revisions. Credentialed network operations,
implicit hooks, destructive branch operations and remote mutation remain out
of scope until a later security contract.

### Waves 13-14: Establish Document And Pipeline Jobs

Wave 13 freezes a narrow broker-owned local-job contract with Quarto rendering
as its first adapter. It migrates the current synchronous render path without
creating a generic shell, a second runtime authority or a second Artifact
store. Wave 14 begins with read-only `targets` inspection and stops for review;
pipeline execution and composed `targets`-to-Quarto production require a
second authorization inside the wave.

`targets` continues to own `_targets` metadata. Rho owns admission, project and
environment revisions, durable job state, cancellation/restart reconciliation
and links to declared file Artifacts. Pipeline workers are broker-managed
noninteractive R processes, not additional interactive Workspace R sessions.

Posture phases, structural modernization, remote execution, debugging, WB3,
and public remote control remain later separately reviewed streams. Waves 8-14
schedule local editor, viewer, Git, Quarto job and `targets` work but do not
authorize any package; each still requires a focused active handoff.

### Concurrency And Stop Rules

- Keep no more than one new post-`0.3.x` product-capability stream in
  implementation at a time. Acceptance/release tracks and behavior-neutral
  design-system work may run in parallel when their evidence and ownership are
  independent.
- A parallel track must not consume an unaccepted schema, protocol, navigation,
  approval, switching, or retention behavior from another track.
- Stop at every wave exit and package-specific review point. Reconcile tests,
  manual evidence, version/NEWS impact, document lifecycle, remaining debt, and
  worktree state before authorizing dependent work.
- If evidence invalidates an entry condition, return the affected package to
  review; do not silently reorder the program or infer acceptance.
- Emergency repair remains governed by the exception rules in
  `active-development-governance.md` and does not authorize adjacent roadmap
  scope.

## Explicitly deferred

- Python, Jupyter Server and JupyterLab dependencies.
- Electron or a second production frontend shell.
- A second authoritative Workspace R session.
- Broad aisdk family refactors without a demonstrated Rho use case.
- `aisdk.bioc` and semantic-adapter integration during `0.3.x`.
- Remote/cloud multi-user collaboration before local provenance is reliable.
- Installer signing and auto-update until the product surface and release
  identity are stable.

## Decision checkpoints

Every milestone should end with a short evidence review:

- Which user workflow is now demonstrably complete?
- Which state transitions and failure paths have tests?
- Does the change preserve Workspace R authority and revision checks?
- Does it introduce a real aisdk family gap, or can the Rho adapter remain
  local?
- Is the result ready for the next internal user, or only for another spike?
