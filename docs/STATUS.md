# Rho: current state and focus

Updated: 2026-09-13. This is the single current status summary. Git retains history.

## Built-in component Agent implementation

The [implementation plan](BUILTIN-AGENT-PLAN.md) is authorized. The user approved
[Paper B01–B06](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/A-0) on
2026-09-13. The Rig backend and the seven Studio entrances are now implemented.
The first-version implementation and scoped acceptance are complete, with the
verification limits below. No deployment or installation is implied.
The user reviewed the launched local binary and confirmed it was usable on
2026-09-13. The independent preview was then stopped through native session
shutdown and Workbench Quit, retaining its recovery copy.

The optional `rho-agents` crate pins Rig 0.42; Application owns conversations,
request identities, scopes and receipts. Host binds the existing scientific ports.
Objects, Packages, Plots and Environment are Explain-only. Documents, Workspace and
Project support explicitly scoped editing, saving and R execution. Exact document
versions and destinations, native R session identities, retained operations and
original output references remain authoritative. No scientific owner calls models.

### Studio behavior

Ask buttons live in existing component title bars; Environment/R Sessions has an
Ask action in its page. All use the same Rho Assistant area, with grouped built-in
conversations and external tasks, a narrow selector, owner-backed source search and
preview, fixed context chips and separate model settings. Opening an existing panel
never sends a model prompt or scans a CLI. The selected document is synchronized
through the existing Application bridge before its version and checksum are read.

Explain is read-only. Edit/Run show the bounded targets and per-document save scope.
Model settings expose the remote destination, Anthropic/OpenAI-compatible protocol,
session-memory or environment credential reference, and explicit synthetic
connection/image tests. Image input requires a passed test for the exact saved
connection. Model text is displayed separately from native tool results and links.
The shared native IME composer preserves preedit and saves only committed text.
Long replies follow new output while at the bottom; manual earlier reading remains
in place until Jump to latest is selected.

The client retains bounded local drafts, selected context and submission identities,
with CAS conflict copies and project/window response fences. It never automatically
replays an unknown submission. A completed initial HTTP rejection releases the
retained draft only after an authoritative query proves no request was accepted;
an uncertain retry cannot use that shortcut. Stop, Check status, takeover and
Continue are explicit. Continue retains the original authorization and rechecks
confirmed document references. Another window's draft is read-only until takeover.
Maximizing a group removes the normal multi-column minimum width, keeping the
assistant usable in a 320 px panel and a 600 px workspace.

### Backend and recovery

- Rig drives bounded model/tool execution. Tool intent precedes dispatch;
  semantically identical mutations reuse original receipts across changed call IDs
  and confirmed continuation ancestors. Repeated save acknowledgements cannot
  create a second scientific execution.
- Captured document edit/save/run uses Application's resident bridge. Literal
  replacement computes owner-side UTF-16 ranges and rejects ambiguous/stale text.
  Receipts return immutable document summaries with exact draft SHA-256 values.
- A failed R operation pauses its native queue. Resume is explicit and restricted
  to the original operation lineage; unrelated/manual work cannot be resumed.
- Stop fences new calls; native tracking survives dropped model waits. Reconcile
  observes the original operations/documents without replay or model calls.
  Missing evidence remains uncertain. Takeover never cancels another R operation.
- Source/image reads use native owners. Up to two bounded PNG/JPEG images are
  transient model inputs; no image bytes or raw credentials enter conversation
  storage. Package help uses the observed installed copy without loading/installing.
- SQLite bounds total component payload at 64 MiB with reserved completion space.
  Event pruning preserves request/tool identities. Indexed run history has stable
  32-item pages; the browser bounds drafts, history, events and pending requests.
- Model settings accept HTTPS or loopback HTTP; credentials resolve lazily.
  Diagnostics retain exact configuration digests and use no scientific tool port.
  Model concurrency, request duration, calls, text and image bytes remain bounded.

### Executed evidence

- The fixed backend/model matrix passed **27/27** on
  `b288a081f2f862398eb907f5e6096ce616bfb59a`, with seven profiles and two repair
  workflows repeated three times. Service: Anthropic Messages,
  `deepseek-v4.1-flash`. The final report is
  `target/component-matrix/2026-09-13T12-01-56.815Z/summary.json`;
  `matrixComplete=true` and `allPassed=true`. Its backend/source fingerprint is
  `44cdf49e8a7c515b5d3f97c3c032ef15f6f16d2a03a4b181ac178770f450c2c4`.
  Original failed matrices remain in their separate directories. The final fixtures
  use explicit source citations, final-answer extraction, manual recovery policy
  and the published run duration plus 15 seconds; they do not turn previous failures
  into passes or establish error-free future model behavior. Subsequent production
  changes only refine transcript following; engine/scientific owners are unchanged.
- **Two real-model browser cases passed with the final embedded client**: reading
  a native file and quoting its marker/source; and applying a real Editor change,
  saving `analysis.R`, executing it through the resident Application bridge and
  observing `[1] 42` in Console. Disk contents and original execution state were
  checked independently of the model's answer. Log:
  `target/component-browser-live-closed.log`. Screenshots:
  `target/studio-browser/component-real-model{,-execution}.png`.
  The earlier `component-browser-real-final` attempt is retained: its assertion
  incorrectly matched a tool receipt's completion before the whole run completed.
  The final checks target the run's own status.
- **19 embedded-client Chrome scenarios passed**: all nine existing external-Agent
  cases plus ten new component cases covering native source preview, streamed
  responses, retained drafts, takeover, 320/600/1024/1440/1920 layouts, synthetic
  connection/image diagnostics, stop/reconcile/Continue, rejected-scope correction,
  exact document grants, native Chinese IME, long-reply follow/reading behavior
  and comparative input/frame latency.
  Log: `target/component-browser-final.log`. The two opt-in real-model cases skipped
  in this default fixture run were executed separately above.
- On the final embedded client, Console typing p95 was **32.2 ms idle / 31.9 ms
  during an active model stream**; frame p95 was **16.7 / 16.8 ms** (75 key samples
  per phase). Observed JS heap was 22.0 / 19.7 MB; this is a short measurement,
  not a retained-memory/leak claim. The local protocol fixture uses the same Host
  and input script. Report:
  `target/component-browser-final/component-agents-typing-an-41baf--the-model-stream-is-active/performance.json`.
- **395 frontend tests**, 25 boundary fixtures, typecheck, generated contracts,
  embedded assets, current binary build, architecture/governance and vendor checks
  passed. Logs include `target/component-ui-unit-final.log`,
  `target/component-ui-scroll-host.log`, `target/component-ui-scroll-check.log`
  and `target/component-final-*`. A macOS dynamic-library validation wait delayed
  compilation; the scoped cache rebuild and final build completed without changing
  platform security settings or dependencies.
- The complete real-R suite passed in `target/component-complete-real-r-final.log`,
  including captured sources/mutations, protected recovery copies and persistent
  CLI state/cancellation/EOF. **MCP and Workbench real-R checks passed again** in
  `target/component-final-{mcp,workbench}-real-r.log`, including shared principal
  truth, pure queries, idempotency, cancellation/drain and native R/Environment reads.
- Existing focused evidence covers cancellation/late delivery, duplicate mutation
  identities, injected model failure after captured R failure, explicit Continue,
  separate parent/child states and exactly-once native effects. The interrupted
  repair regression passed all 15 native mutation cases in
  `target/component-interrupted-repair-regression.log`. Store/history/HTTP,
  protocol/tool limits and large result tests remain under `target/component-*`.
  The external Agent crash/resume fixture passed in
  `target/component-external-recovery-fixture.log`, preserving native identity,
  uncertain receipt, draft and a fresh MCP connection. This is a protocol fixture,
  not another live external-provider acceptance claim.

The additional full-workspace Rust rerun was stopped after 14 minutes of mostly
cold test-program startup, with no assertion failure observed before interruption.
Its partial log is `target/component-final-workspace.log`; it is **not** a full pass.
The earlier completed workspace baseline and subsequent affected-crate checks are
retained evidence. This Studio integration does not change production Rust behavior;
its changed real-model fixture deadlines were exercised by the final matrix.

Strict Clippy retains pre-existing large Contract enums, SQLite range style,
Workspace checkpoint style and Host style diagnostics. Selected checks passed with
only reproduced existing categories allowed, without source-wide suppressions.
The P0 isolated diagnostic measured 9,629,040 release bytes and 31 new normal package
versions; see `target/component-agent-build-evidence.json`. That measurement does
not establish the shipped application's release-size overhead.

All real checks use disposable projects. Existing user Hosts, R memory, drafts and
native configuration are preserved. No installation, signing or publication was
performed. See [Operations](OPERATIONS.md#built-in-component-assistant) for use.

## Multiple R sessions and recovery copies

The instance foundation, recovery copies, automatic protection and approved Studio
R04–R10 surfaces are implemented. [Design section 17](RHO-DESIGN.md#17-sessions-and-recovery--approved-interaction)
records the authorized interaction; [Architecture](ARCHITECTURE.md#multiple-r-instances-and-recovery-copies)
records ownership and safety boundaries. R01–R03 remain proposals.

R Sessions now has Overview, Runs, Recovery copies and Details, with Main first across
catalog pages, separate inspection and execution targets, scoped Console/Objects
navigation, view pinning, stopped-session continuation and installed-R session creation.
The management page preserves editor and Console drafts; narrow layouts provide
list/detail/Back navigation. Copy details read the immutable full manifest when the
catalog shortened its object-name previews. Counts use the owner's totals.

The recovery states explain opening, partial restoration, validation failure and
connection loss. Notices refer to the actual restore operation and source copy;
saving a partial copy does not imply anything was restored. Dismissals persist with
window preferences. A first-copy notice is shown once. Selecting an alternative
installed R/environment for a separate restoration still requires matching version,
architecture and native package validation.

Restart, Stop and Quit report consequences and operation results in one panel.
Restart creates empty memory in a new continuation lineage. A failed or partial
protection step leaves R open until remaining loss is explicitly accepted. Quit
synchronizes drafts, cancels waiting work, observes active cancellation, saves supported
objects, confirms local R termination and then requests Host shutdown. Closing a view
alone leaves R running. Host shutdown refuses live or unconfirmed process receipts and
fences later launches. Opening/restore cancellation forwards to the original child,
waits for the launch handshake and confirms candidate termination before reporting
cancellation. Ordinary in-flight reads drain behind a stop fence; consumer holds and
scientific operations remain blockers.

Runtime & recovery settings expose App → Project → Session inheritance per field,
Reset, object inclusion/exclusion, performance/storage controls and advanced limits.
Server defaults and project storage accounting are published by the settings owner;
the UI does not duplicate default constants. Recording default R does not replace any
live R binding. An empty Host can create a session explicitly from the new-session
entry after R is configured.

The factor-predictor model exclusion is fixed: R's base `deferred_string` ALTREP is
accepted after recursively classifying its storage. A test-only foreign provider
verifies unknown ALTREP roots and nested graphs remain excluded without invoking
length, data or serialization callbacks. Cold processes verify predictions for both
character/factor predictor lm/glm, alongside existing aliases/cycles, Unicode/hidden
values, factors/time, sparse/SCE values, RNG/options and unevaluated nested promises.

Environment retention now follows committed recovery manifests even when all R
sessions are stopped. The added real-R regression first reproduced the missing
reference, then passed after the fix; explicit deletion releases that old copy's
library reference. Incomplete bookkeeping blocks cleanup instead of discarding an
unknown dependency. Component delivery validates explicit R arguments and is exercised
in an isolated install layout with matching manifest paths and byte hashes.

### Current verification

- Full serial Rust workspace: **284 passed**, **10 opt-in cases ignored**, not counted
  as passes. An unchanged Agent protocol fixture timed out once during the first run;
  its focused rerun and the full serial rerun passed without changing Agent code.
- Frontend: **362 tests passed**; typecheck, generated DTOs/client build, architecture,
  frontend boundaries and all 24 boundary fixtures, vendor integrity and fixtures passed.
- Full Chrome suite: **46/46 passed**, including four new real scenarios: isolated multi-session recovery and empty
  restart; session creation and per-field settings reset; full coverage beyond a
  truncated catalog; and active/queued cancellation followed by save, Quit, Host reopen
  and automatic recovery. They acquire a component beside a temporary Ark and launch
  through normal discovery, with no explicit helper override. Editor/Console drafts
  and keyboard target selection are checked. Screenshots cover 600/1024/1440/1920 px.
  The fixed load case measured input p95 **34 ms** and frame p95 **16.7 ms**.
- `scripts/test-r-checkpoints.mjs` passed, including foreign-provider exclusions,
  numeric/factor models and isolated component delivery. The recovery-library test
  passed both retained-reference and deletion assertions. The real-R, Environment,
  MCP, Workbench, output-media, process/remote protocol, Agent recovery/harness and
  evidence-pack checks also passed.

The final review corrected two concurrent-update cases: Quit flushes document and
view-state owners in acknowledgement order before checking synchronization; whole-vector
copy waits through transient busy periods on its original reference. Recovery capture,
pinning and deletion do not invalidate object/package observations. Actual scientific
execution still invalidates them. HTTP size checks retain the 413 assertion using
100-continue, MCP media checks explicitly await completion, and the IME fixture uses a
separate deliberate key gesture instead of depending on frame timing.

Evidence for this continuation is in `target/runtime-final-*.log` and the check
manifest `target/runtime-final-checks.json`; screenshots are
`target/studio-browser/runtime-*.png`. Functional evidence does not replace further
user feedback on the interaction.

### Remaining release boundaries

- The native component is still an explicit per-machine acquisition and has not been
  added to a signed packaging or first-run installer. Opening R or browsing copies
  never invokes a compiler or installs packages.
- Two genuinely different R installations require `RHO_ALT_*` and remain opt-in.
  Cross-platform, long-run/destructive-failure and added-wait latency acceptance have
  not been established by these local tests. No release-wide performance claim is made.
- Environment receipts have no user-facing display name, so the interface uses a
  generic description and keeps the exact receipt/path in Details.
- Raw Ctrl-C/server termination ends owned R processes without guaranteeing a fresh
  object copy. The explicit Quit panel is the protected shutdown path.
- Connected CLI and Agent requests require `workspace_instance_id`; no implicit
  target is guessed. A new real-model Agent acceptance run is separate from the
  deterministic protocol/bridge checks.

### Restart paths

The primary repository checkout on `main` is now the only local worktree. It includes
all session/recovery work through `0d3112e3`. Current verification logs and screenshots
were retained under `target/` when the auxiliary worktrees were removed. The primary
checkout passed `cargo build --locked`, generated-client consistency, CLI startup,
documentation checks and backup verification after consolidation.

Original branch refs and history are preserved in
`.git/cleanup-backups/20260912T130405Z/branches.bundle`; the same private directory
contains the retired kernel checkout's local state/artifacts and the cleanup inventory.
These are manual administrative backups, not supported inputs for the current runtime.
Routine development continues in this checkout; temporary worktrees should be removed
once their work has been integrated.

Inspect current processes before a real launch or replacement. Existing user Hosts
and R memory were not restarted during consolidation. New browser and native tests
use disposable projects. No application installation, signing or publication was performed.

## Shell navigation and configurable status bar

The user approved [Paper Shell S01–S04](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/8-0)
and requested optional persistent CPU, memory and disk values. The implemented
48/168 px navigation rail focuses/restores existing modules, offers multiple-view
selection and retains Agent attention/settings entry points. Layout is available
from the top bar. A 30 px footer separates R/queue/input state, user-pinned metrics
and draft synchronization. Narrow windows retain all pinned metrics, using a
second row below 700 px. Project paths live in the top project disclosure.

The shared Project query observes volume total/free/available space with `fs4` at
the canonical project path. It does not scan files, enumerate other disks or start
R. CPU/memory retain their actual Ark/R-process scope. Files and Session retain
observation/error/freshness independently; missing or stale values stay unknown.
Preferences merge against current shared settings. Draft sync now also checks the
ApplicationBridge document acknowledgements, independently of disk-file saving.

Validation passed: 327 frontend tests; all 15 Host project tests; 18 tests across
Contract, Project and Git; generated client/asset consistency, typecheck, Rust
formatting, architecture/frontend boundaries and fixtures, and documentation checks.
All 40 existing Chrome scenarios passed in the full run; both new shell scenarios
passed in a separate final run after correcting their temporary project's canonical
path. These 42 cases cover keyboard controls, retained preferences/drafts, native
input, disconnected metrics and 1920/1440/1024/800/600 px screenshots. Real-R HTTP
and MCP checks passed. The broad Rust workspace suite was not rerun.

A viewport test now awaits ResizeObserver geometry without weakening its bounds.
The new shell cases use a separate temporary Host instead of exceeding the main
suite's 32-window project budget. Native Host rejections that omit `result` retain
their actual error message rather than being obscured as an invalid reply. The
native disk test finishes in 0.10s after replacing slow whole-machine sampling
with the direct filesystem call. Evidence: `target/shell-{frontend-final,rust-domain,
project-tests,browser-verified,browser-isolated-final,workbench-real-r,mcp-real-r}.log`
and `target/studio-browser/shell-*.png`.

A separate preview at `target/experience/shell-review-5dR1zl/study` contains the
synthetic `workspace-demo.R`, its live objects and plot. It uses refreshable assets;
its browser is retained for user review with all three metrics pinned. Existing
Hosts and R sessions were preserved. Inspect current processes before launching
another Host. Native launch credentials remain in ignored local material.
Further first-version visual/usability feedback remains open.

## Object priority and whole-vector viewing

The user approved [Paper boards O07–O10](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/7-0)
on 2026-09-09 and authorized further refinements from real scenarios. The directory
now defaults to Name, Content and Type. Content shows values, dimensions, function
signatures, levels or colors. Fields controls and header dragging reorder, hide
and resize Content/Size/Type; Name stays first. Widths and visibility persist with
the view. Narrow panels retain compact semantic summaries and return to the saved
columns when widened.

Complete small palettes open as one strip or tile set in inline and dedicated
viewers. Selecting a color shows its original value, rendered hex and opacity.
Ordinary string vectors do not automatically open one string's detail. Long vectors
use ranges, explicit item inspection and a scrolling body with visible navigation.
Copy vector preserves original strings, names, NA, supported classes and complete
factor levels; explicit formats offer hex or selected/shown ranges. The shared
Objects owner gathers every requested page and text continuation on one native
observation before writing to the clipboard. Expiry, cancellation, missing pages,
unsupported exact representations and the 1 MiB / 100,000-value limits fail without
publishing a partial copy. A view opened during transient R activity resumes the
same observation when idle; it does not start or re-run R work.

Validation passed: 320 frontend tests, all 40 isolated Chrome scenarios, plus a
final two-scenario Chrome run after narrow-view refinements. Tests cover mouse/keyboard
field controls, saved order/width, approximately 320 px docked views with measured
visible color height, whole palettes,
Unicode continuations, duplicate names, factor levels, missing values and rejected
partial copies. A 252-value copied expression passes `identical()` in real R. Hex
conversion fails on a non-color value beyond the first page without changing the
clipboard. Table ordering/filtering, arrays and SCE browsing still pass. Real-R MCP
and Workbench checks, typecheck, generated-client consistency, architecture/frontend
boundaries and documentation checks also passed. The broad Rust workspace suite
was not rerun for this frontend change. Evidence is in `target/object-refinement-*.log`
and `target/studio-browser/object-{fields,palette}-*.png`.

The existing demo Host has been refreshed with new development assets; its live
objects, plots and unsaved script are preserved. No R Host was restarted to deliver
this refinement. Both inline and independent vector views use the same owner.
Further user feedback on information priority and real vector workflows remains open.

## Object viewers and directional collapse

The user authorized implementation of the six [Objects Paper boards](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/7-0)
on 2026-09-09, plus correction of full-column minimize behavior.
[Design section 14](RHO-DESIGN.md#14-objects--approved-viewing-experience) records the
approved interaction and named storage readers. Object lists now display bounded
native samples, values, dimensions, string lengths and canonical R colors.
Inline inspection and main-area viewers share the Objects owner, including
retained view preferences, nested containers, factor labels/codes, source text,
array slices and SCE/sparse storage. React Data Grid supplies the actual table
surface. Whole-table order/filter reads retain original row indices; oversized
copies, unsupported calendar filters and the one-million-row processing ceiling
are explicit limits. Current Host metadata controls extended table features.

Groups collapse along their parent split: full columns release width into a
38 px side rail; stacked panels release height. Original limits/weights restore,
and startup view reconciliation preserves collapsed state. Explicit activation
still restores the group. The user's existing development Host and R memory are
preserved; a frontend refresh cannot install the new native reader capabilities.
A reproducible synthetic review script is in
`target/experience/object-viewers-ready/study/objects-demo.R`.

Validation passed: 309 frontend tests, all 39 isolated Chrome scenarios, four
contract tests, all five real-R integration cases and the real CLI/session runner.
The native object script verifies full-table ordering/filtering, Unicode/special
values, array slices, non-executed source, R color interpretation and real SCE
counts/colData/PCA storage. Real-R MCP and Workbench checks passed, as did generated
bindings/client consistency, typecheck, architecture/frontend boundaries, Rust
formatting and governance checks. A broad Rust workspace run was interrupted;
it is not recorded as a complete pass. Current evidence logs are
`target/object-viewer-{browser-verified,frontend-final,contract-tests,real-r-suite,mcp-tests,workbench-tests}.log`.

The review Host is running for
`target/experience/object-viewers-ready/study`, using refreshable development
assets. Its retained browser has executed `objects-demo.R`; the 2,700-row table,
canonical colors, SCE and plot objects are real synthetic R fixtures. Inspect this
Host before starting another instance for that project. Its private launch URL
remains in ignored local material. Existing user Hosts were not restarted.
Screenshots are under `target/studio-browser/`; successful inspection does not
replace further user feedback on interaction quality.

## Agent Chinese input composition

The reported Pinyin-to-literal-text bug was reproduced through Chrome's native
composition protocol: `ni → nihao` produced `ninihao`, with JavaScript value writes
back to the previous text between input events. This occurs before draft autosave;
the controlled textarea was backed directly by asynchronously notified task state.
The message input now leaves native preedit in the DOM, reconciles external text
only outside composition, and sends confirmed text to the draft owner. Resizing
and @ completion also wait for committed input. IME confirmation/229/post-end keys
cannot submit, and an ownership change retains a local conflict copy.

Focused tests passed: native Chrome composition across autosave/poll intervals,
delayed draft ACK during composition, committed-only saving and explicit subsequent
Enter. These are browser-native CDP tests. The user separately tested the corrected
ime-test page with their actual input method and confirmed it works on 2026-09-09.
This confirms that configuration, not every possible OS/IME combination. Validation
passed: 300 frontend tests, all 36 isolated Chrome scenarios, frontend boundary
checks/fixtures, typecheck, client build/generated-asset consistency, current binary
build and governance checks. The regression also preserves the original attachments
when composition finishes after another window takes control. The task selector
now has a distinct accessible label from the New task action. Evidence is in
`target/agent-task-development/ime-{unit,chrome-final}.log`. The user's existing
trial Host/page is preserved. A separate `target/experience/agent-ime-review/ime-test`
workspace uses refreshable development assets for testing the corrected client.

## Agent activity and real-analysis integration

The user's ggtree trial exposed failures beyond panel presentation. The recorded
connection took about two seconds; native thinking then continued without a visible
phase. Rho's fixed 600-second ACP prompt deadline stopped observing a native turn
that completed after about 729 seconds. The final response was lost. An invalid
`output_mode: all` was obscured by an incompatible MCP structured-error envelope.
A subsequent corrected R submission waited behind a failed-run pause and hit the
native MCP request timeout. The original successful R operation saved a PNG but
did not emit a Plots artifact; the native final message incorrectly claimed it did.

Implemented: bounded native phase observations and an animated conversation status,
including quiet time, driven by existing Coordinator observations; ACP prompt
correlation until native completion/transport closure; readable MCP rejections;
typed R output modes; default R acceptance receipts with queue-state read links;
live Studio context and document/media guidance in native input. Structured
window/document/action/media identities are expanded in the tool schema after a
real GLM run repeatedly encoded reference-only parameters as strings. Native
permission callback content/diffs are retained, not just the tool title.

Real Kimi/GLM analysis also reproduced a captured-save bug: a partial Rust-generated
patch encoded unchanged context as removed/added lines and Git rejected it despite
the correct file digest. Captured saves now emit real unified-diff context. The
regression applies start/interior/deletion/unchanged/Unicode/CRLF/no-final-newline
edits through Git and checks exact bytes. The external Agent remains responsible
for its R code; failed scientific operations retain their actual outcomes.

Verified with Kimi Code 0.41.0 and `b-ai/glm-5.3-flash`: the same native session
resumed after upgrading the disposable Host, retained the corrected Editor draft,
saved and ran it successfully, read the real image through MCP, explicitly selected
it in Plots and returned a final response with a succeeded submission receipt.
The 800×600 PNG is retained by its producing R operation; the original failed runs
and intentionally interrupted turn retain their actual statuses. Refresh preserved
the saved script, selected image and conversation. Native image inspection rejected
an incomplete reference; the Agent corrected it using the full owner reference.
This validates recovery and completion, not error-free model-generated R code.

Checks passed: 250 Rust workspace tests (seven opt-in cases skipped), all five
real-R cases plus the real CLI/session runner, 303 frontend tests, 37 isolated Chrome
scenarios, real-R MCP acceptance/paused-queue recovery, native task crash/resume
fixtures, generated bindings/client checks, architecture/frontend boundaries,
governance and vendor integrity. All nine focused Chrome cases passed after the
permission-detail disclosure and selected-plot unread-count fixes; 29 native-client
tests passed after the final permission-excerpt redaction review. Evidence logs
and the verified preview `ggtree-final.png` are in `target/agent-task-development/`.
The configured Kimi global Rho MCP entry remains disabled; existing user Hosts were
preserved. Only owned disposable Hosts were restarted. Actual provider thinking
latency remains variable; it is now visible rather than converted into a false
terminal timeout.

## Parent-region docking refinement

The 2026-09-09 follow-up identified an unreachable/unclear parent docking path:
Agent could land beside Plots, while the requested destination was the common
right of Objects and Plots. The floating parent matrix was below the native
transparent drag overlay and included the source in region names. The new client
places reachable arrow targets at shared panel boundaries, highlights the whole
destination and previews the final occupied area. Native single-panel and workspace
edge drops remain available, with Move To for explicit placement. Target names omit
the dragged source; the engine can redistribute space released by that source.

The user's live trial window was moved through the existing placement command to
Agent beside the complete Objects/Plots column. No Host, Agent task or R session was
restarted. The running Host retains its embedded client; the improved drag targets
are in the rebuilt client for subsequent launches. Validation passed: 296 frontend
tests (including the parent/source-extraction regression), all 34 isolated Chrome
scenarios, frontend boundary checks/fixtures, typecheck, generated client consistency,
current binary build and governance checks. The real mouse-drag case verifies exact
preview/drop geometry, draft preservation, no Agent commands, undo and Escape.
Screenshots are `target/studio-browser/agent-parent-drag-{preview,result}.png`; the
full Chrome log is `target/agent-task-development/parent-docking-chrome.log`.

## Workspace Agent tasks

The user approved the fourteen [Paper Agent boards](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/6-2)
and authorized the complete first-version implementation, using Kimi Code with
`b-ai/glm-5.3-flash` (GLM 5.3 Flash, B.AI) for real development tests.
The independent Agent page retains those boards; the general workspace page was
not repurposed. [Design section 13](RHO-DESIGN.md#13-workspace-agent-tasks--approved-interaction)
records the approved interaction and native-capability distinctions.

The singleton dockable Agent panel now owns daily task chat, a wide task rail or
narrow selector, per-task saved drafts/conflict copies, rename/archive, native
permissions beside the composer, attachments and @ context previews. Settings
retains discovery, explicit installation, models, manual MCP and independent Test.
No CLI is scanned or model request sent merely by opening the panel. Window-local
selection/reading state stays in ApplicationPersistence; R-session changes do not
remove Agent tasks. Files/editor/R tables/plots use their existing read owners;
plugins have a read-only information-source registration seam, not an installed
illustrative analysis plugin.

ApplicationStore has additive typed task/attachment/draft/receipt/event/asset tables.
The Host task service owns admission and native lifetime, request deduplication,
draft CAS, controller/generation fencing, eight-connection budgets and bounded
observations. Receipts and terminal states persist immediately; durable cursors
are distinct from in-flight native observations. A stopped/uncertain connection
cannot bypass old-process proof through Disconnect or Resume. Native CLI history
is never reconstructed from Rho's display cache or used to replay scientific work.
Codex uses exact thread resume and native pages; Kimi uses verified exact-ID load
and context replay; DeepSeek uses resume/close/resume after interruption to clear
its native Inbox. User configuration and the disabled global Kimi rho MCP entry
remain unchanged; each task receives a fresh explicit MCP connection.

Executed evidence in `target/agent-task-development/`:

- `kimi-task-acceptance.log`: real Kimi 0.41.0 / B.AI GLM 5.3 Flash; two same-model
  tasks return separate alpha/beta responses, duplicate request IDs do not replay,
  both resume the same native ID, and the resumed Agent performs a new MCP overview
  read of the correct disposable project. Original configuration hashes unchanged.
- `kimi-recovery.log`, `codex-recovery.log`, `deepseek-recovery.log`: each real
  runtime survives a forced, independent Host crash through explicit same-ID Resume.
  The saved next draft and old uncertain receipt remain. Kimi/Codex identify a new
  red-square image; DeepSeek accepts only the new instruction. All three actually
  perform an MCP overview read through the new Host endpoint/credentials afterward.
- `codex-task-acceptance.log`: real Codex / gpt-6-astra; two concurrent tasks,
  exact separate responses, request deduplication and same-ID resume passed.
- `deepseek-task-acceptance.log`: real DeepSeek / 115-newapi deepseek-v4-flash;
  two same-model tasks, duplicate-request protection, same-ID resume and resumed
  native MCP overview passed. Native configuration hashes remained unchanged.
- `deepseek-native-inbox.log`: the installed lock-matched native Inbox implementation
  restores input queued before a crash, persists its removal on clear, and claims
  only a fresh instruction after another reconstruction. No model or user session
  is used by this deterministic native-code test.
- `fixture-recovery.log`: deterministic ACP crash/restart verifies no prompt during
  resume, changed Host MCP address/credential fingerprint, original uncertainty and
  image delivery. Native protocol tests cover Codex quiet/history/cursor rules,
  Kimi replay/session fencing and DeepSeek queued-Inbox cleanup/failed-close refusal.
- `chrome-final.log`: the full isolated Chrome suite passed **33/33**, including
  normal/narrow/wide Agent layouts, native permission modes/options, archived-task
  reminders while closed, two-window takeover, attachments, real R tables/plots,
  independent diagnostics and existing editor/layout/scroll/execution regressions.
- `frontend-tests.log`: **295 frontend tests** passed. Source ownership boundaries,
  generated bindings/embedded assets, typecheck and strict workspace Clippy passed.
- `task-service-final.log`: **10 focused Host task tests** passed, including plugin
  source containment, stale ownership, stop/closing races and uncertain resume.
- `workspace-tests.log`: **244 full-workspace Rust tests** passed; **7 conditional
  external tests** were ignored, not counted as passes. The final native-client
  run passed **25 tests**, including unconfirmed native submission errors.
- Real R, MCP and Workbench checks passed, including MCP/Workbench with real R.
  Environment, native-process recovery, local SSH/Slurm protocol, output-media,
  vendor integrity, governance and Agent-harness self-tests passed. These local
  protocol/self-tests do not claim remote-cluster or new scientific acceptance.

Live integration caught DeepSeek's lack of embedded-resource capability; text
context now uses native text input with its source retained. Chrome review corrected
file-kind filtering, the plot query name, constrained-picker clipping and a test's
window-list pagination. Native progress commentary remains separate from the final
answer; acceptance assertions now inspect the final native message.

Existing user Hosts and their R memory were not restarted. All new test Hosts use
disposable projects. The older native integration remains the basis for explicit
DeepSeek component setup (official 0.1.2-alpha.2) and manual MCP settings. Kimi's
global rho MCP entry stays disabled; task-specific injection has independently
passed real MCP reads. Build/runtime installation/publication remain separate;
this work does not install or replace a user Host automatically. An independent
trial project is available at `target/experience/agent-tasks-ready/study`, with a
blank Kimi task set to GLM 5.3 Flash (B.AI). It was opened in the app browser without
sending a model prompt. Its launch material stays in ignored local files; inspect
that project's live Host before starting another instance.

## Agent interface acceptance baseline

The Agent interface and standard Skills delivery is implemented and verified.
The frozen runtime/harness acceptance version is
`4bcd30903b55568844b20fb93589294b1a8c5f9d`. Evidence-packaging changes through
`a3f08a6` did not change that verified scientific runtime, client assets or
acceptance harness. The connection work above extends the current transport;
the frozen acceptance remains evidence for its recorded baseline only.

Shared Host discovery, concrete capability/result/recovery contracts, diagnostics
and read navigation cover the existing scientific owners. Objects and text use
bounded version-bound reads; package indexes bind exact installed copies; help
renders once from the selected database into retained text. Output reads share
verified originals, bounded native image previews, crops and resource chunks.

Application owns window identities, synchronized drafts/context, CAS receipts and
immutable scientific captures. The resident Studio bridge preserves concurrent
input and startup view choices. Saving/running retains the original caller through
the existing OperationGateway. Standalone CLI queries do not start R, acquire a
writer lease or recover operations; connected CLI requests use the existing Host.

Standard `.agents/skills` and launcher-attested native sources retain their original
resource bytes, enablement and source identities. Read receipts and explicit method
bindings are application metadata. Skills do not grant authority or run an Agent
loop. Native queries do not reload deliberately unloaded inspection/JSON providers.

## Verified evidence

- Rust workspace: 199 default tests passed. All seven separately enabled real-R
  and Environment tests passed through the native verification scripts; none was
  counted as passed while ignored. Strict whole-workspace Clippy passed.
- Frontend: 270 tests and 24 ownership/boundary fixtures passed. Generated DTOs,
  embedded assets and the current binary were checked together.
- Chrome: all 26 cases passed. Normal, wide and constrained screenshots were
  inspected. The fixed Gapminder load case measured typing p95 34.4 ms and frame
  p95 16.8 ms; additional views did not duplicate shared reads.
- Real Workbench/MCP, exact help, native image/resources, pak/renv realization,
  installer cancellation, retention/quarantine/restore/purge, lost-commit recovery,
  restart binding, CLI connection/query purity, process recovery, local SSH/Slurm
  protocol fixtures, architecture/governance and Jet checks passed. The original
  user R library was unchanged. No live remote-cluster acceptance is claimed.
- Independent Codex: **30/30 core runs and 4/4 Skills/adaptation runs passed**, with
  zero violations/failures, exact native/Rho method equivalence, and unchanged
  source/binary hashes. Model `gpt-6-astra`, reasoning `high`, Codex 0.153.4.
  Each run stayed within 80 calls, 1 MiB text and ten minutes. Maximum observed:
  30 calls, 524,698 text bytes and 197,407 ms. Images were metered separately.

The formal run retained 614 hashed artifacts (58,627,766 bytes) and took 16m55s
with three independent workers. Totals: 382 model tool attempts, 380 matched MCP
deliveries, 4,060,795 text bytes and 136,584 image bytes. Actual usage fields:
10,820,205 input tokens; 9,443,328 cached input; 46,945 output; 1,822 reasoning output.

The authoritative formal result is
`target/agent-interface/acceptance/4bcd30903b55-1788916155502-8ec26ea9/manifest.json`.
It records `acceptance=true`, `passed=true`, `fixed_tree=true`, all 34 results,
resource equivalence, original operation identities and the artifact inventory.
All earlier failed attempts remain under `target/agent-interface/acceptance`.
Command logs are under `target/agent-interface`; visual reviews are under
`target/studio-browser`. The evidence packer preserves originals, includes failed
attempts, sanitizes credentials in text/nested traces and records source/archive
hashes. Its tests and CI mapping are separate from scientific acceptance.

Frozen acceptance binary SHA256:
`c1b0157931004efa6af2fd76f8b9c6eab2f58bb08211877d8ce67a074f2dad91`.

## Operational boundaries

Existing user Hosts, R memory and configuration were preserved. All acceptance
instances were disposable. No product installation, signing or publication was
performed. Read [Operations](OPERATIONS.md) before starting another Host; inspect
current ownership and processes rather than reusing old PIDs, ports or tokens.
All Cargo invocations remain serial; build and verify from the integration checkout.

Native session evidence covers the managed fork/exec helper family. Unobservable
same-family processes and missing original evidence stay protected; independent
service-manager jobs and rollback of arbitrary external effects are not implied.

The approved Packages interaction remains in
[Paper](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0).
Cross-version import, plugin execution, package-management UI,
abandoned-data migration, product installation and publication remain deferred.
The external acceptance runner is test tooling, not a product Agent behavior loop.
