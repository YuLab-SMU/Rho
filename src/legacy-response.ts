import { requireThat } from '@rho-workspace/plugin-contracts';
// v1 is an observation bridge for retained requests, not a second capability
// catalog. Do not quietly change its resource kinds or strict descriptors.
export function legacyResponse(value: any): any {
  if (Array.isArray(value)) return value.map(legacyResponse);
  if (!value || typeof value !== 'object') return value;
  if (value.compositionId && Array.isArray(value.views)) requireThat(!value.views.some((view: any) => Object.values<any>(view.bindings ?? {}).some(binding => binding.kind === 'live-document')), 'unavailable', 'Live document bindings require the v2 contract.');
  const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, legacyResponse(v)]));
  if (value.id && value.path && typeof value.content === 'string' && Array.isArray(value.undo)) {
    for (const key of ['revision', 'receipts', 'retainedFromRevision', 'pendingSave', 'receipt', 'history', 'historyRetainedFromVersion']) delete result[key];
    for (const entry of result.undo) delete entry.changeIds;
  }
  if (value.id && value.version && value.owner && value.kind && value.coverage && value.provenance) {
    requireThat(['file', 'table', 'plot', 'model'].includes(value.kind), 'unavailable', 'This resource requires the v2 descriptor; retained v1 resources remain readable.');
    delete result.format;
  }
  if (value.resource && Array.isArray(value.entities) && value.at) delete result.namespace;
  if (value.operationId && value.core && value.plan) delete result.plan.completion;
  return result;
}
