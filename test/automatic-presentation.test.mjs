import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { digest, canonical } from '@rho-workspace/plugin-contracts';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { Presentation } from '../dist/presentation.js';
import { Workspace } from '../dist/workspace.js';
import { TaskRouting } from '../dist/task-routing.js';
import { protocol } from '../dist/protocol.js';
import { presentationSchemas } from '../dist/presentation-contracts.js';
import { tableDomCoverageSchema } from '@rho-workspace/plugin-tables/contract';
import { presentationFixture, query } from './support/presentation.mjs';
async function fixture(config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-present-'));
  const s = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing', plugins: ['files', 'tables', 'agent'], ...config }).start();
  return { root, s, close: async () => { await s.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
test('automatic original/candidate composition uses frozen contracts, one native hint and receipt-first reuse at full capacity', async () => {
  assert.deepEqual(presentationSchemas.VisibilityInput.properties.coverage.anyOf[0], tableDomCoverageSchema);
  assert.deepEqual(protocol.operations['view.observe'], presentationSchemas.VisibilityInput);
  const f = await fixture({ workspace: { maxCompositions: 1 } });
  try {
    const a = await presentationFixture(f.root, f.s), accepted = await a.publish();
    const c = await a.call('composition.read', { compositionId: 'results' });
    assert.equal(c.version, 1); assert.equal(c.nodes[0].presentation.mode, 'split');
    assert.deepEqual(c.views.map(v => v.id), ['original', 'candidate']);
    const sourceRead = await a.call('data.page', { resource: a.ref, offset: 0, limit: 10 });
    const candidateRead = await a.call('data.page', { resource: c.views[1].bindings.data, offset: 0, limit: 10 });
    assert.equal(sourceRead.rows[7].score, 180); assert.equal(candidateRead.rows[7].score, 80);
    const first = await f.s.observeNativeOutput(a.project.id, accepted.accepted[2].eventId);
    const repeated = await f.s.observeNativeOutput(a.project.id, accepted.accepted[2].eventId);
    assert.deepEqual(first, repeated); assert.equal(repeated.presentation.commitVersion, 1);
    await a.call('view.protection.set', { compositionId: 'results', expectedVersion: 1, changeId: 'protect', viewId: 'original', protected: true });
    const after = await f.s.observeNativeOutput(a.project.id, accepted.accepted[2].eventId);
    assert.equal(after.presentation.commitVersion, 1); assert.equal(after.presentation.currentVersion, 2);
    await assert.rejects(a.call('composition.apply', { compositionId: 'results', expectedVersion: 2, changeId: 'geometry', operations: [{ op: 'replace', rootId: c.rootId, nodes: c.nodes.map(n => n.kind === 'group' ? { ...n, presentation: { mode: 'tabs' } } : n) }] }), e => e.error.kind === 'condition');
    assert.equal(f.s.bridge.owned.size, 0);
  } finally { await f.close(); }
});
test('post-commit witness failure recovers only the original transaction and exact binding', async () => {
  const f = await fixture();
  try {
    const a = await presentationFixture(f.root, f.s); await a.publish();
    const file = path.join(a.project.root, '.rho/rho/presentation.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.intents[0].witness = null; await fs.writeFile(file, JSON.stringify(saved));
    const workspace = new Workspace(a.project, f.s.plugins.project(a.project.root, a.project.id));
    const owner = new Presentation(a.project, workspace), route = await new TaskRouting(a.project).read();
    const save = owner.save.bind(owner); owner.save = async (...args) => { if (args[1].intents[0].witness) throw new Error('injected witness fsync failure'); return save(...args); };
    const pending = await owner.ensureBasic(saved.intents[0].input, route);
    assert.equal(pending.witnessState, 'pending'); assert.equal((await workspace.read('results')).version, 1);
    const recovered = await new Presentation(a.project, workspace).ensureBasic(saved.intents[0].input, route);
    assert.equal(recovered.witnessState, 'retained'); assert.equal(recovered.commitVersion, 1); assert.equal(recovered.currentVersion, 1);
  } finally { await f.close(); }
});
test('incompatible manual layout keeps its views, exposes pending placement and preserves the typed artifact', async () => {
  const f = await fixture();
  try {
    const a = await presentationFixture(f.root, f.s);
    const current = await a.call('composition.put', { compositionId: 'results', expectedVersion: 0, views: [{ id: 'manual', component: 'rho.table', version: '0.2.0', props: { title: 'My work' }, bindings: { data: a.ref } }], layout: {} });
    await a.publish();
    assert.deepEqual(await a.call('composition.read', { compositionId: 'results' }), current);
    const snap = await a.call('observation.snapshot');
    assert.equal(snap.presentation.pending.reason, 'condition');
    assert.equal((await a.call('data.page', { resource: snap.presentation.pending.resource, offset: 0, limit: 10 })).rows[7].score, 80);
  } finally { await f.close(); }
});
test('visibility checks typed owner values, authenticates the tab, preserves first across epochs and marks old layouts historical', async () => {
  const f = await fixture();
  try {
    const a = await presentationFixture(f.root, f.s), b = await presentationFixture(f.root, f.s, 'B');
    await a.publish(); await b.publish();
    const pairing = await f.s.browser.createPairing(a.project.root);
    const session = await f.s.browser.pair(pairing.code), browser = new RhoClient({ url: f.s.url, token: session.token });
    const snap = await browser.call('observation.snapshot', { projectId: a.project.id }), witness = snap.presentation.witnesses[0];
    const q = { offset: 0, limit: 200, sort: null, filter: null };
    const evidence = { projectId: a.project.id, taskId: 'grades', compositionId: 'results', compositionVersion: 1, witnessId: witness.witnessId, viewId: 'original', observationId: 'first', clientId: session.principalId, clientEpoch: 'epoch-1', rendererBuild: JSON.parse(await fs.readFile(new URL('../dist/web/renderer.json', import.meta.url))).rendererBuild, evidence: 'dom-visible', coverage: { kind: 'table-dom', resource: a.ref, query: q, loadedRows: 8, visibleRows: [{ entityKey: 'STU-008', columns: ['student_id', 'score'] }], namespace: 'class-A', rowValuesDigest: digest(canonical([a.ref, 'class-A', q, [['STU-008', [['student_id', 'STU-008'], ['score', 180]]]]])), documentVisible: true, panelWithinViewport: true, keyCellsWithinViewport: true, framesAfterData: 2, occlusion: 'element-hit-tested' }, time: { browserObservedAt: new Date().toISOString(), performanceNowMs: 10, clockDomain: 'browser-clock' } };
    const first = await browser.call('view.observe', evidence);
    await assert.rejects(a.call('view.observe', { ...evidence, clientId: 'operator' }), e => e.error.kind === 'unauthorized');
    assert.equal(first.firstResourceObservationId, 'first'); assert.deepEqual(await browser.call('view.observe', evidence), first);
    await assert.rejects(browser.call('view.observe', { ...evidence, observationId: 'bad-values', coverage: { ...evidence.coverage, rowValuesDigest: digest('bad') } }), e => e.error.kind === 'condition');
    await assert.rejects(browser.call('view.observe', { ...evidence, clientId: 'another-tab' }), e => e.error.kind === 'scope');
    await assert.rejects(browser.call('view.observe', { ...evidence, projectId: b.project.id }), e => e.error.kind === 'scope');
    await assert.rejects(browser.call('view.observe', { ...evidence, observationId: 'hidden-visible', coverage: { ...evidence.coverage, documentVisible: false } }), e => e.error.kind === 'condition');
    const hidden = await browser.call('view.observe', { ...evidence, observationId: 'hidden', evidence: 'hidden', coverage: null }); assert.equal(hidden.firstResourceObservationId, 'first');
    await a.call('view.protection.set', { compositionId: 'results', expectedVersion: 1, changeId: 'protect', viewId: 'original', protected: true });
    const updated = await browser.call('observation.snapshot', { projectId: a.project.id });
    const nextWitness = updated.presentation.witnesses.find(w => w.compositionVersion === 2);
    const nextFirst = await browser.call('view.observe', { ...evidence, compositionVersion: 2, witnessId: nextWitness.witnessId, clientEpoch: 'epoch-2', observationId: 'layout-first' });
    assert.equal(nextFirst.firstResourceObservationId, 'first'); assert.equal(nextFirst.firstLayoutObservationId, 'layout-first');
    const late = await browser.call('view.observe', { ...evidence, clientEpoch: 'epoch-2', observationId: 'late' });
    assert.equal(late.historicalAtReceipt, true); assert.equal(late.firstResourceObservationId, 'first');
    const history = JSON.parse(await fs.readFile(path.join(a.project.root, '.rho/rho/visibility.json')));
    assert.equal(history.indexes[digest(canonical(['grades', 'results', 'original', a.ref, session.principalId]))].latest, 'layout-first');
    const read = { projectId: a.project.id, taskId: 'grades', compositionId: 'results', viewId: 'original', clientId: session.principalId, query: { ...query, limit: 1 } };
    const page = await browser.call('view.observations.read', read); assert.equal(page.complete, false);
    assert.equal((await browser.call('view.observations.read', { ...read, query: { ...read.query, cursor: page.next } })).observations[0].request.observationId, 'hidden');
    await browser.call('view.observe', { ...evidence, observationId: 'after-page', evidence: 'hidden', coverage: null });
    await assert.rejects(browser.call('view.observations.read', { ...read, query: { ...read.query, cursor: page.next } }), e => e.error.kind === 'stale');
    const store = path.join(a.project.root, '.rho/rho/visibility.json'), bytes = await fs.readFile(store);
    f.s.config.visibility = { maxRecords: 5 };
    await assert.rejects(browser.call('view.observe', { ...evidence, observationId: 'over-count', evidence: 'hidden', coverage: null }), e => e.error.kind === 'limit');
    assert.deepEqual(await fs.readFile(store), bytes); assert.deepEqual(await browser.call('view.observe', evidence), first);
    f.s.config.visibility = { maxBytes: bytes.length + 1 };
    await assert.rejects(browser.call('view.observe', { ...evidence, observationId: 'over-bytes', evidence: 'hidden', coverage: null }), e => e.error.kind === 'limit');
    assert.deepEqual(await fs.readFile(store), bytes);
    f.s.config.visibility = {};
    await fs.rename(path.join(a.project.root, '.rho/rho/presentation.json'), path.join(a.project.root, '.rho/rho/presentation.saved'));
    await assert.rejects(f.s.configurePresentation(a.project.id, a.policy), e => e.kind === 'condition');
    assert.deepEqual(await fs.readFile(store), bytes);
    await fs.rename(path.join(a.project.root, '.rho/rho/visibility.json'), path.join(a.project.root, '.rho/rho/visibility.saved'));
    await assert.rejects(browser.call('view.observe', { ...evidence, observationId: 'missing-history' }), e => e.error.kind === 'storage');
  } finally { await f.close(); }
});
test('explicit new output configuration updates only the witnessed candidate, preserves human layout and never rolls back on a late old event', async () => {
  const f = await fixture();
  try {
    const a = await presentationFixture(f.root, f.s), initial = await a.publish();
    const first = await a.call('composition.read', { compositionId: 'results' });
    await a.call('composition.apply', { compositionId: 'results', expectedVersion: first.version, changeId: 'human-extra-view', operations: [{ op: 'replace', rootId: first.rootId, nodes: first.nodes.map(n => n.kind === 'group' ? { ...n, presentation: { mode: 'split', axis: 'horizontal', weights: [1,1,1] }, children: [...n.children, 'review'] } : n).concat([ { id: 'review', kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: 'My review' }, bindings: { data: a.ref } }]) }] });
    const before = await a.call('composition.read', { compositionId: 'results' });
    const policy = { ...a.policy, policyId: 'basic-tables-v2', candidateDeclaration: { ...a.policy.candidateDeclaration, path: 'outputs/candidate-v2.csv' } }, policyRef = digest(canonical(policy));
    const route = await new TaskRouting(a.project).read();
    await a.call('task.routing.put', { taskId: route.taskId, expectedVersion: route.version, changeId: 'next-output-policy', compositionId: route.compositionId, participants: route.participants, feedbackOwnerBindingId: route.feedbackOwnerBindingId, presenterBindingId: null, policyRef });
    await f.s.configurePresentation(a.project.id, policy);
    const csv = a.candidateCsv.replace('STU-008,80', 'STU-008,81'); await fs.writeFile(path.join(a.project.root, policy.candidateDeclaration.path), csv);
    const file = path.join(f.root, 'A-observer.private.json'), observer = await RhoClient.fromFile(file);
    const bindingId = route.participants[0].bindingId, at = new Date().toISOString();
    const output = { sourceSeq: 5, kind: 'artifact.ready', nativeToolUseId: 'tool-v2', at, output: { role: 'candidate', policyRef, expectedDigest: digest(csv), declaration: policy.candidateDeclaration } };
    const events = [{ sourceSeq: 3, kind: 'tool.requested', nativeToolUseId: 'tool-v2', tool: 'Bash', at, detailsRef: null, outcome: 'requested' }, { sourceSeq: 4, kind: 'tool.returned', nativeToolUseId: 'tool-v2', tool: 'Bash', at, detailsRef: null, outcome: 'returned' }, output];
    const accepted = await observer.call('binding.activity.append', { taskId: 'grades', bindingId, adapterId: 'adapter', adapterEpoch: 'epoch', events });
    const after = await a.call('composition.read', { compositionId: 'results' });
    assert.equal(after.version, before.version + 1); assert.deepEqual(after.nodes.filter(n => n.id !== 'candidate'), before.nodes.filter(n => n.id !== 'candidate'));
    const candidate = after.views.find(v => v.id === 'candidate'); assert.equal((await a.call('data.page', { resource: candidate.bindings.data, offset: 0, limit: 10 })).rows[7].score, 81);
    const historical = await f.s.observeNativeOutput(a.project.id, initial.accepted[2].eventId);
    assert.equal(historical.presentation.commitVersion, 1); assert.equal(historical.presentation.currentVersion, after.version);
    assert.deepEqual((await a.call('composition.read', { compositionId: 'results' })).nodes, after.nodes);
    assert.equal((await f.s.observeNativeOutput(a.project.id, accepted.accepted[2].eventId)).presentation.commitVersion, after.version);
    const state = JSON.parse(await fs.readFile(path.join(a.project.root, '.rho/rho/presentation.json')));
    assert.equal(state.configurations.length, 2);
    await assert.rejects(f.s.configurePresentation(a.project.id, { ...policy, candidateViewId: 'different' }), e => e.kind === 'condition');
    assert.equal(f.s.bridge.owned.size, 0);
  } finally { await f.close(); }
});
