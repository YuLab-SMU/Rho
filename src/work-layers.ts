import { conversationBlocks, type Activity, type ActivityOutcome, type ConversationStep } from './conversation-presentation.js';
import { askedAbout } from './asking.js';
import { projectPath, type Basis, type FileKind, type GraphNode, type GraphTurn, type PathScope, type WorkGraph } from './work-graph.js';
import type { SessionMeaning, Statement, Trace } from './notes-meaning.js';
import { projectNotesPath } from './project-notes.js';

// The work in a project as one graph read at several levels. The lowest level is the record
// itself: every step an Agent took, as it was kept. Each level above stands for the nodes below
// it and can list them: an activity is a run of steps on one thing (looking around, a script
// written and run until it worked, the notes), an ask is one message and its answer, a line of
// work is the asks on one question, and the workspace is its lines of work. Nothing above a step
// is drawn that the steps under it do not carry: a link between two upper nodes is the links of
// their steps, counted, each with the basis the record gave it.
//
// What the notes say (findings, choices) is not a second graph. A statement names files; steps
// made those files; so a statement is tied to the steps that made what it rests on, and to the
// step that wrote it. A statement that names no file, or a file no recorded step made, says so.

export type Level = 'workspace' | 'line' | 'ask' | 'activity' | 'step';
export type ActivityKind = 'look' | 'cells' | 'build' | 'notes' | 'answer';
export type Verb = 'read' | 'edited' | 'wrote' | 'ran' | 'named' | 'changed' | 'removed' | 'reported';

export interface WorkNode {
  id: string; level: Level; parent: string | null; children: string[];
  title: string;
  // Words the record has for it: the question a line asks, the Agent's sentence before an
  // activity, a command's stated purpose.
  said?: string;
  start: number; end: number; running: boolean;
  // The recorded steps it stands for, and how many of them were refused, failed or have no known outcome.
  steps: number; failed: number;
  // A line of work: its section of the notes when it has one, its conversations, and whether it
  // changed any project file or says anything.
  section?: SessionMeaning; conversations?: string[]; agents?: string[]; quiet?: boolean;
  // An ask that is commands typed in a terminal, not a message; a line of only such asks.
  terminal?: boolean;
  // An ask: the message as the Graph names it (conversation/message), and its answer.
  turn?: string; conversationId?: string; agent?: string; state?: string; text?: string; answer?: string;
  // An activity.
  kind?: ActivityKind; edits?: number; runs?: number; cells?: number; rounds?: number;
  // A step: its place in the record and the record itself.
  key?: string; action?: string; outcome?: ActivityOutcome | 'said' | 'error'; record?: ConversationStep; activity?: Activity;
  // The behaviour graph's node for a command, with its output.
  run?: GraphNode;
}
// One recorded relation between a step and a file. `work` is a step, or an ask when the record
// ties the file to the message but to no step of it (a change seen on disk while no command ran).
export interface Touch { work: string; path: string; verb: Verb; basis: Basis; at: number; makes: boolean }
export interface Artifact { path: string; title: string; category: FileKind; exists: boolean; nodes: GraphNode[] }
// Where a statement stands on the record: a recorded step made a file it names, it names files
// but none a recorded step made, or it names none.
export type Ground = 'made' | 'named' | 'none';
export interface Claim { id: string; line: string; kind: 'finding' | 'choice'; text: string; statement: Statement; trace?: Trace; paths: string[]; written: string | null; ground: Ground }
export interface WorkLayers { root: string; nodes: Map<string, WorkNode>; touches: Touch[]; artifacts: Map<string, Artifact>; claims: Claim[];
  // What a message's record says happened to a file on disk while it ran, by ask and path.
  changes: Map<string, 'added' | 'modified' | 'removed'> }
export interface LayersInput {
  turns: GraphTurn[];
  // The behaviour graph of the same turns (work-graph.ts), folded or not.
  graph: WorkGraph; project: PathScope;
  meanings?: SessionMeaning[]; traces?: Map<Statement, Trace>;
  now: number;
}

const time = (iso?: string | null) => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? value : null; };
const firstLine = (text: string, max = 160) => { const line = text.trim().split('\n').find(l => l.trim())?.trim() ?? ''; return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line; };
const sentence = (text: string, max = 150) => {
  const line = text.replace(/\s+/g, ' ').trim(), first = /^(.+?[.!?。！？])(\s|$)/.exec(line)?.[1] ?? line, clean = first.replace(/[:：]$/, '');
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
};
const names = (paths: string[]) => { const shown = [...new Set(paths.map(p => p.split('/').at(-1)!))]; return shown.length > 2 ? shown.slice(0, 2).join(', ') + ' and ' + (shown.length - 2) + ' more' : shown.join(' and '); };
const times = (n: number) => n === 1 ? 'once' : n === 2 ? 'twice' : n + ' times';
const makes = (verb: Verb) => verb !== 'read' && verb !== 'ran' && verb !== 'named';
export const isNotes = (path: string) => path === projectNotesPath;

// How many steps of looking around, with no words from the Agent, stand as an activity of their
// own between two pieces of work; after the Agent's words, the steps before them need fewer.
export const gapLimits = { own: 6, afterWords: 4 };
type Mode = 'notes' | 'build' | 'cells' | null;
interface Raw { id: string; key: string; at: number; from: number; tool: boolean; text?: string; error?: boolean; activity?: Activity; step: ConversationStep; path: string | null; mode: Mode; edit: boolean; script: string | null }

// A message's steps as the activities a person would tell it in. A step that edits the notes,
// edits another project file, runs a script or runs a cell says what is being worked on; the
// steps around it (reading, searching, a command that touches nothing) belong to that work.
// Looking before something new begins is part of it; looking after a run is still that run's.
// One or two steps of something else between two stretches on the same thing do not split it:
// a note written between two edits of a script is part of working on the script.
function activities(raws: Raw[]): Array<{ kind: ActivityKind; steps: Raw[] }> {
  const lastTool = raws.reduce((last, r, i) => r.tool ? i : last, -1);
  const body = raws.slice(0, lastTool + 1), tail = raws.slice(lastTool + 1);
  let strong = body.map((r, i) => ({ r, i })).filter(x => x.r.mode);
  // A lone cell between other work is a look at something, not a stretch of exploring.
  if (new Set(strong.map(x => x.r.mode)).size > 1) {
    const lone = strong.filter((x, n) => x.r.mode === 'cells' && strong[n - 1]?.r.mode !== 'cells' && strong[n + 1]?.r.mode !== 'cells');
    for (const x of lone) x.r.mode = null;
    strong = strong.filter(x => x.r.mode);
  }
  interface Seg { mode: Exclude<Mode, null>; first: number; last: number; n: number; files: Set<string>; ran: boolean }
  const segs: Seg[] = [];
  for (const { r, i } of strong) {
    const cur = segs.at(-1);
    // A script is one piece of work from its first edit through its runs and fixes; editing a
    // different file after a run begins the next piece.
    const joins = cur && cur.mode === r.mode && (r.mode !== 'build' || !r.edit || cur.files.has(r.path!) || !cur.ran);
    const seg = joins ? cur : { mode: r.mode!, first: i, last: i, n: 0, files: new Set<string>(), ran: false };
    if (!joins) segs.push(seg);
    seg.last = i; seg.n++;
    if (r.mode === 'build') { if (r.edit) seg.files.add(r.path!); else { seg.ran = true; if (r.script) seg.files.add(r.script); } }
  }
  for (let merged = true; merged;) {
    merged = false;
    // The shortest interruption first: a note between two edits of a script, before the edits
    // between two stretches of notes.
    const between = segs.map((b, k) => ({ b, k })).filter(({ b, k }) => {
      const a = segs[k - 1], c = segs[k + 1];
      return a && c && b.n <= 2 && a.mode === c.mode && (a.mode !== 'build' || [...c.files].some(f => a.files.has(f)));
    }).sort((x, y) => x.b.n - y.b.n || x.k - y.k)[0];
    if (!between) break;
    const a = segs[between.k - 1]!, c = segs[between.k + 1]!;
    a.last = c.last; a.n += between.b.n + c.n; a.ran ||= c.ran; for (const f of c.files) a.files.add(f);
    segs.splice(between.k, 2); merged = true;
  }
  const out: Array<{ kind: ActivityKind; steps: Raw[] }> = [];
  if (!segs.length) { if (body.length) out.push({ kind: 'look', steps: body }); }
  else {
    // The steps between two pieces of work. When the Agent says something there, its words open
    // what comes next and the steps before them close what came before. Without words, a short
    // look belongs to what follows, except before the notes, where it is still looking at what
    // was just made. A long look is an activity of its own.
    let held: Raw[] = [];
    const look = (steps: Raw[]) => { if (steps.length) out.push({ kind: 'look', steps }); };
    segs.forEach((seg, k) => {
      const gap = body.slice(k ? segs[k - 1]!.last + 1 : 0, seg.first), said = gap.findIndex(r => !r.tool && !r.error && r.text?.trim());
      const before = said >= 0 ? gap.slice(0, said) : seg.mode === 'notes' ? gap : gap.length >= gapLimits.own ? gap : [];
      const lead = gap.slice(before.length), last = out.at(-1);
      if (!k) look(before);
      else if (before.length >= (said >= 0 ? gapLimits.afterWords : gapLimits.own) && (said >= 0 || seg.mode !== 'notes')) look(before);
      else if (last) last.steps.push(...before);
      held = [...lead, ...body.slice(seg.first, seg.last + 1)];
      out.push({ kind: seg.mode, steps: held });
    });
    held.push(...body.slice(segs.at(-1)!.last + 1));
  }
  if (tail.some(r => r.text?.trim())) out.push({ kind: 'answer', steps: tail });
  else if (tail.length && out.length) out.at(-1)!.steps.push(...tail);
  else if (tail.length) out.push({ kind: 'look', steps: tail });
  return out;
}

function activityTitle(kind: ActivityKind, steps: Raw[], first: boolean) {
  const edited = steps.filter(s => s.mode === 'build' && s.edit), runs = steps.filter(s => s.mode === 'build' && !s.edit), cells = steps.filter(s => s.step.operation === 'kernel.run').length;
  if (kind === 'answer') return 'Answered';
  if (kind === 'notes') return first ? 'Began the project notes' : 'Updated the project notes';
  if (kind === 'cells') return cells === 1 ? 'Ran a cell in the live session' : 'Ran ' + cells + ' cells in the live session';
  if (kind === 'build') {
    const wrote = edited.some(s => s.activity?.action === 'write') ? 'Wrote ' : 'Edited ';
    if (!edited.length) return 'Ran ' + names(runs.flatMap(s => s.script ? [s.script] : [])) + (runs.length > 1 ? ' ' + times(runs.length) : '');
    return wrote + names(edited.map(s => s.path!)) + (runs.length ? ' and ran it ' + times(runs.length) : '');
  }
  const read = steps.filter(s => s.activity?.action === 'read' && s.path).map(s => s.path!), commands = steps.filter(s => s.activity?.action === 'execute' && s.activity.outcome !== 'rejected').length;
  // Looking things up through Rho: its operations, a live session's cells and values.
  const lookups = steps.filter(s => s.activity?.action === 'project').length;
  const more = [commands ? commands + (commands === 1 ? ' command' : ' commands') : '', lookups ? lookups + (lookups === 1 ? ' lookup in Rho' : ' lookups in Rho') : ''].filter(Boolean).join(' and ');
  if (read.length) return 'Read ' + names(read) + (more ? ', with ' + more : '');
  if (more) return 'Looked around with ' + more;
  return steps.some(s => s.tool) ? 'Looked at the project' : 'Said something';
}

const people = (all: string[]) => all.length > 1 ? all.slice(0, -1).join(', ') + ' and ' + all.at(-1) : all[0] ?? 'someone';

export function buildWorkLayers(input: LayersInput): WorkLayers {
  const { graph, project } = input, meanings = input.meanings ?? [], traces = input.traces ?? new Map<Statement, Trace>();
  const nodes = new Map<string, WorkNode>(), touches: Touch[] = [], artifacts = new Map<string, Artifact>();
  const root: WorkNode = { id: 'w', level: 'workspace', parent: null, children: [], title: 'Workspace', start: Infinity, end: 0, running: false, steps: 0, failed: 0 };
  nodes.set(root.id, root);
  const stepId = (turn: string, key: string) => 's:' + turn + ':' + key, askId = (turn: string) => 'a:' + turn;

  // The files of the behaviour graph, and each recorded relation between a step and a file.
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const runs = new Map<string, GraphNode>(), runStep = new Map<string, string>();
  for (const node of graph.nodes) if (node.kind === 'run') for (const run of node.commands ?? [node]) {
    const event = run.events[0];
    if (!event) continue;
    runs.set(stepId(event.turn, event.key), run); runStep.set(run.id, stepId(event.turn, event.key));
    if (node.commands) runStep.set(node.id, runStep.get(node.id) ?? stepId(event.turn, event.key));
  }
  for (const node of graph.nodes) {
    if (node.kind !== 'file' || !node.path) continue;
    const known = artifacts.get(node.path);
    if (known) { known.nodes.push(node); known.exists ||= !!node.exists; }
    else artifacts.set(node.path, { path: node.path, title: node.title, category: node.category ?? null, exists: !!node.exists, nodes: [node] });
    for (const e of node.events) if (e.action === 'read' || e.action === 'edit' || e.action === 'write')
      touches.push({ work: stepId(e.turn, e.key), path: node.path, verb: e.action === 'read' ? 'read' : e.action === 'edit' ? 'edited' : 'wrote', basis: 'reported', at: e.at, makes: e.action !== 'read' });
  }
  for (const e of graph.edges) {
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to) continue;
    if (from.kind === 'run' && to.kind === 'file' && to.path && e.label === 'changed while it ran' && runStep.has(from.id)) touches.push({ work: runStep.get(from.id)!, path: to.path, verb: 'changed', basis: e.basis, at: e.at, makes: true });
    else if (from.kind === 'file' && to.kind === 'run' && from.path && (e.label === 'runs' || e.label === 'named') && runStep.has(to.id)) touches.push({ work: runStep.get(to.id)!, path: from.path, verb: e.label === 'runs' ? 'ran' : 'named', basis: e.basis, at: e.at, makes: false });
    else if (from.kind === 'question' && to.kind === 'file' && to.path && (e.label === 'changed meanwhile' || e.label === 'removed meanwhile' || e.label === 'reported result'))
      touches.push({ work: askId(e.turn), path: to.path, verb: e.label === 'changed meanwhile' ? 'changed' : e.label === 'removed meanwhile' ? 'removed' : 'reported', basis: e.basis, at: e.at, makes: true });
  }
  for (const a of artifacts.values()) a.nodes.sort((x, y) => (x.capturedAt ?? x.at) - (y.capturedAt ?? y.at));
  touches.sort((a, b) => a.at - b.at);
  const ranBy = new Map<string, string>();
  for (const t of touches) if (t.verb === 'ran') ranBy.set(t.work, t.path);

  // Each message: its steps, in the order and with the keys the behaviour graph gave them, then its activities.
  const ordered = [...input.turns].sort((a, b) => (time(a.turn.sentAt) ?? 0) - (time(b.turn.sentAt) ?? 0));
  const asks: WorkNode[] = [], toolStep = new Map<string, string>(), notesSteps = new Map<string, Array<{ id: string; at: number }>>();
  // The conversations that have written in the notes, and what each message's record says happened to a file on disk.
  const begun = new Set<string>(), changes = new Map<string, 'added' | 'modified' | 'removed'>();
  for (const { conversationId, conversationTitle, agent, turn: message, observation, terminal } of ordered) {
    const turn = conversationId + '/' + message.id, question = byId.get('q:' + turn);
    const sent = time(message.sentAt) ?? input.now, start = time(message.startedAt) ?? sent, running = message.state === 'running';
    const end = time(message.endedAt) ?? (running ? input.now : start);
    const ask: WorkNode = { id: askId(turn), level: 'ask', parent: null, children: [], title: firstLine(askedAbout(message.text).question) || 'A message', said: conversationTitle,
      start: sent, end: Math.max(end, sent), running, steps: 0, failed: 0, turn, conversationId, agent, state: message.state, text: message.text, ...(question?.answer ? { answer: question.answer } : {}), ...(terminal ? { terminal: true } : {}) };
    nodes.set(ask.id, ask); asks.push(ask);
    for (const file of message.files?.changed ?? []) changes.set(ask.id + '\n' + file.path, file.change);
    const raws: Raw[] = [];
    for (const block of conversationBlocks({ ...message, id: turn }, observation ?? null, project.root)) {
      if (block.kind !== 'activity') { raws.push({ id: stepId(turn, block.key), key: block.key, at: time(block.step.at) ?? start, from: time(block.step.at) ?? start, tool: false, text: block.step.text ?? '', error: block.kind === 'error', step: block.step, path: null, mode: null, edit: false, script: null }); continue; }
      for (const activity of block.activities) {
        const id = stepId(turn, activity.key), step = activity.step, at = time(step.at) ?? start;
        const onFile = activity.action === 'read' || activity.action === 'edit' || activity.action === 'write' || activity.action === 'delete' || activity.action === 'move';
        const path = onFile ? projectPath(activity.location ?? step.detail ?? '', project) : null;
        const changes = onFile && activity.action !== 'read' && !!path, script = ranBy.get(id) ?? null, refused = activity.outcome === 'rejected';
        const mode: Mode = refused ? null : changes ? (isNotes(path!) ? 'notes' : 'build') : script ? 'build' : step.operation === 'kernel.run' ? 'cells' : null;
        raws.push({ id, key: activity.key, at, from: time(step.startedAt) ?? at, tool: true, activity, step, path, mode, edit: changes, script });
        if (step.id) toolStep.set(turn + '\n' + step.id, id);
        if (mode === 'notes') notesSteps.set(turn, [...(notesSteps.get(turn) ?? []), { id, at }]);
      }
    }
    activities(raws).forEach(({ kind, steps }) => {
      const lead = steps.find(s => s.mode) ?? steps[0]!, words = steps.find(s => !s.tool && !s.error && s.text?.trim());
      const edits = steps.filter(s => s.edit).length, ran = steps.filter(s => s.mode === 'build' && !s.edit).length;
      let rounds = 0, edited = false;
      for (const s of steps) { if (s.edit && s.mode === 'build') edited = true; else if (s.mode === 'build' && edited) { rounds++; edited = false; } }
      const activity: WorkNode = { id: 'v:' + turn + ':' + lead.key, level: 'activity', parent: ask.id, children: [], title: activityTitle(kind, steps, kind === 'notes' && !begun.has(conversationId)),
        ...(kind !== 'answer' && words ? { said: sentence(words.text!) } : {}), start: Math.min(...steps.map(s => s.from)), end: Math.max(...steps.map(s => s.at)), running: false, steps: 0, failed: 0,
        kind, edits, runs: ran, cells: steps.filter(s => s.step.operation === 'kernel.run').length, rounds, turn, conversationId, agent };
      if (steps.some(s => s.mode === 'notes')) begun.add(conversationId);
      nodes.set(activity.id, activity); ask.children.push(activity.id);
      for (const s of steps) {
        const a = s.activity, cell = s.step.operation === 'kernel.run';
        const title = !s.tool ? (s.error ? 'Error: ' : '') + sentence(s.text ?? '', 200) : cell ? (a!.outcome === 'requested' ? 'Running a cell' : 'Ran a cell') : [a!.verb, a!.target].filter(Boolean).join(' ');
        const failed = s.tool ? a!.outcome !== 'returned' && a!.outcome !== 'requested' : !!s.error;
        const step: WorkNode = { id: s.id, level: 'step', parent: activity.id, children: [], title: title || 'A step', ...(s.step.purpose ? { said: s.step.purpose } : s.step.terminal ? { said: 'In the terminal · typed by ' + people(s.step.terminal.by) } : {}), start: s.from, end: s.at, running: false, steps: 1, failed: failed ? 1 : 0,
          key: s.key, action: s.tool ? a!.action : s.error ? 'error' : 'say', outcome: s.tool ? a!.outcome : s.error ? 'error' : 'said', record: s.step, ...(a ? { activity: a } : {}), ...(runs.has(s.id) ? { run: runs.get(s.id)! } : {}), turn, conversationId, agent };
        nodes.set(step.id, step); activity.children.push(step.id);
      }
    });
    if (running && ask.children.length) nodes.get(ask.children.at(-1)!)!.running = true;
  }

  // Lines of work. A section of the notes names one and the conversation that keeps it; a message
  // of another conversation that changed a file the section names belongs to it too. Conversations
  // without a section are each a line, and those that changed the same files are one line.
  const sectionOf = new Map<string, SessionMeaning>(), lineOfSection = new Map<SessionMeaning, string>();
  const madeBy = new Map<string, Set<string>>();
  const askOf = (work: string) => { let n = nodes.get(work); while (n && n.level !== 'ask') n = n.parent ? nodes.get(n.parent) : undefined; return n; };
  for (const t of touches) if (t.makes && !isNotes(t.path)) { const ask = askOf(t.work); if (ask) madeBy.set(ask.id, (madeBy.get(ask.id) ?? new Set()).add(t.path)); }
  const lines = new Map<string, WorkNode>();
  const line = (id: string, title: string, extra: Partial<WorkNode> = {}) => {
    let node = lines.get(id);
    if (!node) { node = { id, level: 'line', parent: root.id, children: [], title, start: Infinity, end: 0, running: false, steps: 0, failed: 0, conversations: [], agents: [], ...extra }; lines.set(id, node); }
    return node;
  };
  for (const section of meanings) {
    if (!section.statements.length && !section.conversationId) continue;
    const id = 'l:' + (section.conversationId ?? 'notes:' + section.title);
    const asked = section.statements.find(s => s.kind === 'question');
    line(id, section.title, { section, ...(asked ? { said: asked.text } : {}) });
    lineOfSection.set(section, id);
    if (section.conversationId) sectionOf.set(section.conversationId, section);
  }
  const named = [...lineOfSection].map(([section, id]) => ({ id, paths: new Set(section.statements.flatMap(s => [...s.links, ...(s.alternatives ?? []).flatMap(o => o.links)]).filter(p => !isNotes(p))) }));
  const home = new Map<string, string>(), loose = new Map<string, string>();
  for (const ask of asks) {
    const own = sectionOf.get(ask.conversationId!), made = madeBy.get(ask.id) ?? new Set<string>();
    const shared = own ? null : named.map(n => ({ id: n.id, n: [...made].filter(p => n.paths.has(p)).length })).sort((a, b) => b.n - a.n)[0];
    if (own) home.set(ask.id, lineOfSection.get(own)!);
    else if (shared && shared.n > 0) home.set(ask.id, shared.id);
    else loose.set(ask.id, ask.conversationId!);
  }
  // Conversations that changed the same files are one line of work.
  const group = new Map<string, string>(), find = (c: string): string => { const p = group.get(c) ?? c; if (p === c) return c; const r = find(p); group.set(c, r); return r; };
  const owner = new Map<string, string>();
  for (const [ask, conversation] of loose) for (const path of madeBy.get(ask) ?? []) { const first = owner.get(path); if (first) group.set(find(conversation), find(first)); else owner.set(path, conversation); }
  for (const ask of asks) {
    const id = home.get(ask.id) ?? 'l:' + find(loose.get(ask.id)!);
    const node = line(id, ask.said || ask.title);
    if (!node.said) node.said = firstLine(askedAbout(ask.text ?? '').question, 400);
    ask.parent = node.id; node.children.push(ask.id);
    if (!node.conversations!.includes(ask.conversationId!)) node.conversations!.push(ask.conversationId!);
    if (ask.agent && !node.agents!.includes(ask.agent)) node.agents!.push(ask.agent);
  }

  // What the notes conclude, tied to the files each statement names and the step that wrote it.
  const claims: Claim[] = [], made = new Set(touches.filter(t => t.makes).map(t => t.path));
  const evidence = new Map(input.turns.map(t => [t.conversationId + '/' + t.turn.id, t.turn.evidence]));
  for (const [section, id] of lineOfSection) for (const statement of section.statements) {
    if (statement.kind !== 'finding' && statement.kind !== 'choice') continue;
    const trace = traces.get(statement), paths = [...new Set([...statement.links, ...(statement.alternatives ?? []).flatMap(o => o.links)])].filter(p => !isNotes(p));
    let written: string | null = null;
    if (trace?.written) {
      // The kept version of the notes that first holds it was captured after one step of that message.
      const turn = trace.written.turn, kept = evidence.get(turn)?.records.find(r => isNotes(r.path) && r.snapshots.some(s => time(s.observedAt) === trace.written!.at));
      const tool = /^(?:tool|command):([^:]+)/.exec(kept?.phase ?? '')?.[1];
      written = (tool && toolStep.get(turn + '\n' + tool)) ?? [...(notesSteps.get(turn) ?? [])].reverse().find(s => s.at <= trace.written!.at + 1000)?.id ?? null;
    }
    claims.push({ id: 'c:' + id + ':' + statement.line, line: id, kind: statement.kind, text: statement.text, statement, ...(trace ? { trace } : {}), paths, written, ground: paths.some(p => made.has(p)) ? 'made' : paths.length ? 'named' : 'none' });
  }

  // Each node's size and span, from the steps under it.
  const claimed = new Set(claims.map(c => c.line));
  for (const node of lines.values()) nodes.set(node.id, node);
  const sum = (node: WorkNode) => {
    if (node.level === 'step') return;
    for (const id of node.children) { const child = nodes.get(id)!; sum(child); node.steps += child.steps; node.failed += child.failed; node.start = Math.min(node.start, child.start); node.end = Math.max(node.end, child.end); node.running ||= child.running; }
  };
  root.children = [...lines.values()].sort((a, b) => first(a) - first(b)).map(l => l.id);
  function first(node: WorkNode) { return Math.min(...node.children.map(id => nodes.get(id)!.start), Infinity); }
  sum(root);
  for (const node of lines.values()) {
    node.quiet = !claimed.has(node.id) && !node.children.some(id => madeBy.get(id)?.size);
    if (node.children.length && node.children.every(id => nodes.get(id)?.terminal)) node.terminal = true;
    if (!Number.isFinite(node.start)) { const at = claims.filter(c => c.line === node.id).map(c => c.trace?.written?.at ?? 0).filter(Boolean); node.start = at.length ? Math.min(...at) : 0; node.end = at.length ? Math.max(...at) : 0; }
  }
  if (!Number.isFinite(root.start)) root.start = 0;
  return { root: root.id, nodes, touches, artifacts, claims, changes };
}

// A node and everything above it, nearest first.
export function ancestors(layers: WorkLayers, id: string) {
  const out: string[] = [];
  for (let node = layers.nodes.get(id); node; node = node.parent ? layers.nodes.get(node.parent) : undefined) out.push(node.id);
  return out;
}
// The node drawn for a piece of work when only the opened nodes show their parts: the deepest
// node on its path whose every ancestor is open.
export function shownAs(layers: WorkLayers, id: string, open: ReadonlySet<string>) {
  const path = ancestors(layers, id).reverse();
  let shown = path[1] ?? path[0] ?? id;
  for (let i = 1; i < path.length; i++) { shown = path[i]!; if (!open.has(shown)) break; }
  return shown;
}
// Every recorded step under a node, in the order they happened: its complete trajectory.
export function trajectory(layers: WorkLayers, id: string): WorkNode[] {
  const out: WorkNode[] = [];
  const walk = (node?: WorkNode) => { if (!node) return; if (node.level === 'step') out.push(node); else for (const child of node.children) walk(layers.nodes.get(child)); };
  walk(layers.nodes.get(id));
  return out.sort((a, b) => a.start - b.start);
}
const lineOf = (layers: WorkLayers, work: string) => ancestors(layers, work).find(id => layers.nodes.get(id)!.level === 'line') ?? null;

// The links between the nodes on screen and the files: every step's relation to a file, carried
// up to the node drawn for that step, counted by what it was and on what basis.
export interface Link { work: string; path: string; makes: boolean; uses: boolean; at: number; n: number; verbs: Array<{ verb: Verb; basis: Basis; n: number }> }
export function links(layers: WorkLayers, open: ReadonlySet<string>, within?: string): Link[] {
  const out = new Map<string, Link>();
  for (const t of layers.touches) {
    if (isNotes(t.path) || (within && !ancestors(layers, t.work).includes(within))) continue;
    const work = shownAs(layers, t.work, open), key = work + '\n' + t.path;
    const link = out.get(key) ?? { work, path: t.path, makes: false, uses: false, at: t.at, n: 0, verbs: [] };
    link.n++; link.at = Math.min(link.at, t.at); if (t.makes) link.makes = true; else link.uses = true;
    const verb = link.verbs.find(v => v.verb === t.verb && v.basis === t.basis);
    if (verb) verb.n++; else link.verbs.push({ verb: t.verb, basis: t.basis, n: 1 });
    out.set(key, link);
  }
  return [...out.values()];
}

// What a line of work used and what it made. A file it only used is an input, named with the
// line that made it earlier when one did; a file it changed is something it made, marked when
// the line first used it as it found it.
export interface LineFiles { used: Array<{ path: string; from: string | null; at: number }>; made: Array<{ path: string; existing: boolean; from: string | null; at: number }> }
export function lineFiles(layers: WorkLayers, line: string): LineFiles {
  const mine = new Map<string, Touch[]>(), makers = new Map<string, Array<{ at: number; line: string }>>();
  for (const t of layers.touches) {
    if (isNotes(t.path)) continue;
    const home = lineOf(layers, t.work);
    if (t.makes && home) makers.set(t.path, [...(makers.get(t.path) ?? []), { at: t.at, line: home }]);
    if (home === line) mine.set(t.path, [...(mine.get(t.path) ?? []), t]);
  }
  const used: LineFiles['used'] = [], made: LineFiles['made'] = [];
  for (const [path, list] of mine) {
    const firstAt = list[0]!.at, from = [...(makers.get(path) ?? [])].reverse().find(m => m.line !== line && m.at <= firstAt)?.line ?? null;
    const maker = list.find(t => t.makes);
    if (maker) {
      // It was there before: another line made it, the message's record says it was modified, or
      // a step read it before the first step that edited it. A change seen on disk is placed at
      // the file's last change, so its time says nothing about what came first.
      const recorded = layers.changes.get(ancestors(layers, maker.work).find(id => layers.nodes.get(id)!.level === 'ask') + '\n' + path);
      const readFirst = !recorded && maker.basis === 'reported' && list[0]!.verb === 'read' && list[0]!.at < maker.at;
      made.push({ path, existing: !!from || recorded === 'modified' || readFirst, from, at: maker.at });
    }
    else used.push({ path, from, at: firstAt });
  }
  return { used: used.sort((a, b) => a.at - b.at), made: made.sort((a, b) => a.at - b.at) };
}
// One line of work building on another: the later one used or changed files the earlier one made.
export interface Flow { from: string; to: string; paths: string[] }
export function flows(layers: WorkLayers): Flow[] {
  const out = new Map<string, Flow>();
  for (const to of layers.nodes.get(layers.root)!.children) {
    const files = lineFiles(layers, to);
    for (const f of [...files.used, ...files.made]) if (f.from) { const key = f.from + '>' + to, flow = out.get(key) ?? { from: f.from, to, paths: [] }; flow.paths.push(f.path); out.set(key, flow); }
  }
  return [...out.values()];
}

// The recorded work behind a statement: the steps that made the files it names, the scripts
// those steps ran and the steps that wrote them, and so on back. A file reached with no step
// that made it ends the path there: the record does not say where it came from.
export interface Support { paths: Set<string>; work: Set<string>; open: string[] }
export function support(layers: WorkLayers, paths: string[], before = Infinity): Support {
  const seen = new Set<string>(), work = new Set<string>(), open: string[] = [], queue = paths.filter(p => !isNotes(p));
  const byWork = new Map<string, Touch[]>();
  for (const t of layers.touches) byWork.set(t.work, [...(byWork.get(t.work) ?? []), t]);
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const makers = layers.touches.filter(t => t.path === path && t.makes && t.at <= before);
    if (!makers.length) { open.push(path); continue; }
    for (const m of makers) {
      work.add(m.work);
      // What that step ran or named is what the file was made from.
      for (const t of byWork.get(m.work) ?? []) if (!t.makes && !isNotes(t.path)) queue.push(t.path);
    }
  }
  return { paths: seen, work, open };
}
