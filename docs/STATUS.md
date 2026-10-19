# Rho status

Updated: 2026-10-19.

## U2 backend prerequisites

Documents mutation receipts/revision, interrupted-save retention and explicit
live-document bindings are implemented; Rho 38/38 and Plugins 23/23 tests pass.
[The frontend handoff](U2-BACKEND-HANDOFF.md) defines input/recovery requirements.
No UI was built; browser grants retain U1 scope. Await frontend delivery before
CodeMirror/Tables integration or browser editing acceptance.

## U1 browser shell candidate

The scoped browser shell is implemented against accepted headless 0.4: one-time
Agent-opened links, same-origin static assets, tab session credentials, typed Fetch
SDK, real project/capability state and unavailable retained views. Observation
resumes after refresh, disconnection and same-port service restart, without native
execution. The UI contribution entry is `0.1-draft`, not protocol v1.
[Browser UI](UI.md) separates U1 from the unimplemented U2-U4 collaboration loop.

Source checks: 36 Rho tests pass, including nine browser/security tests. Real
Chrome 155.0.8059.84 checks pass at 1600/1280/1024/768/390 widths, with zero Host-start
and native-submit attempts. Screenshot inspection covers the compact shell,
context and navigation drawers, command focus and unavailable views. Chrome 154,
owner editor input/IME/clipboard and full accessibility/product acceptance are
not claimed. Fixed full and Documents/Files-minimal tarballs also pass the same
browser flow outside the checkouts, with physically omitted unselected owners.
[U1 installed checks](UI-ACCEPTANCE.md) freeze sources/assets and remaining gates;
the separate installed native regression preserves unknown/partial outcomes.

The user selected Paper's Rho experience V0.1 instead of Main app / Composable
shell. The limited U1 adaptation is on that page for review; implementation and
internal inspection do not substitute for the user's design acceptance.

U1 alignment batch 1 adopts the U1 spec board's tokens, control geometry and
1280/1024/768 breakpoints. Source `test:ui` now also checks 768 and asserts
400/600 weights and the accent primary button; installed tarballs were not
rebuilt. Batches 2 to 7b below cover copy, structure and narrow layouts; see
[batch 1 evidence](UI-ACCEPTANCE.md#u1-alignment-batch-1-appearance).

People no longer type a pairing code; the user rejected that.

- The Agent runs `rho --open`, or `rho --pair FILE --open` for another tab.
  Either opens a one-time `#pair=` link. The page redeems the code and removes
  it from the address bar; a reused link is refused.
- Batch 2 removes the wordmark from the shell and adds location text with a
  Read-only chip.
- The status reads Up to date, Offline or Connecting, with the read time.
- Rail highlighting follows the boards.
- The context panel has Connection, This tab and Agents sections.
- Commands are grouped.
- "Disconnect this tab" asks for confirmation; Escape cancels and returns focus.

`npm test` passes 36/36. `test:ui` passes at five widths with 0 / 0 native
attempts. Only macOS `open` is checked, through a stub. See
[batch 2 evidence](UI-ACCEPTANCE.md#u1-alignment-batch-2-toolbar-rail-and-agent-opened-tabs).

Batch 3 rebuilds the home from U1-02, U1-03 and U1-03b. It adds Welcome titles,
rows with location and added time (full time in a tooltip) and New project /
Open folder sheets. The sheets keep focus inside and give every refusal a next
action. The service adds a `~/` folder label and reports an existing folder as
`conflict`. The boards now say "Added", because the service records when a
project was added, not when it was last opened. On the staged tree `npm test`
passes 36/36 and `test:ui` passes at five widths with 0 / 0 native attempts.
See [batch 3 evidence](UI-ACCEPTANCE.md#u1-alignment-batch-3-home).

Batch 4 follows U1-04 and U1-05 inside a project. The sidebar lists Overview,
Layouts with view counts and Content; retained operations appear only when
there are some. The overview says "No saved layout yet" or lists layouts, then
documents and files as tables. Layout views are Dockview tabs. An unavailable
view says what it shows, needs and lacks, offers About with a way back, and
keeps identifiers in View reference; the main area has no JSON. On the staged
tree `npm test` passes 36/36 and `test:ui` passes at five widths with 0 / 0
native attempts. See [batch 4 evidence](UI-ACCEPTANCE.md#u1-alignment-batch-4-inside-a-project).

Batch 5 follows U1-07 and U1-08 for disconnection and commands. When Rho can't
be reached, a notice keeps what was already read and says when. Reconnect only
reads again, is disabled while it runs, and the last failure is under Context &
access. The command palette filters commands in four groups; Show and Hide follow
the current state, and typed questions run nothing. On the staged tree
`npm test` passes 36/36 and `test:ui` passes at five widths with 0 / 0 native
attempts. See [batch 5 evidence](UI-ACCEPTANCE.md#u1-alignment-batch-5-disconnect-and-commands).

Batch 6 follows U1-09a to U1-09c below 768. The rail and sidebar give way to a
navigation drawer, context opens as a bottom sheet with Done, and both keep
focus inside and return it. The toolbar is 48 high with 36-pixel targets and
two lines of location. Views are tabs instead of a select. On the staged tree
`npm test` passes 36/36 and `test:ui` passes with 0 / 0 native attempts. See
[batch 6 evidence](UI-ACCEPTANCE.md#u1-alignment-batch-6-narrow-widths).

Batch 7a follows U1-06c for plugin states. A usable plugin shows no state; one
that can't be used gives the first reason and who can change it, and plugins
outside this installation are listed last. No Capabilities wording, state flags
or method names appear. Focus now returns to the plugin card in the same update;
the plugin page check had been failing on that. On the staged tree `npm test`
passes 36/36, and `test:ui` and `test:ui:plugins` pass with 0 / 0 native
attempts. See [batch 7a evidence](UI-ACCEPTANCE.md#u1-alignment-batch-7a-plugin-naming-and-states).

Batch 7b follows U1-06, U1-06b and U1-06d with copy from plugin descriptors.
Plugins has its own sidebar. A plugin's page shows prompts to copy, what Claude
Code can do with it, its views and Information, including whether the open
project uses it. The toolbar's Plugins returns to the catalog. Its original
metadata gaps are covered by the catalog completion below.
On the staged tree `npm test` passes 36/36, and `test:ui` and
`test:ui:plugins` pass with 0 / 0 native attempts. All seven alignment batches
are implemented; user design acceptance is pending. See
[batch 7b evidence](UI-ACCEPTANCE.md#u1-alignment-batch-7b-plugin-catalog-and-detail).

The remaining U1 catalog fields now come from the nine owner descriptors: icons,
body text, Skills, entry descriptions, developer/license/links and dependency
purposes. Descriptor ordering matches Paper. Missing selected Rscript is observed
without execution, with exported object reads preserved. A frozen descriptive
inventory supplies introductions in reduced installations without loading owners
or granting access. Source checks pass: Rho 36/36, browser/security 9/9 and the
plugin browser flow at all five widths with zero Host starts/native submissions.
Fixed Full and Documents/Files tarballs pass outside-checkout installation and
all nine plugin pages, including seven physically absent owners in the minimal
package. Installed Full also passes the U1 shell flow, with browser attempts 0/0.
User design acceptance is still pending. See [completion evidence](UI-ACCEPTANCE.md#catalog-completion-and-rebuilt-packages-2026-10-18).

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
snapshot/event transport and scoped bootstrap. Durable browser write intents,
conditional layout writes and all five functional component renderers remain
U2-U4 work; the U1 registry selects no owner renderer.
[The six backend work packages](BACKEND-FIRST.md) retain their original
scope; [first-release tasks](WEBUI-FIRST.md) retain all product gates.

Conditional workspace layout and component renderers, native editor
IME/focus/clipboard, full accessibility and product performance/installation
acceptance remain pending. U1 shell widths/command focus are separately checked;
they do not accept the editor, grid or Agent collaboration loop. React/TypeScript, Vite, Dockview, CodeMirror 6,
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
