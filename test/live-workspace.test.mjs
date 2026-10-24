import test from 'node:test';
import assert from 'node:assert/strict';
import { actLive, advanceLive, holdView, startLive, tickLive } from '../dist/live-workspace.js';
const at = '2026-10-24T14:00:00.000Z', ref = { id: 'a'.repeat(64), version: 'b'.repeat(64) }, nextRef = { id: 'c'.repeat(64), version: 'd'.repeat(64) };
const view = resource => ({ id: 'table', component: 'rho.table', version: '0.2.0', props: { title: 'Results' }, bindings: { data: resource } });
const composition = (version = 1, resource = ref) => ({ compositionId: 'work', version, author: 'agent:test', acknowledgedAt: at, views: [view(resource)], nodes: [{ kind: 'group', id: 'root', children: ['table'] }, { ...view(resource), kind: 'view' }], rootId: 'root' });
const run = (id = 'first', execution = 'completed') => ({ operationId: id, action: 'r.execute', execution, delivery: 'acknowledged', acceptedAt: at, author: 'agent:test', declared: [{ path: 'results.csv', present: true, bytes: 20 }], missing: [], completion: 'present', integrity: 'declared', domain: 'unchecked', script: null, sourceKey: 'same-source', hasStderr: false });
const resource = (r = ref, operationId = 'first') => ({ ...r, path: '.rho/' + operationId + '/results.csv', kind: 'table', bytes: 20, provenance: { operationId } });
const snapshot = (extra = {}) => ({ project: { id: 'project' }, documents: [], resources: [resource()], activity: { cursor: 0, retainedFrom: 1, entries: [] }, annotations: [], contexts: [], ...extra });

test('real layout retains an opened binding, stages Agent replacement and opens both exact versions', () => {
  const first = snapshot(), state = startLive(first, [run()], composition());
  holdView(state, 'table');
  const newer = snapshot({ resources: [resource(), resource(nextRef, 'second')] });
  advanceLive(state, newer, [run(), run('second')], composition(2, nextRef), 1000);
  assert.deepEqual(state.layout.views[0].bindings.data, ref);
  assert.equal(state.active, 'table'); assert.equal(state.expression.suggestions.length, 1);
  actLive(state, { kind: 'accept', suggestion: state.expression.suggestions[0].id });
  assert.deepEqual(state.layout.views.find(v => v.id === 'table').bindings.data, ref);
  assert.deepEqual(state.layout.views.find(v => v.id === state.active).bindings.data, nextRef);
  assert.equal(state.layout.views.length, 2);
  assert.notEqual(state.active, 'table'); // New selection scope cannot rebase old selected rows.
  const displayed = structuredClone(state.layout), moved = state.expression.moves.length;
  advanceLive(state, newer, [run(), run('second')], composition(2, nextRef), 2000);
  assert.deepEqual(state.layout, displayed); assert.equal(state.expression.moves.length, moved);
});

test('away/reload observes new failures and versions without replaying focus; missing calls stay missing', () => {
  let state = startLive(snapshot(), [run()], composition());
  holdView(state, 'table'); actLive(state, { kind: 'leave' });
  state = JSON.parse(JSON.stringify(state));
  advanceLive(state, snapshot({ resources: [resource(), resource(nextRef, 'second')], activity: { cursor: 12, retainedFrom: 12, entries: [{ cursor: 12, method: 'action.lookup', principal: 'agent:test', at, outcome: 'returned', operationId: 'second' }] } }), [run(), run('second', 'failed')], composition(2, nextRef), 1000);
  actLive(state, { kind: 'return' }); tickLive(state, 90000);
  assert.equal(state.active, 'table'); assert.equal(state.gap, true);
  assert.equal(state.expression.objects['run:2'].state, 'failed'); assert.equal(state.expression.objects['run:2'].exit, null);
  assert.equal(state.expression.objects['run:1'].verified.length, 0); // Registration/inventory != byte check.
  assert.ok(state.expression.digest.lines.some(l => l.kind === 'run' && l.state === 'failed'));
  assert.equal(state.evidence.filter(f => f.op === 'action.lookup').length, 1);
});

test('receipt is not a response; only an explicit Agent reply answers the original table rows', () => {
  const state = startLive(snapshot(), [run()], composition());
  const thread = { annotationId: 'q', anchor: { kind: 'table', resource: ref, entities: ['001'] }, messages: [{ id: 'original', author: 'browser:test', at, draft: { text: '解释这行 🧬' } }] };
  const context = { contextId: 'ctx', delivery: 'tool-fetched', fetchedBy: 'operator', fetchedAt: at, responses: [{ annotationId: 'q' }] };
  const observe = () => advanceLive(state, snapshot({ annotations: [thread], contexts: [context] }), [run()], composition(), 1000);
  observe(); assert.equal(state.expression.objects['question:q'].state, 'prepared');
  context.fetchedBy = 'agent:test'; observe(); assert.equal(state.expression.objects['question:q'].state, 'fetched');
  thread.messages.push({ id: 'reply', replyTo: 'someone-else', author: 'agent:test', at, draft: { text: 'Unrelated' } });
  observe(); assert.equal(state.expression.objects['question:q'].state, 'fetched');
  thread.messages[1].replyTo = 'original'; observe(); assert.equal(state.expression.objects['question:q'].state, 'responded');
  assert.deepEqual(state.expression.objects['question:q'].rows, ['001']);
  assert.equal(state.expression.objects['question:q'].version, ref.version);
});

test('a burst of recorded times cannot bypass live presentation pacing', () => {
  const state = startLive(snapshot(), [run()], composition());
  const entries = [1, 2, 3].map(n => ({ cursor: n, principal: 'agent:test', method: 'action.lookup', outcome: 'returned', at: `2026-10-24T14:0${n}:00Z`, operationId: 'run-' + n }));
  advanceLive(state, snapshot({ activity: { cursor: 3, retainedFrom: 1, entries } }), [run(), ...entries.map((_, i) => run('run-' + (i + 1)))], composition(), 1000);
  assert.equal(state.expression.moves.filter(m => m.by === 'agent').length, 1);
  const first = state.active; tickLive(state, 8999); assert.equal(state.active, first);
  tickLive(state, 9000); assert.equal(state.active, 'execution:run-3');
});

test('acceptance alone does not invent execution progress or an exit code', () => {
  const state = startLive(snapshot(), [run('first', 'unobserved')], composition());
  assert.equal(state.expression.objects['run:1'].state, 'unobserved');
  advanceLive(state, snapshot(), [run('first', 'active')], composition(), 1000);
  assert.equal(state.expression.objects['run:1'].state, 'running');
  advanceLive(state, snapshot(), [run('first', 'completed')], composition(), 2000);
  assert.equal(state.expression.objects['run:1'].state, 'completed');
  assert.equal(state.expression.objects['run:1'].exit, null);
});

test('an observed artifact family stays stable when its producer leaves the bounded run window', () => {
  const state = startLive(snapshot(), [run()], composition());
  holdView(state, 'table');
  const original = structuredClone(state.refs[ref.id + '@' + ref.version]);
  advanceLive(state, snapshot(), [], composition(), 1000);
  assert.deepEqual(state.refs[ref.id + '@' + ref.version], original);
  assert.equal(state.expression.objects['artifact:same-source/results.csv'].versions.length, 1);
  assert.deepEqual(state.layout.views[0].bindings.data, ref);
});

test('actual document reads create one owner preview without requiring a declared view or a task map', () => {
  const documents = [{ id: 'd1', path: 'first.md', version: 2, dirty: true, acknowledgedAt: at }, { id: 'd2', path: 'second.md', version: 1, dirty: false, acknowledgedAt: at }];
  const base = snapshot({ documents, catalog: { components: [{ id: 'rho.editor', version: '0.2.0', bindings: { document: 'document' } }] } });
  const state = startLive(base, [run()], composition());
  assert.equal(state.expression.objects['source:first.md'].savedVersion, null); // Dirty metadata is not a saved source revision.
  const observe = (cursor, documentId, now) => advanceLive(state, { ...base, activity: { cursor, retainedFrom: 1, entries: [{ cursor, principal: 'agent:test', method: 'document.read', at, outcome: 'returned', documentId, returnedVersion: 1 }] } }, [run()], composition(), now);
  observe(1, 'd1', 1000); assert.equal(state.active, 'source:d1');
  assert.deepEqual(state.layout.views.at(-1).bindings, { document: { kind: 'live-document', documentId: 'd1' } });
  observe(2, 'd2', 9000); assert.equal(state.active, 'source:d2');
  assert.equal(state.layout.views.some(v => v.id === 'source:d1'), false);
  assert.equal(state.layout.views.filter(v => v.id.startsWith('source:')).length, 1);
});
