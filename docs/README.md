# Rho Documentation

The documentation is organized by purpose so that design intent, implementation
guidance, project tracking, and release evidence do not become mixed together.

## Categories

| Directory | Contents |
| --- | --- |
| [`architecture/`](architecture/) | Stable system boundaries, integration architecture, and upstream change proposals |
| [`decisions/`](decisions/) | Architecture Decision Records (ADRs) |
| [`design/`](design/) | Feature specifications and implementation handoff designs |
| [`implementation/`](implementation/) | Build environment, packaging, and current prototype operation details |
| [`bug-fixes/`](bug-fixes/) | Review findings, defect analysis, and required repair plans |
| [`plans/`](plans/) | Dated work-package and execution plans |
| [`project/`](project/) | Roadmaps, milestone status, and project-level tracking |
| [`release/`](release/) | Release gates, acceptance checklists, and release evidence |

## Current Entry Points

- Product direction: [`project/development-roadmap.md`](project/development-roadmap.md)
- Current implementation status: [`project/phase-0-status.md`](project/phase-0-status.md)
- Windows prototype guide: [`implementation/windows-prototype.md`](implementation/windows-prototype.md)
- Windows build contract: [`implementation/windows-build-environment.md`](implementation/windows-build-environment.md)
- Current release gates: [`release/0.2-release-checklist.md`](release/0.2-release-checklist.md)
- Agent work handoff: [`plans/0.2x-agent-handoff.md`](plans/0.2x-agent-handoff.md)

Add new documents to the category that describes their purpose. Prefer a dated
filename for time-bounded plans and keep durable decisions in ADRs.
