import { conversationBlocks, type ActivityOutcome, type ConversationTurn, type SessionObservation } from './conversation-presentation.js';

// What the Agent did in a project, drawn as a graph: each question a person asked, the files
// its turn read and changed, the commands it ran, and the files that changed on disk while it
// worked. Every edge says where it comes from: the Agent's own report of an action, a file a
// command line names, or a change seen on disk at that time. Nothing here proves that a run
// produced a file; a change seen while it ran is labelled as exactly that.

export interface PathScope { root: string; sources?: ReadonlyArray<{ id: string; root: string }> | null }
// A path the Agent reported, as the project names it: relative inside the project folder,
// @<sourceId>/… inside a source folder, nothing anywhere else or in internal state.
export function projectPath(reported: string, project: PathScope): string | null {
  const value = reported.trim().replace(/\\/g, '/');
  if (!value) return null;
  const inside = (root: string) => { const base = root.replace(/\/+$/, '') + '/'; return value.startsWith(base) ? value.slice(base.length) : null; };
  let relative: string | null = null;
  if (!value.startsWith('/')) relative = value.replace(/^\.\//, '');
  else {
    relative = inside(project.root);
    if (relative === null) for (const source of project.sources ?? []) {
      const within = inside(source.root);
      if (within !== null) { relative = '@' + source.id + '/' + within; break; }
    }
  }
  if (!relative || relative.split('/').some(part => ['..', '.rho', '.git', ''].includes(part))) return null;
  return relative;
}
// Project files a command line names by a file extension Rho can show, at most four.
const named = /(?:^|[\s"'=(<>|;&])((?:\/|\.\/|[\w@-])[\w@./-]*\.(?:R|r|Rmd|qmd|py|sh|sql|md|txt|csv|tsv|json|png|jpe?g|svg|pdf))(?=$|[\s"')<>|;&,])/g;
export function commandFiles(command: string, project: PathScope) {
  const found: string[] = [];
  for (const match of command.matchAll(named)) {
    const path = projectPath(match[1], project);
    if (path && !found.includes(path)) found.push(path);
    if (found.length === 4) break;
  }
  return found;
}

export type FileKind = 'data' | 'code' | 'figures' | 'notes' | 'results' | null;
export interface GraphFile { path: string; bytes: number; modifiedAt?: string; category: FileKind }
export interface GraphTurn { conversationId: string; conversationTitle: string; agent: string; turn: ConversationTurn; observation?: SessionObservation | null }
export interface GraphInput {
  turns: GraphTurn[]; files: GraphFile[]; project: PathScope;
  // The kind of a file the last walk did not see, from its name.
  kindOf: (path: string) => FileKind;
  now: number;
}
export type NodeKind = 'question' | 'file' | 'run';
export type EventAction = 'ask' | 'read' | 'edit' | 'write' | 'run' | 'changed' | 'answer';
export type Basis = 'reported' | 'named' | 'observed';
export interface GraphEvent { key: string; at: number; node: string; turn: string; action: EventAction; label: string; outcome?: ActivityOutcome }
export interface GraphNode {
  id: string; kind: NodeKind; title: string; at: number;
  turn?: string; conversationId?: string; agent?: string; state?: string; answer?: string; model?: string | null; text?: string;
  path?: string; category?: FileKind; exists?: boolean; bytes?: number; modifiedAt?: string;
  command?: string; outcome?: ActivityOutcome;
  // A native permission request for this step that waits for the person.
  waiting?: { conversationId: string; turn: string; permission: string; title: string; options: Array<{ id: string; name: string; kind: string }> };
  // The events that touched this node, oldest first.
  events: GraphEvent[];
}
// The message an edge was recorded in: a file one message made and a later one read is drawn
// with that later message.
export interface GraphEdge { id: string; from: string; to: string; label: string; basis: Basis; at: number; turn: string }
export interface GraphTurnSpan { id: string; conversationId: string; title: string; agent: string; start: number; end: number; running: boolean }
export interface WorkGraph { nodes: GraphNode[]; edges: GraphEdge[]; events: GraphEvent[]; turns: GraphTurnSpan[]; live: { node: string; label: string; waiting?: boolean } | null; omittedTurns: number }

// The protected resource is the browser and the service it reads: the graph reads at most this
// many conversations and messages of each, and draws at most this many nodes. Past a limit it
// keeps the newest messages and says how many it left out.
export const graphLimits = { conversations: 6, turnsPerConversation: 8, nodes: 160 };
// A file that changed on disk this soon after a step still counts as changing during it.
const settleMs = 2500;

const time = (iso?: string | null) => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? value : null; };
const firstLine = (text: string, max = 140) => { const line = text.trim().split('\n').find(l => l.trim())?.trim() ?? ''; return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line; };
export const shortCommand = (command: string, max = 72) => { const text = command.replace(/\s+/g, ' ').trim(); return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text; };

export function buildWorkGraph(input: GraphInput): WorkGraph {
  const ordered = [...input.turns].sort((a, b) => (time(a.turn.sentAt) ?? 0) - (time(b.turn.sentAt) ?? 0));
  const nodes = new Map<string, GraphNode>(), edges = new Map<string, GraphEdge>(), events: GraphEvent[] = [], spans: GraphTurnSpan[] = [];
  const files = new Map(input.files.map(f => [f.path, f]));
  let live = null as WorkGraph['live'], inTurn = '';
  const fileNode = (path: string, at: number) => {
    const id = 'f:' + path;
    let node = nodes.get(id);
    if (!node) {
      const seen = files.get(path);
      node = { id, kind: 'file', title: path.split('/').at(-1) ?? path, at, path, category: seen?.category ?? input.kindOf(path), exists: !!seen, bytes: seen?.bytes, modifiedAt: seen?.modifiedAt, events: [] };
      nodes.set(id, node);
    }
    return node;
  };
  const edge = (from: string, to: string, label: string, basis: Basis, at: number) => {
    const id = from + '>' + to + ':' + label;
    if (!edges.has(id)) edges.set(id, { id, from, to, label, basis, at, turn: inTurn });
  };
  const note = (node: GraphNode, event: Omit<GraphEvent, 'node'>) => { const full = { ...event, node: node.id }; node.events.push(full); events.push(full); node.at = Math.min(node.at, event.at); };

  ordered.forEach(({ conversationId, conversationTitle, agent, turn: message, observation }, position) => {
    // Message identities are per conversation; the graph names each by both.
    const turn = { ...message, id: conversationId + '/' + message.id };
    inTurn = turn.id;
    const sent = time(turn.sentAt) ?? input.now, start = time(turn.startedAt) ?? sent;
    const running = turn.state === 'running';
    const end = time(turn.endedAt) ?? (running ? input.now : start);
    // A change on disk belongs to this message until the next one is sent.
    const next = position + 1 < ordered.length ? time(ordered[position + 1].turn.sentAt) ?? Infinity : Infinity;
    const q: GraphNode = { id: 'q:' + turn.id, kind: 'question', title: firstLine(turn.text) || 'A message', text: turn.text, at: sent, turn: turn.id, conversationId, agent, state: turn.state, model: turn.model ?? null, events: [] };
    nodes.set(q.id, q);
    note(q, { key: turn.id + ':ask', at: sent, turn: turn.id, action: 'ask', label: 'Asked' });
    spans.push({ id: turn.id, conversationId, title: conversationTitle, agent, start: sent, end: Math.max(end, sent), running });

    const blocks = conversationBlocks(turn, observation ?? null, input.project.root);
    const activities = blocks.flatMap(block => block.kind === 'activity' ? block.activities : []);
    const changed = new Set<string>(), byStep = new Map<string, string>();
    const runs: Array<{ node: GraphNode; from: number; to: number }> = [];
    activities.forEach((activity, index) => {
      // A step's time is its latest report: when it started while it runs, when it returned
      // once it has. A finished step ran from the step before it until then.
      const at = time(activity.step.at) ?? start;
      const before = index ? time(activities[index - 1].step.at) ?? start : start;
      const window = activity.outcome === 'requested' ? { from: at, to: end } : { from: Math.min(before, at), to: at };
      if (activity.outcome === 'rejected') return;
      const isLive = running && index === activities.length - 1 && activity.outcome === 'requested';
      if (activity.action === 'execute') {
        // A command is drawn from the start of its window, so what it made follows it in a replay.
        const command = activity.step.detail ?? activity.target ?? 'a command', from = window.from;
        const run: GraphNode = { id: 'r:' + turn.id + ':' + index, kind: 'run', title: shortCommand(command), command, at: from, turn: turn.id, outcome: activity.outcome, events: [] };
        nodes.set(run.id, run);
        if (activity.step.id) byStep.set(activity.step.id, run.id);
        note(run, { key: activity.key, at: from, turn: turn.id, action: 'run', label: activity.outcome === 'requested' ? 'Running' : 'Ran', outcome: activity.outcome });
        edge(q.id, run.id, 'ran', 'reported', from);
        runs.push({ node: run, ...window });
        // A command names the script it runs and sometimes the files it reads or writes; which
        // is which a command line does not say, unless the file changed while it ran.
        for (const path of commandFiles(command, input.project)) {
          if (!files.has(path) && !nodes.has('f:' + path)) continue;
          const modified = time(files.get(path)?.modifiedAt), code = (files.get(path)?.category ?? input.kindOf(path)) === 'code';
          // A file that changed while the command ran is drawn as changing then, below.
          if (!code && modified !== null && modified >= window.from && modified <= window.to + settleMs) continue;
          edge(fileNode(path, from).id, run.id, code ? 'runs' : 'named', 'named', from);
        }
        if (isLive) live = { node: run.id, label: 'Running' };
        return;
      }
      if (activity.action !== 'read' && activity.action !== 'edit' && activity.action !== 'write') return;
      const path = projectPath(activity.location ?? activity.step.detail ?? '', input.project);
      if (!path) return;
      const file = fileNode(path, at);
      if (activity.step.id) byStep.set(activity.step.id, file.id);
      note(file, { key: activity.key, at, turn: turn.id, action: activity.action, label: activity.verb, outcome: activity.outcome });
      if (activity.action === 'read') {
        // A file this turn already changed is its output, not an input to it.
        if (!changed.has(path)) edge(file.id, q.id, 'read', 'reported', at);
        if (isLive) live = { node: file.id, label: 'Reading' };
      } else {
        changed.add(path);
        edges.delete(file.id + '>' + q.id + ':read');
        edge(q.id, file.id, activity.action === 'edit' ? 'edited' : 'wrote', 'reported', at);
        if (isLive) live = { node: file.id, label: activity.action === 'edit' ? 'Editing' : 'Writing' };
      }
    });
    // Files that changed on disk during this message and that no step of it wrote: beside the run
    // that was going on at that moment, or the message itself. The service records them when the
    // message ends; while it runs, or for a record without them, a file whose last change falls
    // within the message stands in.
    const recorded = turn.files;
    const seen = (recorded?.changed ?? []).map(f => ({ path: f.path, at: f.change === 'removed' ? end : time(f.modifiedAt), removed: f.change === 'removed' }));
    if (!recorded || recorded.partial || recorded.omitted) for (const file of input.files) {
      const modified = time(file.modifiedAt);
      if (modified !== null && modified >= start && modified <= Math.min(end + settleMs, next) && !seen.some(f => f.path === file.path)) seen.push({ path: file.path, at: modified, removed: false });
    }
    for (const { path, at: modified, removed } of seen) {
      if (modified === null || changed.has(path)) continue;
      const during = removed ? undefined : [...runs].reverse().find(run => modified >= run.from && modified <= run.to + settleMs);
      const node = fileNode(path, modified), verb = removed ? 'Removed' : 'Changed';
      note(node, { key: turn.id + ':changed:' + path, at: modified, turn: turn.id, action: 'changed', label: during ? verb + ' while ' + during.node.title + ' ran' : removed ? 'Removed' : 'Changed on disk' });
      if (during) { edges.delete(node.id + '>' + during.node.id + ':named'); edge(during.node.id, node.id, 'changed while it ran', 'observed', modified); }
      else edge(q.id, node.id, removed ? 'removed meanwhile' : 'changed meanwhile', 'observed', modified);
      // Reading it only after it changed is looking at this message's output, not taking it in.
      if (!node.events.some(e => e.turn === turn.id && e.action === 'read' && e.at < modified)) edges.delete(node.id + '>' + q.id + ':read');
    }
    const answer = [...blocks].reverse().find(block => block.kind === 'text');
    if (answer?.kind === 'text' && answer.step.text) q.answer = answer.step.text;
    if (!running && time(turn.endedAt) !== null) note(q, { key: turn.id + ':answer', at: end, turn: turn.id, action: 'answer', label: turn.state === 'completed' ? 'Answered' : turn.state === 'failed' ? 'Failed' : turn.state === 'stopped' ? 'Stopped' : 'Ended' });
    if (running && !live) live = { node: q.id, label: 'Working' };
    // A step that waits for the person's choice says so where it is drawn.
    const pending = running ? turn.permissions?.find(p => p.state === 'pending') : undefined;
    if (pending) {
      const node = nodes.get(byStep.get(pending.toolCallId) ?? q.id) ?? q;
      node.waiting = { conversationId, turn: message.id, permission: pending.id, title: pending.title, options: pending.options.map(o => ({ id: o.id, name: o.name, kind: o.kind })) };
      live = { node: node.id, label: 'Needs your choice', waiting: true };
    }
  });
  // The newest messages are kept whole when the graph would grow past its node limit.
  let omittedTurns = 0;
  if (nodes.size > graphLimits.nodes) {
    const keep = new Set<string>();
    const byTurn = [...spans].reverse();
    let count = 0;
    for (const span of byTurn) {
      const own = [...nodes.values()].filter(n => n.events.some(e => e.turn === span.id) && !keep.has(n.id));
      if (count + own.length > graphLimits.nodes && count > 0) { omittedTurns++; continue; }
      for (const n of own) keep.add(n.id);
      count += own.length;
    }
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
  }
  const kept = [...edges.values()].filter(e => nodes.has(e.from) && nodes.has(e.to));
  for (const node of nodes.values()) node.events.sort((a, b) => a.at - b.at);
  return {
    nodes: [...nodes.values()].sort((a, b) => a.at - b.at), edges: kept,
    events: events.filter(e => nodes.has(e.node)).sort((a, b) => a.at - b.at), turns: spans.filter(s => nodes.has('q:' + s.id)),
    live: live && nodes.has(live.node) ? live : null, omittedTurns,
  };
}

// Upstream and downstream of one node: the path a result came by and what it fed.
export function lineage(graph: Pick<WorkGraph, 'edges'>, id: string) {
  const up = new Set<string>([id]), down = new Set<string>([id]);
  const walk = (set: Set<string>, forward: boolean) => {
    const queue = [id];
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of graph.edges) {
        const [from, to] = forward ? [e.from, e.to] : [e.to, e.from];
        if (from === at && !set.has(to)) { set.add(to); queue.push(to); }
      }
    }
  };
  walk(up, false); walk(down, true);
  const nodes = new Set([...up, ...down]);
  const edges = new Set(graph.edges.filter(e => (up.has(e.from) && up.has(e.to)) || (down.has(e.from) && down.has(e.to))).map(e => e.id));
  return { nodes, edges };
}

// A left-to-right layered layout: each node one column after everything it comes from, a node
// nothing points to pulled beside what it feeds, rows ordered to keep edges short, and each
// node then moved toward its neighbours without overlapping. Deterministic for the same graph.
export interface LayoutBox { id: string; width: number; height: number; at: number }
export interface Placed { x: number; y: number; width: number; height: number; column: number }
export function layoutGraph(boxes: LayoutBox[], links: Array<{ from: string; to: string }>, gap = { x: 96, y: 28 }) {
  const ids = boxes.map(b => b.id), box = new Map(boxes.map(b => [b.id, b]));
  const outgoing = new Map(ids.map(id => [id, [] as string[]])), incoming = new Map(ids.map(id => [id, [] as string[]]));
  // Edges keep their direction. One that would close a cycle, found walking from the oldest
  // node, is ignored for columns; it is still drawn.
  const byTime = [...boxes].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map(b => b.id);
  const rank = new Map(byTime.map((id, i) => [id, i]));
  const declared = new Map(ids.map(id => [id, [] as string[]]));
  for (const link of links) if (box.has(link.from) && box.has(link.to) && link.from !== link.to && !declared.get(link.from)!.includes(link.to)) declared.get(link.from)!.push(link.to);
  const state = new Map<string, 1 | 2>(), finished: string[] = [];
  for (const startId of byTime) {
    if (state.has(startId)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: startId, next: 0 }];
    state.set(startId, 1);
    while (stack.length) {
      const top = stack.at(-1)!, targets = [...declared.get(top.id)!].sort((a, b) => rank.get(a)! - rank.get(b)!);
      if (top.next >= targets.length) { state.set(top.id, 2); finished.push(top.id); stack.pop(); continue; }
      const to = targets[top.next++];
      if (state.get(to) === 1) continue;
      outgoing.get(top.id)!.push(to); incoming.get(to)!.push(top.id);
      if (!state.has(to)) { state.set(to, 1); stack.push({ id: to, next: 0 }); }
    }
  }
  const order = finished.reverse();
  const column = new Map<string, number>();
  for (const id of order) column.set(id, Math.max(0, ...incoming.get(id)!.map(p => column.get(p)! + 1)));
  // A node nothing points to sits just before the first thing it feeds.
  for (const id of order) if (!incoming.get(id)!.length && outgoing.get(id)!.length) column.set(id, Math.max(0, Math.min(...outgoing.get(id)!.map(c => column.get(c)!)) - 1));
  const columns: string[][] = [];
  for (const id of order) (columns[column.get(id)!] ??= []).push(id);
  for (let c = 0; c < columns.length; c++) columns[c] ??= [];
  // Barycentre sweeps order each column by the average row of its neighbours.
  const row = () => { const m = new Map<string, number>(); for (const col of columns) col.forEach((id, i) => m.set(id, i)); return m; };
  for (let pass = 0; pass < 6; pass++) {
    const at = row(), forward = pass % 2 === 0;
    const range = forward ? columns.keys() : [...columns.keys()].reverse();
    for (const c of range) {
      const score = (id: string) => { const near = (forward ? incoming : outgoing).get(id)!.map(n => at.get(n)!); return near.length ? near.reduce((a, b) => a + b, 0) / near.length : at.get(id)!; };
      columns[c].sort((a, b) => score(a) - score(b) || rank.get(a)! - rank.get(b)!);
      columns[c].forEach((id, i) => at.set(id, i));
    }
  }
  // Column widths follow their widest card; rows stack, then relax toward their neighbours.
  const widths = columns.map(col => Math.max(0, ...col.map(id => box.get(id)!.width)));
  const xs: number[] = []; let x = 0;
  for (let c = 0; c < columns.length; c++) { xs[c] = x; x += widths[c] + gap.x; }
  const y = new Map<string, number>();
  for (const col of columns) {
    const total = col.reduce((sum, id) => sum + box.get(id)!.height, 0) + gap.y * Math.max(0, col.length - 1);
    let top = -total / 2;
    for (const id of col) { y.set(id, top); top += box.get(id)!.height + gap.y; }
  }
  const centre = (id: string) => y.get(id)! + box.get(id)!.height / 2;
  for (let pass = 0; pass < 8; pass++) {
    for (const col of (pass % 2 ? [...columns].reverse() : columns)) {
      for (const id of col) {
        const near = [...incoming.get(id)!, ...outgoing.get(id)!];
        if (near.length) y.set(id, near.reduce((sum, n) => sum + centre(n), 0) / near.length - box.get(id)!.height / 2);
      }
      // Keep the column's order and spacing: push down past the one above, then pull the
      // whole column back so its middle stays where the neighbours wanted it.
      const wanted = col.reduce((sum, id) => sum + centre(id), 0) / Math.max(1, col.length);
      for (let i = 1; i < col.length; i++) { const above = col[i - 1], min = y.get(above)! + box.get(above)!.height + gap.y; if (y.get(col[i])! < min) y.set(col[i], min); }
      const now = col.reduce((sum, id) => sum + centre(id), 0) / Math.max(1, col.length), shift = wanted - now;
      if (shift < 0) for (const id of col) y.set(id, y.get(id)! + shift);
    }
  }
  const placed = new Map<string, Placed>();
  let minY = Infinity, maxY = -Infinity;
  for (const id of ids) { const top = y.get(id)!; minY = Math.min(minY, top); maxY = Math.max(maxY, top + box.get(id)!.height); }
  if (!ids.length) { minY = 0; maxY = 0; }
  for (const id of ids) placed.set(id, { x: xs[column.get(id)!], y: y.get(id)! - minY, width: box.get(id)!.width, height: box.get(id)!.height, column: column.get(id)! });
  return { placed, width: Math.max(0, x - gap.x), height: maxY - minY, columns: columns.length };
}

// Each message is one row read left to right: what it took in, the question, what it changed
// and ran, and what that made. A node lives in the row of the message that first touched it;
// a later message that reads or changes it shows a small reference to it in its own row, so
// rows stay short and the path still connects. Questions line up in one column.
export interface LaneItem { id: string; node: string; proxy: boolean; lane: number }
export interface LaneLink { id: string; from: string; to: string; edge: GraphEdge }
export function laneLayout(graph: Pick<WorkGraph, 'nodes' | 'edges' | 'turns'>, size: (node: GraphNode, proxy: boolean) => { width: number; height: number }, gap = { x: 88, y: 26, lane: 64 }) {
  const lanes = graph.turns.map(t => t.id), laneOf = new Map(lanes.map((id, i) => [id, i]));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const home = (node: GraphNode) => laneOf.get(node.kind === 'question' ? node.turn! : node.events[0]?.turn ?? '') ?? 0;
  const items = new Map<string, LaneItem>();
  for (const node of graph.nodes) items.set(node.id, { id: node.id, node: node.id, proxy: false, lane: home(node) });
  const links: LaneLink[] = [];
  const at = (id: string, lane: number) => {
    const item = items.get(id)!;
    if (item.lane === lane) return id;
    const proxy = 'p' + lane + ':' + id;
    if (!items.has(proxy)) items.set(proxy, { id: proxy, node: id, proxy: true, lane });
    return proxy;
  };
  for (const edge of graph.edges) {
    const lane = laneOf.get(edge.turn) ?? items.get(edge.to)!.lane;
    links.push({ id: edge.id, from: at(edge.from, lane), to: at(edge.to, lane), edge });
  }
  const placed = new Map<string, Placed>(), rows: Array<{ lane: number; turn: string; y: number; height: number }> = [];
  const perLane = lanes.map((_, lane) => {
    const own = [...items.values()].filter(i => i.lane === lane);
    const result = layoutGraph(own.map(i => ({ id: i.id, at: byId.get(i.node)!.at, ...size(byId.get(i.node)!, i.proxy) })), links.filter(l => items.get(l.from)!.lane === lane && items.get(l.to)!.lane === lane), { x: gap.x, y: gap.y });
    const question = own.find(i => !i.proxy && byId.get(i.node)!.kind === 'question');
    return { own, result, qColumn: question ? result.placed.get(question.id)!.column : 0 };
  });
  // Shift each row so its question stands in the same column as every other row's.
  const align = Math.max(0, ...perLane.map(l => l.qColumn));
  const columnWidth = new Map<number, number>();
  perLane.forEach(l => { for (const [id, p] of l.result.placed) { const c = p.column + align - l.qColumn; columnWidth.set(c, Math.max(columnWidth.get(c) ?? 0, p.width)); void id; } });
  const xs: number[] = []; let x = 0;
  const lastColumn = Math.max(-1, ...columnWidth.keys());
  for (let c = 0; c <= lastColumn; c++) { xs[c] = x; x += (columnWidth.get(c) ?? 0) + gap.x; }
  let y = 0;
  perLane.forEach((l, lane) => {
    for (const [id, p] of l.result.placed) { const c = p.column + align - l.qColumn; placed.set(id, { ...p, column: c, x: xs[c] + (columnWidth.get(c)! - p.width) / 2, y: y + p.y }); }
    rows.push({ lane, turn: lanes[lane], y, height: l.result.height });
    y += l.result.height + (l.own.length ? gap.lane : 0);
  });
  return { placed, items: [...items.values()], links, rows, width: Math.max(0, x - gap.x), height: Math.max(0, y - gap.lane) };
}
