import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserClient, CompositionSummary, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { buildWorkGraph, type GraphEvent, type GraphTurn } from '../src/work-graph.js';
import { turnsAt } from '../src/replay.js';
import { chapters, type Chapter } from '../src/studio-chapters.js';
import { studioAt, studioFiles, studioIds, studioMerge, studioTree, type StudioFile } from '../src/studio-layout.js';
import type { LayoutNode, LayoutTree } from '../src/shell-layout.js';
import { askedAbout } from '../src/asking.js';
import { capturable, kindOf, type ProjectFiles } from './sources.js';
import { agentName, type AgentNow } from './agent-now.js';
import { ProcessContext, studioViewId as viewId, type Process } from './process-context.js';
import { clock, failed, kindOfAction, span } from './timeline-kinds.js';
import { processComposition } from './canvas.js';
import { Icon } from './icons.js';
import { Workspace } from './shell/workspace.js';
import './studio.css';

type Read = RhoOutput<'conversation.read'>;
// The protected resources are the service and this tab: one conversation's newest messages, read
// again at most this often while it changes, and replayed at most this fast.
export const processLimits = { turns: 8, readMs: 700, stepMs: 600, minStepMs: 120 };
const textual = (path: string) => /\.(R|r|Rmd|qmd|py|md|markdown|txt|json|sh|sql|js|mjs|ts|ya?ml|toml|tex|log)$/.test(path);

// One conversation's messages, read again when its recorded version moves, no more often than
// readMs, so a fast stream still lands on screen.
function useConversation(client: BrowserClient, snapshot: WorkspaceSnapshot, conversationId: string) {
  const summary = snapshot.conversations?.find(c => c.conversationId === conversationId);
  const [read, setRead] = useState<{ version: number; read: Read } | null>(null), [problem, setProblem] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), last = useRef(0), wanted = useRef(summary?.version);
  wanted.current = summary?.version;
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!summary || read?.version === summary.version || timer.current) return;
    timer.current = setTimeout(() => {
      const version = wanted.current ?? 0;
      last.current = Date.now();
      client.call('conversation.read', { projectId: snapshot.project.id, conversationId, limit: processLimits.turns })
        .then(value => { setRead({ version, read: value }); setProblem(''); }, error => setProblem(error instanceof Error ? error.message : 'The conversation could not be read.'))
        .finally(() => { timer.current = undefined; });
    }, Math.max(0, last.current + processLimits.readMs - Date.now()));
  }, [client, snapshot.project.id, conversationId, summary?.version, read]);
  const turns: GraphTurn[] = useMemo(() => read && summary ? read.read.turns.map(turn => ({ conversationId, conversationTitle: summary.agentTitle || summary.title, agent: agentName(summary.client), turn, observation: read.read.observation })) : [], [read, summary?.title, summary?.agentTitle]);
  return { turns, problem, loading: !read && !problem, summary };
}

// The parts of the conversation's messages, and which one the work is in at the moment shown.
// The list comes from the whole record; the part in progress is named as it stood then, from
// the steps it had taken by that moment.
function StepsChip({ turns, then, root, at, onAt }: { turns: GraphTurn[]; then: GraphTurn[]; root: string; at: number | null; onAt: (at: number | null) => void }) {
  const parts = useMemo(() => turns.map(t => ({ turn: t.turn, title: askedAbout(t.turn.text).question.split('\n')[0] ?? '', chapters: chapters(t.turn, t.turn.id, root) })), [turns, root]);
  const sofar = useMemo(() => at === null ? null : then.flatMap(t => chapters(t.turn, t.turn.id, root)).at(-1) ?? null, [then, root, at]);
  const all = parts.flatMap(p => p.chapters), reached = all.filter(c => at === null || c.start <= at);
  const whole = reached.at(-1), ref = useRef<HTMLDetailsElement>(null);
  if (!whole) return null;
  const current = sofar ?? whole, rounds = whole.rounds.filter(r => at === null || r.start <= at).length;
  const meta = (c: Chapter) => [c.rounds.length ? c.rounds.length + ' rounds' : '', c.edits ? c.edits + (c.edits === 1 ? ' edit' : ' edits') : '', c.runs ? c.runs + (c.runs === 1 ? ' command' : ' commands') : '', ...c.notes].filter(Boolean).join(' · ');
  return <details ref={ref} className="steps-chip" onKeyDown={event => { if (event.key === 'Escape' && ref.current?.open) { event.preventDefault(); ref.current.open = false; } }}>
    <summary title={current.title}>
      <span className={'steps-dot' + (current.running && at === null ? ' live' : '')} aria-hidden="true" />
      <span className="steps-title">{current.title}</span>
      {whole.rounds.length > 0 && <span className="steps-round">Round {Math.max(1, rounds)} of {whole.rounds.length}</span>}
      <span className="steps-count">{all.indexOf(whole) + 1}/{all.length}</span>
    </summary>
    <div className="steps-pop" role="list" aria-label="Parts of this conversation">
      {parts.map(part => <section key={part.turn.id}>
        <p className="steps-asked" title={part.turn.text}>{part.title.length > 80 ? part.title.slice(0, 79).trimEnd() + '…' : part.title}</p>
        {part.chapters.map(c => <button key={c.id} role="listitem" className={'steps-part ' + c.kind + (c === whole ? ' current' : at !== null && c.start > at ? ' later' : '')}
          onClick={() => { onAt(c === all.at(-1) && at !== null && c.kind === 'answer' ? null : c.start); if (ref.current) ref.current.open = false; }}>
          <span className="steps-time">{clock(c.start)}</span>
          <span className="steps-name">{c.title}{c.said && <small> · in its words</small>}</span>
          {meta(c) && <small className="steps-meta">{meta(c)}</small>}
        </button>)}
      </section>)}
    </div>
  </details>;
}

// Time runs down the side, beside the conversation: each step a mark in its kind's colour, long
// pauses folded to a short gap that says how long they were. Pressing or dragging moves the
// moment shown; Play steps through it; Now returns to the work as it is.
function SideTimeline({ events, spans, at, playing, speed, running, onAt, onPlay, onSpeed }: {
  events: GraphEvent[]; spans: Array<{ start: number; end: number }>; at: number | null; playing: boolean; speed: number; running: boolean;
  onAt: (at: number | null) => void; onPlay: () => void; onSpeed: () => void;
}) {
  const track = useRef<HTMLDivElement>(null), [height, setHeight] = useState(400);
  const [hover, setHover] = useState<{ event: GraphEvent; y: number } | null>(null);
  useLayoutEffect(() => {
    const element = track.current; if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight)); observer.observe(element); setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);
  const stretches = useMemo(() => {
    const out: Array<{ start: number; end: number }> = [];
    for (const s of [...spans].sort((a, b) => a.start - b.start)) { const last = out.at(-1); if (last && s.start <= last.end + 30000) last.end = Math.max(last.end, s.end); else out.push({ start: s.start, end: Math.max(s.end, s.start + 1000) }); }
    return out;
  }, [spans]);
  const gap = 26, pad = 8, usable = Math.max(60, height - pad * 2 - gap * Math.max(0, stretches.length - 1));
  const weights = stretches.map(s => Math.sqrt(s.end - s.start)), total = weights.reduce((a, b) => a + b, 0) || 1;
  const offsets: number[] = []; let y = pad;
  stretches.forEach((_, i) => { offsets.push(y); y += usable * weights[i] / total + gap; });
  const size = (i: number) => usable * weights[i] / total;
  const toY = (t: number) => { const found = stretches.findIndex(s => t <= s.end), i = found < 0 ? stretches.length - 1 : found, s = stretches[i]; return s ? offsets[i] + Math.min(size(i), Math.max(0, (t - s.start) / (s.end - s.start) * size(i))) : pad; };
  const fromY = (py: number) => { for (let i = stretches.length - 1; i >= 0; i--) if (py >= offsets[i]) { const s = stretches[i]; return s.start + Math.min(1, Math.max(0, (py - offsets[i]) / size(i))) * (s.end - s.start); } return stretches[0]?.start ?? 0; };
  const nearest = (py: number) => events.reduce<GraphEvent | null>((best, e) => !best || Math.abs(toY(e.at) - py) < Math.abs(toY(best.at) - py) ? e : best, null);
  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    const element = event.currentTarget, box = element.getBoundingClientRect();
    element.setPointerCapture(event.pointerId); setHover(null);
    const set = (clientY: number) => { const py = clientY - box.top, near = nearest(py); onAt(near && Math.abs(toY(near.at) - py) < 8 ? near.at : fromY(py)); };
    set(event.clientY);
    const move = (e: PointerEvent) => set(e.clientY), stop = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  function point(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.buttons) return;
    const py = event.clientY - event.currentTarget.getBoundingClientRect().top, near = nearest(py);
    setHover(near && Math.abs(toY(near.at) - py) < 7 ? { event: near, y: toY(near.at) } : null);
  }
  // A moment holds its whole second, so the step before it is the last one in an earlier second.
  const now = at ?? events.at(-1)?.at ?? 0, second = Math.floor(now / 1000) * 1000;
  const earlier = () => [...events].reverse().find(e => e.at < second)?.at ?? events[0]?.at;
  const later = () => events.find(e => e.at > now)?.at ?? null;
  function keys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const next = event.key === 'ArrowDown' ? later() : event.key === 'ArrowUp' ? earlier() : event.key === 'Home' ? events[0]?.at : event.key === 'End' ? null : undefined;
    if (next === undefined) return;
    event.preventDefault(); onAt(next);
  }
  const head = at === null ? null : toY(at);
  const pauses = stretches.slice(1).map((s, i) => ({ y: offsets[i + 1] - gap, length: s.start - stretches[i].end }));
  return <aside className="side-timeline" aria-label="Timeline">
    <div className="side-tl-controls">
      <button className="icon-button" aria-label={playing ? 'Pause' : at === null ? 'Play from the start' : 'Play from here'} onClick={onPlay}><Icon name={playing ? 'pause' : 'run'} size={15} /></button>
      <button className="side-tl-speed" aria-label={'Speed ' + speed + '×'} onClick={onSpeed}>{speed}×</button>
      {/* Without room for the track, the moment is named and moved a step at a time. */}
      <span className="side-tl-step">
        <button className="icon-button" aria-label="Earlier step" disabled={!events.length || (at !== null && at < (events[0]?.at ?? 0) + 1000)} onClick={() => { const t = earlier(); if (t !== undefined) onAt(t); }}><span className="flip"><Icon name="chevron" size={14} /></span></button>
        <span className="side-tl-at" aria-live="polite">{at === null ? 'Now' : clock(at, true)}</span>
        <button className="icon-button" aria-label="Later step" disabled={at === null} onClick={() => onAt(later())}><Icon name="chevron" size={14} /></button>
      </span>
    </div>
    <div ref={track} className="side-tl-track" role="slider" tabIndex={0} aria-orientation="vertical" aria-label="Moment shown" aria-valuemin={events[0]?.at ?? 0} aria-valuemax={events.at(-1)?.at ?? 0} aria-valuenow={at ?? events.at(-1)?.at ?? 0} aria-valuetext={at === null ? 'Now' : clock(at, true)}
      onPointerDown={scrub} onPointerMove={point} onPointerLeave={() => setHover(null)} onKeyDown={keys}>
      {stretches.map((s, i) => <span key={i} className="side-tl-stretch" style={{ top: offsets[i], height: size(i) }} aria-hidden="true"><small>{clock(s.start)}</small></span>)}
      {pauses.map((p, i) => <span key={i} className="side-tl-fold" style={{ top: p.y, height: gap }} title={'A pause of ' + span(p.length)} aria-hidden="true"><small>{span(p.length)}</small></span>)}
      {events.map(e => <i key={e.key} className={'side-tl-mark ' + kindOfAction(e.action) + (failed(e) ? ' failed' : '') + (at !== null && e.at > at ? ' later' : '')} style={{ top: toY(e.at) }} aria-hidden="true" />)}
      {head !== null && <span className="side-tl-head" style={{ top: head }} aria-hidden="true"><small>{clock(at!, true)}</small></span>}
      {hover && <span className="side-tl-hover" style={{ top: hover.y }}>{hover.event.label} · {clock(hover.event.at, true)}</span>}
    </div>
    <button className={'side-tl-now' + (at === null ? ' on' : '')} disabled={at === null} onClick={() => onAt(null)}>{at === null && running ? <><span className="pulse-dot" aria-hidden="true" />Live</> : 'Now'}</button>
  </aside>;
}

type WorkspaceProps = Omit<ComponentProps<typeof Workspace>, 'composition' | 'snapshot' | 'client' | 'openView' | 'presence' | 'arrange' | 'following'>;
// One conversation's Studio: its files in views by role, its commands in their own view, the
// parts of the work in a chip above, and its time down the side beside the conversation. What it
// shows is derived from the conversation's record at the moment chosen; once the person moves
// something, the arrangement is theirs and is saved.
export function ProcessStudio({ client, snapshot, files, conversationId, at, playing, speed, onAt, onPlaying, onSpeed, stepsTarget, agentNow, following, workspace }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFiles; conversationId: string;
  at: number | null; playing: boolean; speed: number; onAt: (at: number | null) => void; onPlaying: (playing: boolean) => void; onSpeed: (speed: number) => void;
  stepsTarget: HTMLElement | null; agentNow: AgentNow | null; following: boolean; workspace: WorkspaceProps;
}) {
  const projectId = snapshot.project.id, compositionId = processComposition(conversationId);
  const { turns, problem, loading, summary } = useConversation(client, snapshot, conversationId);
  const walk = useMemo(() => files.files.map(f => ({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, category: f.category })), [files.files]);
  const whole = useMemo(() => buildWorkGraph({ turns, files: walk, project: snapshot.project, kindOf, now: Date.now() }), [turns, walk, snapshot.project]);
  const shownTurns = useMemo(() => turnsAt(turns, at), [turns, at]);
  const graph = useMemo(() => at === null ? whole : buildWorkGraph({ turns: shownTurns, files: walk, project: snapshot.project, kindOf, now: at }), [whole, shownTurns, at]);
  const every = useMemo(() => studioFiles(whole), [whole]), shown = useMemo(() => studioAt(every, at), [every, at]);
  const events = useMemo(() => whole.events.filter(e => Number.isFinite(e.at)).sort((a, b) => a.at - b.at), [whole]);
  const running = !!summary && summary.state === 'running';

  // Text files open in the one shared buffer their editor owns; a table or figure with no kept
  // version is captured as it is now, only while the work is shown as it is now.
  const [docs, setDocs] = useState<Record<string, string | null>>({}), asked = useRef(new Set<string>());
  const [captured, setCaptured] = useState<Record<string, { id: string; version: string } | null>>({});
  useEffect(() => {
    for (const file of every) {
      if (asked.current.has(file.path)) continue;
      if (textual(file.path)) {
        asked.current.add(file.path);
        client.call('document.open', { projectId, path: file.path }).then(d => setDocs(m => ({ ...m, [file.path]: d.id })), () => setDocs(m => ({ ...m, [file.path]: null })));
      } else if (capturable(file.path) && !file.versions.length && at === null) {
        asked.current.add(file.path);
        client.call('agent.activity.capture', { projectId, path: file.path }).then(r => setCaptured(m => ({ ...m, [file.path]: { id: r.id, version: r.version } })), () => setCaptured(m => ({ ...m, [file.path]: null })));
      }
    }
  }, [every, at, client, projectId]);

  const component = (id: string) => snapshot.catalog.components.find(c => c.id === id);
  const firstRun = graph.nodes.filter(n => n.kind === 'run').reduce((min, n) => Math.min(min, n.at), Infinity);
  const firstEver = whole.nodes.filter(n => n.kind === 'run').reduce((min, n) => Math.min(min, n.at), Infinity);
  const tree = useMemo((): LayoutTree | null => {
    const node = (file: StudioFile): LayoutNode | null => {
      const props = { title: file.title };
      if (capturable(file.path)) {
        const ref = file.versions.at(-1)?.resource ?? (at === null ? captured[file.path] : null);
        const owner = component(/\.csv$/i.test(file.path) ? 'rho.table' : 'rho.media');
        if (!ref || !owner) return null;
        return { id: viewId(file.path), kind: 'view', component: owner.id, version: owner.version, props, bindings: { [Object.keys(owner.bindings)[0] ?? 'data']: { id: ref.id, version: ref.version } } };
      }
      const document = docs[file.path];
      const editor = (/\.(md|markdown)$/i.test(file.path) ? component('markdown.reader') : undefined) ?? component('rho.editor');
      if (!document || !editor) return null;
      return { id: viewId(file.path), kind: 'view', component: editor.id, version: editor.version, props, bindings: { document: { kind: 'live-document', documentId: document } } };
    };
    const views = shown.flatMap(file => { const n = node(file); return n ? [{ role: file.role, node: n, figure: n.component === 'rho.media' }] : []; });
    const commands: LayoutNode | null = Number.isFinite(firstRun) ? { id: studioIds.console, kind: 'view', component: 'rho.console', version: '1', props: { title: 'Commands' }, bindings: {} } : null;
    const derived = studioTree(views, commands);
    const saved = snapshot.compositions.find(c => c.compositionId === compositionId) as CompositionSummary | undefined;
    if (!saved?.rootId || !saved.nodes?.length) return derived;
    const savedTree: LayoutTree = { rootId: saved.rootId, nodes: saved.nodes as unknown as LayoutNode[] };
    // The person saw every file the work had when they last arranged it; those they closed stay closed.
    const arranged = Date.parse(saved.acknowledgedAt ?? '');
    const first = (id: string) => id === studioIds.console ? firstEver : every.find(f => viewId(f.path) === id)?.first ?? Infinity;
    return studioMerge(savedTree, derived ?? { rootId: '', nodes: [] }, id => !Number.isFinite(arranged) || first(id) <= arranged);
  }, [shown, every, docs, captured, at, firstRun, firstEver, snapshot.compositions, snapshot.catalog]);
  const saved = snapshot.compositions.find(c => c.compositionId === compositionId);
  const signature = JSON.stringify(tree) + ':' + (saved?.version ?? 0);
  const composition = useMemo((): CompositionSummary | null => tree ? { ...(saved ?? {}), compositionId, version: saved?.version ?? 0, rootId: tree.rootId, nodes: tree.nodes as never, views: tree.nodes.filter(n => n.kind === 'view') as never } : null, [signature]);

  // Replay steps through the conversation's marks; at the end it returns to now.
  useEffect(() => {
    if (!playing) return;
    const index = at === null ? 0 : events.findIndex(e => e.at > at);
    if (index < 0 || index >= events.length) { onPlaying(false); onAt(null); return; }
    const pace = Math.min(processLimits.stepMs, Math.max(processLimits.minStepMs, 12000 / Math.max(1, events.length))) / speed;
    const timer = setTimeout(() => onAt(events[index].at), at === null ? 0 : pace);
    return () => clearTimeout(timer);
  }, [playing, at, events, speed]);

  // What comes forward: a file the person asked for here, else the one the work was on at the
  // moment shown: the Agent's newest file while following now, or the step at the replay moment.
  const [chosen, setChosen] = useState<string | null>(null);
  const views = new Set(composition?.views.map(v => v.id) ?? []);
  const forPath = (path: string | null | undefined) => path && views.has(viewId(path)) ? viewId(path) : undefined;
  const live = agentNow?.running && agentNow.conversationId === conversationId && at === null ? agentNow : null;
  // The step at the moment shown. A moment holds its second; when the Agent wrote a file and
  // started a command in the same second, the file comes forward, since Commands keeps its own place.
  const latest = at === null ? null : [...events].reverse().find(e => e.at <= at && e.action !== 'capture');
  const step = latest && ([...events].reverse().find(e => e.at <= at! && e.at >= Math.floor(latest.at / 1000) * 1000 && (e.action === 'write' || e.action === 'edit')) ?? latest);
  const stepNode = step ? graph.nodes.find(n => n.id === step.node) : null;
  const working = live ? (live.latest?.action === 'execute' ? studioIds.console : forPath(live.files.at(-1)?.path)) : stepNode ? (stepNode.kind === 'run' ? studioIds.console : forPath(stepNode.path)) : undefined;
  const openView = (chosen && views.has(chosen) ? chosen : undefined) ?? (following || at !== null ? working : undefined);
  useEffect(() => { setChosen(null); }, [at === null, conversationId]);
  const presence = live && working && views.has(working) ? { viewId: working, label: live.title, verb: working === studioIds.console ? 'Running' : live.files.at(-1)?.verb ?? 'Working', live: live.latest?.outcome === 'requested' } : null;

  const process: Process = useMemo(() => ({ conversationId, graph, whole, at, files: shown, every, setAt: onAt, showPath: path => setChosen(viewId(path)) }), [conversationId, graph, whole, at, shown, every]);
  return <ProcessContext.Provider value={process}>
    <div className="process-studio">
      <div className="process-stage">
        {problem && <p className="inline-error" role="alert">{problem}</p>}
        {composition ? <Workspace key={projectId + compositionId} {...workspace} bar={false} composition={composition} snapshot={snapshot} client={client} openView={openView} presence={presence} arrange={at === null} following={following || at !== null} />
          : <div className="studio-empty"><span className="empty-symbol">{running ? <span className="pulse-dot large" aria-hidden="true" /> : <Icon name="layout" size={26} stroke={1.5} />}</span>
            <h2>{loading ? 'Reading the conversation…' : running ? (summary ? agentName(summary.client) : 'The Agent') + ' is starting' : 'Nothing to show yet'}</h2>
            <p>{running ? 'The data it reads, the code it writes, the commands it runs and the results they make appear here as it works.' : 'This conversation has not read or made any project files.'}</p></div>}
      </div>
      {events.length > 0 && <SideTimeline events={events} spans={whole.turns} at={at} playing={playing} speed={speed} running={running}
        onAt={next => { onPlaying(false); onAt(next); }} onPlay={() => onPlaying(!playing)} onSpeed={() => onSpeed(speed === 4 ? 1 : speed * 2)} />}
    </div>
    {stepsTarget && createPortal(<StepsChip turns={turns} then={shownTurns} root={snapshot.project.root} at={at} onAt={next => { onPlaying(false); onAt(next); }} />, stepsTarget)}
  </ProcessContext.Provider>;
}
