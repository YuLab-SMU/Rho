# Rho technology stack

This is the implementation direction for the npm-distributed local WebUI and its
[integrated flow](ROADMAP.md#first-integrated-flow).
[Architecture](ARCHITECTURE.md) defines ownership; [Status](STATUS.md) records
implementation. The headless slice locks Node 22.22.x, TypeScript 5.9.3, Ajv
8.20.0, MCP SDK 1.29.0 and csv-parse 7.0.3. [Backend acceptance](BACKEND-ACCEPTANCE.md)
records its native dependencies and immutable selected composition. UI library
versions remain to be selected with the browser implementation.

## Main combination

| Layer | Choice | Responsibility |
| --- | --- | --- |
| Distribution and launcher | npm package and CLI | `@rho-workspace/local` 0.4.0, Node >=22.22.0 <23; assembled local tarball bundles the selected Core binary |
| Local application service | Node.js/TypeScript, built-in HTTP, Ajv 8.20.0; versioned JSON and SSE | Authenticated browser/application boundary, scoped component routing, bounded observation and Core CLI access |
| UI and build | React, TypeScript, Vite | Application assembly and trusted component presentation |
| Workspace layout | Dockview core | Docking, tabs, split views and layout persistence within one browser window |
| Editing component | Headless document service; CodeMirror 6 view | The service owns content, versions, undo and write conditions; the view adapts editing and input |
| Data component | AG Grid Community | Real rows, filtering and stable entity selection |
| Graphics component | ECharts plus original scientific artifacts | Interactive data/specification and selection mapping, with preserved provenance |
| Agent-composed interface | json-render typed catalog | Registered components, typed properties and scoped action/resource references |
| Managed execution | Public Core CLI and independently held resident Host | Documented execution capabilities and bounded observation |

These are choices for this composition. Functional components can use maintained
R/Python/Rust/TypeScript libraries, native CLIs and ordinary files, and expose the
entries their consumers need. Libraries are not mandatory dependencies of every
component.

## Local service and workspace

The first-release path is browser WebUI → local Rho service → public Core CLI →
R and functional components. Rho owns the launcher, local service and workspace
assembly; Core owns managed execution and its resident Host; Rho-plugins owns the
functional components, native conditions and results. The service can provide or
locate selected compatible Core artifacts and report missing R/component
dependencies. The implemented [headless package](HEADLESS.md) targets macOS arm64,
uses built-in Node HTTP, private bearer descriptors and project-scoped credentials,
and assembles a local installable tarball with a digest-checked Core binary.
Other platforms, the browser shell and a registry publication channel remain open.

Bind the first-release service to loopback and authenticate its local sessions;
loopback binding alone does not grant authorization. Validate browser origins,
caller/project visibility, resource containment and native conditions at each
operation. The browser uses narrow named operations through the service and does
not invoke a shell, Core CLI or arbitrary filesystem access directly. Credentials
stay out of frontend assets and diagnostics. Implement versioned HTTP JSON and SSE
under the [backend plan](BACKEND-FIRST.md). The implemented service checks exact
Host/Origin, authenticated project/method scope and symlink-free containment;
HTTP tests exercise unauthorized origins and credentials.
LAN/remote exposure needs separate scope and
acceptance.

Dockview supplies docking, tabs, splits and layout serialization for the initial
single-window workspace. Layout state stores arrangement; editing buffers,
scientific resources and execution facts retain their owners. Browser refresh and
view closure release observation; they do not stop the local service or Host.
Dockview core is MIT; some keyboard docking/navigation,
layout-history and other features are Enterprise. The chosen experience must name
its edition and licensing and provide accessible command-based layout controls.
Source: [Dockview licensing/features](https://dockview.dev/docs/overview/licence/).

## Later desktop client

Electron remains the selected direction for a later desktop client that reuses the
WebUI components and adds native windows, menus and system integration. Native
cross-window movement, desktop packaging and signing are outside first-release
acceptance. A desktop bridge must validate sender, scope and conditions, with
sandboxed renderers, context isolation and no Node integration. Desktop-specific
focus, input, lifecycle and performance need their own actual-client evidence.
Sources: [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model),
[Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

## Functional views

CodeMirror 6 is the default view for scripts, configuration, prose and embedded
editing. The editing component's headless document service owns one logical buffer,
undo and write-conflict behavior; CodeMirror views adapt input and transactions to
that service without creating another content owner. This boundary allows backend
implementation and acceptance before the editor UI.
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

The first release selects one reference Agent integration and the adapters that
its actual consumer flow needs. Independent interactive HTML can use MCP Apps
when that boundary is needed, in the first release or a later milestone. Such an
adapter requires an isolated View host, allowed messages/tool bridge, origin/CSP
checks and teardown. Structured/text results remain inspectable when the View is
unavailable. Select and verify interoperable Apps/base-MCP protocol versions for
that adapter; the SDK alone is not a complete workbench host. Sources:
[MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
[SDK and host API](https://apps.extensions.modelcontextprotocol.io/api/).

| Optional interface | Consumer need |
| --- | --- |
| MCP | External tool/resource clients for the same functional capability |
| AG-UI | Agent/frontend event streaming for the selected Agent backend |
| A2UI | Declarative interface interchange across clients |
| Agent Plugins | Portable Skills/MCP packaging, with namespaced Rho-specific contributions where needed |

Each adapter retains the actual state owner and invocation conditions. Protocol
selection follows the reference Agent and concrete consumer; implementing every
listed protocol is not a first-release gate. Sources: [AG-UI](https://docs.ag-ui.com/introduction),
[A2UI](https://a2ui.org/), [Agent Plugins](https://agent-plugins.org/specification).

## Execution and acceptance

Use the documented [public Core CLI](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/HOST-CLI.md)
at the selected version. The local Rho service invokes it; the browser does not.
Its resident Host has a lifetime independent of observing browser views. Rho owns
the application side of this boundary, namely request identity,
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
licenses, local overrides and observed integration results. First-release npm
installation and local WebUI startup require their own evidence. A later official
signed distribution uses the separate
[release boundary](RELEASE.md#official-distribution).
