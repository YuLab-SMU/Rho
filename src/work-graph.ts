import { commandEnd, conversationBlocks, displayCommand, segments, stepDuration, type ActivityOutcome, type ConversationTurn, type SessionObservation } from './conversation-presentation.js';
import { askedAbout } from './asking.js';
import type { Statement, Trace } from './notes-meaning.js';
import type { Holds } from './file-describer.js';

// What the Agent did in a project, drawn as a graph: each question a person asked, the files
// its turn read and changed, the commands it ran, and the files that changed on disk while it
// worked. Every edge says where it comes from: the Agent's own report of an action, a file a
// command line names, or a change seen on disk at that time. Nothing here proves that a run
// produced a file; a change seen while it ran is labelled as exactly that.

export interface PathScope { root: string; sources?: ReadonlyArray<{ id: string; root: string }> | null }
// A path the Agent reported, as the project names it: relative inside the project folder,
// @<sourceId>/… inside a source folder, nothing anywhere else or in internal state.
// A Windows path is absolute from its drive (C:\… or, in Git Bash, /c/…), and a folder there is
// named with either case of its letters.
const drive = (p: string) => /^[A-Za-z]:\//.test(p);
export function projectPath(reported: string, project: PathScope): string | null {
  const value = reported.trim().replace(/\\/g, '/');
  if (!value) return null;
  const inside = (root: string) => {
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    if (!drive(base)) return value.startsWith(base) ? value.slice(base.length) : null;
    const windows = /^\/[A-Za-z]\//.test(value) ? value[1] + ':' + value.slice(2) : value;
    return windows.toLowerCase().startsWith(base.toLowerCase()) ? windows.slice(base.length) : null;
  };
  let relative: string | null = null;
  if (!value.startsWith('/') && !drive(value)) relative = value.replace(/^\.\//, '');
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

// The files a command line runs rather than only names: those in a part of it whose program is
// not one that reads, lists, moves or compares files. `Rscript analysis.R` runs the script;
// `cat analysis.R | head` and `rtk read analysis.R` look at it.
const lookers = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'wc', 'ls', 'll', 'find', 'stat', 'file', 'diff', 'cmp', 'cp', 'mv', 'rm', 'touch', 'chmod', 'git', 'echo', 'printf', 'test', '[', 'read', 'nl', 'sort', 'uniq', 'cut', 'tee', 'open', 'code', 'vim', 'nano', 'md5', 'shasum', 'sha256sum', 'du', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'mkdir', 'sips', 'cd']);
export function ranFiles(command: string, project: PathScope) {
  const ran = new Set<string>();
  for (const line of displayCommand(command).split('\n')) for (const part of segments(line)) {
    const words = part.trim().replace(/^(\w+=\S*\s+)+/, '').replace(/^(?:(?:time|nohup|env)\s+|(?:uv|poetry)\s+run\s+)+/, '').split(/\s+/);
    if (!words[0] || lookers.has(words[0].split('/').at(-1)!)) continue;
    for (const path of commandFiles(part, project)) ran.add(path);
  }
  return ran;
}

export type FileKind = 'data' | 'code' | 'figures' | 'notes' | 'results' | null;
export interface GraphFile { path: string; bytes: number; modifiedAt?: string; category: FileKind }
export interface GraphTurn { conversationId: string; conversationTitle: string; agent: string; turn: ConversationTurn; observation?: SessionObservation | null;
  external?: boolean; kernelCells?: string[]; reportedResults?: Array<{ path: string; at: string; resource?: { id: string; version: string } }> }
export interface GraphInput {
  turns: GraphTurn[]; files: GraphFile[]; project: PathScope;
  // The kind of a file the last walk did not see, from its name.
  kindOf: (path: string) => FileKind;
  now: number;
}
// What the notes conclude from these nodes, and the levels above them, are in work-layers.ts.
export type NodeKind = 'question' | 'file' | 'run';
export type EventAction = 'ask' | 'read' | 'edit' | 'write' | 'run' | 'changed' | 'capture' | 'answer' | 'report';
// Declared: written in the project notes, by the Agent or the person; not checked.
export type Basis = 'reported' | 'named' | 'observed' | 'declared';
export interface GraphEvent { key: string; at: number; node: string; turn: string; action: EventAction; label: string; outcome?: ActivityOutcome }
export interface GraphNode {
  id: string; kind: NodeKind; title: string; at: number;
  turn?: string; conversationId?: string; agent?: string; state?: string; answer?: string; model?: string | null; text?: string;
  resource?: { id: string; version: string }; capturedAt?: number; captureSource?: string; gap?: string;
  // Every exact version one message captured of this file, oldest first, when it captured more than one.
  versions?: Array<{ resource: { id: string; version: string }; capturedAt: number; captureSource?: string; bytes?: number }>;
  // The commands one card stands for when a message's commands that touched no project file fold together.
  commands?: GraphNode[];
  path?: string; category?: FileKind; exists?: boolean; bytes?: number; modifiedAt?: string;
  // A run: the command as named and as it actually ran, the Agent's own words on what it is
  // for, how it ended (its exit code when the Agent reported one), how long it ran and the
  // last lines it printed.
  command?: string; ran?: string; purpose?: string; outcome?: ActivityOutcome; end?: string | null; durationMs?: number | null; output?: { text: string; lines: number; cut: boolean };
  // A native permission request for this step that waits for the person.
  waiting?: { conversationId: string; turn: string; permission: string; title: string; options: Array<{ id: string; name: string; kind: string }> };
  // The events that touched this node, oldest first.
  events: GraphEvent[];
}
// The message an edge was recorded in: a file one message made and a later one read is drawn
// with that later message.
export interface GraphEdge { id: string; from: string; to: string; label: string; basis: Basis; at: number; turn: string }
export interface GraphTurnSpan { id: string; conversationId: string; title: string; agent: string; start: number; end: number; running: boolean }
export interface WorkGraph { nodes: GraphNode[]; edges: GraphEdge[]; events: GraphEvent[]; turns: GraphTurnSpan[]; live: { node: string; label: string; waiting?: boolean } | null }

// Nothing is left out of the graph for its size: every message that was read is in it. What a page
// draws of it at once is the page's own matter (the Graph draws the levels a person has opened,
// see work-layers.ts).
// A file that changed on disk this soon after a step still counts as changing during it.
const settleMs = 2500;

const time = (iso?: string | null) => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? value : null; };
const firstLine = (text: string, max = 140) => { const line = text.trim().split('\n').find(l => l.trim())?.trim() ?? ''; return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line; };
export const shortCommand = (command: string, max = 72) => { const text = command.replace(/\s+/g, ' ').trim(); return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text; };

export function buildWorkGraph(input: GraphInput): WorkGraph {
  const ordered = [...input.turns].sort((a, b) => (time(a.turn.sentAt) ?? 0) - (time(b.turn.sentAt) ?? 0));
  const nodes = new Map<string, GraphNode>(), edges = new Map<string, GraphEdge>(), events: GraphEvent[] = [], spans: GraphTurnSpan[] = [];
  const files = new Map(input.files.map(f => [f.path, f]));
  // Every path a step has touched so far, whichever version of it a node stands for.
  const touched = new Set<string>();
  let live = null as WorkGraph['live'], inTurn = '';
  let evidence: ConversationTurn['evidence'] | undefined;
  const fileNode = (path: string, at: number, exact?: NonNullable<ConversationTurn['evidence']>['records'][number]['snapshots'][number], reported?: { id: string; version: string }) => {
    const observed = evidence?.records.filter(r => r.path === path).flatMap(r => r.snapshots).filter(s => s.source.kind !== 'buffer').sort((a,b) => a.observedAt.localeCompare(b.observedAt)) ?? [];
    const selected = exact ?? [...observed].reverse().find(s => (time(s.observedAt) ?? Infinity) <= at);
    const id = 'f:' + path + (selected ? '@' + selected.resource.id : reported ? '@' + reported.id + ':' + reported.version : evidence ? '@' + inTurn + ':unrecorded' : '');
    let node = nodes.get(id);
    touched.add(path);
    if (!node) {
      const seen = files.get(path);
      node = { id, kind: 'file', title: path.split('/').at(-1) ?? path, at, path, category: seen?.category ?? input.kindOf(path), exists: !!seen, bytes: selected?.bytes ?? seen?.bytes, modifiedAt: seen?.modifiedAt, events: [], ...(selected ? { resource: selected.resource, capturedAt: time(selected.observedAt) ?? at, captureSource: String(selected.source.kind) } : reported ? { resource: reported, captureSource: 'tool reply' } : { gap: evidence ? evidence.records.find(r => r.path === path)?.reason ?? 'No historical snapshot was captured.' : 'No historical version was kept in this record.' }) };
      nodes.set(id, node);
    }
    return node;
  };
  const edge = (from: string, to: string, label: string, basis: Basis, at: number) => {
    const id = from + '>' + to + ':' + label;
    if (!edges.has(id)) edges.set(id, { id, from, to, label, basis, at, turn: inTurn });
  };
  const note = (node: GraphNode, event: Omit<GraphEvent, 'node'>) => { const full = { ...event, node: node.id }; node.events.push(full); events.push(full); node.at = Math.min(node.at, event.at); };

  ordered.forEach(({ conversationId, conversationTitle, agent, turn: message, observation, external, reportedResults }, position) => {
    // Message identities are per conversation; the graph names each by both.
    const turn = { ...message, id: conversationId + '/' + message.id };
    inTurn = turn.id; evidence = turn.evidence;
    const sent = time(turn.sentAt) ?? input.now, start = time(turn.startedAt) ?? sent;
    const running = turn.state === 'running';
    const end = time(turn.endedAt) ?? (running ? input.now : start);
    // A change on disk belongs to this message until the next one is sent.
    const next = position + 1 < ordered.length ? time(ordered[position + 1].turn.sentAt) ?? Infinity : Infinity;
    const q: GraphNode = { id: 'q:' + turn.id, kind: 'question', title: firstLine(askedAbout(turn.text).question) || 'A message', text: turn.text, at: sent, turn: turn.id, conversationId, agent, state: turn.state, model: turn.model ?? null, events: [] };
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
      const window = external ? { from: at, to: at } : activity.outcome === 'requested' ? { from: at, to: end } : { from: Math.min(before, at), to: at };
      // A refused step did nothing; a command that ran and failed did, and stays.
      if (activity.outcome === 'rejected') return;
      const isLive = running && index === activities.length - 1 && activity.outcome === 'requested';
      if (activity.action === 'execute') {
        // A command is drawn from the start of its window, so what it made follows it in a replay.
        const command = activity.step.detail ?? activity.target ?? 'a command', from = window.from, step = activity.step;
        const run: GraphNode = { id: 'r:' + turn.id + ':' + index, kind: 'run', title: shortCommand(displayCommand(command)), command: displayCommand(command), ran: command, ...(step.purpose ? { purpose: step.purpose } : {}), at: from, turn: turn.id, outcome: activity.outcome,
          end: commandEnd(step), durationMs: stepDuration(step), ...(step.output ? { output: { text: step.output.text, lines: step.output.lines, cut: step.output.cut } } : {}), events: [] };
        nodes.set(run.id, run);
        if (activity.step.id) byStep.set(activity.step.id, run.id);
        note(run, { key: activity.key, at: from, turn: turn.id, action: 'run', label: activity.outcome === 'requested' ? 'Running' : 'Ran', outcome: activity.outcome });
        edge(q.id, run.id, 'ran', 'reported', from);
        runs.push({ node: run, ...window });
        // A command names the script it runs and sometimes the files it reads or writes. A script
        // given to a program that runs things is run; which of the other files it reads or writes
        // a command line does not say, unless the file changed while it ran.
        const ran = ranFiles(command, input.project);
        for (const path of commandFiles(command, input.project)) {
          if (!files.has(path) && !touched.has(path)) continue;
          const modified = time(files.get(path)?.modifiedAt), code = (files.get(path)?.category ?? input.kindOf(path)) === 'code';
          // A file that changed while the command ran is drawn as changing then, below.
          if (!code && modified !== null && modified >= window.from && modified <= window.to + settleMs) continue;
          edge(fileNode(path, from).id, run.id, code && ran.has(path) ? 'runs' : 'named', 'named', from);
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
    for (const record of evidence?.records ?? []) for (const snapshot of record.snapshots) {
      const capturedAt = time(snapshot.observedAt) ?? end;
      const node = fileNode(record.path, capturedAt, snapshot);
      note(node, { key: turn.id + ':capture:' + record.key + ':' + snapshot.resource.id, at: capturedAt, turn: turn.id, action: 'capture', label: snapshot.source.kind === 'buffer' ? 'Captured buffer version ' + snapshot.source.version + (snapshot.source.dirty ? ' (unsaved)' : '') : 'Captured disk bytes' });
      edge(q.id, node.id, 'captured observation', 'observed', capturedAt);
    }
    const answer = [...blocks].reverse().find(block => block.kind === 'text');
    if (answer?.kind === 'text' && answer.step.text) q.answer = answer.step.text;
    for (const result of reportedResults ?? []) {
      const path = projectPath(result.path, input.project); if (!path) continue;
      const at = time(result.at); if (at === null || at > input.now) continue;
      const node = fileNode(path, at, undefined, result.resource);
      note(node, { key: turn.id + ':result:' + path, at, turn: turn.id, action: 'report', label: 'Reported result' });
      edge(q.id, node.id, 'reported result', 'reported', at);
    }
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
  // A kept version is on its file's card. Its own line from the question is drawn only when
  // nothing else in that message touches the file (a read, an edit, a command naming it);
  // otherwise it repeats the path beside it.
  const reached = new Set([...edges.values()].filter(e => e.label !== 'captured observation').flatMap(e => [e.turn + '>' + e.to, e.turn + '>' + e.from]));
  const kept = [...edges.values()].filter(e => nodes.has(e.from) && nodes.has(e.to) && !(e.label === 'captured observation' && reached.has(e.turn + '>' + e.to)));
  for (const node of nodes.values()) node.events.sort((a, b) => a.at - b.at);
  return {
    nodes: [...nodes.values()].sort((a, b) => a.at - b.at), edges: kept,
    events: events.filter(e => nodes.has(e.node)).sort((a, b) => a.at - b.at), turns: spans.filter(s => nodes.has('q:' + s.id)),
    live: live && nodes.has(live.node) ? live : null,
  };
}

// One card per file per message: the versions a message captured of the same file fold into the
// newest, which keeps every exact version, oldest first, and the events and edges of all of them.
// A message that rewrites its script nine times draws one script, not a column of nine.
// A "captured" edge beside the message's own edit or write of that file says nothing more.
// Commands of one message that read, ran or changed no project file — looking around, checking an
// environment, computing in a heredoc — fold the same way into one card that lists each of them,
// so the commands that made the results stand out.
export const foldLimits = { otherCommands: 3 };
export function foldVersions(graph: WorkGraph): WorkGraph {
  // A file only named by a command has no events of its own; its edge says which message it is in.
  const home = (node: GraphNode) => node.events[0]?.turn ?? graph.edges.find(e => e.from === node.id || e.to === node.id)?.turn ?? '';
  const groups = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) if (node.kind === 'file' && node.path) {
    const key = node.path + '\n' + home(node);
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  const into = new Map<string, string>(), folded = new Map<string, GraphNode>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => (a.capturedAt ?? a.at) - (b.capturedAt ?? b.at));
    const newest = ordered.at(-1)!;
    const versions = ordered.filter(n => n.resource).map(n => ({ resource: n.resource!, capturedAt: n.capturedAt!, captureSource: n.captureSource, bytes: n.bytes }));
    const events = ordered.flatMap(n => n.events).map(e => ({ ...e, node: newest.id })).sort((a, b) => a.at - b.at);
    folded.set(newest.id, { ...newest, at: Math.min(...ordered.map(n => n.at)), events, ...(versions.length > 1 ? { versions } : {}) });
    for (const n of ordered) into.set(n.id, newest.id);
  }
  const quiet = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) if (node.kind === 'run' && node.turn && node.outcome !== 'requested' && !node.waiting
    && graph.edges.every(e => (e.from !== node.id && e.to !== node.id) || (e.to === node.id && e.from === 'q:' + node.turn))) quiet.set(node.turn, [...(quiet.get(node.turn) ?? []), node]);
  for (const [turn, runs] of quiet) {
    if (runs.length < foldLimits.otherCommands) continue;
    const id = 'r:' + turn + ':others', last = runs.at(-1)!;
    const events = runs.flatMap(n => n.events).map(e => ({ ...e, node: id })).sort((a, b) => a.at - b.at);
    const failed = runs.filter(n => n.outcome !== 'returned' || (n.end && !/^exit 0\b/i.test(n.end))).length;
    folded.set(id, { id, kind: 'run', title: runs.length + ' other commands', at: runs[0].at, turn, outcome: last.outcome, end: failed ? failed + ' did not finish cleanly' : 'All finished', durationMs: runs.reduce((sum, n) => sum + (n.durationMs ?? 0), 0) || null, events, commands: runs });
    for (const n of runs) into.set(n.id, id);
  }
  const to = (id: string) => into.get(id) ?? id;
  const nodes = [...graph.nodes.filter(n => to(n.id) === n.id).map(n => folded.get(n.id) ?? n), ...[...folded.values()].filter(n => !graph.nodes.some(o => o.id === n.id))].sort((a, b) => a.at - b.at);
  const edges = new Map<string, GraphEdge>();
  for (const e of [...graph.edges].sort((a, b) => a.at - b.at)) {
    const from = to(e.from), target = to(e.to);
    if (from === target) continue;
    const id = from + '>' + target + ':' + e.label;
    if (!edges.has(id)) edges.set(id, { ...e, id, from, to: target });
  }
  // As above: once versions fold into one card, a kept version's own line goes when the message reaches that card another way.
  const reached = new Set([...edges.values()].filter(e => e.label !== 'captured observation').flatMap(e => [e.turn + '>' + e.to, e.turn + '>' + e.from]));
  for (const e of [...edges.values()]) if (e.label === 'captured observation' && reached.has(e.turn + '>' + e.to)) edges.delete(e.id);
  return { ...graph, nodes, edges: [...edges.values()], events: graph.events.map(e => into.has(e.node) ? { ...e, node: to(e.node) } : e), live: graph.live && { ...graph.live, node: to(graph.live.node) } };
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
