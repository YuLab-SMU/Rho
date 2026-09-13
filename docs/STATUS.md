# Rho: current state and focus

Updated: 2026-09-13. This is the single current status summary. Git retains history.

## Built-in component Agent implementation

The [implementation plan](BUILTIN-AGENT-PLAN.md) is authorized. P0, the P1 backend,
P2 source/context access, P3 document/R execution and the P4 reconciliation, takeover and
explicit Continue backend are implemented.
The optional `rho-agents` crate uses pinned Rig 0.42 through Application ports;
Host composes it with the existing scientific owners. No replacement scientific
gateway or external Agent-provider variant was introduced.

The new Studio interface remains unimplemented pending user review of
[Paper B01–B06](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/A-0).
[Design section 18](RHO-DESIGN.md)
records the proposal: separate assistant navigation, component sources, settings,
execution evidence and constrained layouts. All six boards were inspected; the
original fourteen Agent boards were preserved. Functional backend tests do not
approve this interaction or establish its visual quality.

A nonvisual TypeScript client now handles immutable snapshots, bounded history and
event caches, CAS draft conflicts, persisted submission identities, read-only
acknowledgement recovery, project/window response fences and explicit Stop,
Reconcile and takeover commands. HostClient exposes the existing authenticated
component endpoints; read timeouts do not cancel or replay commands. This model is
connected to Studio's project-switch and stop lifecycle, with a separate local
window/project cache. No component views or polling are mounted. Submission
preflight is serialized per conversation; explicit retries preserve the complete
original request, and unique observation tokens fence responses after cache eviction.
Startup recovery tests verify zero component queries, commands or model tests.

### Current backend behavior

- Application owns conversations, independent CAS drafts/controllers, fixed run
  inputs and model references, durable tool identities, results and bounded events.
  Stable request/call identities survive retries; late results retain their original
  window, principal and scientific owner. Event pruning preserves tool receipts.
- Conversation history is now an indexed, project/principal-scoped Application
  query, ordered by creation time and run ID. Pages contain at most 32 summaries;
  full context and receipts remain on their existing reads. Foreign-conversation
  cursors are rejected, tied timestamps paginate deterministically, and missing
  live tasks are observed as Interrupted without rewriting the stored run.
- Project persistence now accounts all component payload tables under the 64 MiB
  budget, including reserved completion capacity. Transactional byte entries are
  derived from UTF-8 serialized values. New obligations fail before dispatch when
  full; active/unconfirmed receipts can finish within reserved space. Only events
  are pruned. Existing oversized data remains readable and non-growing completion
  or disable operations remain possible; request/tool identities are never evicted.
- Source search and preview read existing owners without model calls. Submission
  revalidates file/document/object/package identities before capture. Verified
  selected PNG/JPEG images are transient model input with native references and
  digests; their bytes are not persisted in conversation text.
- Objects, Packages, Plots and Environment are Explain-only. Native
  `workspace.read_help` reads the exact observed installed copy without loading,
  attaching or installing packages. Workspace/Project Run uses the original R
  instance/session and the shared Operation path.
- Document tools bind authorized IDs, confirmed versions and destinations. The
  existing resident bridge applies edits and acknowledges captured save/run steps.
  Saving may advance a document version without changing its text; predecessor
  receipts preserve mutation identity across that transition. A repaired draft has
  a new execution identity, while concurrent user input never expands the grant.
  Edit/save acknowledgements also return immutable document summaries with the
  exact draft SHA-256. Follow-up reads can use that checksum without confusing
  the document version or saved base hash with the current draft checksum.
- Literal document repairs now have an exact unique-text replacement tool. The
  Application owner computes editor UTF-16 ranges, retaining BOM/line-ending
  behavior and rejecting missing, overlapping/ambiguous, read-only or stale matches.
  Tool name/argument hashes preserve repeated replacement identity without storing
  raw model argument copies. Numeric edits remain available for advanced changes.
- A failed R run pauses its native queue. Resume is an explicit tool choice tied to
  this run's confirmed failed operation and observed pause. Workspace atomically
  rejects manual/other-operation pauses or current, pending and reserved work
  outside the injected operation set, including principal-hidden work.
  A component run now checks the original session's queue before admitting new R
  execution. A known pause returns non-executable feedback; duplicate actions still
  resolve to their original receipts. This check never resumes the queue and does
  not replace the native checks if state changes after the observation.
- Stop fences new calls and unsubmitted application steps. Native tracking outlives
  dropped model waits, reconciles original SCI records and cancels only associated
  work. Cancelled local commands do not imply rollback; scientific failure,
  uncertainty and successful saving remain separately visible in receipts.
- Run/request observations serialize with admission and finalization, and report
  Interrupted when the current Host has no owning task. Explicit Reconcile reads
  original caller/request identities, recording versioned native status and document
  references without model calls, replay, cancellation or queue resume. Missing
  acknowledged records and unconfirmed saves/runs remain uncertain. Original tool
  receipts remain intact; repeated unchanged recovery observations are idempotent.
- Explicit conversation takeover checks the observed version and refuses live
  tasks. Orphan interruption and controller replacement commit atomically, preserving
  the user draft and original run/window identities. Old-window draft writes, Stop
  and late model text remain fenced; late native facts can still be retained.
- Explicit Continue binds a terminal parent and current recovery digest. Host
  rechecks native records and targets; Application prevents authorization expansion,
  changed document/session targets and further writes with unresolved mutations.
  Confirmed ancestor actions read their original results instead of executing again.
  History preserves user requests, labels partial text/results and shares the 64 KiB
  context limit. A fresh Start remains a new explicit action that can repeat work.
- Known-tool argument format failures are durable non-executable records. Rig's
  Skip hook returns bounded schema feedback without calling the tool body. These
  attempts consume budgets; hidden-target overrides, unknown tools, storage
  failures and exhausted budgets stop the run.
- Remote model settings use HTTPS, or explicitly configured loopback HTTP. Keys
  remain environment/session references; raw session keys stay in Host memory.
  Clients are lazy, shared and do not automatically follow redirects or retry.
  Explicit synthetic connection/image diagnostics have durable identities and
  share model slots. Image input requires a matching passed image diagnostic.
- Browser-only component routes retain existing authentication, project/window
  checks and native CLI separation. Native stdin and private reasoning are not
  sent into assistant history. Model failures expose typed categories or numeric
  HTTP status, excluding provider bodies and raw error histories.

### Evidence and limits

The real Ark/R tests verify direct execution once, confirmed cancellation,
edit → save → Run File, and failure → edit → scoped resume → successful rerun.
The repair test also repeats failed-run, edit and resume calls under new provider
IDs and verifies that original native identities are retained. Both failed and
successful SCI records survive, the saved text matches, and R increments once.

The authorized `115-newapi` / `deepseek-v4.1-flash` service completed the repair
workflow with 10 model calls and 9 tool calls in 66,848 ms. It retained one failed
and one successful R execution, one edit and four mutation receipts. The Run
model-call default was re-estimated from 8 to 12 after earlier attempts exhausted
8 calls before rerunning the repaired draft; tool, byte and duration limits remain
unchanged. Another attempt was rejected for invalid parameter shape before native
dispatch; bounded format-correction behavior now has a real Rig/HTTP regression.
These are individual acceptance runs, not throughput guarantees.

Current evidence:

- Full workspace regression passed **350 tests**, with **31 external checks ignored**;
  doc tests and the main build passed. Focused validation passed 32 Application,
  28 SQLite, 14 real-R and 365 UI tests, plus contract generation/client build/check.
  Logs: `target/component-precondition-{workspace,application,store,native,ui,client,build}.log`.
- Twelve Chrome regressions passed: three document/save/conflict/multiwindow cases
  and nine external-Agent cases covering previews, takeover, docking and native IME.
  Logs: `target/component-precondition-browser.log`, `target/component-parity-agent-browser.log`.
  The latter uses a local CLI fixture; neither verifies a live CLI provider account
  or the still-unimplemented component-assistant interface.
- Cross-edge fact parity passed with real R and a local HTTP model fixture driving
  Rig. Component tools, direct Host reads and both MCP operation-read names over
  rmcp's framed duplex transport retain identical native records and observations,
  excluding only observation time. Exactly one assistant execution is added; reads
  add no scientific events. `scripts/test-real-r.mjs` includes the check.
  Log: `target/component-parity-rig-final.log`.
- Native/store coverage includes captured edit/save/run, failed-run repair, scoped
  Resume, original-operation input ownership, cross-session Stop, missing result
  acknowledgements, Continue without replay, explicit fresh requests, retained plot
  identity, and SQLite aborts before intent/result/final acknowledgement. Quota tests
  cover admission rollback, Unicode bytes, active completion reservations, event
  pruning, reopen and an existing oversized store. Source/help checks retain exact
  installed-copy and object observations without additional scientific operations.
  Earlier detailed evidence remains in `target/component-{input,payload,continue,recovery,read-help}-*.log`
  and `target/component-fault-injection.log`.
- Saturation tests verified two running/eight waiting model slots, Disable fencing
  queued requests, and project reads/queued Stop within the tested 250 ms backend
  bound. This is not the pending UI performance comparison. Log:
  `target/component-saturation.log`. Startup sampling of the full test run found a
  test executable waiting at `_dyld_start`, before test code; this is an environment
  observation, not an assistant UI measurement.

**Complete real-model acceptance has not passed.** All attempts remain under
`target/component-matrix/`; each directory contains the fixed source digest,
model configuration, all case logs and `summary.json`:

| Complete matrix directory | Passed | Failure evidence |
| --- | --- | --- |
| `2026-09-13T04-54-46.711Z` | 26/27 | Overstrict Markdown color parsing |
| `2026-09-13T05-10-46.226Z` | 26/27 | Checksum confusion and model-call budget exhaustion |
| `2026-09-13T05-35-26.516Z` | 23/27 | Invisible-return fixture and runs submitted before Resume |
| `2026-09-13T07-20-03.997Z` | 25/27 | Plots answer/count mismatch; provider/stream error during produced-plot repair |
| `2026-09-13T08-27-28.616Z` | 26/27 | Workspace checker combined pre-tool narration with the final answer |
| `2026-09-13T09-29-10.428Z` | 26/27 | Correct plot color with source citation rejected by one-word-only checker |

The fourth matrix used code commit `285ca1c3`. Six profiles passed three times,
Plots passed twice, and document repair passed three times. The interrupted repair
retained its original saved R failure and two reads, before submitting an edit.
A live update initially missed the other Plots failure; the complete summary is
authoritative. Progress output now includes cumulative failures.

Source probes now record expected/actual answers and operation counts and retain
failed temporary projects. Targeted Plots repeats at
`2026-09-13T07-40-27.070Z` passed 2/3. One model response claimed no image was delivered
after a successful synthetic diagnostic; operation counts stayed unchanged. Its
retained original PNG was visually verified as solid green (800×600). The failed
case log locates the retained fixture. The source-probe build, selected Clippy with
existing style exceptions and matrix self-test passed in
`target/component-source-evidence-{build,clippy-final}.log`.

Image delivery diagnostics now use `scripts/test-component-image-wire.mjs --run`.
The local relay forwards the original request/response and records only image
manifests, hashes, dimensions, content-block order and HTTP status, excluding keys,
headers and prompt bodies. Six text-first probes passed with one 640×480 PNG per
source request, matching its declared native preview hash, and HTTP 200 responses.
Evidence: `target/component-image-wire/{2026-09-13T07-50-20.678Z,2026-09-13T07-52-06.350Z}/`.
These successful captures do not prove the cause of the earlier refusal.

Labelled images now precede the long question/context, following the official
Anthropic vision placement recommendation. Diagnostics use the same image-first
order. The new Anthropic two-image wire test preserves bytes, labels and the final
question; 11 protocol tests plus the typed-error test passed. Three image-first
relay probes and three direct Plots probes passed. Evidence:
`target/component-image-wire/2026-09-13T08-01-32.906Z/`,
`target/component-matrix/2026-09-13T08-06-16.563Z/`, and
`target/component-image-order-protocol-final.log`.
These are subsets, not a new complete matrix, and do not establish causality or
provider reliability. The fifth matrix on `c9ed28b0` finished with 26/27 automatically
passed. Its retained Workspace record verifies one native execution and the correct
return value; the post-tool answer is exactly that value. The checker had included
earlier progress narration. It now distinguishes the final answer after the last
tool event, with a regression test, and logs expected/actual final text. The original
summary remains unchanged and a fresh complete matrix is still pending. An additional
real-R test now injects model failure immediately after the original captured R
failure, explicitly reconciles and Continues, re-reads the parent failure without
replay, repairs, resumes and finishes. Parent and child retain separate terminal
states and original native identities; the counter increments once. All 15 native
mutation tests pass in `target/component-interrupted-repair-regression.log`.
This is an injected engine failure, not another live-provider availability measurement.

The sixth matrix (`2026-09-13T09-29-10.428Z`) also finished at 26/27: the failed
produced-plot case identified green and cited the original output, but the checker
required a lone word while the assistant instructions require citations. The probe
now requests a first-line color plus the original operation/output reference and
checks both, retaining ambiguity/negative-answer rejection and all native checks.
A targeted repeat at `2026-09-13T10-02-28.955Z` passed 2/3; its remaining failure
was an independently scheduled `workspace.checkpoint_capture` during model waiting.
Temporary source/mutation fixtures now explicitly use project-scoped Manual recovery
policy so that strict no-new-operation assertions measure assistant effects.
Product recovery defaults are unchanged. All 15 native mutation tests and selected
fixture Clippy passed: `target/component-fixture-isolation-{tests,clippy,build}.log`.
The next isolated repeat (`2026-09-13T10-12-41.010Z`) passed 1/3; its two failures
were checker mismatches for "output number 2" and pre-tool narration. The checker
now reads the final post-tool answer and recognizes complete output/sequence
numbers and exact operation IDs. Regressions reject wrong IDs, number prefixes,
conflicting colors and unavailable-image claims. Logs:
`target/component-plot-citation-labels.log`, `target/component-final-citation-clippy.log`.
Engine and mutation-test Clippy passed (the latter with the existing Host style
exceptions), and the current main binary built successfully. Logs:
`target/component-image-order-{clippy,build}.log` and
`target/component-interrupted-repair-clippy.log`.

Client/history verification passed 383 UI tests, 25 frontend boundary fixtures,
type generation/build/check, 29 SQLite component tests and the Host recovery test.
History tests cover scope, cursor bounds, tied timestamps and read purity. The new
client tests cover late acknowledgements, immutable targets, storage failure before
dispatch, offline drafts, explicit conflicts, stale pages and bounded event history.
Logs: `target/component-client-{unit-final,validation,types-verified,boundary-fixtures}.log`,
`target/component-history-{store-final,pagination-final,recovery,clippy-final}.log`.
The authenticated history HTTP route also passed its no-model/no-runtime test,
and the current main binary built: `target/component-history-{http-final,build}.log`.
The final-answer extraction regression and selected probe Clippy passed in
`target/component-final-answer-{test,clippy}.log`.

The later lifecycle/concurrency pass completed 391 UI tests plus 25 boundary
fixtures, typecheck, client build/check and the current main build. An external-Agent
browser run passed 8/9; the failing case waited on CLI discovery, and its isolated
repeat passed. No component requests appeared in that failed trace. Logs:
`target/component-client-lifecycle-{unit,types,build,main,browser,browser-repeat}.log`.
The component UI remains unimplemented pending Paper review.

The Start command boxes its Rust payload without changing generated JSON/TypeScript.
Its newly introduced large-enum diagnostic was removed. Selected Application,
engine, Host, MCP and Workbench Clippy passed with existing style exceptions;
Workbench's 11 tests, the affected Rig feedback test and final build also passed.
Logs: `target/component-parity-{client,clippy,contract-lints,workbench,feedback,build-final}.log`.

Strict Clippy has pre-existing diagnostics in large Contract wire enums, a SQLite
range test, Host session-protection style and Workspace checkpoint style.
The three Workspace diagnostics were reproduced at commit `4b0907ff` in a
temporary registered worktree, then that worktree was removed. Selected Workspace, Application, engine and Host Clippy passed with only the
reproduced `collapsible_if` and Host `unnecessary_sort_by` categories allowed;
no source-wide suppression has been introduced. Evidence: `target/component-repair-*-clippy*.log`
and `target/component-repair-clippy.log`.

Outstanding: Paper review and seven usable Studio entrances; further input,
cross-session, multiwindow and resource stress; and P5 complete scientific, workspace and performance
acceptance. The P0 standalone binary size was only a diagnostic measurement; it
does not establish the shipped application overhead. See
`target/component-agent-build-evidence.json` for that original measurement.

All real checks use disposable projects. Existing user Hosts, R memory and drafts
are preserved. Inspect live state before replacing any workbench. No installation,
signing or publication was performed.

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
