// Explicit capture only: these responses are inert data, never action replay inputs.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { runtime } from '../dist/runtime.js';
import { publicOperation } from '../dist/requests.js';
const { values } = parseArgs({ options: { recovery: { type: 'string' }, completed: { type: 'string' }, failed: { type: 'string' } } });
if (!values.recovery || !values.completed || !values.failed) throw new Error('Select actual --recovery REPORT, --completed OPERATION and --failed OPERATION records.');
const recovery = JSON.parse(await fs.readFile(values.recovery, 'utf8'));
if (recovery.status !== 'passed') throw new Error('Capture requires a passed recovery experiment.');
const projectedRun = run => {
  const { checks, lastCli, ...publicRun } = run;
  const n = run.native;
  return { ...publicRun, native: n && { run_id: n.run_id, request_id: n.request_id, status: n.status, held: n.held, terminal: n.terminal, stdout: n.stdout, stderr: n.stderr },
    plan: { ...run.plan, args: run.plan.args.map((x, i) => x.startsWith('/') ? '/fixture/project/argument-' + i : x) },
    ...(lastCli ? { lastCli: { exitCode: lastCli.exitCode, reply: { ok: lastCli.reply.ok, scope: 'Native record and machine paths omitted from this display fixture.' } } } : {}) };
};
const success = value => ({ apiVersion: '1.0', ok: true, value });
const cases = [];
const add = (state, operation, value, provenance) => cases.push({ state, operation, provenance, envelope: success(value) });
const root = path.resolve('work/fixtures-' + Date.now()); await fs.mkdir(root, { recursive: true });
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime(), documents: { maxBufferBytes: 32 } }).start();
try {
  const c = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await c.call('project.create', { name: 'fixture-project' });
  const call = (m, b = {}) => c.call(m, { projectId: p.id, ...b });
  add('empty', 'observation.snapshot', await call('observation.snapshot'), 'Captured from a new project; no Host started.');
  add('loading', 'action.observe', projectedRun(recovery.loading), 'Captured while the real full DESeq2 fit was paused and its owned Host remained available.');
  add('completed', 'action.observe', projectedRun(publicOperation(JSON.parse(await fs.readFile(values.completed, 'utf8')))), 'Captured after the real science and independent artifact/native checks.');
  add('failed', 'action.observe', projectedRun(publicOperation(JSON.parse(await fs.readFile(values.failed, 'utf8')))), 'Retained first scientific trial: bootstrap=1 exposed the singleton histogram failure, later repaired in the recipe.');
  add('partial', 'resource.list', { resources: [recovery.partial], integrity: { state: 'incomplete', completionDeclaration: 'absent' }, domain: { state: 'unchecked' } }, 'Projection of the real 16,139-row first fit, without a completion declaration.');
  add('unknown', 'action.observe', projectedRun(recovery.unknown), 'Captured after SIGKILL of the owned Host; earlier native facts do not establish its later outcome.');
  add('unavailable', 'composition.put', await call('composition.put', { compositionId: 'unavailable', expectedVersion: 0, views: [{ id: 'missing', component: 'missing.component', version: '0.1.0', props: {}, bindings: {} }], layout: {} }), 'Captured from actual composition validation; no UI entry is installed.');
  let d = await call('document.open', { path: 'draft.R' });
  d = await call('document.edit', { documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: '# 中文 🧬\nx <- 1\n' }], undoGroup: 'initial' });
  async function rejection(state, operation, body) {
    try { await call(operation, body); throw new Error('Expected a typed rejection.'); }
    catch (e) { if (!e.error) throw e; cases.push({ state, operation, provenance: 'Captured from the real versioned service; acknowledged buffer retained.', envelope: { apiVersion: '1.0', ok: false, error: e.error } }); }
  }
  await rejection('stale', 'document.edit', { documentId: d.id, expectedVersion: 1, edits: [{ from: 0, to: 0, insert: 'old' }], undoGroup: 'old' });
  await fs.writeFile(path.join(p.root, 'draft.R'), 'external write\n');
  await rejection('conflict', 'document.save', { documentId: d.id, expectedVersion: d.version, expectedDiskDigest: d.diskDigest });
  await rejection('limit', 'document.edit', { documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'x'.repeat(33) }], undoGroup: 'over' });
} finally { await service.close(); }
const scrub = value => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  if (typeof value === 'string') return value.startsWith('/') ? '/fixture/' + path.basename(value) : value.replaceAll(root, '/fixture/capture');
  return value;
};
await fs.mkdir('fixtures/v1', { recursive: true });
await fs.writeFile('fixtures/v1/states.json', JSON.stringify(scrub({ apiVersion: '1.0', schemaVersion: 1, readOnly: true, replay: 'forbidden', capturedAt: new Date().toISOString(), scope: 'Actual response captures/projections. Native records, executable source, credentials and machine paths are omitted. UI rendering states require independent browser acceptance.', cases }), null, 2) + '\n');
process.stdout.write(JSON.stringify({ fixtures: cases.map(x => x.state) }) + '\n');
