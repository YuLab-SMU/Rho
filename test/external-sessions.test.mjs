import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { CheckedClient } from './checked-client.mjs';
import { observeDshSession } from '@rho-workspace/plugin-agent/dsh-session';

test('project conversation read links native calls and exact results without starting execution or granting Agent history access', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rho-outside-')));
  await fs.mkdir(path.join(root, 'project'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing' }).start();
  try {
    const admin = new CheckedClient({ url: service.url, token: service.adminToken }), person = new BrowserClient({ url: service.url });
    const project = await admin.call('project.open', { path: 'project' });
    const call = (method, args = {}) => person.call(method, { projectId: project.id, ...args });
    assert.deepEqual(await call('agent.sessions.list'), { sessions: [], omitted: 0 });
    await fs.writeFile(path.join(project.root, 'plot.txt'), 'new colors');
    const captured = await admin.call('resource.register', { projectId: project.id, expectedDigest: createHash('sha256').update('new colors').digest('hex'), declaration: { kind: 'file', path: 'plot.txt', format: { mimeType: 'text/plain' } } });
    const events = [
      ['turn/start', { turn: 1 }], ['user/message', { source: { kind: 'user' }, content: 'Change colors' }],
      ['tool/call', { turn: 1, callId: 'native-call', name: 'mcp__rho__rho_call', arguments: JSON.stringify({ operation: 'resource.register', input: { path: 'plot.txt' } }) }],
      ['tool/result', { message: { toolCallId: 'native-call', content: JSON.stringify({ ok: true, value: captured }) } }],
      ['turn/end', { turn: 1, reason: { kind: 'completed' } }]
    ].map(([type, data], seq) => ({ seq, type, data, time: 1000 + seq }));
    const summary = observeDshSession(project.root, { version: 4, id: 'native-conversation', cwd: project.root, createdAt: 1000 }, events);
    assert.equal((await call('agent.sessions.list')).sessions[0].sessionId, 'native-conversation');
    const read = await call('agent.sessions.read', { session: summary.id });
    assert.equal(read.turns[0].results[0].version, captured.version);
    const work = await call('project.work.read');
    assert.equal(work.sessions[0].source, 'external-session'); assert.deepEqual(work.sessions[0].resourceRefs, [{ id: captured.id, version: captured.version }]);
    assert.equal(work.files[0].references[0].tool, 'native-call');
    assert.equal((await call('conversation.list')).conversations.length, 0);
    const connection = await service.agentConnection(project.id, 'outside', path.join(root, 'connection.json'));
    assert.ok(connection.methods.every(m => !m.startsWith('agent.sessions.')));
    const agent = new CheckedClient(JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8')));
    await assert.rejects(agent.call('agent.sessions.list', { projectId: project.id }));
    await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
    await assert.rejects(call('agent.sessions.read', { session: '../outside' }));
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
