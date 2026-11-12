import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';
// A Unix Host's socket lies under its project, within the socket path limit; Windows Hosts use pipes.
const shortTemp = process.platform === 'win32' ? tmpdir() : '/tmp';

// A project is a folder. The person takes one off Rho's list and nothing else changes: the folder,
// its files and the records Rho keeps in it stay, and the folder opened again is the project it was.
async function setup(t, config = {}) {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-remove-'));
  for (const name of ['one', 'two']) { await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, 'data.csv'), 'id\n1\n'); }
  const start = () => new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing', python: process.env.RHO_PYTHON, ...config }).start();
  const live = { service: await start() };
  t.after(async () => { await live.service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const clients = () => ({ admin: new RhoClient({ url: live.service.url, token: live.service.adminToken }), person: new BrowserClient({ url: live.service.url }) });
  return { root, live, start, clients };
}
const names = list => list.map(p => path.basename(p.root));
const kind = expected => error => { assert.equal(error.error?.kind, expected, error.message); return true; };

test('a project leaves the list, its folder stays, and Undo or opening the folder lists it as it was', async t => {
  const { root, live, start, clients } = await setup(t);
  let { admin, person } = clients();
  const one = await admin.call('project.open', { path: 'one' }), two = await admin.call('project.open', { path: 'two' });
  const grant = path.join(root, 'agent.json');
  await live.service.agentConnection(one.id, 'reader', grant, undefined, undefined, 'layered-business');
  const granted = JSON.parse(await fs.readFile(grant, 'utf8')), agent = () => new RhoClient(granted);
  await agent().call('kernel.read', { projectId: one.id });
  // Only the person at this machine removes a project; an Agent's grant never holds the operation.
  await assert.rejects(agent().call('project.remove', { projectId: one.id }), error => ['unauthorized', 'scope'].includes(error.error?.kind));
  assert.deepEqual(names(await person.call('project.list', {})), ['one', 'two']);

  const removed = await person.call('project.remove', { projectId: one.id });
  assert.equal(removed.project.id, one.id);
  assert.deepEqual(removed.stopped, { conversations: 0, sessions: 0, terminals: 0, commands: 0 });
  assert.deepEqual(names(await person.call('project.list', {})), ['two']);
  // Nothing in the folder changed: its file and Rho's own records are where they were.
  assert.equal(await fs.readFile(path.join(root, 'one', 'data.csv'), 'utf8'), 'id\n1\n');
  assert.ok((await fs.stat(path.join(root, 'one', '.rho'))).isDirectory());
  // A removed project is not reached by its identity, by the person or by an Agent granted it.
  await assert.rejects(person.call('project.entries', { projectId: one.id }), kind('not_found'));
  await assert.rejects(agent().call('kernel.read', { projectId: one.id }), kind('not_found'));
  await assert.rejects(person.call('project.remove', { projectId: one.id }), kind('not_found'));

  // Undo lists it where it stood, and the grant reaches it again.
  const back = await person.call('project.restore', { projectId: one.id });
  assert.equal(back.id, one.id);
  assert.deepEqual(names(await person.call('project.list', {})), ['one', 'two']);
  await agent().call('kernel.read', { projectId: one.id });
  // Listing one that is listed changes nothing.
  assert.equal((await person.call('project.restore', { projectId: one.id })).id, one.id);
  assert.deepEqual(names(await person.call('project.list', {})), ['one', 'two']);

  // A removal lasts across a restart, and so does what is kept to list the project again.
  await person.call('project.remove', { projectId: one.id });
  await live.service.close(); live.service = await start();
  ({ admin, person } = clients());
  assert.deepEqual(names(await person.call('project.list', {})), ['two']);
  // Opening the folder again lists the same project.
  const opened = await admin.call('project.open', { path: 'one' });
  assert.equal(opened.id, one.id);
  assert.deepEqual(names(await person.call('project.list', {})).sort(), ['one', 'two']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.service', 'removed-projects.json'), 'utf8')), []);
  // One never removed, or forgotten, is not brought back by its identity.
  await person.call('project.remove', { projectId: two.id });
  await fs.writeFile(path.join(root, '.service', 'removed-projects.json'), '[]');
  await live.service.close(); live.service = await start();
  ({ admin, person } = clients());
  await assert.rejects(person.call('project.restore', { projectId: two.id }), kind('not_found'));
});

test('work Rho runs in a project is counted first and stopped only when the person says so', async t => {
  const { live, clients } = await setup(t);
  const { admin, person } = clients();
  const one = await admin.call('project.open', { path: 'one' });
  const ran = await person.call('kernel.run', { projectId: one.id, language: 'python', code: 'kept = 41 + 1', changeId: 'r1', waitMs: 30000 });
  assert.equal(ran.cell.state, 'done');
  // A live session holds values; the project stays listed and the session keeps running.
  await assert.rejects(person.call('project.remove', { projectId: one.id }), error => {
    assert.equal(error.error.kind, 'conflict');
    assert.deepEqual(error.error.details.running, { conversations: 0, sessions: 1, terminals: 0, commands: 0 });
    assert.match(error.error.message, /1 live session/);
    return true;
  });
  assert.deepEqual(names(await person.call('project.list', {})), ['one']);
  assert.equal((await person.call('kernel.read', { projectId: one.id })).sessions.filter(s => s.state !== 'ended').length, 1);

  const removed = await person.call('project.remove', { projectId: one.id, stop: true });
  assert.deepEqual(removed.stopped, { conversations: 0, sessions: 1, terminals: 0, commands: 0 });
  assert.deepEqual(await person.call('project.list', {}), []);
  // Listed again, its record says the session was stopped, and by whom; nothing was started.
  await person.call('project.restore', { projectId: one.id });
  const sessions = (await person.call('kernel.read', { projectId: one.id })).sessions;
  assert.deepEqual(sessions.map(s => [s.state, s.ending, s.stop?.by]), [['ended', 'stopped', 'browser:local']]);
  assert.ok(live.service);
});
