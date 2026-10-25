# Rho implementation stack

The package lock and owner entry inventory identify exact build inputs. This document
records the current combination; it does not prescribe a visual style or future UI
framework. [Architecture](ARCHITECTURE.md) defines source ownership.

| Layer | Current implementation |
| --- | --- |
| Local service and launcher | Node 22.22.x, TypeScript 5.9.3, built-in HTTP, Ajv 8.20.0 |
| Public API | Generated JSON Schema request/response contracts; authenticated JSON and SSE |
| Browser application | React/React DOM 19.3.1, Vite 8.3.4, TypeScript |
| Workspace | Rho renders the owner's conditional composition tree as tabs and splits |
| Documents | Documents owner with a CodeMirror 6 view |
| Tables | Tables owner with AG Grid Community |
| Figures and charts | Original versioned media; Charts owner with ECharts |
| External Agent | Project-scoped MCP adapter and selected external Agent client |
| Managed execution | Public Core CLI and an independently held resident Host |
| Browser automation | Playwright 1.64.1 driving installed Google Chrome |

## Local service and workspace

The browser has no shell, filesystem or Core access of its own. Its client calls
named scoped operations on the local service. Credentials do not enter frontend
assets. Reads and reconnects do not start or recover a Host.

View rendering and local cursor/scroll state stay in the browser; document content,
undo, resource versions and execution facts stay with their owners. Layout writes
use `composition.apply` or `composition.undo`, with the version actually observed.
There is no additional layout persistence model to reconcile.

The installed application is assembled from selected component packages and a
Core artifact. Native R and selected scientific libraries remain external runtime
requirements. A component check does not accept an application combination.

[Frontend](FRONTEND.md) documents navigation and browser checks.
[Headless backend](HEADLESS.md) documents installation and runtime limits.
[Release](RELEASE.md) separates source publication from package distribution.
