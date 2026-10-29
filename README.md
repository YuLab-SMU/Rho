# Rho

Rho is an application container for an intelligent, composable workspace. People
and Agents use the same functional components to act on real resources, inspect
results and arrange the tools they need.

The first release brings natural-language interaction, code/data/graphics and
arranged views within one browser window into one workflow. It is distributed
through npm and runs as a local service with a WebUI. An Agent can compose interfaces
from registered components while the user continues editing and inspecting the
same resources.

## Architecture

| Repository | Responsibility |
| --- | --- |
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | Optional managed execution, retained execution facts, activity observation and resident Host |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) | Reusable document/code, file/artifact, runtime/object, requirement, table, media/chart and Agent capabilities; optional reusable domain adapters |
| Rho | Component selection and assembly, local service, workspace layout, shared interaction and presentation; native windows in a later client |

Components may expose CLI, Skills, MCP and UI entries as their consumers require.
They retain their implementation, conditions and results across headless and
application use. Agents use native tools normally; Rho connects shared workspace capabilities and
uses Core only for selected managed operations or activity observation.

A specific analysis workflow is project code or an acceptance example, not a
plugin. The [plugin extraction plan](docs/PLUGIN-EXTRACTION.md) applies the
[capability model](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PLUGIN-MODEL.md)
to the backend. Version 0.4 independently packages eight selected capabilities and keeps workflow
actions and recipes outside those packages; an ordinary R project and the original analysis use the same declared
execution, dependency, resource and selection contracts.

## Technology direction

The first release is an npm launcher and local service with a React, TypeScript
and Vite WebUI. The workspace lays out the owners' views in Rho's own tabs and
splits, arranged by the Agent and the person through one conditional layout
contract. Electron is reserved for a later desktop client that reuses the WebUI
and component boundaries. Functional views use CodeMirror 6, AG Grid Community
and ECharts.

Install the packed tarball, start `rho`, and connect an external Agent with
`rho --grant` ([Install and start](docs/HEADLESS.md#install-and-start)). Projects,
files, execution records and workspaces are available through the local WebUI.
The Agent uses the same scoped capabilities; a browser request copied to an external
Agent is explicitly a handoff.

The frontend was reconstructed on 2026-10-25 after withdrawing the earlier design
plans and visual rules. See [Frontend](docs/FRONTEND.md) for the current interface,
[Status](docs/STATUS.md) for executed checks and limits, and the
[documentation index](docs/README.md) for backend and release information.
npm registry publication has not been performed.

For a new component view, start with [Plugin authoring](docs/PLUGIN-AUTHORING.md):
generate a typed package, preview it independently and select its compiled entry
through configuration without adding an application adapter.

Contributions follow [Contributing](CONTRIBUTING.md); source is licensed under
[AGPL-3.0](LICENSE).
