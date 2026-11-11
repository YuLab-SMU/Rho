import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService, layeredGrantLimits } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';
// A Unix Host's socket lies under its project, within the socket path limit; Windows Hosts use pipes.
const shortTemp = process.platform === 'win32' ? tmpdir() : '/tmp';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-notebook-'));
  await fs.mkdir(path.join(root, 'project'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing', python: process.env.RHO_PYTHON }).start();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' }), person = new BrowserClient({ url: service.url });
  return { service, admin, p, root, call: (m, b = {}) => person.call(m, { projectId: p.id, ...b }) };
}

test('the person and their Agent share a live session; only the person ends it', async t => {
  const { service, admin, p, root, call } = await setup(t);
  assert.deepEqual((await call('kernel.read')).sessions, [], 'reading starts no session');
  const grant = path.join(root, 'agent.json');
  const connection = await service.agentConnection(p.id, 'notebook', grant, undefined, undefined, 'layered-business');
  assert.ok(connection.methods.length <= layeredGrantLimits.maxMethods);
  for (const method of ['kernel.run', 'kernel.read', 'kernel.inspect', 'kernel.plot', 'kernel.interrupt']) assert.ok(connection.methods.includes(method), method);
  assert.ok(!connection.methods.includes('kernel.stop') && !connection.methods.includes('kernel.start'));
  await assert.rejects(service.agentConnection(p.id, 'notebook-stop', path.join(root, 'stop.json'), ['kernel.stop']), /operator-only|Unknown/);
  await assert.rejects(service.agentConnection(p.id, 'notebook-start', path.join(root, 'start.json'), ['kernel.start']), /operator-only|Unknown/);

  const agent = new RhoClient(JSON.parse(await fs.readFile(grant, 'utf8')));
  const made = await agent.call('kernel.run', { projectId: p.id, language: 'python', code: 'shared = 41', purpose: 'Define a value', changeId: 'a1', waitMs: 30000 });
  assert.equal(made.cell.state, 'done');
  assert.match(made.cell.by, /^agent:/);
  const mine = await call('kernel.run', { language: 'python', code: 'shared + 1', changeId: 'p1', waitMs: 30000 });
  assert.equal(mine.cell.by, 'browser:local');
  // The timeline reads who ran each cell from the read the plugin names for it.
  const catalog = await call('capability.list');
  assert.equal(catalog.plugins.find(entry => entry.id === 'kernel').timeline, 'kernel.events');
  assert.deepEqual((await call('kernel.events')).events.map(e => [e.by, e.label, e.outcome]), [['browser:local', 'shared + 1', 'done'], [made.cell.by, 'Define a value', 'done']]);
  assert.equal(mine.cell.sessionId, made.cell.sessionId, 'the person runs in the Agent\'s session');
  assert.equal(mine.cell.outputs[0].text, '42\n');
  // Both read the same value as the session holds it.
  const seen = await call('kernel.inspect', { language: 'python', name: 'shared' });
  assert.equal(seen.state, 'shown'); assert.equal(seen.object.values.items[0].value, '41');
  assert.equal((await agent.call('kernel.inspect', { projectId: p.id, language: 'python', name: 'shared' })).object.kind, 'value');
  const again = await agent.call('kernel.run', { projectId: p.id, language: 'python', code: 'shared = 41', purpose: 'Define a value', changeId: 'a1' });
  assert.equal(again.cell.cellId, made.cell.cellId, 'a repeated request names the same cell');

  // A run that waits for a long cell holds nothing else of the project: reads answer and the
  // person can interrupt it.
  const slow = agent.call('kernel.run', { projectId: p.id, language: 'python', code: 'import time\ntime.sleep(20)', purpose: 'Wait', changeId: 'slow', waitMs: 60000 });
  let running;
  for (let i = 0; i < 100 && !running; i++) { await new Promise(r => setTimeout(r, 50)); running = (await call('kernel.read')).cells.find(c => c.changeId === 'slow' && c.state === 'running'); }
  const asked = Date.now();
  assert.ok(running, 'the waiting run left reads free');
  await call('kernel.interrupt', { cellId: running.cellId });
  const interrupted = await slow;
  assert.equal(interrupted.cell.state, 'interrupted');
  assert.ok(Date.now() - asked < 5000, 'the interrupt was not queued behind the run');

  await assert.rejects(agent.call('kernel.stop', { projectId: p.id, sessionId: made.session.sessionId }), e => e.error?.kind === 'unauthorized');
  await assert.rejects(admin.call('kernel.stop', { projectId: p.id, sessionId: made.session.sessionId }), e => e.error?.kind === 'unauthorized');
  const stopped = await call('kernel.stop', { sessionId: made.session.sessionId });
  assert.equal(stopped.session.stop.by, 'browser:local');
  let read;
  for (let i = 0; i < 200; i++) { read = await call('kernel.read'); if (read.sessions[0].state === 'ended') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(read.sessions[0].ending, 'stopped');
  assert.equal(read.cells.length, 3);
  // Only the person starts a session without a cell; an Agent's first cell starts one.
  await assert.rejects(agent.call('kernel.start', { projectId: p.id, language: 'python' }), e => e.error?.kind === 'unauthorized');
  await assert.rejects(admin.call('kernel.start', { projectId: p.id, language: 'python' }), e => e.error?.kind === 'unauthorized');
  const started = await call('kernel.start', { language: 'python' });
  assert.equal(started.session.startedBy, 'browser:local'); assert.equal(started.session.cells, 0);
  assert.notEqual(started.session.sessionId, made.session.sessionId);
  assert.equal((await call('kernel.start', { language: 'python' })).session.sessionId, started.session.sessionId);
});

test('a cell run in a named notebook keeps that notebook, in the session the project shares', async t => {
  const { call } = await setup(t);
  const first = await call('kernel.run', { language: 'python', code: 'base = 6', changeId: 'n1', waitMs: 30000 });
  const second = await call('kernel.run', { language: 'python', code: 'base * 7', notebook: 'nb-1a2b3c4d', changeId: 'n2', waitMs: 30000 });
  assert.equal(second.cell.state, 'done');
  assert.equal(second.cell.sessionId, first.cell.sessionId);
  assert.equal(second.cell.outputs.map(o => o.text ?? '').join(''), '42\n');
  assert.deepEqual((await call('kernel.read')).cells.map(c => c.notebook ?? null), [null, 'nb-1a2b3c4d']);
  // The identity is a short token, not a name: the contract refuses anything else.
  await assert.rejects(call('kernel.run', { language: 'python', code: '1', notebook: 'my notebook', changeId: 'n3' }), error => error.error.kind === 'invalid');
});
