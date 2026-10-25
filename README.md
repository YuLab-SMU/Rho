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
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | Intelligent-system foundation: managed execution, request identity, retained execution facts and resident Host |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) | Reusable document/code, file/artifact, runtime/object, requirement, table, media/chart and Agent capabilities; optional reusable domain adapters |
| Rho | Component selection and assembly, local service, workspace layout, shared interaction and presentation; native windows in a later client |

Components may expose CLI, Skills, MCP and UI entries as their consumers require.
They retain their implementation, conditions and results across headless and
application use. Rho connects those components to the Core's public capabilities.

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

Install the packed tarball, start `rho`, and connect Claude Code with
`rho --grant` ([Install and start](docs/HEADLESS.md#install-and-start)). A task in
natural language becomes a run the person reviews and starts; its outputs open
from the run, a question about a table row goes back to the Agent, and a run
exports as ordinary files with its provenance. The
[W7 acceptance](docs/W7-ACCEPTANCE.md) records that path with real Claude Code
from an installed package; npm registry publication is not done yet.
[Status](docs/STATUS.md) records the current evidence and limits.

Start with the [prioritized first-release tasks](docs/WEBUI-FIRST.md),
[Architecture](docs/ARCHITECTURE.md), [Technology stack](docs/TECHSTACK.md)
and [Roadmap](docs/ROADMAP.md). The [documentation index](docs/README.md) covers
product design, development and distribution. Contributions follow
[Contributing](CONTRIBUTING.md); source is licensed under [AGPL-3.0](LICENSE).
