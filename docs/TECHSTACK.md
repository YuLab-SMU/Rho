# Rho technology direction and joint acceptance

Selected: 2026-10-13, after the user clarified the three owners and requested that
the workbench, freely composed components/multiple windows and Agent interfaces
evolve together. This records the direction for implementation. No dependencies
are installed or pinned here, and no running application composition is accepted.
[Status](STATUS.md) records actual evidence; [Architecture](ARCHITECTURE.md)
defines ownership and shared interaction semantics.

## Selected main combination

| Position | Direction | Responsibility and limit |
| --- | --- | --- |
| Desktop container | Electron | Rho owns windows, desktop interaction and a narrow native bridge |
| UI and build | React, TypeScript, Vite | Rho assembles the workbench; actual feature components remain plugin-owned |
| Layout | Dockview core | Rho owns docking, tabs, floating/popout adaptation and layout persistence |
| Editing component | CodeMirror 6 | Plugin owns document buffers, local versions, undo and file-write conditions |
| Data component | AG Grid Community | Plugin provides real rows, stable entity IDs, filtering and selection |
| Graphics component | ECharts and original scientific artifacts | Plugin supplies data/specification and selection mapping; native plots retain provenance |
| Agent-generated interface | json-render with a typed component/action catalog | Agent proposes validated compositions bound to existing resources/actions |
| Independent HTML component | MCP Apps, when selected | Rho implements an isolated View host and permits only scoped bridge operations |
| Functional implementation | Maintained R/Python/Rust/TypeScript libraries or CLIs | Actual owner retains native semantics, conditions and result checking |
| Managed execution adapter | Existing public Core CLI and independently held resident Host | Rho connects supported capabilities; no private socket protocol or new Core model loop |

These are implementation choices for the first flow, not required dependencies
of every plugin. Record exact versions, immutable source/artifact identities,
third-party origin/licenses and actual acceptance when a composition is built.

## Desktop choice

Electron provides a Chromium baseline shipped with the app and a mature web UI
environment. This is the preferred tradeoff for rich editors, charts, generated
interfaces and multiple windows. Tauri 2 is a valid alternative if a measured
resource/distribution budget justifies its different system-WebView compatibility
matrix. Rust Core alone does not decide the container; both can use its public
capabilities. This is an engineering judgment, not a Rho performance benchmark.
Sources: [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
and [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/).

Keep the renderer sandboxed, with context isolation and no Node integration.
Expose narrow named operations, validate the sender and route them through the
actual operation boundary. Prefer React/DOM views for deeply integrated trusted
components. Independently supplied HTML needs an isolated origin and controlled
bridge. Electron WebContentsView is an option for an appropriate independent view,
but its native positioning/focus/overlay lifecycle is not free docking support;
do not allocate one for every small panel. UI isolation does not sandbox the OS
authority of native R/Python/other executables.
Sources: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
and [web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds).

Do not embed the sole Core Host in a UI process whose shutdown ends held tasks.
Continued operation requires an independently held resident Host and explicit
application/Host exit behavior. A panel close releases observation, not execution.
Missing acknowledgements and reconnect use the original request identity. Reading
historical artifacts or unavailable tasks must not silently start or recover a
runtime. Sources: [public Core CLI](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/HOST-CLI.md)
and [Architecture](ARCHITECTURE.md#state-and-lifecycle-ownership).

## Workbench components

Dockview core supplies docking, tabs, floating/popout and layout serialization.
Its layout JSON does not save editing buffers, scientific resources or task facts.
Browser popout must be adapted to actual desktop-window ownership and close events.
Dockview core is MIT; some keyboard docking/navigation, layout-history and other features
are Enterprise. Provide equivalent command-menu access or evaluate licensing for
the selected experience; do not rely only on dragging.
Source: [Dockview licensing and features](https://dockview.dev/docs/overview/licence/).

CodeMirror 6 is the default for scripts, configuration, prose and embedded editing.
Its state/view separation fits a plugin-owned logical document with several views.
Monaco is the alternative when the selected first flow needs a fuller IDE/diff/
multi-file language-service experience. Monaco does not run VS Code extensions
directly, and syntax highlighting alone is not R/Python semantic intelligence.
Sources: [CodeMirror API](https://codemirror.net/docs/ref/)
and [Monaco README](https://github.com/microsoft/monaco-editor/blob/main/README.md).

AG Grid Community and ECharts are the initial table/graphic combination. Use real
owner-provided data and stable domain IDs to synchronize selections. Do not copy
Enterprise pivot, range-selection or integrated-chart assumptions into Community.
If a real consumer needs richer pivot/aggregation or streaming multi-view analysis,
evaluate Perspective for that role rather than duplicate two analysis engines.
Retain original R outputs and checks alongside interactive presentation.
Sources: [AG Grid editions](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/),
[ECharts events/actions](https://echarts.apache.org/handbook/en/concepts/event/)
and [Perspective table/view ownership](https://perspective-dev.github.io/react/index.html).

xterm.js is optional for an actual interactive terminal backed by a PTY service;
it is not an executor. Ordinary managed output uses a bounded log view first.
Source: [xterm.js](https://github.com/xtermjs/xterm.js).

JupyterLab/Lumino is a useful component/service architecture precedent. Consider
whole-platform reuse when notebook, kernel, ipywidgets or Jupyter file-service
compatibility is selected; docking alone does not require adopting that platform.
Prebuilt dynamic loading is not a permission/fault-isolation mechanism.
Source: [JupyterLab extension patterns](https://jupyterlab.readthedocs.io/en/stable/developer/patterns.html).

## Agent interfaces and external interoperability

Start with trusted React components and a small registered catalog. json-render
can describe available components, typed properties and actions, and map them to
actual React implementations. An Agent can compose parameter forms, linked result
views and comparison workspaces from that vocabulary. Scope/resource freshness
and native conditions are checked at invocation, not inferred from schema validity.
Models do not supply privileged JavaScript. Generated content does not substitute
for owner-provided scientific values or execution facts.
Source: [json-render catalog](https://json-render.dev/docs/catalog).

MCP Apps is the optional boundary for independently supplied interactive HTML.
Implement the sandboxed View, allowed message/tool bridge, origin/CSP checks and
teardown. Its SDK is not a complete supported workbench host. Text or structured
results remain usable when a View is unavailable. The Apps UI protocol and base
MCP protocol have separate versions; select an interoperable, verified pair.
Sources: [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
and [SDK/host boundary](https://apps.extensions.modelcontextprotocol.io/api/).

| Optional boundary | Purpose and adoption condition |
| --- | --- |
| MCP | Component tools/resources for a selected external Agent/client; same capability implementation |
| AG-UI | Streaming Agent/frontend interaction when the chosen backend needs a standard adapter; not Core's task journal |
| A2UI | Declarative interface interoperability across clients when needed; the internal catalog remains component-owned |
| Agent Plugins | Portable Skills/MCP packaging for selected consumers; Rho execution/UI contributions belong in an appropriate reverse-domain extension namespace |

None is a required entry for every functional component or a reason to add a
second execution/state owner. The first flow does not require a universal loader,
marketplace, Rust dynamic ABI, Module Federation or new WASM scientific runtime.
Sources: [AG-UI](https://docs.ag-ui.com/introduction), [A2UI](https://a2ui.org/)
and [Agent Plugins specification](https://agent-plugins.org/specification).

## Joint acceptance flow

Use a disposable project and an owned Host. Reuse the verified real-R consumer
and outputs where valid; do not refit science merely to check unchanged documents
or presentation. Implement one selected boundary at a time while retaining this
end-to-end acceptance target; do not claim intermediate component checks prove it.

1. An authorized natural-language request selects a real component action and
   opens a typed parameter interface. UI/tool/CLI entries use the same capability;
   a managed submission carries the original request identity.
2. Script, real result table and interactive plot share resource provenance and
   stable selected entities. Sorting/filtering, missing values and numerical
   representation do not silently change scientific identity or interpretation.
3. Native Chinese IME editing, undo, clipboard and focus work while views are
   docked, switched and moved to another window. Unsaved buffers remain with one
   document owner; external changes produce an explicit write conflict.
4. Close or crash an observer window, then observe the original task from another
   view. Verify no additional native dispatch, and retain partial/unknown results.
   Host shutdown and native-session recovery are separate tested claims.
5. Display execution completion, artifact integrity and domain checks separately,
   with their scope/freshness. An Agent explanation is visibly distinct from the
   source owner's result. Component upgrade/missing View retains inspection of
   the original run, component version and available outputs.
6. The Agent composes a new comparison/explanation view from registered components
   bound to the same resources/selections. Malformed, stale or out-of-scope requests
   are rejected mechanically without adding another approval for existing scope.
7. Keyboard access and layout commands work; assistive text/table alternatives
   exist for graphics. Missing components or blocked popout retain drafts/results
   and provide a recoverable view state without executing again.

Measure cold start, interaction latency and steady/peak memory with representative
data and platform builds. Name each protected resource, configured limit and
exceeded-limit behavior: view/message counts and retained bytes, paged data size,
drawing work or component concurrency. Send references and bounded pages rather
than whole scientific objects across windows. Exhaustion affects the owned view/
component resource, preserves obtained output and does not silently stop a user
Host or replay a task. No performance, native-input or isolation pass is claimed
until observed on the actual composition.

After this flow, add a second functional domain to test reuse of the small boundary.
Add independent publishing/interoperability only for an actual selected component
requirement. Official signing/distribution remains the separate
[release milestone](RELEASE.md#future-official-release-boundary).
