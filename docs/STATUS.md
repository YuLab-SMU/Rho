# Rho: current state and focus

Updated: 2026-09-28. This is the single current status summary: current behavior,
the evidence that still applies, open problems and the next milestone. Git and
`target/` logs retain history, failed attempts and superseded evidence; do not copy
them here. Keep this page under about 300 lines (see [Development § Status
discipline](DEVELOPMENT.md#status-discipline)).

## Current focus: unified plugin refactor

The user authorized the entire unified-plugin plan on 2026-09-23: all scientific
owners and views as ordinary plugins, coexisting versions, project scenarios,
public SDKs and Plugin Studio as an ordinary plugin. PS01–PS07 are approved in
Paper; see [Design section 21](RHO-DESIGN.md#21-unified-plugins-and-plugin-studio--approved).

**The fixed scientific composition is still present.** Ordinary packages exist
for R, Files/Git, Process, Remote, Environment, Editor, Console, Objects, Packages,
Help, Plots, Viewer, Manager, Studio and Agent (`plugins/`). Each has individual
acceptance evidence. The complete replacement is not established: final scenario
integration, cross-plugin workflows, default delivery and removal of the fixed
composition remain.

### Work order (reset 2026-09-28)

Work is organized as end-to-end user flows. A milestone is complete when its flow
works in the ordinary plugin composition, its heavy acceptance has run once on the
settled source, and the fixed-composition path it replaces is deleted or has a
written deletion condition. Internal pieces are not reported as milestones.

| # | Milestone (user flow) | Replaces / deletes | State |
| --- | --- | --- | --- |
| M1 | **Default plugin scenario as the primary composition.** `rho` opens a project in the ordinary plugin window with R, Console, Objects, Files, Editor, Plots, Viewer, Packages, Help active; Run File → Objects/Plots works with real R. | Fixed scientific panels for those views become unused in the default path | Ordinary scientific flow verified; default entry implemented, native/browser checks pending; delivery remains |
| M2 | **Ordinary Agent view, first vertical slice.** Open Agent view → pick a document or file attachment → Send → native tool calls a real R/Files plugin → results shown → browser reload finds the original record. | Fixed Agent panel in the default scenario | Backend done; view not started |
| M3 | **Actual Host restart recovery.** Restart the generic Host during M2's flow; the same instance/task recovers its original records without replay. | — (risk reduction; do early) | Same-instance lifecycle recovery missing; not verified |
| M4 | **Agent context and continuation.** Contributed context sources (help, viewer, annotations, documents), component input and continuation through the ordinary backend. | Application-side Agent context composition | Not started |
| M5 | **Studio Agent assistance.** Exact development branch capture; separate checkpoint, build, preview and scenario-application actions. | — | Branch checkpoint via Agent verified; Studio UI not started |
| M6 | **Final composition.** Default delivery through the same repository/lifecycle, all feature plugins removable, no silent reinstall; remove fixed registrations, panels and scientific/Agent branches; full-plan acceptance matrix. | All remaining fixed composition | Not started |

M1 is deliberately first: the ordinary scenario must become the integration target
before more Agent surface is built, so composition problems surface continuously.
M3 is pulled forward because it is the least certain boundary.

### Scientific scenario: current integration

The ordinary Manager now provides **Scenarios → New R workspace**. It selects
installed exact artifacts for nine scientific plugins and existing Ark/R paths,
activates their instances, saves a checkpoint and prepares their views. Switching
the window and starting R are separate explicit actions. Files passes its captured
R provider to newly opened Editors; Help has an initial empty view until a package
is selected. Lost preparation receipts retain the original requests and instances;
recovery does not replay them or continue later stages automatically.

Verified with a disposable generic Host and real R: Manager preparation/switch →
Console Start R → Files opens a Unicode-named file → Editor Save and Run → original
Console output, Objects value and Plots image. Browser reload preserves the native
session and the single original execution. Setup and result screenshots were
inspected; the Manager dialog also passed normal, wide and constrained layouts.
`target/plugin-refactor/scientific-workspace-results.json` records the checks,
artifact reuse and limits; browser evidence is retained beside it. Current R and
Editor native artifacts were reused, and Files was built once through the primary
workspace cache. This is integration evidence, not a new independent-source build.

Default entry is now implemented in source: `rho workbench` selects the ordinary
plugin profile, accepts project selection in the browser, and offers installed
standalone UI views in an empty window. Opening a view retains its original
activation and view requests before dispatch. The startup model/window checks
pass (25 frontend cases), including no fixed Studio construction in ordinary
startup; the updated native Host and browser path remain pending.
Existing fixed-composition acceptance explicitly uses `--fixed-workspace`. Remove
that temporary reference and shell after M2–M4 replace the remaining fixed flows;
missing plugins cannot select it as a fallback. Default package delivery remains.

Restart recovery needs implementation, not just another acceptance run: current
Host drain closes views and releases instances; released identities cannot be
resurrected. Separate confirmed Host suspension from explicit instance release
before claiming same-instance/task recovery. Browser reload evidence does not
cover that boundary. No user Host was replaced, installation or publication ran.

### Agent migration: current state

Implemented in `plugins/agent` (public APIs/SDK only, no private core imports):

- Transport, native/component task owners, credential/metadata storage and the Rig
  driver. One Agent-owned `agent-v1.sqlite` repository; no old-table reads, no
  second scientific journal. Development checks have not opened user keys.
- Ordinary backend: metadata, task create/draft/rename/archive, controller
  takeover, model settings/diagnostics, scoped credential Control, component model
  runs, native task commands, attachment Control and original-request observations.
- Native Send captures explicit Query/Operation targets and scopes. Optional grants
  cover 83 public R, Files, Process, Remote, Environment and Editor contracts plus
  31 native management contracts (not Control/Runtime). Tool requests are durably
  admitted before dispatch; later turns, Stop and dropped observers cannot redirect
  or replay them. Unverified or oversized replies stay uncertain. All scientific
  results commit through core Operation.
- Management tools freeze project, capability and caller-chosen fields including
  the development branch; exact-branch checkpointing through Agent is verified.
- `agent.native.assets.import` reads a controlled resource up to 8 MiB through an
  explicit `resources.read` grant, checks ranges/length/digest, and retains the
  original receipt; repeats observe the original. Inline attachments stay ≤ 524288
  encoded bytes per Control.

Not done: browser file capture/staging, ordinary Agent views, contributed context
and component input/continuation, actual Host restart recovery, Studio Agent flow.
Synthetic peer tests for Process/Remote/Environment do not establish actual
execution through those plugins.

Current Agent evidence (`target/plugin-refactor/`): `agent-assets-results-v3.json`
and `agent-assets-combined-v1.json` (20 owner, 35 store, 42 framed backend cases,
five frozen-Host cases including a real 8 MiB resource-channel import),
`agent-core-combined-v2.json` (management tools, checkpoint case), and
`agent-native-tools-combined-v1.json` plus `agent-native-tools-native-rerun-v2.json`
(component and native real-R normal/Stop fixtures). No real-model quality, browser,
full-workspace, installation or publication check ran for these changes.

### Plugin platform: implemented behavior

- `rho-plugin-protocol` defines package, revision, instance, provider, scenario,
  visual-document and RPC contracts; `rho-plugins` owns immutable source/artifact
  identities, archives, transactional import/export, branch CAS and repository
  pages. `rho plugins --store ...` works without a scientific Host. Nothing is
  activated or reinstalled implicitly; native builds are explicit trusted code.
- Backend instances run immutable artifacts in separate processes with exact
  readiness before atomic contribution publication. Framed RPC checks identity,
  order and parent authority for reverse calls. Cleanup needs acknowledgement and
  process exit. Queries never restart failed or historical instances.
- The plugin bridge uses the existing Operation/Query gateways and SQLite journal.
  Repeating an accepted request returns the original record without re-execution.
  `operation.commit_status`/`reconcile_commit` expose explicit recovery.
- Optional capability grants are selected at activation; Send/call sites select
  within them.
- `--plugins-only` opens the generic package/window/Operation workspace without
  discovering R or falling back to fixed composition. It does not complete default
  delivery.
- Studio: visual/source editing, native `plugins.build`, fixture `plugins.preview`,
  disposable backend test projects (`plugins.test_create/test_stop`), named
  scenario checkpoints, `scenarios.prepare/apply` window application, archive
  import/export/download. Manager: composition, import/export, activation.
- Generic window: synchronized drafts, cooperative multi-document closure,
  renderer retirement, original-request recovery, scoped download admission.
- Scientific plugins: R owner (execution, objects, packages, help, checkpoints and
  recovery copies with capture/restore/pin/delete/cleanup/reconcile), Files/Git,
  Process (local + explicit reconciliation), Remote, Environment (21 capabilities,
  explicit R binding), Editor drafts, Console with read-only submission recovery,
  Objects with explicit set-aside, Packages, Help, Plots with original export,
  Viewer.

Per-plugin checks are mapped in `governance/source-map.json`; run
`node scripts/governance.mjs impact --changed-auto` for the affected set.

### Known open problems

- Plugin backend native initialization occasionally exceeded ten seconds before
  reaching the program entry (Studio backend browser runs); cause not established.
  Treat a repeat as an infrastructure issue to investigate, not a product pass.
- Older standalone frame pointer-routing failure remains separate from the passing
  generic-window pointer checks.
- Abrupt browser disposal cannot establish that unacknowledged edits were saved;
  recovery stays explicit.
- Unfiltered offline `cargo metadata` fails on an uncached dependency
  (`combine 4.6.8`); host-filtered metadata passes.

### Restart boundary

Existing user Hosts and R memory have not been restarted by this work. New Host
capabilities require the rebuilt binary; a client refresh alone cannot add them.
New plugin revisions need explicit package snapshot/activation; existing instances
keep immutable assets. Inspect live work before any separately authorized
replacement. All native acceptance uses disposable projects and explicit Ark/R.

## Established product surfaces (fixed composition)

These are implemented in the current fixed composition and remain the reference
behavior that the plugin composition must preserve. Details live in Design,
Architecture and Git history.

- **Demo project.** Welcome page and `rho --demo-project workbench` materialize a
  writable base-R Gapminder project; opening it does not run R, install packages or
  contact an Agent.
- **Console safety.** Console, Run Selection and Run File share a per-session
  submission gate and R parser preflight. Transport loss fences the session and
  keeps the uncertain Operation. `print.htmlwidget` produces retained `text/html`
  artifacts shown in Viewer.
- **Help, Viewer, annotations.** Help reads exact-copy Rd as text/HTML; Viewer
  captures `viewer(url)` with inlined assets; annotation storage/service exist.
  Not implemented: Studio annotation UI, lighter chrome (HV01–HV07), Viewer
  "Open in system browser", Help in-topic anchors. AN01–AN05 and HV01–HV07 await
  user visual review ([Design 19](RHO-DESIGN.md#19-r-help-interactive-viewer-and-lighter-controls--proposal),
  [Design 20](RHO-DESIGN.md#20-component-annotations-for-people-and-agents--proposal)).
- **Multiple R sessions and recovery copies.** R04–R10 implemented
  ([Design 17](RHO-DESIGN.md#17-sessions-and-recovery--approved-interaction));
  R01–R03 remain proposals. Restart/Stop/Quit report consequences in one panel;
  Quit is the protected shutdown path (raw Ctrl-C does not guarantee a fresh copy).
  Two different R installations need `RHO_ALT_*` and remain opt-in.
- **Shell.** 48/168 px navigation rail, 30 px footer with pinned CPU/memory/disk
  metrics ([Paper S01–S04](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/8-0)).
- **Objects.** O07–O10 priority columns and whole-vector viewing; six viewer boards
  with React Data Grid ([Design 14](RHO-DESIGN.md#14-objects--approved-viewing-experience)).
- **Parent-region docking** with shared-boundary targets and Move To.
- **Unified Agent panel** ([Design 13](RHO-DESIGN.md#13-workspace-agent-tasks--approved-interaction),
  [Design 18](RHO-DESIGN.md#18-rho-in-the-unified-agent-panel--review-revision)):
  shared task list/composer for Rho, Codex, Kimi and DeepSeek, IME-safe input, A20
  manual handoff, local key storage, deterministic Ask/Auto/Full access policy,
  task-bound revocable MCP credentials, native phase observations. The 33-scenario
  real-model matrix is defined but has not run.
- **Packages** approved design:
  [Paper](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0), Design
  section 11. Core Packages is read-only.

## Verified baselines

These baselines apply to their recorded source only; later changes need their own
evidence.

- **Agent interface acceptance** at `4bcd3090`: independent Codex 30/30 core and
  4/4 Skills runs passed (`gpt-6-astra`, Codex 0.153.4). Manifest:
  `target/agent-interface/acceptance/4bcd30903b55-1788916155502-8ec26ea9/manifest.json`.
- **Sessions/recovery continuation**: full serial Rust workspace 284 passed (10
  opt-in ignored), 362 frontend tests, 46/46 Chrome cases; input p95 34 ms, frame
  p95 16.7 ms. Evidence `target/runtime-final-checks.json`.
- No live remote-cluster acceptance is claimed; SSH/Slurm are local protocol
  fixtures.

## Delivery scope

Initial installation targets only **macOS 26.5.2 (25F84), Apple Silicon arm64**.
CI and manual binary builds target macOS arm64 only. The native R component is
still an explicit per-machine acquisition, not part of a signed installer. No
installation, signing, notarization or publication has been performed. See
[Build and release](RELEASE.md).

## Operational boundaries

Read [Operations](OPERATIONS.md) before starting another Host; inspect current
ownership and processes rather than reusing old PIDs, ports or tokens. Cargo
invocations remain serial. Native session evidence covers the managed fork/exec
helper family; unobservable processes and missing evidence stay protected.
R package-management UI, abandoned-data migration, installation and publication
remain outside the current scope. The external acceptance runner is test tooling,
not product Agent behavior.
