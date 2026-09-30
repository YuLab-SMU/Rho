# Rho: current state and focus

Updated: 2026-10-01. This is the single current summary of behavior, evidence,
open work and the next milestone. Git and run artifacts retain history; see
[Development](DEVELOPMENT.md#status-discipline) for update and evidence rules.
Evidence filenames below are relative to `target/plugin-refactor/` unless stated.

## Current focus: usable local Preview 3 and workspace-aware Agent

Current source links Agent Editor runs to original Operations, captured code and
native results. Read-only inspection survives lost acknowledgements/plans, while
receipt-only updates preserve concurrent typing. New document-linked notes use a separately scoped freeze tool, fenced to the
original selected Editor/window in Native and Rho.
Focused owner/client tests pass. Isolated Host and headless Chrome acceptance pass for
Editor freeze, Agent annotation use, source/CAS refusal, draft retention, picker overflow
at 1440/960/390/220px, reload and same-instance restart without replay. Model/native
peers were synthetic; no release claim. Local real-R acceptance is unrun: no Ark or
`RHO_ARK`; R 4.5.2 is installed. Earlier Linux AF_UNIX denial remains historical.

Preview 3 contains the native launcher, saved Demo, navigation and bundled Ark;
R remains the configured local installation. Its fresh `Preview 3` catalog selects
updated immutable packages, preserving earlier preview catalogs and drafts.
Objects/Packages discover the selected provider's live session. Context search
uses real file kinds, browses current project files and live R objects, and retains
exact source references. Keyboard `@` opens the picker; reopening cannot discard
the new source search. New Agent tasks default to read-only workspace tools.
Rho's **Read, edit and run in workspace** adds scoped Files and synchronized Editor
read/edit/save/captured-run tools. Fresh Send captures provider/window/session;
Continue keeps original grants. Accepted operations are observed to settlement;
Partial, unknown and unavailable reads retain their Host status. Editor updates refresh
resident documents and survive reload; stale edits and changed disk bases are refused.
The Host permits exact granted Controls from active Operation parents for transient
draft staging; Query/Control parents still cannot acquire writes.

Prior Preview 3 Agent backend (66), native owner/store (9 each), Editor (5), Files context
(2), delegated Host (2), draft Host (9) and view delegation (4) checks pass. Agent,
Editor and Manager client checks/builds, generated manifests, tool grants, public
boundaries and documentation governance pass. The core builds; current Agent,
Editor, Files and Manager packages use isolated source closures and workspace
native builds. Browser `@` for Files/Editor/R, stale-write protection, edit/save/run
and reload pass. `deepseek-v4.1-flash` completed one captured run; native R readback
is 57. `target/preview-3/context-flow-final.json` rechecks retained streaming events
from the successful native flow after a report-only assertion failure; no replay.
Launcher Demo/Objects/Packages/reload/graceful restart pass in `launcher-5.json`.
That retained launcher candidate predates the final Agent/Editor/Files updates;
those exact updated packages are covered by the separate context flow. Final
assembly records precise runtime hashes. No user Host restart or installation.

The unified-plugin plan was authorized on 2026-09-23; PS01–PS07 are approved
([Design 21](RHO-DESIGN.md#21-unified-plugins-and-plugin-studio--approved)).
All sixteen ordinary packages exist. Fixed scientific/Agent composition, private
frontend/HTTP flows, Application/Skill handlers, retired owner/adapter packages
and legacy shared-port DTOs are removed. CLI, HTTP and MCP use the generic Host.
The declared scientific-operation slice now passes through a real Files provider.
The annotation foundation covers eight source entries, versioned notes and Agent
inclusion; scoped evidence and the remaining real-model/IME limits are below.

Studio forms, synchronized references, Undo and recovery (`5a5ecc4d`) passed model/browser and multi-width inspection: `definition-editor-results.json`, `visual-runtime-results.json`.

### Remaining work order

Completed flow baselines: M1 default scientific composition; M2 ordinary Agent;
M3 graceful same-instance Host recovery; M5 Studio Agent checkpoint/build/preview/apply.
M4's annotation foundation is verified. `m6-final-acceptance-matrix.json` reconciles
approved PS01–PS07/AN01–AN06 scope and exact delivered artifacts, retaining historical
evidence with its original limits. Assessment is complete; full product acceptance
is not. The older `final-acceptance-matrix.json` remains historical input.

| Order | User flow / ownership | Completion condition | Dependency and scope |
| --- | --- | --- | --- |
| 1 — verified | **Declared view → real Files update → explicit patch → original-operation recovery.** Public UI SDK and the consumer own observation/intent; Files and Operation own effects/truth. | Captured provider/arguments remain fixed; observation updates and stops on disposal; one explicit write; lost acknowledgement, reload and replacement view recover the original record with exactly one native effect. Affected Editor/Studio consumers still pass. | Real Files/browser flow, public SDK, Editor/Studio models, visual Studio/browser and client checks pass on settled source (`visual-science-results.json`). Snapshot polling only; no Host push channel. |
| 2 — verified | **Capture → edit annotation → include in Agent → recover original evidence.** Ordinary Annotations plugin and source owners. | Reviewed AN01–AN06 interactions, eight-entry smoke, complete Files text/Viewer image flows, keyboard and 600/320px layouts. | Shared counts/near-selection entry, structured Agent-item anchors and current Viewer viewport capture pass. Files and Viewer save → existing Agent draft → refresh/source-change flows pass (`annotation-foundation-files`, `annotation-foundation-viewer`, `annotation-foundation-entries`). Prior lost-acknowledgement, CAS, history and mark/Undo evidence remains valid (`annotation-components-browser`, `annotation-version-browser`). This closes M4's foundation, not delivery, real-model quality or OS IME. |
| 3 — verified | **Updated runtime reaches the development bundle.** Existing package builders/delivery path. | Exact revisions/hashes, imported definition editor and delivered SDK → real Files patch/recovery pass. | Thirteen affected packages refreshed; Environment/Process/Remote archives reused byte-for-byte. Updated core requires and passes relocation/import/retry/remove/empty-start/restore acceptance (`m6-bundle-refresh.json`, `m6-bundle-acceptance.json`, `m6-delivery-results.json`). No user installation/signing/publication. |
| 4 — verified for Annotations | **Actual system IME in an ordinary view.** UI acceptance. | Real candidate window, composition/commit/Enter, focus changes and draft retention observed in the target app/browser. | Native macOS/Edge key input produced Chinese via Space; Return committed pinyin during composition and inserted a newline after commit. Focus changes retained text; reload retained the draft; Save produced revision 2. User confirmed the system candidate window. `m6-system-ime.json`, `m6-ime-composition.png`, `m6-ime-saved.png`. Agent/Editor controls and other OS/input methods are not established. |
| 5 — assessed with gaps | **Real Agent/provider quality on the ordinary-plugin path.** Agent acceptance. | Assess existing capabilities; preserve every unavailable or partial case, as requested. | `deepseek-v4.1-flash`: Objects/Packages/Environment/Workspace, three repetitions each, pass (12). Plots metadata passes but original visual-color intent remains partial (3). At that assessment, six document-dependent intents lacked scoped Editor tools (18 not run); this historical matrix is not retroactively passed by the new Preview flow. `Qwen3.8-27B` image diagnostic returned HTTP 200 without visible text; image interpretation/followup remain unrun. Evidence: `m6-live-matrix-results.json`, `m6-live-matrix-reviewed.json`, `m6-live-objects-results.json`. |
| 6 — assessment complete | **Final evidence matches approved scope and exact delivered artifacts.** Full-plan acceptance matrix. | Reconcile evidence and retain all open requirements. | `m6-final-acceptance-matrix.json` verifies bundle bytes/hashes and maps approved scope. Current Host-port checks pass 13/13 (`m6-host-ports.log`); historical scene/version/Python/Studio-self evidence retains original artifact scope. Full product acceptance is false; no global release claim. |

HV01–HV07 lighter Help/Viewer controls, system-browser opening and Help anchors
remain proposed ([Design 19](RHO-DESIGN.md#19-r-help-interactive-viewer-and-lighter-controls--proposal)).
Their pending review does not block approved AN01–AN06 implementation or runtime
work. R01–R03 also remain proposals; annotation approval does not extend to them.

## Verified ordinary-plugin flows

### Scientific composition and continuity

Manager's **Scenarios → New R workspace** selects installed exact artifacts and
existing Ark/R paths, activates providers, saves a checkpoint and prepares views.
Window switching and R startup are separate explicit actions. The expanded recipe
includes sixteen instances and eleven initial views; new Agent tasks offer read-only
workspace context. Remote/Environment remain unconfigured until selected.

The full delivered scene passes Files → Unicode Editor Save/Run → Console,
Objects and Plots with real R. Lost activation acknowledgement, scene switching,
view close/reopen, drafts and reload retain the original provider/session and one
execution. Historical scenario restoration creates a new checkpoint and preserves
live R memory, scientific files, original Operations and Agent settings/credentials.
The repaired Console compares JSON values without erasing meaningful event order;
Ready/input and retained memory are visible in inspected captures.
Evidence: `default-entry-results.json`, `final-science-agent-results.json`,
`final-science-history-fixed-results.json`, `fixed-composition-results.json`.

Two R revisions coexist while an original native execution is held: the original
provider/session/output/retry identity and isolated variables survive activation
of the second revision. Queue/commit recovery, pending input during drain,
cancellation, read-only Packages/Help/Objects and retained PNG/HTML also pass.
The native fixture took 29.49s with zero builds. Evidence:
`final-version-studio-results.json`. Both revisions use the same native executable;
this is not distinct-implementation or two-installation acceptance.

### Agent, source context and recovery

The ordinary Agent owns transport, Rig execution, credential/metadata storage,
Native/Rho tasks, bounded history, attachments, settings, Send/Stop, continuation
and handoff. It uses public grants and the core Operation journal; it does not
read retired tables or maintain another scientific result database. Captured
native tools preserve provider, scope, parent and request identity across retries.

Actual Host/browser evidence covers Native/Rho input, 8 MiB native attachments,
Editor/Help/Viewer context, real R, continuation/handoff, browser reload and graceful
same-instance/task/view Host restart without replay. Explicit native Resume uses
the original Kimi directory and a deterministic local ACP peer; resumed R remains
unstarted until explicitly started. Other providers and abrupt crashes
are not established by this result. Evidence: `final-agent-r.log`,
`final-agent-r-browser/agent-workspace-ordinary-n-217bb-ugh-reload-and-Host-restart/agent-native-result.json`,
`agent-rho-tools-results.json`, `agent-workspace-current-results.json`.

Editor/Help/Viewer/Objects/Plots/Console/Packages/Files **Ask** contributes exact
source references to editable Agent drafts. Changed sources are refused; later
output cannot replace original input; reload/restart retains original context.
Plots supports explicit original images. Packages retains installed-copy/session
identity and does not load packages. Console retains original code and saved
transcript; Files retains path/digest/native identity. Source previews were inspected
at normal and constrained widths. Native/Rho coverage differs by source; do not
infer every provider/mode combination from one passing flow. Evidence:
`component-senders-results.json`, `editor-agent-input-results.json`,
`object-context-results.json`, `plots-links-results.json`, `console-context-results.json`,
`packages-context-results.json`, `files-context-results.json`, `../preview-agent-fix/cache-recovery.json`.

Native Agent through real Process, local Environment/pak and loopback OpenSSH
passes original-effect/retry/restart checks with retained packages/core in
74s/86s/75s respectively. Remote distinguishes exit failure from uncertainty;
reading a receipt cannot promote the original uncertain Operation to success.
Environment retains a real failed verification even when Send finishes.
Evidence: `agent-process-results.json`, `agent-environment-results.json`,
`agent-remote-results.json`. These use deterministic peers and local fixtures:
no remote cluster, cross-machine network-loss, remote package resolution, renv
restoration or real-model quality is claimed.

### Annotations: component entry, captured marks and Agent draft slice

Ordinary Annotations owns native text/image records, revisions, source references,
CAS, tombstones/history and Agent context. Editor, Files and all six R context
sources pass freeze → note → Agent → graceful same-instance restart. Objects and
Packages freeze bounded observed metadata, not whole values/package files;
Console/Plots retain producing-run/output identity. Suspended sources cannot be
silently restarted for new captures.

PNG/JPEG import/read validates exact decoded bytes; explicit image context reaches
Native/Rho Send with marks and picker thumbnails. Context permits two images of
at most 2 MiB each under a project budget; Rho requires its model image diagnostic.
Retry/restart preserves original images and does not resend pixels or model work.
Evidence: `image-context-results.json`, `annotation-summary-results.json`,
`annotation-files-results.json`, `annotation-files-host.json`.
The ordinary view adds generic owner discovery, quoted/whole-item capture, imported
PNG/JPEG drawing (Pen/Rectangle/Arrow/Text), numbered marks, local mark Undo,
labels/filters, saved-revision history, original-source checks and explicit
continuation. Unsaved replacement and irreversible deletion use in-view dialogs.
Eight source views expose Annotate through a shared public SDK sender; the source
view/tab identity and navigation intent are saved before opening. Source content,
scientific state and Agent authority are unchanged by note capture/navigation.

Actual Files browser acceptance covers lost open/create acknowledgements, reload,
original Operation inspection with one invocation, stale note CAS, deletion and
historical reads, source-lineage/version filters and explicit continuation after a
real Files content change, normalized rectangle marks and Undo, Back preserving source
view state, and two exact note revisions appended to an existing controlled Rho
Agent draft while retaining its Chinese text. The PNG is a deterministic public
resource fixture. Native acceptance separately uses real R Help/Viewer/Console/
Plots/Objects/Packages, Native/Rho Agent protocol fixtures and a graceful same-
instance Host restart. Evidence: `annotation-components-browser`,
`annotation-components-native.json`, `annotation-version-browser` (two browser
flows, 23.1s test bodies); these do not establish real-provider quality.
Source UI builds and focused SDK/Editor/Files/Plots/Objects/Packages/Viewer/Console/
Agent view checks passed, as did annotation/Files backend and client checks.

The reviewed AN01–AN06 foundation passes focused acceptance. Shared entry counts
and the near-selection action work on Files text; eight source entries open exact
previews, including structured Agent task-item evidence. The live Viewer viewport
captures its changed controls/pixels, retains marks and the original PNG after a
new R output, and labels the capture as non-original media. Files quote and Viewer
image each save a revision, join a distinct existing Agent draft without sending,
and survive refresh/source change. Keyboard paths, 600/320px note layouts and
320px Agent draft inclusion were checked with screenshots. Evidence:
`annotation-foundation-files`, `annotation-foundation-viewer`,
`annotation-foundation-entries` (browser bodies 7.7s, 8.0s and 14.3s; setup
45.2s, 62.0s and 116.1s respectively). Focused public SDK/Files/Viewer checks,
client build/check, plugin boundaries and native activation tests pass. Actual
Annotations system IME is separately verified below the work-order boundary.
Current live-source status is labeled unknown unless the
owner can establish it; an exact historical preview is not a current-version claim.
Affected source packages are retained for milestone reuse and included in the
refreshed development bundle. No user Host was restarted or installed.

### Studio and public visual runtime

Studio supports source/declaration/canvas editing, checkpoints, comparisons,
branching, explicit native build, fixture preview, disposable backend test projects,
scenario application/restore and archive import/export. Exact-branch Agent
assistance passes checkpoint → explicit build → preview → apply while preserving
old instances and other branches (`studio-agent-current-results.json`).

The standalone SDK renders all ten declared node kinds, bounded queries, verified
PNG/JPEG, compiled custom components and explicit event adapters with cleanup.
Late reads cannot replace newer observations; form drafts/focus survive refresh;
programmatic click/requestSubmit cannot dispatch declared writes. Studio edits
reach actual built preview/applied views and retain old revisions. Data-source and
custom-component forms share source/Undo, synchronize renames, refuse referenced
removal/stale forms, retain invalid drafts and preserve custom source bytes.
Evidence: `visual-runtime-results.json`, `definition-editor-results.json`,
`visual-science-results.json`. The real Files flow uses the public polling adapter
and a consumer-owned durable action intent; it does not add a Host subscription
or infer general-purpose automatic recovery for arbitrary declared actions.

Studio self-development passes branch/edit/checkpoint/build/preview/save/reload/
close/apply/restore. Fixture drafts use bounded intrinsic state without a real
source-document save. Original views can be explicitly reopened with their drafts;
a fresh revised Studio restores default state, not an automatic cross-revision
retained-view map. Evidence: `studio-self-results.json`.

### Generic platform and independent delivery boundary

The Host composes generic plugin, Operation, discovery and test-project ports.
Queries are bounded observations and never start or resume a runtime. Package
source/revision/artifact identities, explicit activation/grants, framed RPC,
scoped resources, window drafts/layouts and original-request recovery are public.
Normal drain suspends exact instances after acknowledged cleanup; resume and view
reconnect are explicit separate actions. New SQLite state uses generic scoped,
versioned storage and neither imports nor deletes abandoned scientific records.

Retained fault/boundary acceptance covers 50 Host/runtime/package cases including
forgery, path containment, backend failure, unconfirmed cancellation and lost
settlement. External public-SDK UI and a stateful Python fixture execute through
the unchanged core; Python sessions, isolation, one execution on retry and original
journal output after release/restart pass. This is fixture evidence, not a shipped
Python feature, OS sandbox or memory recovery. Evidence:
`final-boundaries-results.json`, `final-external-runtime-results.json`,
`generic-contract-results.json`, `generic-state-results.json`.

All sixteen ordinary archives pass import/remove/empty-Host/explicit restoration;
archive fields and exact blob content are retained. JSON key-order differences do
not constitute changed contents. Empty startup does not silently reinstall
packages. Evidence: `final-delivery-contents-results.json`.

## Known limits and environment dependencies

- Historical native compilation/loading stalls have an unproven OS cause. Preserve caches, recovery links and existing process evidence; do not clear caches, duplicate Cargo work or restart user Hosts to mask them.
  Evidence: `development-optimization-results.json`, `annotation-output-results.json`, `files-context-results.json`, `../preview-agent-fix/cache-recovery.json`.
- Current generic-window pointer/docking/focus and normal/wide/narrow captures pass.
  Older standalone frame pointer-routing failure remains separate. Earlier IME
  attempts were inconclusive. Current native-key input verifies Annotations on
  macOS/Edge; candidate visibility is user-confirmed, not captured by the app-only
  screenshot. Other controls and OS/input methods remain outside that evidence.
- Abrupt browser disposal cannot establish that unacknowledged edits were saved.
  Graceful Host restart evidence does not establish abrupt-crash or R-memory recovery.
- Unfiltered offline Cargo metadata hits uncached `combine 4.6.8`; host-filtered
  metadata passes. Two different R installations require opt-in `RHO_ALT_*`.
- The 33-case assessment has 12 passes, 3 partial Plots cases and 18 unavailable
  document cases. The separate real image diagnostic failed. Historical 27-case
  evidence, full-workspace totals and retired tests do not establish current passes.
  Six completed model runs were verified from original public records without
  model/R replay; only the three Objects cases needed a targeted rerun.

## Development bundle and restart boundary

The last verified portable bundle is
`target/plugin-refactor/local-bundle-m6-macos-arm64-20260930`
(391,727,116 bytes): current core, thirteen refreshed packages and three unchanged
Environment/Process/Remote archives. A serial core build took 20.50s; package
builds/exports/assembly took 84.713s. Imported Studio definition editing, build,
preview/apply and recovery pass; real Files patch/recovery uses the compiled SDK
extracted from the delivered Studio archive. Normal/220px captures were inspected.
The updated core also passes relocation/corruption/path/import/retry/remove/empty-
start/restore acceptance. Evidence: `m6-bundle-refresh.json`,
`m6-bundle-acceptance.json`, `m6-delivery-results.json`; manifests retain exact
revisions, hashes and sizes. Core source is `09633b76`; subsequent changes concern
delivery harnesses/documentation. The assembly records a dirty checkout explicitly.

Initial installation scope remains macOS 26.5.2 (25F84), Apple Silicon arm64.
Native R is a separate per-machine acquisition. Existing binaries have ad hoc
signatures; no Developer ID signing, notarization, installation, publication or
complete licensing audit is claimed. See [Release](RELEASE.md).

Existing user Hosts and R memory have not been restarted by this work. A client
refresh cannot add Host capabilities; new plugin revisions need explicit snapshot/
activation and old instances retain immutable assets. Inspect live work and respect
restart authorization before replacing a Host. Read [Operations](OPERATIONS.md)
before starting another one; acceptance uses disposable projects and explicit R.
Package-management UI, abandoned-data migration and distribution beyond the
existing authorized development-bundle path remain outside this work order.
