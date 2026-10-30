import { answerBoard, boardLimits } from './answer-board.js';
import type { GraphNode, WorkGraph } from './work-graph.js';
import type { LayoutNode, LayoutTree } from './shell-layout.js';
import { projectNotesPath } from './project-notes.js';

// Studio's layout for one conversation, written from what each file is to the work rather than
// from when the Agent touched it. The roles are the answer board's: the data it read, the
// scripts that were run, the results and reports they made. Each role has one place, in the
// order the work flows: inputs above the code, the commands that ran it below, results beside
// them, figures above the tables and reports. A file has one view, whichever version is shown; the structure changes only when a role
// first appears. The person's own arrangement, once saved, is kept: files that were already
// there when they arranged it are not put back, and later files join their role's place.
export type StudioRole = 'input' | 'code' | 'result' | 'report';
export interface StudioVersion { resource: { id: string; version: string }; at: number }
export interface StudioFile {
  path: string; title: string; role: StudioRole; category: string | null;
  // Whether an answer led with it, when the work first had the file, and every version it
  // kept, oldest first.
  lead: boolean; first: number; versions: StudioVersion[];
}
// The protected resource is the screen: past these, a role's further files stay in the list of
// the step they belong to, and Files keeps them all.
export const studioLimits = { input: 3, code: 3, result: 6, report: 2 };
export const studioIds = { root: 'studio', left: 'studio-left', input: 'studio-input', code: 'studio-code', commands: 'studio-commands', right: 'studio-right', figures: 'studio-figures', result: 'studio-result', console: 'studio-console', session: 'studio-session' };
const unlimited = { supporting: 64, method: 64, run: 64, input: 64, report: 64 } satisfies typeof boardLimits;
const rank: Record<StudioRole, number> = { code: 0, result: 1, report: 2, input: 3 };

function versionsOf(graph: WorkGraph, path: string): StudioVersion[] {
  const seen = new Map<string, StudioVersion>();
  for (const node of graph.nodes) {
    if (node.kind !== 'file' || node.path !== path) continue;
    const all = node.versions?.length ? node.versions : node.resource ? [{ resource: node.resource, capturedAt: node.capturedAt ?? node.at }] : [];
    for (const v of all) {
      const key = v.resource.id + '@' + v.resource.version;
      if (!seen.has(key)) seen.set(key, { resource: { id: v.resource.id, version: v.resource.version }, at: v.capturedAt });
    }
  }
  return [...seen.values()].sort((a, b) => a.at - b.at);
}

// Roles come from the whole record: what each file turned out to be to the work. A replay then
// only decides when a file joins and which of its versions shows, so a result read back by the
// Agent mid-way is still a result, as the work went on to show. Within a role a result an answer
// led with comes first, then files in the order the work first had them, so views keep their
// places while the work goes on.
export function studioFiles(graph: WorkGraph): StudioFile[] {
  const found = new Map<string, StudioFile>();
  const firstOf = (path: string) => Math.min(...graph.nodes.filter(n => n.path === path).flatMap(n => [n.at, ...n.events.map(e => e.at)]));
  const take = (node: GraphNode, role: StudioRole, lead: boolean) => {
    // The project's notes have their own panel beside every Studio, so they take no place here.
    if (!node.path || node.path === projectNotesPath) return;
    const known = found.get(node.path);
    if (known && rank[known.role] < rank[role]) return;
    if (known && known.role === role) { known.lead ||= lead; return; }
    found.set(node.path, { path: node.path, title: node.title, role, category: node.category ?? null, lead, first: firstOf(node.path), versions: versionsOf(graph, node.path) });
  };
  for (const turn of [...graph.turns].sort((a, b) => a.start - b.start)) {
    const board = answerBoard(graph, turn.id, unlimited);
    for (const item of board?.items ?? []) {
      const role: StudioRole | null = item.role === 'method' ? 'code' : item.role === 'primary' || item.role === 'supporting' ? 'result' : item.role === 'report' ? 'report' : item.role === 'input' ? 'input' : null;
      if (role) take(item.node, role, item.role === 'primary');
    }
  }
  return [...found.values()].sort((a, b) => rank[a.role] - rank[b.role] || Number(b.lead) - Number(a.lead) || a.first - b.first || a.path.localeCompare(b.path));
}

// The files as they stood at a moment: those the work had by then, each with the versions kept
// by then. Null is now.
export function studioAt(files: StudioFile[], at: number | null): StudioFile[] {
  if (at === null) return files;
  return files.filter(f => f.first <= at).map(f => ({ ...f, versions: f.versions.filter(v => v.at <= at) }));
}

const group = (id: string, children: string[]): LayoutNode => ({ id, kind: 'group', children });
const split = (id: string, axis: 'horizontal' | 'vertical', parts: Array<{ id: string; weight: number }>): LayoutNode =>
  ({ id, kind: 'group', children: parts.map(p => p.id), presentation: { mode: 'split', axis, weights: parts.map(p => p.weight) } });

// The arrangement the roles call for, from nothing. A figure is drawn at its own size, so the
// figures have their own place above the tables and reports that scroll.
// The cells the Agent ran in a live session share the commands' place, as another way it ran code.
export function studioTree(views: Array<{ role: StudioRole; node: LayoutNode; figure?: boolean }>, commands: LayoutNode | null, session: LayoutNode | null = null): LayoutTree | null {
  const nodes: LayoutNode[] = [];
  const region = (id: string, members: LayoutNode[]) => { if (!members.length) return null; nodes.push(group(id, members.map(m => m.id)), ...members); return id; };
  const of = (role: StudioRole) => views.filter(v => v.role === role).slice(0, studioLimits[role]);
  const column = (id: string, parts: Array<{ id: string; weight: number } | null>) => {
    const present = parts.filter((p): p is { id: string; weight: number } => !!p);
    if (present.length < 2) return present[0]?.id ?? null;
    nodes.push(split(id, 'vertical', present)); return id;
  };
  const input = region(studioIds.input, of('input').map(v => v.node)), code = region(studioIds.code, of('code').map(v => v.node));
  const run = region(studioIds.commands, [commands, session].filter((n): n is LayoutNode => !!n));
  const made = [...of('result'), ...of('report')];
  const figures = region(studioIds.figures, made.filter(v => v.figure).map(v => v.node)), result = region(studioIds.result, made.filter(v => !v.figure).map(v => v.node));
  const leftId = column(studioIds.left, [input ? { id: input, weight: 1 } : null, code ? { id: code, weight: 1.8 } : null, run ? { id: run, weight: 1.2 } : null]);
  const rightId = column(studioIds.right, [figures ? { id: figures, weight: 1.25 } : null, result ? { id: result, weight: 1 } : null]);
  if (leftId && rightId) { nodes.push(split(studioIds.root, 'horizontal', [{ id: leftId, weight: 1 }, { id: rightId, weight: 1.3 }])); return { rootId: studioIds.root, nodes }; }
  const only = leftId ?? rightId;
  return only ? { rootId: only, nodes } : null;
}

// The person's saved arrangement with the work's later files added by role, and every view of
// a file showing the version derived for it now. `known` says which views the person had seen
// placed when they arranged it; those they closed stay closed.
export function studioMerge(saved: LayoutTree, derived: LayoutTree, known: (viewId: string) => boolean): LayoutTree {
  const nodes = structuredClone(saved.nodes) as LayoutNode[];
  let rootId = saved.rootId;
  const byId = (id: string) => nodes.find(n => n.id === id);
  const fresh = new Map(derived.nodes.filter(n => n.kind === 'view').map(n => [n.id, n]));
  // A view the work also derives shows what the work has now.
  for (const node of nodes) { const now = node.kind === 'view' ? fresh.get(node.id) : undefined; if (now) { node.bindings = now.bindings; node.props = now.props; } }
  for (const [id, view] of fresh) {
    if (byId(id) || known(id)) continue;
    const home = derived.nodes.find(n => n.kind === 'group' && n.children?.includes(id))!;
    let target = byId(home.id);
    if (!target || target.kind !== 'group' || target.presentation?.mode === 'split') {
      // The role's place was closed: it opens again beside what the person kept.
      target = group(home.id, []); nodes.push(target);
      const root = byId(rootId)!;
      if (root.presentation?.mode === 'split' && root.presentation.axis === 'horizontal') { root.children = [...root.children!, target.id]; root.presentation = { ...root.presentation, weights: [...(root.presentation.weights ?? root.children.slice(1).map(() => 1)), 1] }; }
      else { let wrap = 'studio-wrap', n = 1; while (byId(wrap)) wrap = 'studio-wrap-' + ++n; nodes.push(split(wrap, 'horizontal', [{ id: rootId, weight: 1 }, { id: target.id, weight: 1 }])); rootId = wrap; }
    }
    target.children = [...target.children!, id];
    nodes.push(view);
  }
  return { rootId, nodes };
}
