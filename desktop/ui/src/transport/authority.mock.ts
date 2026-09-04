import type {
  AuthorityObservationViewV1,
  AuthorityReceiptSummaryV1,
} from "./generated/authority";
import type { AuthorityReadTransport } from "./authority";

const projectId = "project.mock";
const observedAt = "2026-08-31T20:00:05Z";

const observations: readonly AuthorityObservationViewV1[] = [{
  reference: { kind: "run", authority_id: "run:mock-1" },
  status: "succeeded",
  digest: null,
  project_revision: 4,
  state_revision: 3,
  observed_at: observedAt,
  limitations: [],
}, {
  reference: { kind: "artifact", authority_id: "artifact:mock-plot" },
  status: "present",
  digest: `sha256:${"a".repeat(64)}`,
  project_revision: 4,
  state_revision: 3,
  observed_at: observedAt,
  limitations: [],
}, {
  reference: { kind: "environment_snapshot", authority_id: "environment:mock-1" },
  status: "present",
  digest: `sha256:${"c".repeat(64)}`,
  project_revision: 4,
  state_revision: 3,
  observed_at: observedAt,
  limitations: [],
}];

const receipts: readonly AuthorityReceiptSummaryV1[] = observations.map((observation) => ({
  reference: observation.reference,
  status: observation.status,
  label: observation.reference.authority_id,
  digest: observation.digest,
  captured_at: observation.observed_at,
  related_refs: [],
}));

function key(reference: AuthorityObservationViewV1["reference"]) {
  return `${reference.kind}:${reference.authority_id}`;
}

export function createMockAuthorityTransport(): AuthorityReadTransport {
  const byReference = new Map(observations.map((observation) => [
    key(observation.reference),
    observation,
  ]));
  return {
    async resolveAuthorityRefs(request) {
      return request.references.map((reference) => structuredClone(
        byReference.get(key(reference)) ?? {
          reference,
          status: "missing" as const,
          digest: null,
          project_revision: null,
          state_revision: null,
          observed_at: observedAt,
          limitations: ["Mock Authority owner has no matching record."],
        },
      ));
    },
    async listAuthorityReceipts(request) {
      const items = receipts
        .filter((receipt) => receipt.reference.kind === request.kind)
        .slice(0, request.limit);
      return {
        project_id: projectId,
        items: structuredClone(items),
        next_cursor: request.cursor ?? 0,
        has_more: false,
      };
    },
  };
}
