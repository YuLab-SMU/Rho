// A real ordinary base-R computation publishes a table, then pauses. Only
// disposable projects and owned processes are used; unknown remains unknown.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { RhoService, RhoClient, native } from './support.mjs';
const root = path.resolve(process.argv[2] ?? 'work/recovery-' + Date.now());
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native, maxConcurrentActions: 1 }).start();
const report = { status: 'running', source: 'Ordinary base-R project paused after publishing computed rows.', checks: [] };
const check = name => { report.checks.push(name); process.stdout.write(JSON.stringify({ passed: name }) + '\n'); };
let rPid;
async function until(read, predicate, timeout = 60000) {
  const end = Date.now() + timeout; let value;
  do { value = await read(); if (predicate(value)) return value; await setTimeout(100); } while (Date.now() < end);
  throw new Error('Recovery acceptance time budget reached; original records retained.');
}
try {
  const human = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await human.call('project.create', { name: 'partial-project' });
  const h = (m, b = {}) => human.call(m, { projectId: p.id, ...b });
  const paused = 'args <- commandArgs(TRUE)\nout <- args[[1L]]\ncat(as.character(Sys.getpid()), "\\n", file=paste0(out,".entries.jsonl"), append=TRUE)\nstopifnot(dir.create(out))\nx <- 1:4\nwrite.csv(data.frame(sample_id=sprintf("%03d",x),value=x^2),file.path(out,"partial.csv"),row.names=FALSE)\nwriteLines("paused after real computation",file.path(out,"checkpoint.txt"))\nSys.sleep(600)\n';
  const declaration = { path: 'partial.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'sample_id', type: 'string', nullValues: [] }, { name: 'value', type: 'number', nullValues: [''] }], key: { column: 'sample_id', namespace: 'ordinary-samples' } } };
  let doc = await h('document.open', { path: 'paused-analysis.R' });
  doc = await h('document.edit', { documentId: doc.id, expectedVersion: doc.version, edits: [{ from: 0, to: 0, insert: paused }], undoGroup: 'pause-fixture' });
  const grant = await h('session.grant', { externalSessionId: 'recovery-agent', methods: ['binding.open', 'binding.close', 'action.submit', 'action.lookup', 'action.observe', 'action.retry', 'action.output', 'action.cancel', 'resource.list', 'observation.snapshot'] });
  const agent = await RhoClient.fromFile(grant.connectionFile);
  await agent.call('binding.open', { externalSessionId: 'recovery-agent', adapter: 'claude-code-mcp' });
  const intent = await agent.retainOperation(path.join(root, 'caller-intent.json'), { projectId: p.id, action: 'r.execute', actionVersion: '0.2.0', input: { args: [], requirements: [], artifacts: [declaration], completion: 'result.json', script: { kind: 'buffer', documentId: doc.id, version: doc.version } } });
  const run = await agent.call('action.submit', intent); assert.equal(run.lastCli.exitCode, 0);
  const output = path.join(p.root, run.plan.output);
  await until(() => fs.stat(path.join(output, 'checkpoint.txt')).then(() => true, () => false), Boolean);
  let current = await agent.call('action.observe', { operationId: intent.operationId });
  assert.equal(current.execution, 'active'); rPid = current.native.status.Running?.pid ?? current.native.status.Stopping?.pid;
  if (!rPid) { const entries = (await fs.readFile(output + '.entries.jsonl', 'utf8')).trim().split('\n'); rPid = Number(entries[0]); }
  report.loading = current;
  const artifacts = await agent.call('resource.list', { operationId: intent.operationId });
  const table = artifacts.resources.find(r => r.path.endsWith('/partial.csv'));
  assert.equal(table.availability, 'partial'); assert.equal(artifacts.integrity.state, 'incomplete');
  const ref = { id: table.id, version: table.version };
  const page = await h('data.page', { resource: ref, offset: 0, limit: 10 }); assert.equal(page.total, 4);
  await assert.rejects(fs.stat(path.join(output, 'complete.json')), { code: 'ENOENT' });
  check('real partial snapshot has 4 observed rows and no completion declaration');
  await assert.rejects(agent.call('action.submit', { ...intent, operationId: 'concurrency-overflow' }), e => e.error.kind === 'limit' && e.error.details.limit === 'maxConcurrentActions');
  check('concurrent action limit rejects new work while preserving the original request');
  const comp = await h('composition.put', { compositionId: 'partial', expectedVersion: 0, views: [{ id: 'table', component: 'rho.table', version: '0.2.0', props: { title: 'Partial fit' }, bindings: { data: ref } }], layout: {} });
  const snapshot = await agent.call('observation.snapshot');
  const stream = await agent.events(p.id, snapshot.cursor); await stream.cancel();
  await h('view.close', { compositionId: 'partial', viewId: 'table', expectedVersion: comp.version });
  await agent.call('binding.close', { externalSessionId: 'recovery-agent' });
  current = await agent.call('action.observe', { operationId: intent.operationId }); assert.equal(current.execution, 'active'); assert.equal(current.native.run_id, run.native.run_id);
  check('closing observation, view and external binding does not cancel the original analysis');
  await agent.call('binding.open', { externalSessionId: 'recovery-agent', adapter: 'claude-code-mcp' });
  assert.equal((await agent.call('action.lookup', { operationId: intent.operationId })).native.run_id, run.native.run_id);
  check('rebinding observes the original task without submitting it');
  const host = (await h('capability.list')).host.reply.value.host.pid;
  process.kill(host, 'SIGKILL');
  current = await until(() => agent.call('action.observe', { operationId: intent.operationId }), r => r.execution === 'unknown');
  assert.equal(current.native.run_id, run.native.run_id); assert.equal(current.integrity.state, 'incomplete'); assert.equal(current.domain.state, 'unchecked');
  const stillThere = await h('data.page', { resource: ref, offset: 0, limit: 1 }); assert.equal(stillThere.total, 4);
  const retained = await agent.call('action.retry', { operationId: intent.operationId });
  assert.equal(retained.execution, 'unknown'); assert.deepEqual(retained.core, run.core);
  const cancelled = await agent.call('action.cancel', { operationId: intent.operationId }); assert.equal(cancelled.cancellation.cli.exitCode, 3); assert.equal(cancelled.execution, 'unknown');
  assert.equal((await h('capability.list')).host.exitCode, 3);
  check('Host loss retains partial data, original identity, unknown outcome and unconfirmed cancellation');
  report.unknown = current; report.partial = table; report.partialRows = page.total;
  const exported = await h('workspace.export', { destination: 'partial-export' }); assert.equal(exported.state, 'complete');
  const q = await human.call('project.create', { name: 'restored-partial' });
  await fs.cp(path.join(p.root, 'partial-export'), path.join(q.root, 'import'), { recursive: true });
  const restored = await human.call('workspace.restore', { projectId: q.id, source: 'import' }); assert.equal(restored.execution, 'not-replayed');
  assert.equal((await human.call('data.page', { projectId: q.id, resource: ref, offset: 0, limit: 1 })).total, 4);
  assert.equal((await human.call('capability.list', { projectId: q.id })).host.exitCode, 3);
  check('actual partial export restores bytes and provenance without starting a Host');
  // Separate, explicit cleanup of the owned R process group cannot establish
  // a retroactive native outcome for the lost Host's journal.
  try { process.kill(-rPid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } rPid = undefined;
  const z = await human.call('project.create', { name: 'cancel-project' });
  await fs.writeFile(path.join(z.root, 'sleep.R'), 'args <- commandArgs(TRUE)\nout <- args[[1]]\ncat("entry\\n", file=paste0(out,".entries.jsonl"), append=TRUE)\ndir.create(out)\nwriteLines("ready",file.path(out,"ready"))\nSys.sleep(600)\n');
  const script = await human.call('document.open', { projectId: z.id, path: 'sleep.R' });
  const sleeper = await human.call('action.submit', { projectId: z.id, operationId: 'cancel-check', action: 'r.execute', actionVersion: '0.2.0', input: { args: [], requirements: [], artifacts: [], completion: null, script: { kind: 'buffer', documentId: script.id, version: script.version } } });
  await until(() => fs.stat(path.join(z.root, sleeper.plan.output, 'ready')).then(() => true, () => false), Boolean);
  const cancel = await human.call('action.cancel', { projectId: z.id, operationId: 'cancel-check' }); assert.equal(cancel.cancellation.cli.exitCode, 0);
  const stopped = await until(() => human.call('action.observe', { projectId: z.id, operationId: 'cancel-check' }), r => r.native?.terminal && !r.native?.held);
  assert.ok(stopped.native.status.Finished?.group_released); report.cancelled = stopped;
  check('explicit cancel acknowledgement and independently observed process-group release are separate facts');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.failure = e.message; process.exitCode = 1; process.stdout.write(JSON.stringify({ failure: e.message }) + '\n'); }
finally {
  if (rPid) { try { process.kill(-rPid, 'SIGTERM'); } catch {} }
  report.shutdown = await service.close();
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
