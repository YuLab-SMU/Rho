// DOM-free reading of a composition as the regions the shell draws (docs/WORKSPACE-PLAN.md
// W1). The owner's tree is the only layout source: split groups keep their axis and
// weights, tab groups keep their order. A split nested inside a tab group shows as that
// group's tabs, as before. Views the live layout added outside the tree (an opened result,
// an execution record) join the last tab group, in layout order.
import type { CompositionSummary } from './browser.js';
export type Axis = 'horizontal' | 'vertical';
export type Region =
  | { kind: 'split'; id: string; axis: Axis; weights: number[]; children: Region[] }
  | { kind: 'tabs'; id: string; views: string[] };

export function regions(composition: CompositionSummary): Region | null {
  const present = new Set(composition.views.map(v => v.id)), placed = new Set<string>();
  const nodes = new Map((composition.nodes ?? []).map(n => [n.id, n]));
  const leaves = (id: string): string[] => { const n = nodes.get(id); return !n ? [] : n.kind === 'view' ? (present.has(n.id) ? [n.id] : []) : n.children.flatMap(leaves); };
  const build = (id: string): Region | null => {
    const n = nodes.get(id);
    if (!n) return null;
    if (n.kind === 'view') { if (!present.has(n.id)) return null; placed.add(n.id); return { kind: 'tabs', id: 'tabs:' + n.id, views: [n.id] }; }
    const split = n.presentation?.mode === 'split' ? n.presentation as { axis: Axis; weights: number[] } : null;
    if (split) {
      const parts = n.children.map((child, i) => ({ region: build(child), weight: split.weights[i] ?? 1 })).filter(p => p.region);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0].region;
      return { kind: 'split', id: n.id, axis: split.axis, weights: parts.map(p => p.weight), children: parts.map(p => p.region!) };
    }
    const views = leaves(n.id); views.forEach(v => placed.add(v));
    return views.length ? { kind: 'tabs', id: n.id, views } : null;
  };
  let root = composition.rootId && nodes.size ? build(composition.rootId) : null;
  const rest = composition.views.map(v => v.id).filter(id => !placed.has(id));
  if (!rest.length) return root;
  if (!root) return { kind: 'tabs', id: 'tabs:root', views: rest };
  const groups = tabGroups(root), last = groups[groups.length - 1];
  root = replace(root, last.id, { ...last, views: [...last.views, ...rest] });
  return root;
}
export function tabGroups(region: Region): Extract<Region, { kind: 'tabs' }>[] {
  return region.kind === 'tabs' ? [region] : region.children.flatMap(tabGroups);
}
// Reading order: the narrow surface lists every view this way.
export function viewOrder(region: Region | null): string[] { return region ? tabGroups(region).flatMap(g => g.views) : []; }
export function groupOf(region: Region | null, viewId: string) { return region ? tabGroups(region).find(g => g.views.includes(viewId)) ?? null : null; }
function replace(region: Region, id: string, next: Region): Region {
  if (region.id === id) return next;
  return region.kind === 'split' ? { ...region, children: region.children.map(c => replace(c, id, next)) } : region;
}
// Moving one divider changes only its two neighbours; each keeps at least `floor` of the total.
export function resize(weights: number[], divider: number, delta: number, floor = 0.12): number[] {
  const total = weights.reduce((a, b) => a + b, 0), next = [...weights];
  const min = total * floor, pair = next[divider] + next[divider + 1];
  const left = Math.min(pair - min, Math.max(min, next[divider] + delta * total));
  next[divider] = left; next[divider + 1] = pair - left;
  return next;
}
