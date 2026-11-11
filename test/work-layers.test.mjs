import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkGraph, foldVersions, ranFiles } from '../dist/work-graph.js';
import { ancestors, buildWorkLayers, flows, lineFiles, links, shownAs, support, trajectory } from '../dist/work-layers.js';
import { layoutLayers } from '../dist/layers-layout.js';
import { notesMeaning } from '../dist/notes-meaning.js';

const root = '/work/project';
const kindOf = p => /\.(R|py)$/.test(p) ? 'code' : /\.(png|svg)$/.test(p) ? 'figures' : /^results\//.test(p) ? 'results' : /\.csv$/.test(p) ? 'data' : /\.md$/.test(p) ? 'notes' : null;
const at = s => new Date(Date.UTC(2026, 10, 11, 10, 0, s)).toISOString();
const tool = (id, name, s, detail, extra = {}) => ({ kind: 'tool', id, tool: name, at: at(s), detail, outcome: 'returned', ...extra });
const say = (s, text) => ({ kind: 'text', at: at(s), text });
const cell = (id, s) => tool(id, 'mcp__rho__rho_call', s, '', { operation: 'kernel.run' });
const turn = (id, text, sent, ended, steps, extra = {}) => ({ id, by: 'local', text, sentAt: at(sent), startedAt: at(sent), endedAt: at(ended), state: 'completed', steps, model: 'sonnet', ...extra });
const of = (conversationId, turns, title = conversationId) => turns.map(t => ({ conversationId, conversationTitle: title, agent: 'Claude Code', turn: t }));
function layers(turns, { files = [], notes = '', traces } = {}) {
  const graph = foldVersions(buildWorkGraph({ turns, files, project: { root }, kindOf, now: Date.parse(at(900)) }));
  const meanings = notesMeaning(notes);
  return { graph, meanings, layers: buildWorkLayers({ turns, graph, project: { root }, meanings, traces: traces?.(meanings), now: Date.parse(at(900)) }) };
}
const level = (l, name) => [...l.nodes.values()].filter(n => n.level === name);

test('a command runs the script it gives to a program, and only names one it reads', () => {
  const project = { root };
  assert.deepEqual([...ranFiles('Rscript analysis.R 2>&1 | tail -20', project)], ['analysis.R']);
  assert.deepEqual([...ranFiles('cd /work/project && uv run python fit.py --out results/fit.csv', project)], ['fit.py', 'results/fit.csv']);
  assert.deepEqual([...ranFiles('rtk read analysis.R | head -80 && cat fit.py', project)], []);
  const t = turn('t1', 'Look', 0, 9, [tool('w', 'Write', 2, root + '/analysis.R'), tool('c', 'Bash', 4, 'cat analysis.R | head'), tool('r', 'Bash', 6, 'Rscript analysis.R')]);
  const graph = buildWorkGraph({ turns: of('c1', [t]), files: [], project, kindOf, now: Date.parse(at(60)) });
  assert.deepEqual(graph.edges.filter(e => e.label === 'runs' || e.label === 'named').map(e => e.label + ' ' + graph.nodes.find(n => n.id === e.to).command), ['named cat analysis.R | head', 'runs Rscript analysis.R']);
});

test('a message is its activities: looking, a script written and run until it worked, the notes, the answer', () => {
  const steps = [
    tool('a', 'Read', 1, root + '/data/x.csv'), tool('b', 'Bash', 2, 'ls -la'),
    say(3, 'I will write the analysis script now. Then run it.'),
    tool('c', 'Write', 4, root + '/analysis.R'), tool('d', 'Bash', 6, 'Rscript analysis.R'),
    tool('e', 'Edit', 7, root + '/project-notes.md'),
    cell('f', 8),
    tool('g', 'Edit', 9, root + '/analysis.R'), tool('h', 'Bash', 11, 'Rscript analysis.R', { exitCode: 1, output: { text: 'Error', bytes: 5, lines: 1, cut: false } }),
    tool('i', 'Edit', 12, root + '/project-notes.md'), tool('j', 'Edit', 13, root + '/project-notes.md'), tool('k', 'Edit', 14, root + '/project-notes.md'),
    say(15, 'Done. Ozone rises until August.'),
  ];
  const { layers: l } = layers(of('c1', [turn('t1', 'How does ozone change?', 0, 16, steps)]));
  const ask = level(l, 'ask')[0], parts = ask.children.map(id => l.nodes.get(id));
  assert.deepEqual(parts.map(p => p.kind), ['look', 'build', 'notes', 'answer']);
  assert.deepEqual(parts.map(p => p.steps), [2, 7, 3, 1]);
  // The Agent's words open what follows them; one note and one cell between two edits of the script are part of it.
  assert.equal(parts[1].title, 'Wrote analysis.R and ran it twice');
  assert.equal(parts[1].said, 'I will write the analysis script now.');
  assert.equal(parts[1].rounds, 2);
  assert.equal(parts[1].failed, 1);
  assert.equal(parts[2].title, 'Updated the project notes');
  // Nothing of the record is left out, and every step is under exactly one activity.
  assert.equal(ask.steps, steps.length);
  assert.deepEqual(trajectory(l, l.root).map(s => s.key.replace(/-\d+$/, '')).filter(k => !k.startsWith('t-')), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']);
  assert.ok(level(l, 'step').every(s => l.nodes.get(s.parent).level === 'activity'));
});

test('cells in a row are an activity; a long look without words stands alone', () => {
  const steps = [tool('n', 'Edit', 1, root + '/project-notes.md'), ...[2, 3, 4, 5, 6, 7].map(s => tool('l' + s, 'Bash', s, 'ls data')), cell('c1', 8), cell('c2', 9), cell('c3', 10), tool('w', 'Write', 12, root + '/plot.R')];
  const { layers: l } = layers(of('c1', [turn('t1', 'Explore', 0, 14, steps)]));
  const parts = level(l, 'ask')[0].children.map(id => l.nodes.get(id));
  assert.deepEqual(parts.map(p => p.kind + ':' + p.steps), ['notes:1', 'look:6', 'cells:3', 'build:1']);
  assert.equal(parts[0].title, 'Began the project notes');
  assert.equal(parts[2].title, 'Ran 3 cells in the live session');
});

const notes = `# Project notes

## Ozone over the summer
<!-- rho:session c1 -->

### Question

How does ozone change by month?

### Key results

- Ozone peaks in July and August. See [results/monthly.csv](results/monthly.csv).
- The trend is clear by eye.

### Choices

- Chose the mean over the median. See [results/monthly.csv](results/monthly.csv).
`;

test('lines of work: a section of the notes names one, shared files join conversations, and a line builds on another', () => {
  const notesStep = tool('n1', 'Edit', 8, root + '/project-notes.md');
  const c1 = of('c1', [turn('t1', 'How does ozone change by month?', 0, 10, [tool('r', 'Read', 1, root + '/data/air.csv'), tool('w', 'Write', 3, root + '/analysis.R'), tool('x', 'Bash', 5, 'Rscript analysis.R'), notesStep],
    { files: { changed: [{ path: 'results/monthly.csv', change: 'added', modifiedAt: at(5), bytes: 90 }], omitted: 0, partial: false },
      evidence: { records: [{ key: 'tool:n1:project-notes.md', path: 'project-notes.md', phase: 'tool:n1', requestedAt: at(8), state: 'captured', snapshots: [{ resource: { id: 'a'.repeat(64), version: 'b'.repeat(64) }, kind: 'file', bytes: 10, observedAt: at(8), source: { kind: 'disk' } }] }], omitted: 0, bytes: 10, snapshots: 1 } })], 'Ozone');
  const c2 = of('c2', [turn('t1', 'Plot the monthly means', 20, 30, [tool('r2', 'Read', 21, root + '/results/monthly.csv'), tool('w2', 'Write', 23, root + '/plot.R'), tool('x2', 'Bash', 25, 'Rscript plot.R')],
    { files: { changed: [{ path: 'results/plot.png', change: 'added', modifiedAt: at(25), bytes: 900 }], omitted: 0, partial: false } })], 'Plot');
  const c3 = of('c3', [turn('t1', 'Tidy the plot script', 40, 45, [tool('e3', 'Edit', 42, root + '/plot.R')])], 'Tidy');
  const c4 = of('c4', [turn('t1', 'What is this project?', 50, 52, [say(51, 'An ozone analysis.')])], 'Asked');
  const files = [{ path: 'results/monthly.csv', bytes: 90, modifiedAt: at(5), category: 'results' }, { path: 'results/plot.png', bytes: 900, modifiedAt: at(25), category: 'figures' }, { path: 'data/air.csv', bytes: 50, modifiedAt: at(-100), category: 'data' }];
  const { layers: l, graph } = layers([...c1, ...c2, ...c3, ...c4], { files, notes,
    traces: meanings => new Map(meanings[0].statements.map(s => [s, { written: { at: Date.parse(at(8)), turn: 'c1/t1', conversationId: 'c1', version: 1, of: 1 }, files: [] }])) });
  const lines = l.nodes.get(l.root).children.map(id => l.nodes.get(id));
  assert.deepEqual(lines.map(x => [x.title, x.children.length, !!x.quiet]), [['Ozone over the summer', 1, false], ['Plot', 2, false], ['Asked', 1, true]]);
  assert.equal(lines[0].said, 'How does ozone change by month?');
  // The plot line used what the ozone line made: one line builds on the other, through that file.
  assert.deepEqual(flows(l).map(f => [l.nodes.get(f.from).title, l.nodes.get(f.to).title, f.paths]), [['Ozone over the summer', 'Plot', ['results/monthly.csv']]]);
  assert.deepEqual(lineFiles(l, lines[0].id), { used: [{ path: 'data/air.csv', from: null, at: Date.parse(at(1)) }], made: [{ path: 'analysis.R', existing: false, from: null, at: Date.parse(at(3)) }, { path: 'results/monthly.csv', existing: false, from: null, at: Date.parse(at(5)) }] });
  // What the notes conclude stands on the record through the files it names.
  assert.deepEqual(l.claims.map(c => [c.kind, c.ground, c.paths]), [['finding', 'made', ['results/monthly.csv']], ['finding', 'none', []], ['choice', 'made', ['results/monthly.csv']]]);
  const wrote = l.nodes.get(l.claims[0].written);
  assert.equal(wrote.title, 'Edited project-notes.md');
  const behind = support(l, l.claims[0].paths);
  assert.deepEqual([...behind.paths].sort(), ['analysis.R', 'results/monthly.csv']);
  assert.deepEqual([...behind.work].map(id => l.nodes.get(id).title).sort(), ['Ran Rscript analysis.R', 'Wrote analysis.R']);
  assert.ok([...behind.work].every(id => ancestors(l, id).includes(lines[0].id)), 'the work behind a statement of one line stays in that line');
  // A link is carried up to the node on screen: closed, the line stands for all its steps.
  const closed = links(l, new Set());
  assert.deepEqual(closed.filter(k => k.work === lines[0].id).map(k => [k.path, k.makes, k.n]).sort(), [['analysis.R', true, 2], ['data/air.csv', false, 1], ['results/monthly.csv', true, 1]]);
  const step = [...l.nodes.values()].find(n => n.title === 'Ran Rscript analysis.R');
  assert.equal(shownAs(l, step.id, new Set()), lines[0].id);
  assert.equal(shownAs(l, step.id, new Set([lines[0].id])), step.parent && l.nodes.get(step.parent).parent);
  assert.equal(shownAs(l, step.id, new Set(ancestors(l, step.id))), step.id);
  assert.ok(graph.nodes.length > 0);

  // The page: closed, one card a line; open, a frame whose parts do not overlap and stay inside it.
  const top = layoutLayers(l, new Set());
  assert.deepEqual(top.items.filter(i => i.kind === 'line').map(i => l.nodes.get(i.ref).title), ['Ozone over the summer', 'Plot', 'Asked']);
  assert.deepEqual(top.wires.map(w => w.kind + ':' + w.label), ['flow:builds on 1 file']);
  const everything = new Set(l.nodes.keys()), scene = layoutLayers(l, everything, { figure: p => p.endsWith('.png') });
  const frames = scene.items.filter(i => i.kind === 'frame');
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    const inside = scene.items.filter(i => i.line === frame.id && i.kind !== 'frame' && i.kind !== 'label');
    for (const i of inside) assert.ok(i.x >= frame.x && i.y >= frame.y && i.x + i.width <= frame.x + frame.width && i.y + i.height <= frame.y + frame.height, i.id + ' lies inside its frame');
    for (const a of inside) for (const b of inside) if (a !== b && a.column === b.column && a.kind !== 'ask' && b.kind !== 'ask') assert.ok(a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x, a.id + ' and ' + b.id + ' do not overlap');
  }
  const ids = new Set(scene.items.map(i => i.id));
  assert.ok(scene.wires.every(w => ids.has(w.from) && ids.has(w.to)), 'every line joins two things that are drawn');
  assert.ok(scene.items.filter(i => i.kind === 'step').length === level(l, 'step').length, 'opened all the way, every recorded step is drawn');
  assert.equal(scene.items.find(i => i.kind === 'file' && i.ref === 'results/plot.png').figure, true);
});

test('the shipped example: 3 lines of work over every recorded step, each finding tied to the steps that made its files', () => {
  const project = path.resolve('example/pa14-qs'), dir = path.join(project, '.rho/rho/conversations');
  const turns = [], files = [];
  (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.rho' || e.name === '.git') continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else files.push({ path: r, bytes: fs.statSync(path.join(d, e.name)).size, category: /^data\//.test(r) ? 'data' : kindOf(r) }); } })(project, '');
  let recorded = 0;
  for (const f of fs.readdirSync(dir).filter(f => /^c-/.test(f))) { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); for (const t of c.turns) { recorded += t.steps.length; turns.push({ conversationId: c.id, conversationTitle: c.agentTitle || c.title, agent: 'Claude Code', turn: t }); } }
  // The records name files by the folder the example was recorded in.
  const recordedRoot = turns.flatMap(t => t.turn.steps).map(s => /^(\/.*?)\/(?:analysis|results|data)\//.exec(s.detail ?? '')?.[1]).find(Boolean) ?? project;
  const graph = foldVersions(buildWorkGraph({ turns, files, project: { root: recordedRoot }, kindOf: p => /^data\//.test(p) ? 'data' : kindOf(p), now: Date.now() }));
  const l = buildWorkLayers({ turns, graph, project: { root: recordedRoot }, meanings: notesMeaning(fs.readFileSync(path.join(project, 'project-notes.md'), 'utf8')), now: Date.now() });
  const lines = l.nodes.get(l.root).children.map(id => l.nodes.get(id));
  assert.equal(lines.filter(x => !x.quiet).length, 3);
  assert.equal(trajectory(l, l.root).length, recorded, 'every recorded step is in the graph');
  assert.equal(l.nodes.get(l.root).steps, recorded);
  assert.ok(level(l, 'activity').length < recorded / 4, 'activities stand for many steps each');
  assert.ok(Math.max(...level(l, 'activity').map(a => a.steps)) <= 40, 'no activity swallows a whole long message');
  const built = flows(l).map(f => l.nodes.get(f.from).title.split(/[ :]/)[0] + '>' + l.nodes.get(f.to).title.split(/[ :]/)[0]).sort();
  assert.deepEqual(built, ['Co-culture>RNA-seq', 'Swarming>RNA-seq']);
  const named = l.claims.filter(c => c.paths.length);
  assert.ok(named.length >= 25 && named.every(c => c.ground === 'made'), 'each statement that names a file names one a recorded step made');
  for (const c of named) { const behind = support(l, c.paths); assert.ok(behind.work.size > 0 && behind.work.size <= 40, c.text.slice(0, 40) + ': ' + behind.work.size + ' steps behind it'); assert.ok([...behind.work].every(id => ancestors(l, id).includes(c.line)), 'the work behind it is in its own line'); }
});
