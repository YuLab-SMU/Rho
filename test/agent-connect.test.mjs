import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';

// Stand-ins for the `claude` and `codex` CLIs: they record each `mcp` command and where it ran.
const cli = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.RHO_CONNECT_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.env.RHO_CONNECT_FAIL && process.argv[3] !== 'remove' && process.argv[2] !== 'remove') { process.stderr.write('config is locked\\n'); process.exit(3); }
`;
async function setup(extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rho-connect-')));
  const log = path.join(root, 'calls.jsonl'), claude = path.join(root, 'claude'), codex = path.join(root, 'codex');
  for (const file of [claude, codex]) { await fs.writeFile(file, cli); await fs.chmod(file, 0o755); }
  process.env.RHO_CONNECT_LOG = log;
  await fs.mkdir(path.join(root, 'ozone study'), { recursive: true });
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript', claude, codex, ...extra }).start();
  const operator = new CheckedClient({ url: service.url, token: service.adminToken }), person = new BrowserClient({ url: service.url });
  const project = await operator.call('project.open', { path: 'ozone study' });
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, service, operator, person, project, calls, call: (method, body = {}) => person.call(method, { projectId: project.id, ...body }) };
}

test('the person adds Rho to their own Claude Code and Codex with each Agent\'s mcp add, and the grant is kept', async () => {
  const s = await setup();
  try {
    const first = await s.call('session.connect', { agent: 'claude-code' });
    assert.equal(first.label, 'Claude Code'); assert.equal(first.granted, true); assert.ok(first.methods > 0);
    assert.deepEqual({ agent: first.added.agent, name: first.added.name, scope: first.added.scope }, { agent: 'claude-code', name: 'rho-ozone-study', scope: 'folder' });
    const [remove, add] = await s.calls();
    assert.deepEqual(remove.args, ['mcp', 'remove', '-s', 'local', 'rho-ozone-study']);
    assert.deepEqual(add.args.slice(0, 6), ['mcp', 'add', '-s', 'local', 'rho-ozone-study', '--']);
    assert.equal(add.cwd, s.project.root, 'Claude Code keeps the entry for the project folder');
    const connection = JSON.parse(await fs.readFile(add.args.at(-1), 'utf8'));
    assert.equal(connection.projectId, s.project.id); assert.equal(add.args.at(-2), '--mcp');

    const again = await s.call('session.connect', { agent: 'claude-code' });
    assert.equal(again.granted, false, 'a connected session keeps its grant and token');
    assert.equal(JSON.parse(await fs.readFile(add.args.at(-1), 'utf8')).token, connection.token);

    const codex = await s.call('session.connect', { agent: 'codex' });
    assert.equal(codex.added.scope, 'user');
    assert.deepEqual((await s.calls()).at(-1).args.slice(0, 4), ['mcp', 'add', 'rho-ozone-study', '--']);

    const agents = (await s.call('observation.snapshot')).agents.filter(a => a.added);
    assert.deepEqual(agents.map(a => [a.label, a.added.agent, a.conversationId]).sort(), [['Claude Code', 'claude-code', null], ['Codex', 'codex', null]]);
  } finally { await s.service.close(); }
});

test('a grant from rho --grant is the same Claude Code session, and only the person at this machine may add Rho', async () => {
  const s = await setup();
  try {
    // A connection written for another service address is replaced, not kept.
    const before = await s.call('session.connect', { agent: 'codex' }), file = (await s.calls()).at(-1).args.at(-1);
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), url: 'http://127.0.0.1:1' }));
    const moved = await s.call('session.connect', { agent: 'codex' });
    assert.equal(before.granted, true); assert.equal(moved.granted, true);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).url, s.service.url);

    const granted = await s.operator.call('session.grant', { projectId: s.project.id, externalSessionId: 'claude-code' });
    const connected = await s.call('session.connect', { agent: 'claude-code' });
    assert.equal(connected.granted, false); assert.equal((await s.calls()).at(-1).args.at(-1), granted.connectionFile);
    const agent = new CheckedClient(JSON.parse(await fs.readFile(granted.connectionFile, 'utf8')));
    await assert.rejects(agent.call('session.connect', { projectId: s.project.id, agent: 'codex' }), error => ['unauthorized', 'scope'].includes(error.error?.kind ?? error.kind));
  } finally { await s.service.close(); }
});

test('an Agent that refuses, is missing or does not finish says so and leaves nothing marked added', async () => {
  const s = await setup({ connect: { timeoutMs: 400 } });
  try {
    process.env.RHO_CONNECT_FAIL = '1';
    await assert.rejects(s.call('session.connect', { agent: 'claude-code' }), error => error.error.kind === 'unavailable' && /Claude Code could not add Rho: config is locked/.test(error.error.message));
    delete process.env.RHO_CONNECT_FAIL;
    assert.equal((await s.call('observation.snapshot')).agents.some(a => a.label === 'Claude Code'), false, 'a new grant the Agent refused is removed');
    await fs.rm(path.join(s.root, 'codex'));
    await assert.rejects(s.call('session.connect', { agent: 'codex' }), error => error.error.kind === 'unavailable' && /Codex was not found on this machine/.test(error.error.message));
    await fs.writeFile(path.join(s.root, 'codex'), '#!/bin/sh\nsleep 5\n'); await fs.chmod(path.join(s.root, 'codex'), 0o755);
    await assert.rejects(s.call('session.connect', { agent: 'codex' }), error => error.error.kind === 'limit' && /within 0.4 s/.test(error.error.message));
  } finally { delete process.env.RHO_CONNECT_FAIL; await s.service.close(); }
});
