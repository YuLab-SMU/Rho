import path from 'node:path';
import { atomicJson, canonical, digest, now, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import type { Project } from './state.js';
export const compositionLimits = { maxNodes: 256, maxUndo: 32, maxReceipts: 256, maxBytes: 32 * 1024 * 1024 };
const format = 'rho.composition/1';
const identity = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(s);
export class Compositions {
  limits: typeof compositionLimits;
  constructor(public project: Project, public validateViews: (views: any[], retained: any[]) => Promise<any>, limits: Partial<typeof compositionLimits> = {}) { this.limits = { ...compositionLimits, ...limits }; }
  private async file(id: string) {
    requireThat(identity(id), 'invalid', 'Invalid composition identity.');
    return path.join(await stateDirectory(this.project.root, '.rho/rho/compositions'), digest(id) + '.json');
  }
  validate(c: any) {
    requireThat(c.format === format && Array.isArray(c.nodes) && c.nodes.length > 0 && c.nodes.length <= this.limits.maxNodes, 'invalid', 'Choose a bounded structured composition.');
    const nodes = new Map<string, any>();
    for (const n of c.nodes) {
      requireThat(identity(n.id) && !nodes.has(n.id) && ['group', 'view'].includes(n.kind), 'invalid', 'Nodes need unique stable identities and group/view kinds.');
      requireThat(n.kind === 'group' ? Array.isArray(n.children) && new Set(n.children).size === n.children.length : typeof n.component === 'string' && typeof n.version === 'string' && n.props && n.bindings && !n.children, 'invalid', 'Invalid group or view contract.');
      if (n.kind === 'group' && n.presentation) requireThat(n.presentation.mode === 'tabs' || n.presentation.mode === 'split' && ['horizontal', 'vertical'].includes(n.presentation.axis) && n.presentation.weights?.length === n.children.length && n.presentation.weights.every((x: number) => Number.isFinite(x) && x > 0 && x <= 100), 'invalid', 'Split weights must match their group children.');
      if (n.kind === 'view' && n.presentation) requireThat(['normal', 'highlight'].includes(n.presentation.emphasis), 'invalid', 'View emphasis must use the selected presentation profile.');
      nodes.set(n.id, n);
    }
    const reached = new Set<string>();
    const walk = (id: string) => {
      const n = nodes.get(id);
      requireThat(n && !reached.has(id), 'invalid', 'Composition must be a single-parent, acyclic, fully referenced tree.');
      reached.add(id);
      if (n.kind === 'group') n.children.forEach(walk);
    };
    walk(c.rootId);
    requireThat(reached.size === nodes.size && nodes.get(c.rootId)?.kind === 'group', 'invalid', 'Every node must be reachable from the root group.');
  }
  private ancestors(c: any, id: string): string[] {
    const result: string[] = [];
    let child = id;
    for (;;) {
      const parent = c.nodes.find((n: any) => n.kind === 'group' && n.children.includes(child));
      if (!parent) return result;
      result.unshift(parent.id); child = parent.id;
    }
  }
  private protect(current: any, next: any) {
    for (const v of current.nodes.filter((n: any) => n.kind === 'view' && n.protected)) {
      const n = next.nodes.find((n: any) => n.id === v.id);
      requireThat(n && n.kind === 'view' && n.component === v.component && n.version === v.version && canonical(n.bindings) === canonical(v.bindings) && canonical(this.ancestors(current, v.id)) === canonical(this.ancestors(next, v.id)), 'condition', 'A protected view cannot be closed, moved, replaced or rebound.', { viewId: v.id });
      // Reordering any ancestor is movement too. Ignore unrelated siblings
      // inserted/removed before it, but preserve the order of retained siblings.
      for (const id of [...this.ancestors(current, v.id), v.id]) {
        const oldNode = current.nodes.find((n: any) => n.id === id), newNode = next.nodes.find((n: any) => n.id === id);
        requireThat(canonical(oldNode?.presentation ?? null) === canonical(newNode?.presentation ?? null), 'condition', 'Protected view presentation and ancestor geometry cannot change.', { viewId: v.id });
        const before = current.nodes.find((n: any) => n.children?.includes(id));
        const after = next.nodes.find((n: any) => n.children?.includes(id));
        if (before && after) {
          const retained = before.children.filter((x: string) => after.children.includes(x));
          requireThat(canonical(retained) === canonical(after.children.filter((x: string) => retained.includes(x))), 'condition', 'A protected view ancestor cannot be reordered.', { viewId: v.id });
        }
      }
    }
  }
  async read(id: string) { return readJson<any>(await this.file(id)); }
  async transact(body: any, author: string, kind: 'apply' | 'undo' | 'protect' = 'apply') {
    requireThat(identity(body.changeId) && Number.isSafeInteger(body.expectedVersion) && body.expectedVersion >= 0, 'invalid', 'Conditional version and stable changeId are required.');
    const file = await this.file(body.compositionId);
    const current = await readJson<any>(file, null);
    const requestDigest = digest(canonical({ kind, body, author }));
    const old = current?.receipts?.find((r: any) => r.changeId === body.changeId);
    if (old) {
      requireThat(old.requestDigest === requestDigest, 'conflict', 'changeId already names different content or author.');
      return { ...current, receipt: old };
    }
    requireThat((current?.version ?? 0) === body.expectedVersion, 'stale', 'Composition version changed. Missing receipts do not authorize replay.', { actualVersion: current?.version ?? 0, retainedFromVersion: current?.retainedFromVersion });
    const previous = current?.format === format ? current : { format, rootId: '', nodes: [] };
    let next = structuredClone(previous);
    const snapshot = (c: any) => ({ rootId: c.rootId, nodes: c.nodes });
    let history = current?.history ?? [];
    if (kind === 'undo') {
      requireThat(history.length, 'condition', 'No retained layout transaction can be undone.');
      next = { ...next, ...structuredClone(history.at(-1).snapshot) }; history = history.slice(0, -1);
      for (const n of next.nodes) {
        const existing = previous.nodes.find((v: any) => v.id === n.id);
        if (n.kind === 'view') n.protected = existing?.protected ?? false;
      }
    } else if (kind === 'protect') {
      requireThat(typeof body.protected === 'boolean', 'invalid', 'Protection must be explicit.');
      const view = next.nodes.find((n: any) => n.id === body.viewId && n.kind === 'view');
      requireThat(view, 'not_found', 'View is not present.'); view.protected = body.protected;
    } else {
      requireThat(Array.isArray(body.operations) && body.operations.length > 0 && body.operations.length <= this.limits.maxNodes, 'invalid', 'Supply a bounded atomic operation batch.');
      for (const op of body.operations) {
        const node = next.nodes.find((n: any) => n.id === op.id);
        const containsProtected = node && [node.id, ...next.nodes.filter((n: any) => this.ancestors(next, n.id).includes(node.id)).map((n: any) => n.id)].some(id => next.nodes.find((n: any) => n.id === id)?.protected);
        if (['move', 'remove', 'bind'].includes(op.op)) requireThat(!containsProtected, 'condition', 'A protected view or its ancestor cannot be moved, closed or rebound.');
        if (op.op === 'replace') {
          requireThat(body.operations.length === 1, 'invalid', 'Full replacement must be the only operation.');
          next.rootId = op.rootId; next.nodes = structuredClone(op.nodes);
          requireThat(Array.isArray(next.nodes) && next.nodes.every((n: any) => !n.protected || previous.nodes.some((p: any) => p.id === n.id && p.protected)), 'condition', 'Set protection through view.protection.set.');
          this.validate(next);
          for (const n of next.nodes) if (n.kind === 'view') n.protected = previous.nodes.find((p: any) => p.id === n.id)?.protected ?? false;
        } else if (op.op === 'insert' || op.op === 'move') {
          const parent = next.nodes.find((n: any) => n.id === op.parentId);
          requireThat(parent?.kind === 'group' && Number.isSafeInteger(op.index) && op.index >= 0 && op.index <= parent.children.length, 'invalid', 'Choose a group parent and valid insertion index.');
          if (op.op === 'insert') {
            requireThat(op.node && !next.nodes.some((n: any) => n.id === op.node.id) && !op.node.protected && (op.node.kind !== 'group' || op.node.children?.length === 0), 'invalid', 'Insert one new unprotected leaf or empty group.');
            next.nodes.push(structuredClone(op.node)); parent.children.splice(op.index, 0, op.node.id);
          } else {
            requireThat(node && node.id !== next.rootId && node.id !== parent.id && !this.ancestors(next, parent.id).includes(node.id), 'invalid', 'Movement would create a cycle or move the root.');
            for (const n of next.nodes) if (n.kind === 'group') n.children = n.children.filter((id: string) => id !== node.id);
            parent.children.splice(op.index, 0, node.id);
          }
        } else if (op.op === 'remove') {
          requireThat(node && node.id !== next.rootId, 'invalid', 'Cannot remove an absent node or root.');
          const ids = next.nodes.filter((n: any) => n.id === node.id || this.ancestors(next, n.id).includes(node.id)).map((n: any) => n.id);
          next.nodes = next.nodes.filter((n: any) => !ids.includes(n.id));
          for (const n of next.nodes) if (n.kind === 'group') n.children = n.children.filter((id: string) => !ids.includes(id));
        } else if (op.op === 'props' || op.op === 'bind') {
          requireThat(node?.kind === 'view', 'invalid', 'Select an existing view.');
          if (op.op === 'props') node.props = structuredClone(op.props); else node.bindings = structuredClone(op.bindings);
        } else requireThat(false, 'invalid', 'Unknown composition operation.');
        this.validate(next);
      }
      if (previous.nodes.length) history = [...history, { version: current.version, snapshot: snapshot(previous) }].slice(-this.limits.maxUndo);
    }
    this.validate(next);
    if (kind !== 'protect' && previous.nodes.length) this.protect(previous, next);
    const views = next.nodes.filter((n: any) => n.kind === 'view').map(({ kind, protected: protection, ...v }: any) => v);
    const availability = await this.validateViews(views, [...(previous.views ?? []), ...(kind === 'undo' ? current.history.flatMap((h: any) => h.snapshot.nodes.filter((n: any) => n.kind === 'view')) : [])]);
    const receipt = { changeId: body.changeId, author, version: (current?.version ?? 0) + 1, requestDigest, at: now(), kind };
    const receipts = [...(current?.receipts ?? []), receipt].slice(-this.limits.maxReceipts);
    const result = { format, compositionId: body.compositionId, rootId: next.rootId, nodes: next.nodes, views, availability, version: receipt.version, author, acknowledgedAt: receipt.at, history, receipts, retainedFromVersion: receipts[0].version, undoRetainedFromVersion: history[0]?.version ?? receipt.version, receipt };
    requireThat(Buffer.byteLength(JSON.stringify(result) + '\n') <= this.limits.maxBytes, 'limit', 'Composition byte budget reached; existing state is preserved.', { limit: 'maxBytes', maximum: this.limits.maxBytes });
    await atomicJson(file, result); return result;
  }
}
