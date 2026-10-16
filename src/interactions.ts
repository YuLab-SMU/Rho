import path from 'node:path';
import { atomicJson, canonical, digest, now, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import type { ProjectPlugins } from './plugins.js';
import type { Project } from './state.js';
export const interactionLimits = { maxSelections: 128, maxSelectionBytes: 1024 * 1024, maxSelectionReceipts: 256 };
export class Interactions {
  limits: typeof interactionLimits;
  constructor(public project: Project, public owners: ProjectPlugins, limits: Partial<typeof interactionLimits> = {}) { this.limits = { ...interactionLimits, ...limits }; }
  private async file() { return path.join(await stateDirectory(this.project.root, '.rho/rho'), 'interactions.json'); }
  private key(scope: any, principal: string) {
    requireThat(scope && ['caller', 'view', 'shared'].includes(scope.kind), 'invalid', 'Select a caller, view or explicit shared channel.');
    if (scope.kind !== 'caller') requireThat(typeof scope.id === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(scope.id), 'invalid', 'Scope requires a stable identity.');
    return digest(canonical([scope, scope.kind === 'shared' ? null : principal]));
  }
  async list(principal: string, sharedOnly = false) {
    return (await readJson<any[]>(await this.file(), [])).filter(s => s.scope.kind === 'shared' || (!sharedOnly && s.author === principal));
  }
  async read(scope: any, principal: string) {
    const key = this.key(scope, principal);
    return (await readJson<any[]>(await this.file(), [])).find(s => s.key === key) ?? { key, scope, version: 0, selection: null };
  }
  async prepareRestore(imported: any[]) {
    const state = await readJson<any[]>(await this.file(), []), report = [];
    requireThat(Array.isArray(imported) && new Set(imported.map(s => s?.key)).size === imported.length, 'invalid', 'Archived selection channels must be unique.');
    for (const selection of imported) {
      requireThat(selection?.scope?.kind === 'shared' && selection.key === this.key(selection.scope, '') && Number.isSafeInteger(selection.version) && selection.version > 0 && Array.isArray(selection.receipts) && selection.receipts.length > 0 && selection.receipts.length <= this.limits.maxSelectionReceipts && selection.receipts.every((r: any, index: number) => r?.version === selection.version - selection.receipts.length + index + 1 && typeof r.changeId === 'string' && /^[a-f0-9]{64}$/.test(r.requestDigest)) && selection.retainedFromVersion === selection.receipts[0].version, 'invalid', 'Invalid archived shared selection or receipt boundary.');
      const old = state.find(s => s.key === selection.key);
      if (!old) state.push(selection);
      report.push({ key: selection.key, state: old && canonical(old) !== canonical(selection) ? 'conflict' : 'available' });
    }
    requireThat(state.length <= this.limits.maxSelections && Buffer.byteLength(JSON.stringify(state)) <= this.limits.maxSelectionBytes, 'limit', 'Shared selection restore budget reached.');
    return { state, report };
  }
  async set(b: any, principal: string) {
    const key = this.key(b.scope, principal), file = await this.file();
    const all = await readJson<any[]>(file, []), current = all.find(s => s.key === key);
    const requestDigest = digest(canonical({ b, principal }));
    const old = current?.receipts.find((r: any) => r.changeId === b.changeId);
    if (old) { requireThat(old.requestDigest === requestDigest, 'conflict', 'Selection changeId conflicts.'); return { ...current, receipt: old }; }
    requireThat((current?.version ?? 0) === b.expectedVersion, 'stale', 'Selection version changed.', { actualVersion: current?.version ?? 0 });
    requireThat(current || all.length < this.limits.maxSelections, 'limit', 'Selection retention is full.', { limit: 'maxSelections', maximum: this.limits.maxSelections });
    if (b.selection?.document) {
      const d = b.selection.document;
      await this.owners.need('documents').anchor(d.documentId, d.version, d.from, d.to);
    } else if (b.selection?.resource) {
      await this.owners.need('tables').anchor(b.selection.resource, b.selection.entities);
    } else requireThat(b.selection === null, 'invalid', 'Choose a document range, keyed entities or explicit null.');
    const receipt = { changeId: b.changeId, requestDigest, version: (current?.version ?? 0) + 1, author: principal, at: now() };
    const receipts = [...(current?.receipts ?? []), receipt].slice(-this.limits.maxSelectionReceipts);
    const result = { key, scope: b.scope, selection: b.selection, version: receipt.version, author: principal, receipts, retainedFromVersion: receipts[0].version, receipt };
    const next = [...all.filter(s => s.key !== key), result];
    requireThat(Buffer.byteLength(JSON.stringify(next)) <= this.limits.maxSelectionBytes, 'limit', 'Selection byte budget reached.', { limit: 'maxSelectionBytes', maximum: this.limits.maxSelectionBytes });
    await atomicJson(file, next); return result;
  }
}
