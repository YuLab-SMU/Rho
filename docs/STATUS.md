# Rho status

## Workspace plan

Updated: 2026-10-25. The user approved the [workspace plan](WORKSPACE-PLAN.md) W0–W7.
**W0 done:** the superseded-failure rule is in the model, engine and tests;
`scripts/rulers.mjs` measures E1/E4 and M1–M10 from the page only and the S7 acceptance
records them on the frozen workspace. That baseline fails M1 at 1024 and 390 in the
return state, M2 everywhere (the stacked additions reach 94% of a 1024×768 viewport),
M4 (`version ? → 2`), M6 and M7 nav contrast (4.32:1). `scripts/install-smoke.mjs`
installs the packed tarball outside the checkouts with its vendored debug Core: ready
0.75 s, home rendered 1.75 s, idle service RSS 128 MiB, home passes M1–M10 at four
widths, no Host left. `scripts/performance-baseline.json` holds the W0 numbers (open
0.9 s, interaction p95 32 ms in headless Chrome, initial/total gzip 97/513 KiB).
U2 6/6 and S7 pass. Human understanding is not yet evidenced and is not a gate.
**W1 done:** `web/shell/` draws the owner's composition tree (`src/shell-layout.ts`) as
splits and ARIA tab groups behind `#shell=next`; each owner view keeps one element for
as long as it is in the layout, so regrouping, re-layout and the narrow surface move it
instead of remounting it. U2 6/6 on the shell; the hard case (unsaved script through an
Agent layout, a re-layout and a layout switch, then own undo with focus kept), six
composition trees at 0% weight error, and M1–M10 at four widths pass
(`scripts/shell-acceptance.mjs`). The project overview loads on demand: initial gzip
92.7 KiB (baseline 97.3). `--color-meta` darkened to 4.5:1 on the canvas.
**W2 done:** the shell renders the Rho layer from `Screen`: follow switch, the Agent's
object and state (E1), the run chain (a superseded failure is one click away, M3), one
interruption, a digest of at most six lines, and recorded evidence with declared items.
Each artifact view has a source line (producing run observed, byte/domain checks
verified, the Agent's words apart, E4) and runs link back to exact versions (E2). A
submitted table question folds to one status control in the view's header (Rho-plugins
6cc968d); its open thread is a transient line. Task-map items now reach the live
`Screen`. S7 on the shell passes every functional check, E1–E5 with zero `task.map`
calls, and M1–M10 enforced at return, interrupted, complete and the run view at four
widths; U2, shell (with a declared item) and plugin UI pass; unit 161/161, replay
27/27. Open 0.41 s, p95 ≤24 ms, initial gzip 90.5 KiB; the 530 KiB total carries both
shells and is gated once W6 removes the old one.
**W3 done:** the composition shell is the default workspace; the dockview one is frozen
behind `#shell=legacy` until W6. UI acceptance (23 checks) runs on the default entry,
updated to the task-first overview it had waited on since 87ded39e; the sidebar's
Documents/Files now open their collapsed section before focusing it. A move made by the
owners' records never hides the view holding keyboard focus, and moving a view carries
its focus. `scripts/pages-acceptance.mjs` holds M4, M5, M7–M10 on the unpaired landing,
Home, the overview closed and open, the plugin catalog and page, and the disconnected
tab (plugin section counts now 4.5:1). S7, U2, plugin UI and shell pass on the default.
**W4 done (2026-10-25):** a paired tab may stop its project's runs and the Agent's;
any session reads a run by operationId, only the submitter retries, one `not_found`
answers a missing, guessed or other project's ID, and each cancel names its requester
(`test/cancel-authority.test.mjs`). `project.runs` reports `stop` from Core's own record
(a request is never shown as a stop) and `repairOf`. `context.create {run}` freezes the
run's facts and the last 8 KiB of stderr. The shell gains `rho.action`, an Agent-proposed
form checked by the owner's contract (references read by name, problems per field),
submitted once under the proposed operationId; the run view gains Stop, a bounded log,
"Ask the Agent to fix" (a copied request) and repair links; the context panel lists Agent
sessions. `scripts/action-acceptance.mjs` passes all W4 browser exits on real Core and R:
two clicks → one dispatch, refresh mid-run keeps the run, "requested" then "stopped",
repair context with the real error, unknown after the Host is killed, M1–M10 on the form
and run views. Found and fixed: a read said "running" while no Host answered. Not proven:
the natural-language step with a real model (W7). Unit 165/165, replay 27/27; S7, UI,
pages (now with the context panel), shell, U2 and plugin UI pass; initial gzip 91.3 KiB.
**W5 done (2026-10-25):** views of one table version share one selection channel
(`linked:<id>@<version>`), so the table and the new Charts scatter select the same
entities, and sorting or filtering never changes which entities are selected. Layout
commands need no dragging: Split right/down, Move to the next/previous group, Close view
and Undo layout change sit in the palette's Layout group after View; each is one
conditional `composition.apply` replacement or `composition.undo`, and a divider moved
by keyboard is written back. The browser grant adds `composition.apply/undo` and
`data.plot`. While the person works, an Agent's layout waits as "Open update"; a
missing component keeps its reference and offers the nearest view beside it. The editor
hands the Agent an exact buffer range with its version and whether it is saved; a range
the buffer moved past is refused with "Select it again". `scripts/object-acceptance.mjs`
passes all W5 exits on real Core: one channel through sort and filter; split, move,
close, divider, undo and a layout switch keep the draft, undo and selection; legal
compositions apply while malformed, stale and out-of-catalog ones are refused; closing a
view leaves its run running; M1–M10 on the split layout. Found and fixed: a tab chosen
before the live session started was dropped; a closed view stayed held; the chart drew
letterboxed after a split. Unit 169/169, plugins 67/67, replay 27/27; S7, UI, pages,
shell, U2, plugin UI and actions pass; initial gzip 91.3 KiB; total gzip 540 KiB, above
the 525,061-byte gate W6 engages once the legacy shell is gone.

Updated: 2026-10-24. S7 live expression and complete table-question feedback.
`src/expression.ts` drives the replay and the real browser through `live-trace.ts` /
`live-workspace.ts`. Working preserves input and exact resource bindings; new versions
get separate views/selection scopes, layout changes become proposals, and return gives
a digest without replaying focus or native execution. Annotations 0.4.3 uses the
Documents draft, exact table anchor and context receipt, then an explicit Agent
`replyTo` with owner-validated output refs; reading a question does not answer it.
[S7 engineering acceptance](INTERACTION-ACCEPTANCE.md) records real Chrome at four
widths, browser IME, lost acknowledgement/reload/original retry, no Task Map, immutable
old/new tables, linked replies, and failure then recovery. Actual Claude Code 2.1.310
completed the continuation in 28 turns / 132 seconds with four intended R dispatches;
refresh adds none. S6 remains **human usability unverified** and is not a gate.

The public contract stays generated from its owners and validated at the request
boundary; [contract acceptance](CONTRACT-ACCEPTANCE.md) keeps earlier installed evidence.

## Task-first project page, truthful execution facts

Updated: 2026-10-25. Three reported defects were real and are fixed at their source
rather than restyled. `project.runs` now reports three separate facts per run: the
artifact paths the plan **declared**, whether each of those files is **on disk** now
(one bounded stat in the run's output folder), and the recorded **integrity** and
**domain** states plus whether the producer wrote a completion inventory; `script`
and a path-withheld `sourceKey` let a reader see retries of one file even when the
code changed between attempts (`src/protocol.ts`, `src/server.ts`). The person's page no longer lists
declared paths as produced. `web/theme.css` defined only `pending` and `unknown`
state dots, so `project.tsx`'s `state failed` drew the verified green dot; `failed`
and `declared` now name themselves, and the Agent's own "done" is neutral because
green is reserved for owner-verified facts. `web/execution-facts.ts` is the single
reading of runs, artifacts and checks (DOM-free, used by both pages).

Choosing a project opens its overview; reloading an already selected workspace
restores that workspace and its return checkpoint. The overview gives
one tally of runs, declared items and the absence of a domain check, the runs needing
attention, the results (newest version of each artifact name, earlier versions
counted), and what the Agent declared, with records, documents, files, layout and
diagnosis behind disclosures. A failure is a row that opens the execution panel.

A framed view bound to a registered resource carries one achromatic line naming the
execution that produced that version and whether its bytes were verified, plus the
other files of that same execution as links, so a figure and its table are one click
apart instead of two unrelated tabs. The panel separates declared / on disk /
verified / domain, lists what the run registered, shows the submission chain with
each attempt's code digest, and states that no execution establishes a statistical
result. The whole-task form is a band above the work.

A task-map item may name the exact artifact version it produced (`item.artifact
{id, version}` in Rho-owned `task.map.declare`). The shell resolves it against
registered resources and links it in the item's footer and on the project page; a
stale version draws nothing rather than a guess.

Asking a question carries the person's own words and their selection. "Ask about this"
opens a one-line composer; sending appends the text to the project's `questions.md`
through the document owner and creates a `context.create` naming that text range, the
exact artifact version, and — when rows of that version are selected — those entities,
read from the view-scoped channel so rows picked elsewhere never attach. The view
reports "Prepared" until the owner records a fetch, then "Fetched by the Agent" with
the time; work accepted after that is counted as a time fact, never as a claim that it
answers the question; every run here predates the fetch, so only that case is covered.

Checks: Rho 114/114 with `RHO_CORE_BINARY` set (the ten new unit tests cover the
reading of runs, artifacts and checks: declared vs present vs verified, an unknown
outcome never read as done, one row per artifact name with earlier versions counted,
one file's submissions chained). Without that variable eight tests fail on the missing
Core binary, not on the change; `npm run check:contracts` is clean. One earlier
run failed a single test and did not reproduce in five attempts, recorded rather than
waved away. Browser acceptance runs on `work/agent-exp-2215` itself — the service left
from the earlier experiment was stopped, and an orphaned lock-holder child with it, so
the Agent's own items carry exact artifact versions. 49 checks at 1440 and 768
including restart: question, both failed runs, provenance, the sibling jump, the
written question and its fetch receipt, a question narrowed to two selected rows, and
a map naming real artifact versions that open, all from owner state. Evidence:
`work/agent-exp-2215/evidence-v3`.

Not done: no `from` edges are declared here, so the map still cannot show a branch;
no figure region can be anchored; the notes document is one fixed path; and the
Agent's reply to a question has no channel in this project — a context records the
fetch, but responses exist only for annotation-backed feedback.

The earlier `artifact-not-presentable` diagnosis was wrong: `artifact.check` already
returns registered owner-state references. Execution acceptance binds that reference
and requires Chrome to decode the actual PNG at 1440/768/390, then refresh it with
exactly one Host start and one native submission. Installed UI entries and observed
visibility are separate facts; headless metadata no longer claims every renderer is
absent.

Checks: Rho 99/99 and Plugins 65/65 from [the executed checks](VERIFICATION.json).
Source person/execution, deterministic stdio collaboration, U1 (23 checks) and U2
(6 checks) passed. A real Claude Code 2.1.308 session completed discovery, exact
context fetch, shared-buffer edit and confirmation through the four tools; it
started no Host. This model trial does not establish autonomous scientific or
full product acceptance. The previous prose-only dead-path assertions were
removed; actual browser/owner checks now fail on those regressions. A clean local
package passed offline installation outside the checkouts, exact artifact/shard
checks and installed person (9), execution/MCP (5) and U1 (23) checks. The
[accepted combination](progressive-acceptance.json) records source identities,
budgets and the responsive-renderer check; [remaining scope](UNVERIFIED.md).

Updated: 2026-10-22. **Phases 1–5 selected grades flow:** [installed native acceptance](HEADLESS.md#installed-native-grades-acceptance-phase-5) covers two actual Claude Code / Westlake HPC DeepSeek business sessions and two restricted presentation sessions; base tables appear before presenters start, and original-session feedback, human edits, versioned outputs and explicit replies survive the selected faults. The offline candidate passed 32 installed checks, 34 real-model assertions, 14 browser/restart checks and 95 domain/identity assertions against AC01–AC21 (77 model tool calls; failed-trial calls and usage lower bounds retained separately). Source checks then Rho 63/63, Plugins 45/45. This bounded acceptance excludes same-project multi-task, full teaching-design acceptance and official distribution; no registry publication or signing has been performed.

## Item frame and Agent map

Source follows the whole-task design on the Paper page
[03c · 任务全景](https://app.paper.design/file/01M5HG6R8RBC33N84S245J0YXT/p-7-0);
see [Item frame and Agent map](UI.md#item-frame-and-agent-map). The Agent declares
items with its own kind/state vocabulary (`task.map.declare`); Rho interprets only
an optional term role, and every entry draws its body inside Rho's frame. The Agent map is a Rho-owned registry entry importing only the frame contract; its
reference, strip, trail, whole-task and compare forms share `task.map.present`.
Pins win, Agent changes are attributed and revertible, and Agent form changes inside
`agentFormIntervalMs` merge into one suggestion. Reads only observe. Rho reserves the
tones that mean a fact it established (`verified`, `failed`, `unknown`): an item
declaring one falls back to the quiet tone its role earns, so an Agent "done" never
carries the mark Rho uses for verified bytes.

Tables and Documents draw their own bodies in this frame following
[04 · 插件形态](https://app.paper.design/file/01M5HG6R8RBC33N84S245J0YXT/p-8-0).
Checks: Rho 73/73 (then), Plugins 53/53, 14 browser tests, U1 23 checks, U2 6 checks
and plugin pages on Chrome 155 with zero Host starts. A scripted 1440/768/390 pass
drew all 12 Tables/Documents forms on real tables and Agent-edited text: zooming up
reached the summary, a person's show switch was recorded as human, a card revert
updated every form, no card overflowed and the only failed request was
`/favicon.ico`. Limits: one map per project, not archived by `workspace.export`;
item boundaries are whatever the Agent declares (Q1); a keyed subset costs one page
read per key, at most 50. Paper boards remain pending user review.

## Teaching case handoff

The earlier UI pause followed review of the gap from the original Paper experience;
phases 2–5 now have bounded acceptance and committed source. The
[teaching-case handoff](TEACHING-CASE-HANDOFF.md) maps the grades-mean question to
that journey; the full teaching journey and user design acceptance remain pending.
Documents/Tables editing, exact reads, own undo, revert and paging stay reusable.
[U2 evidence](U2-UI-ACCEPTANCE.md) retains bounded engineering checks, which do not
accept the teaching experience. The UI contract remains `0.1-draft`.

## U1 browser shell candidate

First-use review rejected typed paths and the temporary preview root; the correction
uses the macOS folder window and separates a project name from its source folders.
Create project adds existing folders without making same-name directories, Overview
can add further folders, and named workspaces keep owner state separately. Files and
Documents resolve selected source references with distinct identities, shared alias
buffers, conditional saves and source-containment checks; saved R script planning can
read selected sources without changing execution identities. Then-current checks: Rho 66/66, Plugins 46/46, 23 shell checks at 1600–390 on Chrome
155 with zero Host starts, plus the installed browser flow and multi-source reads. [Fixed candidate](ui-acceptance/u1-source-folders.json)
records identities; user design acceptance, full input/accessibility, other-platform
folder dialogs and signed distribution remain pending. The shell keeps Agent-opened links, same-origin assets, scoped tab credentials,
observation after restart and grouped commands.

## Headless collaboration extension

The additive v2 extension selects nine owners, including Annotations. Project
capability configuration, shipped Skills and live MCP filtering share the same HTTP
owners. Structured composition transactions/undo, protected views and
caller/view/shared selections are implemented; Documents/Tables validate frozen
feedback anchors and Annotations owns submitted messages and explicit replies. Agent
contexts distinguish preparation, tool fetch and explicit linked response. DOM-free
snapshot/event reconciliation and format-3 archives preserve collaboration without
native replay. See [Collaboration](COLLABORATION.md) for contracts, limits and checks.

Source checks: 24 Rho tests and 14 Plugins tests pass. Fixed Full and six-owner
Collaboration-minimal npm installations outside the checkouts both pass the
deterministic real stdio MCP/HTTP and actual Claude Code 2.1.302 scenarios, with zero
Host starts and native dispatches, as do independent owner installations and both
reduced combinations. Installed live HTTP/SSE checks cover dual observers, restart,
cursor gaps and injected publication/backlog boundaries; separate installed explicit
R execution covers one native dispatch, close-without-cancel and unknown outcome
after owned Host loss. [Collaboration acceptance](COLLABORATION-ACCEPTANCE.md)
freezes the source/package identities and limits: headless collaboration is accepted,
not UI. The earlier eight-owner candidate below retains its historical identity.

## Historical application baseline

Version 0.4 provides documents, files, R, requirements, tables, media, charts and
Agent through independent npm plugins, each owning its descriptor, behavior and entry
contracts; Rho selects reviewed versions, injects service ports, and a thin contracts
package supplies generic references/envelopes/ports and file primitives. Format,
requirement and script schemas belong to pure owner contract entries; Contracts keeps
no format registry, native plan or document budget, and R owns its script snapshot
budget. Only `action.submit` requires Requirements, and only Tables brings csv-parse
while only Agent brings the MCP SDK. Rho owns authentication/projects, durable
caller intents, the public Core CLI bridge and composition.
[HEADLESS](HEADLESS.md) documents the API and plugin selection, the
[plugin boundary review](PLUGIN-BOUNDARY-ACCEPTANCE.md) the responsibilities and
dependency checks, and [extraction acceptance](EXTRACTION-ACCEPTANCE.md) the actual
source/package checks. One contract serves retained and new work: original accepted
parameters, Core identity and resource bytes stay observable, while superseded
scientific submissions are unavailable. Selected baseline: macOS arm64, Node
22.22.3/npm 10.9.8, Python 3, R 4.5.2, Claude Code 2.1.301 / MCP SDK 1.29.0; R is
external and the ordinary project needs no add-on R package. Other platforms,
registry publication and signing remain unverified/unselected.

## Historical baseline verification

Earlier baselines keep their own scope: protocol, MCP, continuity, budgets, SIGKILL
boundaries with one dispatch, plugin reselection without replay, and real ordinary,
DESeq2 and recovery flows. Retained extraction failures stay failed.

## Current focus and remaining work

[PX-01–PX-05](PLUGIN-EXTRACTION.md) passed their backend scope, including both
installed consumers. The 0.4 boundary review removed central format schemas,
package-wide execution dependencies and a borrowed script budget, and Full plus two
reduced installations passed with removal/reselection and recovery acceptance. The
versioned HTTP schema and inert fixtures form the backend boundary for independent UI
work; the [plugin interface handoff](PLUGIN-UI-HANDOFF.md) records selected owners,
dependencies and routes. The current grades candidate adds conditional layouts and
selected owner entries, which does not accept the whole U2–U4 product journey.
[The six backend work packages](BACKEND-FIRST.md) and [first-release
tasks](WEBUI-FIRST.md) retain their scopes and product gates.

Full editor IME/clipboard, accessibility and broad performance acceptance remain
pending; grades-flow widths, shared Unicode input and installed recovery checks have
their recorded scope and do not accept every editor, grid or Agent interaction.
React/TypeScript, Vite, Dockview, CodeMirror 6, AG Grid Community, ECharts and a typed
json-render catalog remain selected UI choices; Electron and cross-window movement
follow later.

## Design evidence and limits

The Paper ["Release 1 · v3 (capabilities)" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-8-0)
holds W1–W5 (inquiry map, live finding composition, editable-spec explainer,
traceback, anchored feedback) and W1a–W5a continuation/error states, with the
[flow index](DESIGN-PRIORITIES.md#w1w5-能力组合动线索引), the
[state index](DESIGN-PRIORITIES.md#w1aw5a-续接与异常状态索引) and the
[version/feedback ledger](DESIGN-PRIORITIES.md#w-系列资源版本与反馈台账); C9
presentation/animation and C10 annotations remain proposals.

The design keeps distinct: draft, context available but unfetched, a tool-fetch
receipt, observed work and an explicitly linked response. The earlier
["v2 (inquiry)"](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-7-0) and
["npm WebUI"](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-5-0) pages
stay as flow/state reference. Their 1440/1280-wide boards do not prove live layout,
native input or accessibility, and designed run numbers are not backend evidence.

Execution, artifact integrity, domain checks and model judgment remain separate.
The bounded paired trial uses one simulation; Plugins' earlier 200-simulation and
Agent-evaluation records retain their own scope. Batch object snapshots do not
provide live variables or R-memory recovery. Media bytes/metadata are available;
PDF rendering remains unimplemented; image, table and document browser checks
retain their recorded scope.
Native execution retains OS authority. Saving checks actual disk conditions but
does not provide CAS against outside writers. Unassigned MCP contexts require explicit
handoff; configured feedback routes retain the original business session.

[Interaction model](INTERACTION-MODEL.md) and [its plan](INTERACTION-PLAN.md) retain
S0–S5 evidence and two real historical Agent trajectories. `npm run prototype:replay`
still opens them, with simulated person actions clearly identified. S7's live
browser now shares those rules and records explicit replies; historical missing
calls are not backfilled. [S6's moderator script](VALIDATION-S6.md) remains ready
for an actual participant; no human validation has been claimed.

Source, accepted composition, npm installation and future signed distribution
have separate identities/evidence. Local ignored evidence stays at the selected
paths. No npm registry publish or signing has been performed.
