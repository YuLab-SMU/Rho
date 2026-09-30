# Rho: current state and focus

Updated: 2026-09-30. This is the single current summary of behavior, evidence,
open work and the next milestone. Git and run artifacts retain history; see
[Development](DEVELOPMENT.md#status-discipline) for update and evidence rules.
Evidence filenames below are relative to `target/plugin-refactor/` unless stated.
The latest annotation milestone adds ordinary-view/browser and real-R owner evidence.
The current round closes the M4 annotation foundation; delivery, model-matrix and
OS IME acceptance are deferred to later iterations.

## Current focus: approved annotation interface

The unified-plugin plan was authorized on 2026-09-23; PS01–PS07 are approved
([Design 21](RHO-DESIGN.md#21-unified-plugins-and-plugin-studio--approved)).
All sixteen ordinary packages exist. Fixed scientific/Agent composition, private
frontend/HTTP flows, Application/Skill handlers, retired owner/adapter packages
and legacy shared-port DTOs are removed. CLI, HTTP and MCP use the generic Host.
The declared scientific-operation slice now passes through a real Files provider.
The annotation view now has cross-component entry, versioned notes, image marks
and explicit Agent draft inclusion. Complete the remaining M4 interactions first,
then run one focused acceptance round: smoke the eight source entries and finish
Files selected-text and Viewer image flows through save, Agent draft inclusion,
refresh recovery and source change. Reuse valid browser/native evidence. Package
refresh, the 33-scenario model matrix and system IME are outside this round.

Committed baseline `5a5ecc4d` adds Studio data-source/custom-component forms to
the executable visual runtime: synchronized references, shared Undo, invalid draft
recovery and conflict protection. Studio model checks and two browser flows passed
(38.2s for the browser run); settled normal/wide/390/220px captures were inspected in a separate 17.1s
run. Evidence: `definition-editor-results.json`, `visual-runtime-results.json`.
The accepted development bundle predates this runtime work.

The public SDK now offers bounded snapshot polling and strict original-operation
inspection. A separate ordinary UI package observes actual Files text, performs
one explicit patch, and recovers the original Operation after a simulated lost
acknowledgement, reload and replacement view. The original provider, target,
arguments and native file effect remain fixed; polling stops on disposal. Files
preflight fills an omitted target with the project root, so the fixture now
captures `workspace.paths` and records that exact target before dispatch. The
earlier strict-verification failure remains in `visual-science-native.log`;
the settled real Files flow passes in 11.7s (`visual-science-results.json`).
This is snapshot polling, not a server-pushed native subscription.

### Remaining work order

Completed flow baselines: M1 default scientific composition; M2 ordinary Agent;
M3 graceful same-instance Host recovery; M5 Studio Agent checkpoint/build/preview/apply.
M4 has remaining annotation UI work. M6 final composition remains incomplete.
The audit in `final-acceptance-matrix.json` is partial and applies only to its
recorded artifacts; “current” labels there do not certify this newer worktree.

| Order | User flow / ownership | Completion condition | Dependency and scope |
| --- | --- | --- | --- |
| 1 — verified | **Declared view → real Files update → explicit patch → original-operation recovery.** Public UI SDK and the consumer own observation/intent; Files and Operation own effects/truth. | Captured provider/arguments remain fixed; observation updates and stops on disposal; one explicit write; lost acknowledgement, reload and replacement view recover the original record with exactly one native effect. Affected Editor/Studio consumers still pass. | Real Files/browser flow, public SDK, Editor/Studio models, visual Studio/browser and client checks pass on settled source (`visual-science-results.json`). Snapshot polling only; no Host push channel. |
| 2 — active | **Capture → edit annotation → include in Agent → recover original evidence.** Ordinary Annotations plugin and source owners. | Close M4 with the reviewed interactions, eight-entry smoke and two complete Files text/Viewer image flows; include keyboard and 600/320px layouts. | Files component entry → notes → exact revisions in an existing Agent draft passes in the browser, including lost open/create acknowledgements without replay, CAS, deletion confirmation, marks/Undo, source-version history and explicit continuation (`annotation-components-browser`, `annotation-version-browser`). Eight source entries and real native owners exist; remaining implementation: counts/near-selection entry, structured anchors including Agent items, interactive Viewer capture. Reuse prior conflict/history/recovery evidence; inspect only missing or changed interactions. AN01–AN06 review is complete. M4 remains partial. |
| 3 — deferred | **Updated runtime reaches the development bundle.** Existing package builders/delivery path. | Identify the changed source/runtime dependency closure; refresh affected packages once; validate exact revisions/hashes and run the affected imported-view flow. Retain unchanged archives/core and applicable installer evidence. | SDK changes can affect more than Studio: compare consumers and package contents. Repeat relocation/empty-start acceptance only if its inputs change. No installation/signing/publication. |
| 4 — deferred | **Actual system IME in ordinary views.** UI acceptance. | Real candidate window, composition/commit/Enter, focus changes and draft retention observed in the target app/browser. | Needs a stable foreground/input-method session. Synthetic composition passes are separate. Remains required for the full usability claim, outside M4 foundation closure. |
| 5 — deferred | **Real Agent/provider quality on the ordinary-plugin path.** Agent acceptance. | Map the planned 33 scenarios to current public paths and record remaining cases individually. | Representative real-provider Send, one R effect and same-instance original-operation recovery pass (`agent-live-provider-results.json`, `agent-live-provider-wire-results.json`). The matrix stopped during fixture setup before any scenario attempt (`agent-live-matrix-results.json`); vision quality remains unrun. The unfinished opt-in harness is retained for later work. Historical 27-case evidence is not a current pass. |
| 6 — closure | **Final evidence matches the approved scope and exact delivered artifacts.** Full-plan acceptance matrix. | Reconcile existing evidence, run only missing/invalidated checks, and keep every open requirement explicit. | Orders 1–5 have different completion conditions. A verified integration slice or development bundle does not close the full plan. No automatic workspace audit or release. |

HV01–HV07 lighter Help/Viewer controls, system-browser opening and Help anchors
remain proposed ([Design 19](RHO-DESIGN.md#19-r-help-interactive-viewer-and-lighter-controls--proposal)).
Their pending review does not block approved AN01–AN06 implementation or runtime
work. R01–R03 also remain proposals; annotation approval does not extend to them.

## Verified ordinary-plugin flows

### Scientific composition and continuity

Manager's **Scenarios → New R workspace** selects installed exact artifacts and
existing Ark/R paths, activates providers, saves a checkpoint and prepares views.
Window switching and R startup are separate explicit actions. The expanded recipe
includes sixteen instances and eleven initial views; Agent tools start unchecked,
and Remote/Environment remain unconfigured until selected.

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
`packages-context-results.json`, `files-context-results.json`.

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

The reviewed AN01–AN06 flow remains partial: component counts and nearby selection
entry, structured/Agent item anchors, interactive Viewer capture, eight-entry smoke
and focused keyboard/600/320px acceptance are open. OS IME remains deferred.
Current live-source status is labeled unknown unless the
owner can establish it; an exact historical preview is not a current-version claim.
Affected source packages are retained for milestone reuse; the development bundle
has not been refreshed for this change. No user Host was restarted or installed.

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

Current fault/boundary acceptance covers 50 Host/runtime/package cases including
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

- Native compilation/loading can stall before test execution. Historical runs
  include long cache enumeration and startup timeouts for byte-identical binaries;
  an exceptional same-inode hardlink-directory recovery helped temporarily. The OS
  cause remains unproven. Preserve the macro-cache symlink/backups; inspect the
  existing process/log and distinguish build, startup and test body. Do not clear
  caches, duplicate Cargo work or restart user Hosts to mask a stall.
  Evidence: `development-optimization-results.json`, `annotation-output-results.json`,
  `files-context-results.json`.
- Current generic-window pointer/docking/focus and normal/wide/narrow captures pass.
  Older standalone frame pointer-routing failure remains separate. OS-level IME
  attempts produced Latin input without a candidate window and were interrupted
  by foreground interference: unverified, neither a defect finding nor a pass.
- Abrupt browser disposal cannot establish that unacknowledged edits were saved.
  Graceful Host restart evidence does not establish abrupt-crash or R-memory recovery.
- Unfiltered offline Cargo metadata hits uncached `combine 4.6.8`; host-filtered
  metadata passes. Two different R installations require opt-in `RHO_ALT_*`.
- The 33-case real-model matrix has not run; historical 27-case and earlier Agent
  interface evidence apply only to their original source. Earlier full workspace
  totals and retired tests are not current ordinary-plugin acceptance.

## Development bundle and restart boundary

The last verified portable bundle is
`target/plugin-refactor/local-bundle-studio-self-macos-arm64-20260930`
(388,800,483 bytes): cleaned core, repaired Console/Studio and sixteen archives.
Its Studio artifact matches self-development acceptance; fifteen other archives
and the core were reused. Complete bundle validation and disposable Studio import
passed in 30.66s; the unchanged installer/core reuse the prior 266.83s
relocation/corruption/path/import/retry/remove/empty-start/restore matrix.
Evidence: `studio-self-bundle-results.json`, `final-bundle-results.json`,
`final-source-refresh-results.json`. Manifests retain exact hashes/sizes;
core build evidence is at `de0fb4f1`. This bundle does not include the newer public
visual runtime/definition-editor work or the unfinished scientific integration.

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
