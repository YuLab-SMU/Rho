import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { GraphEvent, GraphNode, WorkGraph as Graph } from '../src/work-graph.js';
import { personPrincipal } from '../src/terminal-work.js';
import { plainAsk } from '../src/asking.js';
import { markCaption, type EventMark, type Who } from '../src/timeline-events.js';
import { layoutTimeline, timelineSizes, type Piece, type PlacedBand, type TimelineMark, type TimelineTrack } from '../src/timeline-layout.js';
import { clock, failed, kindOfAction, span, timelineKinds, type TimelineKind } from './timeline-kinds.js';
import { BrandMark, brandOf } from './brand-marks.js';
import { Icon } from './icons.js';

// The work over time (src/timeline-layout.ts). Each conversation is a piece of the strip under
// its own name, and pieces that do not overlap share a row. A message is a band from when it was
// asked until its answer ended; the steps in it are columns, taller where more happened, in each
// kind's colour, with a dot under a column that holds a refused, failed or unknown step. Pauses
// fold to a gap and the axis says where each day begins. Pointing at a band names the message and
// the steps under the pointer; pressing it shows that message in the graph above. The ruler
// below moves the moment the graph is shown at, and Play runs through the work.

const outcomes: Record<string, string> = { returned: 'Returned', requested: 'Running', failed: 'Failed', rejected: 'Refused', unknown: 'Outcome unknown' };
const markEnds: Partial<Record<EventMark['outcome'], string>> = { failed: 'Failed', stopped: 'Stopped', unknown: 'Outcome unknown' };
const plural = (n: number, one: string, many = one + 's') => n.toLocaleString() + ' ' + (n === 1 ? one : many);
const day = (at: number, year = false) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
// A title as a person would say it: the markup a pasted passage arrives in is not part of it.
export const plainTitle = (text: string) => plainAsk(text).replace(/\s+/g, ' ').trim() || 'A conversation';

// One recorded event in words.
export function stepCaption(event: GraphEvent, byId: Map<string, GraphNode>) {
  const node = byId.get(event.node);
  if (!node) return event.label;
  if (event.action === 'ask') return 'Asked: ' + node.title;
  if (event.action === 'answer') return event.label;
  if (event.action === 'changed') return node.title + ' · ' + event.label.charAt(0).toLowerCase() + event.label.slice(1);
  return event.label + ' ' + (node.kind === 'run' ? node.title : node.path ?? node.title);
}

// What the graph above has chosen, as the timeline shows it: the messages it stands for, and
// the stretch of time when it is one activity or step.
export interface TimelineChosen { turns: ReadonlySet<string>; span?: { start: number; end: number } | null }
export interface TimelinePick { turn?: string; conversation?: string }
type Block = TimelineMark & { event?: GraphEvent; mark?: EventMark };
interface Hover { piece: Piece; band: PlacedBand | null; column: number; x: number }

const sizes = { row: 36, name: 15, barTop: 17, bar: 14, axis: 24, zoom: 48 };

export function Timeline({ graph, marks = [], cursor, playing, running, speed, onSpeed, onCursor, onPlay, compact = false, chosen = null, onPick }: {
  graph: Graph; marks?: EventMark[]; cursor: number | null; playing: boolean; running: boolean; speed: number; onSpeed: (speed: number) => void; onCursor: (at: number | null) => void; onPlay: () => void;
  compact?: boolean; chosen?: TimelineChosen | null; onPick?: (pick: TimelinePick) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null), [width, setWidth] = useState(600), [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<Hover | null>(null), [only, setOnly] = useState<TimelineKind | null>(null);
  // Drawn wider than the page, the ruler keeps the day at its left edge in view.
  const [pinned, setPinned] = useState('');
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element); setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // One track per conversation, and one for each other doer the plugins name (the person's cells
  // and commands, a connected Agent's): its messages, or its events when it has none.
  const tracks = useMemo((): TimelineTrack[] => {
    const out = new Map<string, TimelineTrack>();
    for (const t of [...graph.turns].sort((a, b) => a.start - b.start)) {
      const who: Who = t.terminal && t.conversationId === 'terminal:' + personPrincipal ? 'person' : 'conversation';
      const track = out.get(t.conversationId) ?? { id: t.conversationId, title: plainTitle(t.title), agent: t.agent, who, bands: [] };
      track.bands.push({ id: t.id, start: t.start, end: t.end, running: t.running, message: !t.terminal });
      out.set(t.conversationId, track);
    }
    for (const m of marks) {
      const track = out.get(m.lane) ?? { id: m.lane, title: plainTitle(m.laneTitle), agent: m.agent ?? '', who: m.who, bands: [] };
      track.bands.push({ id: m.key, start: m.at, end: m.end, running: m.outcome === 'running' });
      out.set(m.lane, track);
    }
    return [...out.values()];
  }, [graph.turns, marks]);
  // Every step, oldest first: the conversations' and the plugins'.
  const blocks = useMemo((): Block[] => {
    const trackOf = new Map(graph.turns.map(t => [t.id, t.conversationId]));
    return [...graph.events.map(e => ({ key: e.key, at: e.at, track: trackOf.get(e.turn) ?? '', kind: kindOfAction(e.action) as string, failed: failed(e), event: e })),
      ...marks.map(m => ({ key: m.key, at: m.at, track: m.lane, kind: kindOfAction(m.action) as string, failed: m.failed, mark: m }))].sort((a, b) => a.at - b.at);
  }, [graph.events, graph.turns, marks]);

  // Names are measured as they are drawn, so a row holds exactly the pieces that fit.
  const measure = useMemo(() => {
    const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'), known = new Map<string, number>();
    if (context) context.font = '500 12px ' + getComputedStyle(document.body).fontFamily;
    return (text: string) => { let w = known.get(text); if (w === undefined) { w = context ? context.measureText(text).width + 2 : text.length * 7; known.set(text, w); } return w; };
  }, []);
  // Whose conversation each is, by its Agent's mark, when they are not all one Agent's.
  const mixed = useMemo(() => new Set(tracks.filter(t => t.who === 'conversation').map(t => t.agent)).size > 1, [tracks]);
  const marked = (track: TimelineTrack) => track.who !== 'conversation' || (mixed && !!brandOf(track.agent));
  const inner = Math.max(120, Math.round(width * zoom));
  const layout = useMemo(() => layoutTimeline({ tracks, marks: blocks, width: inner, measure: track => measure(track.title) + (marked(track) ? 18 : 0), rows: compact ? 3 : timelineSizes.rows }), [tracks, blocks, inner, measure, compact, mixed]);
  const { scale, pieces } = layout, rows = Math.max(1, layout.rows), height = rows * sizes.row;
  // Drawn wider, the pieces may need fewer rows; the strip keeps the height it had.
  const held = useRef(0), fit = Math.min(rows, compact ? 3 : timelineSizes.rows);
  if (zoom === 1) held.current = fit;
  const shownRows = Math.max(fit, held.current);

  // Zooming keeps the moment under the pointer where it is.
  const anchor = useRef<{ at: number; offset: number } | null>(null);
  const pin = () => { const element = scroller.current, text = element && zoom > 1 && scale.stretches.length ? day(scale.fromX(element.scrollLeft + 1)) : ''; if (text !== pinned) setPinned(text); };
  useLayoutEffect(() => { const kept = anchor.current, element = scroller.current; anchor.current = null; if (kept && element) element.scrollLeft = scale.toX(kept.at) - kept.offset; pin(); }, [layout]);
  const zoomTo = (next: number, at?: { at: number; offset: number }) => {
    const element = scroller.current, k = Math.min(sizes.zoom, Math.max(1, next));
    if (!element || k === zoom) return;
    anchor.current = at ?? { at: scale.fromX(element.scrollLeft + element.clientWidth / 2), offset: element.clientWidth / 2 };
    setHover(null); setZoom(k);
  };
  const zoomNow = useRef({ zoom, scale }); zoomNow.current = { zoom, scale };
  useEffect(() => {
    const element = scroller.current;
    if (!element || compact) return;
    function wheel(event: WheelEvent) {
      const { zoom: k, scale: s } = zoomNow.current;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const offset = event.clientX - element!.getBoundingClientRect().left, next = Math.min(sizes.zoom, Math.max(1, k * Math.exp(-event.deltaY * 0.01)));
        if (next !== k) { anchor.current = { at: s.fromX(element!.scrollLeft + offset), offset }; setHover(null); setZoom(next); }
      // A wheel that only turns one way still moves along the time when the rows all fit.
      } else if (k > 1 && Math.abs(event.deltaY) > Math.abs(event.deltaX) && element!.scrollHeight <= element!.clientHeight + 1) { event.preventDefault(); element!.scrollLeft += event.deltaY; }
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [compact]);
  const zoomPiece = (piece: Piece) => zoomTo(zoom * Math.max(1, (width - 96) / Math.max(24, piece.width)), { at: piece.bands[0]!.start, offset: 40 });

  // The steps as columns, one path for each kind, and the dots under columns with a failed step.
  const drawn = useMemo(() => {
    const paths = new Map<string, string>(), peak = Math.log(1 + Math.max(1, layout.peak)), w = timelineSizes.column - 1;
    let dots = '';
    for (const piece of pieces) {
      const top = piece.row * sizes.row + sizes.barTop, foot = top + sizes.bar;
      for (const column of piece.columns) {
        if (!column.total) continue;
        const tall = Math.min(sizes.bar, 4 + (sizes.bar - 4) * Math.log(1 + column.total) / peak);
        let y = foot;
        for (const [kind, n] of column.parts) { const h = tall * n / column.total; y -= h; paths.set(kind, (paths.get(kind) ?? '') + `M${column.x.toFixed(1)} ${y.toFixed(1)}h${w}v${h.toFixed(1)}h${-w}z`); }
        if (column.failed) dots += `M${(column.x + w / 2).toFixed(1)} ${foot + 2.5}h0`;
      }
    }
    return { paths: [...paths], dots };
  }, [layout]);

  // What is under the pointer: the piece in that row nearest it, the message it is in, and the column.
  function point(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.buttons) return;
    const box = event.currentTarget.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top, row = Math.floor(y / sizes.row);
    if (y >= height || y < 0) { setHover(null); return; }
    const reach = (p: Piece) => x < p.x ? p.x - x : x > p.x + p.width ? x - p.x - p.width : 0;
    const piece = pieces.filter(p => p.row === row).reduce<Piece | null>((best, p) => !best || reach(p) < reach(best) ? p : best, null);
    if (!piece || reach(piece) > 6) { setHover(null); return; }
    const off = (b: PlacedBand) => x < b.x ? b.x - x : x > b.x + b.width ? x - b.x - b.width : 0, band = piece.bands.reduce((best, b) => off(b) < off(best) ? b : best);
    const column = Math.min(piece.columns.length - 1, Math.max(0, Math.floor((x - piece.x) / timelineSizes.column)));
    if (hover?.piece.id !== piece.id || hover.band?.id !== band.id || hover.column !== column) setHover({ piece, band: off(band) <= 6 ? band : null, column, x: Math.min(piece.x + piece.width, Math.max(piece.x, x)) });
  }
  const press = () => { if (hover?.band?.message && onPick) onPick({ turn: hover.band.id }); };

  // The ruler: dragging or the arrow keys move the moment shown, to the nearest step when one is close.
  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (!blocks.length) return;
    const element = event.currentTarget, box = element.getBoundingClientRect();
    element.setPointerCapture(event.pointerId); setHover(null);
    const set = (clientX: number) => { const px = clientX - box.left, at = scale.fromX(px), nearest = blocks.reduce((best, b) => Math.abs(b.at - at) < Math.abs(best.at - at) ? b : best, blocks[0]!); onCursor(Math.abs(scale.toX(nearest.at) - px) < 8 ? nearest.at : at); };
    set(event.clientX);
    const move = (e: PointerEvent) => set(e.clientX);
    const stop = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  const last = blocks.at(-1)?.at ?? 0, index = cursor === null ? blocks.length : blocks.filter(b => b.at <= cursor).length;
  function keys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!blocks.length) return;
    const at = cursor ?? last;
    const step = event.key === 'ArrowRight' ? blocks.find(b => b.at > at)?.at ?? null : event.key === 'ArrowLeft' ? [...blocks].reverse().find(b => b.at < at)?.at ?? blocks[0]!.at : event.key === 'Home' ? blocks[0]!.at : event.key === 'End' ? null : undefined;
    if (step === undefined) return;
    event.preventDefault(); onCursor(step);
  }
  const head = cursor === null ? inner : scale.toX(cursor);
  // The moment shown and what is chosen above stay in view when the strip is drawn wider than the page.
  const chosenBand = useMemo(() => { if (!chosen?.turns.size) return null; for (const p of pieces) for (const b of p.bands) if (chosen.turns.has(b.id)) return b; return null; }, [chosen, layout]);
  useEffect(() => { const element = scroller.current; if (!element || zoom === 1 || cursor === null) return; if (head < element.scrollLeft + 24 || head > element.scrollLeft + element.clientWidth - 24) element.scrollLeft = head - element.clientWidth / 2; }, [head]);
  useEffect(() => { const element = scroller.current; if (!element || zoom === 1 || !chosenBand) return; if (chosenBand.x + chosenBand.width < element.scrollLeft + 24 || chosenBand.x > element.scrollLeft + element.clientWidth - 24) element.scrollLeft = chosenBand.x - 80; }, [chosenBand?.id]);
  const chosenSpan = chosen?.span && chosenBand ? (() => { const piece = pieces.find(p => p.bands.includes(chosenBand))!, x = scale.toX(chosen.span!.start); return { x, width: Math.max(3, scale.toX(chosen.span!.end) - x), top: piece.row * sizes.row + sizes.barTop + sizes.bar + 2 }; })() : null;

  const nodes = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph.nodes]);
  const duration = graph.turns.reduce((sum, t) => sum + (t.end - t.start), 0);
  const counts = timelineKinds.map(k => ({ ...k, count: blocks.filter(b => b.kind === k.key).length })).filter(k => k.count > 0 && (compact || (k.key !== 'ask' && k.key !== 'answer')));
  const answered = blocks.filter(b => b.kind === 'answer').length;
  const refused = blocks.filter(b => b.failed).length, conversations = tracks.filter(t => t.who === 'conversation' && t.bands.some(b => b.message)).length, yours = marks.filter(m => m.who === 'person').length;
  const asked = graph.turns.filter(t => !t.terminal).length, steps = blocks.filter(b => b.kind !== 'ask' && b.kind !== 'answer').length;
  const summary = [conversations > 0 && asked ? plural(asked, 'message') + (answered < asked ? ', ' + answered + ' answered' : '') : '', conversations > 0 ? plural(steps, 'action') : '', graph.turns.length ? span(duration) + ' of work' : '', yours ? `${yours} by you` : ''].filter(Boolean).join(' · ');
  const years = scale.stretches.length > 0 && new Date(scale.stretches[0]!.start).getFullYear() !== new Date(scale.stretches.at(-1)!.end).getFullYear();

  // The tip: whose work, which message, when, and the steps under the pointer.
  const tip = hover && (() => {
    const { piece, band } = hover, column = piece.columns[hover.column], here = (column?.marks ?? []).map(i => blocks[i]!).filter(Boolean);
    const question = band?.message ? nodes.get('q:' + band.id)?.title : undefined, own = band ? blocks.filter(b => b.track === piece.track.id && b.at >= band.start && b.at <= band.end && b.kind !== 'ask' && b.kind !== 'answer') : [];
    const bad = own.filter(b => b.failed).length, from = band?.start ?? piece.bands[0]!.start, to = band?.end ?? piece.bands.at(-1)!.end;
    const when = day(from) + ' ' + clock(from) + (to - from >= 60000 ? ' – ' + (new Date(from).toDateString() === new Date(to).toDateString() ? '' : day(to) + ' ') + clock(to) + ' · ' + span(to - from) : '');
    // Above the row it names, over the page when the row is the first: it is not cut by the strip.
    const view = scroller.current;
    if (!view) return null;
    const left = view.offsetLeft + Math.min(Math.max(hover.x - view.scrollLeft, Math.min(150, view.clientWidth / 2)), Math.max(view.clientWidth - 150, view.clientWidth / 2));
    return <div className="tl-tip" style={{ left, top: view.offsetTop + piece.row * sizes.row - view.scrollTop }} role="tooltip">
      <strong>{piece.track.title}</strong>
      {question && <span className="tl-tip-said">{plainTitle(question)}</span>}
      <small>{when}{band?.message && own.length ? ' · ' + plural(own.length, 'action') + (bad ? ', ' + bad + ' failed, refused or unknown' : '') : ''}{band?.running ? ' · working now' : ''}</small>
      {here.length > 0 && <ul>{here.slice(0, 3).map(b => <li key={b.key} className={b.failed ? 'bad' : ''}><time>{clock(b.at, true)}</time><span>{b.event ? stepCaption(b.event, nodes) : b.mark ? markCaption(b.mark) : ''}</span>
        {b.failed && <em>{b.event ? outcomes[b.event.outcome!] : markEnds[b.mark!.outcome]}</em>}</li>)}{here.length > 3 && <li className="more">and {(here.length - 3).toLocaleString()} more here</li>}</ul>}
    </div>;
  })();

  const Frame = compact ? 'div' : 'footer';
  return <Frame className={'graph-timeline' + (compact ? ' compact' : '') + (only ? ' only-' + only : '') + (cursor !== null ? ' replaying' : '')} aria-label="Timeline">
    <div className="tl-head">
      {!compact && <button className="graph-play" aria-label={playing ? 'Pause' : 'Play the work from the start'} onClick={onPlay}><Icon name={playing ? 'pause' : 'run'} size={15} /></button>}
      <div className="graph-timeline-text"><strong>{conversations > 0 ? plural(conversations, 'conversation') : plural(steps, 'action')}</strong><span>{summary}</span></div>
      <div className="tl-legend" role="group" aria-label="Show one kind of action">
        {counts.map(k => k.key === 'ask' || k.key === 'answer' ? <span key={k.key} className={'tl-kind ' + k.key}><span>{k.label}</span><small>{k.count.toLocaleString()}</small></span>
          : <button key={k.key} className={'tl-kind ' + k.key} aria-pressed={only === k.key} onClick={() => setOnly(only === k.key ? null : k.key)}><i aria-hidden="true" /><span>{k.label}</span><small>{k.count.toLocaleString()}</small></button>)}
        {refused > 0 && <span className="tl-kind failed"><i aria-hidden="true" /><span>Failed, refused or unknown</span><small>{refused.toLocaleString()}</small></span>}
      </div>
      {!compact && <>
        <div className="tl-zoom" role="group" aria-label="How much time is shown">
          {zoom > 1 && <button className="tl-all" onClick={() => zoomTo(1)}>Show all of it</button>}
          <button className="icon-button" aria-label="Zoom the timeline out" title="Zoom out" disabled={zoom <= 1} onClick={() => zoomTo(zoom / 1.6)}><Icon name="minus" size={15} /></button>
          <button className="icon-button" aria-label="Zoom the timeline in" title="Zoom in (⌘ scroll, or double-click a conversation)" disabled={zoom >= sizes.zoom} onClick={() => zoomTo(zoom * 1.6)}><Icon name="plus" size={15} /></button>
        </div>
        <div className="tl-speed" role="group" aria-label="Replay speed">
          {[1, 2, 4].map(value => <button key={value} aria-pressed={speed === value} onClick={() => onSpeed(value)}>{value}×</button>)}
        </div>
        <button className={'graph-now' + (cursor === null ? ' on' : '')} aria-pressed={cursor === null} onClick={() => onCursor(null)}>{running ? <><span className="pulse-dot" aria-hidden="true" />Live</> : 'Now'}</button>
      </>}
    </div>
    <div ref={scroller} className={'tl-scroll' + (rows > shownRows ? ' tall' : '')} style={{ height: shownRows * sizes.row + sizes.axis + 2 }} onScroll={() => { setHover(null); pin(); }}>
      <div className="tl-plot" style={{ width: inner, height: Math.max(height, shownRows * sizes.row) + sizes.axis } as CSSProperties}>
        <div className={'tl-rows' + (onPick && hover?.band?.message ? ' can-pick' : '')} style={{ height: Math.max(height, shownRows * sizes.row) }} onPointerMove={point} onPointerLeave={() => setHover(null)} onClick={press}
          onDoubleClick={() => { if (!compact && hover) zoomPiece(hover.piece); }}>
          {layout.days.slice(1).map(d => <span key={d.at} className="tl-day" style={{ left: d.x }} aria-hidden="true" />)}
          {pieces.map(piece => {
            const brand = piece.track.who === 'conversation' ? brandOf(piece.track.agent) : null, from = Math.min(piece.x, piece.labelX), on = !!chosen && piece.bands.some(b => chosen.turns.has(b.id));
            const title = piece.track.title + ' · ' + plural(piece.bands.filter(b => b.message).length || piece.bands.length, piece.bands.some(b => b.message) ? 'message' : 'event') + ' · ' + plural(piece.steps, 'action');
            const name = <>{marked(piece.track) && (brand ? <BrandMark brand={brand} size={12} /> : <Icon name={piece.track.who === 'person' ? 'person' : 'chat'} size={12} />)}<span>{piece.track.title}</span></>;
            return <div key={piece.id} className={'tl-piece' + (on ? ' chosen' : '') + (hover?.piece.id === piece.id ? ' hot' : '')} data-who={piece.track.who} style={{ left: from, top: piece.row * sizes.row, width: Math.max(piece.x + piece.width, piece.labelX + piece.labelWidth) - from }}>
              {onPick && piece.track.who === 'conversation' && piece.bands.some(b => b.message)
                ? <button className="tl-name" style={{ maxWidth: piece.labelWidth }} title={title} onClick={e => { e.stopPropagation(); onPick({ conversation: piece.track.id }); }} onDoubleClick={e => { e.stopPropagation(); zoomPiece(piece); }}>{name}</button>
                : <span className="tl-name" style={{ maxWidth: piece.labelWidth }} title={title}>{name}</span>}
              {piece.bands.map(band => <span key={band.id} className={'tl-band' + (band.message ? ' message' : '') + (band.running ? ' running' : '') + (chosen?.turns.has(band.id) ? ' chosen' : '') + (hover?.band?.id === band.id ? ' hot' : '')}
                style={{ left: band.x - from, width: Math.max(2, band.width - 1) }} />)}
            </div>;
          })}
          <svg className="tl-columns" width={inner} height={height} aria-hidden="true">
            {drawn.paths.map(([kind, d]) => <path key={kind} className={'tl-col ' + kind} d={d} />)}
            {drawn.dots && <path className="tl-fails" d={drawn.dots} />}
          </svg>
          {chosenSpan && <span className="tl-span" style={{ left: chosenSpan.x, width: chosenSpan.width, top: chosenSpan.top }} aria-hidden="true" />}
          {cursor !== null && <span className="tl-veil" style={{ left: head, width: Math.max(0, inner - head) }} aria-hidden="true" />}
        </div>
        <span className="graph-head-line" style={{ left: Math.min(head, inner - 1), height: Math.max(height, shownRows * sizes.row) + 8 }}>{cursor !== null && <time className={head > inner - 80 ? 'left' : ''}>{clock(cursor, true)}</time>}</span>
        <div className="tl-axis" {...(compact ? { 'aria-hidden': true } : { role: 'slider', tabIndex: 0, 'aria-label': 'When', 'aria-valuemin': 0, 'aria-valuemax': blocks.length, 'aria-valuenow': index,
          'aria-valuetext': cursor === null ? 'Now · everything' : `${clock(cursor, true)} · ${index} of ${blocks.length}`, title: 'Drag to show the graph as it stood then', onPointerDown: scrub, onKeyDown: keys })}>
          {pinned && <b className="tl-pinned">{pinned}</b>}
          {layout.ticks.map(t => <span key={(t.day ? 'd' : 't') + t.at} className={(t.day ? 'day' : 'time') + (t.start ? ' start' : '')} style={{ left: t.x }}>{t.day ? day(t.at, years) : clock(t.at, t.seconds)}</span>)}
        </div>
      </div>
    </div>
    {tip}
  </Frame>;
}
