import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { digest } from '@rho-workspace/plugin-contracts';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';

test('browser observes only its project and selected caller; reads never create a Host or widen default Agent grants', async () => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/rho-activity-api-'));
  const binary = process.env.RHO_CORE_BINARY;
  assert.ok(binary, 'Select the activity-capable public Core binary');
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: binary, rscript: '/missing' }).start();
  let host;
  try {
    const admin = new CheckedClient({ url: service.url, token: service.adminToken });
    const project = await admin.call('project.create', { name: 'one' });
    const other = await admin.call('project.create', { name: 'other' });
    const pairing = await admin.call('session.browser.pair', { path: path.relative(root, project.root) });
    const response = await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code: pairing.code }) });
    const paired = (await response.json()).value;
    const person = new CheckedClient({ url: service.url, token: paired.token });
    const call = (method, args = {}) => person.call(method, { projectId: project.id, ...args });
    await assert.rejects(call('agent.activity.read'), /Host/);
    await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
    await assert.rejects(person.call('agent.activity.read', { projectId: other.id }), /scope|outside|authorized|include/i);
    const connection = await service.agentConnection(project.id, 'default-grant', path.join(root, 'connection.json'));
    assert.ok(connection.methods.length <= 64);
    assert.ok(connection.methods.every(m => !m.startsWith('agent.activity.')));
    const socket = path.join(project.root, '.rho/host.sock');
    host = spawn(binary, ['serve', '--project', project.root, '--state-dir', path.join(project.root, '.rho')], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(host.stdout, 'data');
    const core = (caller, method, args = [], value) => {
      const r = spawnSync(binary, [method, '--socket', socket, '--caller', caller, ...args], { input: value ? JSON.stringify(value) : undefined, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout); return JSON.parse(r.stdout).value;
    };
    for (const caller of ['rho-agent-observe', 'someone-else']) core(caller, 'activity-open', ['--source-file', '-'], { stream_id: caller, producer: 'claude', session_id: 'native', metadata: { normalizer: 'rho-agent-activity/1' } });
    core('rho-agent-observe', 'activity-append', ['--id', 'rho-agent-observe', '--events-file', '-'], [{ sequence: 0, kind: 'tool.requested', data: { call_id: 'call', tool: 'Bash', input: { command: 'python3 analysis.py' } } }]);
    const read = await call('agent.activity.read', { streamId: 'rho-agent-observe', after: 0 });
    assert.equal(read.streams.length, 1); assert.equal(read.page.entries.length, 1);
    assert.deepEqual(core('rho-agent-observe', 'list').runs, []);
    await assert.rejects(call('agent.activity.read', { streamId: 'someone-else' }), /not available/);
    await fs.mkdir(path.join(project.root, 'outputs'));
    const csv = 'id,value\n001,NA\n'; await fs.writeFile(path.join(project.root, 'outputs/a.csv'), csv);
    assert.equal((await call('agent.activity.outputs', { directory: 'outputs' })).files.length, 1);
    const captured = await call('agent.activity.capture', { path: 'outputs/a.csv', expectedDigest: digest(csv) });
    assert.deepEqual((await call('data.page', { resource: { id: captured.id, version: captured.version }, offset: 0, limit: 10 })).rows, [{ id: '001', value: 'NA' }]);
    host.kill('SIGKILL'); await once(host, 'exit'); host = null;
    await assert.rejects(call('agent.activity.read'), /Host/);
  } finally { if (host && host.exitCode === null) { host.kill(); await once(host, 'exit'); } await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
