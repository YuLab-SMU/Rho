import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { RhoService, RhoClient, native, packageRoot } from './support.mjs';
const root = path.resolve(process.argv[2] ?? 'work/acceptance-' + Date.now());
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native }).start();
const report = { status: 'running', platform: process.platform + '-' + process.arch, node: process.version, checks: [] };
const check = (name, data = {}) => { report.checks.push({ name, ...data }); process.stdout.write(JSON.stringify({ passed: name, ...data }) + '\n'); };
try {
  const c = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await c.call('project.create', { name: 'airway' });
  const call = (method, input = {}) => c.call(method, { projectId: p.id, ...input });
  const opened = await c.call('project.open', { path: 'airway' });
  assert.equal(opened.host.exitCode, 3); check('project open does not start a Host');
  const requirements = await call('requirements.check', { action: 'airway.analyze' });
  assert.equal(requirements.status, 'present'); check('action-local dependencies', { action: requirements.action, R: requirements.native.R });
  const shrinkRequirements = await call('requirements.check', { action: 'airway.shrink' });
  let prepare;
  if (shrinkRequirements.status === 'missing') {
    prepare = await call('requirements.prepare', { operationId: 'prepare-apeglm', action: 'airway.shrink' });
    check('explicit scoped dependency preparation accepted', { delivery: prepare.delivery });
  }
  const code = await fs.readFile(path.join(packageRoot, 'node_modules/@rho-workspace/headless/examples/real-r-analysis/analyze.R'));
  await fs.writeFile(path.join(p.root, 'analysis.R'), code);
  const input = { bootstrapReplicates: 1, script: { kind: 'disk', path: 'analysis.R', digest: createHash('sha256').update(code).digest('hex') } };
  const intent = await c.retainOperation(path.join(root, 'analysis-intent.json'), { projectId: p.id, action: 'airway.analyze', actionVersion: '0.1.0', input });
  const accepted = await c.call('action.submit', intent);
  assert.equal(accepted.lastCli.exitCode, 0); assert.ok(accepted.native.run_id); check('real analysis accepted through public Core CLI');
  const duplicate = await c.call('action.submit', intent);
  assert.equal(duplicate.native.run_id, accepted.native.run_id); check('identical HTTP delivery retains native identity');
  await assert.rejects(c.call('action.submit', { ...intent, input: { bootstrapReplicates: 2 } }), e => e.error.kind === 'conflict');
  check('changed input under original identity is rejected');
  async function wait(operationId, timeout = 900000) {
    const deadline = Date.now() + timeout; let view;
    do {
      view = await call('action.observe', { operationId });
      if (['completed', 'failed'].includes(view.execution)) return view;
      if (Date.now() > deadline) throw new Error('Acceptance time budget exceeded; original operation retained.');
      await setTimeout(1000);
    } while (true);
  }
  const final = await wait(intent.operationId);
  assert.equal(final.execution, 'completed'); check('real native execution completed', { nativeExit: final.native.status });
  const all = await call('resource.list', { operationId: intent.operationId });
  const table = all.resources.find(r => r.path.endsWith('/results/full.csv'));
  const model = all.resources.find(r => r.path.endsWith('/models/full.rds'));
  assert.ok(table && model); assert.ok(all.resources.some(r => r.path.endsWith('/plots/qc-and-response.pdf')));
  check('script, table, model and scientific PDF references', { artifacts: all.resources.length });
  const verified = await call('artifact.check', { operationId: intent.operationId });
  assert.equal(verified.integrity.state, 'verified'); assert.equal(verified.domain.state, 'passed'); check('independent arithmetic and saved native models', { arithmeticExit: verified.domain.arithmeticExit, nativeExit: verified.domain.nativeExit });
  const ref = { id: table.id, version: table.version };
  const page = await call('data.page', { resource: ref, offset: 0, limit: 10, sort: { column: 'log2FoldChange', direction: 'desc' } });
  assert.equal(page.total, 16139);
  const marker = await call('data.page', { resource: ref, offset: 0, limit: 10, filter: { column: 'symbol', op: 'eq', value: 'KLF15' } });
  assert.equal(marker.rows[0].gene_id, 'ENSG00000163884');
  const selection = await call('selection.set', { resource: ref, entities: ['ENSG00000163884'] });
  assert.equal(selection.entities[0], marker.rows[0].gene_id); check('16139 real rows and stable KLF15 selection');
  const plot = await call('data.plot', { resource: ref, maxPoints: 1000 });
  assert.equal(plot.originalPoints, 16139); assert.equal(plot.downsampled, true); check('actual interactive plot data and marked downsampling');
  if (prepare) { const prepared = await wait('prepare-apeglm'); assert.equal(prepared.execution, 'completed'); assert.equal(prepared.checks.status, 'present'); check('dependency preparation rechecked'); }
  const shrink = await call('action.submit', { operationId: 'shrink-001', action: 'airway.shrink', actionVersion: '0.1.0', input: { model: { id: model.id, version: model.version }, baseline: ref } });
  assert.equal(shrink.lastCli.exitCode, 0);
  const shrinkFinal = await wait('shrink-001'); assert.equal(shrinkFinal.execution, 'completed');
  const shrinkArtifacts = await call('resource.list', { operationId: 'shrink-001' });
  const shrinkTable = shrinkArtifacts.resources.find(r => r.path.endsWith('/shrinkage.csv'));
  const shrinkCheck = await call('artifact.check', { operationId: 'shrink-001' }); assert.equal(shrinkCheck.domain.state, 'passed');
  const comparison = await call('data.compare', { baseline: ref, shrinkage: { id: shrinkTable.id, version: shrinkTable.version } });
  const comparisonPage = await call('data.page', { resource: { id: comparison.id, version: comparison.version }, offset: 0, limit: 10 });
  assert.equal(comparisonPage.total, 16139); check('real apeglm action and two-input gene join', { genes: comparisonPage.total });
  const joined = { id: comparison.id, version: comparison.version };
  const scatter = await call('data.plot', { resource: joined, maxPoints: 20000 });
  assert.equal(scatter.points.length, 16139); assert.equal(scatter.points[0].y, comparisonPage.rows[0].y);
  const views = ['rho.table', 'rho.scatter'].map((component, i) => ({ id: 'view-' + i, component, version: '0.1.0', props: { title: 'Same comparison' }, bindings: { data: joined }, selection: ['ENSG00000163884'] }));
  const composed = await call('composition.put', { compositionId: 'comparison', expectedVersion: 0, views, layout: { direction: 'horizontal' } });
  assert.equal(composed.views[0].bindings.data.id, composed.views[1].bindings.data.id);
  check('registered table and scatter share the actual two-input comparison');
  const draft = await call('document.open', { path: 'analysis.R' });
  await call('document.edit', { documentId: draft.id, expectedVersion: draft.version, edits: [{ from: 0, to: 0, insert: '# Acknowledged unsaved draft · 中文 🧬\n' }], undoGroup: 'export-draft' });
  const exported = await call('workspace.export', { destination: 'export' }); assert.equal(exported.state, 'complete');
  const restoredProject = await c.call('project.create', { name: 'restored' });
  await fs.cp(path.join(p.root, 'export'), path.join(restoredProject.root, 'import'), { recursive: true });
  const restored = await c.call('workspace.restore', { projectId: restoredProject.id, source: 'import' });
  assert.equal(restored.resources.every(r => r.state === 'available'), true); assert.equal(restored.documents[0].state, 'available');
  assert.equal((await c.call('data.page', { projectId: restoredProject.id, resource: joined, offset: 0, limit: 1 })).total, 16139);
  assert.equal((await c.call('observation.snapshot', { projectId: restoredProject.id })).operations.length, 0);
  check('real scientific bytes, draft and linked composition restore without replay');
  const entries = (await fs.readFile(path.join(p.root, accepted.plan.output + '.entries.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(entries.length, 1); check('one native dispatch entry for duplicate submission');
  report.status = 'passed'; report.projectId = p.id;
  report.baseline = { table: ref, model: { id: model.id, version: model.version }, operationId: intent.operationId };
  report.shrinkage = { id: shrinkTable.id, version: shrinkTable.version };
} catch (e) { report.status = 'failed'; report.failure = e.message; process.exitCode = 1; process.stdout.write(JSON.stringify({ failure: e.message }) + '\n'); }
finally { report.shutdown = await service.close(); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
