import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTimeline, timeScale, timelineSizes } from '../dist/timeline-layout.js';

const hour = 3600e3, day = 24 * hour, t0 = new Date(2026, 10, 8, 9, 0, 0).getTime();
const measure = track => track.title.length * 7;
const talk = (id, title, bands) => ({ id, title, agent: 'Claude Code', who: 'conversation', bands: bands.map(([start, end], i) => ({ id: id + '/m' + i, start: t0 + start, end: t0 + end, message: true })) });
const marks = (track, from, to, n, kind = 'run', failed = false) => Array.from({ length: n }, (_, i) => ({ key: track + ':' + kind + ':' + from + ':' + i, at: t0 + from + (to - from) * (i + 0.5) / n, track, kind, failed }));

test('time is drawn where work happened: pauses fold, and the strip is exactly as wide as asked', () => {
  const spans = [{ start: t0, end: t0 + hour }, { start: t0 + 2 * hour, end: t0 + 3 * hour }, { start: t0 + day, end: t0 + day + hour }];
  const scale = timeScale(spans, [], 1000);
  assert.equal(scale.stretches.length, 3);
  assert.equal(scale.pauses.length, 2);
  // An hour's pause folds narrower than a night's, and both far narrower than an hour of work.
  assert.ok(scale.pauses[0].width < scale.pauses[1].width && scale.pauses[1].width < 20);
  assert.ok(Math.abs(scale.stretches.at(-1).x + scale.stretches.at(-1).width - 1000) < 0.01);
  // A moment goes to its place and back; one inside a pause is drawn where work begins again.
  const at = t0 + 2.5 * hour;
  assert.ok(Math.abs(scale.fromX(scale.toX(at)) - at) < 1000);
  assert.equal(scale.toX(t0 + 1.5 * hour), scale.stretches[1].x);
  // Work 20 s after other work is the same stretch.
  assert.equal(timeScale([{ start: t0, end: t0 + 60e3 }, { start: t0 + 80e3, end: t0 + 120e3 }], [], 500).stretches.length, 1);
});

test('a stretch with many steps is drawn wider than a longer one with few', () => {
  const spans = [{ start: t0, end: t0 + 10 * 60e3 }, { start: t0 + hour, end: t0 + 3 * hour }];
  const scale = timeScale(spans, marks('a', 0, 10 * 60e3, 400), 1000);
  assert.equal(scale.stretches[0].steps, 400);
  assert.ok(scale.stretches[0].width > scale.stretches[1].width);
});

test('conversations held one after another share a row; ones that overlap do not', () => {
  const tracks = [talk('a', 'First', [[0, hour]]), talk('b', 'Second', [[2 * hour, 3 * hour]]), talk('c', 'Third', [[4 * hour, 5 * hour]]), talk('d', 'Beside the second', [[2.2 * hour, 2.8 * hour]])];
  const layout = layoutTimeline({ tracks, marks: [], width: 1200, measure });
  const row = id => layout.pieces.find(p => p.track.id === id).row;
  assert.equal(layout.rows, 2);
  assert.deepEqual([row('a'), row('b'), row('c')], [0, 0, 0]);
  assert.equal(row('d'), 1);
  // No two pieces of one row touch, names included.
  for (const a of layout.pieces) for (const b of layout.pieces) if (a !== b && a.row === b.row && a.x < b.x)
    assert.ok(a.x + a.width < Math.min(b.x, b.labelX) && a.labelX + a.labelWidth + timelineSizes.gap <= Math.min(b.x, b.labelX) + 0.01, a.track.title + ' ends before ' + b.track.title + ' begins');
});

test('sixteen conversations in a row need a few rows, not sixteen', () => {
  const tracks = Array.from({ length: 16 }, (_, i) => talk('c' + i, 'Conversation number ' + i, [[i * 3 * hour, i * 3 * hour + hour]]));
  const layout = layoutTimeline({ tracks, marks: tracks.flatMap((t, i) => marks(t.id, i * 3 * hour, i * 3 * hour + hour, 120)), width: 1500, measure });
  assert.equal(layout.pieces.length, 16);
  assert.ok(layout.rows <= timelineSizes.rows, layout.rows + ' rows');
  // Every conversation keeps a name, shortened before the strip takes more rows than it shows.
  assert.ok(layout.pieces.every(p => p.labelWidth >= 40));
});

test('a conversation taken up again after other work is a second piece under the same name', () => {
  const tracks = [talk('a', 'Resumed', [[0, hour], [1.1 * hour, 2 * hour], [3 * day, 3 * day + hour]]), talk('b', 'Between', [[day, day + 6 * hour]]), talk('c', 'Also between', [[2 * day, 2 * day + 6 * hour]])];
  const layout = layoutTimeline({ tracks, marks: [...marks('b', day, day + 6 * hour, 300), ...marks('c', 2 * day, 2 * day + 6 * hour, 300)], width: 1400, measure });
  const pieces = layout.pieces.filter(p => p.track.id === 'a');
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces.map(p => p.bands.length), [2, 1]);
});

test('every step is in a column of its conversation, counted by kind, with its failures', () => {
  const tracks = [talk('a', 'Work', [[0, hour]]), talk('b', 'Other', [[2 * hour, 3 * hour]])];
  const all = [...marks('a', 0, hour, 90, 'run'), ...marks('a', 0, hour, 30, 'edit'), ...marks('a', 0, hour, 6, 'read', true), ...marks('b', 2 * hour, 3 * hour, 10, 'run'),
    { key: 'ask', at: t0, track: 'a', kind: 'ask', failed: false }, { key: 'answer', at: t0 + hour, track: 'a', kind: 'answer', failed: false }];
  const layout = layoutTimeline({ tracks, marks: all, width: 900, measure });
  const a = layout.pieces.find(p => p.track.id === 'a'), b = layout.pieces.find(p => p.track.id === 'b');
  const sum = (piece, kind) => piece.columns.reduce((n, c) => n + (c.parts.find(p => p[0] === kind)?.[1] ?? 0), 0);
  assert.deepEqual([sum(a, 'run'), sum(a, 'edit'), sum(a, 'read'), sum(b, 'run')], [90, 30, 6, 10]);
  assert.equal(a.steps, 126); assert.equal(a.failed, 6); assert.equal(b.steps, 10);
  // Asking and answering are a message's two ends, not steps in a column.
  assert.equal(a.columns.reduce((n, c) => n + c.total, 0), 126);
  assert.equal(layout.peak, Math.max(...layout.pieces.flatMap(p => p.columns.map(c => c.total))));
  // A column names its steps: each mark's place in the list given.
  const named = a.columns.flatMap(c => c.marks);
  assert.equal(new Set(named).size, 126);
  assert.ok(named.every(i => all[i].track === 'a'));
  // Stacked from the foot up: commands, then edits, then reads.
  const mixed = a.columns.find(c => c.parts.length === 3);
  assert.deepEqual(mixed.parts.map(p => p[0]), ['run', 'edit', 'read']);
});

test('the axis names each day that has work, and times do not run into each other', () => {
  const tracks = [talk('a', 'Day one', [[0, 4 * hour]]), talk('b', 'Day two', [[day, day + 4 * hour]]), talk('c', 'Day four', [[3 * day, 3 * day + 4 * hour]])];
  const layout = layoutTimeline({ tracks, marks: [], width: 1200, measure });
  const days = layout.ticks.filter(t => t.day).map(t => new Date(t.at).getDate());
  assert.deepEqual(days, [8, 9, 11]);
  assert.deepEqual(layout.days.map(d => new Date(d.at).getDate()), [8, 9, 11]);
  const boxes = layout.ticks.map(t => t.day ? [t.x, t.x + timelineSizes.day] : t.start ? [t.x, t.x + timelineSizes.tick] : [t.x - timelineSizes.tick / 2, t.x + timelineSizes.tick / 2]).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], 'label ' + i + ' begins after the one before it ends');
  assert.ok(layout.ticks.some(t => !t.day));
});

test('nothing to draw is an empty strip', () => {
  const layout = layoutTimeline({ tracks: [], marks: [], width: 800, measure });
  assert.deepEqual([layout.pieces.length, layout.rows, layout.ticks.length, layout.peak], [0, 0, 0, 0]);
});
