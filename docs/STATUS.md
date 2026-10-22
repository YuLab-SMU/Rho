# Rho status

Updated: 2026-10-22. **Phases 1–5 selected grades flow:** [installed native acceptance](HEADLESS.md#installed-native-grades-acceptance-phase-5) now covers two actual Claude Code / Westlake HPC DeepSeek business sessions and two restricted presentation sessions. Base tables appear before presenters start; original-session feedback, human edits, versioned outputs and explicit replies survive the selected faults. The external offline candidate passed 32 installed checks, 34 real-model assertions, 14 browser/restart checks and 95 domain/identity assertions against AC01–AC21. Success: 77 model tool calls, 1,098,713 input tokens including cache and 29,705 output tokens; failed-trial calls and observed usage lower bounds are retained separately. Source checks remain Rho 63/63, Plugins 45/45; Agent 0.4.3, Documents/Tables/Annotations 0.4.1/0.4.2/0.4.1; Core unchanged. This bounded acceptance excludes same-project multi-task, full teaching-design acceptance and official distribution. Phase 1–5 source is committed; no registry publication or signing has been performed.

## Item frame and Agent map

Source now follows the whole-task design on the Paper page
[03c · 任务全景](https://app.paper.design/file/01M5HG6R8RBC33N84S245J0YXT/p-7-0);
see [Item frame and Agent map](UI.md#item-frame-and-agent-map). The Agent
declares items with its own kind/state vocabulary (`task.map.declare`); Rho fixes
no closed list and interprets only an optional term role. Every entry draws its
body inside Rho's frame, with forms ordered by scale, subsets as parameters and a
hidden-note footer. The Agent map is a Rho-owned registry entry importing only the
frame contract; its reference, strip, trail, whole-task and compare forms share
`task.map.present` with people. Pins win, Agent changes are attributed and
revertible, and Agent form changes within `agentFormIntervalMs` (8 s) merge into
one suggestion. Reads only observe.

Tables and Documents now draw their own bodies in this frame, following
[04 · 插件形态](https://app.paper.design/file/01M5HG6R8RBC33N84S245J0YXT/p-8-0)
with the four recommended answers accepted. Tables shows a count, keyed rows, a
cell, a summary or a recorded comparison. Documents shows a passage, a change, the
outline, a section summary or one change compared. Compare is declared
`zoom: false`. Bodies read through the item's bound view and report their hidden
note. See [Item frame and Agent map](UI.md#item-frame-and-agent-map).

Checks: Rho 73/73 (including `zoom: false`); Plugins 53/53 (seven card-model tests).
Browser tests 14/14, U1 23 checks, U2 6 checks and plugin pages pass on Chrome 155
with zero Host starts and native dispatches. A scripted Chrome pass at 1440/768/390
drew all 12 Tables/Documents forms on real tables, a recorded comparison and
Agent-edited text. In that pass:
- zooming up from a card reached the summary, not compare;
- a person's `show` switch was recorded as human;
- a card revert updated every form of the document;
- no card overflowed at any width;
- the only failed request was `/favicon.ico`, and no Host started.

Limits: one map per project, not archived by `workspace.export`; item boundaries
are whatever the Agent declares (Q1). A keyed subset makes one page read per key,
at most 50. Paper boards remain pending user review.

## Teaching case handoff

The earlier UI pause followed review of the gap from the original Paper experience;
phases 2–5 now have bounded acceptance and committed source. The [teaching-case handoff](TEACHING-CASE-HANDOFF.md)
maps the grades-mean question to that journey, fixed data, reusable code, owner gaps
and pending frontend/Agent acceptance. The selected object-feedback inspector now has a bounded question entry; the full teaching journey and user design acceptance remain pending.
Documents/Tables editing, exact reads, own undo, revert and paging remain reusable.
[U2 evidence](U2-UI-ACCEPTANCE.md) retains its bounded engineering checks; it does
not accept the teaching experience. The UI contract remains `0.1-draft`.

## U1 browser shell candidate

First-use review rejected typed paths and the temporary preview root. The current
correction uses the macOS folder window and separates a project name from its
source folders. Create project adds one or more existing folders without making
same-name directories; Overview can add further folders. Named workspaces keep
owner state separately. Existing projects and managed requests are preserved.
Files/Documents resolve selected source references with distinct file identities,
shared alias buffers, conditional saves and source-containment checks. Saved R
script planning can read selected sources without changing execution identities.

Source checks: Rho 66/66; Plugins 46/46. Chrome 155 passes 23 shell checks at 1600/1280/1024/768/390 with zero Host
starts/native submissions. The clean offline candidate also passes the same installed browser flow and
installed multi-source reads/addition/restart checks. [Fixed candidate](ui-acceptance/u1-source-folders.json)
records its identities; user design acceptance remains pending. The
[U1 record](UI-ACCEPTANCE.md) retains historical five-width, Full/minimal installed
checks and the seven alignment batches. Those checks did not accept first-use
usability. The [new Paper review draft](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-C-0)
uses the user-provided name-and-source-folders reference; earlier path-entry
boards remain historical and have not been overwritten.

The shell retains Agent-opened one-time links, same-origin assets, scoped tab
credentials, observation after refresh/disconnection/restart, grouped commands,
plugin discovery and unavailable retained views. Native selection adds only the
chosen folder/project scope. Browser actions never start a Host or native task.
The UI contract remains `0.1-draft`; full input/accessibility, product acceptance,
other-platform folder dialogs and signed/registry distribution remain pending.

## Headless collaboration extension

The additive v2 extension now selects nine owners, including Annotations. Project
capability configuration, shipped Skills and live MCP filtering share the same
HTTP owners. Structured composition transactions/undo, protected views and
caller/view/shared selections are implemented. Documents/Tables validate frozen
feedback anchors; Annotations owns submitted messages and explicit replies. Agent
contexts distinguish preparation, tool fetch and explicit linked response.
DOM-free snapshot/event reconciliation and explicit format-3 archives preserve
collaboration without native replay; older exports reject lossy representation.
See [Collaboration](COLLABORATION.md) for contracts, limits and executable checks.

Source checks: 24 Rho tests and 14 Plugins tests pass. Fixed Full and six-owner
Collaboration-minimal npm installations outside the checkouts both pass the
deterministic real stdio MCP/HTTP and actual Claude Code 2.1.302 scenarios, with
zero Host starts and native dispatches. Independent owner installations and both
existing reduced combinations also pass. Installed live HTTP/SSE checks cover
dual observers, restart, cursor gaps and injected publication/backlog boundaries.
Separate installed explicit R execution covers one native dispatch,
close-without-cancel and unknown outcome after owned Host loss. The accepted
public Core binary/digest is unchanged; current Core checkout commits are not
selected. [Collaboration acceptance](COLLABORATION-ACCEPTANCE.md) freezes the
source/package identities and limits: headless collaboration is accepted, not UI.
The earlier eight-owner candidate below retains its historical identity.

## Historical application baseline

Version 0.4 provides documents, files, R, requirements, tables, media, charts and
Agent through eight independent npm plugins. Each owns its descriptor, behavior and
entry contracts. Rho selects reviewed versions and injects service ports; a thin
contracts package supplies generic references/envelopes/ports and file primitives.
Format, requirement and script schemas belong to pure owner contract entries;
Contracts has no format registry, native plan or document budget. R owns its
script snapshot budget. Only its execution action requires Requirements; exported
objects work with Files/R alone, without Documents, Requirements, R or a Host.
Only Tables brings csv-parse; only Agent brings the MCP SDK.
The earlier extraction removed scientific workflows from the base dependencies. `/api/v2` HTTP/SSE schemas, client and inert fixtures expose explicit
scripts/requirements/artifacts, typed tables and entity namespaces, media and
exported object snapshots. The base npm package contains no project recipe or R
script. The ordinary base-R project and original paired analysis use the same
`r.execute`, readers, keyed comparison and composition validation.

Rho owns authentication/projects, durable caller intents, the public Core CLI
bridge and composition. Plugins owns document/resource semantics, R plans,
requirements and scoped MCP. Core remains unchanged at
`d0159da6feb01d1be9e3b4b34b67953241fedfcb`.
[HEADLESS](HEADLESS.md) documents the current API and plugin selection;
[plugin boundary review](PLUGIN-BOUNDARY-ACCEPTANCE.md) records the current responsibilities and dependency checks; [extraction acceptance](EXTRACTION-ACCEPTANCE.md)
records actual source/package checks and failures.

Frozen v1 schema/fixtures and an observation bridge preserve original accepted
parameters, Core identity and resource bytes. New v1 scientific submissions are
unavailable; reads, explicit retained retry/cancel and schema-1 workspace restore
do not select a recipe or create a replacement execution.
The [original v1 acceptance](BACKEND-ACCEPTANCE.md) and
[immutable candidate record](backend-acceptance/v0.1.0.json) retain their scope.

Selected baseline: macOS arm64, Node 22.22.3/npm 10.9.8, Python 3, R 4.5.2,
Claude Code 2.1.301 / MCP SDK 1.29.0. R is external; the ordinary project requires
no add-on R package. Scientific dependencies are explicitly requested by the
paired project. Other platforms, registry publication and signing remain
unverified/unselected.

## Historical baseline verification

- Rho: 15/15 protocol, real stdio MCP, retained v1, service, crash/continuity,
  workspace and budget tests passed. Three SIGKILL boundaries retain the original
  operation/Core identity and one dispatch after a missing first acknowledgement.
- Plugin removal/reselection preserves drafts, undo, bytes, layout references,
  selection intent and original Core identity without replay. Unavailable providers
  reject new work; retained requests stay observable.
- Plugins: 12/12 capability tests and 2/2 separate native example tests passed.
  The additional pure-contract import guard also passed its focused boundary test.
  Explicit types preserve `001` and literal `NA`; unkeyed tables remain readable,
  stale/mismatched inputs fail, and comparisons record both versions/provenance.
- All eight capability tarballs pass independent installation/import with no
  sibling implementation. Source root packing is rejected.
- Ordinary R project: real linear model, four rows, typed two-input join, PNG/PDF,
  original bytes and an exported object snapshot pass through the generic runner.
- Original paired project: five DESeq2 fits, 16,139 genes, 33 baseline artifacts,
  121/121 saved-model observations and 12/12 independent checks; explicit apeglm
  preparation/shrinkage and two-input comparison pass through the same runner.
- Actual Claude MCP v2 handoff fetched explicit context and changed the same
  unsaved Chinese/emoji buffer without starting a Host.
- Actual base-R recovery: four partial rows survive owned Host loss; the original
  request becomes unknown without replay. Observer/view closure preserves work;
  separate cancellation confirms native process-group release. Export/restore
  preserves bytes, drafts, undo, selections and unavailable entries without a Host.
- Actual 0.4 npm installations outside the checkouts passed: the full eight-plugin
  candidate runs both explicit consumers and recovery. Two reduced candidates
  physically contain only Contracts/Documents/Files or Contracts/Files/R, and
  work without R/Host. Unavailable execution retains or dispatches no new request.
  No recipe or R script is bundled. The [candidate record](backend-acceptance/v0.4.0.json)
  freezes all three source/package/lock compositions, all nine owner package
  hashes, example inputs and observed request/resource identities. The
  [0.3 record](backend-acceptance/v0.3.0.json) remains historical evidence.

Retained failed extraction trials exposed checker-wrapper variable collision,
a generic completion sidecar placed inside the producer's immutable inventory,
and an incorrect declared shrinkage column. New trials fixed those conditions;
original failed requests remain failed. Historical scientific failures and the
original installed v1 candidate remain recorded separately.

## Current focus and remaining work

[PX-01–PX-05](PLUGIN-EXTRACTION.md) have passed their backend scope, including
both installed consumers. The 0.4 boundary review removed central format schemas,
package-wide execution dependencies and a borrowed script budget. Full and two
reduced installations passed, with removal/reselection and recovery acceptance. The versioned
HTTP schema and inert fixtures form the backend boundary for independent UI work.
The [plugin interface handoff](PLUGIN-UI-HANDOFF.md) records selected owners,
dependencies and routes. The separate DOM-free browser SDK now reuses the
snapshot/event transport and scoped bootstrap. The original U1 registry selected
no owner renderer. The current grades candidate adds conditional layouts and
selected owner entries; this does not accept the entire U2-U4 product journey.
[The six backend work packages](BACKEND-FIRST.md) retain their original
scope; [first-release tasks](WEBUI-FIRST.md) retain all product gates.

Full editor IME/clipboard, accessibility and broad product performance/installation
acceptance remain pending. Grades-flow widths, shared Unicode input and installed
recovery checks have their recorded scope; they do not accept every editor/grid
or Agent interaction. React/TypeScript, Vite, Dockview, CodeMirror 6,
AG Grid Community, ECharts and a typed json-render catalog remain selected UI
choices. Electron and cross-window movement follow later.

## Design evidence and limits

The Paper ["Release 1 · v3 (capabilities)" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-8-0)
contains W1–W5 — the inquiry map, live finding composition, an editable-spec
explainer, traceback and anchored feedback — and W1a–W5a continuation/error
states. Panels map to target entries of the Plugins
[capability catalog](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PLUGIN-CATALOG.md),
pending user review, with the
[flow index](DESIGN-PRIORITIES.md#w1w5-能力组合动线索引),
[state index](DESIGN-PRIORITIES.md#w1aw5a-续接与异常状态索引) and
[version/feedback ledger](DESIGN-PRIORITIES.md#w-系列资源版本与反馈台账).
UI entries are unimplemented; C9 presentation/animation and C10 annotations
remain proposals. Rho owns selection, assembly and routing; a capability label
does not establish registration, installation or product acceptance.

The design distinguishes feedback draft, context available but not fetched,
tool-fetch receipt, observed work and an explicitly linked response. F-12's
later explanation v2 retains the same data sources with no new execution
observed; old v1 frame anchors remain on v1. Candidate snapshot s3 requires
bounded inspection, owner field/key/binding validation and explicit switching;
it has no claimed contents, coverage or checks. Source loss retains s2 rows and
read time, missing charts retain a table alternative, and spec conflicts retain
the draft. Unknown q-0004/run 004 observations keep the original request and
partial outputs; cancellation requested, confirmed native stop and observer
closure have distinct states. Binding loss keeps the note/context; unavailable
original frames keep anchor metadata. These are design scenarios.

The earlier
["Release 1 · v2 (inquiry)" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-7-0)
(I1–I4) is retained as reference. R1–R14 on the
["Release 1 · npm WebUI" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-5-0)
are retained as flow/state coverage under that direction. W1–W5 and W1a–W4a
use 1440-wide reference artboards; W5a uses a 1280 × 900 design. These widths
do not prove live browser layout, native input or accessibility; those checks
remain pending. Existing S-series and superseded pages are historical.
The designed run numbers and 8,204-row example are not substituted for actual
backend evidence. The historical v1 partial experiment observed 16,139 rows;
the new ordinary-R recovery experiment observes four rows without completion.

Execution, artifact integrity, domain checks and model judgment remain separate.
The bounded paired trial uses one simulation; Plugins' earlier 200-simulation and
Agent-evaluation records retain their own scope. Batch object snapshots do not
provide live variables or R-memory recovery. Media bytes/metadata are available;
PDF rendering, image decoding and browser interaction are not implemented.
Native execution retains OS authority. Saving checks actual disk conditions but
does not provide CAS against outside writers. MCP supports explicit tool-fetched
context; proactive external-chat delivery remains unavailable.

Source, accepted composition, npm installation and future signed distribution
have separate identities/evidence. Local ignored evidence stays at the selected
paths. No npm registry publish or signing has been performed.
