# Rho technology stack

This is the implementation direction for the [integrated flow](ROADMAP.md#first-integrated-flow).
[Architecture](ARCHITECTURE.md) defines ownership; [Status](STATUS.md) records
implementation. Exact versions and immutable source/artifact identities are
selected and verified when the application composition is built.

## Main combination

| Layer | Choice | Responsibility |
| --- | --- | --- |
| Desktop container | Electron | Windows, native desktop interaction and a narrow application bridge |
| UI and build | React, TypeScript, Vite | Application assembly and trusted component presentation |
| Workspace layout | Dockview core | Docking, tabs, floating/popout adaptation and layout persistence |
| Editing component | CodeMirror 6 | Document buffers, local versions, undo and write conditions |
| Data component | AG Grid Community | Real rows, filtering and stable entity selection |
| Graphics component | ECharts plus original scientific artifacts | Interactive data/specification and selection mapping, with preserved provenance |
| Agent-composed interface | json-render typed catalog | Registered components, typed properties and scoped action/resource references |
| Managed execution | Public Core CLI and independently held resident Host | Documented execution capabilities and bounded observation |

These are choices for this composition. Functional components can use maintained
R/Python/Rust/TypeScript libraries, native CLIs and ordinary files, and expose the
entries their consumers need. Libraries are not mandatory dependencies of every
component.

## Desktop and workspace

Electron supplies a Chromium baseline with the application, fitting rich editors,
charts, generated interfaces and multiple windows. Its selection is an engineering
judgment for this flow; performance and native-input acceptance require the actual
application. A measured resource/distribution requirement can justify evaluating
Tauri's system-WebView approach. Sources:
[Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model),
[Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/).

Use sandboxed renderers, context isolation and no Node integration. The native
bridge exposes narrow named operations and validates the sender, resource scope
and conditions at invocation. Trusted React views use normal application layout;
independent HTML uses isolated origins and a controlled bridge. WebContentsView
is an option where its native positioning, focus and overlay behavior fits the
actual view. Sources:
[Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds).

Dockview supplies docking, tabs, floating/popout and layout serialization.
Rho adapts popout to real desktop-window ownership and close events. Layout state
stores arrangement; editing buffers, scientific resources and execution facts
retain their owners. Dockview core is MIT; some keyboard docking/navigation,
layout-history and other features are Enterprise. The chosen experience must name
its edition and licensing and provide accessible command-based layout controls.
Source: [Dockview licensing/features](https://dockview.dev/docs/overview/licence/).

## Functional views

CodeMirror 6 is the default for scripts, configuration, prose and embedded editing.
Its state/view model fits a shared logical document with multiple views. The
editing component owns buffer synchronization, undo and write-conflict behavior.
Monaco can serve a selected fuller IDE/diff/language-service need; it does not run
VS Code extensions directly. Language intelligence needs its actual provider and
acceptance. Sources: [CodeMirror API](https://codemirror.net/docs/ref/),
[Monaco README](https://github.com/microsoft/monaco-editor/blob/main/README.md).

AG Grid Community and ECharts provide the initial data/graphics combination.
Components supply actual data, stable domain IDs and explicit selection mapping.
Enterprise pivot, range-selection and integrated-chart features require their
own license/selection. Perspective can be evaluated for a demonstrated richer
pivot/aggregation or streaming-view requirement. Retain native scientific outputs
and checks alongside interactive presentation. Sources:
[AG Grid editions](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/),
[ECharts events/actions](https://echarts.apache.org/handbook/en/concepts/event/),
[Perspective ownership](https://perspective-dev.github.io/react/index.html).

An interactive terminal can use xterm.js backed by a PTY service when needed.
Managed text output initially uses a bounded log view. JupyterLab is a component/
service architecture reference and a reuse option for selected notebook, kernel
or ipywidgets compatibility. Sources: [xterm.js](https://github.com/xtermjs/xterm.js),
[JupyterLab patterns](https://jupyterlab.readthedocs.io/en/stable/developer/patterns.html).

## Agent interfaces

json-render supplies the typed catalog for registered components, properties and
actions mapped to actual React implementations. Agents describe parameter forms,
linked results and comparison workspaces using that vocabulary. Invocation checks
existing authorization, resource freshness and native conditions in addition to
schema validity. Model output does not supply privileged JavaScript or replace
owner-provided values and execution facts.
Source: [json-render catalog](https://json-render.dev/docs/catalog).

Independent interactive HTML can use MCP Apps when a consumer needs that boundary.
Rho will implement the isolated View host, allowed messages/tool bridge, origin/CSP
checks and teardown. Structured/text results remain inspectable when the View is
unavailable. Select and verify interoperable Apps/base-MCP protocol versions;
the SDK alone is not a complete workbench host. Sources:
[MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
[SDK and host API](https://apps.extensions.modelcontextprotocol.io/api/).

| Optional interface | Consumer need |
| --- | --- |
| MCP | External tool/resource clients for the same functional capability |
| AG-UI | Agent/frontend event streaming for the selected Agent backend |
| A2UI | Declarative interface interchange across clients |
| Agent Plugins | Portable Skills/MCP packaging, with namespaced Rho-specific contributions where needed |

Each adapter retains the actual state owner and invocation conditions. Protocol
selection follows the concrete consumer rather than becoming a requirement for
every component. Sources: [AG-UI](https://docs.ag-ui.com/introduction),
[A2UI](https://a2ui.org/), [Agent Plugins](https://agent-plugins.org/specification).

## Execution and acceptance

Use the documented [public Core CLI](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/HOST-CLI.md)
at the selected version. Its resident Host has a lifetime independent of observing
windows. Rho owns the application side of this boundary, namely request identity,
exit-code handling and Host lifetime, specified in the
[execution bridge](EXECUTION.md). Reconnect retains the original request identity;
reads are bounded and
do not start or recover a runtime. Native tools retain the Host's OS authority;
UI isolation does not establish native containment.

The [roadmap](ROADMAP.md) defines acceptance of the workbench, component composition
and Agent interaction together. Measure actual cold start, interaction latency,
memory and protected view/data/message resources. Record configuration and behavior
when limits are exceeded, preserving obtained output and original task identity.

The accepted application combination records versions, immutable identities,
licenses, local overrides and observed integration results. Official distribution
uses the separate [release boundary](RELEASE.md#official-distribution).
