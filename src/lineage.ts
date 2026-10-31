// How the live values of one session were made, from what each cell recorded as it ran: the
// values it read (the names it mentions that the session held), the values it defined and the
// project files its strings named. Each cell that made something still there is a step holding
// what it made: its values, its plots and the files it wrote, with the project files it read.
// Links run into a step from the values and written files it read as they are now. A cell that changed a value it read (`m$x <- m$x * 2`)
// continues the cell that made that value, and reads what that one read. A value or file made
// again since a cell read it is named on the cell as read in an earlier version, not linked.
// Nothing here runs or reads code; it follows the kernel's records.
export interface LineageCell {
  cellId: string; number: number; state: string; code: string; purpose: string | null; plots: number;
  defined?: string[]; removed?: string[]; used?: string[]; files?: Array<{ path: string; how: 'read' | 'wrote' }>;
}
export type LineageKind = 'value' | 'file' | 'plot';
export interface LineageNode { id: string; kind: LineageKind; name: string; step: string }
export interface LineageStep {
  // A cell, or the values whose making is not in the cells kept.
  id: string; kind: 'cell' | 'earlier'; cell: LineageCell | null;
  // The cells whose values this one changed, oldest first.
  earlier: LineageCell[];
  // What it made, and the project files it read that no cell wrote.
  nodes: LineageNode[]; reads: string[];
  // Made by the newest finished cell; its record (or one it continues) has no reads; what it
  // read that was made again since.
  latest: boolean; unknownInputs: boolean; stale: string[];
  layer: number; order: number;
}
export interface LineageLink { from: string; to: string }
export interface Lineage { steps: LineageStep[]; links: LineageLink[]; layers: number; omitted: { values: number; plots: number; files: number } }
// The protected resource is the panel's drawing: at most this many values (the most recently
// made first), plots and written files (of the newest cells) are drawn; the rest are counted.
export const lineageLimits = { values: 60, plots: 8, files: 24 };

interface Input { name: string; from: LineageCell | undefined }
interface Read { path: string; writer: LineageCell | undefined }
// What a cell read itself, and for each value it changed, what that value had come from: the
// cells that made it before and what they read. A cell's own reads may have gone into any of
// what it made; what a value came from goes only with that value.
interface Origin { inputs: Input[]; files: Read[]; earlier: LineageCell[]; unknown: boolean }
interface Made extends Origin { carried: Map<string, Origin> }
const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map(i => [key(i), i])).values()];
const finished = (cells: LineageCell[]) => cells.filter(c => c.state !== 'queued' && c.state !== 'running').sort((a, b) => a.number - b.number);
const joined = (origins: Origin[]): Origin => ({
  inputs: unique(origins.flatMap(o => o.inputs), i => i.name + '@' + (i.from?.cellId ?? '')), files: unique(origins.flatMap(o => o.files), f => f.path + '@' + (f.writer?.cellId ?? '')),
  earlier: unique(origins.flatMap(o => o.earlier), c => c.cellId).sort((a, b) => a.number - b.number), unknown: origins.some(o => o.unknown) });

export function lineage(cells: LineageCell[], values: string[], limits = lineageLimits): Lineage {
  const ordered = finished(cells);
  // The session's history in order: who made each value and wrote each file at each point.
  const maker = new Map<string, LineageCell>(), writer = new Map<string, LineageCell>(), made = new Map<string, Made>();
  for (const cell of ordered) {
    const own = new Set(cell.defined ?? []), inputs: Input[] = [], carried = new Map<string, Origin>();
    const files: Read[] = (cell.files ?? []).filter(f => f.how === 'read').map(f => ({ path: f.path, writer: writer.get(f.path) }));
    for (const name of cell.used ?? []) {
      const from = maker.get(name), prior = own.has(name) && from ? made.get(from.cellId) : undefined;
      if (!prior) { inputs.push({ name, from }); continue; }
      const before = prior.carried.get(name);
      carried.set(name, joined([{ ...prior, earlier: [from!] }, ...before ? [before] : []]));
    }
    made.set(cell.cellId, { inputs, files, earlier: [], unknown: cell.used === undefined, carried });
    for (const name of cell.removed ?? []) maker.delete(name);
    for (const name of cell.defined ?? []) maker.set(name, cell);
    for (const file of cell.files ?? []) if (file.how === 'wrote') writer.set(file.path, cell);
  }
  const newest = ordered.at(-1) ?? null, recency = (cell: LineageCell | null | undefined) => cell?.number ?? 0;

  // What is drawn: the newest values, plots and written files, within the limits.
  const live = values.map(name => ({ name, cell: maker.get(name) ?? null })).sort((a, b) => recency(b.cell) - recency(a.cell));
  const kept = live.slice(0, limits.values), shown = new Set(kept.map(v => v.name));
  const plotting = ordered.filter(c => c.plots > 0), plotted = plotting.slice(-limits.plots);
  const steps = new Map<string, LineageStep>(), links = new Map<string, LineageLink>();
  const stepOf = (cell: LineageCell | null, kind: LineageStep['kind']) => {
    const id = cell ? 'cell:' + cell.cellId : kind;
    let step = steps.get(id);
    if (!step) steps.set(id, step = { id, kind, cell, earlier: [], nodes: [], reads: [], latest: !!cell && cell === newest, unknownInputs: false, stale: [], layer: 0, order: 0 });
    return step;
  };
  const add = (step: LineageStep, kind: LineageKind, name: string, id = kind + ':' + name) => {
    if (!step.nodes.some(n => n.id === id)) step.nodes.push({ id, kind, name, step: step.id });
    return id;
  };
  for (const value of kept) add(stepOf(value.cell, value.cell ? 'cell' : 'earlier'), 'value', value.name);
  for (const cell of plotted) add(stepOf(cell, 'cell'), 'plot', cell.plots === 1 ? 'Plot' : cell.plots + ' plots', 'plot:' + cell.cellId);
  // A file a cell wrote is drawn where its newest writer made it; the project files a cell read
  // that no cell wrote are named in its box.
  const wrote = [...writer].sort((a, b) => recency(b[1]) - recency(a[1])), drawnFiles = new Set(wrote.slice(0, limits.files).map(([path]) => path));
  for (const [path, cell] of wrote) if (drawnFiles.has(path)) add(stepOf(cell, 'cell'), 'file', path, 'wrote:' + path);

  // Links into each cell's step from what it read, as it is now; what changed since is named.
  // A box holding a value its cell changed also comes from what that value came from.
  for (const step of steps.values()) {
    if (!step.cell) continue;
    const record = made.get(step.cell.cellId)!;
    const { inputs, files: reads, earlier, unknown } = joined([record, ...step.nodes.flatMap(n => n.kind === 'value' && record.carried.get(n.name) ? [record.carried.get(n.name)!] : [])]);
    Object.assign(step, { earlier, unknownInputs: unknown });
    const link = (from: string) => { if (!step.nodes.some(n => n.id === from)) links.set(from + '>' + step.id, { from, to: step.id }); };
    const stale = (name: string) => { if (!step.stale.includes(name)) step.stale.push(name); };
    for (const input of inputs) {
      if (maker.get(input.name) !== input.from) stale(input.name);
      else if (shown.has(input.name)) link('value:' + input.name);
    }
    for (const file of reads) {
      if (writer.get(file.path) !== file.writer) stale(file.path);
      else if (!file.writer) { if (!step.reads.includes(file.path)) step.reads.push(file.path); }
      else if (drawnFiles.has(file.path)) link('wrote:' + file.path);
    }
  }
  const all = [...steps.values()], layers = place(all, [...links.values()]);
  return { steps: all.sort((a, b) => a.layer - b.layer || a.order - b.order), links: [...links.values()], layers,
    omitted: { values: live.length - kept.length, plots: plotting.length - plotted.length, files: wrote.length - drawnFiles.size } };
}

// Layers from the sources: a step sits one past the deepest step it read from. Within a layer,
// steps sit near the middle of what they read from, else in the order their cells ran.
function place(steps: LineageStep[], links: LineageLink[]) {
  const stepOfNode = new Map(steps.flatMap(s => s.nodes.map(n => [n.id, s] as const)));
  const parents = new Map<string, LineageStep[]>();
  for (const link of links) parents.set(link.to, [...parents.get(link.to) ?? [], stepOfNode.get(link.from)!]);
  const depth = new Map<string, number>(), visiting = new Set<string>();
  const layerOf = (step: LineageStep): number => {
    if (depth.has(step.id)) return depth.get(step.id)!;
    if (visiting.has(step.id)) return 0;
    visiting.add(step.id);
    const d = Math.max(-1, ...(parents.get(step.id) ?? []).map(layerOf)) + 1;
    visiting.delete(step.id); depth.set(step.id, d);
    return d;
  };
  for (const step of steps) step.layer = layerOf(step);
  const layers = Math.max(0, ...steps.map(s => s.layer + 1));
  const ran = (step: LineageStep) => step.cell?.number ?? -1;
  for (let layer = 0; layer < layers; layer++) {
    const middle = (step: LineageStep) => { const from = parents.get(step.id) ?? []; return from.length ? from.reduce((s, p) => s + p.order, 0) / from.length : -1; };
    steps.filter(s => s.layer === layer).sort((a, b) => middle(a) - middle(b) || ran(a) - ran(b)).forEach((step, i) => { step.order = i; });
  }
  // Within a step, what it holds sits above the steps that read it, from left to right.
  const byId = new Map(steps.map(s => [s.id, s])), toward = (id: string) => {
    const to = links.filter(l => l.from === id).map(l => byId.get(l.to)!);
    return to.length ? Math.min(...to.map(s => s.layer * 1e4 + s.order)) : Infinity;
  };
  for (const step of steps) step.nodes = step.nodes.map((n, i) => ({ n, i, at: toward(n.id) })).sort((a, b) => a.at - b.at || a.i - b.i).map(x => x.n);
  return layers;
}

// The steps a node comes from and leads to, through the links, for showing one path at a time.
export function related(graph: Lineage, stepId: string) {
  const stepOfNode = new Map(graph.steps.flatMap(s => s.nodes.map(n => [n.id, s.id] as const)));
  const up = new Map<string, string[]>(), down = new Map<string, string[]>();
  for (const link of graph.links) {
    const from = stepOfNode.get(link.from)!;
    up.set(link.to, [...up.get(link.to) ?? [], from]); down.set(from, [...down.get(from) ?? [], link.to]);
  }
  const reach = (start: string, next: Map<string, string[]>) => {
    const seen = new Set<string>([start]), queue = [start];
    while (queue.length) for (const id of next.get(queue.pop()!) ?? []) if (!seen.has(id)) { seen.add(id); queue.push(id); }
    return seen;
  };
  return new Set([...reach(stepId, up), ...reach(stepId, down)]);
}

// The boxes in the order their cells ran (which is also an order in which each reads only from
// boxes above it), and a lane in the margin for each value or file something read: from the line
// that made it down past the boxes between, to each box that read it. Lanes whose spans do not
// overlap share a place; lane 0 is nearest the boxes.
export function lanes(graph: Lineage) {
  const order = [...graph.steps].sort((a, b) => (a.cell?.number ?? -1) - (b.cell?.number ?? -1));
  const index = new Map(order.map((s, i) => [s.id, i])), stepOfNode = new Map(order.flatMap(s => s.nodes.map(n => [n.id, s.id] as const)));
  const spans = new Map<string, { from: number; to: number }>();
  for (const link of graph.links) {
    const from = index.get(stepOfNode.get(link.from)!)!, to = index.get(link.to)!, span = spans.get(link.from);
    spans.set(link.from, { from, to: Math.max(to, span?.to ?? to) });
  }
  const ends: number[] = [], lane = new Map<string, number>();
  for (const [node, span] of [...spans].sort((a, b) => a[1].from - b[1].from || a[1].to - b[1].to)) {
    let free = ends.findIndex(end => end <= span.from);
    if (free < 0) free = ends.length;
    ends[free] = span.to; lane.set(node, free);
  }
  return { order, lane, count: ends.length };
}

// What a cell is called where it is named: its purpose (a script's lines), else its first line.
export function cellLabel(cell: LineageCell) {
  return cell.purpose ?? (cell.code.split('\n').find(line => line.trim())?.trim() ?? '');
}
