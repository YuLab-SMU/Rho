# Evidence graph sidecar rebuild

> Temporary execution contract for the active replacement branch. It describes
> the target and current implementation checkpoint, not the architecture that
> is already shipped. Overwrite stale decisions and status in place; do not
> append a historical diary. The owner requested that the completed
> construction ledger remain available; current architecture lives in
> `docs/ARCHITECTURE.md` and `docs/components/DESKTOP.md`.

| Field | Current value |
| --- | --- |
| Program | `evidence-graph-sidecar` |
| Status | complete; backend, IPC, frontend boundaries, deletion guards and local closure pass |
| Baseline inspected | `56380569917b` |
| Last updated | `2026-09-01` |
| Completed package | `EG-00`–`EG-09` |
| Active package | none |
| Next concrete step | none; retain guards against old Evidence aliases and Authority/Graph recoupling |
| Compatibility policy | clean replacement; no dual write, alias, or legacy read |
| Authority Store migration | none; prior development schema is reset, not imported |
| Evidence data migration | none; old `EvidenceEntry` / `EvidenceClaim` rows are discarded |

The active program ledger is not this document alone:

- `programs/rho-rebuild/MANIFEST.json` owns all three current construction
  projects, packages, dependencies, and exit conditions;
- `programs/rho-rebuild/PROGRESS.json` owns current package state and concrete
  verification evidence;
- `programs/rho-rebuild/STATUS.md` is the compact resumption checkpoint;
- this document owns the detailed architecture and acceptance contract.

Frontend module decomposition is specified independently in
`docs/FRONTEND-MODULARIZATION-REBUILD.md`; Environment/Runtime ownership is
specified in `docs/ENVIRONMENT-REALIZATION-REBUILD.md`.

The earlier `rho-rebuild` 64-package receipt is a completed predecessor recorded
in `test/release/final-release-evidence.json`; it is not silently reopened or
reconstructed from hashes. `codex/rho-kernel-v2` is a separate future-version
worktree and is outside this program.

## Decision

Replace evidence-in-core with authority receipts and a project-local evidence
graph sidecar.

```text
Authority owners
  Workspace / Execution / Artifact CAS / Broker / Store / Secret Broker
        │ emit or resolve immutable receipts and references
        ▼
Receipt and reference contracts
  RunReceipt / ArtifactReceipt / ApprovalReceipt / RevisionRef /
  EnvironmentSnapshotRef / SourceAnchor / FindingReference / AgentTurnRef
        │ pulled and reconciled by the composition layer
        ▼
Evidence graph sidecar
  Claim / support / conflict / citation / trace / gap / draft promotion
        │ typed read projections
        ▼
Authority UI / Evidence UI / Agent UI
```

The authority layer answers whether an operation, revision, approval, or byte
identity really exists. The evidence graph answers which recorded claims link
to those facts, how they link, and what is missing. A graph record never makes
an authority fact true.

## Non-negotiable rules

1. `rho-store` and every other authority owner must not depend on
   `rho-evidence-graph`.
2. Core modules emit or resolve receipts; the graph consumes them. The graph
   never decides core success, failure, commit, or recovery.
3. A sidecar write, ingest, lock, or corruption failure cannot roll back or
   downgrade an otherwise committed authority operation. It may fail an
   explicitly requested evidence gate, never an ordinary development action.
4. There is no compatibility adapter, dual write, fallback read, old surface
   alias, or import of the old evidence tables.
5. `Evidence*` is reserved for claim-support graph concepts. Core references,
   security attestations, evaluation reports, and release receipts use their
   precise names.
6. Large source files, run output, artifacts, private reasoning, raw provider
   frames, and secrets never enter the sidecar. It stores identifiers, digests,
   bounded excerpts, safe labels, and relationships.
7. Agent writes are drafts. Promotion requires an explicit user action or a
   named trusted system policy at the admission boundary.
8. React renders typed backend projections. It does not derive that a run
   succeeded, an artifact exists, or a claim is supported by parsing generic
   JSON.
9. Existing tests are not compatibility requirements. For every replaced
   package, delete the unit tests owned by the old implementation and write a
   new suite from the target contracts. Tests for untouched authority
   invariants remain in scope and must continue to pass.
10. Git is the history. This document contains only the latest plan, checkpoint,
    blockers, and most recent gate result.

## Scope

### In scope

- Remove scientific claim/support persistence and CRUD from `rho-store`.
- Replace ambiguous core `Evidence` types with receipts, references,
  attestations, or reports.
- Replace the historical Store migration ladder with one fresh authority
  schema that contains no claim/evidence tables.
- Add `crates/rho-evidence-graph` with an independent embedded LadybugDB file at
  `<project-root>/.rho/evidence.lbdb`.
- Add idempotent authority ingest, live authority resolution, graph queries,
  draft/promotion writes, staleness, conflict, and gap detection.
- Replace the old Tauri evidence commands and generated transport facet.
- Split semantic frontend views into Workbench composition, Authority,
  Evidence, and Agent modules.
- Replace `rho.evidence` with typed Claims, Evidence Graph, Evidence Gaps, and
  Claim Trace surfaces.
- Add cited evidence and uncertainty/gap projections to the Agent surface.
- Delete old implementation-bound tests and replace them with contract,
  boundary, store, transport, component, and end-to-end tests.

### Not in scope for the first cut

- Neo4j, DuckPGQ, TuringDB, or a remote graph service.
- A scientific truth score or automatic assertion that a claim is true.
- Storing complete papers, source files, run output, or artifact bytes.
- Making evidence completeness a global development gate.
- Automatic Agent promotion of formal evidence.
- Long-lived synchronization with the deleted evidence schema.
- FTS/vector ranking, graph-layout polish, or Parquet export in the first local cut.
- Cross-platform LadybugDB packaging; the rapid replacement is gated on the
  current macOS development machine, with other targets deferred explicitly.

## Ownership contracts

| Module | Owned state and final authority | Emits or accepts | Must not assert |
| --- | --- | --- | --- |
| `rho-workspace` | live R state and state revision | run observation, state revision ref | claim support or scientific truth |
| `rho-execution` / scheduler adapters | process and job lifecycle, including `uncertain` | run/job receipt | artifact existence or claim support |
| `rho-artifact-store` | sealed bytes, SHA-256 identity, manifests | artifact receipt | producing run success unless resolved from its owner |
| `rho-control-plane` | admission, exact effect binding, approval lease, commit outcome | approval and patch receipts | that an Agent conclusion is supported |
| `rho-store` | committed semantic events and durable authority projections | durable receipt feed and authority reads | claim, support, conflict, or evidence gap |
| `rho-secret-broker` | scoped secret lease existence | opaque lease/attestation reference | plaintext secret content or claim support |
| `rho-protocol` | pure versioned receipt/reference shapes | accepted by owners and consumers | persistence or live authority |
| `rho-evidence-graph` | recorded claims, graph links, promotions, graph events, gap projections | authority refs, citation refs, Agent drafts | core fact existence or scientific truth |
| Desktop composition | project binding and typed projection assembly | authority resolver + graph service | independent truth derived in the renderer |
| React / Agent UI | presentation and user intent | typed reads, draft requests, user promotion request | authority success or support inferred locally |

The graph is authoritative only for its own statement: for example,
“promoted edge E links claim C to artifact reference A.” It is not authoritative
for “artifact A exists” or “claim C is true.”

## Dependency contract

Dependencies point toward contracts, never from authority into the sidecar.

```text
rho-workspace -----------┐
rho-execution -----------┤
rho-artifact-store ------┤
rho-control-plane -------┼──> rho-protocol
rho-store ---------------┘

rho-evidence-graph ----------> rho-protocol

desktop / rho-server composition
  ├──> authority read ports and owners
  └──> rho-evidence-graph
```

Required architecture guards:

- no `rho-evidence-graph` dependency in an authority crate;
- no SQLite, Tauri, Store, or runtime dependency in `rho-protocol`;
- no public core Rust type named `*Evidence*` after the naming cut;
- no graph command registered from an authority module;
- no renderer import from an authority implementation;
- no `evidence/` frontend import of authority mutation ports;
- no `authority/` frontend import of graph ports;
- Agent code receives read ports and a draft-only write port;
- `completed`, `succeeded`, `committed`, and `verified` authority labels come
  from authority projections;
- `supported`, `contradicted`, `stale`, `disputed`, and `gap` labels come from
  graph projections.

Release and acceptance artifacts may still use the ordinary English word
“evidence.” The type-name reservation applies to runtime/core contracts so that
scientific graph evidence cannot be confused with an attestation or receipt.

## Authority reference API

`rho-protocol` receives a pure `authority` module. Exact fields may be tightened
while implementing, but the semantic split is fixed.

```text
AuthorityRefV1
  project_id
  kind
  authority_id

AuthorityObservationV1
  reference
  authority_status
  digest
  project_revision
  state_revision
  observed_at
  limitations

RunReceiptV1
ArtifactReceiptV1
ApprovalReceiptV1
RevisionRefV1
EnvironmentSnapshotRefV1
SourceAnchorV1
FindingReferenceV1
AgentTurnRefV1
```

The composition layer exposes two bounded read operations:

```text
receipt_feed(after_cursor, limit) -> receipt batch + next cursor
resolve_authority_refs(refs)      -> live/canonical observations
```

The feed supports idempotent ingest. Live resolution is used whenever UI or a
gap rule needs to say whether a referenced fact currently exists. A cached
observation in the sidecar is labeled with its observation time and is never
silently upgraded into current authority.

### Naming cut

| Current concept | Replacement |
| --- | --- |
| `EvidenceEntry` / `EvidenceEntryDraft` | graph `ExternalCitation`, `SupportSource`, or authority node/reference |
| `EvidenceClaim` / `EvidenceClaimDraft` | graph `ClaimNode` / `ClaimDraft` |
| `EvidenceClaimReview` | `ClaimTrace` plus `EvidenceGap` projections |
| `ClaimReviewStatus` | typed graph trace and gap statuses |
| `CheckEvidenceV1` | `FindingReferenceV1` |
| `CheckFindingV1.evidence` | `CheckFindingV1.references` |
| `AuditEvidence` | `AuditReference` |
| `AuditFinding.evidence` | `AuditFinding.references` |
| `EnvironmentEvidence` | `EnvironmentReceipt` |
| `DeclassificationEvidence` | `DeclassificationAttestation` |
| `SecurityProfileEvidence` | `SecurityProfileAttestation` |
| `PlatformEvidence` | `PlatformAttestation` |
| `EvaluationEvidence` | `EvaluationReport` |
| `provenance_complete` | retained authority provenance status; not a claim-support verdict |

`rho-store` may retain integrity checks such as missing CAS bytes, malformed
run references, or incomplete environment receipts. Their output is a finding
with references. Claim-level unlinked/stale/conflict semantics live only in the
graph gap detector.

## Authority Store reset

The cut is intentionally destructive for development data.

- Replace the current migration ladder with one current schema bootstrap.
- The new authority schema contains no `evidence_entries`, `evidence_claims`,
  or `claim_evidence_links` tables and no claim-review assertions.
- Existing non-empty databases with another fingerprint/version return an
  explicit `STORE_SCHEMA_RESET_REQUIRED` result. They are not read, copied,
  upgraded, or silently reported as current.
- The development reset command removes the incompatible database before the
  next bootstrap. Production-style implicit deletion is not allowed because
  deletion must not masquerade as successful recovery.
- Remove old migration tests and write fresh-schema, wrong-fingerprint,
  interrupted-bootstrap, and authority-integrity tests.

This reset changes persistence shape, not ownership: runs, artifacts,
approvals, revisions, jobs, environments, and committed events remain authority
concepts in the fresh Store.

## Evidence graph contract

### Placement and lifecycle

- Database: `<normalized-project-root>/.rho/evidence.lbdb` using pinned `lbug 0.20.1`.
- One database per project; every row still carries `project_id` as a defensive
  identity check.
- The desktop opens the sidecar from the normalized active project root, not
  the process working directory.
- `.rho` and the database path must be real, contained paths. A symlink,
  reparse-point escape, wrong project identity, or read-only path makes the
  sidecar unavailable without changing core project/runtime status.
- `.rho` remains excluded from Agent project snapshots, so the Agent never gets
  direct database access.
- Project switching binds a new graph handle to the exact project identity.
  Stale handles and cross-project requests are rejected.
- LadybugDB uses WAL, checksums, strict WAL replay, one write transaction, a
  bounded query timeout, and one project-bound manager handle.

### Initial schema

```text
graph_metadata
  schema_version, project_id, project_root_digest, graph_revision

nodes
  node_id, project_id, kind, stable_key, label, payload_json, data_class,
  promotion_state, created_at, updated_at

edges
  edge_id, project_id, from_node, to_node, predicate, polarity, status,
  promotion_state, provenance_ref_id, confidence, created_at, updated_at

provenance_refs
  ref_id, project_id, authority_kind, authority_id, digest,
  project_revision, state_revision, captured_at, bounded_excerpt

graph_events
  event_id, project_id, graph_revision, event_type, actor_kind,
  payload_json, created_at

graph_snapshots
  snapshot_id, project_id, schema_version, event_start, event_end,
  graph_digest, created_at

evidence_gaps
  gap_id, project_id, subject_node, rule_id, status, basis_json,
  detected_revision, resolved_revision, detected_at, resolved_at

ingest_cursors
  feed_id, project_id, authority_cursor, last_success_at, last_error_code
```

Schema invariants:

- `(project_id, kind, stable_key)` is unique for managed authority nodes;
- every edge endpoint and provenance reference belongs to the same project;
- promoted support/conflict edges require a provenance reference;
- `predicate` and `polarity` combinations are constrained rather than free
  strings;
- confidence is optional, bounded to `[0, 1]`, and never presented as truth;
- excerpts and JSON payloads have explicit byte limits;
- formal deletion is a `retired` event/projection, not unexplained erasure;
- graph events and their node/edge/gap projections commit in one LadybugDB
  transaction;
- snapshots digest deterministic canonical graph content;
- FTS tables are deferred until a measured query requires them.


### Node kinds

```text
Claim
SourceRange
Run
Artifact
EnvironmentSnapshot
Approval
CheckFinding
ExternalCitation
AgentTurn
```

Authority-backed nodes contain a stable reference and cached bounded
observation only. User/Agent-authored nodes contain graph-owned content.

### Edge predicates

```text
supports
contradicts
derived_from
generated_by
observed_in
approved_by
uses_environment
cites
stale_after
requires_recheck
```

`stale_after` and `requires_recheck` are system-derived edges. They cannot be
promoted from an Agent-authored draft.

### Promotion states

```text
draft       Agent or user staging; excluded from formal support counts
promoted    admitted project graph record
retired     retained in graph history but inactive in current traces
```

Promotion validates project identity, current authority refs, actor/policy,
revision binding, bounded content, and graph revision. A stale promotion request
returns a conflict and never silently rebases.

## Gap model

Gap rules are deterministic projections, not prose entered by the user.

| Rule | Detection basis |
| --- | --- |
| `unlinked_claim` | promoted claim has no active promoted support/citation path |
| `stale_source_anchor` | current authority file digest differs from captured `SourceAnchor` digest |
| `missing_run_provenance` | referenced artifact has no resolvable producing run |
| `missing_environment` | referenced run has no resolvable environment snapshot |
| `unverified_agent_conclusion` | promoted Agent conclusion has no active run, artifact, source, or citation support |
| `conflicting_evidence` | active promoted support and contradiction paths reach the same claim |
| `needs_reobserve` | relevant project/state revision advanced after the latest supporting observation/test |
| `unresolved_authority_ref` | a graph ref cannot be resolved by its authority owner |
| `sidecar_ingest_lag` | receipt feed cursor is behind or reconciliation failed |

A gap can be open, acknowledged, or resolved. Resolution is recomputed from
current graph and authority observations. Acknowledgement does not make the gap
resolved.

## Ingest and consistency

There is no cross-database transaction and no authority mutation hook that
writes the graph.

1. Authority owners commit their own operation and expose a receipt/read model.
2. The desktop/server composition reads a bounded receipt feed.
3. The graph upserts managed authority nodes and edges by stable key in one
   idempotent graph transaction.
4. The ingest cursor advances only with that graph transaction.
5. Startup, project activation, authority invalidation, and manual refresh run
   reconciliation so a missed notification cannot create permanent loss.
6. Ingest failure updates graph health and retries. It does not rewrite the
   authority outcome.
7. Claim traces batch-resolve authority refs when current existence matters;
   they do not trust the cached sidecar observation alone.

Automatic mappings in the first cut:

| Authority input | Graph projection |
| --- | --- |
| run receipt | managed `Run` node |
| artifact receipt | managed `Artifact` node and `generated_by` when the producer ref exists |
| environment snapshot ref | managed `EnvironmentSnapshot` node and `uses_environment` |
| approval receipt | managed `Approval` node and `approved_by` |
| check finding + references | managed `CheckFinding` and reference edges |
| source anchor | managed `SourceRange` node |
| Agent turn ref | managed `AgentTurn` node; conclusions remain draft until promoted |

A graph request cannot create a run, artifact, approval, environment snapshot,
or revision receipt.

## Service and IPC API

### Rust graph service

```text
open_project_graph
apply_authority_batch
reconcile_authority_refs
create_draft_claim
revise_draft_claim
create_draft_link
retire_draft
promote_draft
retire_promoted_record
list_claims
get_claim_trace
get_subgraph
trace_artifact
list_agent_turn_evidence
list_gaps
rebuild_gaps
snapshot_graph
health
```

Every list/query has an explicit limit, stable cursor, project binding, and
bounded response. There is no arbitrary SQL or unrestricted graph traversal
API.

### Tauri commands and generated facets

```text
AuthorityReadTransport
  resolveAuthorityRefs(refs)
  listAuthorityReceipts(kind, cursor, limit)

EvidenceGraphReadTransport
  listClaims(request)
  getClaimTrace(claimId)
  getEvidenceSubgraph(request)
  listEvidenceGaps(request)
  traceArtifact(artifactId)
  listAgentTurnEvidence(turnId)
  getEvidenceGraphHealth()

EvidenceDraftTransport
  createDraftClaim(request)
  createDraftLink(request)
  retireDraft(request)

EvidencePromotionTransport       # user/trusted-policy UI only
  promoteDraft(request)
  retirePromotedRecord(request)
```

Commands derive the active project identity on the Rust side; renderer-supplied
roots are not trusted. Agent composition receives the read and draft ports but
not `EvidencePromotionTransport`.

The current direct Crossref request in `commands/evidence.rs` is removed.
External citation resolution becomes a bounded citation service admitted by the
appropriate network policy; the graph stores only the normalized citation ref
and bounded metadata.

## Frontend target

```text
desktop/ui/src/app/
  workbench/
    WorkbenchRoot.tsx
    SurfaceRouter.tsx
    SurfaceFrame.tsx
    useWorkbenchProjection.ts
    authorityPorts.ts
    evidenceGraphPorts.ts

  authority/
    RunsSurface.tsx
    JobsSurface.tsx
    ArtifactsSurface.tsx
    ApprovalsSurface.tsx
    RevisionsSurface.tsx
    EnvironmentSurface.tsx
    AuthorityStatus.tsx

  evidence/
    ClaimsSurface.tsx
    ClaimTracePanel.tsx
    EvidenceGraphSurface.tsx
    EvidenceGapsSurface.tsx
    EvidenceNodeCard.tsx
    EvidenceEdgeList.tsx
    EvidenceGraphHealth.tsx

  agent/
    AgentSurface.tsx
    AgentCurrentWork.tsx
    AgentActivity.tsx
    AgentApprovalPanel.tsx
    AgentEvidencePanel.tsx
    AgentGapPanel.tsx
    AgentFinalAnswer.tsx
```

Target surface IDs:

| Family | Surface IDs |
| --- | --- |
| Authority | `rho.runs`, `rho.jobs`, `rho.artifacts`, `rho.approvals`, `rho.revisions`, `rho.environment` |
| Evidence | `rho.claims`, `rho.evidence-graph`, `rho.evidence-gaps`, exact `rho.claim-trace` instances |
| Agent | `rho.agent` reading Authority + Evidence ports and writing drafts only |

`rho.plots` may remain as a typed artifact projection. `rho.jobs` may
remain only as a typed job filter. Neither may use the generic JSON status
inference path.

### Frontend cut

Delete rather than wrap:

- `transport/evidence.ts` and `transport/generated/evidence.ts`;
- the old evidence binding generator/test;
- `EvidenceReadTransport`, `EvidenceClaim`, and old mock records;
- all `rho.evidence` registry, profile, routing, Vibe, and presentation branches;
- evidence handling in `DomainSurfaceView` and `domain-presentation.ts`;
- old `AgentSurfaceView.tsx` and the fixture-only `AgentSurfaceVNext.tsx` once
  the new `agent/AgentSurface.tsx` is wired;
- implementation-bound tests for those files.

`DomainSurfaceView` may survive only for genuinely generic non-semantic views
such as Help. It cannot render Authority or Evidence records. `SurfaceView.tsx`
and the oversized transport intersection are replaced by a typed router and
narrow per-surface ports; they are not extended with more branches.

### Agent presentation

The Agent view contains these independent projections:

```text
Goal
Current Work
Activity
Approvals
Cited Evidence
Gaps / Uncertainty
Final Answer
```

The final answer panel renders, but does not infer:

```text
Cited
  Run r1                    authority: succeeded
  Artifact plot1            authority: digest verified
  analysis.R:20-42          authority: fresh source anchor
  DOI ...                   graph: cited

Gaps
  missing environment snapshot
  claim stale after file change
  conclusion has no promoted support
```

A missing or lagging sidecar is shown as evidence unavailable/lagging, not as a
failed run or missing artifact.

## Current implementation deletion map

| Current path | Current responsibility | Replacement owner |
| --- | --- | --- |
| `crates/rho-store/src/evidence.rs` | claim/entry CRUD and review in authority Store | `rho-evidence-graph` |
| `crates/rho-store/src/executor.rs` evidence methods | async old CRUD | graph executor/service |
| `crates/rho-store/src/migration.rs` evidence tables | old schema and migration ladder | fresh authority schema + graph schema |
| `crates/rho-store/src/lib.rs` evidence exports/assertions | public old model | precise authority exports only |
| `crates/rho-store/src/audit.rs` | mixed integrity checks and `AuditEvidence` | authority findings/references + graph gaps |
| `crates/rho-protocol/src/workbench.rs` | `EnvironmentEvidence` | `EnvironmentReceipt` |
| `crates/rho-protocol/src/results.rs` | declassification “evidence” | attestation contract |
| `crates/rho-ui-contract/src/check.rs` | `CheckEvidenceV1` | `FindingReferenceV1` |
| `desktop/src-tauri/src/commands/evidence.rs` | old CRUD, source snapshot, direct DOI request | graph commands + authority resolver + citation service |
| `desktop/src-tauri/src/main.rs` | old command registration | typed graph/authority command registration |
| `desktop/ui/src/transport/evidence.ts` | one-list read port | split graph read/draft/promotion ports |
| `desktop/ui/src/transport/tauri.ts` | generic domain conversion | typed authority/evidence adapters |
| `desktop/ui/src/app/DomainSurfaceView.tsx` | generic evidence rendering | dedicated evidence surfaces |
| `desktop/ui/src/app/domain-presentation.ts` | renderer-derived support status | backend graph projections |
| `desktop/ui/src/app/AgentSurfaceView.tsx` | monolithic Agent surface | composed Agent modules |
| `desktop/ui/src/app/vibe/**verification**` | direct old `EvidenceClaim` reads | graph claim trace/read port |
| `desktop/src-tauri/src/internal_extensions/plugins.rs` | `rho.evidence` definition | new Authority/Evidence surface definitions |
| `crates/rho-architecture-tests/tests/module_graph.rs` | prior rebuild layout assertions | rewritten current boundary guards |

## Work packages

Status values are `pending`, `active`, `blocked`, and `done`. A package becomes
`done` only when its exit checks have actually run and its deletion conditions
are satisfied.

| ID | Status | Depends on | Deliverable | Exit condition |
| --- | --- | --- | --- | --- |
| `EG-00` | done | — | inspected baseline and this replacement contract | current paths and decisions recorded |
| `EG-01` | done | `EG-00` | authority contracts, naming cut, and architecture guard | core contract tests pass; no public core `*Evidence*` type remains |
| `EG-02` | done | `EG-01` | old Store evidence module/API/tables removed; fresh authority schema is version 17 after adding the receipt log, and prior schemas return reset-required | fresh/reopen/reset tests cover the cut |
| `EG-03` | done | `EG-01` | LadybugDB graph crate implements path-safe open, event-backed mutation/query/ingest/gaps/snapshots and project manager | focused crate suite passed locally, including reopen, corruption, bounds, rollback, ingest, promotion, gaps, snapshots, and switching |
| `EG-04` | done | `EG-02`, `EG-03` | Store Authority feed, resolver, reconciliation, and project graph manager | focused project-switch receipt ingest and sidecar-isolation checks pass |
| `EG-05` | done | `EG-04` | bounded Tauri API, generated TypeScript facet, mocks, and command inventory | generated binding, transport boundary, and 213-command inventory pass |
| `EG-06` | done | `EG-05` | pure graph DTO/API boundary: graph responses carry refs and graph semantics, never a live Authority status | generated contracts and graph transport expose no cached Authority status; Authority commands remain a distinct read facet |
| `EG-07` | done | `EG-06` | complete deterministic stale/conflict/missing-provenance rules and promotion admission | focused gap, conflict, stale revision, draft isolation and user promotion scenarios pass |
| `EG-08` | done | `EG-07`, `FE-04` | project activation, receipt restart, current Authority resolution and Agent/Vibe trace integration | one local cross-layer scenario proves graph failure isolation and independently resolved cited facts |
| `EG-09` | done | `EG-08` | graph dead-code deletion, local closure, current docs and export/recovery truth | old Evidence paths are absent, local new-path gates pass, and the completed owner-requested ledger is retained |

### EG-01 — authority references and naming cut

- Add the pure authority contract module and bounded validation.
- Rename all ambiguous core/runtime types in the naming table in one cut.
- Change Check/Audit field names from `evidence` to `references`.
- Regenerate Check and other affected TypeScript facets.
- Rewrite tests for the new names and semantics; do not retain aliases.
- Replace prior module-graph assertions with dependency and naming guards.

Focused gate:

```bash
rtk cargo test -p rho-protocol -p rho-ui-contract -p rho-control-plane \
  -p rho-sandbox -p rho-extension-runtime --locked
rtk cargo test -p rho-architecture-tests --locked
```

### EG-02 — authority Store excision

- Delete `rho-store/src/evidence.rs` and all exports/executor methods.
- Delete evidence tables, indexes, assertions, migration branches, and tests.
- Build one fresh authority schema and explicit reset-required failure.
- Keep only authority integrity/provenance findings with precise references.
- Update `rho-store` Workbench reads for renamed receipts.

Focused gate:

```bash
rtk cargo test -p rho-store --locked -- --test-threads=1
```

### EG-03 — graph sidecar

- Add workspace crate and governance source mapping.
- Implement path containment, project binding, schema bootstrap, worker, and
  health projection.
- Implement event-backed nodes/edges/refs, drafts, promotion, retirement,
  traces, snapshots, and deterministic gap rebuild.
- Write a new suite for validation, transaction rollback, idempotency, stale
  revisions, reopen, corruption, bounds, and cross-project rejection.

Focused gate:

```bash
rtk cargo test -p rho-evidence-graph --locked -- --test-threads=1
rtk cargo test -p rho-architecture-tests --locked
```

### EG-04 / EG-05 — composition and API cutover

- Add a project-aware graph manager; do not copy the authority Store `OnceCell`
  pattern across project switches.
- Compose authority reads without adding graph dependencies to owners.
- Implement feed cursor/reconciliation and batch authority resolution.
- Register only the new bounded Tauri commands.
- Generate new authority and evidence-graph TypeScript facets.
- Delete direct DOI networking, old command tests, old binding scripts, and old
  mock handlers before the cutover package closes.

Focused gate:

```bash
rtk cargo test -p rho-desktop -p rho-evidence-graph -p rho-ui-contract --locked
rtk npm run rsr:check:contracts --prefix desktop
```

### EG-06 / EG-07 — projection purity and graph semantics

- Remove `authority_status` and `authority_observed_at` from graph node DTOs.
- Keep only stable Authority refs and explicit graph-owned status/promotion fields.
- Separate Authority command/binding ownership from graph command/binding ownership.
- Finish deterministic gap and promotion admission behavior without moving core
  fact authority into the graph.
- Consume the resulting facets through the independent Frontend project.

Focused gate:

```bash
rtk cargo test -p rho-ui-contract evidence_graph --locked
rtk node scripts/test-evidence-graph-bindings.mjs
rtk npm run rsr:typecheck --prefix desktop
```

### EG-08 / EG-09 — integration and closure

- Exercise project activation/switch, ingest restart, sidecar unavailable,
  stale source, conflicting links, draft promotion, and Agent final answer.
- Remove every old symbol, surface ID, generated file, fixture, and test.
- Run governance impact and every affected check; then run the workspace gate.
- Update `docs/ARCHITECTURE.md`, `docs/components/DESKTOP.md`, registry/source
  maps, and generated indexes to describe only implemented behavior.
- Delete this temporary document after all requirements map to passing code,
  tests, and generated contracts.

Closure gate:

```bash
rtk node scripts/governance.mjs impact --changed-auto
rtk cargo test --workspace --locked -- --test-threads=1
rtk npm run rsr:check:full --prefix desktop
rtk node scripts/governance.mjs check
```

Acceptance and release tiers run only if the final changed-path impact requires
them; an unrun tier is reported as unrun.

## Required acceptance scenarios

1. **Authority remains authority.** A graph node that names a nonexistent
   artifact resolves as missing; it does not create an artifact or a successful
   receipt.
2. **Sidecar failure isolation.** Lock or corrupt `evidence.lbdb`; an admitted
   run and CAS commit still report their real authority outcomes while graph
   health reports unavailable.
3. **Idempotent ingest.** Replay one receipt batch and restart during ingest;
   node/edge counts and cursor remain correct without duplicate managed nodes.
4. **Source staleness.** Promote a source-backed claim, change the file, advance
   the project revision, and observe `stale_source_anchor` and
   `needs_reobserve` from current digest/revision resolution.
5. **Missing provenance.** Reference an artifact without a producing run and a
   run without an environment snapshot; the corresponding gaps remain open
   without changing artifact/run authority status.
6. **Conflict.** Promote support and contradiction paths for one claim; the
   trace preserves both and reports `conflicting_evidence` rather than choosing
   a winner.
7. **Draft isolation.** Agent-created links do not count as formal support and
   cannot be promoted through the Agent port.
8. **Promotion admission.** A user promotion bound to an old graph/project
   revision is rejected and requires refresh; no silent rebase occurs.
9. **Project containment.** Project A cannot read, link, resolve through, or
   promote Project B graph records; a project switch cannot reuse the old graph

   handle.
10. **Bounded data.** Oversized excerpts, payloads, traversals, batches, and
    response pages fail with stable bounded errors and leave no partial writes.
11. **Renderer separation.** The UI displays authority status and graph status
    from their typed fields and contains no local success/support derivation.
12. **Agent answer trace.** A final answer displays resolved cited receipts,
    promoted graph links, open gaps, ingest lag, and uncertainty independently.
13. **Ordinary workflow remains light.** Missing claim support does not block
    editing, running, rendering, or committing unless a caller explicitly
    enters a named evidence gate.

## Completion audit

The program is complete only when every statement below has concrete source,
generated-contract, command, or test evidence.

- [x] No claim/support table, type, CRUD method, or review logic remains in
      `rho-store`.
- [x] No authority crate depends on `rho-evidence-graph`.
- [x] No public core/runtime `*Evidence*` type remains from the naming cut.
- [x] The fresh authority schema and sidecar schema reject incompatible identity
      or fingerprints without compatibility reads.
- [x] The sidecar stores no large authority payload, artifact bytes, secrets,
      private reasoning, or raw provider frame.
- [x] Ingest is idempotent and sidecar failure cannot alter core outcomes.
- [x] Every formal support/conflict link has promotion provenance and current
      project identity.
- [x] Gap rules use graph state plus authority resolution and cannot manufacture
      authority facts.
- [x] Agent ports can read and draft but cannot promote.
- [x] Authority and Evidence surfaces use typed projections; generic JSON
      parsing does not assign semantic statuses.
- [x] `rho.evidence`, old commands/transports/generated facets/mocks, and old
      implementation-bound tests are deleted.
- [x] New focused, boundary, contract, component, and acceptance tests cover the
      replacement behavior.
- [x] Governance impact checks and all affected local gates actually pass.
- [x] Current architecture/desktop docs match the implementation.
- [x] The completed construction document is retained by explicit owner request and is not the current architecture source.

## Checkpoint update protocol

During implementation, keep only this compact current checkpoint near the top
of the file:

1. set `Completed package`, `Next package`, and `Status` from actual code state;
2. mark a package `done` only after its exit condition and focused gate pass;
3. replace, rather than append to, changed decisions and schema/API sketches;
4. record a blocker as an exact failing command/path and remove it when fixed;
5. keep only the most recent gate result below; Git retains earlier results;
6. never convert `not run` into `passed` in prose.

### Most recent gate

```text
PASS  cargo test -p rho-evidence-graph --locked -- --test-threads=1  16 tests
PASS  cargo test -p rho-store --lib --locked -- --test-threads=1    162 tests
PASS  cargo test -p rho-architecture-tests --locked                13 tests
PASS  cargo test -p rho-ui-contract --lib --locked                 66 tests
PASS  committed Store receipt + corrupt sidecar desktop smoke       2 tests
PASS  npm --prefix desktop run rsr:check                            460 tests
PASS  focused Agent/Environment App integration                      4 tests
PASS  Evidence Graph generated binding contract
PASS  Tauri command inventory                                     204 commands
PASS  generated transport boundary                                0 direct invoke calls
PASS  npm run rsr:build --prefix desktop
PASS  cargo check --workspace --locked
PASS  cargo build -p rho-desktop --locked
PASS  node scripts/governance.mjs check

NOT RUN  legacy full rho-desktop/workspace compatibility matrices by user direction.
NOT RUN  release/visual/cross-platform packaging gates by user direction.
```

### Current blockers

```text
No local implementation blocker remains. Cross-platform LadybugDB packaging,
release/visual capture and old full compatibility matrices remain explicitly
deferred by owner direction and are not reported as passed.
```

### Session handoff snapshot

```text
Complete
- Authority refs/receipts and graph relations have separate canonical and generated facets.
- Store contains no claim/support tables; LadybugDB owns project-local Claims, links, gaps, traces and promotion history.
- Graph renderer DTOs are ref-only for Authority facts; Authority is resolved independently.
- Agent receives Authority read, Graph read and Draft write only; promotion is absent.
- Old `EvidenceClaim`, `EvidenceEntry`, `EvidenceReadTransport`, `rho.evidence` and implementation-bound paths are absent and guarded.
- The combined Authority/Evidence/Frontend/Environment rebuild ledger is complete and retained at the owner's request.
```
