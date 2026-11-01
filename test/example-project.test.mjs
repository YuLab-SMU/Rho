import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../dist/state.js';
import { seedExampleProject } from '../dist/example-project.js';
import { earlierQuestions } from '../dist/conversations.js';

const opened = [];
test.afterEach(async () => { for (const state of opened.splice(0)) await state.close().catch(() => {}); });
async function workspace() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-example-'));
  const projects = path.join(root, 'projects'), stateDirectory = path.join(root, 'state');
  await fs.mkdir(projects, { recursive: true }); await fs.mkdir(stateDirectory);
  const state = new State(projects, stateDirectory); await state.init();
  opened.push(state);
  return { root, state, projects, stateDirectory };
}
async function example(root) {
  const directory = path.join(root, 'bundled');
  await fs.mkdir(path.join(directory, 'data'), { recursive: true });
  await fs.writeFile(path.join(directory, 'README.md'), '# A finished study\n');
  await fs.writeFile(path.join(directory, 'data', 'values.csv'), 'x\n1\n2\n');
  await fs.mkdir(path.join(directory, '.rho', 'rho'), { recursive: true });
  await fs.writeFile(path.join(directory, '.rho', 'rho', 'conversations-end.json'), '{}\n');
  return directory;
}

test('the example is copied into the projects folder once and registered as an ordinary project', async () => {
  const { root, state, projects, stateDirectory } = await workspace();
  const source = await example(root);
  const first = await seedExampleProject(state, { directory: source, name: 'Example study' });
  assert.equal(first?.problem, undefined, 'seeding reports no problem');
  assert.equal(first?.name, 'Example study');
  const target = path.join(projects, 'Example study');
  assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), '# A finished study\n');
  assert.equal(await fs.readFile(path.join(target, 'data', 'values.csv'), 'utf8'), 'x\n1\n2\n');
  assert.equal(await fs.readFile(path.join(target, '.rho', 'rho', 'conversations-end.json'), 'utf8'), '{}\n', 'the state Rho kept for it comes with it');
  const registered = JSON.parse(await fs.readFile(path.join(stateDirectory, 'projects.json'), 'utf8'));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'Example study');
  assert.deepEqual(registered[0].example, { version: '0' });
  assert.equal(registered[0].root, await fs.realpath(target), 'the project is the copied folder, not the application');
  // A second start copies nothing and registers nothing again. One writer holds a state
  // directory, so the first one closes before the next opens it.
  await state.close();
  const again = new State(projects, stateDirectory); await again.init(); opened.push(again);
  assert.equal(await seedExampleProject(again, { directory: source, name: 'Example study' }), null);
  assert.equal(JSON.parse(await fs.readFile(path.join(stateDirectory, 'projects.json'), 'utf8')).length, 1);
});

test('a folder the person already has is never overwritten and the example is not re-offered', async () => {
  const { root, state, projects } = await workspace();
  const source = await example(root);
  const mine = path.join(projects, 'Example study');
  await fs.mkdir(mine);
  await fs.writeFile(path.join(mine, 'README.md'), '# my own work\n');
  const seeded = await seedExampleProject(state, { directory: source, name: 'Example study' });
  assert.equal(seeded, null);
  assert.equal(await fs.readFile(path.join(mine, 'README.md'), 'utf8'), '# my own work\n', 'the person\'s folder is untouched');
  assert.equal(await fs.readdir(projects).then(names => names.length), 1, 'nothing beside it was left behind');
});

test('an installation that ships no example leaves the project list as it was', async () => {
  const { state, projects } = await workspace();
  const seeded = await seedExampleProject(state, { enabled: false });
  assert.equal(seeded, null);
  assert.deepEqual(await fs.readdir(projects), []);
  const missing = await seedExampleProject(await fresh(), { directory: '/nonexistent/example' });
  assert.equal(missing?.problem !== undefined || missing === null, true, 'a missing source is reported, never thrown');
});
async function fresh() { const { state } = await workspace(); return state; }

test('a message that continues a conversation carries what was said, within a budget', () => {
  const turn = (text, answer) => ({ id: 't', changeId: 'c', requestDigest: 'd', by: 'p', text, sentAt: '', state: 'completed', startedAt: null, endedAt: null, pid: null, model: null, stop: null, exit: null, steps: [{ id: 's', kind: 'text', text: answer }], omitted: 0, retry: null, result: null, problem: null });
  const said = earlierQuestions([turn('What is the mean?', 'The mean is 2.'), turn('And the median?', 'The median is 2.')], { maxTextBytes: 65536 });
  assert.match(said, /continues a conversation/);
  assert.match(said, /The person said: What is the mean\?/);
  assert.match(said, /You answered: The mean is 2\./);
  assert.match(said, /The person said: And the median\?/);
  assert.doesNotMatch(said, /left out for length/);
  // A long conversation keeps its newest exchanges and says the earliest are left out.
  const long = Array.from({ length: 60 }, (_, index) => turn('Question number ' + index + ' ' + 'x'.repeat(400), 'Answer ' + index));
  const cut = earlierQuestions(long, { maxTextBytes: 65536 }, 4000);
  assert.match(cut, /left out for length/);
  assert.ok(Buffer.byteLength(cut) < 4600, 'the preamble stays within its budget');
  assert.match(cut, /Question number 59/, 'the newest exchange is kept');
  assert.doesNotMatch(cut, /Question number 0 /, 'the earliest exchange is dropped first');
  assert.equal(earlierQuestions([], { maxTextBytes: 65536 }), '', 'a first message has nothing to carry');
});
