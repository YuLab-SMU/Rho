import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RhoService, layeredGrantLimits } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';

async function setup(t) {
  const root = await fs.mkdtemp('/tmp/rho-notebook-');
  await fs.mkdir(path.join(root, 'project'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing', python: process.env.RHO_PYTHON ?? 'python3' }).start();
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
  assert.ok(!connection.methods.includes('kernel.stop'));
  await assert.rejects(service.agentConnection(p.id, 'notebook-stop', path.join(root, 'stop.json'), ['kernel.stop']), /operator-only|Unknown/);

  const agent = new RhoClient(JSON.parse(await fs.readFile(grant, 'utf8')));
  const made = await agent.call('kernel.run', { projectId: p.id, language: 'python', code: 'shared = 41', purpose: 'Define a value', changeId: 'a1', waitMs: 30000 });
  assert.equal(made.cell.state, 'done');
  assert.match(made.cell.by, /^agent:/);
  const mine = await call('kernel.run', { language: 'python', code: 'shared + 1', changeId: 'p1', waitMs: 30000 });
  assert.equal(mine.cell.by, 'browser:local');
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
});
