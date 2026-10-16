# Rho status

Updated: 2026-10-16.

## Application

Version 0.3 splits documents, files, R, requirements, tables, media, charts and
Agent into eight independent npm plugins. Each owns its descriptor, behavior and
entry contracts. Rho selects reviewed versions and injects service ports; a thin
contracts package supplies shared types/schemas/file primitives without capabilities.
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
[plugin split acceptance](PLUGIN-SPLIT-ACCEPTANCE.md) records the new package boundary; [extraction acceptance](EXTRACTION-ACCEPTANCE.md)
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

## Verification

- Rho: 13/13 protocol, real stdio MCP, retained v1, service, crash/continuity,
  workspace and budget tests passed. Three SIGKILL boundaries retain the original
  operation/Core identity and one dispatch after a missing first acknowledgement.
- Plugin removal/reselection preserves drafts, undo, bytes, layout references,
  selection intent and original Core identity without replay. Unavailable providers
  reject new work; retained requests stay observable.
- Plugins: 10/10 capability tests and 2/2 separate native example tests passed.
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
- Actual 0.2 npm installation outside the checkouts passed without bundled
  recipes: no-R startup, bundled Core/installed Plugins, both explicit consumers
  and recovery. The [candidate record](backend-acceptance/v0.2.0.json) freezes
  source, package, lockfile, example inputs and observed resource identities.

Retained failed extraction trials exposed checker-wrapper variable collision,
a generic completion sidecar placed inside the producer's immutable inventory,
and an incorrect declared shrinkage column. New trials fixed those conditions;
original failed requests remain failed. Historical scientific failures and the
original installed v1 candidate remain recorded separately.

## Current focus and remaining work

[PX-01–PX-05](PLUGIN-EXTRACTION.md) have passed their backend scope, including
both installed consumers. The versioned schema/client/fixtures are ready for
independent UI development. This split continues backend/headless work; no UI is implemented.
[The six backend work packages](BACKEND-FIRST.md) retain their original
scope; [first-release tasks](WEBUI-FIRST.md) retain all product gates.

Browser shell/layout and component renderers, native IME/focus/clipboard,
representative widths, accessibility and full product performance/installation
acceptance remain pending. React/TypeScript, Vite, Dockview, CodeMirror 6,
AG Grid Community, ECharts and a typed json-render catalog remain selected UI
choices. Electron and cross-window movement follow later.

## Design evidence and limits

The Paper ["Release 1 · npm WebUI" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-5-0)
contains R1–R14, pending user review, with the
[design index](DESIGN-PRIORITIES.md#r1r14-连续交互索引). All 14 reference-width
screens and notes were reviewed during the design revision; other widths and
live browser behavior remain unverified. Existing S-series pages are historical.
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
