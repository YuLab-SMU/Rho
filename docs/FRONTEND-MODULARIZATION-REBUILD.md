# Frontend authority/evidence modularization rebuild

> Temporary construction contract for the current `main` replacement. This is
> a destructive module and capability cut, not a compatibility migration. Its
> progress is tracked by `programs/rho-rebuild/PROGRESS.json`. The owner asked
> to retain the completed construction ledger; current architecture remains in
> `docs/ARCHITECTURE.md` and `docs/components/DESKTOP.md`.

| Field | Current value |
| --- | --- |
| Project | `frontend-authority-evidence` |
| Status | complete; Authority/Evidence/Agent/Workbench boundaries and deletion guards pass |
| Baseline | `main@56380569917b` plus the active Evidence Graph worktree |
| Platform | local macOS development target |
| Compatibility | none; old semantic views and tests are deleted rather than adapted |
| Completed package | `FE-00`–`FE-08` |
| Active package | none; frontend local cut is complete |
| Next cut | none; retain architecture guards against semantic recoupling |

## Outcome

The frontend becomes four explicit module families:

```text
desktop/ui/src/app/
  authority/   authoritative facts from Store / Execution / CAS / Broker
  evidence/    claims, graph relations, traces, citations, staleness and gaps
  agent/       workbench that reads Authority + Evidence and writes drafts only
  workbench/   shell, project switch, narrow capability composition and routing
```

The product vocabulary has one owner per statement:

```text
Authority UI
  “Did this Run, Job, Artifact, Approval or Revision actually exist, and what
   does its owner currently report?”

Evidence UI
  “What supports or contradicts this Claim, what is stale, and what is missing?”

Agent UI
  “Which independently resolved facts and graph relations did this answer cite,
   and where is it uncertain?”
```

React never upgrades a string, generic JSON field, graph cache, optimistic
acknowledgement, or Agent prose into an authority fact.

## Current audit

The first cut created the new directories and Surface IDs, but it did not finish
the architecture:

- `SurfaceRouter.tsx` accepts the complete `UiKernelTransport`.
- `evidence/index.tsx` casts that object to `EvidenceGraphTransport`.
- `EvidenceGraphTransport` and `AgentEvidenceTransport` both include
  `AuthorityReadTransport` instead of exposing independent capabilities.
- graph nodes expose `authority_status` and `authority_observed_at`; Evidence
  and Agent cards render those cached values as current facts.
- `authority/index.tsx` contains every Authority surface. Jobs are inferred by
  matching Run string fields, while Artifact state is mapped from
  `provenance_complete` inside React.
- `WorkbenchRoot.tsx` is 3113 lines, `SurfaceFrame.tsx` is 922 lines, and
  `AgentSurface.tsx` is 1869 lines. Agent Activity and Approvals are inline.
- `authorityPorts.ts` and `evidenceGraphPorts.ts` are aliases, not runtime
  capability pickers, and are not consumed by the semantic modules.

This project is complete only when those facts are no longer true.

## Non-negotiable boundaries

1. `authority/` imports no Evidence Graph transport, model, status or mutation.
2. `evidence/` may request bounded Authority reads for referenced objects but
   imports no Authority mutation capability.
3. `agent/` receives separate Authority-read, Graph-read and Draft-write ports;
   it cannot name or structurally access promotion methods.
4. `workbench/` may compose ports and join projections; it cannot interpret
   Claim truth or manufacture Authority status.
5. `completed`, `succeeded`, `failed`, `uncertain`, `committed`, `approved`,
   `present`, `missing`, and digest verification come from Authority projections.
6. `supported`, `contradicted`, `stale`, `disputed`, `gap`, promotion state and
   graph revision come from Evidence Graph projections.
7. Graph node DTOs carry an optional `AuthorityReceiptRef`, not a cached status
   presented as live truth. Workbench resolves refs through Authority reads.
8. A broad `UiKernelTransport` may exist only at the application composition
   root. Semantic modules receive explicit capability objects and never cast.
9. Old tests tied to `AgentSurfaceView`, `SurfaceView`, `DomainSurfaceView`
   semantic inference, `EvidenceClaim`, or `EvidenceReadTransport` are deleted.
10. Visual values remain in tokenized files under `desktop/ui/src/styles/`.

## Contracts and ports

### Authority

```ts
interface AuthorityReadPort {
  listReceipts(request): Promise<AuthorityReceiptPage>
  resolveRefs(request): Promise<AuthorityObservation[]>
}

interface AuthorityProjectPort {
  loadProjectRevision(): Promise<ProjectRevisionProjection>
  subscribeInvalidated(listener): Unsubscribe
}
```

Convenience methods such as `verifyRunReceipt`, `verifyArtifactReceipt`, and
`verifySourceAnchor` are thin typed calls over `resolveRefs`; they do not read
the graph.

### Evidence Graph

```ts
interface EvidenceGraphReadPort {
  health()
  listClaims()
  getClaimTrace(claimId)
  getSubgraph(request)
  listGaps(request)
  traceArtifact(artifactId)
  listAgentTurnEvidence(turnId)
}

interface EvidenceDraftPort {
  createDraftClaim(request)
  reviseDraftClaim(request)
  createDraftLink(request)
  retireDraft(request)
}

interface EvidencePromotionPort {
  promoteDraft(request)
  retirePromotedRecord(request)
}
```

Graph reads return nodes, edges, gaps, provenance refs and graph health. They do
not return a current Run/Artifact/Approval status. Promotion is provided only to
an explicit user/trusted-policy surface, never to Agent composition.

### Composition

```text
Graph query
  -> AuthorityReceiptRef[]
  -> AuthorityReadPort.resolveRefs()
  -> Workbench joins by (kind, authority_id)
  -> typed view model
  -> Evidence or Agent renderer
```

An unresolved ref stays `missing` or `unavailable` according to the Authority
response. The graph relation remains visible and is never erased or upgraded.

## Target modules

```text
app/workbench/
  WorkbenchRoot.tsx
  SurfaceFrame.tsx
  SurfaceRouter.tsx
  useWorkbenchProjection.ts
  authorityPorts.ts
  evidenceGraphPorts.ts

app/authority/
  AuthoritySurfaceRouter.tsx
  AuthorityStatus.tsx
  RunsSurface.tsx
  JobsSurface.tsx
  ArtifactsSurface.tsx
  ApprovalsSurface.tsx
  RevisionsSurface.tsx
  EnvironmentSurface.tsx

app/evidence/
  EvidenceSurfaceRouter.tsx
  ClaimsSurface.tsx
  ClaimTracePanel.tsx
  EvidenceGraphSurface.tsx
  EvidenceGapsSurface.tsx
  EvidenceNodeCard.tsx
  EvidenceEdgeList.tsx
  EvidenceGraphHealth.tsx

app/agent/
  AgentSurface.tsx
  AgentGoal.tsx
  AgentCurrentWork.tsx
  AgentActivity.tsx
  AgentApprovalPanel.tsx
  AgentEvidencePanel.tsx
  AgentGapPanel.tsx
  AgentFinalAnswer.tsx
```

Small related helpers may remain colocated, but `index.tsx` files do not own
semantic implementation and the three large historical files must materially
shrink rather than merely move.

## Surface contracts

### Authority surfaces

```text
rho.runs
rho.jobs
rho.artifacts
rho.approvals
rho.revisions
rho.environment
```

- Runs show canonical lifecycle status, terminal reason and revision refs.
- Jobs show scheduler/execution-owned state; the UI never guesses a Job by
  matching a Run request string.
- Artifacts show the canonical digest and byte identity from an Artifact receipt.
- Approvals show the exact effect digest, decision and expiry/consumption state.
- Revisions show project/state revision from the owning projection.
- Environment shows desired/realization identity and operation receipts; it does
  not claim scientific support.

If an owner does not yet publish a required projection, the surface says that
the Authority projection is unavailable. It does not substitute a heuristic.

### Evidence surfaces

```text
rho.claims
rho.evidence-graph
rho.evidence-gaps
rho.claim-trace
```

- Claims own drafts and explicit user promotion intent.
- Graph shows bounded topology and relationship status.
- Gaps shows deterministic gap projections and their basis.
- Claim Trace explains one Claim, preserves support and contradiction, and
  independently resolves every Authority ref shown beside it.

### Agent surface

```text
Goal
Current Work
Activity
Approvals
Cited Evidence
Gaps / Uncertainty
Final Answer
```

The final answer and its support are siblings, not one inferred status. An
answer can be complete while its evidence is missing, stale, conflicting or
unavailable. The only Evidence mutation available to Agent UI is a draft.

## Deletion contract

Delete rather than wrap:

```text
AgentSurfaceView.tsx
SurfaceView.tsx
WorkbenchApp.tsx
AgentSurfaceVNext.tsx
transport/evidence.ts
transport/generated/evidence.ts
EvidenceClaim / EvidenceEntry / EvidenceReadTransport
rho.evidence / rho.render-jobs semantic aliases
generic Authority/Evidence branches in DomainSurfaceView
renderer status dictionaries used to classify Authority or Graph truth
```

Already deleted paths stay deleted. A new alias with the old behavior is a
regression even if it has a new filename.

## Work packages

| ID | Status | Depends on | Outcome |
| --- | --- | --- | --- |
| `FE-00` | done | `EG-05` | current frontend audit and this contract |
| `FE-01` | done | `FE-00` | separate Authority/Graph/Draft/Promotion DTOs and runtime ports; remove graph-carried Authority status and mega-port casts |
| `FE-02` | done | `FE-01` | Workbench creates explicit capability objects and joins live Authority observations with graph refs |
| `FE-03` | done | `FE-02` | split typed Authority surfaces; remove Run-string and Artifact-provenance inference |
| `FE-04` | done | `FE-02`, `FE-03` | Evidence surfaces render graph semantics plus separately resolved Authority facts |
| `FE-05` | done | `FE-02`, `FE-04` | split Agent Goal, Current Work, Activity, Approval, Evidence, Gaps and Final Answer |
| `FE-06` | done | `FE-05` | shrink WorkbenchRoot/SurfaceFrame, delete dead generic semantic machinery and old tests |
| `FE-07` | done | `FE-06` | architecture guards for narrow ports, import direction, status vocabulary and no Agent promotion |
| `FE-08` | done | `FE-07` | focused local component/integration smoke, production build and current docs |

## Minimal verification policy

During implementation, run only the check that can falsify the current cut:

```text
contract/transport edit  -> generated facet check + TypeScript typecheck
component extraction     -> that component's Vitest file
router composition       -> one SurfaceRouter/Workbench focused test
Rust DTO change          -> rho-ui-contract library test + binding generation
package exit             -> typecheck + lint + focused frontend suite
program closure          -> one desktop integration smoke + frontend/Rust build + governance
```

Do not repair legacy App/Agent behavior tests to preserve an old component
shape. Full workspace, release, visual and cross-platform gates stay deferred
unless the user explicitly reintroduces them.

## Acceptance

1. Authority and Graph transports are distinct generated/runtime facets.
2. No production semantic component accepts or casts `UiKernelTransport`.
3. Graph node projections contain refs but no live Authority status.
4. Run/Artifact/Approval labels shown as facts come from Authority responses.
5. supported/contradicted/stale/gap labels come from graph DTO fields only.
6. Agent source has no promotion method or promotion-capable object.
7. An unavailable Authority resolver does not remove graph relations or turn a
   Run into failed; an unavailable graph does not change Authority facts.
8. The six Authority and four Evidence Surface IDs route only to their typed
   families; DomainSurfaceView remains generic and non-semantic.
9. The target component files exist and the historical monoliths materially
   shrink or disappear.
10. Local production frontend and desktop builds complete.

## Completion audit

- [x] No graph DTO or Graph-read response carries a live Authority status.
- [x] No semantic module accepts/casts the mega transport.
- [x] Authority surfaces use owner projections and contain no status heuristic.
- [x] Evidence surfaces resolve Authority refs separately when current facts are shown.
- [x] Agent receives Authority read + Graph read + Draft write only.
- [x] Agent Activity and Approvals are separate modules.
- [x] Workbench composes and routes but does not interpret scientific truth.
- [x] Architecture guards prove all six vocabulary/import/capability rules.
- [x] Old semantic modules, aliases, mocks and implementation-bound tests remain absent.
- [x] Focused local checks and builds pass; release/visual/cross-platform gates remain explicitly deferred.
