import { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ShellContext } from './shell-services.js';
import { Snapshot } from './snapshot.js';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { useTerminalTurns } from './terminal-turns.js';
import { personPrincipal } from '../src/terminal-work.js';
import { buildWorkGraph, foldVersions, type FileKind, type GraphEvent, type GraphNode, type GraphTurn, type WorkGraph as Graph } from '../src/work-graph.js';
import { ancestors, buildWorkLayers, flows, isNotes, lineFiles, shownAs, support, talksOf, type Claim, type Talk, type WorkLayers, type WorkNode } from '../src/work-layers.js';
import { layoutLayers, type Item, type Scene, type Wire } from '../src/layers-layout.js';
import { durationText } from '../src/conversation-presentation.js';
import type { AgentNow } from './agent-now.js';
import { openInWorkspace } from './canvas.js';
import { kindOf, type ProjectFiles } from './sources.js';
import { Icon, type IconName } from './icons.js';
import { BrandMark, brandOf } from './brand-marks.js';
import { size } from './project.js';
import { AgentMarkdown } from './markdown.js';
import { TerminalOutput } from '@rho-workspace/plugin-console/ui';
import { readPreview, type Preview } from './previews.js';
import { useTurns } from './work-turns.js';
import { clock, span } from './timeline-kinds.js';
import { Timeline, stepCaption, plainTitle, type TimelineChosen, type TimelinePick } from './timeline.js';
import { useEventMarks } from './timeline-events.js';
import { useMeaning } from './meaning.js';
import { ChoiceOptions } from './choices.js';
import type { Holds } from '../src/file-describer.js';
import './graph.css';

// The project's work as one graph read at several levels (src/work-layers.ts). It opens on the
// lines of work: what was asked, what was made and what the notes conclude, each line after the
// lines it builds on. A line opens into its messages, a message into its activities, an activity
// into its recorded steps, and a step shows the record itself. Every level is made of the one
// below it, so a conclusion can be followed to the files it rests on and the steps that made
// them. Every session's whole record is read; what is drawn is what is open.

const plural = (n: number, one: string, many = one + 's') => n.toLocaleString() + ' ' + (n === 1 ? one : many);
const levelLabel: Record<WorkNode['level'], string> = { workspace: 'Workspace', line: 'Line of work', ask: 'Message', activity: 'Activity', step: 'Step' };
const activityIcon: Record<string, IconName> = { look: 'search', cells: 'braces', build: 'code', notes: 'document', answer: 'chat' };
const stepIcon = (node: WorkNode): IconName => node.action === 'say' ? 'chat' : node.action === 'error' ? 'info' : node.action === 'read' ? 'eye' : node.action === 'edit' || node.action === 'write' ? 'pencil'
  : node.action === 'execute' ? 'run' : node.action === 'search' ? 'search' : node.record?.operation === 'kernel.run' ? 'braces' : 'tool';
const workIcon = (node: WorkNode): IconName => node.level === 'line' ? 'workflow' : node.level === 'ask' ? (node.terminal ? 'monitor' : 'question') : node.level === 'activity' ? activityIcon[node.kind ?? ''] ?? 'tool' : stepIcon(node);
const fileIcon = (category: FileKind): IconName => category === 'figures' ? 'image' : category === 'code' ? 'code' : category === 'notes' ? 'document' : category ? 'table' : 'file';
const fileLabel = (category: FileKind) => ({ data: 'Data', code: 'Script', results: 'Result', figures: 'Figure', notes: 'Note' } as Record<string, string>)[category ?? ''] ?? 'File';
const isPicture = (path: string) => /\.(png|jpe?g|svg)$/i.test(path);
const ended: Record<string, string> = { completed: 'Answered', failed: 'Failed', stopped: 'Stopped', running: 'Working', unknown: 'Outcome unknown' };
// How an ask ended; commands typed in a terminal were not answered.
const askEnd = (node: WorkNode) => node.terminal ? (node.state === 'running' ? 'Running' : '') : ended[node.state ?? ''] ?? node.state;
const outcomes: Record<string, string> = { returned: 'Returned', requested: 'Running', failed: 'Failed', rejected: 'Refused', unknown: 'Outcome unknown' };
const grounds: Record<Claim['ground'], string> = { made: '', named: 'No recorded step made the files it names', none: 'Names no file' };
// A command's output opens at its end, where its result or error is.
const atEnd = (element: HTMLElement | null) => { if (element) element.scrollTop = element.scrollHeight; };
// The Agent's answer in a sentence or two, as plain text.
const gist = (markdown?: string) => markdown ? markdown.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|]+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 220) : '';
const took = (node: WorkNode) => node.end > node.start ? span(node.end - node.start) : '';
const dayOf = (at: number) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
const daysOf = (start: number, end: number) => !start ? '' : dayOf(start) === dayOf(end) ? dayOf(start) : dayOf(start) + ' – ' + (new Date(start).getMonth() === new Date(end).getMonth() && new Date(start).getFullYear() === new Date(end).getFullYear() ? new Date(end).getDate() : dayOf(end));
// A line of work by name. One the notes do not name, held in several conversations, is named
// after the first of them and says how many more there are.
const lineName = (node: WorkNode) => node.level === 'line' && !node.section && (node.conversations?.length ?? 0) > 1 ? `${node.title} and ${node.conversations!.length - 1} more` : node.title;

// What is chosen: a piece of work at any level, one conversation of a line of work, a file as one
// line of work stands to it, or a statement of the notes.
type Target = { kind: 'work'; node: WorkNode } | { kind: 'talk'; talk: Talk } | { kind: 'claim'; claim: Claim } | { kind: 'file'; path: string; line: string };
const talkId = (conversationId: string) => 't:' + conversationId;
function targetOf(layers: WorkLayers, id: string | null): Target | null {
  if (!id) return null;
  const node = layers.nodes.get(id);
  if (node) return { kind: 'work', node };
  if (id.startsWith('t:')) { for (const line of layers.nodes.get(layers.root)!.children) { const talk = talksOf(layers, line).find(t => talkId(t.id) === id); if (talk) return { kind: 'talk', talk }; } return null; }
  const claim = layers.claims.find(c => c.id === id);
  if (claim) return { kind: 'claim', claim };
  const cut = id.indexOf('|');
  return cut > 0 && layers.nodes.has(id.slice(0, cut)) ? { kind: 'file', line: id.slice(0, cut), path: id.slice(cut + 1) } : null;
}

function CardPreview({ client, snapshot, node, shown }: { client: BrowserClient; snapshot: WorkspaceSnapshot; node: GraphNode; shown: boolean }) {
  // A file that changes again is previewed again; until then the card keeps what it read.
  const version = node.resource?.id + '@' + node.resource?.version;
  const [read, setRead] = useState<{ version: string; preview: Preview } | null>(null);
  const preview = read?.preview ?? null;
  useEffect(() => {
    if (!shown || !node.resource || read?.version === version) return;
    let live = true;
    readPreview(client, snapshot, { path: node.path!, bytes: node.bytes, modifiedAt: node.modifiedAt, resource: node.resource ? { ...node.resource, kind: snapshot.resources.find(r => r.id === node.resource!.id)?.kind ?? 'file' } : undefined }).then(value => { if (live) setRead({ version, preview: value }); });
    return () => { live = false; };
  }, [shown, version]);
  if (!preview) return <span className="graph-preview loading" aria-hidden="true" />;
  if (preview.kind === 'image') return <span className="graph-preview image"><img src={preview.url} alt="" /></span>;
  return <span className="graph-preview none">{preview.kind === 'table' ? plural(preview.total, 'row') + ' × ' + plural(preview.width, 'column') : preview.note}</span>;
}

interface View { x: number; y: number; k: number }
const zoomLimits = { min: 0.2, max: 2 };
// Below this zoom a card's text is too small to read; the graph opens no smaller than this.
const readable = 0.76;
// A graph too tall for one screen opens across the page from its top down to this zoom.
const pageAt = 0.66;
// The whole graph is shown at once down to this zoom, where a card is still its name.
const wholeAt = 0.3;

export function WorkGraph({ initialResource, client, snapshot, files, agentNow, following, principalId, notesText = '', onFollow, onStopFollowing, onStudio, workspace, onAgent }: {
  initialResource?: {id:string;version:string}|null; client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFiles; agentNow: AgentNow | null; following: boolean; principalId?: string;
  // The project notes as they stand: what each line of work concludes.
  notesText?: string;
  onFollow: () => void; onStopFollowing: () => void; onStudio: (compositionId: string, viewId?: string) => void; workspace: () => string;
  onAbout: (pluginId: string) => void; onAgent: (conversationId?: string) => void;
}) {
  const { turns: messages, sessions, read, problem, loading, omitted } = useTurns(client, snapshot, undefined, true);
  // With what was typed in the project's terminals.
  const turns = useTerminalTurns(client, snapshot, messages);
  const { marks } = useEventMarks(client, snapshot, turns);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!agentNow?.running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [agentNow?.running]);
  const graphFiles = useMemo(() => files.files.map(f => ({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, category: f.category })), [files.files]);
  // The behaviour graph: every recorded action and file version. The levels are built on it.
  const process = useMemo(() => foldVersions(buildWorkGraph({ turns, files: graphFiles, project: snapshot.project, kindOf, now: agentNow?.running ? now : Date.now() })),
    [turns, graphFiles, snapshot.project, agentNow?.running ? now : 0]);
  const meaning = useMeaning(client, snapshot, process, graphFiles, notesText, turns);
  const layers = useMemo(() => buildWorkLayers({ turns, graph: process, project: snapshot.project, meanings: meaning.meanings, traces: meaning.traces, now: agentNow?.running ? now : Date.now() }), [turns, process, meaning.meanings, meaning.traces]);
  const lines = layers.nodes.get(layers.root)!.children.map(id => layers.nodes.get(id)!);

  // What is open. A project with one line of work opens on it; otherwise on the lines.
  const storeKey = 'rho.graph.open.v1.' + snapshot.project.id;
  const stored = useRef(false);
  const [open, setOpen] = useState<Set<string>>(() => { try { const kept = sessionStorage.getItem(storeKey); if (kept) { stored.current = true; return new Set(JSON.parse(kept) as string[]); } } catch { /* this page only */ } return new Set(); });
  useEffect(() => { if (stored.current) try { sessionStorage.setItem(storeKey, JSON.stringify([...open])); } catch { /* this page only */ } }, [open]);
  const only = lines.filter(l => !l.quiet).length === 1 && lines.length <= 3 ? lines.find(l => !l.quiet)!.id : lines.length === 1 ? lines[0]!.id : null;
  useEffect(() => { if (only && !stored.current && !loading) setOpen(new Set([only])); }, [only, loading]);

  const newest = useCallback((path: string) => [...(layers.artifacts.get(path)?.nodes ?? [])].reverse().find(n => n.resource) ?? layers.artifacts.get(path)?.nodes.at(-1), [layers]);
  const scene = useMemo(() => layoutLayers(layers, open, { figure: path => isPicture(path) && !!newest(path)?.resource }), [layers, open, newest]);
  const items = useMemo(() => new Map(scene.items.map(i => [i.id, i])), [scene]);
  const agentOf = (conversationId: string) => process.turns.find(t => t.conversationId === conversationId)?.agent;

  // Choosing something shows what it stands on and what stands on it; everything else steps back.
  const [selected, setSelected] = useState<string | null>(null);
  const target = useMemo(() => targetOf(layers, selected), [layers, selected]);
  const focus = useMemo(() => {
    if (!target || (target.kind === 'work' && target.node.level === 'workspace')) return null;
    const on = new Set<string>(), paths = new Set<string>(), work = new Set<string>();
    if (target.kind === 'claim') {
      const behind = support(layers, target.claim.paths);
      on.add(target.claim.id); for (const p of behind.paths) paths.add(p); for (const w of behind.work) work.add(w);
      if (target.claim.written) work.add(target.claim.written);
    } else if (target.kind === 'talk') {
      on.add(target.talk.line);
      for (const ask of target.talk.asks) { work.add(ask.id); for (const t of layers.touches) if (ancestors(layers, t.work).includes(ask.id)) paths.add(t.path); }
    } else if (target.kind === 'file') {
      paths.add(target.path);
      for (const t of layers.touches) if (t.path === target.path) work.add(t.work);
      for (const c of layers.claims) if (c.paths.includes(target.path)) on.add(c.id);
    } else {
      const id = target.node.id;
      for (const item of scene.items) if (items.has(item.ref) && ancestors(layers, item.ref).includes(id)) on.add(item.id);
      for (const t of layers.touches) if (ancestors(layers, t.work).includes(id)) paths.add(t.path);
      on.add(id);
      for (const flow of flows(layers)) if (flow.from === id || flow.to === id) { on.add(flow.from); on.add(flow.to); }
    }
    for (const w of work) on.add(shownAs(layers, w, open));
    for (const item of scene.items) if ((item.kind === 'file' && paths.has(item.ref)) || (item.kind === 'bundle' && item.paths!.some(p => paths.has(p)))) on.add(item.id);
    // A closed line stands for the statements and files inside it.
    for (const c of layers.claims) if (on.has(c.id) && !open.has(c.line)) on.add(c.line);
    return on;
  }, [target, layers, scene, open]);
  // The same choice on the timeline: the messages it stands for, and when, for an activity or a step.
  const chosen = useMemo((): TimelineChosen | null => {
    if (!target) return null;
    const turns = new Set<string>(), add = (work: string) => { const ask = ancestors(layers, work).map(id => layers.nodes.get(id)!).find(n => n.level === 'ask'); if (ask?.turn) turns.add(ask.turn); };
    if (target.kind === 'talk') for (const ask of target.talk.asks) add(ask.id);
    else if (target.kind === 'file') { for (const t of layers.touches) if (t.path === target.path) add(t.work); }
    else if (target.kind === 'claim') { for (const w of support(layers, target.claim.paths).work) add(w); if (target.claim.written) add(target.claim.written); }
    else if (target.node.level === 'line') for (const id of target.node.children) add(id);
    else if (target.node.level !== 'workspace') add(target.node.id);
    const node = target.kind === 'work' ? target.node : null;
    return { turns, span: node && (node.level === 'activity' || node.level === 'step') ? { start: node.start, end: node.end } : null };
  }, [target, layers]);
  const [query, setQuery] = useState('');
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const has = (...texts: Array<string | undefined | null>) => texts.some(t => t?.toLowerCase().includes(q));
    const shown = new Set<string>(), raw: string[] = [];
    for (const node of layers.nodes.values()) if (node.level !== 'workspace' && has(node.title, node.said, node.text, node.record?.detail, node.record?.text)) { raw.push(node.id); shown.add(shownAs(layers, node.id, open)); }
    for (const c of layers.claims) if (has(c.text)) { raw.push(c.id); shown.add(open.has(c.line) ? c.id : c.line); }
    for (const item of scene.items) if ((item.kind === 'file' && has(item.ref)) || (item.kind === 'bundle' && has(...item.paths!))) shown.add(item.id);
    for (const t of layers.touches) if (has(t.path)) shown.add(shownAs(layers, t.work, open));
    return { shown, raw };
  }, [query, layers, scene, open]);

  // Replay: the graph as it stood at a moment of the work. Null is now.
  const [cursor, setCursor] = useState<number | null>(null), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const times = process.events.map(e => e.at);
  useEffect(() => {
    if (!playing) return;
    const events = process.events, index = cursor === null ? 0 : events.findIndex(e => e.at > cursor);
    if (index < 0 || index >= events.length) { setPlaying(false); setCursor(null); return; }
    const pace = Math.min(600, Math.max(140, 9000 / Math.max(1, events.length))) / speed;
    const timer = setTimeout(() => setCursor(events[index].at), cursor === null ? 0 : pace);
    return () => clearTimeout(timer);
  }, [playing, cursor, process.events, speed]);
  const current = cursor === null ? null : [...process.events].reverse().find(e => e.at <= cursor) ?? null;
  const processNodes = useMemo(() => new Map(process.nodes.map(n => [n.id, n])), [process]);
  const firstTouch = useMemo(() => { const at = new Map<string, number>(); for (const t of layers.touches) at.set(t.path, Math.min(at.get(t.path) ?? Infinity, t.at)); return at; }, [layers]);
  const later = (item: Item) => cursor !== null && (item.kind === 'bundle' ? Math.min(...item.paths!.map(p => firstTouch.get(p) ?? 0)) > cursor : item.kind === 'file' ? (firstTouch.get(item.ref) ?? 0) > cursor : item.kind === 'claim' ? (layers.claims.find(c => c.id === item.ref)?.trace?.written?.at ?? 0) > cursor : (layers.nodes.get(item.ref)?.start ?? 0) > cursor);

  // Where the Agent is: the step of the record it is on, drawn on the deepest node open for it.
  // The step an event of the record is, or its message when the event is not a step (a change
  // seen on disk, a version kept).
  const eventWork = (e: GraphEvent) => { const id = 's:' + e.turn + ':' + e.key; return layers.nodes.has(id) ? id : layers.nodes.has('a:' + e.turn) ? 'a:' + e.turn : null; };
  const workOf = (node: GraphNode | undefined, turn?: string) => {
    if (!node) return null;
    if (node.kind === 'question') return 'a:' + node.turn;
    const mine = [...node.events].reverse().filter(e => !turn || e.turn === turn);
    const event = mine.find(e => e.action === 'read' || e.action === 'edit' || e.action === 'write' || e.action === 'run') ?? mine[0] ?? node.events.at(-1);
    return event ? eventWork(event) : null;
  };
  const liveTurn = process.turns.find(t => t.running)?.id;
  const live = cursor === null && agentNow?.running && process.live ? { ...process.live, work: workOf(processNodes.get(process.live.node), liveTurn) } : null;
  const liveItem = live?.work ? shownAs(layers, live.work, open) : null;
  const waiting = process.nodes.find(n => n.waiting);
  const waitingWork = waiting ? workOf(waiting, liveTurn) : null;

  // Pan and zoom: dragging the background or scrolling moves; pinching or ⌘/Ctrl-scrolling zooms.
  const canvas = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 }), [gliding, setGliding] = useState(false);
  const viewNow = useRef(view); viewNow.current = view;
  const touched = useRef(false);
  const glide = (next: View) => { setGliding(true); setView(next); setTimeout(() => setGliding(false), 380); };
  const fit = useCallback((animate = true) => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box || !scene.width) return;
    const k = Math.max(zoomLimits.min, Math.min(1, (box.width - 96) / scene.width, (box.height - 132) / scene.height));
    const next = { k, x: (box.width - scene.width * k) / 2, y: Math.max(56, (box.height - scene.height * k) / 2) };
    if (animate) glide(next); else setView(next);
  }, [scene]);
  // One thing brought into view: whole when it fits at a readable size, else from its top left.
  const bring = (id: string, animate = true) => {
    const p = items.get(id), box = canvas.current?.getBoundingClientRect();
    if (!p || !box) return;
    const k = Math.max(readable, Math.min(1, viewNow.current.k, (box.width - 96) / p.width, (box.height - 132) / p.height));
    const wide = p.width * k <= box.width - 64, tall = p.height * k <= box.height - 110;
    const next = { k, x: wide ? (box.width - p.width * k) / 2 - p.x * k : 40 - p.x * k, y: tall ? Math.max(64, (box.height - p.height * k) / 2) - p.y * k : 64 - p.y * k };
    if (animate) glide(next); else setView(next);
  };
  // The page opens on the whole graph when that leaves it readable. A graph that is too tall for
  // that but fits across the page, or nearly, opens across it from the top instead, like a page:
  // its names can be read, and the rest is a scroll away. Only one too wide for that as well opens
  // small, as names. Until the person moves, opens or chooses something, sessions that are read
  // later bring it into view again.
  const shape = scene.items.filter(i => i.kind === 'line' || i.kind === 'frame').map(i => i.id).join('|');
  useLayoutEffect(() => {
    if (touched.current || !scene.items.length || loading) return;
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    const whole = Math.min(1, (box.width - 96) / scene.width, (box.height - 132) / scene.height);
    const across = Math.min(1, (box.width - 96) / scene.width);
    if (whole < 0.9 && across >= pageAt) { setView({ k: across, x: (box.width - scene.width * across) / 2, y: 40 }); return; }
    // Too much for one screen at a size that reads: its full width from the top, like a page.
    if (whole >= wholeAt) fit(false); else { const k = Math.max(wholeAt, Math.min(1, (box.width - 96) / scene.width)); setView({ k, x: Math.max(40, (box.width - scene.width * k) / 2), y: 56 }); }
  }, [shape, loading]);
  // What is chosen stays on screen when its details open beside the canvas and narrow it.
  useEffect(() => {
    if (!selected) return;
    touched.current = true;
    const p = items.get(selected), box = canvas.current?.getBoundingClientRect(), v = viewNow.current;
    if (!p || !box || seeking) return;
    const left = p.x * v.k + v.x, top = p.y * v.k + v.y, w = p.width * v.k, h = p.height * v.k;
    const dx = w > box.width - 48 || left < 24 ? 24 - left : left + w > box.width - 24 ? box.width - 24 - left - w : 0;
    const dy = h > box.height - 96 || top < 64 ? 64 - top : top + h > box.height - 32 ? box.height - 32 - top - h : 0;
    if ((dx || dy) && (p.kind !== 'frame' || left > box.width - 80 || top > box.height - 80)) glide({ ...v, x: v.x + dx, y: v.y + dy });
  }, [selected]);
  // Opening or closing a node keeps it where it was on screen; a line just opened comes into view.
  const anchor = useRef<{ id: string; x: number; y: number; bring: boolean } | null>(null);
  useLayoutEffect(() => {
    const kept = anchor.current, p = kept && items.get(kept.id);
    anchor.current = null;
    if (!kept || !p) return;
    if (kept.bring) { bring(kept.id); return; }
    const v = viewNow.current;
    setView({ ...v, x: kept.x - p.x * v.k, y: kept.y - p.y * v.k });
  }, [scene]);
  function toggle(id: string, wanted?: boolean) {
    const p = items.get(id), v = viewNow.current, opening = wanted ?? !open.has(id);
    if (opening === open.has(id)) return;
    stored.current = true; touched.current = true;
    if (p) anchor.current = { id, x: p.x * v.k + v.x, y: p.y * v.k + v.y, bring: opening && layers.nodes.get(id)?.level === 'line' };
    setOpen(prev => { const next = new Set(prev); if (opening) next.add(id); else next.delete(id); return next; });
  }
  // Shows a node however deep it is: everything above it opens, and it is chosen and brought into view.
  const [seeking, setSeeking] = useState<string | null>(null);
  function reveal(id: string) {
    if (id.startsWith('t:')) { touched.current = true; setSelected(id); return; }
    const claim = layers.claims.find(c => c.id === id), cut = id.indexOf('|');
    const above = claim ? [claim.line] : layers.nodes.has(id) ? ancestors(layers, id).slice(1).filter(a => a !== layers.root) : cut > 0 ? [id.slice(0, cut)] : [];
    stored.current = true; touched.current = true;
    setOpen(prev => new Set([...prev, ...above]));
    setSelected(id); setSeeking(id);
  }
  useEffect(() => { if (seeking && items.has(seeking)) { const p = items.get(seeking)!, box = canvas.current?.getBoundingClientRect(), v = viewNow.current; if (box) glide({ k: Math.max(v.k, readable), x: box.width / 2 - (p.x + p.width / 2) * Math.max(v.k, readable), y: box.height / 2 - (p.y + p.height / 2) * Math.max(v.k, readable) }); setSeeking(null); } }, [seeking, items]);
  // Every node under one opens: its complete record, step by step.
  function openAll(id: string) {
    const all: string[] = [];
    const walk = (node?: WorkNode) => { if (!node || node.level === 'step') return; all.push(node.id); node.children.forEach(child => walk(layers.nodes.get(child))); };
    walk(layers.nodes.get(id));
    stored.current = true; anchor.current = null;
    setOpen(prev => new Set([...prev, ...ancestors(layers, id).filter(a => a !== layers.root), ...all]));
  }
  useEffect(() => { if (initialResource) { const hit = [...layers.artifacts.values()].find(a => a.nodes.some(n => (n.versions ?? (n.resource ? [{ resource: n.resource }] : [])).some(v => v.resource.id === initialResource.id && v.resource.version === initialResource.version))); const line = hit && lines.find(l => lineFiles(layers, l.id).made.some(f => f.path === hit.path)); if (hit && line) reveal(line.id + '|' + hit.path); } }, [initialResource?.id, initialResource?.version, layers.artifacts.size]);
  // Following keeps the Agent in view: its line and message open, and the node it is on stays on screen.
  useEffect(() => {
    if (!following || !live?.work || cursor !== null) return;
    const above = ancestors(layers, live.work).filter(id => { const level = layers.nodes.get(id)!.level; return level === 'line' || level === 'ask'; });
    if (above.some(id => !open.has(id))) { setOpen(prev => new Set([...prev, ...above])); return; }
    const p = liveItem && items.get(liveItem), box = canvas.current?.getBoundingClientRect(), v = viewNow.current;
    if (!p || !box) return;
    const left = p.x * v.k + v.x, top = p.y * v.k + v.y;
    if (left < 24 || top < 64 || left + p.width * v.k > box.width - 24 || top + p.height * v.k > box.height - 24) glide({ ...v, x: box.width / 2 - (p.x + p.width / 2) * v.k, y: box.height / 2 - (p.y + p.height / 2) * v.k });
  }, [following, live?.work, liveItem, scene]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      event.preventDefault(); touched.current = true; moved();
      const v = viewNow.current;
      if (event.ctrlKey || event.metaKey) {
        const box = element!.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top;
        const k = Math.min(zoomLimits.max, Math.max(zoomLimits.min, v.k * Math.exp(-event.deltaY * 0.01)));
        setView({ k, x: px - (px - v.x) * k / v.k, y: py - (py - v.y) * k / v.k });
      } else setView({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY });
      if (following) onStopFollowing();
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [following]);
  const [keyOpen, setKeyOpen] = useState(false);
  // Each move the person makes; the map comes up for those, not for moves the page makes itself.
  const [moves, setMoves] = useState(0), moved = () => setMoves(n => n + 1);
  const dragged = useRef(false);
  function pan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.graph-node, .lg-frame-head, .graph-nav, .graph-overlay, .graph-legend')) return;
    const start = { x: event.clientX, y: event.clientY, view: viewNow.current }, element = event.currentTarget; touched.current = true;
    element.setPointerCapture(event.pointerId); dragged.current = false;
    const move = (e: PointerEvent) => {
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) { dragged.current = true; element.dataset.panning = ''; moved(); }
      setView({ ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y });
    };
    const stop = () => {
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); delete element.dataset.panning;
      if (!dragged.current) setSelected(null); else if (following) onStopFollowing();
    };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  const zoomBy = (factor: number) => {
    touched.current = true; moved();
    const box = canvas.current?.getBoundingClientRect(), v = viewNow.current;
    if (!box) return;
    const k = Math.min(zoomLimits.max, Math.max(zoomLimits.min, v.k * factor)), px = box.width / 2, py = box.height / 2;
    glide({ k, x: px - (px - v.x) * k / v.k, y: py - (py - v.y) * k / v.k });
  };
  // Keys: right opens the node in focus and left closes it, or goes to what holds it; up and down
  // move along its column.
  function keys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('input, textarea')) return;
    const from = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-node]')?.dataset.node;
    if (event.key === 'Escape') { if (selected) { event.preventDefault(); setSelected(null); } return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.2); return; }
    if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); return; }
    if (event.key === '0') { event.preventDefault(); fit(); return; }
    const here = from ? items.get(from) : undefined;
    if (!here || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const node = layers.nodes.get(here.ref), focusOn = (id?: string) => { if (id) canvas.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"] button, button[data-node="${CSS.escape(id)}"]`)?.focus(); };
    if (event.key === 'ArrowRight' && node?.children.length && node.level !== 'activity' ? !open.has(node.id) : event.key === 'ArrowRight' && node?.level === 'activity' && !open.has(node.id)) { toggle(here.id, true); return; }
    if (event.key === 'ArrowLeft' && node) { if (open.has(node.id)) toggle(here.id, false); else focusOn(node.parent && items.has(node.parent) ? node.parent : undefined); return; }
    const column = scene.items.filter(i => i.kind !== 'label' && i.kind !== 'frame' && Math.abs(i.x - here.x) < 40 && i.line === here.line).sort((a, b) => a.y - b.y);
    focusOn(column[column.indexOf(here) + (event.key === 'ArrowDown' ? 1 : -1)]?.id);
  }

  const near = view.k >= 0.56;
  const dim = (id: string) => !!((focus && !focus.has(id)) || (found && !found.shown.has(id)));
  const counts = { lines: lines.filter(l => !l.quiet).length, talks: new Set(lines.flatMap(l => l.conversations?.filter(c => !c.startsWith('terminal:')) ?? [])).size, asks: [...layers.nodes.values()].filter(n => n.level === 'ask' && !n.terminal).length, steps: layers.nodes.get(layers.root)!.steps, claims: layers.claims.length,
    typed: [...layers.nodes.values()].filter(n => n.level === 'step' && n.record?.terminal).length };
  const wireOn = (w: Wire) => !!focus && focus.has(w.from) && focus.has(w.to) && (target?.kind !== 'file' || w.from === selected || w.to === selected || items.get(w.from)?.ref === target.path || items.get(w.to)?.ref === target.path);
  const flag = (id: string) => liveItem === id && live ? (agentNow?.agent ?? 'Agent') + ' · ' + live.label : null;
  // A message or a conversation pressed on the timeline is chosen here as it stands: its line of
  // work lights up and its details open, and nothing on the canvas opens or moves.
  const pick = (picked: TimelinePick) => {
    const id = picked.turn && layers.nodes.has('a:' + picked.turn) ? 'a:' + picked.turn : picked.conversation ? talkId(picked.conversation) : null;
    if (id && targetOf(layers, id)) { touched.current = true; setSelected(selected === id ? null : id); }
  };
  // The conversation chosen or worked in now, for the line of work that lists it.
  const talkOf = (id: string | null | undefined) => id ? layers.nodes.get(id)?.conversationId ?? null : null;
  const chosenTalk = target?.kind === 'talk' ? target.talk.id : target?.kind === 'work' ? target.node.conversationId ?? null : null, liveTalk = talkOf(live?.work);
  const holds = (path: string) => meaning.holds(path);

  if (!loading && !scene.items.length && !marks.length) return <section className="graph-page"><GraphHead counts={null} /><div className="studio-empty"><span className="empty-symbol"><Icon name="graph" size={26} stroke={1.5} /></span><h2>{problem ? 'Work could not be read' : 'Nothing to draw yet'}</h2>
    <p>{problem ? 'Earlier records are kept. This page will retry.' : 'Work recorded in this project appears here, including sessions observed from your Agent’s own window.'}</p>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    <div className="empty-actions"><button className="primary" onClick={() => onAgent()}><Icon name="prompt" size={17} stroke={1.6} /><span>Ask Agent</span></button></div></div></section>;
  return <section className="graph-page" aria-labelledby="graph-title">
    <GraphHead counts={counts} omitted={omitted} reading={read < sessions.length ? { read, of: sessions.length } : null}>
      {open.size > 0 && <button className="small-button" onClick={() => { stored.current = true; touched.current = false; setSelected(null); setOpen(new Set()); }}>Close all</button>}
      <label className="graph-search"><Icon name="search" size={15} /><input type="search" placeholder="Find in all the work" aria-label="Find in all the work" value={query} onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && found?.raw.length) reveal(found.raw[0]!); }} />{found && <small>{found.raw.length}</small>}</label>
      {waitingWork && <button className="graph-waiting" onClick={() => reveal(waitingWork)}><span className="pulse-dot" aria-hidden="true" />Needs your choice</button>}
      {agentNow?.running && <button className={'follow-toggle' + (following ? ' on' : '')} aria-pressed={following} title={following ? 'The graph keeps the Agent in view as it works.' : 'Keep the Agent in view as it works.'} onClick={following ? onStopFollowing : onFollow}>
        {following ? <><span className="pulse-dot" aria-hidden="true" />Following {agentNow.agent}</> : <><Icon name="follow" size={15} />Follow {agentNow.agent}</>}</button>}
    </GraphHead>
    {problem && <p className="inline-error graph-problem" role="alert">{problem}</p>}
    <div className={'graph-body' + (target ? ' inspecting' : '')}>
      <div ref={canvas} className={'graph-canvas' + (focus ? ' focusing' : '') + (cursor !== null ? ' replaying' : '')} tabIndex={-1} onPointerDown={pan} onKeyDown={keys}
        onScroll={e => { const el = e.currentTarget, dx = el.scrollLeft, dy = el.scrollTop; if (!dx && !dy) return; el.scrollLeft = 0; el.scrollTop = 0; const v = viewNow.current; setView({ ...v, x: v.x - dx, y: v.y - dy }); }}>
        {loading ? <div className="loading-state" role="status"><span className="loading-dot" /><span>Reading what was done…</span></div> : <>
          <div className={'graph-world' + (gliding ? ' gliding' : '')} data-zoom={near ? 'near' : 'far'} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: scene.width, height: scene.height, '--k': view.k } as CSSProperties}>
            {scene.items.filter(i => i.kind === 'frame').map(item => <Frame key={item.id} item={item} node={layers.nodes.get(item.ref)!} layers={layers} selected={selected === item.id} dimmed={!!found && !found.shown.has(item.id) && ![...found.shown].some(id => items.get(id)?.line === item.id)} flag={null}
              onSelect={() => setSelected(selected === item.id ? null : item.id)} onToggle={() => toggle(item.id)} />)}
            <Wires scene={scene} items={items} on={wireOn} focusing={!!focus} labels={near} dim={dim} later={w => { const a = items.get(w.from), b = items.get(w.to); return !!a && !!b && (later(a) || later(b)); }} live={liveItem} />
            {scene.items.filter(i => i.kind !== 'frame').map(item => {
              const common = { item, selected: selected === item.id, dimmed: dim(item.id), later: later(item), onSelect: () => setSelected(selected === item.id ? null : item.id) };
              if (item.kind === 'label') return <span key={item.id} className="lg-label" style={{ left: item.x, top: item.y, width: item.width }}>{item.ref}</span>;
              if (item.kind === 'file') return <FileCard key={item.id} {...common} artifact={newest(item.ref)} category={layers.artifacts.get(item.ref)?.category ?? kindOf(item.ref)} holds={holds(item.ref)} from={item.from ? lineName(layers.nodes.get(item.from)!) : undefined} client={client} snapshot={snapshot} near={near} />;
              if (item.kind === 'bundle') return <button key={item.id} className="graph-node lg-file lg-bundle" data-node={item.id} data-kind="bundle" style={place(item)} aria-label={`${item.paths!.length} files from ${layers.nodes.get(item.ref)?.title}: ${item.paths!.join(', ')}. Go there`} title={item.paths!.join('\n')}
                data-dimmed={dim(item.id) || undefined} data-later={later(item) || undefined} onClick={() => setSelected(item.ref)}>
                <span className="graph-node-icon"><Icon name="workflow" size={14} stroke={1.8} /></span><span className="lg-text"><strong className="lg-title">{item.paths!.length} files</strong><span className="lg-note">From {lineName(layers.nodes.get(item.ref)!)}</span></span></button>;
              if (item.kind === 'claim') return <ClaimCard key={item.id} {...common} claim={layers.claims.find(c => c.id === item.ref)!} />;
              const node = layers.nodes.get(item.ref)!;
              if (item.kind === 'line') return <LineCard key={item.id} {...common} node={node} layers={layers} chosenTalk={chosenTalk} liveTalk={liveTalk} onTalk={id => { touched.current = true; setSelected(selected === talkId(id) ? null : talkId(id)); }} figure={item.figure ? newest(lineFiles(layers, node.id).made.map(f => f.path).reverse().find(p => isPicture(p) && newest(p)?.resource) ?? '') : undefined} client={client} snapshot={snapshot} near={near} flag={flag(item.id)} waiting={!!waitingWork && liveItem === item.id} onToggle={() => toggle(item.id)} />;
              return <WorkRow key={item.id} {...common} node={node} current={!!current && eventWork(current) !== null && shownAs(layers, eventWork(current)!, open) === item.id} flag={flag(item.id)} waiting={!!waitingWork && shownAs(layers, waitingWork, open) === item.id} onToggle={() => toggle(item.id)} />;
            })}
          </div>
          {focus && target && <div className="graph-overlay"><span>{target.kind === 'claim' ? 'What this statement rests on, and the work that made it' : target.kind === 'talk' ? 'What this conversation used and made' : target.kind === 'file' ? <>The work that touched <strong>{target.path.split('/').at(-1)}</strong> and what is concluded from it</> : target.node.level === 'step' ? 'The files in this step' : target.node.terminal ? 'What these commands used and made' : 'What this ' + levelLabel[target.node.level].toLowerCase() + ' used and made'}</span><button className="small-button" onClick={() => setSelected(null)}>Show everything</button></div>}
          {current && <div className="graph-caption" role="status" aria-live="polite"><time>{clock(current.at, true)}</time><span>{stepCaption(current, processNodes)}</span></div>}
          <div className="graph-nav">
          <MiniMap scene={scene} view={view} canvas={canvas} dim={dim} live={liveItem} moves={moves} onMove={setView} />
          <div className="graph-zoom" role="group" aria-label="Zoom">
            <button className="icon-button" aria-label="Fit the graph" title="Fit (0)" onClick={() => fit()}><Icon name="fit" size={16} /></button>
            <button className="icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / 1.2)}><Icon name="minus" size={16} /></button>
            <span className="graph-zoom-value" aria-live="polite">{Math.round(view.k * 100)}%</span>
            <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.2)}><Icon name="plus" size={16} /></button>
          </div>
          </div>
          {/* The lines between files and work exist only inside an open line of work. */}
          {scene.wires.some(w => w.kind !== 'flow') && <div className={'graph-legend' + (keyOpen ? ' open' : '')}>
            <button className="graph-key" aria-expanded={keyOpen} onClick={() => setKeyOpen(!keyOpen)}><i className="line named" />What the lines mean</button>
            {keyOpen && <div className="graph-key-list">
              <span><i className="line reported" />The Agent reported it</span>
              <span><i className="line named" />Named in a command</span>
              <span><i className="line observed" />Seen changing on disk</span>
              {layers.claims.length > 0 && <span><i className="line declared" />Written in the notes</span>}
            </div>}
          </div>}
        </>}
      </div>
      {target && <Inspector key={selected} target={target} layers={layers} process={process} turns={turns} holds={holds} newest={newest} waiting={waiting && waitingWork === selected ? waiting.waiting! : undefined} client={client} snapshot={snapshot} principalId={principalId} workspace={workspace}
        cursor={cursor} agentOf={agentOf} onStudio={onStudio} onAgent={onAgent} onSelect={reveal} onOpenAll={openAll} onClose={() => setSelected(null)} />}
    </div>
    {(process.events.length > 0 || marks.length > 0) && <Timeline graph={process} marks={marks} cursor={cursor} playing={playing} running={!!agentNow?.running} speed={speed} onSpeed={setSpeed}
      chosen={chosen} onPick={pick} onCursor={at => { setPlaying(false); setCursor(at); }} onPlay={() => { if (playing) setPlaying(false); else { if (cursor !== null && cursor >= times.at(-1)!) setCursor(null); setPlaying(true); } }} />}
  </section>;
}

function GraphHead({ counts, omitted = 0, reading, children }: { counts: { lines: number; talks: number; asks: number; steps: number; claims: number; typed: number } | null; omitted?: number; reading?: { read: number; of: number } | null; children?: ReactNode }) {
  return <header className="graph-head">
    <div className="graph-heading"><h1 id="graph-title">Graph</h1><p>{counts ? `${plural(counts.lines, 'line', 'lines')} of work${counts.talks > counts.lines ? ' in ' + plural(counts.talks, 'conversation') : ''}, ${counts.asks ? plural(counts.asks, 'message') + ', ' : ''}${plural(counts.steps, 'recorded step')}${counts.typed ? counts.typed === counts.steps ? ', all typed in a terminal' : `, ${counts.typed} of them typed in a terminal` : ''}.` : 'What was done in this project, from its lines of work down to each recorded step.'}
      {counts && counts.claims > 0 && ` The notes conclude ${plural(counts.claims, 'thing')} from it.`}{reading && ` Reading session ${reading.read + 1} of ${reading.of}…`}{omitted > 0 && ` ${plural(omitted, 'earlier message')} could not be read.`}</p></div>
    {children && <div className="graph-tools">{children}</div>}
  </header>;
}

const place = (item: Item): CSSProperties => ({ left: item.x, top: item.y, width: item.width, height: item.height });
interface CardProps { item: Item; selected: boolean; dimmed: boolean; later: boolean; onSelect: () => void }
const Flag = ({ text, waiting }: { text: string; waiting: boolean }) => <span className={'graph-flag' + (waiting ? ' waiting' : '')}><span className="pulse-dot" aria-hidden="true" />{waiting ? 'Needs your choice' : text}</span>;
// What a line of work comes to, in the few words its card and its frame both carry.
function lineFacts(layers: WorkLayers, node: WorkNode) {
  const claims = layers.claims.filter(c => c.line === node.id), findings = claims.filter(c => c.kind === 'finding').length, choices = claims.length - findings;
  const made = lineFiles(layers, node.id).made.length, failedAsks = node.children.filter(id => layers.nodes.get(id)!.state === 'failed').length;
  const asks = node.children.filter(id => !layers.nodes.get(id)!.terminal).length;
  return [asks ? plural(asks, 'message') : '', plural(node.steps, 'step'), made ? plural(made, 'file') + ' made' : '', findings ? plural(findings, 'finding') : '', choices ? plural(choices, 'choice') : '', failedAsks ? failedAsks + ' failed' : ''].filter(Boolean);
}

function LineCard({ item, node, layers, figure, client, snapshot, near, selected, dimmed, later, flag, waiting, chosenTalk, liveTalk, onSelect, onToggle, onTalk }: CardProps & { node: WorkNode; layers: WorkLayers; figure?: GraphNode; client: BrowserClient; snapshot: WorkspaceSnapshot; near: boolean; flag: string | null; waiting: boolean;
  chosenTalk: string | null; liveTalk: string | null; onToggle: () => void; onTalk: (conversationId: string) => void }) {
  const facts = lineFacts(layers, node), talks = talksOf(layers, node.id), several = talks.length > 1 && !item.brief && !node.quiet, brand = node.agents?.length === 1 ? brandOf(node.agents[0]!) : null;
  // The card says what the line comes to; how many steps that took is in its details.
  const meta = [daysOf(node.start, node.end), talks.length > 1 && (item.brief || !!node.section) ? plural(talks.length, 'conversation') : '', ...facts.filter(f => node.quiet || !/ steps?$/.test(f))].filter(Boolean);
  // Whose conversation each is, when they are not all one Agent's.
  const name = lineName(node), mixed = new Set(talks.map(t => t.terminal ? 'terminal' : t.agent)).size > 1;
  return <div className={'graph-node lg-line' + (node.quiet ? ' quiet' : '') + (item.brief ? ' brief' : '')} data-node={item.id} data-kind="line" style={{ left: item.x, top: item.y, width: item.width, minHeight: item.height }} data-selected={selected || undefined} data-dimmed={dimmed || undefined} data-later={later || undefined} data-live={flag ? '' : undefined}>
    <button className="lg-main" aria-pressed={selected} aria-label={`${node.quiet ? 'Conversation' : 'Line of work'}: ${name}. ${facts.join(', ')}`} onClick={onSelect} onDoubleClick={onToggle}>
      <span className="lg-line-head">{brand && <BrandMark brand={brand} size={14} />}<strong className="graph-node-title" title={name}>{name}</strong></span>
      <span className="lg-line-meta">{meta.map(f => <span key={f} className={/failed/.test(f) ? 'bad' : ''}>{f}</span>)}</span>
      {flag && <span className={'lg-live' + (waiting ? ' waiting' : '')}><span className="pulse-dot" aria-hidden="true" />{waiting ? 'Needs your choice' : flag}</span>}
      {!several && !node.quiet && !item.brief && node.said && node.said !== node.title && <span className="lg-said">{node.said}</span>}
      {figure && <CardPreview client={client} snapshot={snapshot} node={figure} shown={near && !later} />}
    </button>
    {several && <ul className="lg-talks" aria-label="Its conversations">{talks.map(t => { const mark = t.agent ? brandOf(t.agent) : null; return <li key={t.id}>
      <button className="lg-talk" aria-pressed={chosenTalk === t.id} data-live={liveTalk === t.id || undefined} title={t.title} onClick={() => onTalk(t.id)} onDoubleClick={onToggle}>
        {mixed && (mark ? <BrandMark brand={mark} size={12} /> : <Icon name={t.terminal ? 'monitor' : 'chat'} size={12} />)}<span>{t.title}</span>
        <small>{liveTalk === t.id && <span className="pulse-dot" aria-hidden="true" />}{dayOf(t.start)} · {plural(t.asks.length, t.terminal ? 'command' : 'message')}</small></button></li>; })}</ul>}
    <button className="lg-toggle" aria-expanded={false} aria-label={'Open ' + name} title="Open" onClick={onToggle}><Icon name="chevron" size={14} /></button>
  </div>;
}

function Frame({ item, node, layers, selected, dimmed, onSelect, onToggle }: { item: Item; node: WorkNode; layers: WorkLayers; selected: boolean; dimmed: boolean; flag: string | null; onSelect: () => void; onToggle: () => void }) {
  return <div className="lg-frame" data-node={item.id} data-kind="frame" style={place(item)} data-selected={selected || undefined} data-dimmed={dimmed || undefined}>
    <div className="lg-frame-head">
      <button className="lg-toggle open" aria-expanded aria-label={'Close ' + lineName(node)} title="Close" onClick={onToggle}><Icon name="chevron" size={14} /></button>
      <button className="lg-main" aria-pressed={selected} aria-label={`Line of work: ${lineName(node)}`} onClick={onSelect} onDoubleClick={onToggle}>
        <strong title={lineName(node)}>{lineName(node)}</strong><span className="lg-facts">{lineFacts(layers, node).map(f => <span key={f} className={/failed/.test(f) ? 'bad' : ''}>{f}</span>)}</span>
      </button>
    </div>
  </div>;
}

// A message, an activity or a step in the work column. A message and an activity open in place.
function WorkRow({ item, node, selected, dimmed, later, current, flag, waiting, onSelect, onToggle }: CardProps & { node: WorkNode; current: boolean; flag: string | null; waiting: boolean; onToggle: () => void }) {
  const can = node.level !== 'step' && node.children.length > 0;
  const bad = node.level === 'step' ? node.failed > 0 : node.level === 'ask' && node.state === 'failed';
  const meta = node.level === 'ask' ? [node.agent, plural(node.steps, 'step'), took(node), askEnd(node)].filter(Boolean).join(' · ')
    : node.level === 'activity' ? [plural(node.steps, 'step'), node.rounds && node.rounds > 1 ? node.rounds + ' rounds' : '', node.failed ? node.failed + ' failed' : ''].filter(Boolean).join(' · ')
    : [node.outcome && node.outcome !== 'returned' && node.outcome !== 'said' ? (outcomes[node.outcome] ?? node.outcome) : '', clock(node.end, true)].filter(Boolean).join(' · ');
  return <div className={'graph-node lg-row level-' + node.level + (item.open ? ' open' : '') + (node.kind ? ' kind-' + node.kind : '') + (node.action ? ' action-' + node.action : '')} data-node={item.id} data-kind={node.level} style={place(item)}
    data-selected={selected || undefined} data-dimmed={dimmed || undefined} data-later={later || undefined} data-current={current || undefined} data-bad={bad || undefined} data-live={flag ? '' : undefined}>
    {flag && <Flag text={flag} waiting={waiting} />}
    {can && <button className={'lg-toggle' + (item.open ? ' open' : '')} aria-expanded={!!item.open} aria-label={(item.open ? 'Close ' : 'Open ') + node.title} title={item.open ? 'Close' : node.level === 'ask' ? 'Show its activities' : 'Show its steps'} onClick={onToggle}><Icon name="chevron" size={13} /></button>}
    <button className="lg-main" aria-pressed={selected} aria-label={`${levelLabel[node.level]}: ${node.title}. ${meta}`} onClick={onSelect} onDoubleClick={can ? onToggle : undefined}>
      <span className="graph-node-icon"><Icon name={workIcon(node)} size={node.level === 'step' ? 12 : 14} stroke={1.8} /></span>
      <span className="lg-text"><strong className="lg-title" title={node.level === 'ask' ? node.text : node.record?.detail ?? node.title}>{node.title}</strong>
        {node.level === 'ask' && !item.open && node.answer && <span className="lg-answer">{gist(node.answer)}</span>}</span>
      <span className="lg-meta">{meta}</span>
    </button>
  </div>;
}

function FileCard({ item, artifact, category, holds, from, client, snapshot, near, selected, dimmed, later, onSelect }: CardProps & { artifact?: GraphNode; category: FileKind; holds?: Holds; from?: string; client: BrowserClient; snapshot: WorkspaceSnapshot; near: boolean }) {
  const name = item.ref.split('/').at(-1)!, folder = item.ref.includes('/') ? item.ref.split('/').slice(0, -1).join('/') : '';
  const note = item.unrecorded ? 'No recorded step of this line touched it' : from ? 'From ' + from : item.existing ? 'Was here before; changed' : holds?.text ?? folder;
  return <button className={'graph-node lg-file tone-' + (category ?? 'other') + (item.figure ? ' figure' : '')} data-node={item.id} data-kind="file" style={place(item)} aria-pressed={selected} aria-label={`${fileLabel(category)}: ${item.ref}. ${note}`}
    data-dimmed={dimmed || undefined} data-later={later || undefined} data-missing={item.unrecorded || (artifact && !artifact.exists) || undefined} onClick={onSelect}>
    <span className="graph-node-icon"><Icon name={fileIcon(category)} size={14} stroke={1.8} /></span>
    <span className="lg-text"><strong className="lg-title" title={item.ref}>{name}</strong><span className="lg-note" title={holds?.text}>{note}</span></span>
    {item.figure && artifact && <CardPreview client={client} snapshot={snapshot} node={artifact} shown={near && !later} />}
  </button>;
}

function ClaimCard({ item, claim, selected, dimmed, later, onSelect }: CardProps & { claim: Claim }) {
  // A file written again on disk since may hold the same bytes; only a newer kept version says it changed.
  const stale = claim.trace?.files.some(f => f.later === 'kept') ? 'A file it names has a newer version' : '';
  const note = grounds[claim.ground] || stale;
  return <button className={'graph-node lg-claim kind-' + claim.kind} data-node={item.id} data-kind={claim.kind} style={place(item)} aria-pressed={selected} aria-label={`${claim.kind === 'finding' ? 'Finding' : 'Choice'}: ${claim.text}${note ? '. ' + note : ''}`}
    data-dimmed={dimmed || undefined} data-later={later || undefined} data-ground={claim.ground} onClick={onSelect}>
    <span className="graph-node-icon"><Icon name={claim.kind === 'finding' ? 'check' : 'updown'} size={13} stroke={1.9} /></span>
    <span className="lg-text"><span className="lg-claim-text" title={claim.text}>{claim.text}</span>{note && <span className="lg-note warn">{note}</span>}</span>
  </button>;
}

// The lines between what is on screen: a file into the work that used it, the work into the file
// it made, a file into what is concluded from it, and one line of work into the next.
function Wires({ scene, items, on, focusing, labels, dim, later, live }: { scene: Scene; items: Map<string, Item>; on: (w: Wire) => boolean; focusing: boolean; labels: boolean; dim: (id: string) => boolean; later: (w: Wire) => boolean; live: string | null }) {
  const few = scene.wires.length <= 26;
  return <svg className="graph-edges" width={scene.width} height={scene.height} aria-hidden="true" style={{ overflow: 'visible' }}>
    <defs>
      <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" className="arrow" /></marker>
      <marker id="graph-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" className="arrow on" /></marker>
    </defs>
    {scene.wires.map(w => {
      const a = items.get(w.from), b = items.get(w.to);
      if (!a || !b || later(w)) return null;
      // One line of work to one in a lower row leaves its foot and enters the other's head.
      const below = w.kind === 'flow' && b.y >= a.y + a.height;
      const forward = !below && a.x + a.width <= b.x, back = !below && b.x + b.width <= a.x;
      // One line of work to another in the same row with lines between them: over those, the
      // way back higher than the way forward.
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      const over = w.kind === 'flow' && (forward || back) && scene.items.some(i => (i.kind === 'line' || i.kind === 'frame') && i !== a && i !== b && i.x > left && i.x < right && i.y < Math.max(a.y + a.height, b.y + b.height) && i.y + i.height > Math.min(a.y, b.y));
      if (over) {
        const top = Math.min(a.y, b.y), lift = forward ? 44 : 70, xa = forward ? a.x + a.width - 46 : a.x + 70, xb = forward ? b.x + 46 : b.x + b.width - 70, lit = on(w), off = (focusing && !lit) || dim(w.from) || dim(w.to);
        return <g key={w.id} data-label={w.label} data-kind={w.kind} className={'graph-edge ' + w.basis + ' wire-' + w.kind + (lit ? ' on' : '') + (off ? ' off' : '')}>
          <path d={`M${xa} ${a.y} C${xa} ${top - lift} ${xb} ${top - lift} ${xb} ${b.y - 2}`} markerEnd={lit ? 'url(#graph-arrow-on)' : 'url(#graph-arrow)'} />
          {labels && !off && <text x={(xa + xb) / 2} y={top - lift * 0.75 - 6} textAnchor="middle">{w.label}</text>}
        </g>;
      }
      // Between lines of work a wire runs at the height of their names: the later line's below the earlier's.
      const level = (i: Item) => w.kind === 'flow' ? i.y + Math.min(i.height / 2, back ? 56 : 32) : i.y + i.height / 2;
      const x1 = forward ? a.x + a.width : back ? a.x : a.x + a.width / 2, y1 = forward || back ? level(a) : a.y + a.height;
      const x2 = forward ? b.x : back ? b.x + b.width : b.x + b.width / 2, y2 = forward || back ? level(b) : b.y;
      const bend = Math.max(30, Math.abs(x2 - x1) / 2) * (back ? -1 : 1);
      const d = forward || back ? `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 + (back ? 2 : -2)} ${y2}` : `M${x1} ${y1} C${x1} ${y1 + Math.min(60, (y2 - y1) * 0.8)} ${x2} ${y2 - Math.min(60, (y2 - y1) * 0.8)} ${x2} ${y2 - 2}`;
      const lit = on(w), off = (focusing && !lit) || dim(w.from) || dim(w.to);
      const show = labels && !off && (w.kind === 'flow' || lit || (few && !focusing && w.kind !== 'rests'));
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      return <g key={w.id} data-label={w.label} data-kind={w.kind} className={'graph-edge ' + w.basis + ' wire-' + w.kind + (lit ? ' on' : '') + (off ? ' off' : '') + (live && (w.to === live || w.from === live) ? ' live' : '')}>
        <path d={d} markerEnd={lit ? 'url(#graph-arrow-on)' : 'url(#graph-arrow)'} />
        {show && <text x={mx} y={my - 6} textAnchor="middle">{w.label}</text>}
      </g>;
    })}
  </svg>;
}

// The whole graph in small, with the part on screen outlined. Shown when the graph does not
// fit; pressing or dragging on it moves there.
function MiniMap({ scene, view, canvas, dim, live, moves, onMove }: { scene: Scene; view: View; canvas: { current: HTMLDivElement | null }; dim: (id: string) => boolean; live: string | null; moves: number; onMove: (view: View) => void }) {
  // It comes up while the person moves the view and from the zoom controls, and steps back when
  // the view rests, so nothing on the canvas stays covered.
  const [awake, setAwake] = useState(false);
  useEffect(() => { if (!moves) return; setAwake(true); const timer = setTimeout(() => setAwake(false), 1400); return () => clearTimeout(timer); }, [moves]);
  const box = canvas.current?.getBoundingClientRect();
  if (!box || !scene.width) return null;
  const inside = view.x >= 0 && view.y >= 0 && view.x + scene.width * view.k <= box.width && view.y + scene.height * view.k <= box.height;
  if (inside) return null;
  const width = 188, height = Math.max(64, Math.min(120, width * scene.height / scene.width)), scale = Math.min((width - 12) / scene.width, (height - 12) / scene.height);
  const ox = (width - scene.width * scale) / 2, oy = (height - scene.height * scale) / 2;
  const frame = { x: ox + -view.x / view.k * scale, y: oy + -view.y / view.k * scale, w: box.width / view.k * scale, h: box.height / view.k * scale };
  function move(event: ReactPointerEvent<SVGSVGElement>) {
    const element = event.currentTarget, rect = element.getBoundingClientRect();
    element.setPointerCapture(event.pointerId);
    const go = (clientX: number, clientY: number) => { const gx = (clientX - rect.left - ox) / scale, gy = (clientY - rect.top - oy) / scale; onMove({ ...view, x: box!.width / 2 - gx * view.k, y: box!.height / 2 - gy * view.k }); };
    go(event.clientX, event.clientY);
    const drag = (e: PointerEvent) => go(e.clientX, e.clientY);
    const stop = () => { element.removeEventListener('pointermove', drag); element.removeEventListener('pointerup', stop); };
    element.addEventListener('pointermove', drag); element.addEventListener('pointerup', stop);
  }
  return <div className={'graph-map' + (awake ? ' awake' : '')} aria-hidden="true">
    <svg width={width} height={height} onPointerDown={move}>
      {scene.items.filter(i => i.kind !== 'label').map(i => <rect key={i.id} className={'map-' + i.kind + (dim(i.id) ? ' off' : '') + (live === i.id ? ' live' : '')} x={ox + i.x * scale} y={oy + i.y * scale} width={Math.max(2, i.width * scale)} height={Math.max(1.5, i.height * scale)} rx={1.5} />)}
      <rect className="graph-map-frame" x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx={3} />
    </svg>
  </div>;
}

// The person's own place to read what is chosen: a level of the work with what it holds, a step's
// record as it was kept, a file with its kept version, or a statement with what it rests on.
function Inspector({ target, layers, process, turns, holds, newest, waiting, client, snapshot, principalId, workspace, cursor, agentOf, onStudio, onAgent, onSelect, onOpenAll, onClose }: {
  target: Target; layers: WorkLayers; process: Graph; turns: GraphTurn[]; holds: (path: string) => Holds | undefined; newest: (path: string) => GraphNode | undefined; waiting?: NonNullable<GraphNode['waiting']>;
  client: BrowserClient; snapshot: WorkspaceSnapshot; principalId?: string; workspace: () => string; cursor: number | null; agentOf: (conversationId: string) => string | undefined;
  onStudio: (compositionId: string, viewId?: string) => void; onAgent: (conversationId?: string) => void; onSelect: (id: string) => void; onOpenAll: (id: string) => void; onClose: () => void;
}) {
  const shell = useContext(ShellContext);
  const [placing, setPlacing] = useState(false), [problem, setProblem] = useState('');
  void principalId;
  async function openFile(path: string) {
    setPlacing(true); setProblem('');
    try { const placed = await openInWorkspace(client, snapshot, workspace(), path); if (placed) onStudio(placed.compositionId, placed.viewId); else setProblem('Rho has no viewer for this kind of file yet.'); }
    catch (error) { setProblem(error instanceof Error ? error.message : 'It could not be opened in the workspace.'); }
    finally { setPlacing(false); }
  }
  const node = target.kind === 'work' ? target.node : null, claim = target.kind === 'claim' ? target.claim : null, talk = target.kind === 'talk' ? target.talk : null;
  const artifact = target.kind === 'file' ? layers.artifacts.get(target.path) : undefined;
  const category = target.kind === 'file' ? artifact?.category ?? kindOf(target.path) : null;
  const lineId = target.kind === 'file' ? target.line : claim ? claim.line : talk ? talk.line : node ? ancestors(layers, node.id).find(id => layers.nodes.get(id)!.level === 'line') : undefined;
  const line = lineId ? layers.nodes.get(lineId) : undefined;
  const work = (id: string) => layers.nodes.get(id);
  const link = (id: string, icon: IconName, text: string, note?: string) => <li key={id}><button className="graph-link" onClick={() => onSelect(id)}><Icon name={icon} size={14} /><span>{text}</span></button>{note && <small>{note}</small>}</li>;
  const fileLink = (path: string, note?: string) => link((lineId ?? '') + '|' + path, fileIcon(layers.artifacts.get(path)?.category ?? kindOf(path)), path, note);
  // Where a node sits: the line, message and activity above it.
  const above = node ? ancestors(layers, node.id).slice(1).filter(id => id !== layers.root).reverse() : talk && line && (line.conversations?.length ?? 0) > 1 ? [line.id] : [];
  const title = node ? (node.level === 'step' && node.run ? 'Ran a command' : node.level === 'ask' ? (node.terminal ? node.title : 'You asked') : lineName(node)) : talk ? talk.title : claim ? (line ? lineName(line) : 'In the notes') : target.kind === 'file' ? target.path.split('/').at(-1)! : '';
  const kind = node ? (node.terminal ? (node.level === 'ask' ? 'Terminal' : 'Line of work · in a terminal') : node.level === 'line' && node.quiet ? 'Conversation' : levelLabel[node.level]) : talk ? (talk.terminal ? 'Terminal' : 'Conversation') : claim ? (claim.kind === 'finding' ? 'Finding' : 'Choice') + ' · in the notes' : fileLabel(category);
  const icon = node ? workIcon(node) : talk ? (talk.terminal ? 'monitor' : 'chat') : claim ? (claim.kind === 'finding' ? 'check' : 'updown') : fileIcon(category);

  return <aside className="graph-inspector" aria-label={kind + ' ' + title}>
    <header className="graph-inspector-head">
      <span className={'graph-node-icon tone-' + (target.kind === 'file' ? category ?? 'other' : node?.level === 'ask' ? 'question' : 'run')}><Icon name={icon} size={16} stroke={1.8} /></span>
      <div><small>{kind}</small><h2 title={title}>{title}</h2>{target.kind === 'file' && <p>{target.path}</p>}</div>
      <button className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={17} /></button>
    </header>
    <div className="graph-inspector-body">
      {above.length > 0 && <nav className="lg-above" aria-label="Where this is">{above.map(id => <button key={id} className="graph-link" onClick={() => onSelect(id)}><span>{lineName(work(id)!)}</span></button>)}</nav>}
      {waiting && <Choice key={waiting.permission} waiting={waiting} client={client} projectId={snapshot.project.id} />}
      {talk && <TalkSaid talk={talk} layers={layers} onAgent={onAgent} link={link} fileLink={fileLink} />}
      {node?.level === 'line' && <LineSaid node={node} layers={layers} onSelect={onSelect} onOpenAll={onOpenAll} onAgent={onAgent} link={link} />}
      {node?.level === 'ask' && <section className="graph-said"><p className="graph-question">{node.text}</p>
        <p className="graph-facts">{[node.agent, askEnd(node), took(node) && 'took ' + took(node), plural(node.steps, 'recorded step')].filter(Boolean).join(' · ')}</p>
        {node.answer && <div className="graph-answer"><AgentMarkdown text={node.answer} streaming={node.state === 'running'} /></div>}
        <div className="graph-actions">{!node.terminal && <button onClick={() => onAgent(node.conversationId)}><Icon name="prompt" size={15} />Show the conversation</button>}{node.steps > 0 && <button onClick={() => onOpenAll(node.id)}><Icon name="list" size={15} />Show every step</button>}</div>
        {node.children.length > 0 && <><h3 className="caption">What it did</h3><ol className="graph-relations">{node.children.map(id => link(id, workIcon(work(id)!), work(id)!.title, plural(work(id)!.steps, 'step')))}</ol></>}</section>}
      {node?.level === 'activity' && <section className="graph-said">
        {node.said && <blockquote className="lg-quote">{node.said}<cite>{node.agent ?? 'The Agent'}, before it began</cite></blockquote>}
        <p className="graph-facts">{[plural(node.steps, 'recorded step'), node.edits ? plural(node.edits, 'edit') : '', node.runs ? plural(node.runs, 'run') : '', node.cells ? plural(node.cells, 'cell') : '', node.failed ? node.failed + ' refused, failed or unknown' : '', took(node), clock(node.start, true)].filter(Boolean).join(' · ')}</p>
        <Touched layers={layers} under={node.id} fileLink={fileLink} />
        <h3 className="caption">Its steps, as recorded</h3><ol className="lg-steps">{node.children.map(id => { const s = work(id)!; return <li key={id} data-bad={s.failed > 0 || undefined}><time>{clock(s.end, true)}</time><button className="graph-link" onClick={() => onSelect(id)}><Icon name={stepIcon(s)} size={13} /><span>{s.title}</span></button></li>; })}</ol></section>}
      {node?.level === 'step' && <StepSaid node={node} turns={turns} layers={layers} client={client} snapshot={snapshot} cursor={cursor} fileLink={fileLink} />}
      {claim && <ClaimSaid claim={claim} layers={layers} client={client} snapshot={snapshot} agentOf={agentOf} onAgent={onAgent} onSelect={onSelect} fileLink={fileLink} openPath={path => shell?.openPath?.(path)} />}
      {target.kind === 'file' && <FileSaid path={target.path} line={line} layers={layers} process={process} node={newest(target.path)} holds={holds(target.path)} client={client} snapshot={snapshot} cursor={cursor} placing={placing} onOpen={() => void openFile(target.path)} onSelect={onSelect} onReview={id => shell?.openReview?.(id)} />}
      {problem && <p className="canvas-note" role="alert">{problem}</p>}
    </div>
  </aside>;
}

// The files a piece of work used and made, each with what the record says was done to it.
function Touched({ layers, under, fileLink }: { layers: WorkLayers; under: string; fileLink: (path: string, note?: string) => ReactNode }) {
  const byPath = new Map<string, Map<string, number>>();
  for (const t of layers.touches) if (!isNotes(t.path) && ancestors(layers, t.work).includes(under)) { const verbs = byPath.get(t.path) ?? new Map<string, number>(); verbs.set(t.verb, (verbs.get(t.verb) ?? 0) + 1); byPath.set(t.path, verbs); }
  if (!byPath.size) return null;
  return <><h3 className="caption">Files it touched</h3><ul className="graph-relations">{[...byPath].map(([path, verbs]) => fileLink(path, [...verbs].map(([verb, n]) => verb + (n > 1 ? ' ' + n + '×' : '')).join(' · ')))}</ul></>;
}

function LineSaid({ node, layers, onSelect, onOpenAll, onAgent, link }: { node: WorkNode; layers: WorkLayers; onSelect: (id: string) => void; onOpenAll: (id: string) => void; onAgent: (conversationId?: string) => void; link: (id: string, icon: IconName, text: string, note?: string) => ReactNode }) {
  const claims = layers.claims.filter(c => c.line === node.id), files = lineFiles(layers, node.id), todos = node.section?.statements.filter(s => s.kind === 'todo') ?? [];
  const into = flows(layers).filter(f => f.to === node.id), out = flows(layers).filter(f => f.from === node.id), talks = talksOf(layers, node.id);
  void onSelect;
  return <section className="graph-said">
    {node.said && <p className="graph-question">{node.said}</p>}
    <p className="graph-facts">{[...lineFacts(layers, node), node.agents?.join(', '), todos.length ? `${todos.filter(t => t.done).length} of ${todos.length} to-dos done` : ''].filter(Boolean).join(' · ')}</p>
    <div className="graph-actions">{node.steps > 0 && <button onClick={() => onOpenAll(node.id)}><Icon name="list" size={15} />Show every step</button>}{node.conversations?.find(c => !c.startsWith('terminal:')) && <button onClick={() => onAgent(node.conversations!.find(c => !c.startsWith('terminal:')))}><Icon name="prompt" size={15} />Show the conversation</button>}</div>
    {!node.section && !node.quiet && <p className="muted">The notes have no section for this work, so nothing says what was concluded from it.</p>}
    {claims.length > 0 && <><h3 className="caption">Concluded in the notes</h3><ul className="graph-relations lg-claims">{claims.map(c => link(c.id, c.kind === 'finding' ? 'check' : 'updown', c.text, grounds[c.ground] || undefined))}</ul></>}
    {files.made.length > 0 && <><h3 className="caption">Made</h3><ul className="graph-relations">{files.made.map(f => link(node.id + '|' + f.path, fileIcon(layers.artifacts.get(f.path)?.category ?? null), f.path, f.existing ? 'was here before' : undefined))}</ul></>}
    {into.length > 0 && <><h3 className="caption">Builds on</h3><ul className="graph-relations">{into.map(f => link(f.from, 'workflow', lineName(layers.nodes.get(f.from)!), plural(f.paths.length, 'file')))}</ul></>}
    {out.length > 0 && <><h3 className="caption">Built on by</h3><ul className="graph-relations">{out.map(f => link(f.to, 'workflow', lineName(layers.nodes.get(f.to)!), plural(f.paths.length, 'file')))}</ul></>}
    {talks.length > 1 ? <><h3 className="caption">Conversations</h3><ol className="graph-relations">{talks.map(t => link(talkId(t.id), t.terminal ? 'monitor' : 'chat', t.title, dayOf(t.start) + ' · ' + plural(t.asks.length, t.terminal ? 'command' : 'message')))}</ol></>
      : <><h3 className="caption">{node.terminal ? 'Typed in a terminal' : 'Messages'}</h3><ol className="graph-relations">{node.children.map(id => { const ask = layers.nodes.get(id)!; return link(id, 'question', ask.terminal ? clock(ask.start, true) + ' · ' + ask.title : ask.title, [plural(ask.steps, 'step'), askEnd(ask)].filter(Boolean).join(' · ')); })}</ol></>}
  </section>;
}

// One conversation of a line of work: its messages in order and the files it changed.
function TalkSaid({ talk, layers, onAgent, link, fileLink }: { talk: Talk; layers: WorkLayers; onAgent: (conversationId?: string) => void; link: (id: string, icon: IconName, text: string, note?: string) => ReactNode; fileLink: (path: string, note?: string) => ReactNode }) {
  const mine = new Set(talk.asks.map(a => a.id)), changed = new Map<string, number>();
  for (const t of layers.touches) if (t.makes && !isNotes(t.path) && ancestors(layers, t.work).some(id => mine.has(id))) changed.set(t.path, (changed.get(t.path) ?? 0) + 1);
  return <section className="graph-said">
    <p className="graph-facts">{[talk.agent, daysOf(talk.start, talk.end), plural(talk.asks.length, talk.terminal ? 'command' : 'message'), plural(talk.steps, 'recorded step'), talk.failed ? talk.failed + ' refused, failed or unknown' : '', changed.size ? plural(changed.size, 'file') + ' changed' : '', talk.running ? 'working now' : ''].filter(Boolean).join(' · ')}</p>
    {!talk.terminal && <div className="graph-actions"><button onClick={() => onAgent(talk.id)}><Icon name="prompt" size={15} />Show the conversation</button></div>}
    <h3 className="caption">{talk.terminal ? 'Typed in a terminal' : 'Messages'}</h3><ol className="graph-relations lg-asks">{talk.asks.map(ask => link(ask.id, 'question', ask.title, [clock(ask.start), plural(ask.steps, 'step'), askEnd(ask)].filter(Boolean).join(' · ')))}</ol>
    {changed.size > 0 && <><h3 className="caption">Files it changed</h3><ul className="graph-relations">{[...changed].map(([path, n]) => fileLink(path, n > 1 ? n + '×' : undefined))}</ul></>}
  </section>;
}

// One step as the record kept it: what the Agent called, with what, how it ended and what it printed.
function StepSaid({ node, turns, layers, client, snapshot, cursor, fileLink }: { node: WorkNode; turns: GraphTurn[]; layers: WorkLayers; client: BrowserClient; snapshot: WorkspaceSnapshot; cursor: number | null; fileLink: (path: string, note?: string) => ReactNode }) {
  const step = node.record!, run = node.run, touched = layers.touches.filter(t => t.work === node.id);
  // The version of a file kept right after this step, when the record kept one.
  const evidence = turns.find(t => t.conversationId + '/' + t.turn.id === node.turn)?.turn.evidence;
  const kept = step.id ? evidence?.records.filter(r => r.phase.split(':')[1] === step.id).flatMap(r => r.snapshots.map(s => ({ path: r.path, ...s }))).filter(s => cursor === null || Date.parse(s.observedAt) <= cursor) ?? [] : [];
  const output = run?.output ?? (step.output ? { text: step.output.text, lines: step.output.lines, cut: step.output.cut } : undefined);
  const terminal = step.terminal;
  const facts = [node.action === 'say' ? node.agent ?? 'The Agent' : terminal ? 'Terminal' : step.tool, terminal ? (terminal.cwd ? 'in ' + terminal.cwd + '/' : 'in the project folder') : '', step.operation, node.outcome && node.outcome !== 'said' ? (run?.end ?? outcomes[node.outcome] ?? node.outcome) : '', run?.durationMs ? 'took ' + durationText(run.durationMs) : '', clock(node.end, true)].filter(Boolean).join(' · ');
  return <section className="graph-said">
    {node.said && <p className="lg-purpose">{node.said}</p>}
    {node.action === 'say' || node.action === 'error' ? <div className="graph-answer"><AgentMarkdown text={step.text ?? ''} streaming={false} /></div>
      : run ? <pre className="graph-command" title={run.ran}>{run.command}</pre>
      : step.detail ? <pre className="graph-command">{step.detail}</pre> : null}
    <p className="graph-facts">{facts}</p>
    {run?.ran && run.ran !== run.command && <p className="graph-facts">As run: <code>{run.ran}</code></p>}
    {terminal ? <><h3 className="caption">Printed</h3><div className="graph-terminal-output"><TerminalOutput client={client} projectId={snapshot.project.id}
        command={{ commandId: terminal.commandId, output: step.output?.text ?? '', outputBytes: step.output?.bytes ?? 0, stored: terminal.stored, screens: terminal.screens, state: node.outcome === 'requested' ? 'running' : 'exited', problem: terminal.problem }} /></div></>
      : output && <><h3 className="caption">{output.text ? output.cut ? `Printed · last ${output.text.split('\n').length} of ${output.lines} lines` : 'Printed' : 'Printed nothing'}</h3>{output.text && <pre className="graph-output" ref={atEnd}>{output.text}</pre>}</>}
    {touched.length > 0 && <><h3 className="caption">Files in this step</h3><ul className="graph-relations">{[...new Set(touched.map(t => t.path))].map(path => fileLink(path, touched.filter(t => t.path === path).map(t => t.verb).join(' · ')))}</ul></>}
    {kept.map(s => <div key={s.path + s.resource.version} className="lg-kept"><h3 className="caption">{s.path} as kept after this step</h3><Snapshot client={client} projectId={snapshot.project.id} resource={s.resource} path={s.path} /></div>)}
    {node.action !== 'say' && node.action !== 'error' && !run && !step.detail && !output && !kept.length && <p className="muted">The record keeps no more of this step than that it happened and how it ended.</p>}
  </section>;
}

// A statement of the notes with the record behind it: the files it names as the versions kept
// then, the steps that made them, and the step that wrote the statement.
function ClaimSaid({ claim, layers, client, snapshot, agentOf, onAgent, onSelect, fileLink, openPath }: { claim: Claim; layers: WorkLayers; client: BrowserClient; snapshot: WorkspaceSnapshot; agentOf: (conversationId: string) => string | undefined;
  onAgent: (conversationId?: string) => void; onSelect: (id: string) => void; fileLink: (path: string, note?: string) => ReactNode; openPath: (path: string) => void }) {
  const behind = useMemo(() => support(layers, claim.paths), [layers, claim]);
  const steps = [...behind.work].map(id => layers.nodes.get(id)).filter((n): n is WorkNode => !!n).sort((a, b) => a.start - b.start);
  const parts = [...new Set(steps.map(s => s.level === 'step' ? s.parent! : s.id))].map(id => layers.nodes.get(id)!);
  const written = claim.trace?.written, line = layers.nodes.get(claim.line);
  return <section className="graph-said meaning-said">
    {claim.kind === 'choice' ? <ChoiceOptions statement={claim.statement} trace={claim.trace} conversationId={line?.section?.conversationId ?? null} client={client} projectId={snapshot.project.id} onPath={openPath} onSent={id => onAgent(id)} />
      : <p className="meaning-statement">{claim.text}</p>}
    <div className="meaning-trace">
      <h3 className="caption">Rests on</h3>
      {claim.paths.length ? <ul className="graph-relations">{claim.paths.map(path => { const f = claim.trace?.files.find(x => x.path === path); return fileLink(path, f ? (f.kept ? 'version kept ' + clock(f.kept.at) : 'no version kept') + (f.later === 'kept' ? ' · a newer version was kept since' : f.later === 'written' ? ' · written again since' : '') : undefined); })}</ul>
        : <p className="graph-facts">It names no file, so nothing in the record can be tied to it.</p>}
    </div>
    {claim.paths.length > 0 && <div className="meaning-trace">
      <h3 className="caption">The recorded work behind it</h3>
      {steps.length ? <><p className="graph-facts">{plural(steps.length, 'recorded step')} in {plural(parts.length, 'activity', 'activities')} made {behind.paths.size === 1 ? 'this file' : 'these files and what they were made from'}. The record says these steps made the files, not that the statement follows from them.</p>
        <ol className="graph-relations">{parts.map(p => <li key={p.id}><button className="graph-link" onClick={() => onSelect(p.id)}><Icon name={workIcon(p)} size={14} /><span>{p.title}</span></button><small>{plural(steps.filter(s => s.parent === p.id || s.id === p.id).length, 'step')}</small></li>)}</ol></>
        : <p className="graph-facts">No recorded step made {claim.paths.length === 1 ? 'this file' : 'these files'}.</p>}
      {behind.open.filter(p => !claim.paths.includes(p) || steps.length > 0).length > 0 && <p className="graph-facts">Where {behind.open.map(p => p.split('/').at(-1)).join(', ')} came from is not in the record.</p>}
    </div>}
    <div className="meaning-trace">
      <h3 className="caption">Where the statement comes from</h3>
      <p className="graph-facts">{written ? <>Written by {agentOf(written.conversationId) ?? 'the Agent'} at {clock(written.at, true)}, first in version {written.version} of {written.of} of the notes that the Agent's record kept.</>
        : <>No version of the notes that the Agent's record kept holds this. You or another program wrote it, or the record kept no version since.</>}</p>
      <div className="graph-actions">{claim.written && <button onClick={() => onSelect(claim.written!)}><Icon name="graph" size={15} />Show the step that wrote it</button>}
        {!claim.written && line?.section?.conversationId && <button onClick={() => onAgent(line.section!.conversationId!)}><Icon name="prompt" size={15} />Show the conversation</button>}</div>
    </div>
  </section>;
}

// A file: what it holds, the version kept, what happened to it step by step, and what rests on it.
function FileSaid({ path, line, layers, process, node, holds, client, snapshot, cursor, placing, onOpen, onSelect, onReview }: { path: string; line?: WorkNode; layers: WorkLayers; process: Graph; node?: GraphNode; holds?: Holds; client: BrowserClient; snapshot: WorkspaceSnapshot; cursor: number | null; placing: boolean;
  onOpen: () => void; onSelect: (id: string) => void; onReview: (id: string) => void }) {
  void process;
  const shown = node && cursor !== null && (node.capturedAt ?? 0) > cursor ? undefined : node;
  // A review is bound to one kept version of the file; every kept version's reviews are listed.
  const keptVersions = shown?.versions?.map(v => v.resource) ?? (shown?.resource ? [shown.resource] : []), isKept = (r: any) => !!r && keptVersions.some(v => v.id === r.id && v.version === r.version);
  const related = snapshot.annotations.filter((t: any) => isKept(t.anchor?.resource) || t.messages?.some((m: any) => m.resources?.some(isKept)));
  const touches = layers.touches.filter(t => t.path === path), claims = layers.claims.filter(c => c.paths.includes(path));
  const lineOf = (work: string) => ancestors(layers, work).find(id => layers.nodes.get(id)!.level === 'line');
  return <>
    {holds?.text && <p className="meaning-statement">{holds.text}</p>}
    <p className="graph-facts">{shown?.resource ? (shown.versions ? `Newest of ${shown.versions.length} versions kept, ` : 'Version kept ') + new Date(shown.capturedAt!).toLocaleString() + (shown.bytes !== undefined ? ' · ' + size(shown.bytes) : '') : node ? node.gap ?? 'No version of this file was kept.' : 'No recorded step touched this file; the notes name it.'}</p>
    {shown?.resource && <Snapshot client={client} projectId={snapshot.project.id} resource={shown.resource} path={path} />}
    <div className="graph-actions">{node?.exists && <button className="primary" disabled={placing} onClick={onOpen}><Icon name="layout" size={15} />{placing ? 'Opening…' : 'Open current file in workspace'}</button>}</div>
    {related.map((t: any) => <button key={t.annotationId} onClick={() => onReview(t.annotationId)}>Review: {t.messages[0].draft.text.slice(0, 70)}</button>)}
    {node && !node.exists && <p className="muted">This file was not in the project folders when they were last read. It may have been moved or removed.</p>}
    {claims.length > 0 && <section><h3 className="caption">Concluded from it</h3><ul className="graph-relations lg-claims">{claims.map(c => <li key={c.id}><button className="graph-link" onClick={() => onSelect(c.id)}><Icon name={c.kind === 'finding' ? 'check' : 'updown'} size={14} /><span>{c.text}</span></button></li>)}</ul></section>}
    {touches.length > 0 && <section><h3 className="caption">What happened to it</h3><ol className="graph-history">{touches.map((t, i) => { const w = layers.nodes.get(t.work), other = lineOf(t.work); return <li key={i}><time>{clock(t.at)}</time><span>{t.verb}{t.basis === 'observed' ? ' · seen on disk' : t.basis === 'named' ? ' · named in a command' : ''}{other && line && other !== line.id ? ' · in ' + layers.nodes.get(other)!.title : ''}</span>{w && <button className="graph-link" onClick={() => onSelect(w.id)}>{w.title}</button>}</li>; })}</ol></section>}
  </>;
}

// A native permission the Agent waits on, answered where the step it asks about is drawn. The
// same choice as the Agent panel's; the answer goes to the Agent's own permission request.
function Choice({ waiting, client, projectId }: { waiting: NonNullable<GraphNode['waiting']>; client: BrowserClient; projectId: string }) {
  const [sending, setSending] = useState(''), [problem, setProblem] = useState('');
  function choose(optionId: string) {
    setSending(optionId); setProblem('');
    client.call('conversation.permission', { projectId, conversationId: waiting.conversationId, turnId: waiting.turn, permissionId: waiting.permission, optionId })
      .catch(error => { setSending(''); setProblem(error instanceof Error ? error.message : 'The choice could not be sent.'); });
  }
  return <section className="turn-permission graph-choice" role="group" aria-label="Agent permission">
    <p className="permission-caption"><span aria-hidden="true" />Needs your choice</p>
    <p className="permission-title">{waiting.title}</p>
    <div>{waiting.options.map(option => <button key={option.id} className="small-button" disabled={!!sending} onClick={() => choose(option.id)}>{option.name}</button>)}</div>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
  </section>;
}

// The Overview's glance at the same record: the timeline without its controls, and the way to
// the Graph. It reads the conversations as the Graph does, and shows nothing until they are read.
export function WorkStrip({ client, snapshot, files, onOpen, onConversations }: { initialResource?: {id:string;version:string}|null; client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFiles; onOpen: () => void; onConversations: () => void }) {
  const { turns: messages, loading } = useTurns(client, snapshot);
  const turns = useTerminalTurns(client, snapshot, messages);
  const { marks } = useEventMarks(client, snapshot, turns);
  const graph = useMemo(() => buildWorkGraph({ turns, files: files.files.map(f => ({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, category: f.category })), project: snapshot.project, kindOf, now: Date.now() }),
    [turns, files.files, snapshot.project]);
  if (loading || (!graph.events.length && !marks.length)) return null;
  const files_ = graph.nodes.filter(n => n.kind === 'file' && n.events.some(e => e.action === 'edit' || e.action === 'write' || e.action === 'changed')).length;
  const last = Math.max(graph.events.at(-1)?.at ?? 0, marks.at(-1)?.at ?? 0), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(last).setHours(0, 0, 0, 0)) / 864e5);
  const lastWords = (days === 0 ? 'today' : days === 1 ? 'yesterday' : new Date(last).toLocaleDateString()) + ' at ' + clock(last);
  const conversations = new Set(turns.filter(t => !t.terminal).map(t => t.conversationId)).size, yours = marks.some(m => m.who === 'person') || turns.some(t => t.terminal && t.turn.by === personPrincipal);
  const title = !graph.events.length ? 'What you did' : yours ? 'What you and the Agent did' : 'What the Agent did';
  return <section className="project-section work-strip" aria-labelledby="work-strip-title">
    {/* Questions and commands are counted by the kinds under the heading; the line keeps the rest. */}
    <div className="section-heading"><div><h2 id="work-strip-title">{title}</h2>
      <p className="work-strip-line">{conversations > 0 && <><button className="text-button" onClick={onConversations}>{conversations} {conversations === 1 ? 'conversation' : 'conversations'}</button> · {files_} {files_ === 1 ? 'file' : 'files'} changed · </>}last {lastWords}</p></div>
      {graph.events.length > 0 && <button className="text-button" onClick={onOpen}>Open the Graph <Icon name="chevron" size={12} /></button>}</div>
    <Timeline graph={graph} marks={marks} cursor={null} playing={false} running={false} speed={1} onSpeed={() => undefined} onCursor={() => undefined} onPlay={() => undefined} compact />
  </section>;
}
