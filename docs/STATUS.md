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

Public types are generated from that contract with `json-schema-to-typescript`
(the Node client, browser client and service request boundary all use them), and
`npm run check:contracts` fails on a stale owner snapshot, a stale published
artifact, an operation present in only one of them, or stale generated types. It
writes nothing. `--check` was verified to fail on an edited artifact and on an
orphan operation file.

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

Checks: Rho 103/103 and Plugins 65/65, `npm run check:contracts` clean, service and
web builds clean. `mcp` calls are validated against the resolved owner contract and
then enter the same service operation: the accepted `rho_call` value is asserted to
equal the direct reply and to satisfy the published response schema.

cancels on view release. Snapshots contain document metadata, not all text and
undo. Document record/aggregate budgets reject before replacing retained state.
The browser now uses the same conditional `document.save` as the owner, including
original retry identity, current revision and disk digest.

The earlier `artifact-not-presentable` diagnosis was wrong: `artifact.check`
already returns registered owner-state references. Execution acceptance now binds
that reference and requires Chrome to decode the actual PNG at 1440/768/390, then
refresh it with exactly one Host start and one native submission. Installed UI
entries and observed visibility are separate facts; headless metadata no longer
claims every renderer is absent. Person acceptance checks real button/keyboard
saves, Unicode, refresh and preservation of an external disk write.

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

Updated: 2026-10-22. **Phases 1–5 selected grades flow:** [installed native acceptance](HEADLESS.md#installed-native-grades-acceptance-phase-5) now covers two actual Claude Code / Westlake HPC DeepSeek business sessions and two restricted presentation sessions. Base tables appear before presenters start; original-session feedback, human edits, versioned outputs and explicit replies survive the selected faults. The external offline candidate passed 32 installed checks, 34 real-model assertions, 14 browser/restart checks and 95 domain/identity assertions against AC01–AC21. Success: 77 model tool calls, 1,098,713 input tokens including cache and 29,705 output tokens; failed-trial calls and observed usage lower bounds are retained separately. Source checks remain Rho 63/63, Plugins 45/45; Agent 0.4.3, Documents/Tables/Annotations 0.4.1/0.4.2/0.4.1; Core unchanged. This bounded acceptance excludes same-project multi-task, full teaching-design acceptance and official distribution. Phase 1–5 source is committed; no registry publication or signing has been performed.

## Item frame and Agent map

Source follows the whole-task design on the Paper page
[03c · 任务全景](https://app.paper.design/file/01M5HG6R8RBC33N84S245J0YXT/p-7-0);
see [Item frame and Agent map](UI.md#item-frame-and-agent-map). The Agent declares
items with its own kind/state vocabulary (`task.map.declare`) and Rho interprets
only an optional term role; every entry draws its body inside Rho's frame, with
forms ordered by scale, subsets as parameters and a hidden-note footer. The Agent
map is a Rho-owned registry entry importing only the frame contract; its reference,
strip, trail, whole-task and compare forms share `task.map.present` with people.
Pins win, Agent changes are attributed and revertible, and Agent form changes within
`agentFormIntervalMs` merge into one suggestion. Reads only observe.

Tables and Documents draw their own bodies in this frame following
[04 · 插件形态](https://app.paper.design/file/01M5HG6R8RBC33N84S245J0YXT/p-8-0)
with the four recommended answers accepted; compare is declared `zoom: false`.
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
phases 2–5 now have bounded acceptance and committed source. The [teaching-case handoff](TEACHING-CASE-HANDOFF.md)
maps the grades-mean question to that journey, fixed data, reusable code, owner gaps
and pending frontend/Agent acceptance. The selected object-feedback inspector now has a bounded question entry; the full teaching journey and user design acceptance remain pending.
Documents/Tables editing, exact reads, own undo, revert and paging remain reusable.
[U2 evidence](U2-UI-ACCEPTANCE.md) retains its bounded engineering checks; it does
not accept the teaching experience. The UI contract remains `0.1-draft`.

## U1 browser shell candidate

First-use review rejected typed paths and the temporary preview root; the correction
uses the macOS folder window and separates a project name from its source folders.
Create project adds existing folders without making same-name directories, Overview
can add further folders, and named workspaces keep owner state separately. Files and
Documents resolve selected source references with distinct identities, shared alias
buffers, conditional saves and source-containment checks; saved R script planning can
read selected sources without changing execution identities. Then-current checks:
Rho 66/66, Plugins 46/46, and 23 shell checks at 1600/1280/1024/768/390 on Chrome 155
with zero Host starts or native submissions, plus the same installed browser flow and
multi-source reads. [Fixed candidate](ui-acceptance/u1-source-folders.json) records
identities; user design acceptance remains pending, as do full input/accessibility,
other-platform folder dialogs and signed distribution. The
[U1 record](UI-ACCEPTANCE.md) keeps the historical five-width and alignment batches.
The shell keeps Agent-opened links, same-origin assets, scoped tab credentials,
observation after refresh/restart, grouped commands, plugin discovery and unavailable
retained views; native selection adds only the chosen folder/project scope.

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
Agent through independent npm plugins. Each owns its descriptor, behavior and entry
contracts; Rho selects reviewed versions, injects service ports, and a thin contracts
package supplies generic references/envelopes/ports and file primitives. Format,
requirement and script schemas belong to pure owner contract entries; Contracts has
no format registry, native plan or document budget, and R owns its script snapshot
budget. Only `action.submit` requires Requirements; exported objects work with
Files/R alone. Only Tables brings csv-parse and only Agent brings the MCP SDK.
`/api/v2` HTTP/SSE, client and inert fixtures expose explicit
scripts/requirements/artifacts, typed tables and entity namespaces, media and
exported object snapshots; the base npm package contains no project recipe or R
script.

Rho owns authentication/projects, durable caller intents, the public Core CLI bridge
and composition. Plugins owns document/resource semantics, R plans, requirements and
scoped MCP. Core remains unchanged at
`d0159da6feb01d1be9e3b4b34b67953241fedfcb`. [HEADLESS](HEADLESS.md) documents the
API and plugin selection, [plugin boundary review](PLUGIN-BOUNDARY-ACCEPTANCE.md)
the responsibilities and dependency checks, and
[extraction acceptance](EXTRACTION-ACCEPTANCE.md) the actual source/package checks.
One contract serves retained and new work: original accepted parameters, Core
identity and resource bytes stay observable, while superseded scientific submissions
are unavailable. Reads, explicit retained retry/cancel and schema-1 workspace restore
do not select a recipe or create a replacement execution. Selected baseline: macOS
arm64, Node 22.22.3/npm 10.9.8, Python 3, R 4.5.2, Claude Code 2.1.301 / MCP SDK
1.29.0; R is external and the ordinary project needs no add-on R package. Other
platforms, registry publication and signing remain unverified/unselected.

## Historical baseline verification

Earlier baselines, retained with their own scope: Rho 15/15 protocol, real stdio
MCP, retained v1, service, crash/continuity, workspace and budget tests, with three
SIGKILL boundaries keeping the original operation/Core identity and one dispatch
after a missing first acknowledgement. Plugin removal/reselection preserves drafts,
undo, bytes, layout references, selection intent and original Core identity without
replay; unavailable providers reject new work while retained requests stay
observable. Plugins passed 12/12 capability and 2/2 native example tests plus a
pure-contract import guard; explicit types preserve `001` and literal `NA`, unkeyed
tables stay readable, and comparisons record both versions and provenance. All eight
capability tarballs pass independent installation/import with no sibling
implementation.

Real flows recorded then: an ordinary R project (linear model, four rows, typed
two-input join, PNG/PDF, original bytes, exported object snapshot) and the original
paired project (five DESeq2 fits, 16,139 genes, 33 baseline artifacts, 121/121
saved-model observations, 12/12 independent checks) through the generic runner. An
actual Claude MCP v2 handoff fetched explicit context and changed the same unsaved
Chinese/emoji buffer without starting a Host. Actual base-R recovery keeps four
partial rows across owned Host loss, turns the original request unknown without
replay, releases the native process group on confirmed cancel and restores bytes,
drafts, undo, selections and unavailable entries without a Host. Actual 0.4 npm
installations outside the checkouts passed for the full eight-plugin candidate and
two reduced candidates containing only Contracts/Documents/Files or
Contracts/Files/R without R/Host.

Retained failed extraction trials exposed checker-wrapper variable collision,
a generic completion sidecar placed inside the producer's immutable inventory,
and an incorrect declared shrinkage column. New trials fixed those conditions;
original failed requests remain failed. Historical scientific failures and the
original installed candidate remain recorded separately.

## Single-contract cleanup verification

The two coexisting protocol artifacts were collapsed on 2026-10-23, before any
release: the earlier version had never been published, so keeping it as a second
dialect charged a released product's compatibility cost against development work.
Shared definitions now live in `protocol-base.ts` carrying no contract identity;
the serve path, validators, envelope and artifacts describe one contract.

Actually run in this checkout: `npm run build` and
`RHO_CORE_BINARY=../Rho-core/target/debug/rho-core node --test test/*.test.mjs`
passed, including retained-operation observation, the repointed service and
workspace tests and the retired-path refusals. A local tarball built with the
explicit `--allow-dirty` development override was inspected: it carries
`protocol/index.json` plus hashed operation files and `fixtures/states.json`, no
retired artifact or fixture directory, and every packaged hash was recomputed.

A later pass removed what the collapse left behind: three operations the base module
still declared in an earlier action vocabulary and its own copy of the
grantable-method enum. Those copies never reached the served contract; comparing
every leaf before and after showed no difference. The enum and description map are
sorted, so the content-addressed artifact depends on the contract, not editing order.

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
holds W1–W5 (inquiry map, live finding composition, editable-spec explainer,
traceback, anchored feedback) and W1a–W5a continuation/error states. Panels map to
Plugins [capability catalog](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PLUGIN-CATALOG.md)
targets, pending user review, with the
[flow index](DESIGN-PRIORITIES.md#w1w5-能力组合动线索引), the
[state index](DESIGN-PRIORITIES.md#w1aw5a-续接与异常状态索引) and the
[version/feedback ledger](DESIGN-PRIORITIES.md#w-系列资源版本与反馈台账). UI entries
are unimplemented; C9 presentation/animation and C10 annotations remain proposals.
Rho owns selection, assembly and routing; a capability label does not establish
registration, installation or product acceptance.

The design keeps distinct: feedback draft, context available but unfetched, a
tool-fetch receipt, observed work and an explicitly linked response. F-12's later
explanation v2 keeps the same sources with no new execution, and old v1 frame
anchors stay on v1. Candidate snapshot s3 needs bounded inspection, owner
field/key/binding validation and explicit switching; it claims no contents,
coverage or checks. Source loss keeps s2 rows and read time, missing charts keep a
table alternative, and spec conflicts keep the draft. Unknown q-0004/run 004
observations keep the original request and partial outputs; cancellation requested,
confirmed native stop and observer closure are separate states. The earlier
["Release 1 · v2 (inquiry)" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-7-0)
(I1–I4) and R1–R14 on the
["Release 1 · npm WebUI" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-5-0)
stay as flow/state reference under that direction. W1–W5/W1a–W4a use 1440-wide
boards and W5a a 1280 × 900 design; those widths do not prove live layout, native
input or accessibility. Designed run numbers and the 8,204-row example are not
substituted for backend evidence.

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
