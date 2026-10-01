# Rho: current state and focus

Updated: 2026-10-01. This is the single summary of implemented behavior, retained
verification, gaps and current focus. Evidence names below are relative to
`target/plugin-refactor/` unless stated. Git retains earlier work orders.

## Current focus

Prepare the next version around a small generic Host, ordinary scientific plugins,
external Agents and independently testable headless capabilities. The direction
is in [Next Version](NEXT-VERSION.md). This milestone reorganizes documentation;
it does not replace the existing Agent, introduce a TypeScript backend, change
runtime behavior or restart a user Host. A bounded implementation flow is still
to be selected. There is no pending full-product acceptance claim.

Current operation and development procedures remain in [Operations](OPERATIONS.md)
and [Development](DEVELOPMENT.md). Approved UI decisions and pending proposals
remain in [Design](RHO-DESIGN.md); they are not prerequisites for every future
headless capability.

## Implemented baseline

- Preview 3 has a native launcher, saved Demo, generic navigation and bundled Ark.
  R is a separately configured local installation. A fresh Preview 3 catalog
  selects immutable plugin packages without replacing earlier catalogs or drafts.
- Sixteen ordinary packages provide the scientific workspace, Agent, Annotations
  and management tools. CLI, HTTP and MCP share the generic Host. Fixed scientific
  composition, old Application/Skill handlers and retired owner/adapter packages
  are removed. Some scientific grants and window-dependent contracts remain;
  see [Architecture](ARCHITECTURE.md).
- Manager can assemble an R scenario from installed exact artifacts, existing
  Ark/R paths and explicit provider activation. Its expanded recipe has sixteen
  instances and eleven initial views. R startup and view switching are separate.
  Remote and Environment remain unconfigured until selected.
- Files, synchronized Editor, R Console, Objects, Packages, Help, Plots and Viewer
  support real local work. Queries do not start R. Observations preserve provider,
  session, source and incomplete/busy status. Packages is read-only.
- The ordinary Agent still contains Rig execution, Native/Rho tasks, settings,
  credentials, attachments, continuation and handoff. New tasks default to
  read-only tools; **Read, edit and run in workspace** adds scoped Files and Editor
  operations. Fresh Send captures targets; Continue retains original grants.
  Context search browses actual files and R objects, and `@` opens its picker.
- Editor Agent runs retain captured code, original Operations and native results.
  Receipt refresh preserves typing. Annotation freeze is separately scoped to
  the original Editor/window; stale edits and changed disk bases are refused.
- Annotations owns versioned text/image notes, exact source references, CAS,
  history, marks and inclusion in an existing Agent draft without sending.
  Eight source entries exist; live-source status stays unknown when unprovable.
- Studio supports source/declaration/canvas editing, checkpoints, branches,
  explicit build, fixture preview, disposable backend tests, scenario application
  and archive import/export. It still has internal Agent-specific entry points.
- Public views use bounded snapshot polling, not a Host push channel. Imported
  packages are immutable; shell development assets do not provide plugin HMR.

## Retained verification

These results apply to their recorded source, packages and environment. They are
not newly rerun by this documentation change. Deterministic model peers establish
protocol behavior, not real-provider reasoning quality.

| Flow | Established result and boundary | Evidence |
| --- | --- | --- |
| Latest Agent → Editor → real R | Six isolated Host/Chrome Gapminder workflows pass, with results 1704/142/703984/6/2007/703984. Agent reads a source-linked Chinese note. Editor SIGKILL plus Host restart preserves uncertain parent/succeeded child, disconnected Editor, suspended R and one effect without replay. Deterministic peer. | `agent-r-workflow-20261001.json` |
| Preview 3 context | File/Editor/R search, stale-write refusal, edit/save/captured-run and reload pass. One real `deepseek-v4.1-flash` run has native R readback 57. Original streaming evidence was rechecked without replay. | `../preview-3/context-flow-final.json` |
| Preview 3 launcher | Demo, Objects, Packages, reload and graceful restart pass. This candidate predates the later Agent/Editor/Files updates, which have separate context-flow evidence. | `../preview-3/launcher-5.json` |
| Scientific workspace | Files → Unicode Editor Save/Run → Console/Objects/Plots; lost activation acknowledgement, scenario switching, close/reopen, drafts and reload preserve original identities and one execution. Scenario restoration preserves live R memory and prior Operations. | `default-entry-results.json`, `final-science-agent-results.json`, `final-science-history-fixed-results.json`, `fixed-composition-results.json` |
| Runtime revisions | Two R revisions coexist during held work; original session, outputs and retries remain bound. Queue, stdin, cancellation and read-only observations pass. Both revisions use the same native executable, not two R installations. | `final-version-studio-results.json` |
| Agent continuity | Native/Rho input, attachments, captured tools, continuation/handoff and graceful same-instance restart pass. Native Resume uses the original Kimi directory and a deterministic ACP peer. R does not restart on observation. | `final-agent-r.log`, `agent-rho-tools-results.json`, `agent-workspace-current-results.json` |
| Source context | Editor/Help/Viewer/Objects/Plots/Console/Packages/Files supply exact references; changed sources are refused and original input survives reload. Original images are explicit. Mode/provider coverage differs by source. | `component-senders-results.json`, `editor-agent-input-results.json`, `object-context-results.json`, `plots-links-results.json`, `console-context-results.json`, `packages-context-results.json`, `files-context-results.json` |
| Process, Environment, Remote | Real Process, local Environment/pak and loopback OpenSSH retain original effects across retries/restart. Failed verification and uncertain exit remain visible. Deterministic peers; no remote-cluster or network-loss claim. | `agent-process-results.json`, `agent-environment-results.json`, `agent-remote-results.json` |
| Annotation records | Source freeze, CAS, historical versions, lost acknowledgements, marks/Undo and original-operation recovery pass with real native owners and controlled Agent peers. Explicit PNG/JPEG context retains original bytes. | `annotation-components-browser`, `annotation-components-native.json`, `annotation-version-browser`, `image-context-results.json`, `annotation-summary-results.json`, `annotation-files-results.json`, `annotation-files-host.json` |
| Annotation UI | Approved AN01–AN06 foundation: eight entries, Files quote and Viewer viewport capture, existing Agent draft inclusion, refresh/source change, keyboard and 600/320px layouts. Captured viewport is labeled non-original media. | `annotation-foundation-files`, `annotation-foundation-viewer`, `annotation-foundation-entries` |
| Actual system IME | Native macOS/Edge input, composition/commit/Enter, focus, draft reload and Save revision 2 pass for Annotations. User confirmed the candidate window; app-only screenshots do not show it. Other controls/OS are not covered. | `m6-system-ime.json`, `m6-ime-composition.png`, `m6-ime-saved.png` |
| Studio and public SDK | Exact-branch checkpoint/build/preview/apply, self-development, forms/Undo, reference synchronization, bounded queries and real Files write/recovery pass. Current views retain original instances. Generic automatic action recovery is not inferred. | `studio-agent-current-results.json`, `studio-self-results.json`, `visual-runtime-results.json`, `definition-editor-results.json`, `visual-science-results.json` |
| Generic extension boundary | Fifty package/runtime/fault cases pass. A public-SDK UI and stateful Python fixture work through unchanged core with one execution on retry and original journal results after restart. Python is a fixture, not a shipped product or memory-recovery claim. | `final-boundaries-results.json`, `final-external-runtime-results.json`, `generic-contract-results.json`, `generic-state-results.json` |
| Independent packages | Sixteen archives pass import/remove/empty-Host/explicit restore. Empty startup does not silently reinstall packages. | `final-delivery-contents-results.json` |

The latest Editor workflow also has focused Agent/backend, Host, source-owner and
client evidence. Full workspace totals and retired test counts are not carried
forward as current passes. Exact commands and assertions remain with their runs.

## Open acceptance and product limits

- `m6-final-acceptance-matrix.json` reconciles PS01–PS07/AN01–AN06 scope and delivered
  artifacts. Assessment is complete; full product acceptance is **false**.
  The earlier `final-acceptance-matrix.json` is historical evidence.
- The historical 33-case real-provider matrix has 12 passes (Objects, Packages,
  Environment and Workspace, three repetitions each), 3 partial Plots cases
  (metadata, not requested visual color understanding), and 18 document-dependent
  cases not run at that time. The later six deterministic Editor workflows do
  not retroactively pass this provider-quality matrix. Evidence:
  `m6-live-matrix-results.json`, `m6-live-matrix-reviewed.json`,
  `m6-live-objects-results.json`.
- The `Qwen3.8-27B` image diagnostic returned HTTP 200 without visible text. Image
  interpretation and followup remain unverified. A successful transport is not a
  successful model response.
- Graceful restart does not establish general abrupt-crash or R-memory recovery.
  The latest targeted Editor SIGKILL case proves only its stated boundary.
  Unacknowledged browser edits are not known to be saved.
- The local Remote/Environment checks do not establish remote package resolution,
  cross-machine failure recovery or renv restoration. Different R installations
  require the opt-in `RHO_ALT_*` checks.
- Historical native compilation/loading stalls have an unproven OS cause. Inspect
  existing process/log evidence, preserve caches and avoid duplicate Cargo work
  or user Host restarts. See `development-optimization-results.json`,
  `annotation-output-results.json` and `../preview-agent-fix/cache-recovery.json`.
  Unfiltered offline Cargo metadata encounters uncached `combine 4.6.8`;
  host-filtered metadata passed.
- HV01–HV07 Help/Viewer refinements and R01–R03 runtime-navigation designs remain
  proposals. UI usability remains subject to actual user review; see
  [Design](RHO-DESIGN.md) and [Feedback](STUDIO-FEEDBACK.md).

## Last verified development bundle

The retained portable bundle is
`target/plugin-refactor/local-bundle-m6-macos-arm64-20260930`, **391,727,116 bytes**.
Its recorded core source is `09633b76`; assembly explicitly records a dirty source
checkout. Thirteen packages were refreshed; Environment/Process/Remote archives
were reused byte-for-byte. This is an artifact-specific result, not a claim that
the bundle contains every later source change.

Relocation, corruption/path checks, import/retry/remove/empty-start/restore and
Studio editing/build/preview/apply pass. The delivered SDK performs the real Files
patch/recovery flow. Exact revisions, hashes and sizes are in the retained
manifests. Evidence: `m6-bundle-refresh.json`, `m6-bundle-acceptance.json`,
`m6-delivery-results.json`.

Verified bundle target is macOS 26.5.2 (25F84), Apple Silicon arm64. Native R
is acquired per machine. Existing signatures are ad hoc; Developer ID signing,
notarization, user installation, publication and a complete licensing audit are
not established. See [Release](RELEASE.md).

## Continuation boundary

No user Host or R memory was restarted for this documentation work. Before
starting another Host, inspect the current project/session and follow
[Operations](OPERATIONS.md). Client refresh cannot add Host capabilities. New
plugin revisions need explicit snapshot/activation; old instances keep immutable
assets. Replacing the R-owning backend can end R memory.

The next implementation should select a bounded headless flow from
[Next Version](NEXT-VERSION.md#首批范围与推进顺序), declare its real-owner and recovery
checks, and independently scope any UI work. No abandoned-data migration, general
Shell product, new built-in Agent or wider distribution work is implied.
