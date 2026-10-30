import type { FileKind, GraphEdge, GraphFile, GraphNode, GraphTurnSpan, WorkGraph } from './work-graph.js';
import { fileDescriptions, type SessionMeaning, type Statement, type Trace } from './notes-meaning.js';

// The meaning layer of the Graph: one row per session's section of the notes. Its question,
// then what was found and the choices taken, then the files those rest on, then how the files
// came about and what they read. Findings, choices and descriptions are declared in the notes;
// how a file came about is taken from the process record with that record's basis. Each file
// can be traced to the version the process kept, and each statement to the message it was
// written in.

export interface MeaningLayer {
  nodes: GraphNode[]; edges: GraphEdge[]; turns: GraphTurnSpan[];
  // Edges from the meaning layer into the process layer: a file to the version kept, a
  // statement to the message it was written in.
  traces: GraphEdge[];
}
export interface MeaningInput {
  process: WorkGraph; meanings: SessionMeaning[]; traces: Map<Statement, Trace>;
  files: GraphFile[]; kindOf: (path: string) => FileKind;
}
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;

export function meaningLayer(input: MeaningInput): MeaningLayer {
  const { process, meanings, traces } = input;
  const files = new Map(input.files.map(f => [f.path, f]));
  const described = fileDescriptions(meanings);
  const nodes = new Map<string, GraphNode>(), edges = new Map<string, GraphEdge>(), links = new Map<string, GraphEdge>(), turns: GraphTurnSpan[] = [];
  const edge = (into: Map<string, GraphEdge>, from: string, to: string, label: string, basis: GraphEdge['basis'], at: number, turn: string) => {
    const id = from + '>' + to + ':' + label;
    if (!into.has(id)) into.set(id, { id, from, to, label, basis, at, turn });
  };
  const keptOf = (path: string) => process.nodes.filter(n => n.kind === 'file' && n.path === path)
    .flatMap(n => n.versions ?? (n.resource ? [{ resource: n.resource, capturedAt: n.capturedAt ?? n.at }] : [])).sort((a, b) => a.capturedAt - b.capturedAt);
  const processNodeOf = (path: string, version?: string) => process.nodes.find(n => n.kind === 'file' && n.path === path && (!version || n.resource?.version === version || n.versions?.some(v => v.resource.version === version)));

  // A file's node is shared by every row that names it; it lives in the first.
  const fileNode = (path: string, lane: string, at: number, trace?: Trace) => {
    const id = 'm:f:' + path;
    let node = nodes.get(id);
    if (!node) {
      const seen = files.get(path), bound = trace?.files.find(f => f.path === path)?.kept ?? null, newest = keptOf(path).at(-1);
      const kept = bound ?? (newest ? { resource: newest.resource, at: newest.capturedAt } : null);
      const said = described.get(path);
      node = { id, kind: 'file', title: path.split('/').at(-1) ?? path, path, at, category: seen?.category ?? input.kindOf(path), exists: !!seen, bytes: seen?.bytes, modifiedAt: seen?.modifiedAt,
        ...(kept ? { resource: kept.resource, capturedAt: kept.at } : { gap: 'No version of this file was kept in the Agent\'s record.' }),
        events: [{ key: id, at, node: id, turn: lane, action: 'write', label: 'Named in the notes' }],
        meaning: { session: '', conversationId: null, ...(said ? { description: { text: said.text, trace: traces.get(said.statement) } } : {}) } };
      nodes.set(id, node);
    }
    return node;
  };

  meanings.forEach(section => {
    const statements = section.statements;
    if (!statements.length) return;
    const lane = 'm:' + (section.conversationId ?? 'notes-' + section.line);
    const span = process.turns.find(t => t.conversationId === section.conversationId);
    const written = statements.map(s => traces.get(s)?.written?.at).filter((at): at is number => at !== undefined);
    const start = written.length ? Math.min(...written) : span?.start ?? 0;
    turns.push({ id: lane, conversationId: section.conversationId ?? '', title: section.title, agent: span?.agent ?? 'Notes', start, end: Math.max(start, ...written), running: false });
    const at = (s: Statement) => traces.get(s)?.written?.at ?? start;
    const info = (s?: Statement) => ({ session: section.title, conversationId: section.conversationId, ...(s ? { statement: s, trace: traces.get(s) } : {}) });
    const todos = statements.filter(s => s.kind === 'todo');
    const asked = statements.find(s => s.kind === 'question');
    const q: GraphNode = { id: 'q:' + lane, kind: 'question', title: clip(asked?.text || section.title, 160), text: asked?.text || section.title, at: asked ? at(asked) : start, turn: lane,
      conversationId: section.conversationId ?? undefined, agent: span?.agent, events: [],
      meaning: { ...info(asked), ...(todos.length ? { todos: { done: todos.filter(t => t.done).length, total: todos.length } } : {}) } };
    nodes.set(q.id, q);
    const said = new Map<number, GraphNode>();
    statements.forEach((s, index) => {
      if (s.kind !== 'finding' && s.kind !== 'choice') return;
      const node: GraphNode = { id: 'm:s:' + lane + ':' + s.line, kind: s.kind, title: clip(s.text, 220), text: s.text, at: at(s), turn: lane, conversationId: section.conversationId ?? undefined,
        events: [{ key: 'm:s:' + lane + ':' + s.line, at: at(s), node: 'm:s:' + lane + ':' + s.line, turn: lane, action: 'write', label: 'Written in the notes' }], meaning: info(s) };
      nodes.set(node.id, node); said.set(index, node);
      edge(edges, q.id, node.id, s.kind === 'finding' ? 'found' : 'chose', 'declared', at(s), lane);
      for (const path of s.links) edge(edges, node.id, fileNode(path, lane, at(s), traces.get(s)).id, s.kind === 'finding' ? 'rests on' : 'gives', 'declared', at(s), lane);
      for (const option of s.alternatives ?? []) for (const path of option.links) edge(edges, node.id, fileNode(path, lane, at(s), traces.get(s)).id, 'instead gives', 'declared', at(s), lane);
      const where = traces.get(s)?.written;
      if (where && process.nodes.some(n => n.id === 'q:' + where.turn)) edge(links, node.id, 'q:' + where.turn, 'written in', 'observed', where.at, lane);
    });
    // A figure shows the finding written just before it, or the question when none was.
    statements.forEach(s => {
      if (s.kind !== 'figure') return;
      const by = s.of !== undefined ? said.get(s.of) : undefined;
      for (const path of s.links) edge(edges, (by ?? q).id, fileNode(path, lane, at(s), traces.get(s)).id, by ? 'shown in' : 'shows', 'declared', at(s), lane);
    });
    // Results the notes list but no finding names still belong to the question; the data and
    // scripts the method names join through how the results came about, or the question.
    const reached = () => new Set([...edges.values()].map(e => e.to));
    for (const s of statements) if (s.kind === 'file') for (const path of s.links) {
      const node = fileNode(path, lane, at(s), traces.get(s));
      if (!reached().has(node.id) && node.category !== 'code' && node.category !== 'data') edge(edges, q.id, node.id, 'made', 'declared', at(s), lane);
    }
    const method = statements.filter(s => s.kind === 'method' || s.kind === 'file');
    for (const s of method) {
      const code = s.links.filter(p => (files.get(p)?.category ?? input.kindOf(p)) === 'code'), data = s.links.filter(p => (files.get(p)?.category ?? input.kindOf(p)) === 'data');
      for (const script of code) for (const path of data) edge(edges, fileNode(script, lane, at(s), traces.get(s)).id, fileNode(path, lane, at(s), traces.get(s)).id, 'reads', 'declared', at(s), lane);
    }
    lineage(lane, section.conversationId);
    for (const s of method) for (const path of s.links) {
      const node = fileNode(path, lane, at(s), traces.get(s));
      if (!reached().has(node.id)) edge(edges, q.id, node.id, node.category === 'data' ? 'uses data' : 'uses', 'declared', at(s), lane);
    }
  });

  // How each result came about, from the process record: the run whose working changed it and
  // the script that run ran, and the files that command names. The process edge's basis stays.
  function lineage(lane: string, conversationId: string | null) {
    const mine = (e: GraphEdge) => !conversationId || e.turn.startsWith(conversationId + '/');
    const byId = new Map(process.nodes.map(n => [n.id, n]));
    let added = true;
    while (added) {
      added = false;
      for (const node of [...nodes.values()]) {
        if (node.kind !== 'file' || !node.path || node.events[0]?.turn !== lane) continue;
        for (const into of process.edges.filter(e => mine(e) && byId.get(e.to)?.path === node.path)) {
          const run = byId.get(into.from);
          if (run?.kind !== 'run') continue;
          for (const ran of process.edges.filter(e => e.to === run.id && (e.label === 'runs' || e.label === 'named'))) {
            const source = byId.get(ran.from);
            if (!source?.path || source.path === node.path) continue;
            const before = nodes.size, other = fileNode(source.path, lane, ran.at);
            edge(edges, node.id, other.id, ran.label === 'runs' ? 'made by' : 'named with', into.basis, into.at, lane);
            if (nodes.size > before) added = true;
          }
        }
        // A script's runs name the data they read.
        if (node.category === 'code') for (const runs of process.edges.filter(e => mine(e) && e.label === 'runs' && byId.get(e.from)?.path === node.path)) {
          for (const named of process.edges.filter(e => e.to === runs.to && e.label === 'named')) {
            const data = byId.get(named.from);
            if (!data?.path || data.path === node.path) continue;
            const before = nodes.size;
            edge(edges, node.id, fileNode(data.path, lane, named.at).id, 'reads', 'named', named.at, lane);
            if (nodes.size > before) added = true;
          }
        }
      }
    }
  }

  // Each file to the version the process kept, where that version is drawn.
  for (const node of nodes.values()) {
    if (node.kind !== 'file' || !node.path) continue;
    const kept = processNodeOf(node.path, node.resource?.version) ?? processNodeOf(node.path);
    if (kept) edge(links, node.id, kept.id, 'kept as', 'observed', node.capturedAt ?? node.at, node.events[0]!.turn);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], turns, traces: [...links.values()] };
}

export type GraphLayer = 'meaning' | 'both' | 'process';
// The graph a layer shows: the meaning rows, the process rows, or the meaning rows above the
// process rows with the trace edges between them.
export function layered(process: WorkGraph, meaning: MeaningLayer | null, layer: GraphLayer): WorkGraph {
  if (layer === 'process' || !meaning || !meaning.nodes.length) return process;
  if (layer === 'meaning') return { ...process, nodes: meaning.nodes, edges: meaning.edges, turns: meaning.turns, events: [], live: null, omittedNodes: 0 };
  return { ...process, nodes: [...meaning.nodes, ...process.nodes], edges: [...meaning.edges, ...meaning.traces, ...process.edges], turns: [...meaning.turns, ...process.turns] };
}
