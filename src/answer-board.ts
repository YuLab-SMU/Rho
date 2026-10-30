import type { GraphEdge, GraphNode, WorkGraph } from './work-graph.js';

// One answer laid out by what each file is to it, not by its kind or where a viewer last was:
// the result that answers it largest, the results beside it, the script and the commands that
// made them, and the data they started from. Roles come from the Graph's own links, so each
// keeps the basis it was drawn with: a result "changed while a command ran" is that, not a
// claim that the command produced it. A person or the Agent may later move an item to
// another role or hide it; what the record says stays the same.
export type BoardRole = 'primary' | 'supporting' | 'report' | 'method' | 'run' | 'input';
export interface BoardItem { node: GraphNode; role: BoardRole; why: string; mentioned: boolean }
export interface AnswerBoard {
  turn: string; question: GraphNode; items: BoardItem[];
  // Commands of this message that changed no result: counted here, listed in the Console.
  otherCommands: number;
  omitted: Partial<Record<BoardRole, number>>;
}
// The protected resource is the page a person reads: past these, a role says how many more
// it has rather than growing.
export const boardLimits = { supporting: 4, method: 2, run: 2, input: 4, report: 2 };

// A command as a person names it: its first step, without where its output was sent.
// `python3 analysis.py > /tmp/out.txt 2>&1; echo done` is `python3 analysis.py`.
// Moving into a folder or setting a variable first is not the step; a script given inline is named so.
export function commandGist(command: string) {
  const steps = command.replace(/\s+/g, ' ').trim().split(/\s*(?:;|&&|\|\||\|)\s*/).filter(Boolean);
  const first = steps.find(step => !/^(?:cd|export|source|set|\.)\s/.test(step)) ?? steps[0] ?? '';
  const inline = /<<-?\s*['"]?\w+/.test(first);
  const bare = first.replace(/\s*\d?>>?\s*&?\S+/g, '').replace(/\s*<<-?\s*['"]?\w+['"]?.*$/, '').replace(/\s+-$/, '').trim();
  return (inline ? bare + ' (inline script)' : bare) || command.trim();
}
const quote = (text: string, max = 48) => { const t = commandGist(text); return '`' + (t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t) + '`'; };
const isResult = (node: GraphNode) => node.category === 'figures' || node.category === 'results' || node.category === 'data';

export function answerBoard(graph: WorkGraph, turn: string): AnswerBoard | null {
  const question = graph.nodes.find(n => n.id === 'q:' + turn);
  if (!question) return null;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const own = graph.edges.filter(e => e.turn === turn);
  const answer = (question.answer ?? '').toLowerCase();
  const mentioned = (node: GraphNode) => !!node.path && answer.includes((node.path.split('/').at(-1) ?? '').toLowerCase());
  const runs = new Map<string, GraphNode>();
  const outputs = new Map<string, { node: GraphNode; edge: GraphEdge }>();
  for (const e of own) {
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to || to.kind !== 'file') continue;
    const made = (from.kind === 'question' && (e.label === 'wrote' || e.label === 'edited' || e.label === 'changed meanwhile')) || (from.kind === 'run' && e.label === 'changed while it ran');
    // A file of no kind the project shows — an Agent's own settings, a cache — is no output of the work.
    if (!made || !to.category) continue;
    // A command's observed change says more about where a file came from than "the Agent wrote it".
    const known = outputs.get(to.id);
    if (!known || (from.kind === 'run' && known.edge.from === question.id)) outputs.set(to.id, { node: to, edge: e });
    if (from.kind === 'run') runs.set(from.id, from);
  }
  const items: BoardItem[] = [], omitted: AnswerBoard['omitted'] = {};
  const add = (role: BoardRole, list: Array<{ node: GraphNode; why: string }>) => {
    const limit = role === 'primary' ? 1 : boardLimits[role];
    for (const { node, why } of list.slice(0, limit)) items.push({ node, role, why, mentioned: mentioned(node) });
    if (list.length > limit && role !== 'primary') omitted[role] = list.length - limit;
  };
  const madeBy = (o: { node: GraphNode; edge: GraphEdge }) => {
    const from = byId.get(o.edge.from)!;
    return from.kind === 'run' ? 'Changed while ' + quote(from.command ?? from.title) + ' ran' : o.edge.label === 'changed meanwhile' ? 'Changed on disk during this message' : o.edge.label === 'edited' ? 'Edited by the Agent' : 'Written by the Agent';
  };
  // Results the answer names lead, then the newest; a figure answers before a table does.
  const results = [...outputs.values()].filter(o => isResult(o.node))
    .sort((a, b) => Number(mentioned(b.node)) - Number(mentioned(a.node)) || Number(b.node.category === 'figures') - Number(a.node.category === 'figures') || b.node.at - a.node.at);
  const lead = results.find(o => o.node.category === 'figures' && mentioned(o.node)) ?? results.find(o => mentioned(o.node)) ?? results.find(o => o.node.category === 'figures') ?? results[0];
  if (lead) add('primary', [{ node: lead.node, why: madeBy(lead) }]);
  add('supporting', results.filter(o => o !== lead).sort((a, b) => Number(mentioned(b.node)) - Number(mentioned(a.node)) || a.node.at - b.node.at).map(o => ({ node: o.node, why: madeBy(o) })));
  add('report', [...outputs.values()].filter(o => o.node.category === 'notes').map(o => ({ node: o.node, why: madeBy(o) })));
  // The method: a script a producing command ran, then scripts this message wrote or edited.
  const ranBy = (code: GraphNode) => own.filter(e => e.from === code.id && e.label === 'runs').map(e => byId.get(e.to)).filter((r): r is GraphNode => !!r && runs.has(r.id));
  const scripts = graph.nodes.filter(n => n.kind === 'file' && n.category === 'code' && (ranBy(n).length > 0 || outputs.has(n.id)))
    .sort((a, b) => ranBy(b).length - ranBy(a).length || a.at - b.at);
  add('method', scripts.map(code => {
    const run = ranBy(code)[0], edits = code.events.filter(e => e.turn === turn && (e.action === 'edit' || e.action === 'write')).length;
    const versions = code.versions?.length ?? 0;
    return { node: code, why: [run ? 'Run by ' + quote(run.command ?? run.title) : '', edits ? (edits === 1 ? 'Written in this message' : 'Written and edited ' + edits + ' times in this message') : '', versions > 1 ? versions + ' versions kept' : ''].filter(Boolean).join(' · ') };
  }));
  const producing = [...runs.values()].sort((a, b) => a.at - b.at);
  add('run', producing.map(run => {
    const made = own.filter(e => e.from === run.id && e.label === 'changed while it ran').length;
    return { node: run, why: made + (made === 1 ? ' file changed while it ran' : ' files changed while it ran') };
  }));
  // What it started from: data the message read, or a file a producing command names.
  const inputs = new Map<string, { node: GraphNode; why: string }>();
  for (const e of own) {
    const from = byId.get(e.from);
    if (!from || from.kind !== 'file' || outputs.has(from.id) || from.category === 'code') continue;
    if (e.to === question.id && e.label === 'read') inputs.set(from.id, { node: from, why: 'Read by the Agent' });
    else if (e.label === 'named' && runs.has(e.to) && !inputs.has(from.id)) inputs.set(from.id, { node: from, why: 'Named by ' + quote(byId.get(e.to)!.command ?? '') });
  }
  add('input', [...inputs.values()].sort((a, b) => Number(b.node.category === 'data') - Number(a.node.category === 'data') || a.node.at - b.node.at));
  const commands = graph.nodes.filter(n => n.kind === 'run' && n.turn === turn && !runs.has(n.id));
  const otherCommands = commands.reduce((sum, n) => sum + (n.commands?.length ?? 1), 0);
  return { turn, question, items, otherCommands, omitted };
}

// Which message the board shows, and what was asked about it since. A message that made results
// holds the board; later messages in its conversation that made none are questions about it and
// follow it, until the next message that made results.
export function boardThreads(graph: WorkGraph) {
  const asked = [...graph.turns].sort((a, b) => b.start - a.start);
  const boards = new Map(asked.map(t => [t.id, answerBoard(graph, t.id)]));
  const made = (id: string) => !!boards.get(id)?.items.some(i => i.role === 'primary' || i.role === 'supporting');
  const holders = asked.filter(t => made(t.id));
  const threads = (holders.length ? holders : asked).map(turn => {
    const later = asked.filter(t => t.conversationId === turn.conversationId && t.start > turn.start).sort((a, b) => a.start - b.start);
    const next = later.findIndex(t => made(t.id));
    return { turn, board: boards.get(turn.id)!, followUps: holders.length ? (next < 0 ? later : later.slice(0, next)) : [] };
  });
  return threads.filter(t => t.board);
}
