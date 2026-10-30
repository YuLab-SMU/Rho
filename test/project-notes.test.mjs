import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesInstructions, notesLimits, notesSections, projectNotesPath, sessionMarker, sessionTitles } from '../dist/project-notes.js';

const notes = [
  '# Project notes',
  '',
  '## Plate notes',
  'Written by the person, with no session.',
  '',
  '## **Swarming** area by `strain` ##',
  sessionMarker('c-1'),
  '',
  '### To do',
  '- [ ] Repeat',
  '',
  '```markdown',
  '## Not a section',
  sessionMarker('c-2'),
  '```',
  '',
  '## Second look',
  '',
  '<!--   rho:session c-3   -->',
  '## Claims c-1 again',
  sessionMarker('c-1'),
  '## Marker after text',
  'Some text first.',
  sessionMarker('c-4'),
].join('\n');

test('the notes\' sections are their level-2 headings outside code, each with the session its marker names', () => {
  assert.deepEqual(notesSections(notes), [
    { title: 'Plate notes', line: 2, conversationId: null },
    { title: 'Swarming area by strain', line: 5, conversationId: 'c-1' },
    { title: 'Second look', line: 16, conversationId: 'c-3' },
    { title: 'Claims c-1 again', line: 19, conversationId: null },
    { title: 'Marker after text', line: 21, conversationId: null },
  ]);
});

test('a session is titled by its own section; a duplicate, late or fenced marker titles nothing', () => {
  assert.deepEqual([...sessionTitles(notes)], [['c-1', 'Swarming area by strain'], ['c-3', 'Second look']]);
  const long = '## ' + 'x'.repeat(200) + '\n' + sessionMarker('c-9');
  assert.equal(sessionTitles(long).get('c-9').length, notesLimits.titleChars);
  // Past the byte limit the notes give no titles; sessions keep the ones they had.
  const big = '## Big\n' + sessionMarker('c-8') + '\n' + 'a'.repeat(notesLimits.maxTitleBytes);
  assert.equal(sessionTitles(big).size, 0);
});

test('a session is told where the notes are and how to keep its section, and nothing of the person\'s question', () => {
  const words = notesInstructions('c-42');
  assert.match(words, new RegExp(projectNotesPath.replace('.', '\\.')));
  assert.ok(words.includes(sessionMarker('c-42')), 'names its own marker');
  assert.match(words, /level-2 heading/);
  assert.match(words, /- \[ \] open, - \[x\] done/);
  assert.match(words, /Change only your own section/);
  assert.doesNotMatch(words, /QUESTIONS|swarm/i);
});
