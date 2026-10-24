# Rho status

Updated: 2026-10-24. Contract, type and call-boundary ownership.

One public contract is served, and it is derived rather than restated. Each
component owns its operation schemas in a pure package entry (`./operations`);
`scripts/contract-owners.mjs` snapshots those entries with the selected package
version and entry digest, so an absent owner is still describable without
importing, activating or installing it. The application adds only what it owns
(the project every request is scoped to, and its own operations). Rho keeps no
second copy of a component contract: the five hand-maintained copies that used to
exist had already drifted from their owners.

Public types are generated from that contract with `json-schema-to-typescript` (the
Node client, browser client and service request boundary all use them), and
`npm run check:contracts` fails on a stale owner snapshot, a stale published artifact,
an operation present in only one of them, or stale generated types. It writes nothing.
`--check` was verified to fail on an edited artifact and on an orphan operation file.

Runtime guarantees are unchanged: Ajv validates every request and the one place an
untrusted value becomes typed is `src/contract-runtime.ts`; requests are handed on
unaltered (no default, coercion or reserialization), so request digests and
duplicate delivery keep their meaning. Authorization, version, disk and native
checks stay at each operation. `test/contract-coverage.test.mjs` calls every
published operation and fails if any is answered by the "not installed" fallback.
`test/types/contract-usage.ts` is compiled, not run: it asserts that unknown
methods, wrong fields, wrong value types and invented return types are rejected for
both clients, and that a rejected request cannot be read as accepted.

Responses that used to be a bare object now name their real fields: runs (request,
Core identity, native view, plan source, checks, cancellation), selections,
contexts, task-map state and receipts, the capability catalog, composition records,
workspace save/restore, observation snapshot, artifact facts, table pages and media
metadata. Genuinely open payloads stay open with a stated boundary: Core's native
view, table rows, provenance/coverage, resource format, and the Agent's own
vocabulary and form parameters. Every service-facing test validates the real
responses and SSE events it receives against the contract.

Checks run on the published commits (`480ac6f5` application, `18252d2` owners):
Rho 103/103, Plugins 65/65, `npm run check:contracts` clean, service and web builds
clean. `mcp` calls are validated against the resolved owner contract and then enter
the same service operation: the accepted `rho_call` value is asserted to equal the
direct reply and to satisfy the published response schema.

[Contract acceptance](CONTRACT-ACCEPTANCE.md) records what was actually executed on
these commits: the person, execution/MCP and U1 journeys against both the source build
and an installed copy of the packed artifact, recovery acceptance's seven checks, and
collaboration acceptance over real stdio MCP and HTTP.

Still not executed: the scientific `install-acceptance.mjs` flows (two external
example projects are absent here) and the model-driven collaboration variant. No npm
registry publication or signing was performed.

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

A project opens on its own question rather than on the last-used layout, then gives
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

Earlier baselines, retained with their own scope: protocol, stdio MCP, retained v1,
service, crash/continuity, workspace and budget tests, and three SIGKILL boundaries
keeping the original operation/Core identity and one dispatch after a missing first
acknowledgement. Plugin removal/reselection preserves drafts, undo, bytes, layout
references, selection intent and Core identity without replay. Real flows then: an
ordinary R project and the paired DESeq2 project (16,139 genes, 33 artifacts) through
the generic runner; a Claude MCP v2 handoff that changed the same unsaved Chinese/emoji
buffer without a Host; base-R recovery keeping four partial rows across owned Host
loss. Retained extraction failures (a sidecar inside the producer's inventory, a wrong
declared column) stay failed.

## Single-contract cleanup verification

The two coexisting protocol artifacts were collapsed on 2026-10-23, before any
release, because keeping an unpublished second dialect charged a compatibility cost
against development work. Shared definitions live in `protocol-base.ts` with no
contract identity.

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
PDF rendering, image decoding and browser interaction are not implemented.
Native execution retains OS authority. Saving checks actual disk conditions but
does not provide CAS against outside writers. MCP supports explicit tool-fetched
context; proactive external-chat delivery remains unavailable.

[Interaction model](INTERACTION-MODEL.md) draft, replayed over agent-exp-2215 by `npm run prototype:replay` (person simulated, not the WebUI); `src/expression.ts` holds its rules, `test/expression.test.mjs` checks them. [Its plan](INTERACTION-PLAN.md) sequences S0–S7 before any high-fidelity design; S0 is in: a view the person opened keeps its version while following (default B). S1 is in: the 18:19 questions and their fetch receipt are facts with principals; a question stays on the version it was asked about, and a receipt changes nothing else. S2 is in: `src/trace.ts` folds Rho's own records into the same trace and the ledger's five projections; Rho holds 3 of the run's 7 refusals, the other 4 never left the agent adapter.

Source, accepted composition, npm installation and future signed distribution
have separate identities/evidence. Local ignored evidence stays at the selected
paths. No npm registry publish or signing has been performed.
