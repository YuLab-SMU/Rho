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
to the backend. Version 0.3 independently packages eight selected capabilities and keeps workflow
actions and recipes outside those packages; an ordinary R project and the original analysis use the same declared
execution, dependency, resource and selection contracts.

## Technology direction

The first-release direction is an npm launcher and local service with React,
TypeScript, Vite and Dockview. Electron is reserved for a later desktop client
that reuses the WebUI and component boundaries. Initial
functional views use CodeMirror 6, AG Grid Community and ECharts. Agent-composed
interfaces use a typed json-render catalog; independent HTML views can use an
isolated MCP Apps host when needed.

The versioned local backend, npm launcher, client and read-only state fixtures are
implemented. [Start the headless service](docs/HEADLESS.md) or inspect its
[extraction acceptance](docs/EXTRACTION-ACCEPTANCE.md). The browser shell and component
views remain to be implemented; backend checks do not establish product release
acceptance. [Status](docs/STATUS.md) records the current evidence and limits.

Start with the [prioritized first-release tasks](docs/WEBUI-FIRST.md),
[Architecture](docs/ARCHITECTURE.md), [Technology stack](docs/TECHSTACK.md)
and [Roadmap](docs/ROADMAP.md). The [documentation index](docs/README.md) covers
product design, development and distribution. Contributions follow
[Contributing](CONTRIBUTING.md); source is licensed under [AGPL-3.0](LICENSE).
