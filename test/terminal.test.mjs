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

test('the person has a terminal in the project folder, and an Agent may read its screen, type in it and open its own, recorded as its activity', { skip: process.platform === 'win32' && 'Rho does not open a pseudo-terminal on Windows yet' }, async t => {
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

  // An Agent's grant carries the terminal, except its raw output and its size, which are the page's.
  const grant = path.join(root, 'agent.json');
  const connection = await service.agentConnection(p.id, 'terminal', grant);
  assert.deepEqual(connection.methods.filter(method => method.startsWith('console.terminal.')).sort(), ['console.terminal.close', 'console.terminal.commands', 'console.terminal.list', 'console.terminal.open', 'console.terminal.output', 'console.terminal.screen', 'console.terminal.write']);
  for (const method of ['console.terminal.read', 'console.terminal.resize'])
    await assert.rejects(service.agentConnection(p.id, 'terminal-' + method, path.join(root, method + '.json'), [method]), /operator-only|Unknown/);
  const agent = new RhoClient(JSON.parse(await fs.readFile(grant, 'utf8'))), as = (method, body = {}) => agent.call(method, { projectId: p.id, ...body });
  await assert.rejects(as('console.terminal.read', { terminalId: terminal.terminalId }), error => ['unauthorized', 'scope'].includes(error.error.kind));
  // It types a command into the person's terminal and reads the screen once the output settles.
  const sent = await as('console.terminal.write', { terminalId: terminal.terminalId, data: 'echo "from the Agent $((40 + 2))"\r' });
  const screen = await as('console.terminal.screen', { terminalId: terminal.terminalId, after: sent.offset, waitMs: 10000 });
  assert.equal(screen.quiet, true);
  assert.ok(screen.lines.includes('from the Agent 42'), JSON.stringify(screen.lines));
  const listed = (await call('console.terminal.list')).terminals[0];
  assert.equal(listed.typedBy.by, connection.principal ?? listed.typedBy.by); assert.match(listed.typedBy.by, /^agent:/);
  const activity = (await admin.call('observation.snapshot', { projectId: p.id })).activity.entries.map(e => e.method);
  assert.ok(activity.includes('console.terminal.write') && activity.includes('console.terminal.screen'), 'the Agent\'s calls are its recorded activity');
  // Its own terminal it may close; the person's it may not.
  const own = (await as('console.terminal.open', { cols: 80, rows: 24 })).terminal;
  assert.match(own.by, /^agent:/);
  await assert.rejects(as('console.terminal.close', { terminalId: terminal.terminalId }), error => error.error.kind === 'unauthorized');
  assert.equal((await as('console.terminal.close', { terminalId: own.terminalId })).terminal.terminalId, own.terminalId);

  // Closing hangs up the shell and forgets the terminal; the waiting read is released.
  const closed = await call('console.terminal.close', { terminalId: terminal.terminalId });
  assert.equal(closed.terminal.terminalId, terminal.terminalId);
  await waiting.catch(() => {});
  await assert.rejects(call('console.terminal.read', { terminalId: terminal.terminalId }), error => error.error.kind === 'not_found');
});

test('commands typed in a terminal are recorded with who typed them, for the person and the Agent, apart from the machine\'s shell history', { skip: process.platform === 'win32' && 'Rho does not open a pseudo-terminal on Windows yet' }, async t => {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-terminal-'));
  await fs.mkdir(path.join(root, 'project')); await fs.mkdir(path.join(root, 'home'));
  // bash, with a home of its own so the machine's startup files and history stay out of it.
  const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME, HISTFILE: process.env.HISTFILE };
  Object.assign(process.env, { SHELL: '/bin/bash', HOME: path.join(root, 'home'), HISTFILE: path.join(root, 'home', 'machine_history') });
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing' }).start();
  t.after(async () => { await service.close(); for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await fs.rm(root, { recursive: true, force: true }); });
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' });
  const person = new BrowserClient({ url: service.url }), call = (method, body = {}) => person.call(method, { projectId: p.id, ...body });
  const grant = path.join(root, 'agent.json'), connection = await service.agentConnection(p.id, 'terminal', grant);
  const agent = new RhoClient(JSON.parse(await fs.readFile(grant, 'utf8'))), as = (method, body = {}) => agent.call(method, { projectId: p.id, ...body });

  const { terminal } = await call('console.terminal.open', { cols: 80, rows: 20 }), terminalId = terminal.terminalId;
  await as('console.terminal.screen', { terminalId, after: 0, waitMs: 8000 });
  const cursor = (await admin.call('observation.snapshot', { projectId: p.id })).cursor;
  const typed = async (who, data) => who('console.terminal.screen', { terminalId, after: (await who('console.terminal.write', { terminalId, data })).offset, waitMs: 8000 });
  await typed(call, 'echo mine\r');
  await typed(as, 'ls no-such-file\r');
  const { commands } = await as('console.terminal.commands', { limit: 5 });
  assert.deepEqual(commands.map(c => [c.command, c.by, c.state, c.exit, c.cwd]), [['ls no-such-file', [connection.principal ?? commands[0].by[0]], 'exited', commands[0].exit, ''], ['echo mine', ['browser:local'], 'exited', 0, '']]);
  assert.match(commands[0].by[0], /^agent:/); assert.notEqual(commands[0].exit, 0); assert.match(commands[0].output, /no-such-file/);
  assert.equal(commands[1].output, 'mine');
  assert.deepEqual((await call('console.terminal.commands')).commands.map(c => c.commandId), commands.map(c => c.commandId), 'the person reads the same record');
  assert.deepEqual((await as('console.terminal.commands', { limit: 1, offset: 1 })).commands.map(c => c.command), ['echo mine']);
  // What one printed past the start its record holds is read in pages.
  await typed(as, 'seq 1 5000\r');
  const [long] = (await as('console.terminal.commands', { limit: 1 })).commands;
  assert.equal(long.command, 'seq 1 5000'); assert.equal(long.stored, true); assert.ok(long.outputBytes > Buffer.byteLength(long.output));
  const page = await as('console.terminal.output', { commandId: long.commandId, maxChars: 1000 });
  assert.ok(page.text.startsWith('1\n2\n') && page.more && page.text.length === 1000);
  const rest = await call('console.terminal.output', { commandId: long.commandId, offset: page.nextOffset, maxChars: 65536 });
  assert.ok((page.text + rest.text).trimEnd().endsWith('4999\n5000'));
  for (const end = Date.now() + 3000; (await admin.call('observation.snapshot', { projectId: p.id })).cursor === cursor;) {
    assert.ok(Date.now() < end, 'a recorded command moves the page\'s cursor'); await new Promise(r => setTimeout(r, 100));
  }
  await call('console.terminal.close', { terminalId });
  await new Promise(r => setTimeout(r, 500));
  await assert.rejects(fs.stat(path.join(root, 'home', 'machine_history')), 'the machine\'s history file is untouched');
  assert.match(await fs.readFile(path.join(root, 'project', '.rho/plugins/console/history/bash_history'), 'utf8'), /ls no-such-file/);
});
