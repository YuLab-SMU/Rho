import type { Who } from './timeline-events.js';

// The work over time, laid out for one strip of a given width: what the Graph's timeline and the
// Overview's glance draw. Time is drawn where something happened, and a pause between two
// stretches of work folds to a short gap. A conversation is a piece of the strip with its name
// on it, and pieces that do not overlap share a row, so sixteen conversations held one after
// another are one or two rows, not sixteen. A conversation taken up again after other work is
// a second piece under the same name. Steps are counted in narrow columns by kind: a thousand
// commands are a profile of how busy the work was, and a piece drawn wide enough shows each step
// as a column of its own. Nothing is left out: every step is in a column and every column can
// name its steps.

// A message from when it was sent until its answer ended, or one event a plugin recorded.
export interface TimelineBand { id: string; start: number; end: number; running?: boolean; message?: boolean }
export interface TimelineTrack { id: string; title: string; agent: string; who: Who; bands: TimelineBand[] }
export interface TimelineMark { key: string; at: number; track: string; kind: string; failed: boolean }

// The kinds a column stacks, from its foot up. Asking and answering are a message's two ends.
export const columnKinds = ['run', 'edit', 'read', 'changed', 'capture'] as const;
export const timelineSizes = {
  // A pause longer than this folds. How wide the fold is says roughly how long the pause was;
  // all the folds together take no more than this share of the strip.
  fold: 30000, pauses: [[600e3, 4], [7200e3, 7], [43200e3, 10], [Infinity, 14]] as ReadonlyArray<readonly [number, number]>, pauseShare: 0.3,
  // One column of steps, and the room between a conversation's messages past which it is two pieces.
  column: 4, split: 64,
  // The room a name may take beside its mark, tried widest first; between two pieces in a row.
  labels: [200, 140, 96], gap: 14,
  // The page is the protected resource: past this many rows the strip keeps its height and the
  // rows scroll inside it. Names give way first (labels above), and nothing is left out.
  rows: 4,
  // The room a time and a date need on the axis.
  tick: 34, day: 52, tickGap: 26,
};
const S = timelineSizes;

export interface Stretch { start: number; end: number; x: number; width: number; steps: number }
export interface Pause { x: number; width: number; from: number; to: number }
export interface TimeScale { stretches: Stretch[]; pauses: Pause[]; width: number; toX: (at: number) => number; fromX: (x: number) => number }

// Where a moment is drawn. Each stretch of work is wide enough for its steps before the rest is
// shared by how long it lasted, so a minute of commands beside days of messages stays readable.
export function timeScale(spans: ReadonlyArray<{ start: number; end: number }>, marks: ReadonlyArray<{ at: number }>, width: number): TimeScale {
  const stretches: Stretch[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = stretches.at(-1);
    if (last && s.start <= last.end + S.fold) last.end = Math.max(last.end, s.end);
    else stretches.push({ start: s.start, end: Math.max(s.end, s.start + 1000), x: 0, width: 0, steps: 0 });
  }
  let at = 0;
  for (const m of [...marks].sort((a, b) => a.at - b.at)) {
    while (at < stretches.length - 1 && m.at > stretches[at]!.end && m.at >= stretches[at + 1]!.start) at++;
    if (stretches[at]) stretches[at]!.steps++;
  }
  const raw = stretches.slice(1).map((s, i) => { const length = s.start - stretches[i]!.end; return S.pauses.find(([most]) => length <= most)![1]; });
  const folds = raw.reduce((a, b) => a + b, 0), shrink = folds > width * S.pauseShare ? width * S.pauseShare / folds : 1;
  const gaps = raw.map(w => w * shrink), usable = Math.max(0, width - gaps.reduce((a, b) => a + b, 0));
  const weights = stretches.map(s => 14 + 6 * Math.sqrt(s.steps) + 0.5 * Math.sqrt((s.end - s.start) / 1000)), total = weights.reduce((a, b) => a + b, 0) || 1;
  const pauses: Pause[] = [];
  let x = 0;
  stretches.forEach((s, i) => {
    s.x = x; s.width = usable * weights[i]! / total; x += s.width;
    if (i < stretches.length - 1) { pauses.push({ x, width: gaps[i]!, from: s.end, to: stretches[i + 1]!.start }); x += gaps[i]!; }
  });
  // The stretch a moment is in, or the next one when it falls in a pause.
  const stretchAt = (moment: number) => { let low = 0, high = stretches.length - 1; while (low < high) { const mid = (low + high) >> 1; if (stretches[mid]!.end >= moment) high = mid; else low = mid + 1; } return stretches[low]; };
  const toX = (moment: number) => { const s = stretchAt(moment); return s ? s.x + Math.min(1, Math.max(0, (moment - s.start) / (s.end - s.start))) * s.width : 0; };
  const fromX = (px: number) => {
    for (let i = stretches.length - 1; i >= 0; i--) { const s = stretches[i]!; if (px >= s.x) return s.start + Math.min(1, Math.max(0, (px - s.x) / (s.width || 1))) * (s.end - s.start); }
    return stretches[0]?.start ?? 0;
  };
  return { stretches, pauses, width, toX, fromX };
}

export interface PlacedBand extends TimelineBand { x: number; width: number }
// The steps one column stands for: how many of each kind, how many were refused, failed or have
// no known outcome, and which they are, as places in the marks given.
export interface Column { x: number; total: number; failed: number; parts: Array<[kind: string, n: number]>; marks: number[] }
export interface Piece { id: string; track: TimelineTrack; x: number; width: number; row: number; labelX: number; labelWidth: number; bands: PlacedBand[]; columns: Column[]; steps: number; failed: number }
// A label on the axis: a date where a day begins, or a time. `start`: the label begins at x;
// otherwise it is centred on x.
export interface Tick { at: number; x: number; day: boolean; seconds: boolean; start: boolean }
export interface TimelineLayout { scale: TimeScale; pieces: Piece[]; rows: number; peak: number; ticks: Tick[]; days: Array<{ at: number; x: number }> }

const tickSteps = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 21600e3];
const nextDay = (at: number) => { const d = new Date(at); d.setHours(24, 0, 0, 0); return d.getTime(); };

// `measure` says how wide a track's name is as it will be drawn, with whatever stands before it.
export function layoutTimeline(input: { tracks: readonly TimelineTrack[]; marks: readonly TimelineMark[]; width: number; measure: (track: TimelineTrack) => number; rows?: number }): TimelineLayout {
  const { tracks, marks, width } = input, most = input.rows ?? S.rows;
  const scale = timeScale(tracks.flatMap(t => t.bands), marks, width);

  // Each conversation's pieces: its messages in order, a new piece where other work or a long
  // pause leaves more than `split` of the strip between two of them.
  const pieces: Piece[] = [], byTrack = new Map<string, Piece[]>();
  for (const track of tracks) {
    const own: Piece[] = [];
    for (const band of [...track.bands].sort((a, b) => a.start - b.start)) {
      const x = scale.toX(band.start), placed = { ...band, x, width: Math.max(S.column, scale.toX(band.end) - x) };
      const last = own.at(-1);
      if (last && placed.x - (last.x + last.width) <= S.split) { last.bands.push(placed); last.width = Math.max(last.width, placed.x + placed.width - last.x); }
      else own.push({ id: track.id + '#' + own.length, track, x, width: placed.width, row: 0, labelX: x, labelWidth: 0, bands: [placed], columns: [], steps: 0, failed: 0 });
    }
    byTrack.set(track.id, own); pieces.push(...own);
  }

  // Every step in the column it falls in, in the piece of its conversation it falls in or is nearest to.
  let peak = 0;
  for (const piece of pieces) piece.columns = Array.from({ length: Math.max(1, Math.ceil(piece.width / S.column)) }, (_, i) => ({ x: piece.x + i * S.column, total: 0, failed: 0, parts: [], marks: [] }));
  marks.forEach((mark, index) => {
    const own = byTrack.get(mark.track);
    if (!own?.length || mark.kind === 'ask' || mark.kind === 'answer') return;
    const x = scale.toX(mark.at), off = (p: Piece) => x < p.x ? p.x - x : x > p.x + p.width ? x - p.x - p.width : 0;
    const piece = own.reduce((best, p) => off(p) < off(best) ? p : best), column = piece.columns[Math.min(piece.columns.length - 1, Math.max(0, Math.floor((x - piece.x) / S.column)))]!;
    const kind = (columnKinds as readonly string[]).includes(mark.kind) ? mark.kind : 'read', part = column.parts.find(p => p[0] === kind);
    if (part) part[1]++; else column.parts.push([kind, 1]);
    column.total++; column.marks.push(index); piece.steps++;
    if (mark.failed) { column.failed++; piece.failed++; }
    peak = Math.max(peak, column.total);
  });
  for (const piece of pieces) for (const column of piece.columns) column.parts.sort((a, b) => columnKinds.indexOf(a[0] as typeof columnKinds[number]) - columnKinds.indexOf(b[0] as typeof columnKinds[number]));

  // Rows: each piece in the first row with room for its mark and its name. Names take less room
  // before the strip takes more rows than it shows at once.
  pieces.sort((a, b) => a.x - b.x || (a.track.who === 'person' ? -1 : 0) - (b.track.who === 'person' ? -1 : 0));
  const named = new Map(tracks.map(t => [t.id, input.measure(t)]));
  let rows = 0;
  for (const cap of S.labels) {
    const ends: number[] = [];
    for (const piece of pieces) {
      piece.labelWidth = Math.min(cap, named.get(piece.track.id) ?? cap);
      piece.labelX = Math.max(0, Math.min(piece.x, width - piece.labelWidth));
      // Two marks may stand a hairline apart, as two messages do; a name needs room before the next piece.
      const from = Math.min(piece.x, piece.labelX), to = Math.max(piece.x + piece.width + 1.5, piece.labelX + piece.labelWidth + S.gap);
      let row = ends.findIndex(end => end <= from);
      if (row < 0) row = ends.length;
      ends[row] = to; piece.row = row;
    }
    rows = ends.length;
    if (rows <= most) break;
  }
  // A name takes the room its row has left before the next piece, up to its whole length.
  for (let row = 0; row < rows; row++) {
    const inRow = pieces.filter(p => p.row === row);
    inRow.forEach((piece, i) => {
      const next = inRow[i + 1], room = (next ? Math.min(next.x, next.labelX) - S.gap : width) - piece.labelX;
      piece.labelWidth = Math.max(piece.labelWidth, Math.min(named.get(piece.track.id) ?? 0, room));
    });
  }

  // The axis: where each day begins, then times at the shortest step that leaves room between labels.
  const days: Array<{ at: number; x: number }> = [], ticks: Tick[] = [], first = scale.stretches[0], last = scale.stretches.at(-1);
  if (first && last) {
    days.push({ at: first.start, x: 0 });
    for (let midnight = nextDay(first.start); midnight <= last.end; midnight = nextDay(midnight)) {
      const pause = scale.pauses.find(p => p.from < midnight && midnight <= p.to);
      // A day with no work in it has no place on the strip; the next day with work begins there.
      const x = pause ? pause.x + pause.width / 2 : scale.toX(midnight), at = pause ? pause.to : midnight;
      const known = days.at(-1)!;
      if (x - known.x < 1) known.at = at; else days.push({ at, x });
    }
    // A date is kept when it has room before the next day begins; a time, when it is clear of
    // every label already kept.
    const taken: Array<[number, number]> = [];
    const keep = (tick: Tick, from: number, to: number, room: number) => { if (from < 0 || to > width + 1 || taken.some(([a, b]) => to + room > a && from - room < b)) return; taken.push([from, to]); ticks.push(tick); };
    days.forEach((d, i) => { if (i === days.length - 1 || d.x + S.day + 8 <= days[i + 1]!.x) keep({ at: d.at, x: d.x, day: true, seconds: false, start: true }, d.x, d.x + S.day, 0); });
    for (const s of scale.stretches) {
      const length = s.end - s.start, step = tickSteps.find(t => s.width * t / length >= S.tick + S.tickGap) ?? tickSteps.at(-1)!, seconds = step < 60e3, size = seconds ? S.tick * 1.5 : S.tick;
      keep({ at: s.start, x: s.x, day: false, seconds, start: true }, s.x, s.x + size, S.tickGap);
      for (let t = Math.ceil(s.start / step) * step; t < s.end; t += step) { const x = scale.toX(t); if (s.x + s.width - x >= size / 2) keep({ at: t, x, day: false, seconds, start: false }, x - size / 2, x + size / 2, S.tickGap); }
    }
    ticks.sort((a, b) => a.x - b.x);
  }
  return { scale, pieces, rows, peak, ticks, days };
}
