import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesMeaning, fileDescriptions, traceStatement, plainText, notesPath, topicOf, withoutPaths } from '../dist/notes-meaning.js';
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
test('what a file holds comes from the notes\' words first, then a model\'s sentence, then the facts read from it', () => {
  const descriptions = fileDescriptions(notesMeaning(notes).slice(0, 1));
  const read = (path, conversationId, extra = {}) => [path, { path, version: 'a'.repeat(64), bytes: 10, modifiedAt: at(16), observedAt: at(17), facts: 'facts of ' + path, sentence: null, state: 'facts', conversationId, turnId: 't1', ...extra }];
  const described = new Map([read('results/plot2.png', 'c-1'), read('results/tests.csv', 'c-1', { sentence: { text: 'a model says', version: 'a'.repeat(64), model: 'm', at: at(18) }, state: 'described' }),
    read('results/other.csv', 'c-9', { sentence: { text: 'other table', version: 'b'.repeat(64), model: 'provider/small[1m]', at: at(19) }, state: 'described' })]);
  const plot = holdsOf('results/plot2.png', descriptions, described);
  assert.deepEqual([plot.source, plot.text], ['facts', 'facts of results/plot2.png']);
  const tests = holdsOf('results/tests.csv', descriptions, described);
  assert.deepEqual([tests.source, tests.text, tests.facts], ['notes', 'one row per strain with its p-value', 'facts of results/tests.csv']);
  const other = holdsOf('results/other.csv', descriptions, described);
  assert.deepEqual([other.source, other.text, other.earlier, other.model], ['model', 'other table', true, 'provider/small[1m]']);
  assert.equal(holdsOf('results/other.csv', new Map(), described, ms(18)).source, 'facts', 'at an earlier moment the sentence had not arrived');
  assert.equal(holdsOf('results/other.csv', new Map(), described, ms(16)), undefined, 'nor had the file been read');
  assert.equal(modelName('provider/small[1m]'), 'small');
});

test('a choice names its other option in its own sentence, and code that names a function links no file', () => {
  // As an Agent wrote them in a real run: the option after "Alternative:" in the same bullet.
  const [section] = notesMeaning(['## Logistic models', '<!-- rho:session c-1 -->', '### Choices', '',
    '- q5 model: used the BMI-only model. Alternative: BMI in the full model gives p = 0.1363 ([results/alternatives.json](results/alternatives.json)).',
    '- p-values: Wald z from `summary.glm`, written by `analysis.R` to `results/model_summary.csv`.',
    '- **Dunnett family = the 12 ratios only** [results/dunnett.csv](results/dunnett.csv)',
    '  - Alternative: adding the monocultures gives the same counts.', ''].join('\n'));
  const [q5, p, family] = section.statements;
  assert.equal(q5.text, 'q5 model: used the BMI-only model.');
  assert.deepEqual(q5.links, []);
  assert.deepEqual(q5.alternatives.map(o => [o.text, o.links]), [['BMI in the full model gives p = 0.1363 (results/alternatives.json).', ['results/alternatives.json']]]);
  assert.deepEqual(p.alternatives, []);
  assert.deepEqual(p.links, ['analysis.R', 'results/model_summary.csv']);
  assert.deepEqual(family.alternatives.map(o => o.text), ['adding the monocultures gives the same counts.']);
  // What a choice is about, what was taken, and the paths a sentence ends with left to its files.
  assert.deepEqual(topicOf(q5.text), { topic: 'q5 model', rest: 'Used the BMI-only model.' });
  assert.deepEqual(topicOf(withoutPaths(family.text, family.links)), { topic: 'Dunnett family', rest: 'The 12 ratios only' });
  assert.deepEqual(topicOf('The rows were kept. Then: more'), { topic: null, rest: 'The rows were kept. Then: more' });
  assert.equal(withoutPaths(q5.alternatives[0].text, q5.alternatives[0].links), 'BMI in the full model gives p = 0.1363.');
  assert.equal(withoutPaths('Both traits count. results/a.csv, results/b.json', ['results/a.csv', 'results/b.json']), 'Both traits count.');
});
