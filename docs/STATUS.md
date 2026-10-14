# Rho status

Updated: 2026-10-14.

## Application

Rho's product, architecture, technology direction and development policies are
specified. The application container, functional UI assembly and first release
build are not implemented. No integrated usability, performance or distribution
acceptance has been completed.

First release uses npm distribution with local WebUI: browser → local service →
Rho-core CLI → R/components. Desktop client deferred to later milestone. The
selected stack is React/TypeScript, Vite and Dockview. Initial editing, data and
graphics views use CodeMirror 6, AG Grid Community and ECharts. Agent-composed
interfaces use a typed json-render catalog; independent HTML views can use
isolated MCP Apps. Dependency versions and composition identities will be
recorded when implementation selects the actual artifacts.

## Available foundation and components

[Rho-core](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/PROGRESS.md)
provides managed execution, original request identity, retained facts, a resident
Host and public CLI. Rho uses those declared capabilities at the selected version.

[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/STATUS.md)
provides an Agent evaluation component and a real R analysis recipe. Their
component acceptance records contain actual executions, checks, failures and
limits. Application integration is pending; component results do not establish
a running Rho composition.

## Next delivery

Implement first release as defined in [WebUI-first roadmap](WEBUI-FIRST.md):
npm-distributed local WebUI with browser-based workbench. P0 requirements are
first-use flow, Agent integration, human-Agent collaborative editing, working
code/table/chart components with real R execution, and run center with failure
recovery. Multi-view layout and Agent-composed interfaces (P1), then npm
installation acceptance complete the first release.

Action, Resource, Selection and View are design concepts. Public schemas, component
host adapters and application state services remain to be implemented for this
flow. The application side of the Core boundary is specified in the
[execution bridge](EXECUTION.md). Component host adapters and the UI components
belong to their source owners. Native resource conditions and results retain their
functional owner.

## Verification

Local links and anchors across the three repositories and rendered inspection of
every changed page have been checked for this revision. The execution bridge also
distinguishes application-started Hosts from existing Hosts whose lifecycle stays
with their original owner. Application behavior, native input, component composition,
signing and installation require evidence from their actual implementations. Core
and component checks retain the scope recorded by those owners; they are not rerun
solely to rewrite application documents.

First release uses npm distribution; browser refresh and service lifecycle handling
require explicit verification. Desktop client features (native menus, cross-window
movement, system integration, signing) deferred to later milestone.
