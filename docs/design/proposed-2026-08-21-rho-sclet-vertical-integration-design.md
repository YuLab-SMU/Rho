# Rho + sclet: Single-Cell & Spatial Transcriptomics Vertical Integration Proposal

Date: 2026-08-21
Status: proposed; implementation not authorized

## Summary

This proposal records a future product direction: make Rho an AI-assisted
single-cell and spatial transcriptomics workbench by integrating
[YuLab-SMU/sclet](https://github.com/YuLab-SMU/sclet).

`sclet` is a state-aware single-cell and spatial toolkit built around
`SingleCellExperiment`. It exposes a unified `Run*(sce, ...)` API, organizes
analysis into 11 mainlines, and maintains an explicit Analysis-State Contract
that records assays, reductions, clusterings, and downstream results as
structured provenance.

Rho already provides durable runs, problems, evidence, recovery, and an Agent
execution surface. The intersection is natural:

> sclet gives Rho a domain-native, reproducible analysis vocabulary.
> Rho gives sclet a durable, inspectable, AI-steerable execution environment.

This proposal is intentionally **not an implementation authorization**. It is a
sequencing and architecture-direction document. Concrete implementation must
wait until the prerequisite foundations are accepted.

## Prerequisites

This vertical does **not** come first. It depends on:

1. **Shared application service seam**
   - Active: `docs/plans/active-2026-08-20-project-application-service-seam-spec.md`
   - Required so Tauri, headless tests, CLI, and future adapters share one
     application semantics layer.

2. **Remote R / remote project support**
   - Current status: deferred/future in existing proposals.
   - Required because sclet mainlines include heavy Python backends (scVI,
     scVelo, CellRank, SCENIC, cell2location, CellOracle) and real single-cell
     datasets often live on servers or high-memory nodes.
   - Required so Rho is not limited to local R/Ark execution.

3. **More complete Agent capabilities**
   - Current status: partial proposals exist
     (`docs/plans/proposed-2026-08-10-ai-capability-gap-closure-plan.md`).
   - Required so the Agent can plan multi-step sclet workflows, interpret SCE
     state, choose the next mainline, recover from failures, and explain
     results.

## Goals

- Let a user ask Rho to run a complete single-cell analysis through sclet.
- Let the Agent plan and execute `Run*` workflows with inspectable steps.
- Map sclet's Analysis-State Contract to Rho's durable run/evidence records.
- Support local and later remote R execution of sclet mainlines.
- Provide domain-aware vertical skill packs for single-cell / spatial analysis.
- Preserve Rho's existing authority model: no second store, no automatic
  approval, no silent environment mutation.

## Non-Goals

- Replacing sclet as the analysis engine.
- Creating a second single-cell state authority inside Rho.
- Implementing this vertical before remote R and Agent foundations are accepted.
- Adding a public protocol or schema migration solely for sclet.
- Auto-approving sclet execution based on model confidence.
- Building a separate TUI/CLI product as part of this proposal.

## Proposed Sequencing

### Phase 0: Contract mapping (design only)

- Document sclet mainlines and state fields.
- Map sclet state to Rho's existing run/problem/evidence model.
- Identify which sclet calls are read-only vs stateful.
- Identify remote-execution requirements per mainline.

### Phase 1: Read-only sclet awareness

- Agent can inspect SCE objects and sclet state through bounded viewer/protocol.
- Rho can display sclet mainline status and provenance without executing.
- No new execution authority.

### Phase 2: Local sclet execution

- After Agent capability milestones are accepted.
- Agent can invoke sclet `Run*` functions through the shared application
  service.
- Every run is recorded as a durable Rho run with bounded evidence.

### Phase 3: Remote sclet execution

- After remote R / remote project support is accepted.
- SCE data and sclet runs can be executed on remote R/Ark/high-memory nodes.
- Project folder may be remote.
- Remote run/cancel/recovery follows Rho's existing semantics.

### Phase 4: Vertical agent skills

- Ship sclet-aware skill packs / project skills.
- Agent learns common single-cell workflows:
  - QC → normalization → HVG → PCA → UMAP → clustering
  - integration → cell annotation → trajectory → SCENIC → communication
  - spatial deconvolution / niche analysis
- Generate reproducible reports and evidence trails.

## Relationship To Existing Proposals

- **RStudio-inspired workflow proposal**: this vertical is a domain-specific
  extension of the scientific workflow direction, not a replacement.
- **Human/Agent posture design**: sclet workflows should work in both
  Human-first and Agent-first postures.
- **Public Workbench Protocol / CLI / MCP**: future remote or headless sclet
  access must follow the authenticated transport boundary, not direct-store
  access.
- **Plugin runtime**: sclet skill packs could later become project-scoped
  workspace plugins, but this proposal does not depend on plugin runtime.

## Acceptance Direction (not a gate yet)

A future authorized slice should prove:

- one sclet mainline can be executed as a deterministic scenario test;
- the same application service is used by Tauri and headless test;
- sclet state is persisted as Rho evidence without duplicating authority;
- remote execution (when available) preserves run/recovery truth;
- Agent planning can be evaluated on a small single-cell fixture.

## Recommendation

Do not implement this vertical now.

Instead:

1. Finish and close the current application-service seam slice.
2. Produce and accept a dedicated **remote R / remote project proposal**.
3. Produce and accept a **more complete Agent capability roadmap**.
4. Then activate this sclet vertical as a bounded, evidence-driven slice.

This keeps the order:

```text
architecture → remote R → smarter agent → sclet vertical
```
