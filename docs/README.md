# Rho documentation

Rho's documentation defines the application container, its functional components
and the user flow they deliver together. [Status](STATUS.md) is the current
implementation and verification summary.

| Document | Purpose |
| --- | --- |
| [成绩平均值教学案例交接](TEACHING-CASE-HANDOFF.md) | Original Paper journey, fixed teaching data, reusable capabilities, frontend/backend gaps and pending acceptance |
| [Browser UI implementation](UI.md) | U1 Agent-opened tabs, scoped SDK/shell, contribution draft, four-stage gates and browser checks |
| [U1 installed browser checks](UI-ACCEPTANCE.md) | Fixed full/minimal npm candidates, zero-native browser scenarios, design/Chrome baseline limits |
| [U1 design alignment plan](U1-ALIGNMENT.md) | Gaps between `web/` and the Paper U1 boards, seven batches, blockers |
| [Collaboration acceptance](COLLABORATION-ACCEPTANCE.md) | Fixed installed compositions, real Agent replies, zero-native collaboration, recovery and separate native checks |
| [Headless collaboration](COLLABORATION.md) | Conditional composition/protection, scoped selection, owner-anchored feedback, Skills/MCP and format-3 recovery |
| [Plugin interfaces and UI handoff](PLUGIN-UI-HANDOFF.md) | Eight owner APIs, HTTP consumers, five unavailable component entries and remaining browser/backend capabilities |
| [First-release tasks](WEBUI-FIRST.md) | Prioritized npm + local WebUI backlog, Agent connection, human-Agent flows, dependencies and release gates |
| [Plugin boundary review](PLUGIN-BOUNDARY-ACCEPTANCE.md) | Owner schemas, action-level dependencies, generic Contracts and three installed compositions |
| [Plugin split acceptance](PLUGIN-SPLIT-ACCEPTANCE.md) | Eight independent packages, selective assembly and backend verification |
| [Backend implementation plan](BACKEND-FIRST.md) | Six backend work packages and the contract for independent UI development |
| [Reusable plugin extraction](PLUGIN-EXTRACTION.md) | Capability/workflow boundary, current source coupling, owner changes, compatibility and new gates before plugin UI acceptance |
| [Headless backend](HEADLESS.md) | Installation, versioned HTTP/SSE client, Agent adapter, persistence and budgets |
| [Installed native grades acceptance](HEADLESS.md#installed-native-grades-acceptance-phase-5) | Two real business/presentation pairs, immutable offline candidate, original feedback recovery, calls/tokens/latency and AC01–AC21 evidence |
| [Backend acceptance](BACKEND-ACCEPTANCE.md) | Actual component/integration evidence, selected composition, failures and unsupported scope |
| [Extraction acceptance](EXTRACTION-ACCEPTANCE.md) | v2 reusable backend, two explicit R projects, compatibility, failures and actual npm installation |
| [Agent 行为账本](AGENT-LEDGER.md) | What facts Rho has about the Agent's behavior, what it has none of, and the five projections that follow |
| [交互模型](INTERACTION-MODEL.md) | Draft: how person and Agent jointly drive the screen, attention rules and the six primitives |
| [交互模型实施计划](INTERACTION-PLAN.md) | Invariants that keep each step consistent, eight phases S0–S7 with owners and completion criteria, open decisions, the gate before high-fidelity design |
| [Design priorities](DESIGN-PRIORITIES.md) | Required interaction designs, Paper review scope and design acceptance |
| [Architecture](ARCHITECTURE.md) | Source ownership, component interaction, state and lifecycle boundaries |
| [Technology stack](TECHSTACK.md) | Selected libraries, integration choices and adoption conditions |
| [Product design](DESIGN.md) | Workspace behavior, Agent interfaces and usability acceptance |
| [Roadmap](ROADMAP.md) | First integrated flow, completion criteria and subsequent milestones |
| [Development](DEVELOPMENT.md) | Owner workflow, checks and composition evidence |
| [Upgrade plan](UPGRADE-PLAN.md) | Observed defects, the mechanisms that hid them, and the phased work that closes the loop |
| [Unverified and dead paths](UNVERIFIED.md) | What nothing here verifies, and which known paths do not work |
| [Status](STATUS.md) | Implemented capabilities, pending work and verification limits |
| [Execution bridge](EXECUTION.md) | Application side of the Core boundary: request identity, exit codes and Host lifetime |
| [Release](RELEASE.md) | Source publication and official distribution |

Repository policies cover [contributions](../CONTRIBUTING.md),
[privacy](../PRIVACY.md), [security](../SECURITY.md) and
[artifact trust](../CODE_SIGNING_POLICY.md).

Execution documentation belongs to [Rho-core](https://github.com/YuLab-SMU/Rho-core).
Functional component documentation belongs to
[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins).
