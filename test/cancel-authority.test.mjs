import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { runtime } from '../dist/runtime.js';
import { digest } from '@rho-workspace/plugin-contracts';

// A tab whose pairing includes a project may stop that
// project's runs; it finds a run only among that project's runs, a missing, guessed or other
// project's ID gets one answer, the request names who asked, and an Agent's own cancel is as before.
const sleep = 'cat("started\\n")\nSys.sleep(30)\n', fails = 'stop("Deliberate failure")\n';
const run = (operationId, script, extra = {}) => ({ operationId, action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'run.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null }, ...extra });
async function poll(read, predicate, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (predicate(value)) return value; await setTimeout(100); }
  throw new Error('Timed out: ' + label);
}

test('a paired tab stops only its project runs, names itself, and an Agent cancels as before', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-cancel-'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...await runtime() }).start();
  try {
    const operator = new RhoClient({ url: service.url, token: service.adminToken });
    for (const name of ['a', 'b']) await fs.mkdir(path.join(root, name));
    const a = await operator.call('project.open', { path: 'a' }), b = await operator.call('project.open', { path: 'b' });
    const agentOf = async (p, name) => {
      await fs.writeFile(path.join(p.root, 'run.R'), sleep);
      const file = path.join(root, name + '.json');
      await service.agentConnection(p.id, name, file, ['action.submit', 'action.lookup', 'action.cancel', 'action.observe']);
      const client = await RhoClient.fromFile(file);
      return (m, body = {}) => client.call(m, { projectId: p.id, ...body });
    };
    const agentA = await agentOf(a, 'agent-a'), agentB = await agentOf(b, 'agent-b');
    const pair = async folder => {
      const { code } = await operator.call('session.browser.pair', { path: folder });
      const grant = (await (await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code }) })).json()).value;
      return { grant, tab: new BrowserClient({ url: service.url, ...grant }) };
    };
    const { grant, tab } = await pair('a');

    const longA = await agentA('action.submit', run('long-a', sleep));
    const longB = await agentB('action.submit', run('long-b', sleep));
    await poll(() => agentA('action.observe', { operationId: 'long-a' }), r => r.execution === 'active', 'long-a running');

    // One answer for an ID that is missing, guessed or another project's.
    const refusal = id => tab.call('action.cancel', { projectId: a.id, operationId: id }).then(() => null, e => e.error);
    const missing = await refusal('never-submitted'), guessed = await refusal('long-a2'), elsewhere = await refusal('long-b');
    assert.equal(missing.kind, 'not_found');
    for (const e of [guessed, elsewhere]) assert.deepEqual({ kind: e.kind, message: e.message }, { kind: missing.kind, message: missing.message });
    // A project outside this tab's pairing is refused before any run is looked for.
    await assert.rejects(tab.call('action.cancel', { projectId: b.id, operationId: 'long-b' }), e => e.error.kind === 'scope');
    assert.equal((await agentB('action.lookup', { operationId: 'long-b' })).cancellation, undefined);

    // The tab stops the Agent's run: the request names the tab, the submitter is unchanged.
    const stopped = await tab.call('action.cancel', { projectId: a.id, operationId: 'long-a' });
    assert.equal(stopped.principal, longA.principal);
    assert.equal(stopped.cancellation.requestedBy, grant.principalId);
    const summary = async () => (await tab.call('project.runs', { projectId: a.id })).runs.find(r => r.operationId === 'long-a');
    // Core may end the process before the first read; whichever state is read, "stopped"
    // appears only with an ended run and its exit (the mapping itself: execution-facts.test).
    const first = await summary();
    assert.equal(first.stop.by, 'Person');
    if (first.stop.state === 'stopped') assert.ok(first.execution !== 'active' && first.stop.exit, JSON.stringify(first.stop));
    else assert.ok(['requested', 'signalled'].includes(first.stop.state) && first.execution === 'active' && first.stop.exit === null, JSON.stringify(first.stop));
    await poll(() => agentA('action.observe', { operationId: 'long-a' }), r => r.execution !== 'active', 'long-a ended');
    const ended = await poll(summary, r => r.stop.state === 'stopped', 'Core reports the stop');
    assert.match(ended.stop.exit, /^(signal|code) /);

    // An Agent cancels its own run exactly as before, and is named as the requester.
    const own = await agentB('action.cancel', { operationId: 'long-b' });
    assert.equal(own.principal, longB.principal); assert.equal(own.cancellation.requestedBy, longB.principal);

    // A run the person submits stays theirs: the Agent reads it but cannot stop it.
    await tab.call('action.submit', { projectId: a.id, ...run('person-a', sleep) });
    assert.equal((await agentA('action.lookup', { operationId: 'person-a' })).operationId, 'person-a');
    await assert.rejects(agentA('action.cancel', { operationId: 'person-a' }));
    await tab.call('action.cancel', { projectId: a.id, operationId: 'person-a' });
    await poll(() => agentA('action.lookup', { operationId: 'person-a' }), r => r.execution !== 'active', 'person-a ended');
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a repair is a new identity that names the failed run it repairs', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-repair-'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...await runtime() }).start();
  try {
    const operator = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await operator.call('project.create', { name: 'p' });
    const file = path.join(root, 'agent.json');
    await service.agentConnection(p.id, 'agent', file, ['action.submit', 'action.lookup', 'context.read']);
    const client = await RhoClient.fromFile(file), agent = (m, body = {}) => client.call(m, { projectId: p.id, ...body });
    await fs.writeFile(path.join(p.root, 'run.R'), fails);
    await agent('action.submit', run('first', fails, { input: { ...run('first', fails).input, args: ['--seed', '7'] } }));
    await poll(() => agent('action.lookup', { operationId: 'first' }), r => r.execution === 'failed', 'first failed');

    // The person asks the Agent to fix it: the context carries the real error and the references.
    const { code } = await operator.call('session.browser.pair', { path: 'p' });
    const grant = (await (await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code }) })).json()).value;
    const tab = new BrowserClient({ url: service.url, ...grant });
    await assert.rejects(tab.call('context.create', { projectId: p.id, run: { operationId: 'never-ran' } }), e => e.error.kind === 'not_found');
    const asked = await tab.call('context.create', { projectId: p.id, run: { operationId: 'first' } });
    const context = (await agent('context.read', { contextId: asked.contextId })).run;
    assert.equal(context.operationId, 'first'); assert.equal(context.execution, 'failed'); assert.equal(context.submittedBy, 'Agent');
    assert.match(context.exit, /^code [1-9]/);
    assert.match(context.error.text, /Deliberate failure/); assert.equal(context.error.from, 0); assert.equal(context.error.truncated, false);
    assert.equal(context.error.retainedBytes, Buffer.byteLength(context.error.text));
    assert.deepEqual(context.script, { kind: 'disk', path: 'run.R', digest: digest(fails) });
    assert.deepEqual(context.args, ['--seed', '7']);
    // A long stderr gives its end, where R writes the error, and says where the excerpt starts.
    const noisy = 'for (i in 1:2000) message("progress line ", i)\nstop("Final failure")\n';
    await fs.writeFile(path.join(p.root, 'noisy.R'), noisy);
    const loud = run('noisy', noisy); loud.input.script.path = 'noisy.R';
    await agent('action.submit', loud);
    await poll(() => agent('action.lookup', { operationId: 'noisy' }), r => r.execution === 'failed', 'noisy failed');
    const tail = (await agent('context.read', { contextId: (await tab.call('context.create', { projectId: p.id, run: { operationId: 'noisy' } })).contextId })).run.error;
    assert.ok(tail.retainedBytes > 8192 && tail.from === tail.retainedBytes - 8192, JSON.stringify({ ...tail, text: undefined }));
    assert.match(tail.text, /Final failure/); assert.doesNotMatch(tail.text, /progress line 1\n/);
    assert.ok(Buffer.byteLength(tail.text) <= 8192);
    await assert.rejects(agent('action.submit', run('first-again', fails, { repairOf: 'missing' })), e => e.error.kind === 'not_found');
    await assert.rejects(agent('action.submit', run('first', fails, { repairOf: 'first' })), e => ['invalid', 'conflict'].includes(e.error.kind));
    const fixed = 'cat("fixed\\n")\n';
    await fs.writeFile(path.join(p.root, 'run.R'), fixed);
    const repair = await agent('action.submit', run('second', fixed, { repairOf: 'first' }));
    assert.equal(repair.repairOf, 'first'); assert.notEqual(repair.core.requestId, (await agent('action.lookup', { operationId: 'first' })).core.requestId);
    await poll(() => agent('action.lookup', { operationId: 'second' }), r => r.execution === 'completed', 'repair completed');
    const runs = (await operator.call('project.runs', { projectId: p.id })).runs;
    assert.equal(runs.find(r => r.operationId === 'second').repairOf, 'first');
    assert.equal(runs.find(r => r.operationId === 'first').repairOf, null);
    // Only a failed run or one with an unknown outcome is repaired.
    await assert.rejects(agent('action.submit', run('third', fixed, { repairOf: 'second' })), e => e.error.kind === 'condition');
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
