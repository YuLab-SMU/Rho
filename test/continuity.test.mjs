import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { protocol } from '../dist/protocol.js';
import { runtime } from '../dist/runtime.js';
import { Ajv } from 'ajv';
const native = await runtime();
const validateRun = new Ajv({ strict: false, allowUnionTypes: true }).compile(protocol.definitions.run);
for (const stage of ['before-host', 'before-cli', 'after-cli']) test('lost first reply and SIGKILL at ' + stage + ' retain one native identity and dispatch', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-continuity-'));
  const worker = fork(new URL('./crash-worker.mjs', import.meta.url), [root, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  worker.stderr.resume();
  const messages = []; const waiters = [];
  worker.on('message', m => { messages.push(m); for (const resolve of waiters.splice(0)) resolve(); });
  async function message(key) {
    const deadline = Date.now() + 15000;
    while (!messages.some(m => key in m)) { assert.ok(Date.now() < deadline, 'fault worker checkpoint timeout'); await Promise.race([new Promise(resolve => waiters.push(resolve)), setTimeout(50)]); }
    return messages.find(m => key in m)[key];
  }
  let restarted, hostPid;
  try {
    const c = new RhoClient(await message('ready'));
    const p = await c.call('project.create', { name: 'project' });
    const doc = await c.call('document.open', { projectId: p.id, path: 'snapshot.R' });
    const code = 'args <- commandArgs(TRUE)\nout <- args[[1L]]\ncat("entry\\n", file=paste0(out,".entries.jsonl"), append=TRUE)\ndir.create(out)\nwriteLines("original unsaved 中文 🧬", file.path(out,"snapshot.txt"))\ncat(paste(rep("界",100), collapse=""))\nSys.sleep(0.2)\n';
    const edited = await c.call('document.edit', { projectId: p.id, documentId: doc.id, expectedVersion: doc.version, edits: [{ from: 0, to: 0, insert: code }], undoGroup: 'initial' });
    const input = { projectId: p.id, action: 'airway.analyze', actionVersion: '0.1.0', input: { bootstrapReplicates: 1, script: { kind: 'buffer', documentId: doc.id, version: edited.version } } };
    const [intent, competingIntent] = await Promise.all([c.retainOperation(path.join(root, 'caller-intent.json'), input), c.retainOperation(path.join(root, 'caller-intent.json'), input)]);
    assert.deepEqual(intent, competingIntent);
    await assert.rejects(c.retainOperation(path.join(root, 'caller-intent.json'), { ...input, actionVersion: 'changed' }), { kind: 'conflict' });
    const lost = c.call('action.submit', intent).then(() => 'unexpected reply', () => 'transport lost');
    await message('checkpoint');
    const recordFile = (await fs.readdir(path.join(p.root, '.rho/rho/operations')))[0];
    const durable = JSON.parse(await fs.readFile(path.join(p.root, '.rho/rho/operations', recordFile), 'utf8'));
    assert.equal(durable.operationId, intent.operationId); assert.equal(durable.plan.source.version, edited.version);
    const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited; assert.equal(await lost, 'transport lost');
    // Pipe EOF releases the advisory writer locks after an actual process death.
    await setTimeout(50);
    restarted = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native }).start();
    const recovered = new RhoClient({ url: restarted.url, token: restarted.adminToken });
    const call = (m, b = {}) => recovered.call(m, { projectId: p.id, ...b });
    const original = await call('action.lookup', { operationId: intent.operationId });
    assert.deepEqual(original.core, durable.core); assert.ok(validateRun(original), JSON.stringify(validateRun.errors));
    const cap = await call('capability.list');
    if (stage === 'before-host') assert.equal(cap.host.exitCode, 3);
    else { assert.equal(cap.host.exitCode, 0); hostPid = cap.host.reply.value.host.pid; }
    await call('action.observe', { operationId: intent.operationId });
    assert.equal((await call('capability.list')).host.exitCode, stage === 'before-host' ? 3 : 0);
    const retry = await call('action.retry', { operationId: intent.operationId });
    assert.equal(retry.lastCli.exitCode, 0); assert.deepEqual(retry.core, durable.core);
    const nativeId = retry.native.run_id;
    const changed = await call('document.edit', { documentId: doc.id, expectedVersion: edited.version, edits: [{ from: 0, to: code.length, insert: 'stop("newer unsaved text must not run")\n' }], undoGroup: 'after-acceptance' });
    assert.equal(changed.version, 3);
    await assert.rejects(call('action.submit', { ...intent, operationId: 'stale-buffer' }), e => e.error.kind === 'stale');
    const deadline = Date.now() + 5000; let final;
    do { final = await call('action.observe', { operationId: intent.operationId }); if (final.execution === 'completed') break; await setTimeout(50); } while (Date.now() < deadline);
    assert.equal(final.execution, 'completed'); assert.equal(final.native.run_id, nativeId); assert.ok(validateRun(final), JSON.stringify(validateRun.errors));
    assert.equal((await call('action.submit', intent)).native.run_id, nativeId);
    assert.match(await fs.readFile(path.join(p.root, final.plan.output, 'snapshot.txt'), 'utf8'), /original unsaved 中文 🧬/);
    assert.equal((await fs.readFile(path.join(p.root, final.plan.output + '.entries.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await call('action.list')).length, 1);
    const output = await call('action.output', { operationId: intent.operationId, stream: 'stdout', offset: 0, maxBytes: 7 });
    assert.equal(output.exitCode, 0); assert.ok(output.reply.ok);
    await assert.rejects(call('action.output', { operationId: intent.operationId, stream: 'stdout', offset: 0, maxBytes: 65537 }), e => e.error.kind === 'limit');
    const shutdown = await restarted.close(); restarted = undefined;
    if (stage !== 'before-host') { assert.deepEqual(shutdown, []); process.kill(hostPid, 0); }
    else assert.equal(shutdown[0].confirmed, true);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    if (restarted) await restarted.close();
    if (hostPid) { try { process.kill(hostPid, 'SIGTERM'); } catch {} }
  }
});
