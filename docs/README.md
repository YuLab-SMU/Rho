# Rho documentation

Start with [Status](STATUS.md) for the current implementation and verification.
The previous frontend design documents and plans were withdrawn on 2026-10-25.
[Frontend](FRONTEND.md) describes the rebuilt application and its actual capabilities.

| Document | Purpose |
| --- | --- |
| [Frontend](FRONTEND.md) | Project navigation, workspaces, Agent handoff and browser checks |
| [Architecture](ARCHITECTURE.md) | Source ownership, state and lifecycle boundaries |
| [Technology stack](TECHSTACK.md) | Libraries and runtimes used by the current implementation |
| [Roadmap](ROADMAP.md) | Product direction and remaining delivery scope |
| [Headless backend](HEADLESS.md) | Installation, HTTP/SSE, Agent adapters, persistence and resource budgets |
| [Execution bridge](EXECUTION.md) | Core request identity, exit codes and Host lifetime |
| [Collaboration](COLLABORATION.md) | Conditional compositions, selections, feedback and recovery |
| [Development](DEVELOPMENT.md) | Owner workflow and verification |
| [Release](RELEASE.md) | Source publication and distribution |

The following records retain their historical backend or component scope. They do
not impose layouts, colors or frontend process requirements:

| Record | Scope |
| --- | --- |
| [Backend plan](BACKEND-FIRST.md) | The original headless implementation packages |
| [Backend acceptance](BACKEND-ACCEPTANCE.md) | Selected installed backend composition and limits |
| [Extraction plan](PLUGIN-EXTRACTION.md) | Reusable component extraction |
| [Extraction acceptance](EXTRACTION-ACCEPTANCE.md) | Versioned public APIs and two R consumers |
| [Plugin split acceptance](PLUGIN-SPLIT-ACCEPTANCE.md) | Independent component packages |
| [Plugin boundary acceptance](PLUGIN-BOUNDARY-ACCEPTANCE.md) | Owner contracts and selected dependencies |
| [Collaboration acceptance](COLLABORATION-ACCEPTANCE.md) | Shared state, Agent replies and recovery |
| [Contract acceptance](CONTRACT-ACCEPTANCE.md) | Generated public contract checks |

Repository policies cover [contributions](../CONTRIBUTING.md), [privacy](../PRIVACY.md),
[security](../SECURITY.md) and [artifact trust](../CODE_SIGNING_POLICY.md).
Execution belongs to [Rho-core](https://github.com/YuLab-SMU/Rho-core); functional
component APIs belong to [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins).
