import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesMeaning, fileDescriptions, traceStatement, plainText, notesPath } from '../dist/notes-meaning.js';
import { meaningLayer, layered } from '../dist/meaning-graph.js';
import { buildWorkGraph, foldVersions } from '../dist/work-graph.js';
import { holdsOf, modelName } from '../dist/file-describer.js';

const notes = [
  '# Project notes',
  '',
  '## Plates by strain',
  '<!-- rho:session c-1 -->',
  '',
  '### Question',
  'Which strains differ from the reference?',
  '',
  '### Data & method',
  '- [data/plates.csv](data/plates.csv) — one row per plate',
  '- [analysis.py](analysis.py) — reads [data/plates.csv](data/plates.csv) and tests each strain',
  '',
  '### Key results',
  '- Four strains differ ([results/tests.csv](results/tests.csv))',
  '![Area by strain](results/figure.png)',
  '- Strain 98 is the most different, see `results/summary_by_strain.csv`',
  '',
  '![All plates](results/plates.png)',
  '',
  '### Choices',
  '- Dunnett against the reference:',
  '  four strains differ ([results/tests.csv](results/tests.csv))',
  '  - Alternative: Holm-corrected t-tests give three',
  '    ([results/alt_holm.csv](results/alt_holm.csv))',
  '',
  '### Files',
  '- [results/tests.csv](results/tests.csv) — one row per strain with its p-value',
  '- [results/summary_by_strain.csv](results/summary_by_strain.csv): mean and SD',
  '  per strain',
  '',
  '### To do',
  '- [x] Read the plates',
  '- [ ] Check the dried plates',
  '',
  '```markdown',
  '### Key results',
  '- Not a finding',
  '```',
  '',
  '## 第二个问题',
  '<!-- rho:session c-2 -->',
  '### 关键结果',
  '- 结果写在 [results/b.csv](results/b.csv)',
].join('\n');

test('a section reads as its question, method, findings, figures, choices, files and to-dos, each with the files it links', () => {
  const [one, two] = notesMeaning(notes);
  assert.equal(one.conversationId, 'c-1');
  assert.deepEqual(one.statements.map(s => [s.kind, s.links]), [
    ['question', []],
    ['method', ['data/plates.csv']],
    ['method', ['analysis.py', 'data/plates.csv']],
    ['finding', ['results/tests.csv']],
    ['figure', ['results/figure.png']],
    ['finding', ['results/summary_by_strain.csv']],
    ['figure', ['results/plates.png']],
    ['choice', ['results/tests.csv']],
    ['file', ['results/tests.csv']],
    ['file', ['results/summary_by_strain.csv']],
    ['todo', []],
    ['todo', []],
  ]);
  const figure = one.statements[4], apart = one.statements[6];
  assert.equal(figure.of, 3, 'a figure on the line after a finding shows that finding');
  assert.equal(apart.of, undefined, 'a figure after a blank line belongs to the section');
  const choice = one.statements[7];
  assert.equal(choice.text, 'Dunnett against the reference: four strains differ (results/tests.csv)');
  assert.deepEqual(choice.alternatives, [{ text: 'Holm-corrected t-tests give three (results/alt_holm.csv)', source: '- Alternative: Holm-corrected t-tests give three\n([results/alt_holm.csv](results/alt_holm.csv))', links: ['results/alt_holm.csv'] }], 'an option keeps the lines that continue it');
  assert.deepEqual(one.statements.filter(s => s.kind === 'todo').map(s => s.done), [true, false]);
  assert.deepEqual(two.statements.map(s => [s.kind, s.links]), [['finding', ['results/b.csv']]], 'headings in another language');
});

test('what a file holds comes from Files first, then a figure, then the method that names it first', () => {
  const said = fileDescriptions(notesMeaning(notes));
  assert.equal(said.get('results/tests.csv').text, 'one row per strain with its p-value');
  assert.equal(said.get('results/summary_by_strain.csv').text, 'mean and SD per strain', 'an underscore in a name is not emphasis');
  assert.equal(said.get('results/figure.png').text, 'Area by strain');
  assert.equal(said.get('data/plates.csv').text, 'one row per plate');
  assert.equal(said.get('analysis.py').text, 'reads data/plates.csv and tests each strain');
  assert.equal(plainText('**Q1:** see _this_ and `a_b.csv` in snake_case_name'), 'Q1: see this and a_b.csv in snake_case_name');
  assert.equal(plainText('- **q5 — ratio `5:1` is closest**: `**kept**`'), 'q5 — ratio 5:1 is closest: **kept**', 'bold across a code span, and marks inside code kept');
  assert.equal(notesPath('https://example.org/x.csv'), null);
  assert.equal(notesPath('../outside.csv'), null);
  assert.equal(notesPath('results/'), null);
  assert.equal(notesPath('./results/a%20b.csv#top'), 'results/a b.csv');
});

test('a statement is traced to the first kept version of the notes that holds it, and its files to their versions then', () => {
  const finding = notesMeaning(notes)[0].statements[3];
  const versions = [
    { text: notes.replace('- Four strains differ ([results/tests.csv](results/tests.csv))', '- Three strains differ'), at: 1000, turn: 'c-1/t1', conversationId: 'c-1', resource: { id: 'n', version: '1' } },
    { text: notes, at: 5000, turn: 'c-1/t2', conversationId: 'c-1', resource: { id: 'n', version: '2' } },
  ];
  const kept = path => path === 'results/tests.csv' ? [{ at: 4000, resource: { id: 't', version: 'a' } }, { at: 9000, resource: { id: 't', version: 'b' } }] : [];
  const trace = traceStatement(finding, versions, kept, () => null);
  assert.deepEqual(trace.written, { at: 5000, turn: 'c-1/t2', conversationId: 'c-1', version: 2, of: 2 });
  assert.deepEqual(trace.files, [{ path: 'results/tests.csv', kept: { at: 4000, resource: { id: 't', version: 'a' } }, later: 'kept' }], 'written about a version that has since changed');
  assert.equal(traceStatement(finding, versions, path => kept(path).slice(0, 1), () => 9000).files[0].later, 'written', 'only the file on disk was written again');
  const same = path => [{ at: 4000, resource: { id: 't1', version: 'a' } }, { at: 9000, resource: { id: 't2', version: 'a' } }];
  assert.equal(traceStatement(finding, versions, same, () => 9000).files[0].later, false, 'kept again with the same bytes, and written no later than that');
  const outside = traceStatement({ source: '- Written by the person', links: [] }, versions, kept, () => null);
  assert.equal(outside.written, null);
});

const root = '/work/project';
const kindOf = path => /\.py$/.test(path) ? 'code' : /\.png$/.test(path) ? 'figures' : /^results\//.test(path) ? 'results' : /\.csv$/.test(path) ? 'data' : /\.md$/.test(path) ? 'notes' : null;
const at = s => new Date(Date.UTC(2026, 9, 30, 6, 0, s)).toISOString();
const ms = s => Date.UTC(2026, 9, 30, 6, 0, s);
test('the meaning layer runs from the question to findings and choices, the files they rest on, and how those files came about', () => {
  const turn = {
    id: 't1', by: 'local', text: 'Compare the strains.', sentAt: at(0), startedAt: at(0), endedAt: at(60), state: 'completed', model: 'm',
    steps: [
      { kind: 'tool', id: 'a', tool: 'Write', at: at(5), detail: root + '/analysis.py', outcome: 'returned' },
      { kind: 'tool', id: 'b', tool: 'Bash', at: at(20), startedAt: at(10), detail: 'python3 analysis.py data/plates.csv', outcome: 'returned', exitCode: 0 },
      { kind: 'text', at: at(30), text: 'Done.' },
    ],
    evidence: { records: [], omitted: 0, bytes: 0, snapshots: 0 },
    files: { changed: [{ path: 'results/tests.csv', change: 'created', modifiedAt: at(15) }], partial: false, omitted: 0 },
  };
  const files = [
    { path: 'data/plates.csv', bytes: 10, modifiedAt: at(-100), category: 'data' },
    { path: 'analysis.py', bytes: 10, modifiedAt: at(5), category: 'code' },
    { path: 'results/tests.csv', bytes: 10, modifiedAt: at(15), category: 'results' },
  ];
  const process = foldVersions(buildWorkGraph({ turns: [{ conversationId: 'c-1', conversationTitle: 'Plates', agent: 'Claude Code', turn }], files, project: { root }, kindOf, now: ms(90) }));
  const meanings = notesMeaning(notes).slice(0, 1);
  const traces = new Map(meanings[0].statements.map(s => [s, traceStatement(s, [], () => [], () => null)]));
  const layer = meaningLayer({ process, meanings, traces, files, kindOf });
  const edge = (from, to) => layer.edges.find(e => e.from === from && e.to === to);
  assert.deepEqual(layer.turns.map(t => t.id), ['m:c-1']);
  const finding = layer.nodes.find(n => n.kind === 'finding' && n.text.startsWith('Four'));
  assert.equal(edge('q:m:c-1', finding.id).label, 'found');
  assert.equal(edge(finding.id, 'm:f:results/tests.csv').label, 'rests on');
  assert.equal(edge(finding.id, 'm:f:results/figure.png').label, 'shown in');
  const choice = layer.nodes.find(n => n.kind === 'choice');
  assert.equal(edge(choice.id, 'm:f:results/alt_holm.csv').label, 'instead gives');
  const made = edge('m:f:results/tests.csv', 'm:f:analysis.py');
  assert.equal(made.label, 'made by'); assert.equal(made.basis, 'observed', 'the process basis stays');
  assert.equal(edge('m:f:analysis.py', 'm:f:data/plates.csv').label, 'reads');
  assert.equal(layer.nodes.find(n => n.id === 'm:f:results/tests.csv').meaning.description.text, 'one row per strain with its p-value');
  assert.deepEqual(layer.nodes.find(n => n.id === 'q:m:c-1').meaning.todos, { done: 1, total: 2 });
  assert.ok(layer.traces.some(e => e.from === 'm:f:results/tests.csv' && e.label === 'kept as' && e.to.startsWith('f:results/tests.csv')));
  const both = layered(process, layer, 'both');
  assert.deepEqual(both.turns.map(t => t.id), ['m:c-1', 'c-1/t1'], 'the meaning rows above the process rows');
  assert.equal(layered(process, layer, 'meaning').nodes.every(n => n.meaning), true);
  assert.equal(layered(process, layer, 'process'), process);
});

test('files read while a message ran join its row until the notes name them, and the notes\' words lead over a model\'s or the facts', () => {
  const process = buildWorkGraph({ turns: [], files: [], project: { root }, kindOf, now: ms(90) });
  const meanings = notesMeaning(notes).slice(0, 1);
  const traces = new Map(meanings[0].statements.map(s => [s, traceStatement(s, [], () => [], () => null)]));
  const read = (path, conversationId, extra = {}) => [path, { path, version: 'a'.repeat(64), bytes: 10, modifiedAt: at(16), observedAt: at(17), facts: 'facts of ' + path, sentence: null, state: 'facts', conversationId, turnId: 't1', ...extra }];
  const described = new Map([read('results/plot2.png', 'c-1'), read('results/tests.csv', 'c-1', { sentence: { text: 'a model says', version: 'a'.repeat(64), model: 'm', at: at(18) }, state: 'described' }),
    read('results/other.csv', 'c-9', { sentence: { text: 'other table', version: 'b'.repeat(64), model: 'provider/small[1m]', at: at(19) }, state: 'described' }), read('scratch.py', 'c-1')]);
  const layer = meaningLayer({ process, meanings, traces, files: [], kindOf, described });
  const edge = (from, to) => layer.edges.find(e => e.from === from && e.to === to);
  const plot = layer.nodes.find(n => n.id === 'm:f:results/plot2.png');
  assert.deepEqual([edge('q:m:c-1', plot.id).label, edge('q:m:c-1', plot.id).basis], ['made', 'observed']);
  assert.deepEqual([plot.meaning.description.source, plot.meaning.description.text], ['facts', 'facts of results/plot2.png']);
  const tests = layer.nodes.find(n => n.id === 'm:f:results/tests.csv').meaning.description;
  assert.deepEqual([tests.source, tests.text, tests.facts], ['notes', 'one row per strain with its p-value', 'facts of results/tests.csv']);
  assert.ok(!layer.nodes.some(n => n.path === 'scratch.py'), 'only results and figures join a row by themselves');
  assert.deepEqual(layer.turns.map(t => t.id), ['m:c-1', 'm:c-9'], 'a conversation with no section yet gets its own row');
  const other = layer.nodes.find(n => n.id === 'm:f:results/other.csv').meaning.description;
  assert.deepEqual([other.source, other.text, other.earlier, other.model], ['model', 'other table', true, 'provider/small[1m]']);
  assert.equal(edge('q:m:c-9', 'm:f:results/other.csv').label, 'made');
  assert.equal(holdsOf('results/other.csv', new Map(), described, ms(18)).source, 'facts', 'at an earlier moment the sentence had not arrived');
  assert.equal(holdsOf('results/other.csv', new Map(), described, ms(16)), undefined, 'nor had the file been read');
  assert.equal(modelName('provider/small[1m]'), 'small');
});
