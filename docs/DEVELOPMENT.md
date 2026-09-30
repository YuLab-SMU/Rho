# Developing Rho

Read [current focus](STATUS.md) and the relevant [architecture](ARCHITECTURE.md).
For Studio interaction work, also read [design principles](RHO-DESIGN.md) and
[user feedback](STUDIO-FEEDBACK.md). A proposed design is not implemented behavior.

## Working loop

1. Inspect `git status`, the relevant code and existing tests; preserve unrelated work.
2. Run `node scripts/governance.mjs impact --changed-auto` for scoped L0/L1
   suggestions. Select the nearest useful check rather than running the list.
3. Make a coherent change and iterate with the closest meaningful check.
4. Once behavior settles, run affected checks, inspect the diff and record actual
   results. Compare a failing test with the pre-change baseline before attributing it.
5. Update current documentation where it explains behavior or constraints. Keep
   detailed task plans with the issue/branch and run artifacts with the run.

Cargo commands share `target/`. Run only one Cargo build/test/check process at a
time, including client type generation, which invokes Cargo. Wait for background
commands to complete instead of polling them with sleep loops.

### Milestone cadence

Organize work as end-to-end user flows (the milestone table in
[Status](STATUS.md#work-order-reset-2026-09-28)). Within a milestone:

- **Build the thinnest complete flow first**, including its real view, before
  deepening any one layer. Missing infrastructure should surface from the flow, not
  from a later integration pass.
- **Iterate with L0/L1 only.** Independent package builds, frozen-Host harnesses,
  source-parity inventories, real-R fixtures and browser flows (plugin L2) run
  **once per milestone** on settled source, and again only when a later change
  touches the same boundary. Do not run them per commit.
- **Preflight before any L2 run:** correct toolchain for independent directories
  (`agentPluginBuildEnvironment()` and equivalents), generated manifests/SDKs
  current (`--check`), fixture counts and capability names updated in the same
  change, browser fixtures waiting on explicit Ready/paint. A harness failure is
  fixed and rerun for that stage only; it is not a product failure and is not
  recorded in Status.
  Fault injection must target the actual edge: launcher calls use `/api/host`,
  while iframe actions use `/api/plugin-view` and `message.body`. A transport loss
  retires the frame; reload/reconnect before inspecting its saved original request.
  A correlated error reply keeps the frame connected. Test those outcomes distinctly.
- **Use tracked harnesses.** Acceptance runners belong in `scripts/` and in the
  governance map, not as one-off files under `target/`. Extend an existing runner
  (for example `scripts/test-agent-plugin.mjs`) instead of copying it per feature.
- **Delete as you go.** When a milestone's flow passes, remove the fixed-composition
  path it replaces in the same milestone, or record the exact deletion condition
  in the Status table.

The impact tool defaults to `--phase iteration` (L0/L1). It filters checks by
their source scopes, so an Agent edit does not list unrelated plugin suites.
`--phase milestone` adds affected L2 candidates; `--phase audit` also exposes L3.
These are suggestions, never an automatic queue. A deferred check is not passed.
New check registrations must declare a tier; use explicit `sources` where a
documentation area covers more than one component. Check commands do not run as
part of impact analysis.

For Agent milestone acceptance, choose the build once and reuse its exact package:

```sh
node scripts/test-agent-plugin.mjs --build --evidence target/agent-acceptance.json
# Use the external path printed above or recorded in the evidence file.
node scripts/test-agent-core-tools.mjs --package /absolute/retained/package
```

`--build` retains the external package and adjacent `.build.json` receipt even if
a later test stage fails. `--package` (or `RHO_AGENT_PLUGIN_PACKAGE`) verifies the
current input-source digest and the entire retained package before starting Cargo.
It never silently rebuilds a stale or modified package. Documentation outside the
package does not invalidate it. This receipt proves artifact reuse, not that a
test passed; subsequent tests still run. Use `--skip-framed` only with a passing
framed result that covers the current source. Real-R reuse also requires
`RHO_R_PLUGIN_PACKAGE`; a fresh R package is built only in explicit `--build` mode.
Keep retained packages through milestone acceptance and remove them when their
evidence is no longer needed. Older packages without receipts are not adopted.

For Agent integration during development, run
`node scripts/build-agent-plugin.mjs /new/package` once, then pass
that package to the same `--package` runners. This builds the native backend in
the primary workspace cache and assembles the same source/UI package. The receipt
and acceptance output identify `workspace` versus `independent` builds; workspace
framed checks also stay in the primary checkout. This verifies integration, not
independent-source compilation. Add `--independent` only when that separate
acceptance is due. `--workspace` remains an explicit spelling of the default.
Neither mode weakens package validation or source containment.
Mapped Agent integration checks expect `RHO_AGENT_PLUGIN_PACKAGE` to identify the
retained package; they no longer suggest an independent rebuild at every stage.

The scientific-window integration runner also reuses explicit native packages:
`node scripts/test-scientific-workspace.mjs --packages /absolute/packages.json`,
with `RHO_ARK` and `RHO_R_HOME` selecting an existing disposable-test runtime.
The JSON object maps `r`, `files` and `editor` to absolute built package directories;
optional Console/Objects/Plots/Viewer/Packages/Help paths reuse unchanged UI builds.
Optional `process`, `remote`, `environment`, `annotations`, `agent` and `studio`
paths exercise the expanded recipe. For the actual default delivery, use
`--set /absolute/plugin-set` instead: the fixture validates and imports the sixteen
archives into its disposable catalog and builds nothing, including Manager.
It exercises initial installation through the same repository, exact preparation,
lost first-provider activation/reload recovery, real R, Agent's unchecked tools and
the Studio tab. Full-set acceptance also holds one real R operation at a bounded
file gate while switching to a Manager-only scene and back, closing and reopening
Console/Editor, and retaining their unsent/unsaved drafts. The fixture releases
its own gate even on failure, then checks the original provider/session, exactly
one file effect, unchanged source file and browser reload without replay. Scenario
checkpoints/application and reopening use public Host ports; browser clicks cover
script submission, editing and cooperative closure. `RHO_SCIENTIFIC_EVIDENCE` selects a successful-run JSON report;
Playwright retains failure traces. This is composition acceptance, not a replacement
for individual Agent tool, remote cluster or Environment operation checks.
In `--packages` mode, the runner builds only missing UI packages and the current Manager. Both modes open a fresh plugin-only Host and
drives default Workbench startup → project selection → installed Manager view →
scenario preparation/switch → Files → Editor Save and Run →
Console/Objects/Plots → browser reload. It does not run Cargo or install software.
For Files iteration, `node scripts/build-files-plugin.mjs /new/package`
builds the current backend in the primary Cargo workspace and packages that artifact
with its source and UI. It is integration evidence; add `--independent` only when
independent-source build acceptance is actually due. Keep Cargo invocations serial.
Editor uses the same default: `node scripts/build-editor-plugin.mjs /new/package`
builds its backend in the primary workspace, then exports the context contract and
builds its UI into a full source package. Use `--independent` for standalone-source
acceptance. Its internal `--reuse-native` assembly flag is used only after the
workspace builder succeeds; it is not independent-build evidence.

R uses the same cadence: `node scripts/build-r-plugin.mjs /new/package`
builds once through the primary cache and records an adjacent source/artifact receipt.
Run `node scripts/test-r-plugin.mjs --package /absolute/retained/package` for the
native Host stage. The Help, Viewer, Console, Objects, Plots and Packages browser runners require
`RHO_R_PLUGIN_PACKAGE` and verify that receipt; they never compile another R package.
The native runner's explicit `--build` remains available for independent acceptance.
Reuse rejects stale sources or modified package bytes and retains packages after
later-stage failures. `node scripts/test-r-workflow.mjs` checks this without Cargo.
`node scripts/test-plugin-build-modes.mjs` observes the actual Agent/R/Files/Editor/Process/Remote/Environment build
entry points with sentinel tools: default workspace dispatch, explicit independent
dispatch and invalid-option refusal, without compiling anything.

`npm run test:browser --prefix ui -- plugin-startup.spec.ts` covers default
project selection, constrained startup layouts and an empty repository remaining
empty across reload. `ui/tests/plugin-launcher.test.ts` covers original-request
retention and receipt recovery. The default startup selector only opens standalone
UI contributions; richer configuration, native activation and scenarios belong to
ordinary plugins. Fixed browser fixtures and private scientific HTTP endpoints
are retired. Workbench serves only the generic plugin profile; `--fixed-workspace`
is removed. `test-workbench.mjs` tests generic HTTP/MCP/connected CLI and empty
scenario checkpoints. Scientific behavior uses the ordinary-plugin suites.

For frontend-only startup/scientific-window iteration, build the client and set
`RHO_WORKBENCH_DEV_ASSETS` to the absolute `crates/workbench/assets` directory.
Those two fixtures use the existing Host's `--dev-assets` option, so a label/layout
fix does not need a new native binary. Record this as current-client integration
with a retained Host; it does not verify new Host capabilities or updated embedded
assets. Omit the variable for embedded-artifact acceptance. Preserve each settled
run's browser evidence before another run replaces `target/studio-browser`, or
pass Playwright a dedicated `--output` directory.

For ordinary Agent UI iteration, `node scripts/test-agent-view.mjs --build-ui`
checks native/Rho task, draft and settings models and builds just the UI from public SDK copies. It uses
the already installed client dependencies and never invokes Cargo. Add `--browser`
when the interaction settles to check the production UI in an opaque iframe with
a synthetic public MessagePort peer. Reload creates a new document/connection,
including original key/configuration/removal receipt recovery without automatic
model tests. Rho creation/Send recovery, missing keys, next-draft isolation and
retained history run through the same opaque iframe. Settings and rename buttons work without `allow-forms`; screenshots
cover 960/440/320/220 px, with the narrow settings panel scrolled to its diagnostics.
Rho followup input inspection uses the saved per-Send history after reload; 440/220 px
captures check its original questions/answers without fresh source queries. This
renderer fixture is synthetic. The `rho_conversation_history` metadata case checks
actual Rig input and unchanged original retries; store `native_history` cases cover
Unicode/JSON byte limits, conversation scope and unread event tails. Run those native
checks serially with the other affected Agent checks before claiming backend acceptance.
That fixture does not replace real combined
Agent/Host acceptance; native manifest changes still require the serial exporter
and backend checks before snapshotting the package.

`Check tool outcomes` invokes `agent.model.run.reconcile` explicitly, retaining its
original request before dispatch. The renderer covers a lost reply, reload without
repeating the inspection, preserved next draft and an uncertain report at 440/220 px.
The native `rho_recovery_reports_original_native_outcomes` fixture checks original
parent correlation, live-wait refusal, pending/uncertain outcomes and changed callers;
store `native_recovery_report` checks controller/version fencing and reopen. These
must pass on the current backend separately. A recovery report does not itself start
Continue or establish actual Host restart acceptance.

`Continue task` sends the current saved draft with a selected checked run. The
renderer covers unchanged original targets, refusal of unresolved reports, typing
during admission reads, and lost continuation replies followed by immediate next
input and reload. A next draft waits for observation of the original Send's atomic
draft consumption; saving its old version is not retried as new work. Sent context
shows the retained continuation report, input and source snapshots without queries
to the original source. Screenshots cover 960/440/220 px.
The metadata `rho_continuation_rechecks_original` case exercises fresh recovery
observations and Rig asking for the same confirmed R mutation: only reads of the
original native Operation are accepted, never a second `r.execute`. Store
`native_continuation_retains_exact_provider` checks exact artifact/session retention,
stale reports and previous-result receipts. These checks must run separately before
native or real-R acceptance can be claimed; the browser's peer is synthetic.

Once the combined package is current, run the existing real-R runner with
`--browser --package /absolute/retained/package` and explicit `RHO_R_PLUGIN_PACKAGE`,
`RHO_EDITOR_PLUGIN_PACKAGE`, `RHO_FILES_PLUGIN_PACKAGE`, `RHO_ARK` and `RHO_R_HOME`. This mode never invokes Cargo: `agent-workspace.spec.ts`
uses the current Host, retained ordinary Agent/R/Editor/Files packages and local
ACP and streaming-model peers. It checks browser attachment capture, lost import receipts, a real Editor
context preview, one original Send, real R work and reload during that work.
The public document owner is seeded with a synchronized Editor capture; the real
Editor backend resolves it. The peer verifies the actual source bytes in native
input; changing that source and restarting Host must leave the original readable
without resuming Editor. The same view also creates a Rho task, saves a disposable
model credential, sends actual Editor input through Rig, retains ordinary followup
history, and explicitly continues the original checked task. Lost first/Continue
replies preserve one request each and the next draft. After Host restart, the same
task and original input must remain readable with Editor still suspended and no
additional model request. This Rho path is read-only; scientific R execution in
this fixture belongs to the native task. Test discovery and the model peer's local
protocol probe alone do not pass this combined acceptance.
This does not test editing through the Editor UI. It also pages a long native observation history,
keeps its earlier reading position through background refreshes and returns to
the latest messages without another Send. After the turn settles it restarts the
disposable Host against the same storage, restores the original instance/view
through a lost resume reply, and explicitly resumes the same native Agent session.
It checks the original result, attachments and unsent draft without another prompt
or R execution. Manager then restores the original viewless R backend through a
lost reply and confirms that its R session stays unstarted. This does not cover abrupt process failure or external-model
quality. A listed/written browser case is not a passing native result.

The ordinary Agent's `component_request` view configuration accepts a bounded
`{request_id, title, sources}` input. Each source uses the existing
`AgentContextSelection` contract with `source: "plugin"`, a label, an exact
`ContextReference` and its JSON-encoded inclusion. The source window must match
this Agent view. It supplies context only; task choice, draft insertion and Send
remain separate user actions. The Native/Rho receiver checks source availability,
deduplicates exact references/inclusions and retains a one-time insertion receipt.
Model and renderer checks cover stale/partial sources, typing during preview,
changed task selection and lost draft replies. `agent-workspace.spec.ts` supplies
an actual synchronized Editor reference through view configuration, then checks
preview, insertion, Send and restart retention through the real owners. It does
not establish every component sender. `editor-agent.spec.ts` separately drives
Editor **Ask about…** → select an active Agent instance → open its ordinary view →
choose an editable task → add the exact synchronized document/selection. It covers
a lost view-open reply, reload and original-request inspection without another
view or Send. Supply retained `RHO_EDITOR_PLUGIN_PACKAGE`, `RHO_AGENT_PLUGIN_PACKAGE`
and `RHO_FILES_PLUGIN_PACKAGE` paths; the new case refuses missing package inputs.
Existing Agent views are not silently taken over, and other component senders still
need their own integration.
`component-agent.spec.ts` drives the Help and Viewer sender buttons through a
real disposable Host/R session and the ordinary Agent receiver. Supply retained
`RHO_R_PLUGIN_PACKAGE`, `RHO_AGENT_PLUGIN_PACKAGE`, `RHO_HELP_PLUGIN_PACKAGE` and
`RHO_VIEWER_PLUGIN_PACKAGE`, plus existing `RHO_ARK` and `RHO_R_HOME`; it compiles
nothing. Help sends the exact observed installed topic; Viewer retains the
original HTML even when a newer output arrives. The case checks draft insertion,
reload and a lost open reply without Agent Send. Shared sender recovery checks run
with `node scripts/test-viewer-plugin.mjs`; Help source/serial-state checks run with
`node scripts/test-help-plugin.mjs`. These do not replace other component acceptance.

For a Rho tool-selection change, use the smaller real-R browser case:
`npm run test:browser --prefix ui -- agent-rho-tools.spec.ts`, with retained
`RHO_AGENT_PLUGIN_PACKAGE`, `RHO_R_PLUGIN_PACKAGE`, `RHO_ARK` and `RHO_R_HOME`.
It reuses the current generic Host and invokes no Cargo or package build. The
ordinary view selects an exact R binding; the real Rig driver calls that R plugin
under the original Send. A local streaming model peer checks the real tool result.
The case covers lost Send acknowledgement, reload without replay, original tool
inspection and Continue after deselecting the next-turn tool. It also checks menu
bounds while resizing through 1440/390/220 px. External-model quality and Host
restart are separate acceptance scopes. Workspace-built package receipts remain
mandatory; do not silently rebuild dependencies inside a browser test.

Browser acceptance uses the locked Node 22 type declarations in `ui`. Check the
Agent fixture and its imported helpers without invoking Cargo from the repository
root:

```sh
node ui/node_modules/typescript/bin/tsc --noEmit --target es2023 \
  --module esnext --moduleResolution bundler --skipLibCheck --allowJs \
  --types node --typeRoots ui/node_modules/@types \
  ui/e2e/agent-workspace.spec.ts ui/e2e/agent-rho-tools.spec.ts
```

This checks fixture types only; run the browser case with its retained packages
for actual Host acceptance. `npm run typecheck --prefix ui` covers product code.

### Status discipline

`docs/STATUS.md` stays under about 300 lines. Update it at milestone boundaries or
when current behavior, open problems or restart guidance change — not per commit.
Record the current evidence file for a milestone, not every versioned attempt;
failed attempts, compile errors and harness corrections stay in logs and Git.
Commits that only record a verification result are folded into the change they
verify.

## Client composition

The browser entry renders only the generic plugin workspace or an explicitly
selected contributed view. The fixed Studio container, builtin panel registry,
scientific/Agent panels, private browser transport helpers and their dedicated
styles and tests have been deleted. Their replacement checks live with the ordinary
plugins and the integrated scientific/Agent browser suites. The retained core UI
checks cover transport, framing, layout, startup, closing and recovery.

Private Agent/annotation/HTML HTTP routes and Workbench-owned service construction
have also been removed, as have R discovery/settings and the large resident
application-bridge HTTP endpoint. Workbench startup no longer accepts a fixed
Host profile or calls default-R continuation; its CLI escape flag is removed.
CLI writer/server entries now also use the generic plugin Host. Scientific startup
flags, R invocation shortcuts and method-binding commands are removed. HostProfile
now contains only the database path; there is no runtime selector or deferred-R
startup path. Standalone observation reads the journal without constructing Files
or native output owners. Fixed scientific Host constructors, native scientific registration, runtime-instance
management and Host Application/Skill adapters are removed. Obsolete contract DTOs,
Application storage types remain for the next cleanup; the eleven unused fixed
owner/adapter crates and their dedicated tests have been deleted. Missing plugins cannot select a fixed Workbench fallback. Historical
fixed-renderer test totals do not count as current plugin acceptance.

## Testing SOP

Annotation ownership checks reuse the workspace: `cargo test -p rho-annotation-store
--test annotations --locked` covers immutable evidence, revisions, idempotency,
separate-connection races, scope isolation and transactional budgets. Fixed
Application/SQLite bridge and private HTTP tests were retired with those paths; `node scripts/test-annotation-plugin.mjs`
checks the ordinary native owner through a real generic Host. Run Cargo serially.
`cargo test -p rho-annotation-backend --lib --locked` exercises the actual framed
native entry with deterministic public context peers, receipts and reopen; it is
not real Host/Editor/R acceptance. Changed source identities also require the
focused Editor and R context checks. `node scripts/test-annotation-plugin-store.mjs
--source-check` validates the actual assembled package's six-crate public closure
without compilation. Reserve `--independent` for an owner/store source audit.
`node scripts/build-annotation-plugin.mjs /new/path` defaults to the workspace cache;
only an explicit `--independent` rebuilds standalone source. Native tests, package
assembly, real-provider/Host acceptance and UI review are separate outcomes.
`node scripts/test-annotation-plugin.mjs --files` uses retained Annotation,
Editor and Files packages and the frozen Host for Files quote freezing, native
identity/content-version separation and same-instance restart without source replay.
For **Files → Agent** acceptance, `node scripts/test-files-agent.mjs` reuses
`RHO_FILES_PLUGIN_PACKAGE` and `RHO_AGENT_PLUGIN_PACKAGE` with the frozen Host.
It builds nothing. A disposable Unicode text file supplies the exact native
identity and digest. Browser Ask → text preview → draft/reload → Rho Send reaches
one deterministic local model request. Changed source/path escape is refused;
actual Host restart retains the original run text without replay. Set
`RHO_FILES_AGENT_EVIDENCE` to retain the report and normal/constrained screenshots.
Native Files Send and real-model reasoning remain separate coverage.
For **Packages → Agent** acceptance, `node scripts/test-packages-agent.mjs` reuses
`RHO_R_PLUGIN_PACKAGE`, `RHO_AGENT_PLUGIN_PACKAGE`, `RHO_PACKAGES_PLUGIN_PACKAGE`
and existing `RHO_ARK` / `RHO_R_HOME`, without building or installing anything.
A disposable real R session supplies the selected installed `splines` copy. Browser
Ask → draft/reload → explicit Rho Send reaches a deterministic local model peer.
Loaded-package observations before/after verify that viewing did not load the
package; changed libraries are refused. After actual Host restart, the original
Send survives and the old native observation cannot start R. Set
`RHO_PACKAGES_AGENT_EVIDENCE` for reports/screenshots; Native Send and model
reasoning quality are separate coverage.
For **Console → Agent** acceptance, `node scripts/test-console-agent.mjs` reuses
`RHO_R_PLUGIN_PACKAGE`, `RHO_AGENT_PLUGIN_PACKAGE`, `RHO_CONSOLE_PLUGIN_PACKAGE`
and existing `RHO_ARK` / `RHO_R_HOME`. It builds nothing. A disposable real R
execution goes through Run Details → Ask → Agent draft/reload → explicit Rho
Send to a local deterministic model peer, then actual Host restart. It also checks
original transcript identity/digest refusal, bounded search and code-only inclusion.
Set `RHO_CONSOLE_AGENT_EVIDENCE` for reports/screenshots. Native Send, quoted
subranges, live incomplete runs and model reasoning quality are separate coverage.
For **Plots → Agent** acceptance, `node scripts/test-plots-agent.mjs` reuses
`RHO_R_PLUGIN_PACKAGE`, `RHO_AGENT_PLUGIN_PACKAGE` and `RHO_PLOTS_PLUGIN_PACKAGE`,
plus existing `RHO_ARK` / `RHO_R_HOME`. It builds nothing and uses a disposable
Host, two real R outputs and local deterministic Rig/ACP peers. The browser
selects originals, previews images or metadata, adds the pair to a draft and sends
explicitly. Image diagnostics, digest-preserving delivery, text-only follow-up and
same-instance Host restart are covered together. Sent-context buttons read the
original image and producing run through public queries; screenshots cover
1440/960/390/220 widths. Native API Send separately checks exact image bytes,
retained context, scoped preview tools and original-request retries before/after
restart while R is suspended. This does not establish Native browser Send coverage.
Set `RHO_PLOTS_AGENT_EVIDENCE`
for the report and screenshot paths. This does not measure model reasoning quality.
For **Objects → Agent** acceptance, `node scripts/test-object-agent.mjs` reuses
`RHO_R_PLUGIN_PACKAGE`, `RHO_AGENT_PLUGIN_PACKAGE` and `RHO_OBJECTS_PLUGIN_PACKAGE`,
plus existing `RHO_ARK` / `RHO_R_HOME`. It checks build receipts before starting a
disposable Host; it never builds or restarts a user session. The browser previews
one exact object handle, opens a selected Agent, adds to its draft and explicitly
sends to a local deterministic model peer through the real driver. Source changes,
nested paths, original Send retention and actual Host restart share this fixture.
Set `RHO_OBJECT_AGENT_EVIDENCE` to retain its JSON report and screenshot paths.
The inclusion is bounded native metadata/recognition samples, not the whole object.

For settled text-flow acceptance, `node scripts/test-annotation-plugin.mjs` reuses
`RHO_ANNOTATION_PLUGIN_PACKAGE`, `RHO_EDITOR_PLUGIN_PACKAGE` and
`RHO_FILES_PLUGIN_PACKAGE` against a frozen `RHO_TEST_BINARY` (default `target/debug/rho`).
It refuses stale annotation/Editor source, snapshots into a disposable database,
checks historical context and restarts only its own Host. `RHO_ANNOTATION_EVIDENCE`
selects the retained report. It never triggers compilation or independent builds.
Add `--agent` and a current `RHO_AGENT_PLUGIN_PACKAGE` for exact contributed note
context through real Agent/Rig Send and recovery while its provider stays suspended.
The same run checks Native Agent read-only refusal, create/update/CAS, exact child
Operations and retained Send/tool records after restart with the source suspended.
The HTTP model and external ACP peers are local fixtures, not third-party model acceptance.
Add `--browser` with `--agent` for the existing ordinary picker and retained draft;
inspect its screenshots separately before claiming visual quality. This does not
cover annotation editor UI or abrupt-crash recovery.
Add `--captures` for a Python-only public resource producer, actual PNG decode/import,
Editor-bound captured evidence and marks, bounded byte readback, damaged-image refusal
and replay after same-instance restart while that producer remains suspended. This
can run without `--agent`. Add `--agent --captures` to check exact image bytes in
Native ACP input and Rho/Rig input, refusal before the image diagnostic, text-only
follow-up without image replay and retained context after Host restart. Add
`--browser` to select the explicit image inclusion in the ordinary picker, inspect
its thumbnail at 1440/960/390/220 px and preserve both selections across reload.
The ACP and HTTP model peers are fixtures; these checks do not validate browser
screenshot/upload, real R image provenance or an annotation editor.

Add `--scientific` with a current retained `RHO_R_PLUGIN_PACKAGE`, `RHO_ARK` and
`RHO_R_HOME` to test actual installed Help, saved HTML, Console transcript and
Plots metadata, Objects summaries and Packages copy metadata as annotation sources.
The disposable R instance explicitly starts once. The check freezes exact evidence,
refuses forged resources, preserves the original outputs after a newer run,
and reads/replays notes after graceful Host restart while R remains suspended.
Object/package checks separate observation identity from summary content versions.
With `--agent`, all six notes reach the real Agent/Rig path through a local model peer.
This is owner/RPC integration; it does not claim annotation-editor interaction.

The generic plugin-only Host uses `cargo test -p rho-host --test plugin_workspace
--locked` for canonical project identity, native lease exclusion, empty-catalog
startup, retained history after package removal, and two independently running
backend projects. `cargo test -p rho-cli --bin rho plugin_workspace --locked`
checks launch selection and refusal of fixed runtime flags;
`cargo test -p rho-workbench --lib plugin_workspace --locked` checks skipped R
configuration and generic HTTP ports. Run these Cargo commands serially. After
building the current binary, the existing `plugin-workspace.spec.ts` and
`studio-plugin.spec.ts` browser cases run with `--plugins-only` and ordinary external
packages. These establish the generic project substrate, not Studio's
disposable-project creation or real-R acceptance.

Host restart work uses `cargo test -p rho-plugins --test backend_runtime suspension
--locked` for confirmed cleanup, original activation/data retention, stale resume
tokens, authority changes, substituted data directories and conflicting live
contracts during recovery. After that settles,
`cargo test -p rho-host --test plugin_restart --locked` exercises the public resume
and view-reconnect Operations across actual Host reopen with a separate native
backend, including retained state/layout and original Operation replay refusal.
Run the existing `plugin_workspace` and `plugin_test_projects` Host targets once
to check the shared shutdown paths. This does not establish the combined Agent
browser/real-R restart flow; that acceptance still needs its current artifact.
`ui/tests/plugin-window-recovery.test.ts` covers saved original requests, missing
replies, explicit inspection/retry and refusal to advance a recovered request on
reload. The workspace component test checks restoring its original isolated view.

Disposable-project metadata uses `cargo test -p rho-plugins --test test_projects
--locked` for exact dependency/configuration selection, scoped byte-bounded paging, immutable
identity, lifecycle compare-and-swap and transactional source protections. The
native lifecycle fixture is `cargo test -p rho-host --test plugin_test_projects
--locked`: a separate external backend, concurrent analysis work, borrowed/busy/open-view
stop refusal, original request recovery, cleanup failure and read-only history
across reopen. Catalog-write faults preserve acknowledged activation/release IDs
in their original parent Operations without replay. It also rejects caller paths,
invalid grants/artifacts and symlink
storage before backend startup. Run the repository and generic workspace
regressions after changes to these shared owners. These tests do not establish
Studio's backend-test UI or real-R acceptance.
Transport selection uses `cargo test -p rho-workbench --lib plugin_test_ --locked`
for independent ports/journals, token/asset separation, replay refusal, immutable
MCP selection and connection leases. Run the existing MCP identity regression
cases when changing that boundary. `cargo test -p rho-cli --test connection
--locked` covers explicit child selection and the parent project precondition. The
`--test session_test_project` CLI target exercises actual JSON-lines child
selection, parent separation and stopped/missing-target refusal.
After public DTO generation and client/binary builds, `npm run test:browser
--prefix ui -- plugin-test-project.spec.ts` exercises the actual connected CLI,
public SDK, native control, refresh, saved closure, stopped-state refusal and
normal/wide/constrained layouts while another analysis view retains its draft.
It checks ordinary flush closure after refresh and standalone navigation. A
deliberately dropped document-end notification still requires explicit saved-state
recovery; browser disappearance alone cannot prove a saved draft.


Generic project read coverage is separate from scientific reference interpretation.
`cargo test -p rho-sqlite --lib project_coverage --locked` and
`cargo test -p rho-operation -p rho-plugins --lib project_coverage --locked` check
principal/project boundaries, recorded lifecycle states and observation without
mutation or recovery. A journal without coverage support remains unavailable;
an empty visible page cannot stand in for that missing evidence.
`cargo test -p rho-host --test plugin_optional_requirements project_coverage --locked`
checks explicit grants and delegated visibility; the existing
`official_host_ports_bind_revisions_visibility_commit_and_release_without_r`
case in `--test plugins` checks direct Host access. Public protocol generation and
the independent TypeScript consumer include the coverage DTO and empty-input schema.
These checks establish metadata visibility, not Environment cleanup safety.

Archive transfer uses `cargo test -p rho-plugins --test archive_transfers --locked`
for native visibility, immutable ranges, full digest checks, capacity, expiry,
exact artifact export and atomic receipt rollback. The generic Host check is
`cargo test -p rho-host --test plugin_archives --locked`: empty-core import/export,
removal/reimport without activation, ordinary-view grants, native principal,
original commit recovery after reopen and preserved uncertainty when result
staging is lost. Run these serially, then the affected package-repository and
public-port regressions. Public DTO changes also require client generation and
`node scripts/test-plugin-protocol.mjs`. These establish archive port behavior;
they do not establish a browser file save or Studio archive UI acceptance.

The Manager archive models run in `node scripts/test-manager-plugin.mjs`: retained
file capture, identical-content reselection, partial uploads, lost acknowledgements,
original import recovery, replacement views, preserved uncertainty and explicit
discard, exact export selections, source-only exports and recovery without downloads.
After building the current client and Host, run `npm run test:browser
--prefix ui -- manager-plugin.spec.ts manager-archive.spec.ts` for the ordinary
Manager composition and local-file import flow. The archive fixture uses independent
source and target catalogs, loses a chunk reply and an import reply, reloads the
view, and verifies one import without activation while a second window keeps its
unsaved Unicode text. It also loses an export reply, recovers its original result
and explicitly downloads both source-only and built archives with matching checksums.

Studio archive models run in `node scripts/test-studio-plugin.mjs`. They exercise
source draft preservation, identical-file reselection, original request recovery
across views, result-save failure, exact source exports and uncertain outcomes.
After the current client/binary build, run `npm run test:browser --prefix ui --
studio-plugin.spec.ts studio-backend-test.spec.ts studio-scenario.spec.ts
studio-archive.spec.ts`. The archive flow loses upload/import/export replies,
retains unsaved Unicode source, downloads the immutable checkpoint, then opens
imported source only after explicitly checkpointing edits. It also checks normal,
wide and constrained controls, checkbox keyboard focus and another window's draft.
Inspect normal, wide and constrained dialog captures and
scrolled controls; passing model checks alone does not establish visual acceptance.

Run `npm run test:browser --prefix ui -- plugin-resource-download.spec.ts
plugin-archive-download.spec.ts` after rebuilding the client and current binary
for both containing-browser download paths. The archive case checks gesture
refusal, exact downloaded bytes, no extra Operations and closure during collection.
Client download unit tests cover the separate archive byte bound, one shared
download slot, integrity, revoked authority, disposal and transfer expiry.

Source development uses `cargo test -p rho-plugins --test source_development --locked`
for binary/paged reads, full-file corruption detection, source-only history,
concurrent head conflicts and transactional rollback. The shared-port fixture is
`cargo test -p rho-host --test plugin_development --locked`; it covers pure checks,
explicit scopes, original Operation replay and an ordinary view's declared calls.
Run the existing package repository suite after changes to shared archive storage.
Public DTO changes also require client generation and
`node scripts/test-plugin-protocol.mjs`. These tests do not establish the Studio
editor, build/preview, scene application or real-R continuity.

The ordinary Studio package uses `node scripts/test-studio-plugin.mjs` for an
independent build outside the core checkout and focused source/canvas history,
draft, receipt and recovery checks. After building the current client and Host,
`npm run test:browser --prefix ui -- studio-plugin.spec.ts` runs its ordinary view
against a disposable project. It covers fixture-only editing, declaration errors,
source composition, drag, checkpoints, lost receipt recovery and historical source
restoration. Its development flow also builds a real source checkpoint, recovers a
lost build acknowledgement without replay, starts an exact fixture preview and
closes/releases it while retaining its latest acknowledged state. It also requests
stopping a real long-running build and verifies the original terminal outcome,
with no new artifact and no replay. Inspect the
captured normal, wide and constrained screenshots before claiming visual completion.
The editing canvas itself does not execute plugin code. These checks cover
source/build/fixture behavior. The separate `studio-backend-test.spec.ts` case
uses a real external native backend and ordinary Studio: explicit creation, lost
creation receipt and reload recovery, child view opening, private workspace
navigation, native control, cooperative closure and stop while an analysis draft
remains unsaved. Inspect its normal/wide/constrained captures. This establishes
plugin lifecycle integration, not real-R acceptance. The model fixture additionally
covers unacknowledged saves, replacement-view recovery, retained child journals,
failed activation and uncertain cleanup. Public SDK tests cover selected five-port
calls and refusal of selected intrinsic requests.

`npm run test:browser --prefix ui -- studio-scenario.spec.ts` exercises ordinary
Studio against a separate generic Host: exact previewed build selection, explicit
new view state, lost checkpoint acknowledgement/reload inspection, preparation
without layout change, current-window application, and restoration as a new
checkpoint. It verifies old instances and hidden live drafts, including another
window's unsaved text. Inspect normal, wide and constrained screenshots plus the
scrolled narrow application controls. The Studio model fixture also checks layout
conflicts, partial-preparation reuse, failed final draft saves, replacement-view
recovery, uncertain results and refusal to proceed to later steps after a lost
reply. These do not establish real-R or full migration acceptance.

Fixture preview uses `cargo test -p rho-host --test plugin_preview --locked` for
exact artifact identity, no backend/project-path/grant creation, fixture-only
query routing, write/cancel refusal, scope/sequence checks, state and credential
lifetime, scenario exclusion and noninterference with real providers. After
building the current client and Host, `npm run test:browser --prefix ui --
plugin-preview.spec.ts` builds source through `plugins.build`, opens that exact
artifact with `plugins.preview`, and checks the ordinary SDK iframe, fixture
queries, blocked writes, Unicode, state persistence, clipboard, narrow/wide layout
and closure. `node scripts/test-manager-plugin.mjs` checks that fixture identities
are excluded from runtime/scenario reuse. These do not establish disposable-project
real-backend testing; Studio's end-user flow has its own browser case above.

Scenario application uses `cargo test -p rho-host --test plugin_scenarios --locked`.
The fixtures construct ordinary packages outside the checkout and exercise scoped
checkpoint/application ports, exact dependency/grant validation, delegated view
calls, transaction rollback, concurrent window conflicts, native work across
version switching and unavailable-default refusal. `--test plugins` covers the
shared view/lifecycle ports; `cargo test -p rho-mcp --test plugins --locked` checks live public discovery.
These tests do not establish the management UI, iframe continuity in a browser or
real-R scenario acceptance. View resource context is qualified against bounded
retained metadata; the separate byte ports remain responsible for byte integrity.

Agent native transport lives in `plugins/agent/backend/client`, depending only on
the public `plugins/agent/api` and external libraries. Iterate with
`cargo test -p rho-agent-client --lib --locked`; generate public declarations and
schemas with `node plugins/agent/generate-sdk.mjs` (supports `--check`).
`node scripts/test-agent-plugin-types.mjs` compiles an independent TypeScript
consumer using only the public declarations, including unknown usage counters.
`node scripts/test-agent-plugin-client.mjs` assembles only those two crates outside
the checkout, verifies all local dependency containment and runs the same native
protocol/recovery fixtures plus generated-contract freshness. Local fake providers
exercise original input identity, bounded/redacted observations, uncertain replies,
cancellation and native-session recovery without starting real Agents. Host task
admission remains covered by `cargo test -p rho-host --lib agent_tasks --locked`
while that adapter awaits deletion. Workbench tests cover generic MCP project and
test-project identity; ordinary Agent private MCP is checked by the native package
and real Agent tool/restart acceptance. No setup entry point is invoked by the native fixture checks.

The native task scheduler is `plugins/agent/backend/native`. Iterate with
`cargo test -p rho-agent-native --lib --locked`, then run `cargo test -p rho-host
--lib agent_tasks --locked` for caller/window/context and MCP integration.
`node scripts/test-agent-plugin-native.mjs` assembles the scheduler, native client,
owner and store outside the checkout and runs receipt-failure, no-replay and
endpoint-cleanup fixtures, including failed registration and unconfirmed process
cleanup, using only public dependencies. These use fake native
sessions and a disposable Agent database. The old fixed HTTP recovery script has
been retired; ordinary `ui/e2e/agent-workspace.spec.ts` and
`node scripts/test-agent-process.mjs` cover actual Host restart with explicit retained
packages and local ACP peers. Ordinary native-plugin composition has framed and Host
acceptance: `cargo test -p rho-agent-backend --test metadata native_tasks --locked`
uses an injected native factory and real package storage/loopback endpoints.
It covers original Send retention, explicit Stop, next drafts, attachment input,
reopen deduplication and refusal to forget unconfirmed native cleanup.
`node scripts/test-agent-plugin.mjs --build` builds one independent assembly and repeats
all framed cases, then checks task metadata, attachment Control journal exclusion
and instance separation through a generic Host compiled before that external
package. The `native_foreign_takeover` framed
case checks attached/closing/unknown originals, changed requesting connections,
confirmed detachment and original-request retries. The `view_presence` case in
`cargo test -p rho-host --test plugin_view_delegation --locked` uses the public
ports for cross-window/backend observations, refused closure, backend exit,
visibility and credential/content exclusion. These do not establish real provider
performance or plugin view acceptance.

`cargo test -p rho-agent-backend --test metadata native_science --locked`
adds real private-loopback MCP calls with an injected native Agent and synthetic
Host scientific records. It covers original Send/child retention, dropped reply
observers, Stop, later turns, partial/cached queries, result verification/bounds,
grant/caller revalidation, multiple scientific owners under one Send, refusal
when either an activation grant or original caller scope is missing, and
observation-only reopen. After manifest generation, run
`node scripts/test-agent-tool-grants.mjs` to compare the exact optional versions
and scopes against the public scientific-provider manifests. These framed tests do not
establish actual R execution. `node scripts/test-agent-plugin-real-r.mjs --build` compiles
generic Host harnesses before independently building the ordinary Agent/R packages.
Its native ACP fixture runs only from an isolated PATH/home and calls the actual
private MCP endpoint; the disposable R counter must execute once and retain its
original result after native Stop. The existing component model fixture is run
separately in the same harness. Set `RHO_ARK` and `RHO_R_HOME`; no real model or user
credentials are used. Neither fixture establishes native model quality or the
full Agent UI/restart flow.

Use `cargo test -p rho-agent-native --lib mcp --locked` for private native MCP
transport changes. These real loopback HTTP fixtures cover connection/session
identity, bearer/Host/Origin refusal, numeric/text request correlation, failed
initialization cleanup, bounded input/output, streaming-response capacity,
cancellation and endpoint shutdown while accepted owner work remains pending.
They use no model or user credentials.
The independent native assembly runs the same fixtures without private core source.

Native command admission uses `cargo test -p rho-agent-store --lib
native_admission --locked`. Its real-store fixtures cover pre-command captures,
concurrent duplicates, original-parent retention, atomic write rollback, later
receipt mutation, observation-only reopen, scoped visibility and admission budgets.
The independent store/owner assembly includes these cases. These checks establish
persistence invariants, not native plugin MCP or view acceptance.
The `native_tools` filter covers captured bindings/scopes, exact retry observations,
post-Stop admission refusal, atomic storage failure, byte budgets and immutable
tool results across reopen.

The public model driver is `plugins/agent/backend/engine`. Run `cargo test -p
rho-agent-engine --locked` for the real Rig HTTP/SSE codecs and production-driver
ports using local provider fixtures. `node scripts/test-agent-plugin-engine.mjs`
repeats these checks with the owner/API in an independent source assembly and
checks SDK freshness. The fixed Host task/component services and their adapter
crate have been removed. Ordinary integration uses the retained-package Agent
workflow, real-R and browser checks documented above; retired Host service tests
do not count as plugin acceptance. These use local synthetic models; provider
quality remains a separate outcome.
The explicit live provider probe now belongs to `rho-agent-engine`'s
`provider_probe` example; no test invokes it implicitly.

The public task state machine is `plugins/agent/backend/owner`. Iterate with
`cargo test -p rho-agent-owner --lib --locked`; `node
scripts/test-agent-plugin-owner.mjs` repeats its admission/recovery fixtures from
an independent source assembly and verifies public contract freshness. Core Agent
request/controller conversions and private-route DTOs are removed, along with
their obsolete fixtures and generated client exports. `node
scripts/test-agent-plugin-types.mjs` checks an external consumer using only the
plugin SDK. The Application component conversion is also retired. Public component-owner fixtures inject controller
loss and atomic write failure, and check original admission, late native receipts,
observation-only restart, unsupported control refusal and frozen permissions.
Public handoff ownership uses `cargo test -p rho-agent-owner --lib handoff --locked`: all task-kind pairs,
original receipt recovery, scoped/live controllers, stale or unowned context,
target budgets and atomic commit faults. The public owner preserves original receipt digests and structured diagnostics.
Asynchronous native reverse-call transport uses `cargo test -p rho-plugin-sdk
--test host_calls --test transport --locked`: original request IDs, concurrent
correlation, retained abandoned waits, queued/unknown/duplicate reply refusal,
capacity and payload bounds, typed recovery, and unconfirmed disconnects. These
SDK checks do not establish ordinary Agent process composition or scientific
execution; Host delegation checks still own authority and journal idempotency.
Calling-view identity uses `cargo test -p rho-host --test plugin_view_delegation
--test plugin_drafts --locked` plus `cargo test -p rho-plugins --test backend_runtime
reverse_calls_inherit_active_parent_and_declared_scope_without_host_credentials
--locked`. The independent backend fixture checks authenticated origin across
multiple hops, forged selectors, native scope loss and closure while an accepted
operation is waiting. A non-view origin stays distinct from a stale view. These
checks use the generic plugin-only Host and do not establish Agent task admission.

Original reverse-request observation uses `cargo test -p rho-host --test
plugin_delegated_operations --locked`. Its independent framed Python backend
keeps a parent active while its delegated child runs, discards the child's reply,
and resolves the exact journal identity without repeating the call. The fixture
checks absent-record uncertainty, argument forgery, sibling-instance denial,
principal/project/read-scope boundaries and journal reads after release/reopen.
Public declarations and standalone schemas are covered by the protocol consumer.

Native contract metadata uses `cargo test -p rho-operation --lib
native_contract_inspection --locked` and `cargo test -p rho-host --test
plugin_workspace native_contract_metadata --locked`. The registry test rejects
dynamic/retired contributions and attempted replacement of a startup port. The
generic Host fixture compares exact descriptors, denies metadata reads without
`plugins.read`, rejects contributed or missing ports, and verifies that reading
write schemas grants no write authority and creates no Operations or branches.
Its external backend also reads a write contract through the scoped reverse Query
port while the original caller holds only `plugins.read`.
Run the affected discovery and generic workspace targets once this behavior
settles. Public declarations and schemas use client generation and the independent
`node scripts/test-plugin-protocol.mjs` consumer.

The ordinary Agent scientific port adds scoped R observation/execution fixtures to
`cargo test -p rho-agent-backend --test metadata --locked --offline`. Owner/store
checks cover immutable native captures, Explain/Run admission, original tool IDs,
stop fences and late receipts. The framed suite also covers omitted grants, foreign
binding parameters, actual loopback Rig tool calls, parent retention while stopped,
and read-only delegated-result recovery after disconnect. These use simulated
native replies; they do not establish real scientific execution.
With existing `RHO_ARK` and `RHO_R_HOME`, run
`node scripts/test-agent-plugin-real-r.mjs --build` for two independently built packages in
a plugin-only Host. The frozen Host harness exercises real R effects, late results
after model stop, original causation, no duplicate execution and retained native
reports after package removal. All sessions, projects and model keys are disposable.
Neither this nor the framed suite establishes real-provider quality or Agent views.

`RHO_PLUGIN_SET_PACKAGE=/absolute/set node scripts/test-agent-process.mjs` uses
retained ordinary archives and the frozen Host, without Cargo or a model service.
A local ACP peer reaches real Process preflight/run through Agent's private MCP:
read-only selection refuses execution, malformed provider arguments are refused
before admission, and the selected process produces original Unicode stdin/stdout
and stderr with a bounded resource report. Tool/Send retries retain one effect. Owner-normalized targets/arguments must match
an independently queried original Host operation identity; provider, project,
capability, preconditions and original parent remain fixed.
Native Agent Stop fences further Agent work while the original Send waits for its
already accepted Process child to settle; it is not a process cancellation request.
The runner restarts only its disposable Host, resumes the same Agent instance and
replays original receipts while Process remains suspended. `RHO_TEST_BINARY`
selects the frozen core and `RHO_AGENT_PROCESS_EVIDENCE` selects the report. This
is real plugin/native-process composition with a deterministic ACP peer, not
real-model quality, Rho-model execution, remote-cluster or browser acceptance.

`RHO_PLUGIN_SET_PACKAGE=/absolute/set node scripts/test-agent-environment.mjs`
uses the retained Agent and Environment archives with an existing R installation
(`RHO_R_HOME`, defaulting to the macOS framework). Existing pak/renv/ps/jsonlite
are required; the runner never installs prerequisites or builds Rho/plugin binaries. Its
local ACP peer exercises native read-only preflight, explicit refresh → pak plan
of the local fixture → isolated realization → verification → inventory/library
selection and original bounded report reads. Cached or unavailable inventory
remains a partial observation even when the selected library is listed. The fixture package is installed
only into the disposable Environment library. Changed DESCRIPTION bytes produce
a failed verification, retained separately from the successful Send. Repeated
native tools and Sends reuse original outcomes; actual namespace-load evidence
must stay unchanged across Send replay and same-instance Host restart with
Environment suspended. `RHO_AGENT_ENVIRONMENT_EVIDENCE` selects the report.
This does not establish real-model quality, Rho-model Environment execution,
remote package resolution, renv restoration, material cleanup or browser behavior.

`RHO_PLUGIN_SET_PACKAGE=/absolute/set node scripts/test-agent-remote.mjs` uses
retained Agent/Remote artifacts and actual macOS OpenSSH. The owned sshd listens
only on loopback with ephemeral client/host keys, a pinned host key and private
configuration; it changes no system service or user SSH files. A local ACP peer
checks read-only preflight without a connection, exact target refusal, Unicode
streams, native exit 9, exit 255 uncertainty, Stop waiting for accepted work, and
original tool/Send records after actual Host restart with Remote suspended.
SSH connection counts and one-time file effects must not change on retries or
restart. A fresh envelope may successfully read a native ACP receipt; the original
Send and SSH operation must independently retain their uncertain status. `RHO_AGENT_REMOTE_EVIDENCE` selects the retained report. This verifies
real SSH transport on one machine, not Slurm, a remote cluster, cross-machine
network failure, real-model quality or Rho-model Remote execution. The runner
never builds Rho/plugin binaries or replaces an existing Host/SSH service.

Native Host tool capture uses the `native_host` filters in owner/store/backend
checks and the ordinary framed `metadata` suite. These cover fixed branches,
model-field override refusal, explicit optional grants, foreign project/version
rejection, normalized result correlation and read-only tools without mutation
observation grants. Run `node scripts/test-agent-tool-grants.mjs` after manifest
generation to compare published scientific and management declarations.
`node scripts/test-agent-core-tools.mjs --build` freezes the generic Host harness before
building an independent Agent package. Its isolated native ACP peer uses the real
private MCP endpoint to read a chosen branch and checkpoint its source once,
refuses another branch, observes identical retries, recovers the original journal
record and leaves the running revision unchanged. The peer also asserts no build,
preview or scenario application occurred. This establishes native transport and
Host composition, not model quality or Studio's Ask Agent interface.

For the complete Studio path, first build the current Host and retain one current
Agent package, then run `node scripts/test-agent-core-tools.mjs --browser --package
/absolute/retained/package`. This mode runs `studio-agent.spec.ts` without Cargo or
another Agent build. Its disposable Host uses actual Studio/Agent views and a local
ACP peer through private MCP: review one captured branch, recover a lost view-open
reply, add the request to a native draft, Send, and correlate one original source
checkpoint. Studio then explicitly builds, previews and applies that exact revision
to a scenario while the older instance remains active. The peer refuses replacement
branch/head fields and repeats only the same checkpoint request. Type checking or
test discovery alone does not establish this acceptance; use Status for run evidence.
UI iteration uses `node scripts/test-studio-plugin.mjs --browser-agent` and
`node scripts/test-agent-view.mjs --browser`, whose peers are synthetic.

The ordinary Agent metadata process uses `cargo test -p rho-agent-backend --test
metadata --locked` for framed Host exchanges, original caller identity, task/draft
CAS, explicit controller takeover, bounded concurrency, disconnect and settlement.
The same target covers ephemeral key Controls, original-key receipt reads,
wrong-port/identity refusal, lost replies/reopen and combined capacity without
fabricated Control settlement. `support/model_settings.rs` additionally checks
version-fenced key availability/removal, unchanged settings, retained receipts,
environment-key refusal and storage-error visibility. These fixtures use only
temporary synthetic keys.
The `contributed_context` filter on the same metadata target checks public source
preview before Native Send, original captured text after reopen, no source reread,
and refusal of foreign, partial, truncated, oversized, resource-bearing or
unauthorized input before native launch. `cargo test -p rho-agent-store --lib
native_context_bytes --locked` checks immutable captured context and replay after
reopening the store. `rho_contributed_context` on the metadata target verifies
actual context bytes delivered through Rig to a local HTTP/SSE model, atomic
admission, reopen without source grants and unchanged drafts on source refusal.
The store `native_context_admission` case covers atomic context/draft persistence,
changed-byte retry rejection and later drafts after reopening. These framed/store
fixtures do not establish a real Editor/Host flow.
`node scripts/test-agent-view.mjs --browser` also exercises the ordinary @ picker,
using the actual Editor inclusion schema and a synthetic source over the public
view channel. It checks exact references, no implicit activation, bounded/partial
reads, changed sources, draft reload, original sent context and responsive layouts.
These checks do not replace native source capture or real Editor/Host acceptance.
`node plugins/agent/generate-manifest.mjs` updates its contributed schemas; use
`--check` for freshness. `node scripts/test-agent-plugin.mjs --build` first builds the
generic Host harness, then builds one external package, checks public dependency
containment, repeats the framed fixtures and loads that same package without
changing the Host harness. Its explicitly selected ignored cases check scopes, two
instances, durable request deduplication, key-Control journal exclusion and retained
journal reads after removal.
The synthetic model fixtures exercise the production Rig driver against a local
HTTP/SSE provider, retain the original Operation until completion, reject stale or
foreign stop requests, and verify disable/disconnect behavior without replay.
The model-task fixtures additionally retain the original native admission,
stream Unicode text into existing task events, project live task status and fence
the original loop on stop/disable/takeover. Duplicate/reopened task requests are
observations even after removing the fixture key file.
The `model_history` fixture checks bounded pages and foreign/invalid cursors;
the disconnect case projects interrupted history without changing stored state.
Missing-key preflight must leave the saved draft and run history unchanged.
`cargo test -p rho-agent-store --lib native_send_consumes --locked` checks atomic
matching-draft consumption, unmatched input and original replay after reopening.
The independent generic Host case exercises the ordinary task's actual retained process and journal.
They use temporary keys and no real provider or user session. Scientific tools,
context/attachment capture, continuation, native Agent connections and Agent view
acceptance remain separate checks. `cargo test -p rho-agent-owner -p
rho-agent-store --lib native_ --locked` focuses on atomic parent identity,
original-request deduplication, late native receipts, readonly reopen, scoped
visibility and refusal to replace/remove a retained parent in a later write.

Independent assemblies include the public plugin protocol and R media API, with
all source/dependency paths checked to stay inside the assembly. Agent-owned storage
includes scoped credential-file locking, replacement, redaction and explicit-path
fixtures, atomic original-request receipts, concurrent duplicate writes and
post-removal replay refusal, and uses `cargo test -p rho-agent-store --lib --locked`; `node
scripts/test-agent-plugin-store.mjs` repeats store and owner tests in an independent
source assembly. Format isolation tests reject unrelated/unsupported databases
without modifying them. The core Agent/annotation storage adapters and their tests
are removed. `cargo test -p rho-application -p rho-sqlite --lib --locked` covers
generic state/receipt persistence, including refusal to overwrite stale drafts and
independence from retired plugin database paths. `cargo test -p rho-sqlite --lib
--no-default-features --locked` checks the journal-only composition. Neither entry
replaces ordinary Agent/annotation plugin acceptance.
`node scripts/test-real-r.mjs --agent` delegates to the ordinary Agent/R plugin
harness (`test-agent-plugin-real-r.mjs`) using retained `RHO_AGENT_PLUGIN_PACKAGE`
and `RHO_R_PLUGIN_PACKAGE`, plus installed `RHO_ARK`/`RHO_R_HOME`. It builds only
the affected Host test executables and does not rebuild plugins or call a live model.
The no-argument script checks the ordinary R engine and shared native helpers; the retired
fixed component-source, mutation and MCP parity tests are no longer part of it.

Environment contracts, native execution and R helpers live in
`plugins/environment/api` and `plugins/environment/backend/owner`. The fixed Host adapter has been removed. Iterate with
`cargo test -p rho-environment-api -p rho-environment-owner --lib --locked`.
`node scripts/test-environment-plugin-owner.mjs` copies six public/plugin crates
outside the checkout and runs the focused storage/observation tests without R.
The fixed Environment Host bridge and its runner are retired. Use the ordinary
Environment/Agent suites below with retained packages and explicit R prerequisites;
the retired tests do not establish current plugin acceptance. The ordinary backend is `plugins/environment/backend`. Iterate with
`cargo test -p rho-environment-backend --lib --locked`; generate public declarations
and contributed schemas with `node plugins/environment/generate-sdk.mjs` and
`node plugins/environment/generate-manifest.mjs` (both support `--check`).
`node scripts/test-environment-plugin-types.mjs` checks an independent TypeScript
consumer. `node scripts/build-environment-plugin.mjs /absolute/new/package`
assembles nine public/plugin Rust crates outside the checkout and builds offline
with locked dependencies. The shipped `python3 tests/protocol.py
/absolute/package/dist/rho-environment-backend` exercises the actual executable
without R. With an already built Host and the installed R prerequisites,
`RHO_ENVIRONMENT_PLUGIN_PACKAGE=/absolute/package node scripts/test-environment-plugin.mjs`
checks ordinary activation, original source/report authority, native pak/renv,
verification, installer cancellation, previous-instance resource reads, explicit
reference grants and material quarantine/restore/purge through that unchanged Host.
It retains failed evidence and only cleans test-owned native markers. Add
`--r-references` and set `RHO_R_PLUGIN_PACKAGE=/absolute/r-package` and
`RHO_ARK=/absolute/ark` for exact-session live-library and namespace retention,
including namespace use after removal from `.libPaths()` and eventual release.
Use `--checkpoint-references` with those variables and
`RHO_CHECKPOINT_HELPER=/absolute/verified/rho_checkpoint.so` to add recovery capture,
protection after namespace unloading and session release, an unstarted replacement
reader, ambiguous-reader refusal, explicit reader configuration and
pin/unpin, uncertain deletion and resolution retry, explicit completion and purge
before Environment material cleanup. Unpublished capture checks add a real namespace
dependency, protection after provider release, an uncertain disposal with missing
bytes, and explicit confirmation before cleanup. All original failed/uncertain
records remain unchanged; observation and disposal providers remain unstarted.
The native absence check can be unavailable when the OS hides a contemporaneous
process's environment or lifetime. Keep this acceptance run separate from
additional shell commands; preserve such a refusal as unavailable evidence and
do not weaken the native check to turn it into a pass.
The Host must include the public project-coverage capabilities; the script never
rebuilds or replaces it. Backend unit checks include bounded reference scans,
unavailable visibility, unknown recovery, changed observations, original scope,
absent-path references and uncertainty. The shipped wire check includes material
query purity and unsupported cancellation before EOF. Ordinary checkpoint references
are read through the public R owner; uncertain original captures/controls retain
material. `environment.library@2` is a pure original-realization observation;
`r.create_session@2` explicitly delegates native verification before starting R.
`RHO_ENVIRONMENT_PLUGIN_PACKAGE=/absolute/environment-package
RHO_R_PLUGIN_PACKAGE=/absolute/r-package RHO_ARK=/absolute/ark
RHO_R_HOME=/absolute/R node scripts/test-r-environment.mjs` exercises their
independently built packages through the existing unchanged Host. It checks grants,
preflight purity, library tampering, delegated verification, namespace failure,
two R revisions, replacement Environment instances, original records and retained
reports. All sessions and libraries belong to disposable fixtures. It also runs
the shipped R `tests/environment_protocol.py` against that executable for bounded
and reversed Host replies, lost verification acknowledgement and pending-call EOF.
That wire check can run directly with `python3 tests/environment_protocol.py
/absolute/r-package/dist/rho-r-backend`; its fake R/Ark must never be launched.
The ordinary Environment backend checks validate captured provider/source qualification;
generic Host delegation tests enforce original caller scope before a reverse query.
Retired fixed Environment query tests do not count as ordinary-plugin acceptance.

SSH/Slurm contracts and native execution live in `plugins/remote/api` and
`plugins/remote/backend/owner`. Iterate with `cargo test -p rho-remote-api -p
rho-remote-owner --lib --locked`. `node scripts/test-remote-plugin-owner.mjs`
assembles only five public/plugin crates outside the checkout, runs the focused
checks and exercises fake SSH/Slurm transcripts. The fixed CLI Remote bridge runner
is retired. Ordinary Remote/Agent suites cover exact provider calls, idempotency
and recovery. Local transcript fixtures do not establish remote-host acceptance. The native owner has no
journal or automatic replay.
The ordinary Remote backend tests reject malformed, foreign and unqualified source
records before native work. Generic Host delegation tests enforce the original
principal and read scope before a reverse query.

The ordinary Remote RPC backend is `plugins/remote/backend`. Iterate with
`cargo test -p rho-remote-backend --lib --locked`. Generate its public declarations
and manifest with `node plugins/remote/generate-sdk.mjs` and
`node plugins/remote/generate-manifest.mjs` (both support `--check`).
`node scripts/test-remote-plugin-types.mjs` compiles an independent public consumer.
`node scripts/build-remote-plugin.mjs /absolute/new/package` assembles seven
public/plugin crates and builds with the locked offline dependency closure.
Run `node /absolute/package/tests/protocol.mjs /absolute/package/dist/rho-remote-backend`
for resource loss, source correlation, cancellation observations, settlement and
EOF fault checks. After building the current Host explicitly,
`RHO_REMOTE_PLUGIN_PACKAGE=/absolute/package node scripts/test-remote-plugin.mjs`
checks ordinary installation, configured invocation, retained output resources,
lost submission receipt, native observations and original-source recovery through
a replacement instance. It verifies unchanged Host bytes, uses disposable local
SSH/Slurm substitutes and never contacts a real cluster. Omit the package variable
to assemble a new standalone package first. Default activation stays disconnected;
preparing and observing local status never start SSH.

Local process launch and native recovery live in `plugins/process/backend/owner`.
Use `cargo test -p rho-process-owner --lib --locked` while
iterating, and `node scripts/test-process-plugin-owner.mjs` to assemble the public
protocol/API/engine/owner sources independently and run their native tests.
The fixed Process Host bridge and its recovery runner are retired. The ordinary
Process and Agent/Process suites below own current native-operation and recovery
acceptance; no retired test counts as a current pass.

The ordinary Process RPC backend is `plugins/process/backend`. Iterate with
`cargo test -p rho-process-backend --lib --locked`; generate its public declarations
and manifest with `node plugins/process/generate-sdk.mjs` and
`node plugins/process/generate-manifest.mjs` (both support `--check`).
`node scripts/test-process-protocol.mjs` compiles an independent public TypeScript
consumer. `node scripts/build-process-plugin.mjs /absolute/new/package` assembles
six public/plugin Rust crates outside the checkout, with locked offline builds.
After building the current Host explicitly, `node scripts/test-process-plugin.mjs`
builds the external package and verifies unchanged Host bytes while exercising
actual process execution, resource evidence, project targeting, original-request
idempotency, cancellation, settlement and replay after release. Set
`RHO_PROCESS_PLUGIN_PACKAGE` to reuse an independently built package. The included
`tests/protocol.py` additionally checks executable RPC failures and settlement
fencing, bounded/reordered original-operation reads and EOF cleanup of queued
recovery. The Host case also exercises tagged-process reconciliation, retained
original outcomes and source/recovery idempotency. Backend unit checks include
fresh native cleanup with unrelated work preserved. The Host case then kills only
its freshly observed disposable backend, verifies original uncertainty, and uses
a replacement instance to reconcile surviving work without changing or replaying
the source. These cases use disposable
projects and no R runtime; they do not establish SSH/Slurm behavior.

Editor context is an ordinary native backend in the Editor package. Use
`cargo test -p rho-editor-backend --lib --locked` for its bounded search, exact
source/version/digest checks, multi-page content verification and Unicode selection
behavior. Regenerate its contributed manifest with `node scripts/generate-editor-context.mjs`;
use `--check` to verify committed schemas. After independent assembly,
`python3 /absolute/package/tests/protocol.py /absolute/package/dist/rho-editor-backend`
checks executable RPC concurrency, correlation, errors and release. The public context DTOs are included in protocol generation and the
independent strict TypeScript consumer. The native `editor-plugin.spec.ts` path
also reads actual synchronized Editor captures through the context contribution;
assemble Editor with the native artifact target before that case. The three
Editor/Files browser fixtures now use that combined package target.

`cargo test -p rho-host --test plugin_view_delegation --test plugin_drafts
--test plugin_workspace --locked` checks Host-owned view restrictions through an
independent public-RPC backend, including nested delegation, preflight, controls,
close-time encoding scope and accepted work after closure. The fixture waits for
native settlement before releasing the instance; a terminal journal record alone
does not prove that backend settlement has finished.

The ordinary Console package has an independent build/model check,
`node scripts/test-console-plugin.mjs`. Its isolated editing case is
`npm run test:browser --prefix ui -- console-editor.spec.ts`; this case supplies
only a public MessagePort fixture and establishes no native R behavior. Build the
current client and Host before the browser checks. The real R package path is
`RHO_ARK=/absolute/existing/ark RHO_R_HOME=/absolute/existing/R/home node
scripts/test-r-console.mjs`, with `RHO_R_PLUGIN_PACKAGE` selecting the retained R
package. It builds only the Console UI, exercises the current Host, and checks that the package build did not
change the Host binary. Synthetic composition events cover submission guards;
they do not establish native input-method acceptance.

The Console model check also covers read-only original-submission recovery from a
replacement view, exact view/request/provider/session/code matching, partial records
or ambiguous candidates, failed acknowledgement persistence and edits during observation.
Native recent-operation pages are partial by design; recovery uses them only to
locate candidates before requiring a complete, exactly matching Operation record.
`console-editor.spec.ts` exercises the explicit inspection action, disabled foreign
retry, preserved uncertainty and recovered drafts across reload at normal, wide
and constrained sizes. `r-plugin-console.spec.ts` drops a native submission reply,
replaces its view and verifies one original Operation and one real R increment.
Neither recovery path invokes the saved submission or restarts R.

The ordinary Objects package is assembled outside the checkout with
`node scripts/build-objects-plugin.mjs /absolute/new/directory`; model, action
capture and component checks run with `node scripts/test-objects-plugin.mjs`.
After building the current client and Host, use
`npm run test:browser --prefix ui -- objects-plugin.spec.ts` for its opaque-frame
presentation and explicit-action fixture. This fixture uses public SDK messages;
it does not establish native R behavior or production window lifecycle integration.
The action model covers explicit set-aside persistence, bounded retention without
eviction, later original-request inspection from another view, refused partial or
foreign records, and failed saves that cannot clear the active request. The isolated
browser case retains a lost reply, permits a separate new action and reopens the
saved request for read-only recovery. Check its retained-request layouts as well
as the ordinary object views at normal, wide and constrained sizes.
The native path uses explicit existing Ark/R and ggplot2 in a disposable project:
`RHO_ARK=/absolute/existing/ark RHO_R_HOME=/absolute/existing/R/home node
scripts/test-r-objects-plugin.mjs`. The wrapper builds both packages outside the
checkout and verifies an unchanged Host binary; set `RHO_R_PLUGIN_PACKAGE` to
reuse an existing native package while assembling current Objects sources.
To reuse both already built packages,
set `RHO_R_PLUGIN_PACKAGE` and `RHO_OBJECTS_PLUGIN_PACKAGE` alongside Ark/R, then
run `npm run test:browser --prefix ui -- r-plugin-objects.spec.ts`. It covers native
objects, automatic same-window inspection, preserved directory documents,
responsive table presentation, actual pointer receipt inspection, explicit plot
Operations and close-time state capture. The case uses the generic composition
entrypoint; default scenario delivery remains a separate acceptance.

Use the smallest test tier that proves the current change. A small change must not
rerun the entire workspace by default; expand the scope only when the dependency or
owner boundary requires it.

Native package builds use `plugins.build@1` through the shared Operation port:
`{"revision":"sha256:…","timeout_ms":120000}`. Both `plugins.write` and
`plugins.run` are required. Build a saved source checkpoint, retain its original
request identity, and inspect that Operation after an interrupted acknowledgement.
No instance activation or scenario application follows automatically. Iterate with
`cargo test -p rho-plugins --test build_operations --locked`; changes to package
storage also require the `package_repository` and `source_development` targets.

The Host forwards existing tool/cache locations only, including optional
`RHO_PLUGIN_CARGO` and `RHO_PLUGIN_NODE_MODULES`; it supplies neither a dependency
installer nor a shared build target directory. Missing tools/cache entries produce
build diagnostics. Rustup automatic toolchain installation is disabled and Cargo
runs offline. Working source is retained under the repository's
`builds-v1/<SHA256-of-original-operation-id>/source`. `request.json`, `process.json`
and a possible `artifact.json` retain bounded native evidence. The latter names a
validated candidate, not proof of a journal commit: inspect the original Operation
and repository. Uncertain original builds retain source references and are never
automatically rerun. A read or client refresh does not start or recover a build.

Files/Git native sources now live in `plugins/files/backend/engine`; their public
data and provider contracts live in `plugins/files/api`. Shared bounded subprocess
supervision lives in `crates/process-engine` with public process reports
in `crates/plugin-protocol`. Search and patch interpretation live in
`plugins/files/backend/owner`; fixed adapters and project handlers are removed.
Iterate with
`cargo test -p rho-files-engine -p rho-files-owner -p rho-process-engine --lib --tests --locked`.
For the source boundary, `node scripts/test-files-plugin-engine.mjs` materializes
those four libraries and the public plugin protocol outside the checkout, and
runs their native tests with the installed toolchain. It is not a backend activation or packaging test.
Generate public Files declarations with `node plugins/files/generate-sdk.mjs`,
then run `node scripts/test-files-protocol.mjs`. Contract moves also require the
normal client generation check, even when wire shapes remain unchanged.
The Host boundary check is
`cargo test -p rho-host --test plugin_workspace --test plugin_workspace_paths --locked`.
It covers generic Host leases and public protected-path metadata, including an
external backend's explicitly granted reverse query. Actual Files operations use
`files_plugin` with an explicitly retained package.

The ordinary native Files package is assembled with
`node scripts/build-files-plugin.mjs /absolute/new/directory`. Iterate on its owner
with `cargo test -p rho-files-backend --lib --locked`; check its generated capability
manifest with `node plugins/files/generate-manifest.mjs --check`.
`node scripts/test-files-plugin.mjs` first compiles its Host acceptance target, then
builds Files outside the checkout from eight public/plugin packages using locked
offline dependencies. It verifies unchanged Host target bytes, runs executable
wire/fault cases, and explicitly runs the otherwise ignored native acceptance.
That case uses a disposable Git project, two exact revisions, real protected Host
paths and an injected journal commit failure. It does not require R or restart a
user Host. This is backend acceptance; it does not establish Files/Editor UI or
default scenario delivery. Set `RHO_FILES_PLUGIN_PACKAGE` to reuse an independently
built package while recompiling and testing a changed Host.

The combined Files UI has an independent model/connection/action check:
`node scripts/test-files-ui.mjs`. After building the current client and Host,
`RHO_FILES_PLUGIN_PACKAGE=/absolute/built/package npm run test:browser --prefix ui -- files-plugin.spec.ts`
uses the real Files backend, ordinary Editor and generic window in a disposable
project. `RHO_EDITOR_PLUGIN_PACKAGE` can also select an already assembled Editor;
omitting either variable assembles its fresh package first. It covers directories/search,
responsive input, close capture, reopening, external changes and exact Editor
navigation, native editing/saving and new unsaved documents. A file changed after
the Files capture is refused until an explicit refresh; saving then remains usable.
`cargo test -p rho-host --test plugin_self_requirements --locked` verifies that
combined packages can declare exact self-capability grants before first activation
without early publication, scope escalation or undeclared access.

`node scripts/test-editor-plugin.mjs` compiles the Editor owner outside the checkout
using only its locked dependencies, public plugin/UI SDK and Files/R declarations.
It checks resident text/undo, bounded exact file reads, queued captured drafts,
original-request recovery, receipt identity and failure/uncertain retention, plus
the native save controller's durable intent, later edits, non-blocking close and
conflict/explicit replacement behavior. Assemble the ordinary UI package with
`node scripts/build-editor-plugin.mjs /absolute/new/directory`.
Code-action checks cover explicitly observed existing sessions, capture before
asynchronous observation, selection/line/document requests, byte limits, original
admission and close/reopen recovery. Formatting checks verify complete retained
reports, exact request/session/source identities, unchanged-document application,
resident undo, later edits and version-fenced explicit comparison choices.
Saved-run checks verify the frozen file/R capture, original save completion before
R admission, unchanged-file observations, lost acknowledgements, failure and
uncertainty, later typing, close during both admission preparations and explicit
continuation only from the original view. Reopening and inspection do not start R.
Session-selection checks cover bounded project/principal-scoped capability
discovery, unstarted and unavailable providers, retained target selection and
original operations that remain attached to their captured provider after a switch.
Editor preference checks preserve document state and native file identities while
synchronizing bounded font/indent choices; the native file browser case checks
their actual rendering, indentation, undo and restoration after closing the view.
After building the current client and Host,
`npm run test:browser --prefix ui -- editor-plugin.spec.ts` uses independently built
Files and Editor packages in a disposable project; set `RHO_FILES_PLUGIN_PACKAGE`
and `RHO_EDITOR_PLUGIN_PACKAGE` to reuse exact built packages. It checks native file
saves, held admission during close, original-result restoration, Unicode Save As,
larger-than-view-state drafts, explicit disk comparison/replacement and responsive
CodeMirror presentation. Comparisons preserve local edits, recheck the captured
digest before choosing a base and do not write files; replacement retains undo.
This does
not establish R execution, native input-method behavior or default composition.

`npm run test:browser --prefix ui -- editor-code.spec.ts` exercises ordinary Editor,
R, Console and Files packages in a disposable native project. Supply existing
`RHO_ARK` and `RHO_R_HOME`; `RHO_R_PLUGIN_PACKAGE`, `RHO_FILES_PLUGIN_PACKAGE`,
`RHO_EDITOR_PLUGIN_PACKAGE` and `RHO_CONSOLE_PLUGIN_PACKAGE` can reuse exact built
packages. Build the current client and Host first. This case selects Editor's
optional R grants explicitly and starts R through Console. It checks formatting
without input evaluation, explicit file save, captured document execution and
Console output, delayed admission during closure, a restored original formatting
comparison, undo and responsive presentation. It does not install R packages,
restart user sessions or establish native input-method acceptance.

The generic draft storage and public content contracts are checked with
`cargo test -p rho-plugins -p rho-plugin-protocol --lib draft --locked`. These
checks cover storage, bounded draft enumeration, captured/accepted chunk leases, version fences and source
references. `cargo test -p rho-host --test plugin_drafts --locked` exercises the
shared Host draft ports: scoped bounded listing/reads/staging, compare-and-swap saves,
discard fences, exact view grants, original replay, failed journal writes,
cleanup failure and original commit recovery after restart and successor edits.
Listing checks cover exclusive pagination after discard, exact source filters,
current metadata after edits, window and caller fences, and no implicit publication
or lease collection. A list is not a snapshot across pages or a claim about edits
that have not reached synchronized storage.
`node scripts/test-plugin-ui.mjs` builds the public UI SDK outside the checkout and
checks frozen captures, verified staging/read transfers, malformed content,
acknowledgement identity, interruptions and view cooperation. The Host draft target
also covers a draining instance's open view flushing large content through original
grants, refusal of another encoding, all-renderer preparation and the final write
fence. The Host target also checks private renderer
release, caller/window/project boundaries, idempotent retirement without state or
sequence changes, prepared/unprepared document loss during closure and last-handler
saved-state recovery. `plugin-frame.test.ts` checks document-local native identities,
hidden/cached document retention, destruction and late/lost registration receipts;
the selected keepalive transport is covered by `host-client.test.ts`. The SDK check
verifies that preparation waits for the original save and
its synchronized reference state. After building the current client and Host,
`npm run test:browser --prefix ui -- plugin-drafts.spec.ts` uses an independent
ordinary view to flush more than 512 KiB while draining, hold the original receipt
before closing, and restore exact Unicode bytes in another view. It seeds bulk
fixture text after checking small normal input; it is not Editor input-performance
or native IME acceptance. `plugin-workspace.spec.ts` retains the general close,
lost-acknowledgement and saved-state recovery regression.
After contract changes, regenerate with `npm run generate --prefix ui` and run
`node scripts/test-plugin-protocol.mjs` for an independent TypeScript consumer.

When one cross-boundary check needs several packages, prefer one Cargo invocation
with multiple `-p` selections and the required target selectors when possible.
Cargo [unifies their dependency features](https://doc.rust-lang.org/cargo/reference/resolver.html#feature-unification),
which can avoid rebuilding the same shared dependency with different feature sets
in consecutive commands. Keep the intended test set and the serial Cargo rule;
this is not a reason to expand a focused check into a workspace audit.

### Test tiers

- **L0 — focused iteration.** Run the nearest test or filter while editing:
  `cargo test -p <crate> <filter> --locked` or
  `npm run test --prefix ui -- <test-file>`. Use this for a local function, model,
  or component change.
- **L1 — affected module.** After behavior settles, run the complete affected crate
  or frontend suite, plus `typecheck` for client changes. Typical commands are
  `cargo test -p rho-r-engine --lib --locked`, `cargo test -p rho-host --lib --locked`,
  `npm run test --prefix ui`, `npm run typecheck --prefix ui`,
  `npm run build --prefix ui`, and `npm run check --prefix ui`.
- **L2 — cross-boundary acceptance.** Use this for Host/Operation/Runtime,
  Contract, recovery, output, Viewer, Plot, Console or document execution changes.
  Run the affected Rust and UI suites, a disposable real-R check, and the relevant
  isolated browser case. Build the current binary before browser tests.
- **L3 — merge/release gate.** Run the complete serial Rust workspace suite and
  all required product checks only for merge, release, or an explicitly requested
  full regression.

### Common L2 commands

For Operation-journal-only changes, use
`cargo test -p rho-sqlite --no-default-features --lib --locked`.
The SQLite `application-store` feature retains generic Application state for Host
builds and ordinary SQLite test commands. Agent/annotation forwarding stores and
Host scientific composition are removed. Plugin-runtime fixtures disable this
feature when they only need the journal. Check the selected closure with
`cargo tree -p rho-plugins --edges normal,build,dev --locked --offline`.
Remaining scientific DTO dependencies and Application storage types still require cleanup.

Scenario metadata changes use `cargo test -p rho-plugins --test package_repository
--locked`, `cargo test -p rho-plugin-protocol --test contract --locked` and
`cargo test -p rho-host --test plugin_scenarios --locked` serially. They cover
immutable history, concurrent head changes, protecting references, visibility and
ordinary external-plugin calls. They do not establish live window switching,
scenario readiness or Plugin Studio interaction acceptance.

HTML widget, Viewer and Plot changes should cover both native and browser paths:

```sh
Rscript --vanilla scripts/test-r-tools.R
RHO_ARK="$PWD/target/debug/ark" \
RHO_R_HOME=/Library/Frameworks/R.framework/Resources \
cargo test -p rho-r-engine --test real_r --locked -- --ignored --nocapture
node scripts/test-viewer-plugin.mjs
npm run test:browser --prefix ui -- r-plugin-viewer.spec.ts r-plugin-plots.spec.ts
```

Runtime/recovery changes should select the affected generic Host, journal and
ordinary backend checks:

```sh
cargo test -p rho-operation -p rho-sqlite --lib --locked
cargo test -p rho-host --test observer --test plugin_restart --test plugin_archives --locked
cargo test -p rho-plugins --test backend_runtime --locked
cargo test -p rho-plugins --lib --test resources --locked
cargo test -p rho-host -p rho-mcp --test plugins --locked
cargo test -p rho-host --lib --locked
RHO_PLUGIN_SET_PACKAGE=/absolute/retained/set node scripts/test-agent-process.mjs
```

Real R acceptance uses disposable projects and explicit bindings. The retained
R backend path is checked with explicit existing
`RHO_ARK` and `RHO_R_HOME` using `node scripts/test-r-plugin.mjs --package DEST`. Native queue changes
also use `cargo test -p rho-r-backend queue::tests --locked`. Session routing changes
use `cargo test -p rho-cli --test session --locked`, including an external plugin
that fills execution/query capacity while transient controls remain responsive.
The real-R acceptance injects an original journal commit fault, verifies FIFO
recovery, failed/pending-cancel pauses and resuming accepted work during draining. The package contains
public SDKs plus R sources outside the checkout; the fixture tests original Operations,
coexisting revisions, cancellation, native stdin and retained resources through
the Host. The input case waits for an actual native prompt, rejects stale identity,
oversized UTF-8 and duplicate answers, then completes the original execution while
its instance drains. The generic Host plugin test separately proves that transient
controls create no journal/result/event entries or direct resource uploads.

The ordinary R engine and shared native helper check is:

```sh
node scripts/test-real-r.mjs
```

For the ordinary R recovery archive, iterate with `cargo test -p rho-r-engine
--lib recovery:: --locked`, then run the engine library cases after changes settle.
`node scripts/test-real-r.mjs --plugin-recovery` selects the focused native
capture/restore/adoption check. Supply existing `RHO_ARK`, `RHO_R_HOME` and
`RHO_CHECKPOINT_HELPER` paths; the helper's adjacent manifest and bytes are verified
before launching R. This mode does not install or build a helper. It creates and
stops disposable sessions and tests exact sessions, pre-start cancellation,
Unicode graph aliases, bounded payload reads, nonempty-candidate refusal and
retained native evidence. `node scripts/test-r-plugin-engine.mjs --recovery`
checks the same native layer from an independent public/plugin source tree.
Archive checks include separate-process lock contention and process exit without
a destructor. For ordinary RPC publication and original-operation authorization,
run `cargo test -p rho-r-backend --locked --offline`, generate the R SDK, and build
an independent package with `scripts/build-r-plugin.mjs DEST --independent`. With that package selected
as `RHO_R_PLUGIN_PACKAGE`, run `node scripts/test-r-recovery.mjs` using the same
three native prerequisites and an already built Host. The test verifies unchanged
Host bytes, optional read grants, pure observations, partial Unicode graph capture,
replacement-provider reads, bounded bytes, payload damage, empty-candidate restore,
pin/delete preconditions, explicit application/discard of uncertain controls,
an uncertain resolution retry, unchanged original outcomes, post-commit cleanup,
retained metadata and explicit reconciliation of a capture whose public output
was rejected by the core. Capture-disposal cases cover confirmed original-provider
release, stale previews, partial graph/metadata files, lost commit after removal,
fresh explicit confirmation, intact adopted copies and original outcomes. Set `RHO_OLD_R_PLUGIN_PACKAGE` to an existing prior
version-1 recovery package to also verify it refuses version-2 control history.
The test-owned fault proxy preserves registered contracts and native evidence;
it changes only returned plans. The test uses
disposable projects and native sessions and preserves failed evidence. It does not
establish Studio recovery UI.

Skipped or unavailable real-R, browser, external-provider, and environment checks
are not passes. Run them only with their documented prerequisites; preserve the
failure log when the prerequisite is missing.

The ordinary Help package uses `node scripts/test-help-plugin.mjs` for independent
model/connection/static-content checks and the isolated `help-plugin.spec.ts` browser
case. `node scripts/test-r-help.mjs` reuses `RHO_R_PLUGIN_PACKAGE`, builds Help and runs its disposable
native browser case with explicit `RHO_ARK` and `RHO_R_HOME`. An explicitly selected
existing `RHO_R_PLUGIN_PACKAGE` reuses that native artifact when R sources have not
changed; this establishes no new native build. Pass a distinct `--output` directory
to retain each browser run. Help viewing must preserve namespace/search/library
state and must not create scientific execution records.

The ordinary Packages package uses `node scripts/test-packages-plugin.mjs` for
independent source compilation and model/connection/navigation checks, and
`packages-plugin.spec.ts` for the approved responsive inspection, explicit source
links and capture-before-Help flow. `node scripts/test-r-packages.mjs` assembles
Packages and Help and runs the disposable native cross-package path. It has the
same explicit Ark/R prerequisites and optional unchanged R-package reuse as Help.
Its navigation receipt must identify the original selected copy, provider and
session. Closing either view must preserve the native R session.

The independent Plots package is built and checked with
`node scripts/test-plots-plugin.mjs`; `plots-plugin.spec.ts` covers its isolated
presentation. `node scripts/test-r-plots.mjs` builds the UI outside the repository
and runs the native PNG acceptance with explicit existing `RHO_ARK` and
`RHO_R_HOME`. Set `RHO_R_PLUGIN_PACKAGE` to reuse a previously verified native
package without invoking Cargo. Native Packages and Plots checks use the generic
window, including newly opened Help and pinned comparison tabs. A written fixture
is not a passing result; current executed evidence is in Status.

### Optional workspace audit

The complete workspace audit is intentionally not part of every development
completion. Run these commands serially for a release, a periodic audit, or when
the user explicitly requests the full workspace result:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
cargo build --locked
```

The workspace command uses incremental compilation, but it still executes every
workspace test target. `--test-threads=1` makes tests serial within each target;
it does not restrict the run to crates changed by the last edit. A time-budget
limit or an incomplete audit therefore does not block normal completion when the
affected-module and cross-boundary checks have passed.

### Timeouts and reporting

Treat a long idle compiler or a test stuck before its first output as a diagnostic
event. Inspect its process state and existing log; distinguish compilation,
executable startup, and test-body time before changing code. Do not start another
build, clear Cargo caches, or restart a scientific Host to hide the delay. Preserve
incomplete evidence, continue independent work, and resume only the affected stage
with its retained artifact when appropriate.

If the compiler spends time scanning `target/debug/deps`, measure its entry count
and listing time before invalidating cached libraries. Repeated/interrupted builds
can leave large numbers of loose `*.rcgu.o` files alongside final artifacts.
Cache maintenance requires all Cargo/rustc processes to be stopped. Preserve the
original directory; retain final libraries, metadata, dependency files and
executables with their identities and permissions, as well as `incremental/`,
`build/` and fingerprints. On macOS, the default unpacked debug information can
reference loose objects: inspect existing native artifacts' `N_OSO` debug maps
and retain every referenced object, not only the linked executables. Objects in
an `.rlib` archive remain embedded in that archive. Verify native debug references
and a focused build before removing any retained data.
If enumeration stalls again despite a bounded entry count, a fresh directory of
same-inode hardlinks can preserve all files while replacing the directory itself.
Keep its backup and preserve relative symlink resolution; do not remove debug
objects merely to reduce the count. Record before/after listing and build times.
This is an exceptional recovery step, not a per-build scan or permission to clear caches. A fast directory listing alone does not establish that
native loading or an acceptance flow passed.

A test process that reaches its time budget is **incomplete**, not passed. Record the
last completed target and retain its log. Do not turn an ignored, skipped,
unavailable, or timed-out check into a pass by rerunning a narrower command; report
the two results separately. Compare a failure with a pre-change baseline before
attributing it to the current edit.

A completion report should list:

```text
Implementation: affected owners and user-visible behavior
Focused checks: exact commands and results
Cross-boundary checks: exact commands and prerequisites
Workspace audit: passed, incomplete, or not run
Unresolved: failures, ignored checks, timeouts and their evidence
Workspace: unrelated changes preserved; commit status
```

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

## Object viewer acceptance fixtures

The object viewer uses `react-data-grid` with React 19. Real native-storage checks
in `scripts/test-r-objects.R` require Matrix and SingleCellExperiment in addition
to the existing jsonlite/rlang bridge providers; tests never install them. Use
`node scripts/test-real-r.mjs` for the ordinary R engine and shared native helper fixtures; ordinary-plugin acceptance is separate. The Studio browser
scenario exercises a real 501-row table, Unicode text, array slices and SCE assay
storage. Check ordinary/wide/constrained layouts and copying, not only snapshots.

## Checks

| Change or verification need | Closest entry point |
| --- | --- |
| Rust behavior | `cargo test -p <crate> <filter> --locked` |
| Shared capability contracts and result validation | `cargo test -p rho-contract --locked`, then `cargo test -p rho-operation --locked` |
| Application windows, captures and CAS receipts | `cargo test -p rho-application --locked`, SQLite tests and the ordinary Editor/Agent plugin draft and input checks |
| Frontend model/component behavior | `npm run test --prefix ui` |
| Client types and embedded assets | Generate, build, then check as above |
| Studio interaction and real local R | `npm run test:browser --prefix ui` |
| Rust architecture/dependency ownership | `node scripts/check-architecture.mjs` |
| Component assistant Studio | `npm run test:browser --prefix ui -- agent-workspace.spec.ts agent-rho-tools.spec.ts` with retained packages; local model fixture, native context, attachments and recovery |
| Component Agent integration | `cargo test -p rho-agent-engine --locked` for Rig HTTP/SSE; retained-package `test-agent-process.mjs` and ordinary Agent browser checks for Host integration |
| Frontend ownership and dependency boundaries | `npm run check:boundaries --prefix ui` and `npm run test:boundaries --prefix ui` |
| Vendored Jet snapshot / verifier | `node scripts/vendor-jet.mjs check` and `node scripts/test-vendor-jet.mjs` |
| Documentation/map only | `node scripts/governance.mjs check` and `node scripts/test-governance.mjs` |

The ordinary Agent browser suites use explicit retained package selections and a
local model-protocol fixture. Their prerequisite map is documented with the Agent
plugin checks above. No browser case may silently select a fixed scientific shell.
Keep credentials out of tracked files and command logs, and use a distinct
Playwright `--output` directory to preserve evidence.

Broader Rust checks, run sequentially when affected:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
```

Live model diagnostics belong to the public `rho-agent-engine` `provider_probe`
example. They are opt-in and require explicit model configuration; never record
credentials. The removed fixed Host probes and 33-case harness are not current
acceptance entry points. Ordinary Agent/R checks use disposable projects and local
model fixtures; they do not establish live-provider quality.

Native/transport verification:

| Script | Scope and prerequisites |
| --- | --- |
| `test-real-r.mjs` | Installed Ark/R; ordinary R engine and shared R helper checks. Fixed Host/CLI tests are retired; `--agent` and `--plugin-recovery` select their focused ordinary-plugin boundaries. |
| `test-r-checkpoints.mjs` | Installed R with jsonlite; builds the private native checkpoint component for that R, then exercises the classifier and a capture/cold-restore round trip in disposable `--vanilla` processes. `--print-library` prints the component path for `RHO_CHECKPOINT_HELPER` |
| `npm run test:browser --prefix ui` | Current `cargo build --locked` binary. Ordinary-plugin cases use explicit package/runtime selections; `scientific-workspace.spec.ts` requires either `RHO_SCIENTIFIC_PACKAGES` or `RHO_SCIENTIFIC_PLUGIN_SET`, plus `RHO_ARK` and `RHO_R_HOME`. Fixed-renderer browser specs have been retired with that implementation. Run the affected cases, not every fixture during iteration. |
| `test-workbench.mjs` | Generic HTTP/MCP/connected CLI, empty-scene checkpoint idempotency, state CAS, request bounds and project fencing; accepts `RHO_TEST_BINARY=/absolute/current/rho` to skip all builds. Scientific cancellation/disconnect checks belong to the ordinary Process/R/Agent suites. |
| `test-mcp.mjs` | Generic stdio MCP, schema portability, query purity, principal visibility, checkpoint idempotency across Host restart and frame bounds. `RHO_TEST_BINARY=/absolute/current/rho` skips builds. |
| `test-deepseek-inbox.mjs` | Checks the installed, lock-matched native Inbox replay/clear implementation with a disposable journal; no provider calls or session scan |

Interactive Rho integration checks need a disposable analysis project outside the Rho
checkout's ancestry, so the native Agent does not inherit repository-development
AGENTS.md instructions. Use a real analysis, verify its captured Editor script,
original R operation and retained Plots media in the same live window. A successful
greeting does not establish this integration. The retired fixed MCP/R runner formerly covered
model-readable invalid arguments and prompt acceptance behind a failed-run queue
pause, including duplicate-request identity and explicit queue recovery.

These scripts live in `scripts/`. R tests accept `RHO_ARK` and `RHO_R_HOME` where
applicable. Ignored or unavailable checks are not passes; optional third-party Agent
observations are separate from required Rho checks and do not block their completion.
The generic shell scenarios are in `ui/e2e/plugin-startup.spec.ts` and `ui/e2e/plugin-workspace.spec.ts`, with their own disposable Hosts.
Keep independent suites isolated rather than raising the product's retained-window
budget for tests. Geometry checks wait for ResizeObserver layout to settle.

Playwright uses isolated Chrome and disposable projects; build the current client
and `rho` binary before running it. Keep real interactive workbench sessions in
the integration checkout, separate from disposable test projects.

The approved workspace Agent task UI is in Design section 13. Focused Chrome tests
are `ui/e2e/agent-workspace.spec.ts`; local native protocol fixtures never call a model.
Rho acceptance covers connection identity, protocol delivery, permission handling,
drafts, original receipts, Rho's recovery behavior and faithful native-usage display.
Deterministic protocol fixtures and HTTP/browser tests can establish these contracts.

Third-party Agent capabilities, answer quality, image recognition and each platform's
independent lifecycle belong to that platform. Rho does not independently qualify
Codex, Kimi or DeepSeek. A Kimi image answer is not a completion gate for Rho;
image tests at this boundary verify the bytes, metadata and references Rho delivers.
Missing native text or usage stays missing, and a native end-of-turn is not evidence
that a requested answer or scientific result exists.

For isolated ordinary Agent recovery, build the current Host and run:

```sh
RHO_PLUGIN_SET_PACKAGE=/absolute/path/to/retained/plugin-set node scripts/test-agent-process.mjs
```

This reuses the selected archives and runs a local ACP peer, original tool/Send
receipts, cancellation and same-instance Host restart. No real provider is called.
The fixed HTTP scripts `test-agent-task-recovery.mjs` and `test-agent-clients.mjs`
were deleted with their endpoints. Prior raw logs and failed attempts remain
historical evidence; retiring a check does not turn an old failure into a pass.
The reviewed Kimi adapter source was tag `@moonshot-ai/kimi-code@0.41.0`, commit
`95478e8c7ba248fd2470d5bb151555ec7fedd19d`; that provenance does not certify the
third-party product or require its current models to pass an independent evaluation.

## Contract and source changes

The R owner source is under `plugins/r/api` and `plugins/r/backend/engine`.
Iterate with `cargo test -p rho-r-engine --lib --locked`; after changes to its public
types, cover `rho-r-backend` and any surviving `rho-contract`/`rho-operation`
consumers and regenerate their public/client contracts. `node scripts/test-r-plugin-engine.mjs`
constructs a standalone tree outside the checkout and runs the native owner's
unit tests with no private core source. Add `--real-r` with explicit `RHO_ARK` and
`RHO_R_HOME` to run its disposable native acceptance. These checks invoke Cargo;
run them serially with all other Cargo and generation commands. The script keeps
pinned dependency versions from the existing lock and resolves offline; it does
not install tools. The existing `node scripts/test-real-r.mjs` suite verifies the
ordinary R engine and shared native helpers; use retained-package browser/Host
suites for the real plugin composition.

The public plugin contracts live in `crates/plugin-protocol` and generate the
standalone `sdk/plugin-protocol` TypeScript/schema package through the same
`npm run generate --prefix ui` command. Public packages must not depend on private
Host/Studio modules. Plugin source is snapshotted before use; import, inspection
and validation must never invoke a build recipe. Focused foundation checks are
`cargo test -p rho-plugin-protocol --locked`,
`cargo test -p rho-plugin-sdk --locked` and `cargo test -p rho-plugins --locked`.
For runtime iteration use `cargo test -p rho-plugins --test backend_runtime --locked`
and `cargo test -p rho-host -p rho-mcp --test plugins --locked`.
Its `operation_bridge` filter exercises the actual process through the generic
Operation/Query gateways and SQLite journal: fixed preflight qualification,
principal/revision containment, removal during execution, cancellation,
invalid candidates, crash without replay and original-record cleanup.
Registry changes also require `cargo test -p rho-operation --lib --locked`;
shared Operation DTO changes require affected journal/Host checks and generation.
Its external Python fixture exercises actual independent processes and requires
Python 3 on PATH. `node scripts/test-plugin-backend.mjs` copies the public Rust
crates outside the repository and compiles the example with no private source;
it invokes Cargo, so run it serially with every other Cargo command. Public
TypeScript consumption is checked by `node scripts/test-plugin-protocol.mjs`.
Capability-grant changes require both `plugin_self_requirements` and
`plugin_optional_requirements` Host tests. The optional case covers activation
without an available optional provider, explicit exact selection, invalid scopes,
unchosen grants and current-parent intersection when a view calls the Host.
The protocol's optional requirement tests also check combined declaration bounds,
duplicate versions and unchanged serialization when no optional entry is present.
R-owned public declarations and capability schemas are generated with
`node plugins/r/generate-sdk.mjs`; use `--check` for freshness and
`node scripts/test-r-protocol.mjs` for a strict independent TypeScript consumer.
The generator invokes Cargo and runs serially. Generate before backend checks so
the transport-routing test checks the current contributed manifest. R Console protocol changes require
`cargo test -p rho-r-api -p rho-r-backend --locked` and the existing real-R
`node scripts/test-r-plugin.mjs --package DEST`, whose Console fixture checks parser nonexecution,
source retention, visible Console output, live event pagination during stdin,
pending cancellation and exact instance boundaries. Full Application document
capture and Console UI acceptance remain separate migration work.
The ordinary R formatting capability has a separate native check:
`RHO_ARK=/absolute/ark RHO_R_HOME=/absolute/R/home node scripts/test-r-format.mjs`.
It requires the existing `styler` package, builds the R package outside the checkout,
and exercises the unchanged Host in a disposable project. It checks explicit
session selection, nonexecution of input, restored formatting options, exact
retained large results, original-request replay, syntax failure and pending
cancellation. Set `RHO_R_PLUGIN_PACKAGE` to reuse an already assembled package;
the default build invokes Cargo and must run serially. Failed native evidence is
retained; only the fixture's own Host is stopped. Editor application of the result
and later-edit protection require their separate UI acceptance.
R inspection changes use the same native acceptance: its inspection fixture reads
object directories and table continuations, refuses foreign/expired references,
reads Packages and Help from one observed copy, and verifies that queries neither
force active/lazy bindings nor change loaded namespaces, search paths or library
paths. The fixture explicitly loads its test prerequisite before taking the
read-only baseline. It also checks busy/unstarted behavior and unchanged Operation
history. Public declarations alone do not establish those native results.
The combined `scientific-workspace.spec.ts` continuity case holds a real layout-save
reply while checking that the close button stays in place, then closes/reopens
Console and Editor while the same R operation remains running. Routine saving
indicators must not reflow the window or intercept pointer input.
The native Console browser case also checks `r.inspection_state`: short runs and
failed scripts with prior object mutations invalidate cached inspection data,
while read-only queries preserve the key. The backend's manifest-to-route test
checks that every declared query/operation reaches the proper transport handler.
Generic window layout changes use the `rho-plugin-protocol` and `rho-plugins`
library checks, followed by `cargo test -p rho-host --test plugins --test
plugin_workspace --locked`. These cover bounded layout structure, scoped view
references, expected versions, original request replay and retained closed views
after package removal/restart. They do not establish a visual window shell,
scenario switching, or iframe drag/focus behavior; those need their own browser
acceptance once assembled. The independent `plugin-layout.spec.ts` browser fixture
checks retained opaque iframe documents/input while tabs move, hide, resize and
restore from saved layout. Its close gesture must reach the owner callback without
removing the frame. It does not exercise Host persistence or close-time flushing.
The `plugin-layout`, `plugin-frame-layer`, `plugin-window-state` and
`plugin-window-client` unit checks cover protocol conversion, fixed DOM order,
versioned saves, lost acknowledgements and original Operation outcomes. The
`plugin-window-views` and `plugin-window-close` checks add scoped connections,
retained hidden documents, confirmed closure and retries of the original request.
`plugin-workspace.spec.ts` exercises the generic `?plugin-window` composition with
real Host ports and an independently built fixture package. It checks automatic
placement, retained drafts, close refusal, lost-close acknowledgements and explicit
saved-state recovery after both a flush refusal and a missing handler. This
entrypoint is under integration; the final default scenario replaces the fixed
shell after all feature packages are available.
`node scripts/test-objects-plugin.mjs` compiles the in-progress Objects model and
React components in a fresh external directory using public R/plugin declarations,
the UI SDK and existing locked tools. It covers directory/reference bounds,
stale/busy behavior, independent expanded-view demands, exact vector copying,
reservation before collection, native confirmation and scalar/color/field semantics.
Connection checks cover exact restored session/provider binding, busy deferral,
owner cache invalidation, failed state saves and reverting edits during a save.
It does not start R or establish a working plugin view; native and browser acceptance remain
separate checks when that package is assembled.
`node scripts/test-plugin-ui.mjs` compiles the public UI SDK outside the checkout
and exercises its channel using real MessagePorts. After client generation/build
and `cargo build --locked`, use `npm run test:browser --prefix ui --
e2e/plugin-view.spec.ts` for the independent UI-only package, opaque iframe,
scoped reads, state persistence, Unicode input and revocation. It also verifies
native text copying, delayed collection beyond transient activation, refusal of
automatic/direct iframe writes, and no clipboard replacement after failed
collection or view closure. Clipboard-read permission belongs only to that
disposable browser context while asserting known text; clear the permission
override before the next user action so it cannot deny normal writes. The fixture
uses a disposable project, not a user's active scientific session, and retains
its project on failure. `ui/tests/plugin-clipboard.test.ts` separately checks
reservation expiry, bounds and native refusal.
`plugin-resource-download.spec.ts` uses independently built ordinary UI/backend
fixtures and real Host ports to check scoped original-byte downloads, Unicode
filenames, unchanged Operation history, automatic-action refusal and closure
during collection. `plugin-download.spec.ts` checks the browser download primitive
and checksum refusal without establishing Host admission. The Plots native case
separately checks original PNG export before and after releasing its R provider.
`node scripts/test-viewer-plugin.mjs` independently builds the ordinary Viewer and
checks original Operation/resource identities. `node scripts/test-r-viewer.mjs`
requires explicit existing `RHO_ARK`, `RHO_R_HOME`, retained `RHO_R_PLUGIN_PACKAGE`, the R package `DT`, Chrome and a
current `target/debug/rho`. It builds only Viewer outside the checkout, then runs
`r-plugin-viewer.spec.ts` with disposable native sessions and unchanged core binary
hashes. It never starts Cargo or rebuilds the retained R package. The browser case covers interactive retained HTML, separate R
revisions, history/refresh, closure during execution, removal/restart recovery and
normal/wide/narrow screenshots. Inspect those screenshots before claiming visual
acceptance; programmatic Unicode input does not verify native IME composition.
These do not replace later real-science and
iframe/browser acceptance for the full migration.

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

## Optional external-client observations

Ordinary Agent task recovery uses the retained-package checks above. For any
separately requested real-provider investigation, use a disposable plugin instance
and a model reported by that installation. Preserve configuration and failed
attempts. A native end-of-turn alone does not prove an answer, image interpretation
or token usage being reported.

The old Codex runner depended on the removed fixed Workbench profile and private
Application/scientific contracts. It and its parser-only CI check are retired.
Historical result artifacts remain evidence of their original commit only. Current
scientific/Agent flows use ordinary package fixtures documented above; none of those
fixtures establishes new third-party model quality. New external-client experiments
must use ordinary plugin capabilities and preserve their actual tool/operation
records, with explicit model scope and no prescribed answer or forced tool sequence.

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
integrity and regression checks on macOS arm64, the current CI target.
