// One headless consumer runner for explicitly selected ordinary project files.
// Recipes and domain assertions live with that project, outside the npm package.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { RhoService, RhoClient, native } from './support.mjs';
const root = path.resolve(process.argv[2] ?? 'work/acceptance-' + Date.now());
const source = path.resolve(process.argv[3] ?? process.env.RHO_ACCEPTANCE_PROJECT ?? '');
assert.ok(process.argv[3] || process.env.RHO_ACCEPTANCE_PROJECT, 'Select an explicit project directory as the second argument or RHO_ACCEPTANCE_PROJECT.');
const specification = JSON.parse(await fs.readFile(path.join(source, 'project.json'), 'utf8'));
assert.equal(specification.schemaVersion, 1);
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native }).start();
const report = { schemaVersion: 2, status: 'running', project: specification.name, projectSpecSha256: sha(JSON.stringify(specification)), platform: process.platform + '-' + process.arch, node: process.version, checks: [], runs: {} };
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function check(name, facts = {}) { report.checks.push({ name, ...facts }); process.stdout.write(JSON.stringify({ passed: name, ...facts }) + '\n'); }
function relative(name) { assert.ok(typeof name === 'string' && !path.isAbsolute(name) && !name.split('/').some(p => ['..', '.git', '.rho', ''].includes(p))); return name; }
let project, call;
const runs = new Map(), resources = new Map();
const ref = r => ({ id: r.id, version: r.version });
const get = s => { const r = resources.get(s.run + ':' + s.artifact); assert.ok(r, 'Selected resource must have been collected: ' + JSON.stringify(s)); return r; };
async function terminal(id) {
  const end = Date.now() + 900000;
  while (Date.now() < end) {
    const run = await call('action.observe', { operationId: id });
    if (['completed', 'failed'].includes(run.execution)) return run;
    if (run.execution === 'unknown') throw new Error('Native outcome unknown; original identity retained: ' + id);
    await setTimeout(500);
  }
  throw new Error('Execution observation budget exceeded; original identity retained: ' + id);
}
try {
  const c = new RhoClient({ url: service.url, token: service.adminToken });
  project = await c.call('project.create', { name: 'project' });
  call = (method, input = {}) => c.call(method, { projectId: project.id, ...input });
  for (const name of specification.files) {
    relative(name);
    assert.equal((await fs.lstat(path.join(source, name))).isFile(), true);
    await fs.mkdir(path.dirname(path.join(project.root, name)), { recursive: true });
    await fs.copyFile(path.join(source, name), path.join(project.root, name));
  }
  const opened = await c.call('project.open', { path: 'project' });
  const catalog = await call('capability.list');
  assert.equal(opened.host.exitCode, 3); assert.deepEqual(catalog.actions.map(a => a.id), ['r.execute']);
  check('base catalog and project/document reads start no Host');
  let first;
  for (const spec of specification.runs) {
    let dependencies = await call('requirements.check', { requirements: spec.requirements });
    if (dependencies.status === 'missing') {
      await call('requirements.prepare', { operationId: 'prepare-' + spec.id, requirements: spec.requirements });
      const prepared = await terminal('prepare-' + spec.id);
      assert.equal(prepared.execution, 'completed'); assert.equal(prepared.checks.status, 'present');
      report.checks.push({ name: 'explicit dependency preparation', run: spec.id, requirements: spec.requirements });
    } else assert.equal(dependencies.status, 'present');
    const args = [];
    for (const arg of spec.args) {
      if (typeof arg === 'string') args.push(arg);
      else if (arg.outputOf) args.push(path.join(project.root, runs.get(arg.outputOf).plan.output));
      else if (arg.file) {
        const bytes = await fs.readFile(path.join(project.root, relative(arg.file)));
        const resource = await call('resource.register', { declaration: { path: arg.file, kind: 'file', format: { mimeType: 'application/octet-stream' } }, expectedDigest: sha(bytes) });
        args.push({ resource: ref(resource) });
      } else args.push({ resource: ref(get(arg)) });
    }
    const script = await fs.readFile(path.join(project.root, relative(spec.script)));
    const input = { script: { kind: 'disk', path: spec.script, digest: sha(script) }, args, requirements: spec.requirements, artifacts: spec.artifacts, completion: spec.completion };
    const intent = await c.retainOperation(path.join(root, 'intent-' + spec.id + '.json'), { projectId: project.id, action: 'r.execute', actionVersion: '0.2.0', input });
    const accepted = await c.call('action.submit', intent);
    assert.equal(accepted.lastCli.exitCode, 0);
    const duplicate = await c.call('action.submit', intent); assert.equal(duplicate.native.run_id, accepted.native.run_id);
    await assert.rejects(c.call('action.submit', { ...intent, input: { ...input, args: [...args, 'changed'] } }), e => e.error.kind === 'conflict');
    const final = await terminal(intent.operationId);
    assert.equal(final.execution, 'completed', 'Project run failed: ' + spec.id);
    runs.set(spec.id, final); first ??= spec;
    // The selected project consumer declares byte completeness after observing
    // exit zero. This is separate from execution and from project domain checks.
    const inventory = [];
    for (const d of spec.artifacts) {
      const bytes = await fs.readFile(path.join(project.root, final.plan.output, relative(d.path)));
      inventory.push({ path: d.path, bytes: bytes.length, sha256: sha(bytes) });
    }
    // Keep the transport inventory beside the output directory. A producer may
    // independently require an exact, immutable artifact inventory inside it.
    await fs.writeFile(path.join(project.root, final.plan.completion), JSON.stringify({ schemaVersion: 1, complete: true, authority: 'explicit-project-acceptance-client', artifacts: inventory }) + '\n', { flag: 'wx' });
    const facts = await call('artifact.check', { operationId: intent.operationId });
    assert.equal(facts.integrity.state, 'verified'); assert.equal(facts.domain.state, 'unchecked');
    for (const resource of facts.resources) resources.set(spec.id + ':' + resource.path.slice(final.plan.output.length + 1), resource);
    const entries = await fs.readFile(path.join(project.root, final.plan.output + '.entries.jsonl'), 'utf8');
    assert.equal(entries.trim().split('\n').length, 1);
    report.runs[spec.id] = { operationId: intent.operationId, core: final.core, nativeRunId: final.native.run_id, output: final.plan.output, integrity: facts.integrity, resources: facts.resources };
    check('same generic execution, declared artifact integrity and one dispatch', { run: spec.id, artifacts: facts.resources.length });
  }
  for (const spec of specification.tables) {
    const resource = get(spec);
    const page = await call('data.page', { resource: ref(resource), offset: 0, limit: 10 });
    assert.equal(page.total, spec.rows); assert.equal(page.entityKey, spec.key); assert.equal(page.namespace, spec.namespace);
    const marker = await call('data.page', { resource: ref(resource), offset: 0, limit: 10, filter: { column: spec.literal.column, op: 'eq', value: spec.literal.value } });
    assert.equal(marker.rows.some(r => r[spec.key] === spec.entity), true);
    await call('selection.set', { resource: ref(resource), entities: [spec.entity] });
    const context = await call('context.create', { resource: ref(resource), entities: [spec.entity] });
    assert.equal(context.resource.rows[0][spec.key], spec.entity);
    const plot = await call('data.plot', { resource: ref(resource), x: spec.x, y: spec.y, maxPoints: 1000 });
    assert.equal(plot.originalPoints, spec.rows); assert.equal(plot.downsampled, spec.rows > 1000);
    check('declared keys, string values, selection, explicit context and chart fields', { rows: spec.rows, key: spec.key });
  }
  const cmp = specification.comparison;
  const comparison = await call('data.compare', { left: ref(get(cmp.left)), right: ref(get(cmp.right)), options: cmp.options });
  const joined = await call('data.page', { resource: ref(comparison), offset: 0, limit: 10 });
  assert.equal(joined.total, specification.tables[0].rows);
  assert.deepEqual(comparison.provenance.inputs, [ref(get(cmp.left)), ref(get(cmp.right))]);
  const view = { id: 'table', component: 'rho.table', version: '0.2.0', props: { title: 'Project comparison' }, bindings: { data: ref(comparison) } };
  await call('composition.put', { compositionId: 'project', expectedVersion: 0, views: [view, { ...view, id: 'missing', component: 'optional.uninstalled', version: '9' }], layout: {} });
  check('two input versions and declared join; missing entry retains references');
  for (const spec of specification.reports) {
    const snapshot = await call('object.read', { resource: ref(get(spec)) });
    assert.equal(snapshot.value[spec.field], spec.value, 'Project-owned domain check report: ' + spec.artifact);
  }
  for (const resource of resources.values()) {
    if (resource.kind === 'object') assert.equal((await call('object.read', { resource: ref(resource) })).observation, 'exported-snapshot');
    if (resource.kind === 'media') {
      const media = await call('media.describe', { resource: ref(resource) }); assert.equal(media.original.version, resource.version);
      if (media.width && media.height) {
        const context = await call('context.create', { resource: ref(resource), region: { page: 1, x: 0, y: 0, width: 10, height: 10, units: media.mimeType === 'application/pdf' ? 'points' : 'pixels' } });
        assert.equal(context.region.resource.version, resource.version);
      }
    }
  }
  check('original media, coordinate context and bounded exported object snapshots');
  const draft = await call('document.open', { path: first.script });
  await call('document.edit', { documentId: draft.id, expectedVersion: draft.version, edits: [{ from: 0, to: 0, insert: '# Unsaved 中文 🧬\n' }], undoGroup: 'export' });
  await call('workspace.export', { destination: 'export' });
  const q = await c.call('project.create', { name: 'restored' });
  await fs.cp(path.join(project.root, 'export'), path.join(q.root, 'import'), { recursive: true });
  const restored = await c.call('workspace.restore', { projectId: q.id, source: 'import' });
  assert.equal(restored.execution, 'not-replayed'); assert.equal(restored.documents[0].state, 'available'); assert.ok(restored.resources.every(r => r.state === 'available'));
  const snapshot = await c.call('observation.snapshot', { projectId: q.id });
  assert.equal(snapshot.operations.length, 0); assert.equal(snapshot.host.exitCode, 3); assert.equal(snapshot.documents[0].dirty, true);
  assert.equal(snapshot.compositions[0].availability.missing.state, 'unavailable');
  assert.equal((await c.call('data.page', { projectId: q.id, resource: ref(comparison), offset: 0, limit: 1 })).total, joined.total);
  check('actual export/restore preserves bytes, undo, unsaved text and unavailable entries without replay');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.failure = e.stack; process.exitCode = 1; process.stdout.write(JSON.stringify({ failure: e.message }) + '\n'); }
finally { report.shutdown = await service.close(); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
