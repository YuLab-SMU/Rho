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

test('the person has a terminal in the project folder; no Agent can be granted it, open it, read it or type in it', { skip: process.platform === 'win32' && 'Rho does not open a pseudo-terminal on Windows yet' }, async t => {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-terminal-'));
  await fs.mkdir(path.join(root, 'project'));
  // A plain shell, whatever the person's own is set up to print.
  const shell = process.env.SHELL; process.env.SHELL = '/bin/sh';
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing' }).start();
  t.after(async () => { await service.close(); if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell; await fs.rm(root, { recursive: true, force: true }); });
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' });
  const person = new BrowserClient({ url: service.url }), call = (method, body = {}) => person.call(method, { projectId: p.id, ...body });

  const { terminal } = await call('console.terminal.open', { cols: 90, rows: 20 });
  let at = 0, text = '';
  const until = async pattern => {
    for (const end = Date.now() + 15000; ;) {
      const read = await call('console.terminal.read', { terminalId: terminal.terminalId, after: at, waitMs: 300 });
      at = read.nextOffset; text += Buffer.from(read.data, 'base64').toString('utf8');
      if (pattern.test(text)) return read;
      assert.ok(Date.now() < end, 'the terminal printed ' + JSON.stringify(text.slice(-200)));
    }
  };
  await call('console.terminal.write', { terminalId: terminal.terminalId, data: 'stty size && pwd && echo "answer=$((6 * 7))"\n' });
  await until(/20 90\r\n.*rho-terminal-.*project\r\nanswer=42\r\n/s);
  assert.equal((await call('console.terminal.resize', { terminalId: terminal.terminalId, cols: 120, rows: 40 })).terminal.cols, 120);
  assert.deepEqual((await call('console.terminal.list')).terminals.map(each => [each.terminalId, each.by, each.endedAt]), [[terminal.terminalId, 'browser:local', null]]);
  // A read that waits holds nothing else of the project.
  const waiting = call('console.terminal.read', { terminalId: terminal.terminalId, after: at + 100000, waitMs: 5000 });
  const began = Date.now();
  await call('project.entries');
  assert.ok(Date.now() - began < 2000, 'another request does not wait for the terminal');

  // An Agent's grant never carries the terminal, by default or by name, and a call is refused.
  const grant = path.join(root, 'agent.json');
  const connection = await service.agentConnection(p.id, 'terminal', grant);
  assert.deepEqual(connection.methods.filter(method => method.startsWith('console.terminal.')), []);
  for (const method of ['console.terminal.open', 'console.terminal.read', 'console.terminal.write'])
    await assert.rejects(service.agentConnection(p.id, 'terminal-' + method, path.join(root, method + '.json'), [method]), /operator-only|Unknown/);
  const agent = new RhoClient(JSON.parse(await fs.readFile(grant, 'utf8')));
  await assert.rejects(agent.call('console.terminal.read', { projectId: p.id, terminalId: terminal.terminalId }), error => ['unauthorized', 'scope'].includes(error.error.kind));
  await assert.rejects(agent.call('console.terminal.write', { projectId: p.id, terminalId: terminal.terminalId, data: 'id\n' }), error => ['unauthorized', 'scope'].includes(error.error.kind));
  await assert.rejects(agent.call('console.terminal.open', { projectId: p.id, cols: 80, rows: 24 }), error => ['unauthorized', 'scope'].includes(error.error.kind));

  // Closing hangs up the shell and forgets the terminal; the waiting read is released.
  const closed = await call('console.terminal.close', { terminalId: terminal.terminalId });
  assert.equal(closed.terminal.terminalId, terminal.terminalId);
  await waiting.catch(() => {});
  await assert.rejects(call('console.terminal.read', { terminalId: terminal.terminalId }), error => error.error.kind === 'not_found');
});
