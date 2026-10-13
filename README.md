# Rho

Rho is the application container for a component-based intelligent workbench. It
owns component selection, assembly and presentation.
The selected `main` tree contains the new application design and repository policies.
The rebuilt application has no UI, launcher or build entry yet.

| Repository | Current responsibility |
| --- | --- |
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | Generic managed execution, original request identity, retained facts, resident Host and CLI |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) | Actual functional components, with optional CLI, Skills, MCP and UI entries; currently verified R and evaluation consumers |
| Rho (this repository) | Application container, composition, shared interaction and presentation |

The selected design combines the scientific workbench, freely arranged component
views/multiple windows and Agent-driven dynamic interfaces in one user flow.
The implementation direction is Electron, React/TypeScript, Vite and Dockview,
with functional UI owned by plugins. This is a documented selection, not an
accepted running composition. Read [Architecture](docs/ARCHITECTURE.md) and
[Technology stack](docs/TECHSTACK.md).

The new Core CLI has already supported a real R analysis and reusable evaluations.
Those results belong to their component owners; they do not establish a working
new application. See [current state](docs/STATUS.md) and [Rebuild](docs/REBUILD.md).

The complete former application is published on
[`codex/legacy-app-before-rebuild`](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-rebuild).
The complete pre-clear tree, including subsequent design updates, is also on
[`codex/legacy-app-before-main-reset`](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-main-reset).
The former UI, SDK snapshot, development scripts, lock and examples are removed
from the selected tree. Ignored local evidence, caches and user state remain local.

Read [documentation](docs/README.md), [development](docs/DEVELOPMENT.md) and
[source publication](docs/RELEASE.md). The source replacement is merged into
organization `main`. Routine Rho changes now proceed directly on `main`, through
checked commits and ordinary pushes. Source publication, an accepted application
composition and an official signed release are separate outcomes.
