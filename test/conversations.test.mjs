import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';

// A stand-in for the Claude Code CLI: it records each start, confirms the session it was
// given, and answers in the stream-json shape the real CLI writes. "slow" keeps working until
// it is stopped; "provider" fails the way an unavailable model provider does.
const fakeClaude = log => `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), at = name => args[args.indexOf(name) + 1];
const session = args.includes('--resume') ? at('--resume') : at('--session-id');
let text = ''; process.stdin.on('data', d => text += d);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ resume: args.includes('--resume'), session, text, tools: at('--allowedTools'), mcp: JSON.parse(at('--mcp-config')) }) + '\\n');
  const out = record => process.stdout.write(JSON.stringify({ session_id: session, ...record }) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'fake-model' });
  if (text === 'slow') { out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__rho__rho_call', input: { operation: 'document.read' } }] } }); setInterval(() => {}, 1000); return; }
  if (text === 'provider') { out({ type: 'assistant', is_api_error_message: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 502 upstream' }] } }); out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 502 upstream', num_turns: 1, duration_ms: 5 }); return; }
  out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', id: 'tool-2', name: 'mcp__rho__rho_call', input: { operation: 'capability.list' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', is_error: false, content: 'ok' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo: ' + text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + text, num_turns: 2, duration_ms: 12, total_cost_usd: 0.001 });
});
`;
async function fixture(root) {
  const state = path.join(root, '.service'), log = path.join(root, 'claude.jsonl'), claude = path.join(root, 'claude-stub.mjs');
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  await fs.writeFile(claude, fakeClaude(log), { mode: 0o755 });
  const service = await new RhoService({ root, stateDir: state, coreBinary: path.join(root, 'no-core'), rscript: 'Rscript', claude, agentBackend: 'claude-cli' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  const person = new BrowserClient({ url: service.url });
  const starts = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const settled = async (conversationId, count) => {
    for (let i = 0; i < 200; i++) {
      const read = await person.call('conversation.read', { projectId: p.id, conversationId });
      if (read.turns.length === count && read.turns.at(-1).state !== 'running') return read;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('message did not end');
  };
  const running = async (conversationId, steps) => {
    for (let i = 0; i < 200; i++) {
      const read = await person.call('conversation.read', { projectId: p.id, conversationId });
      if (read.turns.at(-1).state === 'running' && read.turns.at(-1).steps.length >= steps) return read;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('message did not start working');
  };
  return { service, operator, p, person, starts, settled, running };
}

test('a conversation started in Rho keeps one identity per message and resumes its own session', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-conversation-'));
  let f = await fixture(root);
  try {
    const { p, person } = f;
    const started = await person.call('conversation.start', { projectId: p.id, changeId: 'first', text: 'hello 你好' });
    const id = started.conversation.conversationId;
    let read = await f.settled(id, 1);
    assert.equal(read.turns[0].state, 'completed');
    assert.deepEqual(read.turns[0].steps.map(s => s.kind === 'tool' ? `${s.operation}:${s.outcome}` : s.text), ['capability.list:returned', 'echo: hello 你好']);
    assert.ok(!JSON.stringify(read).includes('hidden'), 'hidden reasoning is never kept');
    // A repeat of the same request returns the original and starts nothing; changed words are refused.
    assert.equal((await person.call('conversation.start', { projectId: p.id, changeId: 'first', text: 'hello 你好' })).conversation.conversationId, id);
    await assert.rejects(person.call('conversation.start', { projectId: p.id, changeId: 'first', text: 'other' }), e => e.error.kind === 'conflict');
    let starts = await f.starts();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].resume, false); assert.equal(starts[0].text, 'hello 你好');
    assert.equal(starts[0].tools, 'mcp__rho__rho_index');
    // The Agent gets the project grant `rho --grant` gives, under its own principal; never conversation methods.
    const grant = JSON.parse(await fs.readFile(starts[0].mcp.mcpServers.rho.env.RHO_AGENT_CONNECTION, 'utf8'));
    assert.equal(grant.projectId, p.id);
    assert.ok(!grant.methods.some(m => m.startsWith('conversation.') || m.startsWith('session.')));
    const agent = new RhoClient(grant);
    // It has no file tools of its own, so the grant lists the project folder; other project methods stay operator work.
    assert.deepEqual((await agent.call('project.entries', { projectId: p.id })).entries.map(e => e.name), []);
    assert.ok(!grant.methods.some(m => m.startsWith('project.') && m !== 'project.entries'));
    await assert.rejects(agent.call('project.open', { path: 'work' }), e => e.error.kind === 'unauthorized');
    await assert.rejects(agent.call('conversation.start', { projectId: p.id, changeId: 'agent', text: 'x' }), e => e.error.kind === 'unauthorized');
    await assert.rejects(f.operator.call('conversation.start', { projectId: p.id, changeId: 'operator', text: 'x' }), e => e.error.kind === 'unauthorized');
    await assert.rejects(f.operator.call('session.grant', { projectId: p.id, externalSessionId: 'x', methods: ['conversation.start'] }), e => e.error.kind === 'invalid');
    const snapshot = await person.call('observation.snapshot', { projectId: p.id });
    assert.equal(snapshot.conversations.length, 1);
    assert.ok(snapshot.conversations[0].principal.startsWith('agent:'));
    assert.equal(snapshot.agents.find(a => a.principal === snapshot.conversations[0].principal)?.conversationId, id);
    assert.deepEqual((await f.operator.call('observation.snapshot', { projectId: p.id })).conversations, []);

    // The next message resumes the same native session. A second one is refused while it works.
    await person.call('conversation.send', { projectId: p.id, conversationId: id, changeId: 'second', text: 'slow' });
    await f.running(id, 1);
    await assert.rejects(person.call('conversation.send', { projectId: p.id, conversationId: id, changeId: 'third', text: 'more' }), e => e.error.kind === 'conflict');
    const stopping = await person.call('conversation.stop', { projectId: p.id, conversationId: id, turnId: 't2' });
    assert.equal(stopping.turn.stop.reason, 'person');
    read = await f.settled(id, 2);
    assert.equal(read.turns[1].state, 'stopped');
    assert.equal(read.turns[1].steps[0].outcome, 'unknown');
    starts = await f.starts();
    assert.equal(starts.length, 2);
    assert.equal(starts[1].resume, true); assert.equal(starts[1].session, starts[0].session);

    // A provider failure is the message's ending, not the Agent's words.
    await person.call('conversation.send', { projectId: p.id, conversationId: id, changeId: 'provider', text: 'provider' });
    read = await f.settled(id, 3);
    assert.equal(read.turns[2].state, 'failed'); assert.equal(read.turns[2].result.message, 'API Error: 502 upstream');
    assert.deepEqual(read.turns[2].steps.map(s => s.kind), ['error']);

    // Closing Rho stops a message being answered and records the stop; nothing is sent again.
    await person.call('conversation.send', { projectId: p.id, conversationId: id, changeId: 'closing', text: 'slow' });
    await f.running(id, 1);
    await f.service.close();
    f = await fixture(root);
    read = await f.person.call('conversation.read', { projectId: f.p.id, conversationId: id });
    assert.equal(read.turns[3].state, 'stopped'); assert.equal(read.turns[3].stop.reason, 'closing');
    assert.equal((await f.starts()).length, 4);
    await f.person.call('conversation.send', { projectId: f.p.id, conversationId: id, changeId: 'after', text: 'again' });
    read = await f.settled(id, 5);
    assert.equal(read.turns[4].state, 'completed');
    starts = await f.starts();
    assert.equal(starts.length, 5); assert.equal(starts[4].resume, true); assert.equal(starts[4].session, starts[0].session);
  } finally { await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a message Rho stopped observing stays unknown and is never sent again', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-conversation-lost-'));
  let f = await fixture(root);
  try {
    const started = await f.person.call('conversation.start', { projectId: f.p.id, changeId: 'first', text: 'hello' });
    const id = started.conversation.conversationId;
    await f.settled(id, 1);
    await f.service.close();
    // As if the service died while a message was being answered.
    const file = path.join(root, 'work', '.rho', 'rho', 'conversations', id + '.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.format = 1; delete record.backend; // Legacy on-disk conversation, before ACP.
    record.turns.push({ ...record.turns[0], id: 't2', changeId: 'lost', text: 'lost words', state: 'running', steps: [], result: null, endedAt: null, pid: null });
    await fs.writeFile(file, JSON.stringify(record));
    const indexFile = path.join(path.dirname(file), 'index.json'), index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    index.conversations[0].state = 'running'; index.conversations[0].turns = 2;
    await fs.writeFile(indexFile, JSON.stringify(index));
    f = await fixture(root);
    let read = await f.person.call('conversation.read', { projectId: f.p.id, conversationId: id });
    assert.equal(read.turns[1].state, 'unknown'); assert.match(read.turns[1].problem, /not sent again/);
    assert.equal((await f.person.call('observation.snapshot', { projectId: f.p.id })).conversations[0].state, 'unknown');
    await f.person.call('conversation.send', { projectId: f.p.id, conversationId: id, changeId: 'next', text: 'next' });
    read = await f.settled(id, 3);
    assert.equal(read.turns[1].state, 'unknown');
    assert.deepEqual((await f.starts()).map(s => s.text), ['hello', 'next']);
  } finally { await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
