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

Install it with `npm install -g @rho-workspace/rho` on Node 22.22 or later, below 27, start
`rho`, and connect an external Agent with `rho --grant`
([Install and start](docs/HEADLESS.md#install-and-start)). Projects,
files, execution records and workspaces are available through the local WebUI.
The Agent uses the same scoped capabilities; a browser request copied to an external
Agent is explicitly a handoff.

The frontend was reconstructed on 2026-10-25 after withdrawing the earlier design
plans and visual rules. See [Frontend](docs/FRONTEND.md) for the current interface,
[Status](docs/STATUS.md) for executed checks and limits, and the
[documentation index](docs/README.md) for backend and release information.

## Set up with an Agent

A person can ask Claude Code or Codex, in any language:

> Read https://yulab-smu.top/Rho/doc/setup.md and follow its steps to install and configure Rho for me.

or: 请阅读 https://yulab-smu.top/Rho/doc/setup.md 文档，按照步骤为我安装并配置 Rho。

That page is [SETUP.md](SETUP.md). The Agent checks the machine, installs the npm package and
starts Rho on `~/Rho/projects` and `~/Rho/state`. It then installs the Agent Skill in
[skills/rho](skills/rho/SKILL.md) into its own skills folder, connects itself to the example
project and says what is missing. The Skill teaches an Agent to install and connect Rho, call
its tools without guessing, and run an analysis a person can follow. It is published beside the
page at <https://yulab-smu.top/Rho/skills/rho/SKILL.md>.

## Documentation

<https://yulab-smu.top/Rho/> runs the real interface on the shipped example project,
replaying a recorded session without a backend, and gives the sentence above for an Agent.
The documentation is published at <https://yulab-smu.top/Rho/docs/>. The site is
generated from this repository's `docs/` directory, which stays the only source of
truth: every page names the file it came from and links to it.

```sh
npm run docs:dev      # assemble and serve locally
npm run docs:build    # assemble, then build the static site into site/.vitepress/dist
npm run docs:check    # fail if a document in docs/ is neither published nor withheld
npm run pages:build   # front page, demo and documentation into site/.pages (add -- --home for the front page alone)
npm run pages:check   # walk the demo and the front page in a browser
npm run pages:capture # record the demo again from this checkout's service (after npm run build)
```

`@rho-workspace/rho` is published to npm. The registry entry for 0.5.2 carries no
README, so its package page shows no description; from 0.5.3 the packer ships this README.

For a new component view, start with [Plugin authoring](docs/PLUGIN-AUTHORING.md):
generate a typed package, preview it independently and select its compiled entry
through configuration without adding an application adapter.

Contributions follow [Contributing](CONTRIBUTING.md); source is licensed under
[AGPL-3.0](LICENSE).
