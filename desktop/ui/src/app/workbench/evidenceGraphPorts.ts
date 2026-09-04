import type { AuthorityReadTransport } from "../../transport/authority";
import type {
  EvidenceDraftTransport,
  EvidenceGraphAdminTransport,
  EvidenceGraphReadTransport,
  EvidencePromotionTransport,
} from "../../transport/evidence-graph";

export interface EvidenceGraphPorts {
  readonly authority: AuthorityReadTransport;
  readonly graph: EvidenceGraphReadTransport & EvidenceGraphAdminTransport;
  readonly draft: EvidenceDraftTransport;
  readonly promotion: EvidencePromotionTransport;
}

type EvidencePortSource = AuthorityReadTransport
  & EvidenceGraphReadTransport
  & EvidenceGraphAdminTransport
  & EvidenceDraftTransport
  & EvidencePromotionTransport;

const cache = new WeakMap<object, EvidenceGraphPorts>();

export function createEvidenceGraphPorts(source: EvidencePortSource): EvidenceGraphPorts {
  const cached = cache.get(source as object);
  if (cached != null) return cached;
  const ports: EvidenceGraphPorts = {
    authority: {
      resolveAuthorityRefs: (request) => source.resolveAuthorityRefs(request),
      listAuthorityReceipts: (request) => source.listAuthorityReceipts(request),
    },
    graph: {
      getEvidenceGraphHealth: () => source.getEvidenceGraphHealth(),
      listClaims: (request) => source.listClaims(request),
      getClaimTrace: (claimId) => source.getClaimTrace(claimId),
      getEvidenceSubgraph: (request) => source.getEvidenceSubgraph(request),
      listEvidenceGaps: (request) => source.listEvidenceGaps(request),
      traceArtifact: (artifactId) => source.traceArtifact(artifactId),
      listAgentTurnEvidence: (turnId) => source.listAgentTurnEvidence(turnId),
      refreshEvidenceGraph: () => source.refreshEvidenceGraph(),
      snapshotEvidenceGraph: () => source.snapshotEvidenceGraph(),
    },
    draft: {
      createDraftClaim: (request) => source.createDraftClaim(request),
      reviseDraftClaim: (request) => source.reviseDraftClaim(request),
      createDraftLink: (request) => source.createDraftLink(request),
      retireDraft: (request) => source.retireDraft(request),
    },
    promotion: {
      promoteDraft: (request) => source.promoteDraft(request),
      retirePromotedRecord: (request) => source.retirePromotedRecord(request),
    },
  };
  cache.set(source as object, ports);
  return ports;
}
