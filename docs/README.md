# Rho Documentation

The documentation is organized by purpose so that design intent, implementation
guidance, project tracking, and release evidence do not become mixed together.

## Status Prefixes

Every substantive document starts with a lifecycle prefix. `README.md` index
files are the only exception.

| Prefix | Meaning |
| --- | --- |
| `implemented-` | The documented design, plan, or behavior is implemented in the current product baseline |
| `active-` | The document is actively maintained or its work and acceptance gates are still underway |
| `accepted-` | The architecture decision has been adopted and remains authoritative |
| `proposed-` | The proposal is not yet approved or implemented |
| `historical-` | The document is a completed snapshot retained for traceability rather than current execution |

The prefix describes lifecycle state, while the directory describes document
type. For example, an implemented design remains under `design/` as
`implemented-...`; moving it to another directory is unnecessary. Update both
the filename prefix and the document's `Status:` field when its lifecycle
changes.

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

- Product direction: [`project/active-development-roadmap.md`](project/active-development-roadmap.md)
- Phase 0 implementation snapshot: [`project/historical-phase-0-status.md`](project/historical-phase-0-status.md)
- Windows prototype guide: [`implementation/implemented-windows-prototype.md`](implementation/implemented-windows-prototype.md)
- Windows build contract: [`implementation/implemented-windows-build-environment.md`](implementation/implemented-windows-build-environment.md)
- Current release gates: [`release/active-0.2-release-checklist.md`](release/active-0.2-release-checklist.md)
- `0.2.0` hardening contract: [`release/active-0.2.0-release-hardening-spec.md`](release/active-0.2.0-release-hardening-spec.md)
- Implemented Agent work handoff: [`plans/implemented-0.2x-agent-handoff.md`](plans/implemented-0.2x-agent-handoff.md)

Add new documents to the category that describes their purpose. Prefer a dated
filename for time-bounded plans and keep durable decisions in ADRs.
