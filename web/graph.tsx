import { useContext } from 'react';
import { ShellContext } from './shell-services.js';
import { Snapshot } from './snapshot.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { buildWorkGraph, foldVersions, laneLayout, lineage, type GraphEdge, type GraphEvent, type GraphNode, type GraphTurn, type LaneItem, type LaneLink, type WorkGraph as Graph } from '../src/work-graph.js';
import { durationText } from '../src/conversation-presentation.js';
import { agentName, type AgentNow } from './agent-now.js';
import { openInWorkspace, viewFor } from './canvas.js';
import { kindOf, type ProjectFiles } from './sources.js';
import { Icon, type IconName } from './icons.js';
import { BrandMark, brandOf } from './brand-marks.js';
import { size } from './project.js';
import { AgentMarkdown } from './markdown.js';
import { OwnerView } from './shell/owner.js';
import { readPreview, type Preview } from './previews.js';
import { useTurns } from './work-turns.js';
import { clock, failed, kindOfAction, span, timelineKinds, type TimelineKind } from './timeline-kinds.js';
import { layered, type GraphLayer } from '../src/meaning-graph.js';
import { modelName } from '../src/file-describer.js';
import { costText, seen } from './holds.js';
import type { Trace } from '../src/notes-meaning.js';
import { useMeaning } from './meaning.js';
import { ChoiceOptions } from './choices.js';
import './graph.css';

// The project as a graph of what the Agent did: the questions people asked, the files each
// message read and changed, the commands it ran and what changed on disk while they ran.
// It is drawn from the conversation records and one walk of the folders; nothing here starts
// work, and a file is shown as it is now. The person and the Agent share one workspace; the
// graph is a way into it, not a second one.

const kindLabel = (node: GraphNode) => node.kind === 'question' ? 'Question' : node.kind === 'run' ? 'Run' : node.kind === 'finding' ? 'Finding' : node.kind === 'choice' ? 'Choice'
  : ({ data: 'Data', code: 'Script', results: 'Result', figures: 'Figure', notes: 'Note' } as Record<string, string>)[node.category ?? ''] ?? 'File';
const kindIcon = (node: GraphNode): IconName => node.kind === 'question' ? 'question' : node.kind === 'run' ? 'run' : node.kind === 'finding' ? 'check' : node.kind === 'choice' ? 'updown'
  : node.category === 'figures' ? 'image' : node.category === 'code' ? 'code' : node.category === 'notes' ? 'document' : node.category ? 'table' : 'file';
const tone = (node: GraphNode) => node.kind !== 'file' ? node.kind : node.category ?? 'other';
const hasPreview = (node: GraphNode) => node.kind === 'file' && !!node.resource && (/\.(png|jpe?g|svg)$/i.test(node.path!) || /\.csv$/i.test(node.path!));
const sizeOf = (node: GraphNode, proxy: boolean) => proxy ? { width: 228, height: 58 }
  // The meaning layer's cards carry a statement or a description and where it came from.
  : node.meaning ? { width: node.kind === 'file' ? 256 : 300, height: node.kind === 'question' ? 138 : node.kind === 'finding' || node.kind === 'choice' ? 124 : (hasPreview(node) ? (/\.csv$/i.test(node.path!) ? 226 : 212) : 128) }
  : { width: node.kind === 'question' ? 300 : node.kind === 'run' ? 236 : 256, height: node.kind === 'question' ? (node.answer ? 160 : 116) : node.kind === 'run' ? 88 : hasPreview(node) ? (/\.csv$/i.test(node.path!) ? 198 : 184) : 96 };
// Who wrote a statement of the notes, as far as the Agent's record says: the Agent of the message
// whose kept version of the notes first holds it, or nobody it recorded.
const writtenBy = (trace: Trace | undefined, agentOf: (conversationId: string) => string | undefined) => trace?.written ? (agentOf(trace.written.conversationId) ?? 'The Agent') + ' · ' + clock(trace.written.at) : 'Not in the Agent\'s record';
const layerNames: Record<GraphLayer, string> = { both: 'Meaning + process', meaning: 'Meaning', process: 'Process' };
type Layout = ReturnType<typeof laneLayout>;
// The Agent's answer in a sentence or two, as plain text, for the question's card.
const gist = (markdown?: string) => markdown ? markdown.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|]+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 220) : '';
const verbs: Record<string, string> = { read: 'Read', edit: 'Edited', write: 'Wrote', changed: 'Changed', capture: 'Kept', run: 'Ran', ask: 'Asked', answer: 'Answered' };
// A card's one line about what happened to it, newest last: "Read · Edited 2×".
function happened(node: GraphNode) {
  const counts = new Map<string, number>();
  for (const e of node.events) if (e.action !== 'ask' && e.action !== 'answer' && !(e.action === 'capture' && node.versions)) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  return [...counts].map(([action, n]) => (verbs[action] ?? action) + (n > 1 ? ' ' + n + '×' : '')).join(' · ');
}
const ended: Record<string, string> = { completed: 'Answered', failed: 'Failed', stopped: 'Stopped', running: 'Working', unknown: 'Outcome unknown' };
// A command's output opens at its end, where its result or error is.
const atEnd = (element: HTMLElement | null) => { if (element) element.scrollTop = element.scrollHeight; };
const outcomes: Record<string, string> = { returned: 'Returned', requested: 'Running', failed: 'Failed', rejected: 'Refused', unknown: 'Outcome unknown' };

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
  if (preview.kind === 'table') return <span className="graph-preview table">
    <span className="graph-table" style={{ gridTemplateColumns: `repeat(${preview.columns.length}, minmax(0, 1fr))` }}>
      {preview.columns.map(c => <span key={'h' + c} className="graph-cell head">{c}</span>)}
      {preview.rows.map((row, i) => preview.columns.map(c => <span key={i + c} className="graph-cell">{row[c] === null || row[c] === undefined ? '' : String(row[c])}</span>))}
    </span>
    <small>{preview.total.toLocaleString()} {preview.total === 1 ? 'row' : 'rows'} × {preview.width} {preview.width === 1 ? 'column' : 'columns'}</small>
  </span>;
  return <span className="graph-preview none">{preview.note}</span>;
}

interface View { x: number; y: number; k: number }
const zoomLimits = { min: 0.2, max: 2 };
// Below this zoom a card's text is too small to read; the graph opens no smaller than this.
const readable = 0.78;

export function WorkGraph({ initialResource, client, snapshot, files, agentNow, following, principalId, notesText = '', onFollow, onStopFollowing, onStudio, workspace, onAbout, onAgent }: {
  initialResource?: {id:string;version:string}|null; client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFiles; agentNow: AgentNow | null; following: boolean; principalId?: string;
  // The project notes as they stand, the source of the meaning layer.
  notesText?: string;
  onFollow: () => void; onStopFollowing: () => void; onStudio: (compositionId: string, viewId?: string) => void; workspace: () => string;
  onAbout: (pluginId: string) => void; onAgent: (conversationId?: string) => void;
}) {
  const { turns, problem, loading, omitted } = useTurns(client, snapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!agentNow?.running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [agentNow?.running]);
  const graphFiles = useMemo(() => files.files.map(f => ({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, category: f.category })), [files.files]);
  const process = useMemo(() => foldVersions(buildWorkGraph({ turns, files: graphFiles, project: snapshot.project, kindOf, now: agentNow?.running ? now : Date.now() })),
    [turns, graphFiles, snapshot.project, agentNow?.running ? now : 0]);
  // The meaning layer from the project notes, above the process layer by default; either can be
  // shown alone. The choice is remembered in this browser.
  const meaning = useMeaning(client, snapshot, process, graphFiles, notesText, turns);
  const hasMeaning = meaning.layer.nodes.length > 0;
  const [layer, setLayer] = useState<GraphLayer>(() => { try { const v = localStorage.getItem('rho.graph.layer.v1'); return v === 'meaning' || v === 'process' ? v : 'both'; } catch { return 'both'; } });
  function showLayer(next: GraphLayer) { fitted.current = false; setLayer(next); try { localStorage.setItem('rho.graph.layer.v1', next); } catch { /* this page only */ } }
  const graph = useMemo(() => layered(process, hasMeaning ? meaning.layer : null, layer), [process, meaning.layer, hasMeaning, layer]);
  const meaningRows = new Set(hasMeaning && layer !== 'process' ? meaning.layer.turns.map(t => t.id) : []);
  const agentOf = (conversationId: string) => process.turns.find(t => t.conversationId === conversationId)?.agent;
  const shape = graph.nodes.map(n => n.id + (hasPreview(n) ? '+' : '') + (n.answer ? 'a' : '') + (n.meaning?.description ? 'd' : '')).join('|') + '#' + graph.edges.map(e => e.id + '@' + e.turn).join('|');
  const layout = useMemo(() => laneLayout(graph, sizeOf, { x: 108, y: 26, lane: 64 }), [shape]);
  const byId = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph]);
  const items = useMemo(() => new Map(layout.items.map(i => [i.id, i])), [layout]);
  // Where the Agent is: in the row of the message it is answering, a reference there if the
  // file it touches lives in an earlier row.
  const liveTurn = graph.turns.find(t => t.running)?.id;
  const liveRow = liveTurn ? layout.rows.find(r => r.turn === liveTurn)?.lane : undefined;
  const liveItem = (id?: string | null) => !id ? null : layout.items.find(i => i.node === id && i.lane === liveRow)?.id ?? id;

  // Selecting a node shows the path it came by and what it fed; everything else steps back.
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(()=>{if(initialResource){const node=graph.nodes.find(n=>(n.versions??(n.resource?[{resource:n.resource}]:[])).some(v=>v.resource.id===initialResource.id&&v.resource.version===initialResource.version));if(node)setSelected(node.id);}},[initialResource?.id,initialResource?.version,shape]);
  const focus = useMemo(() => selected && byId.has(selected) ? lineage(graph, selected) : null, [selected, graph]);
  const [query, setQuery] = useState('');
  const matches = useMemo(() => { const q = query.trim().toLowerCase(); return q ? new Set(graph.nodes.filter(n => (n.title + ' ' + (n.path ?? '') + ' ' + (n.text ?? '') + ' ' + (n.command ?? '')).toLowerCase().includes(q)).map(n => n.id)) : null; }, [query, graph]);

  // Replay: the graph as it stood at a moment of the work. Null is now.
  const [cursor, setCursor] = useState<number | null>(null), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const times = graph.events.map(e => e.at);
  useEffect(() => {
    if (!playing) return;
    const events = graph.events, index = cursor === null ? 0 : events.findIndex(e => e.at > cursor);
    if (index < 0 || index >= events.length) { setPlaying(false); setCursor(null); return; }
    const pace = Math.min(600, Math.max(140, 9000 / Math.max(1, events.length))) / speed;
    const timer = setTimeout(() => setCursor(events[index].at), cursor === null ? 0 : pace);
    return () => clearTimeout(timer);
  }, [playing, cursor, graph.events, speed]);
  const current = cursor === null ? null : [...graph.events].reverse().find(e => e.at <= cursor) ?? null;

  // Nodes that appear while the person watches arrive with a short mark.
  const known = useRef<Set<string> | null>(null), [arrived, setArrived] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(graph.nodes.map(n => n.id));
    if (known.current) {
      const fresh = [...ids].filter(id => !known.current!.has(id));
      if (fresh.length) { setArrived(new Set(fresh)); const timer = setTimeout(() => setArrived(new Set()), 1600); known.current = ids; return () => clearTimeout(timer); }
    }
    known.current = ids;
  }, [graph.nodes]);

  // Pan and zoom: dragging the background or scrolling moves; pinching or ⌘/Ctrl-scrolling zooms.
  const canvas = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 }), [gliding, setGliding] = useState(false);
  const viewNow = useRef(view); viewNow.current = view;
  const fitted = useRef(false), touched = useRef(false);
  // Until the person moves or selects something, a graph whose rows change opens fitted again:
  // the meaning rows and later messages arrive after the first drawing.
  const glide = (next: View) => { setGliding(true); setView(next); setTimeout(() => setGliding(false), 380); };
  const fit = useCallback((animate = true) => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box || !layout.width) return;
    const k = Math.max(zoomLimits.min, Math.min(1, (box.width - 96) / layout.width, (box.height - 120) / layout.height));
    const next = { k, x: (box.width - layout.width * k) / 2, y: Math.max(56, (box.height - layout.height * k) / 2) };
    if (animate) glide(next); else setView(next);
  }, [layout]);
  // The page opens on the whole graph when it can be read whole; otherwise on the newest
  // question at a readable size, with the map showing the rest.
  const rowsKey = layout.rows.map(r => r.turn).join(','), lastRows = useRef(rowsKey);
  // With a meaning row, any new layout opens on its question again; otherwise only new rows do.
  useLayoutEffect(() => {
    const moved = rowsKey !== lastRows.current || layout.rows.some(r => r.turn.startsWith('m:'));
    lastRows.current = rowsKey;
    if (!touched.current && !following && moved) fitted.current = false;
  }, [layout]);
  useEffect(() => { if (selected) touched.current = true; }, [selected]);
  useLayoutEffect(() => {
    if (fitted.current || !graph.nodes.length) return;
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    fitted.current = true;
    const whole = Math.min(1, (box.width - 96) / layout.width, (box.height - 120) / layout.height);
    const meaningRow = layout.rows.filter(r => r.turn.startsWith('m:')).at(-1), row = meaningRow ?? layout.rows.at(-1);
    if (whole >= readable || !row) { fit(false); return; }
    // Too large to read whole: the newest meaning row from its top, else the newest message's
    // row from its start; the map shows the rest.
    const k = readable, fitsTall = layout.height * k <= box.height - 120;
    const asked = meaningRow && layout.placed.get('q:' + meaningRow.turn);
    if (asked) {
      // The question at the left, a third of the way down, clear of the map; what it led to follows.
      setView({ k, x: 32 - asked.x * k, y: box.height * 0.35 - (asked.y + asked.height / 2) * k });
      return;
    }
    setView({ k, x: 32, y: fitsTall ? (box.height - layout.height * k) / 2 : Math.min(48, box.height - 40 - (row.y + row.height) * k) });
  }, [graph.nodes.length, fit, layout]);
  const center = (id: string, animate = true, zoom?: number) => {
    const p = layout.placed.get(id), box = canvas.current?.getBoundingClientRect();
    if (!p || !box) return;
    const k = zoom ?? Math.max(viewNow.current.k, readable);
    const next = { k, x: box.width / 2 - (p.x + p.width / 2) * k, y: box.height / 2 - (p.y + p.height / 2) * k };
    if (animate) glide(next); else setView(next);
  };
  // Following keeps the node the Agent is on in view.
  useEffect(() => {
    if (!following || !graph.live || cursor !== null) return;
    const id = liveItem(graph.live.node)!, p = layout.placed.get(id), box = canvas.current?.getBoundingClientRect(), v = viewNow.current;
    if (!p || !box) return;
    const left = p.x * v.k + v.x, top = p.y * v.k + v.y;
    if (left < 24 || top < 64 || left + p.width * v.k > box.width - 24 || top + p.height * v.k > box.height - 24) center(id);
  }, [following, graph.live?.node, layout]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      event.preventDefault(); touched.current = true;
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
  const dragged = useRef(false);
  function pan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.graph-node, .graph-zoom, .graph-overlay, .graph-legend')) return;
    const start = { x: event.clientX, y: event.clientY, view: viewNow.current }, element = event.currentTarget; touched.current = true;
    element.setPointerCapture(event.pointerId); dragged.current = false;
    const move = (e: PointerEvent) => {
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) { dragged.current = true; element.dataset.panning = ''; }
      setView({ ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y });
    };
    const stop = () => {
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); delete element.dataset.panning;
      if (!dragged.current) setSelected(null); else if (following) onStopFollowing();
    };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  const zoomBy = (factor: number) => {
    touched.current = true;
    const box = canvas.current?.getBoundingClientRect(), v = viewNow.current;
    if (!box) return;
    const k = Math.min(zoomLimits.max, Math.max(zoomLimits.min, v.k * factor)), px = box.width / 2, py = box.height / 2;
    glide({ k, x: px - (px - v.x) * k / v.k, y: py - (py - v.y) * k / v.k });
  };
  function choose(id: string | null, move = false) { setSelected(id); if (id && move) center(id); }
  // Following a statement or a file into the process layer: shown beside the meaning, then centred
  // once the layout has it.
  const [tracing, setTracing] = useState<string | null>(null);
  function trace(id: string) { if (layer === 'meaning') showLayer('both'); setSelected(id); setTracing(id); }
  useEffect(() => { if (tracing && layout.placed.has(tracing)) { center(tracing); setTracing(null); } }, [tracing, layout]);
  // Arrow keys walk the graph: along its edges left and right, within a column up and down.
  function walk(event: ReactKeyboardEvent<HTMLDivElement>) {
    const from = (document.activeElement as HTMLElement | null)?.dataset.node;
    if (event.key === 'Escape') { if (selected) { event.preventDefault(); setSelected(null); } return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.2); return; }
    if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); return; }
    if (event.key === '0') { event.preventDefault(); fit(); return; }
    if (!from || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const here = layout.placed.get(from)!;
    let to: string | undefined;
    if (event.key === 'ArrowRight') to = layout.links.filter(l => l.from === from).map(l => l.to).sort((a, b) => layout.placed.get(a)!.y - layout.placed.get(b)!.y)[0];
    else if (event.key === 'ArrowLeft') to = layout.links.filter(l => l.to === from).map(l => l.from).sort((a, b) => layout.placed.get(a)!.y - layout.placed.get(b)!.y)[0];
    else {
      const column = [...layout.placed].filter(([, p]) => Math.abs(p.x + p.width / 2 - here.x - here.width / 2) < 4).sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
      to = column[column.indexOf(from) + (event.key === 'ArrowDown' ? 1 : -1)];
    }
    if (!to) return;
    event.preventDefault();
    canvas.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(to)}"]`)?.focus();
    const p = layout.placed.get(to)!, box = canvas.current!.getBoundingClientRect(), v = viewNow.current;
    if (p.x * v.k + v.x < 0 || p.y * v.k + v.y < 48 || (p.x + p.width) * v.k + v.x > box.width || (p.y + p.height) * v.k + v.y > box.height) center(to);
  }

  const near = view.k >= 0.62;
  const shown = (id: string) => cursor === null || (byId.get(id)?.at ?? 0) <= cursor;
  const edgeShown = (e: GraphEdge) => cursor === null || e.at <= cursor;
  const proxyShown = (item: LaneItem) => cursor === null || layout.links.some(l => (l.from === item.id || l.to === item.id) && l.edge.at <= cursor);
  const dim = (id: string) => (focus && !focus.nodes.has(id)) || (matches && !matches.has(id));
  const selectedNode = selected ? byId.get(selected) : undefined;
  const live = cursor === null && agentNow?.running ? graph.live : null;
  const counts = { questions: process.nodes.filter(n => n.kind === 'question').length, files: process.nodes.filter(n => n.kind === 'file').length, runs: process.nodes.filter(n => n.kind === 'run').reduce((sum, n) => sum + (n.commands?.length ?? 1), 0),
    findings: meaning.layer.nodes.filter(n => n.kind === 'finding').length, choices: meaning.layer.nodes.filter(n => n.kind === 'choice').length };

  if (!snapshot.conversations?.length) return <section className="graph-page"><GraphHead counts={null} /><div className="studio-empty"><span className="empty-symbol"><Icon name="graph" size={26} stroke={1.5} /></span><h2>Nothing to draw yet</h2>
    <p>When you ask the Agent something here, the files it reads, the scripts it changes and runs, and what they produce are drawn as one graph.</p>
    <div className="empty-actions"><button className="primary" onClick={() => onAgent()}><Icon name="prompt" size={17} stroke={1.6} /><span>Ask Agent</span></button></div></div></section>;
  return <section className="graph-page" aria-labelledby="graph-title">
    <GraphHead counts={counts} omitted={omitted + graph.omittedTurns}>
      {hasMeaning && <div className="graph-layers" role="group" aria-label="Layers">{(['both', 'meaning', 'process'] as GraphLayer[]).map(l => <button key={l} aria-pressed={layer === l} onClick={() => showLayer(l)}>{layerNames[l]}</button>)}</div>}
      <label className="graph-search"><Icon name="search" size={15} /><input type="search" placeholder="Find in this graph" aria-label="Find in this graph" value={query} onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && matches?.size) { const first = graph.nodes.find(n => matches.has(n.id)); if (first) choose(first.id, true); } }} />{matches && <small>{matches.size}</small>}</label>
      {live?.waiting && <button className="graph-waiting" onClick={() => choose(live.node, true)}><span className="pulse-dot" aria-hidden="true" />Needs your choice</button>}
      {agentNow?.running && <button className={'follow-toggle' + (following ? ' on' : '')} aria-pressed={following} title={following ? 'The graph keeps the Agent in view as it works.' : 'Keep the Agent in view as it works.'} onClick={following ? onStopFollowing : onFollow}>
        {following ? <><span className="pulse-dot" aria-hidden="true" />Following {agentNow.agent}</> : <><Icon name="follow" size={15} />Follow {agentNow.agent}</>}</button>}
    </GraphHead>
    {initialResource && !loading && !graph.nodes.some(n=>n.resource?.id===initialResource.id&&n.resource.version===initialResource.version) && <p className="canvas-note">The selected result version is outside this retained Graph window. Its review still holds the exact reference.</p>}
    {!!graph.omittedNodes && <p className="canvas-note">{graph.omittedNodes} nodes are outside the drawing budget. This is a partial view of the retained work.</p>}
    {problem && <p className="inline-error graph-problem" role="alert">{problem}</p>}
    <div className="graph-body">
      <div ref={canvas} className={'graph-canvas' + (focus ? ' focusing' : '') + (cursor !== null ? ' replaying' : '')} tabIndex={-1} onPointerDown={pan} onKeyDown={walk}>
        {loading ? <div className="loading-state" role="status"><span className="loading-dot" /><span>Reading what the Agent did…</span></div> : <>
          <div className={'graph-world' + (gliding ? ' gliding' : '')} data-zoom={near ? 'near' : 'far'} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: layout.width, height: layout.height, '--k': view.k } as CSSProperties}>
            <Edges layout={layout} focus={focus} shown={edgeShown} labels={near || !!focus} dim={dim} live={liveItem(live?.node)} />
            {[...layout.items].sort((a, b) => a.lane - b.lane || layout.placed.get(a.id)!.column - layout.placed.get(b.id)!.column || layout.placed.get(a.id)!.y - layout.placed.get(b.id)!.y).map(item => {
              const p = layout.placed.get(item.id)!, node = byId.get(item.node)!, flag = liveItem(live?.node) === item.id ? (agentNow?.agent ?? 'Agent') + ' · ' + live!.label : null;
              const homeRow = layout.rows.find(r => r.lane === items.get(item.node)!.lane);
              if (item.proxy) return <Reference key={item.id} item={item} node={node} place={p} home={!homeRow || meaningRows.has(homeRow.turn) ? 'the notes' : 'message ' + (layout.rows.filter(r => !meaningRows.has(r.turn)).indexOf(homeRow) + 1)}
                dimmed={!!dim(item.node)} later={!proxyShown(item)} selected={selected === item.node} live={flag} onSelect={() => choose(item.node, true)} />;
              if (node.meaning) return <MeaningCard key={item.id} node={node} place={p} client={client} snapshot={snapshot} near={near} agentOf={agentOf}
                selected={selected === node.id} dimmed={!!dim(node.id)} later={!shown(node.id)} arrived={arrived.has(node.id)} onSelect={() => choose(selected === node.id ? null : node.id)} onOpen={() => choose(node.id, true)} />;
              return <Card key={item.id} node={node} place={p} client={client} snapshot={snapshot} near={near}
                selected={selected === node.id} dimmed={!!dim(node.id)} later={!shown(node.id) || cursor !== null && (node.capturedAt ?? 0) > cursor} current={current?.node === node.id} arrived={arrived.has(node.id)}
                live={flag} onSelect={() => choose(selected === node.id ? null : node.id)} onOpen={() => choose(node.id, true)} />;
            })}
          </div>
          {focus && selectedNode && <div className="graph-overlay"><span><strong>{focus.nodes.size}</strong> of {graph.nodes.length} · the path to and from <strong>{selectedNode.title}</strong></span><button className="small-button" onClick={() => setSelected(null)}>Show everything</button></div>}
          {current && <div className="graph-caption" role="status" aria-live="polite"><time>{clock(current.at, true)}</time><span>{caption(current, byId)}</span></div>}
          <MiniMap byId={byId} layout={layout} view={view} canvas={canvas} dim={dim} live={liveItem(live?.node)} onMove={setView} />
          <div className="graph-zoom" role="group" aria-label="Zoom">
            <button className="icon-button" aria-label="Fit the graph" title="Fit (0)" onClick={() => fit()}><Icon name="fit" size={16} /></button>
            <button className="icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / 1.2)}><Icon name="minus" size={16} /></button>
            <span className="graph-zoom-value" aria-live="polite">{Math.round(view.k * 100)}%</span>
            <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.2)}><Icon name="plus" size={16} /></button>
          </div>
          <div className="graph-legend" aria-label="What the lines mean">
            <span><i className="line reported" />The Agent reported it</span>
            <span><i className="line named" />Named in a command</span>
            <span><i className="line observed" />Seen changing on disk</span>
            {hasMeaning && layer !== 'process' && <span><i className="line declared" />Written in the notes</span>}
          </div>
        </>}
      </div>
      {selectedNode && <Inspector key={selectedNode.id} node={cursor !== null && (selectedNode.capturedAt ?? 0) > cursor ? { ...selectedNode, resource: undefined, gap: 'This snapshot was captured after the selected replay time.' } : selectedNode} graph={graph} byId={byId} client={client} snapshot={snapshot} principalId={principalId} workspace={workspace}
        onStudio={onStudio} onAbout={onAbout} onAgent={onAgent} onSelect={id => choose(id, true)} onTrace={trace} agentOf={agentOf} process={process} traces={meaning.layer.traces} onClose={() => setSelected(null)} />}
    </div>
    {graph.events.length > 0 && <Timeline graph={graph} cursor={cursor} playing={playing} running={!!agentNow?.running} speed={speed} onSpeed={setSpeed}
      onCursor={at => { setPlaying(false); setCursor(at); }} onPlay={() => { if (playing) setPlaying(false); else { if (cursor !== null && cursor >= times.at(-1)!) setCursor(null); setPlaying(true); } }} />}
  </section>;
}

// The whole graph in small, with the part on screen outlined. Shown when the graph does not
// fit; pressing or dragging on it moves there.
function MiniMap({ byId, layout, view, canvas, dim, live, onMove }: { byId: Map<string, GraphNode>; layout: Layout; view: View; canvas: { current: HTMLDivElement | null }; dim: (id: string) => boolean | null; live: string | null; onMove: (view: View) => void }) {
  const box = canvas.current?.getBoundingClientRect();
  if (!box || !layout.width) return null;
  const inside = layout.width * view.k <= box.width && layout.height * view.k <= box.height && view.x >= 0 && view.y >= 0 && view.x + layout.width * view.k <= box.width && view.y + layout.height * view.k <= box.height;
  if (inside) return null;
  const width = 188, height = Math.max(64, Math.min(120, width * layout.height / layout.width)), scale = Math.min((width - 12) / layout.width, (height - 12) / layout.height);
  const ox = (width - layout.width * scale) / 2, oy = (height - layout.height * scale) / 2;
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
  return <div className="graph-map" aria-hidden="true">
    <svg width={width} height={height} onPointerDown={move}>
      {layout.items.map(i => { const p = layout.placed.get(i.id)!, n = byId.get(i.node)!; return <rect key={i.id} className={'tone-' + tone(n) + (dim(n.id) || i.proxy ? ' off' : '') + (live === i.id ? ' live' : '')} x={ox + p.x * scale} y={oy + p.y * scale} width={Math.max(2, p.width * scale)} height={Math.max(2, p.height * scale)} rx={1.5} />; })}
      <rect className="graph-map-frame" x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx={3} />
    </svg>
  </div>;
}

function GraphHead({ counts, omitted = 0, children }: { counts: { questions: number; files: number; runs: number; findings?: number; choices?: number } | null; omitted?: number; children?: ReactNode }) {
  const words = counts ? [counts.questions + (counts.questions === 1 ? ' question' : ' questions'), counts.files + (counts.files === 1 ? ' file' : ' files'), counts.runs + (counts.runs === 1 ? ' run' : ' runs')].join(' · ') : '';
  const said = counts && (counts.findings || counts.choices) ? [counts.findings ? counts.findings + (counts.findings === 1 ? ' finding' : ' findings') : '', counts.choices ? counts.choices + (counts.choices === 1 ? ' choice' : ' choices') : ''].filter(Boolean).join(' and ') : '';
  return <header className="graph-head">
    <div className="graph-heading"><h1 id="graph-title">Graph</h1><p>{counts ? `What the Agent did: ${words}.` : 'What the Agent did, drawn as one graph.'}{said && ` The notes record ${said}.`}{omitted > 0 && ` ${omitted} earlier ${omitted === 1 ? 'message is' : 'messages are'} not drawn.`}</p></div>
    {children && <div className="graph-tools">{children}</div>}
  </header>;
}

function caption(event: GraphEvent, byId: Map<string, GraphNode>) {
  const node = byId.get(event.node);
  if (!node) return event.label;
  if (event.action === 'ask') return 'Asked: ' + node.title;
  if (event.action === 'answer') return event.label;
  if (event.action === 'changed') return node.title + ' · ' + event.label.charAt(0).toLowerCase() + event.label.slice(1);
  return event.label + ' ' + (node.kind === 'run' ? node.title : node.path ?? node.title);
}

function Card({ node, place, client, snapshot, near, selected, dimmed, later, current, arrived, live, onSelect, onOpen }: {
  node: GraphNode; place: { x: number; y: number; width: number; height: number }; client: BrowserClient; snapshot: WorkspaceSnapshot; near: boolean;
  selected: boolean; dimmed: boolean; later: boolean; current: boolean; arrived: boolean; live: string | null; onSelect: () => void; onOpen: () => void;
}) {
  const last = node.events.at(-1);
  const meta = node.kind === 'question' ? [node.agent, ended[node.state ?? ''] ?? node.state, clock(node.at)].filter(Boolean).join(' · ')
    : node.kind === 'run' ? [node.end ?? outcomes[node.outcome ?? ''] ?? node.outcome, node.durationMs ? durationText(node.durationMs) : null, clock(node.at)].filter(Boolean).join(' · ')
    : [node.versions ? node.versions.length + ' versions' : '', happened(node), last ? clock(last.at) : ''].filter(Boolean).join(' · ');
  const folder = node.path?.includes('/') ? node.path.split('/').slice(0, -1).join('/') : '';
  const label = `${kindLabel(node)}: ${node.kind === 'file' ? node.path : node.title}. ${meta}`;
  return <button className={'graph-node kind-' + node.kind + ' tone-' + tone(node)} data-node={node.id} style={{ left: place.x, top: place.y, width: place.width, height: place.height }}
    aria-pressed={selected} aria-label={label} data-dimmed={dimmed || undefined} data-later={later || undefined} data-current={current || undefined} data-arrived={arrived || undefined} data-live={live ? '' : undefined} data-missing={node.kind === 'file' && !node.exists || undefined}
    onClick={onSelect} onDoubleClick={onOpen}>
    {live && <span className={'graph-flag' + (node.waiting ? ' waiting' : '')}><span className="pulse-dot" aria-hidden="true" />{live}</span>}
    <span className="graph-node-head"><span className="graph-node-icon"><Icon name={kindIcon(node)} size={15} stroke={1.8} /></span><span className="graph-node-kind">{kindLabel(node)}{folder && <span className="graph-node-folder"> · {folder}</span>}</span></span>
    <strong className="graph-node-title" title={node.kind === 'question' ? node.text : node.path ?? node.command}>{node.title}</strong>
    {node.kind === 'question' && node.answer && <span className="graph-node-answer">{gist(node.answer)}</span>}
    {hasPreview(node) && (node.capturedAt === undefined || !later) && <CardPreview client={client} snapshot={snapshot} node={node} shown={near && !later} />}
    {node.kind === 'file' && !node.resource && <span className="graph-node-meta">Historical version not captured</span>}
    <span className="graph-node-meta">{node.kind === 'file' && !node.exists ? 'Not in the folder now' : meta}</span>
  </button>;
}

// A card of the meaning layer: the question with its to-dos, a finding, a choice, or a file by what
// the notes say it holds. Each says who wrote it as far as the Agent's record shows, and when a
// file it names has changed since.
function MeaningCard({ node, place, client, snapshot, near, agentOf, selected, dimmed, later, arrived, onSelect, onOpen }: {
  node: GraphNode; place: { x: number; y: number; width: number; height: number }; client: BrowserClient; snapshot: WorkspaceSnapshot; near: boolean;
  agentOf: (conversationId: string) => string | undefined; selected: boolean; dimmed: boolean; later: boolean; arrived: boolean; onSelect: () => void; onOpen: () => void;
}) {
  const m = node.meaning!, file = node.kind === 'file', trace = file ? m.description?.trace : m.trace;
  const changed = trace?.files.some(f => f.later === 'kept') ? 'newer version since' : trace?.files.some(f => f.later === 'written') ? 'written again since' : '';
  const folder = node.path?.includes('/') ? node.path.split('/').slice(0, -1).join('/') : '';
  const d = file ? m.description : undefined;
  const by = file && !d ? 'Nothing says what it holds yet' : d?.source === 'model' ? `Described by ${modelName(d.model)}${d.strategy === 'context' ? ' from code' : ''} · ${clock(d.at ?? 0)}${d.earlier ? ' · earlier version' : ''}`
    : d?.source === 'facts' ? `Read from the file · ${clock(d.at ?? 0)}${d.writing ? ' · describing…' : ''}`
    : m.message ? `Asked ${clock(m.message.at)} · no notes yet` : writtenBy(trace, agentOf);
  const kind = node.kind === 'question' && !m.statement && !m.message ? 'Section' : kindLabel(node);
  return <button className={'graph-node meaning kind-' + node.kind + ' tone-' + tone(node)} data-node={node.id} style={{ left: place.x, top: place.y, width: place.width, height: place.height }}
    aria-pressed={selected} aria-label={`${kind}: ${file ? (m.description?.text ? m.description.text + ', ' : '') + node.path : node.text}. ${by}`} data-dimmed={dimmed || undefined} data-later={later || undefined} data-arrived={arrived || undefined} data-missing={file && !node.exists || undefined}
    onClick={onSelect} onDoubleClick={onOpen}>
    <span className="graph-node-head"><span className="graph-node-icon"><Icon name={kindIcon(node)} size={15} stroke={1.8} /></span><span className="graph-node-kind">{kind}{file && folder && <span className="graph-node-folder"> · {folder}</span>}{node.kind === 'question' && !m.message && <span className="graph-node-folder"> · {m.session}</span>}</span></span>
    <strong className={'graph-node-title meaning-text' + (d ? ' holds-' + d.source : '')} title={file ? node.path : node.text}>{file ? d?.text || node.title : node.title}</strong>
    {file && d?.text && <span className="graph-node-path">{node.title}</span>}
    {file && hasPreview(node) && <CardPreview client={client} snapshot={snapshot} node={node} shown={near && !later} />}
    <span className="graph-node-meta">{node.kind === 'question' && m.todos ? `${m.todos.done} of ${m.todos.total} to-dos done · ` : ''}{by}{changed && <span className="meaning-changed"> · {changed}</span>}{file && !node.exists && ' · not in the folder now'}</span>
  </button>;
}

function Edges({ layout, focus, shown, labels, dim, live }: { layout: Layout; focus: ReturnType<typeof lineage> | null; shown: (e: GraphEdge) => boolean; labels: boolean; dim: (id: string) => boolean | null; live: string | null }) {
  return <svg className="graph-edges" width={layout.width} height={layout.height} aria-hidden="true" style={{ overflow: 'visible' }}>
    <defs>
      <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" className="arrow" /></marker>
      <marker id="graph-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" className="arrow on" /></marker>
    </defs>
    {layout.rows.slice(1).map(row => <line key={row.turn} className="graph-row-rule" x1={-40} x2={layout.width + 40} y1={row.y - 32} y2={row.y - 32} />)}
    {layout.links.filter(l => shown(l.edge) && !(l.edge.label === 'ran' && layout.links.some(a => a.from === l.from && layout.links.some(b => b.from === a.to && b.to === l.to)))).map((l: LaneLink) => {
      const e = l.edge, a = layout.placed.get(l.from)!, b = layout.placed.get(l.to)!;
      const forward = a.x + a.width <= b.x;
      const x1 = forward ? a.x + a.width : a.x + a.width / 2, y1 = forward ? a.y + a.height / 2 : a.y + a.height, x2 = forward ? b.x : b.x + b.width / 2, y2 = forward ? b.y + b.height / 2 : b.y;
      const bend = Math.max(36, (x2 - x1) / 2);
      const d = forward ? `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 2} ${y2}` : `M${x1} ${y1} C${x1} ${y1 + 80} ${x2} ${y2 - 80} ${x2} ${y2 - 2}`;
      const on = !!focus?.edges.has(e.id), off = (focus && !on) || dim(e.from) || dim(e.to);
      const mx = (x1 + x2) / 2, my = forward ? (y1 + y2) / 2 : (y1 + y2) / 2 + 40;
      return <g key={l.id + l.from} data-label={e.label} className={'graph-edge ' + e.basis + (on ? ' on' : '') + (off ? ' off' : '') + (live && l.to === live ? ' live' : '')}>
        <path d={d} markerEnd={on ? 'url(#graph-arrow-on)' : 'url(#graph-arrow)'} />
        {labels && !off && <text x={mx} y={my - (e.label.length > 12 ? 18 : 6)} textAnchor="middle">{e.label.length > 12 ? e.label.split(/ (?=while|meanwhile)/).map((line, i, all) => <tspan key={i} x={mx} dy={i ? 13 : 0}>{line + (i < all.length - 1 ? ' ' : '')}</tspan>) : e.label}</text>}
      </g>;
    })}
  </svg>;
}

// A file an earlier message touched, as this message's row refers to it. Choosing it goes there.
function Reference({ item, node, place, home, dimmed, later, selected, live, onSelect }: { item: LaneItem; node: GraphNode; place: { x: number; y: number; width: number; height: number }; home: string; dimmed: boolean; later: boolean; selected: boolean; live: string | null; onSelect: () => void }) {
  return <button className={'graph-node graph-ref tone-' + tone(node)} data-node={item.id} style={{ left: place.x, top: place.y, width: place.width, height: place.height }}
    aria-label={`${node.kind === 'file' ? node.path : node.title}, from ${home}. Go there`} aria-pressed={selected} data-dimmed={dimmed || undefined} data-later={later || undefined} data-live={live ? '' : undefined} onClick={onSelect}>
    {live && <span className={'graph-flag' + (node.waiting ? ' waiting' : '')}><span className="pulse-dot" aria-hidden="true" />{live}</span>}
    <span className="graph-node-head"><span className="graph-node-icon"><Icon name={kindIcon(node)} size={13} stroke={1.8} /></span><span className="graph-node-kind">{kindLabel(node)} · from {home}</span><Icon name="back" size={12} /></span>
    <strong className="graph-node-title">{node.title}</strong>
  </button>;
}

// The person's own place to read one node: what happened to it and when, where it came from and
// what it fed, and for a file the file itself in the view its kind has.
function Inspector({ node, graph, process, traces, byId, client, snapshot, principalId, workspace, onStudio, onAbout, onAgent, onSelect, onTrace, agentOf, onClose }: {
  node: GraphNode; graph: Graph; process: Graph; traces: GraphEdge[]; byId: Map<string, GraphNode>; client: BrowserClient; snapshot: WorkspaceSnapshot; principalId?: string; workspace: () => string;
  onStudio: (compositionId: string, viewId?: string) => void; onAbout: (pluginId: string) => void; onAgent: (conversationId?: string) => void; onSelect: (id: string) => void;
  onTrace: (id: string) => void; agentOf: (conversationId: string) => string | undefined; onClose: () => void;
}) {
  const shell = useContext(ShellContext);
  const related = snapshot.annotations.filter((t: any) => node.resource && (t.anchor?.resource?.id === node.resource.id && t.anchor?.resource?.version === node.resource.version || t.messages?.some((m: any) => m.resources?.some((r: any) => r.id === node.resource!.id && r.version === node.resource!.version))));
  const [placing,setPlacing] = useState(false), [problem,setProblem] = useState('');
  async function open() {
    setPlacing(true); setProblem('');
    try { const placed = await openInWorkspace(client, snapshot, workspace(), node.path!); if (placed) onStudio(placed.compositionId, placed.viewId); else setProblem('Rho has no viewer for this kind of file yet.'); }
    catch (error) { setProblem(error instanceof Error ? error.message : 'It could not be opened in the workspace.'); }
    finally { setPlacing(false); }
  }
  const from = graph.edges.filter(e => e.to === node.id), to = graph.edges.filter(e => e.from === node.id);
  const turnTitle = (turn: string) => byId.get('q:' + turn)?.title ?? 'A message';
  const relation = (edges: GraphEdge[], side: 'from' | 'to') => edges.map(e => { const other = byId.get(side === 'from' ? e.from : e.to)!; return <li key={e.id}><button className="graph-link" onClick={() => onSelect(other.id)}><Icon name={kindIcon(other)} size={14} /><span>{other.title}</span></button><small className={'graph-basis ' + e.basis}>{e.label}</small></li>; });
  const took = node.kind === 'question' && node.events.at(-1)?.action === 'answer' ? span(node.events.at(-1)!.at - node.at) : '';
  return <aside className="graph-inspector" aria-label={kindLabel(node) + ' ' + node.title}>
    <header className="graph-inspector-head">
      <span className={'graph-node-icon tone-' + tone(node)}><Icon name={kindIcon(node)} size={16} stroke={1.8} /></span>
      <div><small>{node.meaning && node.kind !== 'file' ? kindLabel(node) + ' · in the notes' : kindLabel(node)}</small><h2 title={node.path ?? node.text}>{node.kind === 'file' ? node.title : node.kind === 'run' ? (node.commands ? node.title : 'Ran a command') : node.meaning ? node.meaning.session : 'You asked'}</h2>{node.kind === 'file' && <p>{node.path}{node.bytes !== undefined && node.exists ? ' · ' + size(node.bytes) : ''}</p>}</div>
      <button className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={17} /></button>
    </header>
    <div className="graph-inspector-body">
      {node.meaning && <MeaningSaid node={node} graph={graph} process={process} traces={traces} client={client} snapshot={snapshot} agentOf={agentOf} onAgent={onAgent} onTrace={onTrace} onSelect={onSelect} />}
      {node.kind === 'question' && !node.meaning && <section className="graph-said"><p className="graph-question">{node.text}</p>
        <p className="graph-facts">{[node.agent, ended[node.state ?? ''] ?? node.state, took && 'took ' + took, node.model].filter(Boolean).join(' · ')}</p>
        {node.answer && <div className="graph-answer"><AgentMarkdown text={node.answer} streaming={node.state === 'running'} /></div>}
        <button onClick={() => onAgent(node.conversationId)}><Icon name="prompt" size={15} />Show the conversation</button></section>}
      {node.waiting && <Choice key={node.waiting.permission} waiting={node.waiting} client={client} projectId={snapshot.project.id} />}
      {node.commands && <section className="graph-said"><p className="graph-facts">Commands that read, ran or changed no project file, for “{turnTitle(node.turn!)}”</p>
        <ol className="graph-commands">{node.commands.map(run => <li key={run.id}><details><summary><code title={run.ran}>{run.command}</code><small>{[run.end ?? outcomes[run.outcome ?? ''] ?? run.outcome, run.durationMs ? durationText(run.durationMs) : null, clock(run.at)].filter(Boolean).join(' · ')}</small></summary>
          {run.output?.text ? <pre className="graph-output">{run.output.text}</pre> : <p className="muted">Printed nothing.</p>}</details></li>)}</ol></section>}
      {node.kind === 'run' && !node.commands && <section className="graph-said"><pre className="graph-command" title={node.ran}>{node.command}</pre><p className="graph-facts">{[node.end ?? outcomes[node.outcome ?? ''] ?? node.outcome, node.durationMs ? 'took ' + durationText(node.durationMs) : null, clock(node.at, true)].filter(Boolean).join(' · ')} · for “{turnTitle(node.turn!)}”</p>
        {node.output && <><h3 className="caption">{node.output.text ? node.output.cut ? `Printed · last ${node.output.text.split('\n').length} of ${node.output.lines} lines` : 'Printed' : 'Printed nothing'}</h3>{node.output.text && <pre className="graph-output" ref={atEnd}>{node.output.text}</pre>}</>}
        {node.ran && node.ran !== node.command && <p className="graph-facts">As run: <code>{node.ran}</code></p>}</section>}
      {node.kind === 'file' && <><p className="graph-facts">{node.resource ? (node.versions ? `Newest of ${node.versions.length} versions kept during this message, ` : 'Version kept ') + new Date(node.capturedAt!).toLocaleString() + (node.captureSource === 'buffer' ? ' from the open editor' : node.captureSource === 'disk' ? ' from disk' : '') + ' · which step made it is not confirmed' : node.gap}</p>{node.resource && <Snapshot client={client} projectId={snapshot.project.id} resource={node.resource} path={node.path}/>}<div className="graph-actions">{node.exists && <button className="primary" disabled={placing} onClick={() => void open()}><Icon name="layout" size={15} />{placing ? 'Opening…' : 'Open current file in workspace'}</button>}</div></>}
      {related.map((t: any) => <button key={t.annotationId} onClick={() => shell?.openReview?.(t.annotationId)}>Review: {t.messages[0].draft.text.slice(0,70)}</button>)}
      {problem && <p className="canvas-note" role="alert">{problem}</p>}
      {node.kind === 'file' && !node.exists && <p className="muted">This file was not in the project folders when they were last read. It may have been moved or removed.</p>}
      {from.length > 0 && <section><h3 className="caption">Comes from</h3><ul className="graph-relations">{relation(from, 'from')}</ul></section>}
      {to.length > 0 && <section><h3 className="caption">Leads to</h3><ul className="graph-relations">{relation(to, 'to')}</ul></section>}
      {node.kind === 'file' && !node.meaning && <section><h3 className="caption">What happened</h3><ol className="graph-history">{node.events.map(e => <li key={e.key}><time>{clock(e.at)}</time><span>{e.label}{e.outcome && e.outcome !== 'returned' ? ' · ' + (outcomes[e.outcome] ?? e.outcome).toLowerCase() : ''}</span><button className="graph-link" onClick={() => onSelect('q:' + e.turn)}>{turnTitle(e.turn)}</button></li>)}</ol></section>}
    </div>
  </aside>;
}

// What the notes say in a meaning card, where it came from, and the way into the process layer:
// the message whose kept version of the notes first holds it, and each file it names as the
// version kept then.
function MeaningSaid({ node, graph, process, traces, client, snapshot, agentOf, onAgent, onTrace, onSelect }: { node: GraphNode; graph: Graph; process: Graph; traces: GraphEdge[]; client: BrowserClient; snapshot: WorkspaceSnapshot;
  agentOf: (conversationId: string) => string | undefined; onAgent: (conversationId?: string) => void; onTrace: (id: string) => void; onSelect: (id: string) => void }) {
  const m = node.meaning!, file = node.kind === 'file', trace = file ? m.description?.trace : m.trace;
  const shell = useContext(ShellContext);
  // The way into the process layer is the same whichever layer is shown.
  const kept = traces.find(e => e.from === node.id && e.label === 'kept as')?.to;
  const writtenIn = trace?.written ? 'q:' + trace.written.turn : null;
  const message = writtenIn ? process.nodes.find(n => n.id === writtenIn) : undefined;
  return <section className="graph-said meaning-said">
    {file ? (m.description ? <p className="meaning-statement">{m.description.text}</p> : <p className="muted">The notes do not say what this file holds.</p>)
      : node.kind === 'choice' && m.statement ? <ChoiceOptions statement={m.statement} trace={m.trace} conversationId={m.conversationId} client={client} projectId={snapshot.project.id} onPath={path => shell?.openPath?.(path)} onSent={id => onAgent(id)} />
      : <p className="meaning-statement">{node.text}</p>}
    {node.kind === 'question' && m.todos && <p className="graph-facts">{m.todos.done} of {m.todos.total} to-dos done</p>}
    {file && m.description && m.description.source !== 'notes' && <div className="meaning-trace">
      <h3 className="caption">Where this comes from</h3>
      <p className="graph-facts">{m.description.source === 'model'
        ? <>Described by {modelName(m.description.model)} at {clock(m.description.at ?? 0, true)} {seen(m.description)}{m.description.earlier ? ', from an earlier version than the facts below' : ''}. A model's sentence; it is not checked. The notes do not say what this file holds yet.</>
        : <>Read from the file at {clock(m.description.at ?? 0, true)}{m.description.writing ? '; a model is writing a sentence about it' : ''}. The notes do not say what this file holds yet.</>}</p>
      {m.description.source === 'model' && m.description.why && <p className="graph-facts">{m.description.why}</p>}
      {m.description.source === 'model' && m.description.cost && <p className="graph-facts">{costText(m.description.cost)}</p>}
      {m.description.source === 'model' && m.description.facts && <p className="graph-facts">Facts read from the file: {m.description.facts}</p>}
    </div>}
    {m.message && <div className="meaning-trace">
      <h3 className="caption">Where this comes from</h3>
      <p className="graph-facts">Asked at {clock(m.message.at, true)}. The notes have no section for this conversation yet, so its results are shown by what was read from them.</p>
      <div className="graph-actions"><button onClick={() => onTrace(m.message!.id)}><Icon name="graph" size={15} />Show the message</button></div>
    </div>}
    {!m.message && (!file || m.description?.source === 'notes') && <div className="meaning-trace">
      <h3 className="caption">Where this comes from</h3>
      <p className="graph-facts">{trace?.written
        ? <>Written by {agentOf(trace.written.conversationId) ?? 'the Agent'} at {clock(trace.written.at, true)}, first in version {trace.written.version} of {trace.written.of} of the notes that the Agent's record kept.</>
        : <>No version of the notes that the Agent's record kept holds this. You or another program wrote it, or the record kept no version since.</>}</p>
      {trace?.files.length ? <ul className="meaning-files">{trace.files.map(f => {
        const target = graph.nodes.find(n => n.id === 'm:f:' + f.path);
        return <li key={f.path}><button className="graph-link" onClick={() => target && onSelect(target.id)}><Icon name="file" size={13} /><span>{f.path}</span></button>
          <small>{f.kept ? 'version kept ' + clock(f.kept.at) : 'no version kept'}{f.later === 'kept' ? ' · a newer version was kept since' : f.later === 'written' ? ' · written again since' : ''}</small></li>;
      })}</ul> : null}
      <div className="graph-actions">
        {message && <button onClick={() => onTrace(message.id)}><Icon name="graph" size={15} />Show the message it was written in</button>}
        {kept && <button onClick={() => onTrace(kept)}><Icon name="graph" size={15} />Show this version in the process</button>}
        {!message && !kept && m.conversationId && <button onClick={() => onAgent(m.conversationId!)}><Icon name="prompt" size={15} />Show the conversation</button>}
      </div>
    </div>}
  </section>;
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

// The work over time: each message a band, each action a tick. Dragging or the arrow keys
// show the graph as it stood then; Play runs through it. Long pauses between messages are cut.
// Ticks a reader can tell apart: the shortest step that leaves this much room between labels.
const tickSteps = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 21600e3];

// What happened when, one lane per conversation: each message a band, each action a block in its
// kind's colour, refused or unknown ones marked. A pause longer than half a minute is folded to a
// fixed gap that says how long it was. Pointing at a block names it; pressing moves the playhead.
function Timeline({ graph, cursor, playing, running, speed, onSpeed, onCursor, onPlay, compact = false }: { graph: Graph; cursor: number | null; playing: boolean; running: boolean; speed: number; onSpeed: (speed: number) => void; onCursor: (at: number | null) => void; onPlay: () => void; compact?: boolean }) {
  const track = useRef<HTMLDivElement>(null), [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ event: GraphEvent; x: number; lane: number } | null>(null), [only, setOnly] = useState<TimelineKind | null>(null);
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element); setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  // Bands that overlap are one stretch of time; between stretches a fixed gap stands for the pause.
  const stretches = useMemo(() => {
    const sorted = [...graph.turns].sort((a, b) => a.start - b.start), out: Array<{ start: number; end: number; turns: typeof sorted }> = [];
    for (const t of sorted) { const last = out.at(-1); if (last && t.start <= last.end + 30000) { last.end = Math.max(last.end, t.end); last.turns.push(t); } else out.push({ start: t.start, end: Math.max(t.end, t.start + 1000), turns: [t] }); }
    return out;
  }, [graph.turns]);
  // One lane per conversation, in the order they began.
  const lanes = useMemo(() => {
    const out: Array<{ id: string; title: string; agent: string; turns: typeof graph.turns }> = [];
    for (const t of [...graph.turns].sort((a, b) => a.start - b.start)) {
      const lane = out.find(l => l.id === t.conversationId);
      if (lane) lane.turns.push(t); else out.push({ id: t.conversationId, title: t.title, agent: t.agent, turns: [t] });
    }
    return out;
  }, [graph.turns]);
  const laneOf = useMemo(() => new Map(graph.turns.map(t => [t.id, lanes.findIndex(l => l.id === t.conversationId)])), [graph.turns, lanes]);
  const gap = 44, usable = Math.max(100, width - gap * Math.max(0, stretches.length - 1));
  const weights = stretches.map(s => Math.sqrt(s.end - s.start)), total = weights.reduce((a, b) => a + b, 0) || 1;
  const offsets: number[] = []; let x = 0;
  stretches.forEach((s, i) => { offsets.push(x); x += usable * weights[i] / total + gap; });
  const widthOf = (i: number) => usable * weights[i] / total;
  const toX = (at: number) => {
    const found = stretches.findIndex(s => at <= s.end), i = found < 0 ? stretches.length - 1 : found;
    const s = stretches[i], w = widthOf(i);
    return offsets[i] + Math.min(w, Math.max(0, (at - s.start) / (s.end - s.start) * w));
  };
  const fromX = (px: number) => {
    for (let i = stretches.length - 1; i >= 0; i--) if (px >= offsets[i]) { const s = stretches[i], w = widthOf(i); return s.start + Math.min(1, Math.max(0, (px - offsets[i]) / w)) * (s.end - s.start); }
    return stretches[0]?.start ?? 0;
  };
  const events = graph.events, last = events.at(-1)?.at ?? 0;
  const index = cursor === null ? events.length : events.filter(e => e.at <= cursor).length;
  const laneHeight = 24, lanesTop = 0;
  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    const element = event.currentTarget, box = element.getBoundingClientRect();
    element.setPointerCapture(event.pointerId); setHover(null);
    const set = (clientX: number) => { const at = fromX(clientX - box.left); const nearest = events.reduce((best, e) => Math.abs(e.at - at) < Math.abs(best.at - at) ? e : best, events[0]); onCursor(Math.abs(toX(nearest.at) - (clientX - box.left)) < 8 ? nearest.at : at); };
    set(event.clientX);
    const move = (e: PointerEvent) => set(e.clientX);
    const stop = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  // The block nearest the pointer in the lane under it, within a few pixels.
  function point(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.buttons) return;
    const box = event.currentTarget.getBoundingClientRect(), px = event.clientX - box.left, lane = Math.floor((event.clientY - box.top - lanesTop) / laneHeight);
    let best: GraphEvent | null = null, distance = 7;
    for (const e of events) { if (laneOf.get(e.turn) !== lane) continue; const d = Math.abs(toX(e.at) - px); if (d < distance) { best = e; distance = d; } }
    setHover(best ? { event: best, x: toX(best.at), lane } : null);
  }
  function keys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const at = cursor ?? last;
    const step = event.key === 'ArrowRight' ? events.find(e => e.at > at)?.at ?? null : event.key === 'ArrowLeft' ? [...events].reverse().find(e => e.at < at)?.at ?? events[0].at : event.key === 'Home' ? events[0].at : event.key === 'End' ? null : undefined;
    if (step === undefined) return;
    event.preventDefault(); onCursor(step);
  }
  const head = cursor === null ? width : toX(cursor);
  const duration = graph.turns.reduce((sum, t) => sum + (t.end - t.start), 0);
  const counts = timelineKinds.map(k => ({ ...k, count: events.filter(e => (k.actions as readonly string[]).includes(e.action)).length })).filter(k => k.count > 0);
  const refused = events.filter(failed).length;
  // Each stretch's ticks, at the shortest step that leaves 72 px between labels.
  const ticks = stretches.flatMap((s, i) => {
    const w = widthOf(i), length = s.end - s.start, step = tickSteps.find(t => w * t / length >= 72) ?? tickSteps.at(-1)!;
    const out = [{ at: s.start, x: offsets[i], first: true }];
    for (let t = Math.ceil(s.start / step) * step; t < s.end; t += step) { const tx = toX(t); if (tx - out.at(-1)!.x >= 60 && offsets[i] + w - tx >= 24) out.push({ at: t, x: tx, first: false }); }
    return out.map(tick => ({ ...tick, label: clock(tick.at, step < 60e3) }));
  });
  const pauses = stretches.slice(1).map((s, i) => ({ x: offsets[i + 1] - gap, length: s.start - stretches[i].end }));
  const Frame = compact ? 'div' : 'footer';
  return <Frame className={'graph-timeline' + (compact ? ' compact' : '') + (only ? ' only-' + only : '')} aria-label="Timeline">
    <div className="tl-head">
      {!compact && <button className="graph-play" aria-label={playing ? 'Pause' : 'Play the work from the start'} onClick={onPlay}><Icon name={playing ? 'pause' : 'run'} size={16} /></button>}
      <div className="graph-timeline-text"><strong>{events.filter(e => e.action !== 'ask' && e.action !== 'answer').length} actions</strong><span>{graph.turns.length} {graph.turns.length === 1 ? 'message' : 'messages'} · {span(duration)}{lanes.length > 1 ? ` · ${lanes.length} conversations` : ''}</span></div>
      <div className="tl-legend" role="group" aria-label="Show one kind of action">
        {counts.map(k => <button key={k.key} className={'tl-kind ' + k.key} aria-pressed={only === k.key} onClick={() => setOnly(only === k.key ? null : k.key)}><i aria-hidden="true" /><span>{k.label}</span><small>{k.count}</small></button>)}
        {refused > 0 && <span className="tl-kind failed"><i aria-hidden="true" /><span>Failed, refused or unknown</span><small>{refused}</small></span>}
      </div>
      {!compact && <>
        <div className="tl-speed" role="group" aria-label="Replay speed">
          {[1, 2, 4].map(value => <button key={value} aria-pressed={speed === value} onClick={() => onSpeed(value)}>{value}×</button>)}
        </div>
        <button className={'graph-now' + (cursor === null ? ' on' : '')} aria-pressed={cursor === null} onClick={() => onCursor(null)}>{running ? <><span className="pulse-dot" aria-hidden="true" />Live</> : 'Now'}</button>
      </>}
    </div>
    <div className="tl-body">
      <ol className="tl-names" aria-label="Conversations">
        {lanes.map(l => {
          // Conversations that share a title lead with when they started, which a cut name still shows.
          const brand = brandOf(l.agent), twin = lanes.some(o => o !== l && o.title === l.title), name = twin && l.turns[0] ? clock(l.turns[0].start) + ' · ' + l.title : l.title;
          return <li key={l.id} title={name}>{brand ? <BrandMark brand={brand} size={13} /> : <Icon name="chat" size={13} />}<span>{name}</span></li>;
        })}
      </ol>
      <div className="tl-plot">
        <div ref={track} className="graph-track" {...(compact ? { role: 'img', 'aria-label': `${events.length} steps over ${lanes.length} ${lanes.length === 1 ? 'conversation' : 'conversations'}` } : { role: 'slider', tabIndex: 0, 'aria-label': 'When', 'aria-valuemin': 0, 'aria-valuemax': events.length, 'aria-valuenow': index,
          'aria-valuetext': cursor === null ? 'Now · everything' : `${clock(cursor, true)} · ${index} of ${events.length}`, onPointerDown: scrub, onKeyDown: keys })} onPointerMove={point} onPointerLeave={() => setHover(null)}
          style={{ height: lanes.length * laneHeight } as CSSProperties}>
          {lanes.map((l, lane) => <div key={l.id} className="tl-lane" style={{ top: lane * laneHeight, height: laneHeight }}>
            {l.turns.map(t => <span key={t.id} className={'tl-band' + (t.running ? ' running' : '')} style={{ left: toX(t.start), width: Math.max(4, toX(t.end) - toX(t.start)) }} />)}
          </div>)}
          {pauses.map((p, i) => <span key={i} className="tl-fold" style={{ left: p.x, width: gap, height: lanes.length * laneHeight }} aria-hidden="true" />)}
          {events.map(e => <i key={e.key} className={'graph-tick tl-block ' + kindOfAction(e.action) + (failed(e) ? ' failed' : '') + (cursor !== null && e.at > cursor ? ' later' : '') + (hover?.event.key === e.key ? ' hot' : '')}
            style={{ left: toX(e.at), top: (laneOf.get(e.turn) ?? 0) * laneHeight + 5 }} />)}
          <span className="graph-head-line" style={{ left: head, height: lanes.length * laneHeight + 22 }}>{cursor !== null && <time>{clock(cursor, true)}</time>}</span>
          {hover && <div className="tl-tip" style={{ left: Math.min(Math.max(hover.x, 110), width - 110), top: hover.lane * laneHeight }} role="tooltip">
            <time>{clock(hover.event.at, true)}</time><span>{caption(hover.event, new Map(graph.nodes.map(n => [n.id, n])))}</span>{failed(hover.event) && <small>{outcomes[hover.event.outcome!]}</small>}
          </div>}
        </div>
        <div className="tl-axis" aria-hidden="true">
          {ticks.map(t => <span key={t.at + ':' + t.x} className={t.first ? 'first' : ''} style={{ left: t.x }}>{t.label}</span>)}
          {pauses.map((p, i) => <small key={i} style={{ left: p.x + gap / 2 }} title={'A pause of ' + span(p.length)}>{span(p.length)}</small>)}
        </div>
      </div>
    </div>
  </Frame>;
}

// The Overview's glance at the same record: the timeline without its controls, and the way to
// the Graph. It reads the conversations as the Graph does, and shows nothing until they are read.
export function WorkStrip({ client, snapshot, files, onOpen, onConversations }: { initialResource?: {id:string;version:string}|null; client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFiles; onOpen: () => void; onConversations: () => void }) {
  const { turns, loading } = useTurns(client, snapshot);
  const graph = useMemo(() => buildWorkGraph({ turns, files: files.files.map(f => ({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, category: f.category })), project: snapshot.project, kindOf, now: Date.now() }),
    [turns, files.files, snapshot.project]);
  if (loading || !graph.events.length) return null;
  const files_ = graph.nodes.filter(n => n.kind === 'file' && n.events.some(e => e.action === 'edit' || e.action === 'write' || e.action === 'changed')).length;
  const last = graph.events.at(-1)!.at, days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(last).setHours(0, 0, 0, 0)) / 864e5);
  const lastWords = (days === 0 ? 'today' : days === 1 ? 'yesterday' : new Date(last).toLocaleDateString()) + ' at ' + clock(last);
  const conversations = snapshot.conversations?.length ?? 0;
  return <section className="project-section work-strip" aria-labelledby="work-strip-title">
    {/* Questions and commands are counted by the kinds under the heading; the line keeps the rest. */}
    <div className="section-heading"><div><h2 id="work-strip-title">What the Agent did</h2>
      <p className="work-strip-line"><button className="text-button" onClick={onConversations}>{conversations} {conversations === 1 ? 'conversation' : 'conversations'}</button> · {files_} {files_ === 1 ? 'file' : 'files'} changed · last {lastWords}</p></div>
      <button className="text-button" onClick={onOpen}>Open the Graph <Icon name="chevron" size={12} /></button></div>
    <Timeline graph={graph} cursor={null} playing={false} running={false} speed={1} onSpeed={() => undefined} onCursor={() => undefined} onPlay={() => undefined} compact />
  </section>;
}
