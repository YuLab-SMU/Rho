import { requireThat } from '@rho-workspace/plugin-contracts';
// v1 is an observation bridge for retained requests, not a second capability
// catalog. Do not quietly change its resource kinds or strict descriptors.
export function legacyResponse(value: any): any {
  if (Array.isArray(value)) return value.map(legacyResponse);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, legacyResponse(v)]));
  if (value.id && value.version && value.owner && value.kind && value.coverage && value.provenance) {
    requireThat(['file', 'table', 'plot', 'model'].includes(value.kind), 'unavailable', 'This resource requires the v2 descriptor; retained v1 resources remain readable.');
    delete result.format;
  }
  if (value.resource && Array.isArray(value.entities) && value.at) delete result.namespace;
  if (value.operationId && value.core && value.plan) delete result.plan.completion;
  return result;
}
