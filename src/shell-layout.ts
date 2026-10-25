// DOM-free reading of a composition as the regions the shell draws. The owner's tree
// is the only layout source: split groups keep their axis and
// weights, tab groups keep their order. A split nested inside a tab group shows as that
// group's tabs, as before. Views the live layout added outside the tree (an opened result,
// an execution record) join the last tab group, in layout order.
import type { CompositionSummary, ViewDescription } from './browser.js';
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

// The selection channel of a view. Views bound to one table version share one channel, so
// a table and a chart of that version select the same entities and a sort or filter in one
// never changes what the other shows selected; any other view keeps a channel of its own.
// A new version is a new channel: a selection never migrates to different bytes.
export function selectionScope(view: { id: string; bindings?: Record<string, unknown> }): { kind: 'shared'; id: string } {
  const data = view.bindings?.data as { id?: unknown; version?: unknown } | undefined;
  const part = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  return typeof data?.id === 'string' && typeof data.version === 'string' ? { kind: 'shared', id: `linked:${part(data.id)}@${part(data.version)}` } : { kind: 'shared', id: view.id };
}

// Layout commands without dragging: each returns the owner tree
// after one change, or null when the change does not apply, so the shell can send it as one
// conditional replacement. A tab group is the node directly under a split (or the root) that
// holds a view's tabs; a pane left with one child collapses into it.
export interface LayoutNode { id: string; kind: 'group' | 'view'; children?: string[]; presentation?: { mode?: string; axis?: Axis; weights?: number[] }; [key: string]: unknown }
export interface LayoutTree { rootId: string; nodes: LayoutNode[] }
const isSplit = (node: LayoutNode | undefined) => node?.presentation?.mode === 'split';
const parentOf = (nodes: LayoutNode[], id: string) => nodes.find(n => n.kind === 'group' && n.children?.includes(id));
function tabOwner(nodes: LayoutNode[], viewId: string) {
  let id = viewId;
  for (;;) { const parent = parentOf(nodes, id); if (!parent || isSplit(parent)) return id; id = parent.id; }
}
function leaves(nodes: LayoutNode[], id: string): string[] {
  const node = nodes.find(n => n.id === id);
  return !node ? [] : node.kind === 'view' ? [id] : (node.children ?? []).flatMap(child => leaves(nodes, child));
}
// Groups left empty disappear, and a split left with one pane becomes that pane.
function tidy(tree: LayoutTree): LayoutTree {
  let nodes = tree.nodes, rootId = tree.rootId;
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) {
      if (node.kind !== 'group' || node.id === rootId) continue;
      const parent = parentOf(nodes, node.id)!;
      if (!node.children?.length) {
        const index = parent.children!.indexOf(node.id);
        parent.children = parent.children!.filter(id => id !== node.id);
        if (isSplit(parent)) parent.presentation = { ...parent.presentation, weights: (parent.presentation!.weights ?? []).filter((_, i) => i !== index) };
        nodes = nodes.filter(n => n.id !== node.id); changed = true; break;
      }
      if (isSplit(node) && node.children.length === 1) {
        const only = node.children[0]!;
        parent.children = parent.children!.map(id => id === node.id ? only : id);
        nodes = nodes.filter(n => n.id !== node.id); changed = true; break;
      }
    }
    const root = nodes.find(n => n.id === rootId);
    if (root && isSplit(root) && root.children?.length === 1) {
      const only = root.children[0]!, child = nodes.find(n => n.id === only)!;
      if (child.kind === 'group') { nodes = nodes.filter(n => n.id !== rootId); rootId = only; changed = true; }
    }
  }
  return { rootId, nodes };
}
const copy = (tree: LayoutTree): LayoutTree => ({ rootId: tree.rootId, nodes: structuredClone(tree.nodes) });
function detach(tree: LayoutTree, viewId: string) {
  const parent = parentOf(tree.nodes, viewId)!, index = parent.children!.indexOf(viewId);
  parent.children = parent.children!.filter(id => id !== viewId);
  if (isSplit(parent)) parent.presentation = { ...parent.presentation, weights: (parent.presentation!.weights ?? []).filter((_, i) => i !== index) };
}
// Takes a view out of the tabs it shares and shows it beside them along the axis.
export function splitView(tree: LayoutTree, viewId: string, axis: Axis, newId: (kind: string) => string): LayoutTree | null {
  if (!tree.nodes.some(n => n.id === viewId && n.kind === 'view') || !parentOf(tree.nodes, viewId)) return null;
  const owner = tabOwner(tree.nodes, viewId);
  if (owner === viewId || leaves(tree.nodes, owner).length < 2) return null;
  const next = copy(tree);
  detach(next, viewId);
  const pane: LayoutNode = { id: newId('group'), kind: 'group', children: [viewId] };
  next.nodes.push(pane);
  const holder = parentOf(next.nodes, owner);
  if (holder && isSplit(holder) && holder.presentation!.axis === axis) {
    const index = holder.children!.indexOf(owner), weights = [...(holder.presentation!.weights ?? holder.children!.map(() => 1))], half = (weights[index] ?? 1) / 2;
    holder.children!.splice(index + 1, 0, pane.id); weights.splice(index, 1, half, half);
    holder.presentation = { ...holder.presentation, weights };
  } else {
    const split: LayoutNode = { id: newId('split'), kind: 'group', children: [owner, pane.id], presentation: { mode: 'split', axis, weights: [1, 1] } };
    next.nodes.push(split);
    if (holder) holder.children = holder.children!.map(id => id === owner ? split.id : id); else next.rootId = split.id;
  }
  return tidy(next);
}
// The tab groups in reading order, as the shell draws them.
function owners(tree: LayoutTree): string[] {
  const out: string[] = [];
  const walk = (id: string, underSplit: boolean) => {
    const node = tree.nodes.find(n => n.id === id); if (!node) return;
    if (isSplit(node)) { for (const child of node.children ?? []) walk(child, true); return; }
    if (underSplit || id === tree.rootId) out.push(id);
  };
  walk(tree.rootId, false);
  return out;
}
// A linked result starts as a local view. A person's arrangement command can include
// that exact descriptor in its one conditional owner write. Never rebind a saved node
// which happens to reuse its id, or persist unrelated previews with the command.
export function placeView(tree: LayoutTree, view: ViewDescription, newId: (kind: string) => string): LayoutTree | null {
  const existing = tree.nodes.find(n => n.id === view.id);
  if (existing) return existing.kind === 'view' && existing.component === view.component && existing.version === view.version
    && JSON.stringify(existing.bindings) === JSON.stringify(view.bindings) ? tree : null;
  const next = copy(tree), target = owners(next).at(-1), node = next.nodes.find(n => n.id === target);
  if (!node) return null;
  next.nodes.push({ id: view.id, kind: 'view', component: view.component, version: view.version, props: structuredClone(view.props), bindings: structuredClone(view.bindings) });
  if (node.kind === 'group') node.children = [...(node.children ?? []), view.id];
  else {
    const tabs: LayoutNode = { id: newId('group'), kind: 'group', children: [node.id, view.id] };
    next.nodes.push(tabs);
    const holder = parentOf(next.nodes, node.id);
    if (holder) holder.children = holder.children!.map(id => id === node.id ? tabs.id : id);
    else next.rootId = tabs.id;
  }
  return next;
}
// Moves a view into the next (1) or previous (-1) tab group, as its last tab.
export function moveView(tree: LayoutTree, viewId: string, direction: 1 | -1, newId: (kind: string) => string): LayoutTree | null {
  if (!parentOf(tree.nodes, viewId)) return null;
  const groups = owners(tree), from = tabOwner(tree.nodes, viewId), target = groups[groups.indexOf(from) + direction];
  if (!target || target === from) return null;
  const next = copy(tree);
  detach(next, viewId);
  const node = next.nodes.find(n => n.id === target)!;
  if (node.kind === 'group') node.children = [...(node.children ?? []), viewId];
  else {
    const tabs: LayoutNode = { id: newId('group'), kind: 'group', children: [target, viewId] };
    next.nodes.push(tabs);
    const holder = parentOf(next.nodes, target)!;
    holder.children = holder.children!.map(id => id === target ? tabs.id : id);
  }
  return tidy(next);
}
// Closes a view: its node leaves the tree; its records, input and runs stay with their owners.
export function closeView(tree: LayoutTree, viewId: string): LayoutTree | null {
  if (!parentOf(tree.nodes, viewId)) return null;
  const next = copy(tree);
  detach(next, viewId);
  next.nodes = next.nodes.filter(n => n.id !== viewId);
  return tidy(next);
}
// Keeps a divider where the person left it.
export function resizeSplit(tree: LayoutTree, splitId: string, weights: number[]): LayoutTree | null {
  const node = tree.nodes.find(n => n.id === splitId);
  if (!isSplit(node) || node!.children!.length !== weights.length) return null;
  const next = copy(tree);
  const split = next.nodes.find(n => n.id === splitId)!;
  split.presentation = { ...split.presentation, weights: weights.map(w => Math.round(w * 1000) / 1000) };
  return next;
}
