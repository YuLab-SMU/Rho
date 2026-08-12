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

- Required development governance: [`project/active-development-governance.md`](project/active-development-governance.md)
- Product direction: [`project/active-development-roadmap.md`](project/active-development-roadmap.md)
- Active/proposed document authority and cross-review: [`project/active-document-cross-review.md`](project/active-document-cross-review.md)
- Phase 0 implementation snapshot: [`project/historical-phase-0-status.md`](project/historical-phase-0-status.md)
- Windows prototype guide: [`implementation/implemented-windows-prototype.md`](implementation/implemented-windows-prototype.md)
- Windows build contract: [`implementation/implemented-windows-build-environment.md`](implementation/implemented-windows-build-environment.md)
- Current release gates: [`release/active-0.2-release-checklist.md`](release/active-0.2-release-checklist.md)
- `0.2.0` hardening contract: [`release/active-0.2.0-release-hardening-spec.md`](release/active-0.2.0-release-hardening-spec.md)
- Accepted About and manual update-check V1: [`design/accepted-2026-07-25-about-and-update-check-design.md`](design/accepted-2026-07-25-about-and-update-check-design.md)
- Active SignPath application readiness: [`plans/active-2026-08-11-signpath-application-readiness-spec.md`](plans/active-2026-08-11-signpath-application-readiness-spec.md)
- Active SignPath Free Trial Windows smoke: [`plans/active-2026-08-12-signpath-free-trial-smoke-spec.md`](plans/active-2026-08-12-signpath-free-trial-smoke-spec.md)
- Active AGPL transition and installed-license gate: [`plans/active-2026-08-10-agpl-license-transition-spec.md`](plans/active-2026-08-10-agpl-license-transition-spec.md)
- Active `0.4.0-dev.37` source/Issue #33 Windows acceptance gate: [`release/active-0.4.0-dev.37-candidate-checklist.md`](release/active-0.4.0-dev.37-candidate-checklist.md)
- Proposed implemented-baseline hardening: [`plans/proposed-2026-07-26-implemented-baseline-hardening-plan.md`](plans/proposed-2026-07-26-implemented-baseline-hardening-plan.md)
- Active BH1 project-scoped durable identity handoff: [`plans/active-2026-07-26-bh1-project-scoped-durable-identity-handoff.md`](plans/active-2026-07-26-bh1-project-scoped-durable-identity-handoff.md)
- Proposed intuitive interaction and guided workflows: [`design/proposed-2026-07-26-intuitive-interaction-and-guided-workflows-design.md`](design/proposed-2026-07-26-intuitive-interaction-and-guided-workflows-design.md)
- Proposed public Workbench Protocol, CLI, and MCP: [`design/proposed-2026-07-26-public-workbench-protocol-cli-mcp-design.md`](design/proposed-2026-07-26-public-workbench-protocol-cli-mcp-design.md)
- Proposed reproducibility audit and run comparison: [`design/proposed-2026-07-26-reproducibility-audit-and-run-comparison-design.md`](design/proposed-2026-07-26-reproducibility-audit-and-run-comparison-design.md)
- Partially implemented RStudio-inspired workflow direction and remaining gaps: [`design/proposed-2026-07-26-rstudio-inspired-workflow-design.md`](design/proposed-2026-07-26-rstudio-inspired-workflow-design.md)
- Proposed Human/Agent workbench posture: [`plans/proposed-2026-07-20-human-agent-workbench-posture-design.md`](plans/proposed-2026-07-20-human-agent-workbench-posture-design.md)
- Proposed interface modernization: [`plans/proposed-2026-07-26-interface-modernization-plan.md`](plans/proposed-2026-07-26-interface-modernization-plan.md)
- Active remaining-work follow-up: [`plans/active-2026-08-02-remaining-work-follow-up.md`](plans/active-2026-08-02-remaining-work-follow-up.md)
- Active Agent entry and Direct-surface polish: [`plans/active-2026-08-02-agent-entry-and-direct-surface-polish-spec.md`](plans/active-2026-08-02-agent-entry-and-direct-surface-polish-spec.md)
- Active Agent-first intuitive modernization: [`plans/active-2026-08-02-agent-first-intuitive-modernization-spec.md`](plans/active-2026-08-02-agent-first-intuitive-modernization-spec.md)
- Active Agent-first adaptive work surface: [`plans/active-2026-08-03-agent-first-adaptive-work-surface-spec.md`](plans/active-2026-08-03-agent-first-adaptive-work-surface-spec.md)
- Active native context, diagnostics, and editor shortcuts repair: [`plans/active-2026-08-05-native-context-lint-problems-editor-shortcuts-spec.md`](plans/active-2026-08-05-native-context-lint-problems-editor-shortcuts-spec.md)
- Active human-facing information projection: [`plans/active-2026-08-05-human-facing-information-projection-spec.md`](plans/active-2026-08-05-human-facing-information-projection-spec.md)
- Active Agent result transport recovery: [`plans/active-2026-08-06-agent-result-transport-recovery-spec.md`](plans/active-2026-08-06-agent-result-transport-recovery-spec.md)
- Active file proposal collapse: [`plans/active-2026-08-06-file-proposal-collapse-spec.md`](plans/active-2026-08-06-file-proposal-collapse-spec.md)
- Active Act file apply and generated output capture: [`plans/active-2026-08-06-act-file-apply-and-generated-output-capture-spec.md`](plans/active-2026-08-06-act-file-apply-and-generated-output-capture-spec.md)
- Active first-start user directory default: [`plans/active-2026-08-06-user-directory-first-start-spec.md`](plans/active-2026-08-06-user-directory-first-start-spec.md)
- Active Agent output copy: [`plans/active-2026-08-06-agent-output-copy-spec.md`](plans/active-2026-08-06-agent-output-copy-spec.md)
- Active generated output Review: [`plans/active-2026-08-06-generated-output-review-spec.md`](plans/active-2026-08-06-generated-output-review-spec.md)
- Active current Project check: [`plans/active-2026-08-06-current-project-check-spec.md`](plans/active-2026-08-06-current-project-check-spec.md)
- Active Plot payload normalization repair: [`plans/active-2026-08-04-plot-payload-normalization-repair-spec.md`](plans/active-2026-08-04-plot-payload-normalization-repair-spec.md)
- Active guarded Git review: [`plans/active-2026-08-02-ws4-reviewable-git-mutations-spec.md`](plans/active-2026-08-02-ws4-reviewable-git-mutations-spec.md)
- Verified adversarial Git hardening: [`plans/active-2026-08-03-ws4-adversarial-git-hardening-spec.md`](plans/active-2026-08-03-ws4-adversarial-git-hardening-spec.md)
- Verified Git repository replacement handling: [`plans/active-2026-08-03-ws4-repository-replacement-spec.md`](plans/active-2026-08-03-ws4-repository-replacement-spec.md)
- Active broker-owned Data Viewer query: [`plans/active-2026-08-03-ws3-broker-data-query-spec.md`](plans/active-2026-08-03-ws3-broker-data-query-spec.md)
- Active Data Viewer type and missing-value presentation: [`plans/active-2026-08-03-ws3-type-missing-presentation-spec.md`](plans/active-2026-08-03-ws3-type-missing-presentation-spec.md)
- Active render cancellation and restart reconciliation: [`plans/active-2026-08-03-render-cancellation-reconciliation-spec.md`](plans/active-2026-08-03-render-cancellation-reconciliation-spec.md)
- Active render result to Artifact linkage: [`plans/active-2026-08-03-render-artifact-linkage-spec.md`](plans/active-2026-08-03-render-artifact-linkage-spec.md)
- Active WS1 lockfile inventory and library comparison: [`plans/active-2026-08-03-ws1-lockfile-inventory-spec.md`](plans/active-2026-08-03-ws1-lockfile-inventory-spec.md)
- Active WS1 dependency role and package source presentation: [`plans/active-2026-08-03-ws1-dependency-source-spec.md`](plans/active-2026-08-03-ws1-dependency-source-spec.md)
- Active WS1 individual package mutation: [`plans/active-2026-08-03-ws1-package-mutation-spec.md`](plans/active-2026-08-03-ws1-package-mutation-spec.md)
- Active WS2 local Help and package location: [`plans/active-2026-08-03-ws2-local-help-location-spec.md`](plans/active-2026-08-03-ws2-local-help-location-spec.md)
- Active WS2 bounded project references: [`plans/active-2026-08-03-ws2-bounded-project-references-spec.md`](plans/active-2026-08-03-ws2-bounded-project-references-spec.md)
- Active WS2 installed Help and reviewed example: [`plans/active-2026-08-03-ws2-installed-help-and-example-spec.md`](plans/active-2026-08-03-ws2-installed-help-and-example-spec.md)
- Active WS2 deterministic diagnostics and reviewed quick fixes: [`plans/active-2026-08-03-ws2-diagnostic-grouping-quick-fix-spec.md`](plans/active-2026-08-03-ws2-diagnostic-grouping-quick-fix-spec.md)
- Active WS2 Agent answers linked to Local Help: [`plans/active-2026-08-03-ws2-agent-local-help-link-spec.md`](plans/active-2026-08-03-ws2-agent-local-help-link-spec.md)
- Active WS2 reviewable rename and extract edits: [`plans/active-2026-08-03-ws2-refactor-review-spec.md`](plans/active-2026-08-03-ws2-refactor-review-spec.md)
- Deferred aisdk family proposals: [`architecture/proposed-aisdk-family-change-proposals.md`](architecture/proposed-aisdk-family-change-proposals.md)
- Active `0.3.x` implementation handoff: [`plans/active-2026-07-25-0.3x-scientific-workflow-handoff.md`](plans/active-2026-07-25-0.3x-scientific-workflow-handoff.md)
- Current `0.3.x` milestone verification: [`verification/0.3x-milestone/verification.md`](verification/0.3x-milestone/verification.md)
- Implemented Agent work handoff: [`plans/implemented-0.2x-agent-handoff.md`](plans/implemented-0.2x-agent-handoff.md)

Add new documents to the category that describes their purpose. Prefer a dated
filename for time-bounded plans and keep durable decisions in ADRs.
