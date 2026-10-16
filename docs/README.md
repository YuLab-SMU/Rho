# Rho documentation

Rho's documentation defines the application container, its functional components
and the user flow they deliver together. [Status](STATUS.md) is the current
implementation and verification summary.

| Document | Purpose |
| --- | --- |
| [First-release tasks](WEBUI-FIRST.md) | Prioritized npm + local WebUI backlog, Agent connection, human-Agent flows, dependencies and release gates |
| [Backend implementation plan](BACKEND-FIRST.md) | Six backend work packages and the contract for independent UI development |
| [Reusable plugin extraction](PLUGIN-EXTRACTION.md) | Capability/workflow boundary, current source coupling, owner changes, compatibility and new gates before plugin UI acceptance |
| [Headless backend](HEADLESS.md) | Installation, versioned HTTP/SSE client, Agent adapter, persistence and budgets |
| [Backend acceptance](BACKEND-ACCEPTANCE.md) | Actual component/integration evidence, selected composition, failures and unsupported scope |
| [Design priorities](DESIGN-PRIORITIES.md) | Required interaction designs, Paper review scope and design acceptance |
| [Architecture](ARCHITECTURE.md) | Source ownership, component interaction, state and lifecycle boundaries |
| [Technology stack](TECHSTACK.md) | Selected libraries, integration choices and adoption conditions |
| [Product design](DESIGN.md) | Workspace behavior, Agent interfaces and usability acceptance |
| [Roadmap](ROADMAP.md) | First integrated flow, completion criteria and subsequent milestones |
| [Development](DEVELOPMENT.md) | Owner workflow, checks and composition evidence |
| [Status](STATUS.md) | Implemented capabilities, pending work and verification limits |
| [Execution bridge](EXECUTION.md) | Application side of the Core boundary: request identity, exit codes and Host lifetime |
| [Release](RELEASE.md) | Source publication and official distribution |

Repository policies cover [contributions](../CONTRIBUTING.md),
[privacy](../PRIVACY.md), [security](../SECURITY.md) and
[artifact trust](../CODE_SIGNING_POLICY.md).

Execution documentation belongs to [Rho-core](https://github.com/YuLab-SMU/Rho-core).
Functional component documentation belongs to
[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins).
