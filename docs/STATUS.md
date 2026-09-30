# Rho: current state and focus

Updated: 2026-09-29. This is the single current summary of behavior, evidence, open work and the next milestone.
Git and `target/` retain history and failed attempts. Keep this page under about 300 lines ([Development § Status discipline](DEVELOPMENT.md#status-discipline)).

## Current focus: unified plugin refactor

The user authorized the entire unified-plugin plan on 2026-09-23: all scientific
owners and views as ordinary plugins, coexisting versions, project scenarios,
public SDKs and Plugin Studio as an ordinary plugin. PS01–PS07 are approved in
Paper; see [Design section 21](RHO-DESIGN.md#21-unified-plugins-and-plugin-studio--approved).
**Fixed browser, Workbench profile, internal scientific Host composition and Application/Skill handlers are removed. CLI/HTTP/MCP use ordinary plugin capabilities. The fixed owner/adapter crates, Application owner and typed storage are also deleted, including legacy scientific/Application shared-port DTOs.** Ordinary packages exist
for R, Files/Git, Process, Remote, Environment, Editor, Console, Objects, Packages,
Help, Plots, Viewer, Manager, Studio, Agent and Annotations (`plugins/`). Each has individual acceptance evidence. Sixteen-plugin archive delivery now passes; final scenario integration, cross-plugin
workflows and final acceptance remain; the portable internal development bundle now passes relocation/import/startup acceptance.

### Work order (reset 2026-09-28)

Work is organized as end-to-end user flows. A milestone is complete when its flow
works in the ordinary plugin composition, its heavy acceptance has run once on the
settled source, and the fixed-composition path it replaces is deleted or has a
written deletion condition. Internal pieces are not reported as milestones.

| # | Milestone (user flow) | Replaces / deletes | State |
| --- | --- | --- | --- |
| M1 | **Default plugin scenario as the primary composition.** `rho` opens a project in the ordinary plugin window with R, Console, Objects, Files, Editor, Plots, Viewer, Packages, Help active; Run File → Objects/Plots works with real R. | Fixed scientific panels and their private client models deleted | Default entry, full delivered-set setup, real-R browser flow and Rust HTTP checks pass |
| M2 | **Ordinary Agent view, first vertical slice.** Open Agent view → pick a document or file attachment → Send → native tool calls a real R/Files plugin → results shown → browser reload finds the original record. | Fixed Agent panel and private frontend endpoints deleted | Combined real Host/browser flow passes: Native/Rho input, attachments, real R, reload, continuation and handoff |
| M3 | **Actual Host restart recovery.** Restart the generic Host during M2's flow; the same instance/task recovers its original records without replay. | — (risk reduction; do early) | Graceful Host restart, same instance/view/tasks, original receipts and native session Resume pass without replay |
| M4 | **Agent context and continuation.** Contributed context sources (help, viewer, annotations, documents), component input and continuation through the ordinary backend. | Fixed Host context, Application adapters and legacy contract DTOs deleted | Editor/Help/Viewer snapshots, history, Continue and handoff pass real Host/browser checks; Rho exact-session tools and Editor/Help/Viewer/Objects/Plots/Console/Packages/Files Ask → Agent input pass; annotation text/context and Native/Rho Send pass real Editor and real-R Help/Viewer/Console/Plots/Objects/Packages source flows with same-instance restart; the picker and Native read/write tools also pass; resource-image import/read, explicit Native/Rho image context, picker thumbnails and restart pass; browser capture, annotation editor and component annotation controls remain |
| M5 | **Studio Agent assistance.** Exact development branch capture; separate checkpoint, build, preview and scenario-application actions. | — | Combined real Host/browser flow passes: exact-branch Agent checkpoint, explicit build, preview and scenario application |
| M6 | **Final composition.** Default delivery through the same repository/lifecycle, all feature plugins removable, no silent reinstall; remove fixed registrations, panels and scientific/Agent branches; full-plan acceptance matrix. | All remaining fixed composition | Sixteen ordinary archives pass import/remove/empty Host/explicit restoration; delivered-set → Manager → full scene passes real R/browser and activation-reply recovery. Portable development bundle passes relocation/import/empty startup; real-R running-scene switch/close/reopen/draft continuity also passes. Fixed frontend, private Agent/annotation/HTML HTTP and Application Agent/annotation adapters removed; fixed scientific Host composition and Application/Skill handlers removed; legacy shared-port DTOs are deleted; final matrix remains |

The fixed frontend removal retains 135 core UI tests and shrinks embedded JavaScript by 69.5%; real-R scene and draft continuity evidence remains in `target/plugin-refactor/fixed-client-results.json`. Private Agent/annotation/HTML routes and their Workbench services are deleted; real Agent→Process, Editor/Files→annotation and R Viewer restart evidence is in `fixed-http-results.json`. Automatic R discovery/settings/startup fallback and three R/settings/resident-bridge routes are also removed; bounded shared transport, 15 Workbench tests and startup/large-draft browser checks pass (`fixed-runtime-edge-results.json`).

Host-owned Agent services, `rho-agents`, Application Agent/annotation adapters, SQLite forwarding stores and legacy Agent/annotation/HTML-token DTOs are deleted. Generic state no longer creates/opens retired plugin databases; existing files remain untouched. The Host now composes only generic plugin, Operation, discovery and test-project ports. Fixed R/runtime-instance, Files/Git, Process, Remote, Environment and Skill wiring, Application execution/binding and native-output MCP special routes are deleted. Ordinary-plugin fixtures now use the generic Host instead of the removed constructors.

The fixed scientific owner/adapter packages and Application owner are removed: the Cargo workspace now has 39 packages (51 before cleanup). SQLite keeps only generic scoped, versioned key/value state. New state stores create no fixed window/document/command, Skill or R-instance tables; opening existing state does not import or remove abandoned records. The unused Host recovery-protection source is also deleted. The normal Host graph is now 124 unique package names/8 local (239/31 before fixed composition removal). Core Contract no longer depends on the five scientific API packages. Fixed request variants, typed scientific overview branches and MCP live-bridge window observations are deleted; discovery uses visible registered domains, and Operation navigation retains only generic record/evidence links. The preceding unused-package cleanup preserved the exact verified binary (`retired-adapters-results.json`); this state cleanup has its own rebuilt-binary checks below.

Final acceptance now strengthens real R version coexistence: a native socket holds an original execution while a second revision activates and starts its own session; original operation/provider/session/output, retry identity and variable isolation remain intact. The complete real-R fixture passes in 29.49s, including queue/commit recovery, pending input during drain, cancellation, read-only Packages/Help/Objects and retained PNG/HTML. It reuses the newer R package with zero native builds. Two earlier failures used an old package missing Viewer context; preflight now rejects missing required capabilities before native startup. Studio editing/preview/scenario browser checks pass (3 cases, 38.5s), including source/canvas undo, invalid draft recovery, custom source preservation, clipboard, synthetic composition events and historical live-view restoration. Nine screenshots at normal/wide/constrained widths were inspected. Evidence: `target/plugin-refactor/final-version-studio-results.json`; the working full-plan audit is `final-acceptance-matrix.json` and remains incomplete. Final fault/boundary acceptance passes 50 Host/runtime/package cases (24.57s compilation), including failed activation, backend crash, forged/disordered/oversized messages, unconfirmed cancellation, lost settlement and contained paths. External public-SDK browser and docking checks pass (2 cases, 20.6s); held layout-save/focus/close recovery passes three consecutive runs (22.6s), and its new retained-Host/dev-assets route passes once (7.4s). Ten normal/wide/narrow/recovery captures were inspected. Initial focus failures retained: DOM geometry settled before pointer routing reached the selected iframe; the fixture now waits for child and parent painting, without forced focus or product changes. Visibility/size experiments were reverted. Evidence: `final-boundaries-results.json`; zero native plugin or main binary builds. OS-level IME and full-plan completion remain unverified. Earlier scoped storage evidence remains in `generic-state-results.json`. External runtime acceptance now executes real stateful Python through an outside package and the frozen core (3.41s, zero builds): two process/session identities, statistics and retained variables, wrong-session refusal, single execution on retry, and original journal output after release/Host restart. It is an acceptance fixture, not a shipped Python feature or memory recovery. The current core also passes all sixteen retained-package import/remove/empty-start/restore checks, with every archive field and exact blob preserved. Nine exports change only JSON object order; the old whole-container-hash assertion failed and remains recorded. Input integrity checks stay intact. Evidence: `final-external-runtime-results.json` and `final-delivery-contents-results.json`; the current portable bundle refresh is recorded below; final composition remains incomplete.

Prior fixed-composition acceptance passes 108 Host/MCP/Workbench/CLI cases; 10 externally conditioned cases remain ignored, not passes. The initial binary build takes 12.88s; embedding the saving-indicator fix takes 17.87s. Actual stdio MCP, HTTP/connected CLI and Agent→Process normal/Stop/same-instance restart pass with zero plugin builds; the latter takes 77s. The current full sixteen-plugin real-R browser scene and running-operation/draft continuity pass in 2.4 minutes, including the held-save geometry regression. The 29 related UI cases, client build/check/typecheck also pass. Initial click and fixture-baseline failures remain retained. Evidence: `target/plugin-refactor/fixed-composition-results.json`. Retired fixed-owner tests are removed, not counted as passes. The previous Agent/annotation contract generation checks remain in `agent-contract-removal-results.json`.

Public plugin schemas, SDKs and native package bytes are unchanged by the core Contract cleanup; 261 obsolete client bindings are removed. The 64 affected Rust cases and 32 client cases pass, with public/core generation and client build/check. The rebuilt main binary takes 56.10s; actual HTTP/MCP/connected CLI and startup/project/reload browser checks pass (browser 3.0s). Actual Agent→Process readonly/normal/Stop and same-instance Host restart pass in 72.55s with zero plugin builds and no scientific replay (deterministic ACP peer, not real-model reasoning). The first two compile attempts exposed retired navigation DTOs and a Workbench dispatch variant; both failures are retained. Evidence: `target/plugin-refactor/generic-contract-results.json`. The final full-plan matrix remains; no user Host restart or delivery-bundle replacement is claimed.

### Scientific scenario: current integration

The ordinary Manager now provides **Scenarios → New R workspace**. It selects
installed exact artifacts for nine scientific plugins and existing Ark/R paths,
activates their instances, saves a checkpoint and prepares their views. Switching
the window and starting R are separate explicit actions. Files passes its captured
R provider to newly opened Editors; Help has an initial empty view until a package
is selected. The same recipe now optionally includes installed Process, Remote, Environment, Annotations, Agent and Studio, giving sixteen instances and eleven initial views with Manager. Agent offers fourteen exact provider tools, initially unchecked; its context and Studio grants come from the selected public declarations. Remote/Environment retain unconfigured defaults. Lost preparation receipts retain their original requests and instances; recovery follows provider-before-consumer order even when saved JSON keys reorder, and never advances automatically.

Verified with a disposable generic Host and real R: Manager preparation/switch →
Console Start R → Files opens a Unicode-named file → Editor Save and Run → original
Console output, Objects value and Plots image. Browser reload preserves the native
session and the single original execution. Setup and result screenshots were
inspected; the Manager dialog also passed normal, wide and constrained layouts.
`target/plugin-refactor/scientific-workspace-results.json` records the checks,
artifact reuse and limits; browser evidence is retained beside it. Current R and
Editor native artifacts were reused, and Files was built once through the primary
workspace cache. This is integration evidence, not a new independent-source build.
The full sixteen-archive scene passes Manager activation-reply recovery, actual R execution, Objects/Plots, Agent/Studio entry and running-operation continuity. Switching scenes and closing/reopening Console/Editor preserve drafts, provider/session/source-view identity and exactly one file effect. Current frozen-core historical-restore acceptance also retains R memory (`scene_continuity = 73`), the original Operation, scientific files, Agent settings and credential bytes created after the old checkpoint. Restoration creates a new checkpoint and leaves both earlier definitions intact. The initial run passed in 2.7 minutes; a child/parent paint synchronization fix produces the previously blank Objects capture in a passing 2.6-minute rerun. Evidence: `final-science-history-painted-results.json`; the earlier blank screenshot is retained. Visual inspection separately exposed Console rejecting equal live/retained events because JSON fields were ordered differently. Its focused regression fails before the canonical-comparison fix and passes afterward, while changed text/identity/order remain refused. Only the Console UI archive is rebuilt; fifteen archives and the Host are reused. Final real-R Console readiness plus the full scene/history flow passes in 2.7 minutes (`final-science-history-fixed-results.json`); inspected captures show Ready/input available and the original memory value. `final-science-agent-results.json` records the combined evidence and limits. This does not establish remote-cluster behavior or a user install.

Default entry is implemented: `rho workbench` selects the ordinary plugin profile, accepts browser project selection and offers installed standalone views in an empty window. It retains activation/open requests before dispatch. The 25 frontend startup cases, three CLI cases, four default-entry/window browser cases and two Rust HTTP cases pass. The real-R flow uses browser project/Manager selection and recovers a lost activation reply without duplicating the instance or execution. Evidence: `target/plugin-refactor/default-entry-results.json`; interrupted broader CLI checks and earlier startup failures remain retained, not passes.
All writer/server entries use a generic plugin Host. Fixed scientific startup flags, implicit R invocation targeting, method-binding CLI commands and the fixed browser/Codex transport runners are removed. HostProfile now contains only a database path; fixed runtime selection, project-switch binding rewrites and deferred-R startup are deleted. Standalone `query` reads discovery and an existing journal only, retaining canonical project/principal visibility without Files/R/output owners, runtime startup or recovery. Eight Host/observer cases and twenty Workbench/CLI cases pass; real HTTP/MCP/connected CLI, stdio MCP restart idempotency and the default startup/project/reload/no-silent-reinstall browser check pass. The final Host build takes 8.59s and the browser check 4.2s, with zero plugin builds. Evidence: `target/plugin-refactor/generic-observer-results.json`; previous CLI coverage is in `cli-plugin-only-results.json`. This earlier observer-only evidence is superseded for the current Host by the affected suite above. No user Host restart or bundle replacement is claimed. Legacy shared-port DTOs are now deleted; the final matrix remains open. The sixteen-archive delivery set passes explicit catalog import/remove/empty-Host/reimport with byte-identical restoration (`default-delivery-results.json`). The current portable macOS arm64 development bundle includes the cleaned core, repaired Console and all sixteen ordinary archives. Five source-only revisions synchronize four README files and one Packages test; eleven archives are copied unchanged, and every runtime file retains its accepted digest/size/mode. The audit finds no missing tracked plugin source, 1,109 matching first-party files (excluding generated manifests/retargeted Cargo manifests), and 4,792 matching public/copied source files; Packages type compilation and all 34 focused tests pass. Relocation to a Unicode/spaced path, corruption/path refusal, import/retry, complete removal, empty default startup and explicit restoration pass in 266.83s with zero Host/native builds. The verified bundle is copied with matching hashes/modes to `target/plugin-refactor/local-bundle-current-macos-arm64-20260929` (388,794,336 bytes). `final-bundle-artifacts.json` records every size/hash, source commit `d0911988`, exact core build evidence at `de0fb4f1`, and checks; `final-bundle-results.json` retains the relocated test artifact. Read-only signature inspection finds ad hoc signatures and no TeamIdentifier on the core/eight native backends. This is not Developer ID signing, notarization, user installation/publication, a complete licensing audit or full-plan completion; annotation UI/review and OS-level IME remain.

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
reload. The pre-removal baseline passed 566 core frontend tests, including 42 recovery/view cases; retired renderer tests do not count as current plugin coverage. The focused
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
Current frozen-core/retained-archive Agent acceptance also passes in 2.5 minutes with zero builds: 8 MiB attachment/import-reply recovery, Editor/Help/Viewer context, real R, continuation/handoff, browser reload and graceful same-instance/task/view Host restart without replay. Native ACP and model peers are deterministic local fixtures; no external-model reasoning or abrupt-crash recovery is claimed. `RHO_PLUGIN_SET_PACKAGE` imports the existing validated set directly and records its index and Host hashes; it does not pretend stale build receipts verify current source. Evidence: `target/plugin-refactor/final-agent-r-browser/agent-workspace-ordinary-n-217bb-ugh-reload-and-Host-restart/agent-native-result.json` and `final-agent-r.log`; earlier source-build evidence remains in `agent-workspace-current-results.json`. No user Host was replaced or package installed/published.

### Agent migration: current state

Implemented in `plugins/agent` (public APIs/SDK only, no private core imports):

- Transport, native/component task owners, credential/metadata storage and the Rig
  driver. One Agent-owned `agent-v1.sqlite` repository; no old-table reads, no
  second scientific journal. Development checks have not opened user keys.
- Ordinary backend: metadata, task create/draft/rename/archive, controller
  takeover, model settings/diagnostics, scoped credential Control, component model
  runs, native task commands, attachment Control and original-request observations.
- Native Send captures explicit Query/Operation targets and scopes. Optional grants
  cover 103 public R, Files, Process, Remote, Environment, Editor and Annotation contracts plus
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
The UI build and 108 model cases (30 native, 13 settings, 38 Rho, 16 context, 11 handoff) pass, as does
the synthetic public MessagePort browser fixture: opaque iframe, IME Enter, task
switching, native/Rho attachment recovery and retained context, next drafts, 8 MiB selection, lost creation/Send/import/key
replies, actual reload, history and close without Stop. Settings/rename work without
form permission. Continue preserves next drafts through lost replies/reload and original context
at 960/440/220 px. Handoff also preserves edited text, references and lost receipts at those widths.
Current scoped checks cover context/history/Continue, handoff, uploads and reopen;
interrupted attempts remain incomplete evidence. The 45-capability manifest includes
all attachment ports and stays within 256 KiB. Workspace-built Agent artifacts are
reused. Own-backend calls retain selected activation scopes; reverse calls still
require individual grants and enforce caller, foreign-provider and Query boundaries.
Eleven Host delegation/test-project checks pass. Immediate task selection fences
handoff from the prior task while saving. Native Resume uses Kimi with a local ACP
peer; original real-R results survive restart. Other providers and abrupt crashes
remain unverified.
R declares observed Help topics, bounded object summaries and saved HTML/plot contexts; previews check original native handles/sessions, installed files or output records.
Twenty-four context tests and real-R Host flows pass. The Agent picker has actual Host/browser evidence: Help excerpts and saved HTML join Editor input/attachments,
reach the model, and survive Continue, reload and Host restart while R stays suspended. Normal/390/220 layouts are checked.
Component-request reception appends checked sources once to editable Native/Rho drafts. Editor, Help and Viewer **Ask about…** now open a chosen active Agent instance with exact document, installed-topic or saved-HTML references. Real Host/browser flows pass original-opening settlement, lost replies, draft insertion and reload without duplicate views or Send; a newer Viewer output leaves the prepared source unchanged. Normal/390/220 layouts are inspected.
Objects now adds exact-handle metadata and recognition samples (including nested paths) through Ask or the picker to a Rho draft and explicit Send. Real R/Agent/Rig browser checks pass; changed sources refuse Send and retain the draft, while original input survives actual Host restart and an old handle cannot start resumed R. Normal/960/390/220 previews are inspected; 72 UI cases include original-opening recovery without a live R observation. Evidence: `target/plugin-refactor/object-context-results.json`; earlier fixture failures are retained.
Plots retains one/two originals independently of later outputs. Explicit images (PNG/JPEG ≤2 MiB each) or metadata pass preview → chosen Agent → Rho browser Send / Native API Send → text-only follow-up → actual Host restart. Sent context exposes original-image and producing-run reads through public queries, with exact owner/digest checks and normal/960/390/220 layouts inspected. The combined real-R/browser/Rig/ACP flow passes in 90s; saved Native image metadata now satisfies its strict output contract. Repeated Send and post-restart context reads do not replay the model or start suspended R. Agent backend 66 cases, UI 108 cases plus artifact checks, and R context 18 cases pass; prior 34 Plots / 10 shared-sender cases still apply. Evidence: `target/plugin-refactor/plots-links-results.json`; initial wrapper/schema failures remain retained. Native browser Send and real-model quality are not newly verified.
Console Run Details now previews original code or code with complete saved event text, opens a chosen Agent and retains its request/draft. Real R → browser Ask → Rho Send → Host restart passes in 81s; new output cannot replace the original, changed digests are refused, and bounded search passes across nonmatching operations. Normal/960/390/220 previews are inspected. Console build/model checks, 21 R context cases and 99 scientific grants pass. Evidence: `target/plugin-refactor/console-context-results.json`; the initial test compile error and insufficient fixture page limit remain retained. Native Console Send and quoted subranges are not newly verified.
Packages Ask now retains the selected installed copy’s native session, original observation, library and version. Preview → chosen Agent → Rho draft/reload → explicit Send → actual Host restart passes in 80s; changed libraries and old native observations are refused, and fresh loaded-package observations confirm the copy stayed unloaded. Normal/960/390/220 layouts are inspected. Packages has 34 UI/model cases; R context has 24, with 101 scientific grants checked. Evidence: `target/plugin-refactor/packages-context-results.json` retains the initial compiler timeout/error, corrected view-opening grant and fixture failures. Native Packages Send and real-model quality are not newly verified.
Files Ask now captures the original contained text file by path, digest and native identity. Metadata/text preview → chosen Agent → Rho draft/reload → Send → actual same-instance Host restart passes in 72s. Unrelated file edits preserve the source; changed originals and path escapes are refused, while the saved run retains its original text without replay. Normal/960/390/220 layouts are inspected, including a wrapped narrow footer. Five Files backend cases, 30 UI/model cases and 103 scientific grant contracts pass. Evidence: `target/plugin-refactor/files-context-results.json`; Native Files Send and model quality are not newly verified.
Remaining: annotation browser capture and editor UI. Evidence: `component-senders-results.json`, `editor-agent-input-results.json`, `agent-component-input-results.json`,
`agent-scientific-context-current-results.json` and `studio-agent-current-results.json` in `target/plugin-refactor/`.
Native Agent → private MCP → real Process preflight/run/resource-read now passes read-only and forged-provider refusal, Unicode stdin/stdout/stderr, one-effect tool/Send retries, Stop waiting for its accepted child, and actual same-instance Host restart while Process stays suspended. This exposed and fixed successful Process results being misreported as uncertain when preflight normalized a null target to the project root. Normalized replies now require the original Host reverse-request mapping plus unchanged provider/project/capability/preconditions and parent identity; malformed or unconfirmed replies still refuse. Four Agent library and 66 framed checks pass. Only Agent was assembled using the workspace cache (3s); fifteen archives and the frozen Host were reused, and real-process acceptance took 74s with zero builds. Evidence: `target/plugin-refactor/agent-process-results.json`; `agent-process-before-fix.json` retains the real failure and earlier fixture attempts remain. The peer is deterministic; this does not establish real-model quality or Rho-model Process execution.
Native Agent now also reaches the real Environment plugin and installed R/pak: read-only preflight refuses unselected work, explicit refresh → local-package plan → isolated realization → verification → inventory/library selection and bounded report reads pass. Cached/unavailable inventory remains partial. Tampered library metadata produces a genuine failed verification; Send can finish while retaining that scientific failure. Tool/Send retries and actual same-instance Host restart retain original success/failure records while Environment stays suspended, with no additional native namespace loads. All sixteen archives and the frozen core are reused with zero builds; the combined flow passes in 86s. Evidence: `target/plugin-refactor/agent-environment-results.json`; the initial two fixture assertions about partial observations remain retained, and `agent-environment-attempt3.json` is the first passing baseline. This covers a deterministic ACP peer and a local dependency-free package, not real-model quality, Rho-model Environment execution, remote package resolution, renv restoration or material cleanup through Agent.
Native Agent → real Remote plugin → actual loopback OpenSSH now passes read-only preflight without a connection, forged-target refusal, Unicode streams, exit 9 failure, exit 255 uncertainty, Stop waiting for accepted SSH work, and actual same-instance Host restart with Remote suspended. Four native operations produce exactly four authenticated SSH connections and one file effect each; tool/Send retries and restart add neither. A successful read of the native ACP receipt does not promote the original Send or SSH Operation from uncertain. The temporary sshd uses private keys/configuration and a pinned host key; no user SSH files or system service are changed. Frozen core and all sixteen archives are reused; acceptance takes 75s with zero builds. Evidence: `target/plugin-refactor/agent-remote-results.json`; two initial fixture expectations (structured error shape and receipt-read versus original-operation status) remain retained. This is real SSH on one machine with a deterministic ACP peer, not Slurm/cluster, cross-machine network-loss, real-model or Rho-model Remote acceptance.
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

- Native compilation/loading can stall before test execution. Files' two 300s
  compiler timeouts preceded a 103s enumeration of 239,810 cache entries; preserving
  every entry in a fresh hardlink directory reduced listing to 1.31s and the test
  run to 22s. This is temporary recovery: the subsequent annotation-output run
  listed 243,020 entries in 29.9s, built R in 115.6s, and hit pre-test startup
  timeouts even for an identical executable copied elsewhere. The OS cause remains
  unproven; no cache/security changes were made in that run. Preserve the macro-cache symlink and backups. Evidence: `target/plugin-refactor/annotation-output-results.json`, `files-context-results.json`; earlier diagnostics remain retained.
  Agent/R/Files/Editor/Process/Remote/Environment default to workspace reuse; native browser runners reuse retained packages. Process/Remote/Environment actual assembly passes in 89.9/81.7/114.1s; build-mode dispatch and public-boundary checks pass. Independent compilation requires an explicit flag. Plugin tests exclude unused Application/Agent owner/store dependencies.
- Plugin backend native initialization occasionally exceeded ten seconds before
  reaching the program entry (Studio backend browser runs); cause not established.
  Agent context tests also timed out before entry (180s); a byte/attribute-identical copy outside `target/debug` passed all five in 2.1s. Original timeout remains; underlying loading issue is unresolved.
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

## Product behavior and remaining migration boundaries

These describe preserved behavior and remaining UI gaps. Fixed frontend source
has been removed; remaining backend adapters and plugin verification are separated
below. Details live in Design, Architecture and Git history.

- **Demo project.** Welcome page and `rho --demo-project workbench` materialize a
  writable base-R Gapminder project; opening it does not run R, install packages or
  contact an Agent.
- **Console safety.** Console, Run Selection and Run File share a per-session
  submission gate and R parser preflight. Transport loss fences the session and
  keeps the uncertain Operation. `print.htmlwidget` produces retained `text/html`
  artifacts shown in Viewer.
- **Help, Viewer, annotations.** Help reads exact-copy Rd as text/HTML; Viewer captures HTML with inlined assets.
  API/owner/store and ordinary native text RPC/context live in `plugins/annotations`; the workspace-built package passes a frozen generic Host flow with the real Editor source. Metadata scopes reuse application read/control; no Host annotation branch is added.
  Freeze → note → context, source-change refusal, continuation, CAS, tombstone/history and actual same-instance graceful Host restart pass; the source remains suspended during receipt replay. New native (6), Editor (5), R context (12), owner/store + adapter (14) and fixed HTTP (3) cases pass; prior timeouts remain evidence.
  Agent Rho Send/picker and Native read/create/update/CAS pass with local HTTP/ACP peers. Read-only Send refuses writes; malformed arguments are refused before child admission (9 native regressions pass). Both Native Sends and Rho Send replay after same-Agent restart while annotations stay suspended: three original write Operations, two ACP prompts and one model request. Public PNG/JPEG import/read now decodes bounded bytes; a 196,947-byte PNG, Editor-bound image anchor/marks, corrupt-image refusal and original image/receipt after Host restart pass, including the combined Agent flow. Explicit image inclusion now reaches Native/Rho Send with exact bytes and marks; the picker validates and displays thumbnails. Context permits two PNG/JPEG images ≤2 MiB each, stored separately under a project budget. Rho requires the current model image diagnostic; text followup and original Send replay after restart do not resend pixels. Real R-owned Help/Viewer/Console/Plots/Objects/Packages freeze → note → Agent flows now pass; Objects and Packages version only bounded summary/copy metadata (explicit scope), not whole native values or package files; fresh observations preserve that version while changed summaries differ and obsolete references are refused; Console code/transcript share the original run identity, while Plots freezes metadata with original output/image identity (not pixels); later HTML output cannot replace original evidence, and forged resources are refused. After Host restart, original notes and Sends replay while R stays suspended; new captures against that suspended source fail without creating receipts. Files also supplies path lineage/content digest with exact native-identity checks; quote freezing, repeated observations, atomic saves, changed-source refusal and same-instance Host restart pass (5 Files and 9 annotation native tests; real Host flow 25.7s). Browser capture and annotation UI remain; fixed Application/context/storage adapters and private HTTP services are deleted; the ordinary annotation UI remains open.
  AN01–AN05 and HV01–HV07 await review ([Design 19](RHO-DESIGN.md#19-r-help-interactive-viewer-and-lighter-controls--proposal), [Design 20](RHO-DESIGN.md#20-component-annotations-for-people-and-agents--proposal)); lighter chrome, system-browser open and Help anchors remain.
  Evidence: `target/plugin-refactor/image-context-results.json` retains 73 scoped native checks, 108 UI checks and the actual combined Host/browser/restart flow (87.8s), alongside prior annotation reports. `annotation-summary-results.json` covers all six R contexts → notes → Agent → same-instance Host restart (99.0s), with 24 R context and 9 annotation checks passing on current source. Earlier `annotation-output-results.json` retains the three pre-test startup failures and the fixture-concurrency failure; record inspection remains bounded to four calls. Prior `annotation-scientific-results.json` evidence remains retained. Picker screenshots inspected at 1440/960/390/220px, including scrolling to the full image and Add button. A silent ACP completion previously stalled Send because the observer ignored the new request identity; a failing baseline and passing regression confirm the fix. Earlier scope/fixture failures and two Host timeouts remain retained. `annotation-files-host.json` adds Files evidence/recovery; the initial bounded-observation fixture failure is retained in `annotation-files-attempt1-host.json`. No user Host restart, package installation, annotation editor UI or abrupt-crash acceptance.
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
