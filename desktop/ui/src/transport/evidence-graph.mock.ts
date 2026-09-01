import type {
  EvidenceEdgeViewV1,
  EvidenceGapViewV1,
  EvidenceGraphHealthViewV1,
  EvidenceNodeViewV1,
} from "./generated/evidence-graph";
import type { EvidenceGraphTransport } from "./evidence-graph";

const contract = "rho.ui.evidence-graph.v1";
const projectId = "project.mock";

export function createMockEvidenceGraphTransport(): EvidenceGraphTransport {
  let graphRevision = 4;
  let nextId = 2;
  let nodes: EvidenceNodeViewV1[] = [
    {
      node_id: "claim:mock-1",
      kind: "claim",
      stable_key: "claim:mock-1",
      label: "Analysis uses a fixed seed",
      summary: "The analysis records deterministic RNG setup before sampling.",
      claim_kind: "scientific_claim",
      data_class: "project_internal",
      promotion_state: "promoted",
      status: "active",
      authority_ref: null,
      created_at: "2026-08-31T20:00:00Z",
      updated_at: "2026-08-31T20:00:00Z",
    },
    {
      node_id: "run:mock-1",
      kind: "run",
      stable_key: "run:mock-1",
      label: "Run mock-1",
      summary: null,
      claim_kind: null,
      data_class: "project_internal",
      promotion_state: "managed",
      status: "active",
      authority_ref: { kind: "run", authority_id: "run:mock-1" },
      created_at: "2026-08-31T20:00:01Z",
      updated_at: "2026-08-31T20:00:03Z",
    },
    {
      node_id: "artifact:mock-plot",
      kind: "artifact",
      stable_key: "artifact:mock-plot",
      label: "model-fit.png",
      summary: null,
      claim_kind: null,
      data_class: "project_internal",
      promotion_state: "managed",
      status: "active",
      authority_ref: { kind: "artifact", authority_id: "artifact:mock-plot" },
      created_at: "2026-08-31T20:00:02Z",
      updated_at: "2026-08-31T20:00:03Z",
    },
  ];
  let edges: EvidenceEdgeViewV1[] = [{
    edge_id: "edge:mock-support",
    from_node: "run:mock-1",
    to_node: "claim:mock-1",
    predicate: "supports",
    polarity: "support",
    status: "active",
    promotion_state: "promoted",
    provenance: { kind: "run", authority_id: "run:mock-1" },
    confidence: null,
    created_at: "2026-08-31T20:00:03Z",
    updated_at: "2026-08-31T20:00:03Z",
  }, {
    edge_id: "edge:mock-generated",
    from_node: "artifact:mock-plot",
    to_node: "run:mock-1",
    predicate: "generated_by",
    polarity: "neutral",
    status: "active",
    promotion_state: "managed",
    provenance: null,
    confidence: null,
    created_at: "2026-08-31T20:00:02Z",
    updated_at: "2026-08-31T20:00:02Z",
  }];
  const gaps: EvidenceGapViewV1[] = [{
    gap_id: "gap:mock-environment",
    subject_node: "run:mock-1",
    rule_id: "missing_environment",
    status: "open",
    basis: [{ key: "run_id", value: "run:mock-1" }],
    detected_revision: 4,
    resolved_revision: null,
    detected_at: "2026-08-31T20:00:04Z",
    resolved_at: null,
  }];

  const health = (): EvidenceGraphHealthViewV1 => ({
    contract,
    project_id: projectId,
    engine: "ladybug",
    available: true,
    schema_version: 1,
    graph_revision: graphRevision,
    authority_cursor: 3,
    last_ingest_success_at: "2026-08-31T20:00:03Z",
    last_ingest_error_code: null,
    error_code: null,
    message: null,
  });
  const mutation = (recordId: string) => ({ record_id: recordId, graph_revision: ++graphRevision });
  const subgraph = (rootNode: EvidenceNodeViewV1) => ({
    contract,
    project_id: projectId,
    root_node: structuredClone(rootNode),
    nodes: structuredClone(nodes.filter((node) => node.status !== "retired")),
    edges: structuredClone(edges.filter((edge) => edge.status !== "retired")),
    truncated: false,
  });

  return {
    async getEvidenceGraphHealth() {
      return health();
    },
    async listClaims(request = {}) {
      const claims = nodes.filter((node) =>
        node.kind === "claim"
        && node.status !== "retired"
        && (request.include_drafts === true || node.promotion_state === "promoted")
      );
      return {
        contract,
        project_id: projectId,
        items: structuredClone(claims.slice(0, request.limit ?? 100)),
        next_cursor: null,
        has_more: false,
      };
    },
    async getClaimTrace(claimId) {
      const claim = nodes.find((node) => node.node_id === claimId && node.kind === "claim");
      if (claim == null) throw new Error("Mock claim was not found.");
      return {
        contract,
        project_id: projectId,
        claim: structuredClone(claim),
        nodes: structuredClone(nodes.filter((node) => node.node_id !== claimId)),
        edges: structuredClone(edges),
        gaps: structuredClone(gaps),
        authority_refs: structuredClone(
          nodes.flatMap((node) => node.authority_ref == null ? [] : [node.authority_ref]),
        ),
        truncated: false,
      };
    },
    async getEvidenceSubgraph(request) {
      const root = nodes.find((node) => node.node_id === request.root_node);
      if (root == null) throw new Error("Mock graph root was not found.");
      return subgraph(root);
    },
    async listEvidenceGaps(request = {}) {
      const visible = gaps.filter((gap) => request.include_resolved === true || gap.status !== "resolved");
      return {
        contract,
        project_id: projectId,
        items: structuredClone(visible.slice(0, request.limit ?? 100)),
        next_cursor: null,
        has_more: false,
      };
    },
    async traceArtifact(artifactId) {
      const root = nodes.find((node) =>
        node.kind === "artifact" && (node.stable_key === artifactId || node.node_id === artifactId)
      );
      if (root == null) throw new Error("Mock artifact was not found.");
      return subgraph(root);
    },
    async listAgentTurnEvidence(turnId) {
      const root = nodes.find((node) =>
        node.kind === "agent_turn" && (node.stable_key === turnId || node.node_id === turnId)
      );
      if (root == null) throw new Error("Mock Agent turn was not found.");
      return subgraph(root);
    },
    async createDraftClaim(request) {
      const id = `claim:mock-${nextId++}`;
      nodes = [...nodes, {
        node_id: id,
        kind: "claim",
        stable_key: id,
        label: request.label,
        summary: request.summary,
        claim_kind: request.claim_kind,
        data_class: request.data_class,
        promotion_state: "draft",
        status: "active",
        authority_ref: null,
        created_at: "2026-08-31T20:00:05Z",
        updated_at: "2026-08-31T20:00:05Z",
      }];
      return mutation(id);
    },
    async reviseDraftClaim(request) {
      nodes = nodes.map((node) => node.node_id === request.claim_id ? {
        ...node,
        label: request.label,
        summary: request.summary,
        claim_kind: request.claim_kind,
      } : node);
      return mutation(request.claim_id);
    },
    async createDraftLink(request) {
      const id = `edge:mock-${nextId++}`;
      const polarity = request.predicate === "supports" || request.predicate === "cites"
        ? "support" as const
        : request.predicate === "contradicts" ? "conflict" as const : "neutral" as const;
      edges = [...edges, {
        edge_id: id,
        from_node: request.from_node,
        to_node: request.to_node,
        predicate: request.predicate,
        polarity,
        status: "active",
        promotion_state: "draft",
        provenance: request.provenance?.reference ?? null,
        confidence: request.confidence,
        created_at: "2026-08-31T20:00:05Z",
        updated_at: "2026-08-31T20:00:05Z",
      }];
      return mutation(id);
    },
    async retireDraft(request) {
      nodes = nodes.map((node) => node.node_id === request.record_id
        ? { ...node, promotion_state: "retired", status: "retired" }
        : node);
      edges = edges.map((edge) => edge.edge_id === request.record_id
        ? { ...edge, promotion_state: "retired", status: "retired" }
        : edge);
      return mutation(request.record_id);
    },
    async promoteDraft(request) {
      nodes = nodes.map((node) => node.node_id === request.record_id
        ? { ...node, promotion_state: "promoted" }
        : node);
      edges = edges.map((edge) => edge.edge_id === request.record_id
        ? { ...edge, promotion_state: "promoted" }
        : edge);
      return mutation(request.record_id);
    },
    async retirePromotedRecord(request) {
      return this.retireDraft(request);
    },
    async refreshEvidenceGraph() {
      graphRevision += 1;
      return health();
    },
    async snapshotEvidenceGraph() {
      return mutation(`snapshot:mock-${nextId++}`);
    },
  };
}
