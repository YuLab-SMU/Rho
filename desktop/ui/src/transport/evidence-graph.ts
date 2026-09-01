import {
  createEvidenceGraphCommands,
  type ClaimTraceViewV1,
  type CreateDraftClaimRequestV1,
  type CreateDraftLinkRequestV1,
  type ClaimListRequestV1,
  type ClaimPageV1,
  type EvidenceGapListRequestV1,
  type EvidenceGapPageV1,
  type EvidenceGraphHealthViewV1,
  type EvidenceGraphInvoke,
  type EvidenceMutationViewV1,
  type EvidenceNodeId,
  type EvidencePromotionRequestV1,
  type EvidenceRetirementRequestV1,
  type EvidenceSubgraphRequestV1,
  type EvidenceSubgraphViewV1,
  type ReviseDraftClaimRequestV1,
} from "./generated/evidence-graph";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type EvidenceNode = DeepReadonly<ClaimTraceViewV1["claim"]>;
export type EvidenceEdge = DeepReadonly<ClaimTraceViewV1["edges"][number]>;
export type EvidenceGap = DeepReadonly<ClaimTraceViewV1["gaps"][number]>;
export type ClaimPage = DeepReadonly<ClaimPageV1>;
export type EvidenceGapPage = DeepReadonly<EvidenceGapPageV1>;
export type EvidenceSubgraph = DeepReadonly<EvidenceSubgraphViewV1>;
export type ClaimTrace = DeepReadonly<ClaimTraceViewV1>;
export type EvidenceGraphHealth = DeepReadonly<EvidenceGraphHealthViewV1>;
export type EvidenceMutation = DeepReadonly<EvidenceMutationViewV1>;
export type CreateDraftClaimRequest = DeepReadonly<CreateDraftClaimRequestV1>;
export type ReviseDraftClaimRequest = DeepReadonly<ReviseDraftClaimRequestV1>;
export type CreateDraftLinkRequest = DeepReadonly<CreateDraftLinkRequestV1>;
export type EvidencePromotionRequest = DeepReadonly<EvidencePromotionRequestV1>;
export type EvidenceRetirementRequest = DeepReadonly<EvidenceRetirementRequestV1>;

export interface EvidenceGraphReadTransport {
  getEvidenceGraphHealth(): Promise<EvidenceGraphHealth>;
  listClaims(request?: Partial<ClaimListRequestV1>): Promise<ClaimPage>;
  getClaimTrace(claimId: EvidenceNodeId): Promise<ClaimTrace>;
  getEvidenceSubgraph(request: EvidenceSubgraphRequestV1): Promise<EvidenceSubgraph>;
  listEvidenceGaps(request?: Partial<EvidenceGapListRequestV1>): Promise<EvidenceGapPage>;
  traceArtifact(artifactId: string): Promise<EvidenceSubgraph>;
  listAgentTurnEvidence(turnId: string): Promise<EvidenceSubgraph>;
}

export interface EvidenceDraftTransport {
  createDraftClaim(request: CreateDraftClaimRequest): Promise<EvidenceMutation>;
  reviseDraftClaim(request: ReviseDraftClaimRequest): Promise<EvidenceMutation>;
  createDraftLink(request: CreateDraftLinkRequest): Promise<EvidenceMutation>;
  retireDraft(request: EvidenceRetirementRequest): Promise<EvidenceMutation>;
}

export interface EvidencePromotionTransport {
  promoteDraft(request: EvidencePromotionRequest): Promise<EvidenceMutation>;
  retirePromotedRecord(request: EvidenceRetirementRequest): Promise<EvidenceMutation>;
}

export interface EvidenceGraphAdminTransport {
  refreshEvidenceGraph(): Promise<EvidenceGraphHealth>;
  snapshotEvidenceGraph(): Promise<EvidenceMutation>;
}

export type EvidenceGraphTransport = EvidenceGraphReadTransport
  & EvidenceDraftTransport
  & EvidencePromotionTransport
  & EvidenceGraphAdminTransport;

function assertContract<T extends { readonly contract: string }>(value: T): T {
  if (value.contract !== "rho.ui.evidence-graph.v1") {
    throw new Error(`Unsupported Evidence Graph contract: ${value.contract}`);
  }
  return value;
}

export function createTauriEvidenceGraphTransport(
  invoke: EvidenceGraphInvoke,
): EvidenceGraphTransport {
  const commands = createEvidenceGraphCommands(invoke);
  return {
    getEvidenceGraphHealth: async () => assertContract(await commands.evidenceGraphHealth()),
    listClaims: async (request = {}) => assertContract(await commands.evidenceListClaims({
      cursor: request.cursor ?? null,
      limit: request.limit ?? 100,
      include_drafts: request.include_drafts ?? false,
    })),
    getClaimTrace: async (claimId) => assertContract(
      await commands.evidenceGetClaimTrace(claimId),
    ),
    getEvidenceSubgraph: async (request) => assertContract(
      await commands.evidenceGetSubgraph(request),
    ),
    listEvidenceGaps: async (request = {}) => assertContract(
      await commands.evidenceListGaps({
        cursor: request.cursor ?? null,
        limit: request.limit ?? 100,
        include_resolved: request.include_resolved ?? false,
      }),
    ),
    traceArtifact: async (artifactId) => assertContract(
      await commands.evidenceTraceArtifact(artifactId),
    ),
    listAgentTurnEvidence: async (turnId) => assertContract(
      await commands.evidenceListAgentTurn(turnId),
    ),
    createDraftClaim: (request) => commands.evidenceCreateDraftClaim(
      request as CreateDraftClaimRequestV1,
    ),
    reviseDraftClaim: (request) => commands.evidenceReviseDraftClaim(
      request as ReviseDraftClaimRequestV1,
    ),
    createDraftLink: (request) => commands.evidenceCreateDraftLink(
      request as CreateDraftLinkRequestV1,
    ),
    retireDraft: (request) => commands.evidenceRetireDraft(
      request as EvidenceRetirementRequestV1,
    ),
    promoteDraft: (request) => commands.evidencePromoteDraft(
      request as EvidencePromotionRequestV1,
    ),
    retirePromotedRecord: (request) => commands.evidenceRetirePromoted(
      request as EvidenceRetirementRequestV1,
    ),
    refreshEvidenceGraph: async () => assertContract(await commands.evidenceRefresh()),
    snapshotEvidenceGraph: () => commands.evidenceSnapshot(),
  };
}
