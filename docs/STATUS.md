# Rho: current state and focus

Updated: 2026-09-29. This is the single current status summary: current behavior,
the evidence that still applies, open problems and the next milestone. Git and `target/` retain history and failed attempts. Keep this page under about 300 lines (see [Development § Status
discipline](DEVELOPMENT.md#status-discipline)).

## Current focus: unified plugin refactor

The user authorized the entire unified-plugin plan on 2026-09-23: all scientific
owners and views as ordinary plugins, coexisting versions, project scenarios,
public SDKs and Plugin Studio as an ordinary plugin. PS01–PS07 are approved in
Paper; see [Design section 21](RHO-DESIGN.md#21-unified-plugins-and-plugin-studio--approved).

**The fixed scientific composition is still present.** Ordinary packages exist
for R, Files/Git, Process, Remote, Environment, Editor, Console, Objects, Packages,
Help, Plots, Viewer, Manager, Studio and Agent (`plugins/`). Each has individual acceptance evidence. Final scenario integration, cross-plugin
workflows, default delivery and removal of the fixed composition remain.

### Work order (reset 2026-09-28)

Work is organized as end-to-end user flows. A milestone is complete when its flow
works in the ordinary plugin composition, its heavy acceptance has run once on the
settled source, and the fixed-composition path it replaces is deleted or has a
written deletion condition. Internal pieces are not reported as milestones.

| # | Milestone (user flow) | Replaces / deletes | State |
| --- | --- | --- | --- |
| M1 | **Default plugin scenario as the primary composition.** `rho` opens a project in the ordinary plugin window with R, Console, Objects, Files, Editor, Plots, Viewer, Packages, Help active; Run File → Objects/Plots works with real R. | Fixed scientific panels for those views become unused in the default path | Default entry, real-R browser flow and Rust HTTP checks pass; delivery remains |
| M2 | **Ordinary Agent view, first vertical slice.** Open Agent view → pick a document or file attachment → Send → native tool calls a real R/Files plugin → results shown → browser reload finds the original record. | Fixed Agent panel in the default scenario | Combined real Host/browser flow passes: Native/Rho input, attachments, real R, reload, continuation and handoff |
| M3 | **Actual Host restart recovery.** Restart the generic Host during M2's flow; the same instance/task recovers its original records without replay. | — (risk reduction; do early) | Graceful Host restart, same instance/view/tasks, original receipts and native session Resume pass without replay |
| M4 | **Agent context and continuation.** Contributed context sources (help, viewer, annotations, documents), component input and continuation through the ordinary backend. | Application-side Agent context composition | Editor/Help/Viewer snapshots, history, Continue and handoff pass real Host/browser checks; Rho exact-session tool selection also passes; annotations and component input remain |
| M5 | **Studio Agent assistance.** Exact development branch capture; separate checkpoint, build, preview and scenario-application actions. | — | Combined real Host/browser flow passes: exact-branch Agent checkpoint, explicit build, preview and scenario application |
| M6 | **Final composition.** Default delivery through the same repository/lifecycle, all feature plugins removable, no silent reinstall; remove fixed registrations, panels and scientific/Agent branches; full-plan acceptance matrix. | All remaining fixed composition | Not started |

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

Default entry is implemented: `rho workbench` selects the ordinary plugin profile,
accepts browser project selection and offers installed standalone views in an
empty window. It retains activation/open requests before dispatch. The 25 frontend
startup cases, three CLI cases, four default-entry/window browser cases and two
Rust HTTP cases pass. The real-R flow uses browser project/Manager selection and
recovers a lost activation reply without duplicating the instance or execution.
Current client generation, build/check and the embedded Host rebuild pass.
Evidence: `target/plugin-refactor/default-entry-results.json`; interrupted broader
CLI checks and earlier startup failures remain retained, not passes.
Existing fixed-composition acceptance explicitly uses `--fixed-workspace`. Remove
that temporary reference and shell after M2–M4 replace the remaining fixed flows;
missing plugins cannot select it as a fallback. Default package delivery remains.

Restart lifecycle is now implemented in source: normal Host drain suspends exact
runtime instances after acknowledged native cleanup, preserving original grants,
contained data and acknowledged view/layout identity. Explicit `plugins.resume`
consumes that suspension token; `views.reconnect` separately creates a fresh
connection for the retained open view. Queries do neither. Permanent release and
disposable-test teardown remain distinct. Stale tokens, changed authority/data and
unconfirmed cleanup have refusal fixtures. A publication conflict during resume
preserves the original instance with a new confirmed suspension token.
The generic window and Manager's instance details save recovery requests before dispatch; lost replies offer
explicit inspection/retry of the original request, with no next-step dispatch on
reload. All 566 core frontend tests pass, including 42 recovery/view cases. The focused
native current-source run passes all four suspension cases, including publication
conflict (34m11s compilation, 1s tests); the earlier pre-fix failure remains in evidence.
Host-reopen, workspace and disposable-test Host checks now pass (10 cases);
public/core generation, client build/check and Manager restore/model checks pass.
Actual graceful Host restart restores the same Agent instance/view, Native/Rho
records, attachments and handoff receipt without replay. An explicit Agent-owned
`kimi_home` supplies the same native directory to discovery, launch and exact-session
Resume without widening Host environment inheritance. The original native session
resumes with zero prompts; Manager restores R without starting its native runtime.
The complete browser flow passes in 2.3 minutes; earlier failures remain retained.
Detached tabs read scoped contribution names; 36 recovery/window checks pass.
Evidence: `target/plugin-refactor/agent-workspace-current-results.json`. No user Host was replaced or package installed/published.

### Agent migration: current state

Implemented in `plugins/agent` (public APIs/SDK only, no private core imports):

- Transport, native/component task owners, credential/metadata storage and the Rig
  driver. One Agent-owned `agent-v1.sqlite` repository; no old-table reads, no
  second scientific journal. Development checks have not opened user keys.
- Ordinary backend: metadata, task create/draft/rename/archive, controller
  takeover, model settings/diagnostics, scoped credential Control, component model
  runs, native task commands, attachment Control and original-request observations.
- Native Send captures explicit Query/Operation targets and scopes. Optional grants
  cover 87 public R, Files, Process, Remote, Environment and Editor contracts plus
  31 native management contracts (not Control/Runtime). Tool requests are durably
  admitted before dispatch; later turns, Stop and dropped observers cannot redirect
  or replay them. Unverified or oversized replies stay uncertain. All scientific
  results commit through core Operation.
- Management tools freeze project, capability and caller-chosen fields including
  the development branch; exact-branch checkpointing through Agent is verified.
  Studio now prepares an ordinary Agent draft with that branch/checkpoint and six
  bounded tools. Model/renderer checks pass for lost view receipts, one-time draft
  insertion and 1440/960/440/390/220 layouts. The real Host/browser flow now passes
  checkpoint → explicit build → preview → scenario application in 56 seconds. It
  retains the old instance/other branch; screenshots were inspected. Toolbar actions wait for initialization.
- `agent.native.assets.import` reads a controlled resource up to 8 MiB through an
  explicit `resources.read` grant, checks ranges/length/digest, and retains the
  original receipt; repeats observe the original. Inline attachments stay ≤ 524288
  encoded bytes per Control.
Native/Rho captures previews and bounded history without inheriting tool authority;
Check tool outcomes and Continue retain providers and reuse confirmed results.
Ordinary handoff source/target/receipt/append APIs now reuse the atomic draft owner in source,
with exact view control and reference checks. Renderer, framed native and actual
Host/browser checks pass, including lost receipts recovered after Host restart.
The ordinary native/Rho task view is implemented in source: shared task selection,
creation, draft CAS/conflicts, Send/Stop, explicit control and original-request
inspection. Native tasks also support model/tool selection, permissions and
attachments. Task lists and native/Rho history use bounded pages and preserve earlier reading positions. Rho Send captures an available key before admission,
atomically consumes only its matching draft and preserves later typing on replay.
Stable view/controller identities survive private connection rotation. Rho settings
provide key save/removal, versioned configuration and explicit synthetic tests;
keys stay out of saved view state and Operations. Rho now submits text and contributed
references, attachments and explicit continuation. Rho Tools selects one supplied R session,
freezes it at Send and retains the original binding for Continue after deselection. Real Host/Rig/R checks pass; see `target/plugin-refactor/agent-rho-tools-results.json`.
Rho uploads preserve original identity through lost replies/reselection; text ≤32 KiB and PNG/JPEG ≤2 MiB are captured before Send. The five framed backend cases and the complete actual Host/browser flow pass.
The UI build and 107 model cases (30 native, 13 settings, 38 Rho, 15 context, 11 handoff) pass, as does
the synthetic public MessagePort browser fixture: opaque iframe, IME Enter, task
switching, native/Rho attachment recovery and retained context, next drafts, 8 MiB selection, lost creation/Send/import/key
replies, actual reload, history and close without Stop. Settings/rename work without
form permission. Continue preserves next drafts through lost replies/reload and original context
at 960/440/220 px. Handoff also preserves edited text, references and lost receipts at those widths.
Current checks pass 64 framed backend, 33 native client, one configuration and
32 native owner/store cases: context/history/Continue, handoff, uploads and reopen.
Earlier interrupted attempts remain incomplete evidence, not passes. The 45-capability manifest includes all attachment ports; schema annotations/local
names are compacted without weakening validation. The 649-file source manifest is 247,938 bytes, within the 256 KiB limit.
A current workspace-built Agent package and reuse receipt are available. The picker
reads instance observations; a view calling its exact own backend retains selected
activation scopes. Reverse calls still require individual grants; foreign
providers, current caller restrictions and Query-only boundaries stay enforced.
Eleven Host delegation/test-project checks pass, including Query refusal. Immediate
task selection prevents handoff from using the prior task while saving. Native
Resume evidence covers Kimi through a local ACP peer; no other provider or abrupt
crash recovery claim. Post-restart records retain the original real R result.
R declares observed Help topics and saved HTML contexts with exact-copy/file
checks and bounded journal paging. Twelve context tests and the real-R Host case
pass. The Agent picker has actual Host/browser evidence: Help excerpt and saved HTML join
Editor input and attachments, reach the model, and survive Continue,
reload and Host restart while R stays suspended. Normal/390/220 layouts are checked.
Concurrent foreground/background draft confirmation no longer reports a false
missing-request error; its failing baseline and passing regression are retained.
Component-request reception now previews/rechecks sources and appends once to an editable Native/Rho draft without changing text/tools or sending. Native/Rho renderer checks and real Editor-source Host/Send/restart checks pass; the latter uses configuration input, not an Editor Ask button.
Remaining: component sender buttons/routing and annotations. Evidence: `agent-component-input-results.json`,
`agent-scientific-context-current-results.json` and `studio-agent-current-results.json` in `target/plugin-refactor/`.
Synthetic peers for Process/Remote/Environment do not establish execution through those plugins.
Agent evidence in `target/plugin-refactor/`: `agent-current-native-results.json`, `agent-handoff-ui-results.json`, `rho-continue-results.json`, `agent-assets-results-v3.json` and
`agent-assets-combined-v1.json` (20 owner/35 store/42 framed cases; five frozen-Host
cases including real 8 MiB import), `agent-core-combined-v2.json` (management/checkpoint),
and `agent-native-tools-combined-v1.json` / `agent-native-tools-native-rerun-v2.json`
(component/native real-R normal/Stop). No real-model quality or distribution claim.

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

Per-plugin checks: `node scripts/governance.mjs impact --changed-auto`.

### Known open problems

- Build iteration recovered after reducing an oversized dependency directory:
  1,634,793 entries became 201,054 after retaining every referenced debug object;
  listing fell from 66.5s to 0.62s. All old files remain retained. A loader probe
  also stalled in dyld's file validation; `syspolicyd` errors alone do not prove its cause.
  Agent/R/Files builders now default to workspace reuse; six R browser runners
  require a retained package. Plugin tests drop Application/Agent owner/store
  from their local dependency closure (16 → 13); journal/default-store/build checks pass (21/27/7).
  Evidence: `target/plugin-refactor/development-optimization-results.json`; combined Host integration remains.
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
New revisions need explicit snapshot/activation; existing instances keep immutable
assets. Inspect live work before authorized replacement. Acceptance uses disposable
projects and explicit Ark/R.

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

These baselines apply only to their recorded source.

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
