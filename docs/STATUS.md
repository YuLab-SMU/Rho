# Rho: current state and focus

Updated: 2026-09-29. This is the single current status summary: current behavior,
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
| M1 | **Default plugin scenario as the primary composition.** `rho` opens a project in the ordinary plugin window with R, Console, Objects, Files, Editor, Plots, Viewer, Packages, Help active; Run File → Objects/Plots works with real R. | Fixed scientific panels for those views become unused in the default path | Default entry, real-R browser flow and Rust HTTP checks pass; delivery remains |
| M2 | **Ordinary Agent view, first vertical slice.** Open Agent view → pick a document or file attachment → Send → native tool calls a real R/Files plugin → results shown → browser reload finds the original record. | Fixed Agent panel in the default scenario | Native/Rho views and attachment source/renderer checked; combined native/Host path pending |
| M3 | **Actual Host restart recovery.** Restart the generic Host during M2's flow; the same instance/task recovers its original records without replay. | — (risk reduction; do early) | Lifecycle, explicit view recovery and four runtime suspension cases pass; Host acceptance pending |
| M4 | **Agent context and continuation.** Contributed context sources (help, viewer, annotations, documents), component input and continuation through the ordinary backend. | Application-side Agent context composition | Text/history, Continue and handoff implemented; renderer checked, native/restart acceptance pending |
| M5 | **Studio Agent assistance.** Exact development branch capture; separate checkpoint, build, preview and scenario-application actions. | — | Branch checkpoint via Agent verified; Studio request UI/model/renderer checked, combined Host flow pending |
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
startup. The three CLI argument cases also pass, and the current Host binary was
built. The broader CLI command was interrupted while starting unrelated filtered
targets; it is not reported as a complete pass. After executable startup recovered,
four default-entry/generic-window/fixed-reference browser cases passed. The real-R
flow now also starts through browser project selection and the installed Manager
selector, including recovery from a lost activation reply with one instance.
That run found and fixed the selector's accessible label; the passing rerun used
current client assets with the retained Host and native plugin artifacts. It
verified one execution, Objects/Plots output and reload without replay. Evidence:
`target/plugin-refactor/default-entry-results.json`; earlier startup timeouts and
the label failure remain retained. Both Rust HTTP cases now pass (58 minutes of
compilation, 0.52 seconds of test execution). Current client generation and build pass; embedded-binary refresh remains
pending, and that earlier browser run does not cover M3 edits.
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
Host-reopen and combined Agent/real-R browser restart fixtures remain unrun.
Public/core client generation, client build and Manager restore/model checks pass.
Client check and actual Host acceptance remain.
Evidence: `target/plugin-refactor/restart-lifecycle-results.json`. No user Host was replaced or package installed/published.

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
  Studio now prepares an ordinary Agent draft with that branch/checkpoint and six
  bounded tools. Model/renderer checks pass for lost view receipts, one-time draft
  insertion and 1440/960/440/390/220 layouts; combined Host acceptance is pending.
- `agent.native.assets.import` reads a controlled resource up to 8 MiB through an
  explicit `resources.read` grant, checks ranges/length/digest, and retains the
  original receipt; repeats observe the original. Inline attachments stay ≤ 524288
  encoded bytes per Control.

Native/Rho captures exact previews and bounded history without inheriting tool authority;
Check tool outcomes and Continue retain exact providers and reuse confirmed results.
Ordinary handoff source/target/receipt/append APIs now reuse the atomic draft owner in source,
with exact view control and reference checks. Its ordinary UI passes renderer checks; native/Host acceptance remains.
The ordinary native/Rho task view is implemented in source: shared task selection,
creation, draft CAS/conflicts, Send/Stop, explicit control and original-request
inspection. Native tasks also support model/tool selection, permissions and
attachments. Task lists and native/Rho history use bounded pages and preserve
earlier reading positions. Rho Send captures an available key before admission,
atomically consumes only its matching draft and preserves later typing on replay.
Stable view/controller identities survive private connection rotation. Rho settings
provide key save/removal, versioned configuration and explicit synthetic tests;
keys stay out of saved view state and Operations. Rho now submits text and contributed
references and explicit continuation; attachments and tool selection remain to compose.
The UI build and 89 model cases (29 native, 13 settings, 23 Rho, 13 context, 11 handoff) pass, as does
the synthetic public MessagePort browser fixture: opaque iframe, IME Enter, task
switching, one Send, next drafts, 8 MiB selection, lost creation/Send/import/key
replies, actual reload, history and close without Stop. Settings/rename work without
form permission. Continue preserves next drafts through lost replies/reload and original context
at 960/440/220 px. Handoff also preserves edited text, references and lost receipts at those widths.
This does **not** establish combined native/Host acceptance: native manifest
regeneration, backend checks and activation of the new combined package remain
pending: the native metadata run reached 53 passes/6 failures; fixture fixes are under rerun. `plugin.json` still
describes the prior backend-only package until regeneration. No new Agent native
package was built for the frontend iterations.
Browser file capture/import/reselection retains identity; native staging/import cases passed, while corrected context fixtures remain under rerun.
The combined native/Rho–Editor–real-R/restart fixture, including handoff receipts, passes type checking and discovery.
Its model peer probe passes; the actual Host flow awaits one current Agent artifact.

Not done: native acceptance of attachments/settings/Rho drafts/history/Continue/handoffs,
remaining context/component input, actual Host restart recovery and combined Studio Agent acceptance.
Synthetic peers for Process/Remote/Environment do not establish execution through those plugins.

Agent evidence in `target/plugin-refactor/`: `agent-handoff-ui-results.json`, `rho-continue-results.json`, `agent-assets-results-v3.json` and
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

Per-plugin checks are mapped in `governance/source-map.json`; run
`node scripts/governance.mjs impact --changed-auto` for the affected set.

### Known open problems

- Native compilation and executable startup have shown prolonged idle waits.
  The CLI build took 104 minutes, while its selected tests ran in under a second;
  fresh Host startup subsequently exceeded its 60-second deadline. System logs
  repeat `syspolicyd: Unable to initialize qtn_proc: 3`; this is diagnostic evidence,
  not a proven cause. Read-only signature verification of the compiler's open
  `libtracing_attributes` library also timed out after 20 seconds in both Codex
  and a separate system Terminal. This is not isolated to a Rho test body; the
  cause remains unconfirmed. Logs and incomplete checks remain in `target/plugin-refactor`.
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
