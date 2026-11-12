import type { Basis } from './work-graph.js';
import { flows, lineFiles, links, type Link, type WorkLayers, type WorkNode } from './work-layers.js';

// Where the Graph draws the levels a person has opened (work-layers.ts). Closed, a line of work
// is one card and the workspace is its lines in the order they began, joined where one builds on another. Opened, a line
// is a frame read left to right: the files it used, the work, the files the work made, and what
// the notes conclude from them. The work is a column that opens in place, a message into its
// activities and an activity into its steps, and every line to a file moves to the deepest
// node on screen that stands for the step it was recorded on. Nothing is left out for size:
// what is drawn is what is open.

export type ItemKind = 'line' | 'frame' | 'ask' | 'activity' | 'step' | 'file' | 'bundle' | 'claim' | 'label';
export interface Item {
  id: string; kind: ItemKind; x: number; y: number; width: number; height: number;
  // The work node, the file's path, the claim or the label it draws, and the line it is drawn in.
  ref: string; line: string;
  open?: boolean; depth?: number; column?: 'used' | 'work' | 'made' | 'said';
  // A file: the line that made it earlier, whether it was there before this line changed it, and
  // whether the notes name it though no recorded step of this line touched it.
  from?: string | null; existing?: boolean; unrecorded?: boolean; figure?: boolean;
  // A closed line of work drawn as its name and counts alone (see sizes.roomy).
  brief?: boolean;
  // Several files another line of work made, drawn as one: their paths. `ref` is that line.
  paths?: string[];
}
export interface Wire { id: string; from: string; to: string; kind: 'uses' | 'makes' | 'rests' | 'flow'; basis: Basis; label: string; n: number; paths?: string[] }
export interface Scene { items: Item[]; wires: Wire[]; width: number; height: number }
export const sizes = {
  line: { width: 340, height: 178, figure: 132 }, quiet: { width: 300, height: 74 },
  // The protected resource is one look at the whole project. Up to this many lines of work, a
  // closed line carries its question and newest figure; past it, every closed line is its name
  // and counts, so that all of them still read at once. Each opens the same way.
  roomy: 8, brief: { width: 340, height: 98 },
  // A row of lines of work wraps past this width; the room between lines carries what one builds on.
  wrap: 1760, between: { x: 124, y: 72 },
  head: 64, pad: 20, label: 26, gap: 8, column: 68, indent: 16,
  work: 400, ask: 88, askOpen: 60, activity: 46, step: 28, stepGap: 2,
  file: { width: 216, height: 48, figure: 156 }, claim: { width: 304, finding: 86, choice: 64 },
  // This many files from one other line of work are drawn as one card.
  bundle: 2,
};
export interface LayoutOptions {
  // Whether a file draws its picture on its card.
  figure?: (path: string) => boolean;
}
const S = sizes;
const wireLabel = (link: Link) => link.verbs.map(v => v.verb + (v.n > 1 ? ' ' + v.n + '×' : '')).join(' · ');

interface Frame { items: Item[]; wires: Wire[]; width: number; height: number }
function lineFrame(layers: WorkLayers, line: WorkNode, open: ReadonlySet<string>, options: LayoutOptions): Frame {
  const files = lineFiles(layers, line.id), claims = layers.claims.filter(c => c.line === line.id);
  const touched = new Set([...files.used, ...files.made].map(f => f.path));
  // Files the notes rest a statement on that no recorded step of this line touched.
  const unrecorded = [...new Set(claims.flatMap(c => c.paths))].filter(p => !touched.has(p));
  const items: Item[] = [], wires: Wire[] = [], top = S.head + S.label;
  const usedX = S.pad, workX = usedX + (files.used.length ? S.file.width + S.column : 0), madeX = workX + S.work + S.column;
  const hasMade = files.made.length + unrecorded.length > 0, saidX = hasMade ? madeX + S.file.width + S.column : madeX;

  // The work column: each message, opened into its activities, each opened into its steps.
  let y = top;
  const row = (node: WorkNode, kind: ItemKind, depth: number, height: number, isOpen: boolean, gap = S.gap) => {
    items.push({ id: node.id, kind, ref: node.id, line: line.id, x: workX + depth * S.indent, y, width: S.work - depth * S.indent, height, depth, open: isOpen, column: 'work' });
    y += height + gap;
  };
  for (const askId of line.children) {
    const ask = layers.nodes.get(askId)!, askOpen = open.has(ask.id) && ask.children.length > 0;
    row(ask, 'ask', 0, askOpen ? S.askOpen : S.ask, askOpen);
    if (askOpen) for (const activityId of ask.children) {
      const activity = layers.nodes.get(activityId)!, activityOpen = open.has(activity.id);
      row(activity, 'activity', 1, S.activity, activityOpen);
      if (activityOpen) { y -= S.gap - S.stepGap; activity.children.forEach((id, i) => row(layers.nodes.get(id)!, 'step', 2, S.step, false, i === activity.children.length - 1 ? S.gap : S.stepGap)); }
    }
  }
  let bottom = Math.max(y - S.gap, top);
  const rowAt = new Map(items.map(i => [i.id, i.y + i.height / 2]));

  // Files beside the rows that touched them, in the order of those rows.
  const own = links(layers, open, line.id), byPath = new Map<string, Link[]>();
  for (const link of own) byPath.set(link.path, [...(byPath.get(link.path) ?? []), link]);
  const middle = (path: string) => { const ys = (byPath.get(path) ?? []).map(l => rowAt.get(l.work)).filter((v): v is number => v !== undefined); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity; };
  const stack = (list: Array<Omit<Item, 'x' | 'y' | 'width' | 'height'> & { at: number; height: number; width: number }>, x: number) => {
    let free = top;
    for (const { at, ...entry } of [...list].sort((a, b) => a.at - b.at)) {
      const yAt = Math.max(free, Number.isFinite(at) ? at - entry.height / 2 : free);
      items.push({ ...entry, x, y: yAt });
      free = yAt + entry.height + S.gap; bottom = Math.max(bottom, yAt + entry.height);
    }
  };
  const fileId = (path: string) => line.id + '|' + path;
  const fileEntry = (path: string, column: 'used' | 'made', extra: Partial<Item>) => {
    const figure = !!options.figure?.(path);
    return { id: fileId(path), kind: 'file' as const, ref: path, line: line.id, column, figure, width: S.file.width, height: figure ? S.file.figure : S.file.height, at: middle(path), ...extra };
  };
  // What this line took from another line of work is one card per line when it took several
  // files: the other line is where they are told apart.
  const taken = new Map<string, string[]>(), bundled = new Map<string, string>();
  for (const f of files.used) if (f.from) taken.set(f.from, [...(taken.get(f.from) ?? []), f.path]);
  for (const [from, paths] of taken) if (paths.length >= S.bundle) for (const path of paths) bundled.set(path, line.id + '|from|' + from);
  const bundleAt = (paths: string[]) => { const ys = paths.map(middle).filter(Number.isFinite); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity; };
  stack([...files.used.filter(f => !bundled.has(f.path)).map(f => fileEntry(f.path, 'used', { from: f.from })),
    ...[...taken].filter(([, paths]) => paths.length >= S.bundle).map(([from, paths]) => ({ id: line.id + '|from|' + from, kind: 'bundle' as const, ref: from, line: line.id, column: 'used' as const, paths, width: S.file.width, height: S.file.height, at: bundleAt(paths) }))], usedX);
  stack([...files.made.map(f => fileEntry(f.path, 'made', { from: f.from, existing: f.existing })), ...unrecorded.map(path => fileEntry(path, 'made', { unrecorded: true }))], madeX);
  const fileAt = new Map(items.flatMap(i => i.kind === 'file' ? [[i.ref, i.y + i.height / 2] as [string, number]] : i.kind === 'bundle' ? i.paths!.map(p => [p, i.y + i.height / 2] as [string, number]) : []));
  stack(claims.map(claim => {
    const ys = claim.paths.map(p => fileAt.get(p)).filter((v): v is number => v !== undefined);
    return { id: claim.id, kind: 'claim' as const, ref: claim.id, line: line.id, column: 'said' as const, width: S.claim.width, height: claim.kind === 'finding' ? S.claim.finding : S.claim.choice, at: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity };
  }), saidX);

  const made = new Set(files.made.map(f => f.path));
  const wire = (id: string, next: Wire) => { const known = wires.find(w => w.id === id); if (known) { known.n += next.n; if (!known.label.includes(next.label)) known.label += ' · ' + next.label; } else wires.push(next); };
  for (const link of own) {
    const file = bundled.get(link.path) ?? fileId(link.path), into = made.has(link.path) && link.makes;
    // A file the work made: the line goes from the work to it, whatever else the work did with it.
    wire(link.work + '>' + file, { id: link.work + '>' + file, from: into ? link.work : file, to: into ? file : link.work, kind: into ? 'makes' : 'uses', basis: (link.verbs.find(v => into ? v.verb !== 'read' && v.verb !== 'ran' && v.verb !== 'named' : true) ?? link.verbs[0]!).basis, label: wireLabel(link), n: link.n });
  }
  for (const claim of claims) for (const path of claim.paths) { const file = bundled.get(path) ?? fileId(path); wire(file + '>' + claim.id, { id: file + '>' + claim.id, from: file, to: claim.id, kind: 'rests', basis: 'declared', label: claim.kind === 'finding' ? 'supports' : 'shows', n: 1 }); }

  const columns: Array<[string, number, boolean]> = [['Used', usedX, files.used.length > 0], ['Work', workX, true], ['Made', madeX, hasMade], ['Concluded', saidX, claims.length > 0]];
  for (const [text, x, shown] of columns) if (shown) items.push({ id: line.id + '|label|' + text, kind: 'label', ref: text, line: line.id, x, y: S.head, width: 160, height: S.label });
  const right = claims.length ? saidX + S.claim.width : hasMade ? madeX + S.file.width : workX + S.work;
  return { items, wires, width: right + S.pad, height: bottom + S.pad };
}

export function layoutLayers(layers: WorkLayers, open: ReadonlySet<string>, options: LayoutOptions = {}): Scene {
  const root = layers.nodes.get(layers.root)!, all = root.children.map(id => layers.nodes.get(id)!);
  const main = all.filter(l => !l.quiet), quiet = all.filter(l => l.quiet);
  const frames = new Map<string, Frame>();
  for (const line of all) if (open.has(line.id)) frames.set(line.id, lineFrame(layers, line, open, options));
  // A closed line shows the newest figure it made.
  const figureOf = (line: WorkNode) => lineFiles(layers, line.id).made.map(f => f.path).reverse().find(p => options.figure?.(p)) ?? null;
  const brief = main.length > S.roomy;
  const size = (line: WorkNode) => { const frame = frames.get(line.id); return frame ? { width: frame.width, height: frame.height } : line.quiet ? { ...S.quiet } : brief ? { ...S.brief } : { width: S.line.width, height: S.line.height + (figureOf(line) ? S.line.figure : 0) }; };
  const items: Item[] = [], wires: Wire[] = [];
  const place = (line: WorkNode, x: number, y: number) => {
    const frame = frames.get(line.id), box = size(line);
    items.push({ id: line.id, kind: frame ? 'frame' : 'line', ref: line.id, line: line.id, x, y, ...box, open: !!frame, figure: !frame && !brief && !!figureOf(line), brief: !frame && brief && !line.quiet });
    if (frame) { for (const item of frame.items) items.push({ ...item, x: item.x + x, y: item.y + y }); wires.push(...frame.wires); }
  };
  // The lines of work in the order they began, read like a page: left to right, then the next
  // row. An open line takes the room its frame needs.
  const row = (list: WorkNode[], top: number, gap: number, between: number) => {
    let x = 0, y = top, tall = 0, right = 0;
    for (const line of list) {
      const box = size(line);
      if (x > 0 && x + box.width > S.wrap) { x = 0; y += tall + between; tall = 0; }
      place(line, x, y);
      x += box.width + gap; tall = Math.max(tall, box.height); right = Math.max(right, x - gap);
    }
    return { width: right, bottom: list.length ? y + tall : top };
  };
  const work = row(main, 0, S.between.x, S.between.y);
  for (const flow of flows(layers)) if (main.some(l => l.id === flow.from) && main.some(l => l.id === flow.to))
    wires.push({ id: flow.from + '>' + flow.to, from: flow.from, to: flow.to, kind: 'flow', basis: 'reported', label: flow.paths.length === 1 ? 'builds on 1 file' : 'builds on ' + flow.paths.length + ' files', n: flow.paths.length, paths: flow.paths });
  let width = work.width, height = work.bottom;
  if (quiet.length) {
    // Conversations that changed no project file stand below the work, each still opening the same way.
    const top = height + (main.length ? 56 : 0);
    const typed = quiet.every(l => l.terminal), noneTyped = quiet.every(l => !l.terminal);
    items.push({ id: 'label|quiet', kind: 'label', ref: (typed ? 'Typed in a terminal' : noneTyped ? 'Asked' : 'Asked or typed') + (main.length ? ' without changing a file' : ''), line: '', x: 0, y: top, width: 320, height: S.label });
    const asked = row(quiet, top + S.label + 4, 16, 16);
    width = Math.max(width, asked.width); height = asked.bottom;
  }
  return { items, wires, width, height };
}
