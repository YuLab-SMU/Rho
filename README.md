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
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) | Functional components: Agents, editors, files, tables, plots, scientific methods, evaluation and other capabilities |
| Rho | Component selection and assembly, local service, workspace layout, shared interaction and presentation; native windows in a later client |

Components may expose CLI, Skills, MCP and UI entries as their consumers require.
They retain their implementation, conditions and results across headless and
application use. Rho connects those components to the Core's public capabilities.

## Technology direction

The first-release direction is an npm launcher and local service with React,
TypeScript, Vite and Dockview. Electron is reserved for a later desktop client
that reuses the WebUI and component boundaries. Initial
functional views use CodeMirror 6, AG Grid Community and ECharts. Agent-composed
interfaces use a typed json-render catalog; independent HTML views can use an
isolated MCP Apps host when needed.

The repository currently contains design and development policies. Application
implementation and integrated acceptance are pending. Component capabilities and
verification belong to their respective source owners; see [Status](docs/STATUS.md).

Start with the [prioritized first-release tasks](docs/WEBUI-FIRST.md),
[Architecture](docs/ARCHITECTURE.md), [Technology stack](docs/TECHSTACK.md)
and [Roadmap](docs/ROADMAP.md). The [documentation index](docs/README.md) covers
product design, development and distribution. Contributions follow
[Contributing](CONTRIBUTING.md); source is licensed under [AGPL-3.0](LICENSE).
