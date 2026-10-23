import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { digest, canonical } from '@rho-workspace/plugin-contracts';
import { nativeSchemas as ownerSchemas } from '@rho-workspace/plugin-agent/contract';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { protocol } from '../dist/protocol.js';
const caps = { inputMode: 'pull-tool-result', inboxLookup: false, inboxDeduplication: 'none', hookEmissionDeduplication: 'none', modelConsumptionAck: false, nativeExecutionDeduplication: false };
const policyRef = digest('selected-test-policy');
const query = { after: 0, cursor: null, limit: 100, maxBytes: 65536 };
const tool = (sourceSeq, kind = 'tool.requested', id = 'tool-1') => ({ sourceSeq, kind, nativeToolUseId: id, tool: 'Bash', at: '2026-10-21T00:00:00Z', detailsRef: null, outcome: kind === 'tool.requested' ? 'requested' : 'returned' });
async function fixture(config = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-native-'));
  const s = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing', plugins: ['files', 'tables', 'agent'], ...config }).start();
  const admin = new RhoClient({ url: s.url, token: s.adminToken });
  const p = await admin.call('project.create', { name: 'grades' });
  const call = (m, b = {}) => admin.call(m, { projectId: p.id, ...b });
  const make = async (session, methods) => { const file = path.join(root, session + '.json'); const c = await s.agentConnection(p.id, session, file, methods); return { client: await RhoClient.fromFile(file), principal: 'agent:' + digest(p.id + ':' + session).slice(0, 32), descriptor: c }; };
  const business = await make('native-session', ['binding.open', 'binding.activity']);
  const adapter = await make('observer', ['binding.activity.append']);
  s.registerNativeAdapter({ projectId: p.id, taskId: 'grades', registrationId: 'selected-cli', principal: business.principal, adapterPrincipal: adapter.principal, externalSessionId: 'native-session', transportCapabilities: caps, proof: { kind: 'claude-code-init', sessionId: 'native-session', clientVersion: '2.1.304' } });
  const binding = await business.client.call('binding.open', { externalSessionId: 'native-session', adapter: 'claude-code-mcp', attachment: { taskId: 'grades', role: 'business', adapterRegistrationId: 'selected-cli', transportCapabilities: caps } });
  const route = { taskId: 'grades', expectedVersion: 0, changeId: 'route-1', compositionId: 'views', participants: [{ bindingId: binding.id, role: 'business' }], feedbackOwnerBindingId: binding.id, presenterBindingId: null, policyRef };
  const routed = await call('task.routing.put', route);
  const append = events => adapter.client.call('binding.activity.append', { taskId: 'grades', bindingId: binding.id, adapterId: 'selected-cli', adapterEpoch: 'epoch-1', events });
  return { root, s, p, admin, call, business, adapter, binding, route, routed, append, close: async () => { await s.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
test('selected phase 0 native schemas preserve exact public/owner parity', () => {
  for (const [method, name] of [['binding.open', 'BindingOpenExtended'], ['binding.activity.append', 'ActivityAppendInput']]) {
    const input = structuredClone(protocol.operations[method]); delete input.properties.projectId; input.required = input.required.filter(x => x !== 'projectId');
    assert.deepEqual(input, ownerSchemas[name]);
  }
  assert.deepEqual(protocol.responses['binding.activity.append'], ownerSchemas.ActivityAppendOutput);
});
test('native attachment, conditional task routing, target isolation and additive legacy log', async () => {
  const f = await fixture();
  try {
    const ordinary = await f.s.agentConnection(f.p.id, 'ordinary-model', path.join(f.root, 'ordinary.private.json'));
    assert.equal(ordinary.methods.includes('binding.activity.append'), false);
    assert.equal(ordinary.methods.includes('task.routing.put'), false);
    await assert.rejects(f.s.agentConnection(f.p.id, 'control-model', path.join(f.root, 'control.private.json'), ['task.routing.put']), /operator-only/);
    assert.deepEqual(await f.call('task.routing.put', f.route), f.routed);
    await assert.rejects(f.call('task.routing.put', { ...f.route, compositionId: 'other' }), e => e.error.kind === 'conflict');
    await assert.rejects(f.call('task.routing.put', { ...f.route, taskId: 'another', changeId: 'route-2', expectedVersion: 1 }), e => e.error.kind === 'condition');
    await assert.rejects(f.business.client.call('binding.open', { externalSessionId: 'forged', adapter: 'claude-code-mcp', attachment: f.binding.attachment }), e => e.error.kind === 'scope');
    await assert.rejects(f.call('binding.activity.append', { taskId: 'grades', bindingId: f.binding.id, adapterId: 'selected-cli', adapterEpoch: 'epoch-1', events: [tool(0)] }), e => e.error.kind === 'unauthorized');
    const first = await f.append([tool(0), tool(1, 'tool.returned')]);
    const concurrent = await Promise.all([f.append([tool(0), tool(1, 'tool.returned')]), f.append([tool(0), tool(1, 'tool.returned')])]);
    assert.ok(concurrent.every(x => canonical(x.accepted) === canonical(first.accepted)));
    assert.deepEqual((await f.append([tool(0), tool(1, 'tool.returned')])).accepted, first.accepted);
    await assert.rejects(f.append([{ ...tool(0), tool: 'Write' }]), e => e.error.kind === 'conflict');
    await assert.rejects(f.append([tool(2, 'tool.returned', 'unobserved')]), e => e.error.kind === 'condition');
    const native = await f.call('binding.activity', { source: 'native', taskId: 'grades', query: { ...query, limit: 1 } });
    assert.equal(native.entries.length, 1); assert.ok(native.next);
    assert.equal((await f.call('binding.activity', { source: 'native', taskId: 'grades', query: { ...query, limit: 1, cursor: native.next } })).entries[0].event.kind, 'tool.returned');
    const q = await f.admin.call('project.create', { name: 'another-project' });
    await assert.rejects(f.adapter.client.call('binding.activity.append', { projectId: q.id, taskId: 'grades', bindingId: f.binding.id, adapterId: 'selected-cli', adapterEpoch: 'epoch-1', events: [tool(2)] }), e => e.error.kind === 'scope');
    await assert.rejects(f.call('workspace.export', { destination: 'archive', format: 3 }), e => e.error.kind === 'condition');
    const routeFile = path.join(f.p.root, '.rho/rho/task-routing.json'), savedRoute = await fs.readFile(routeFile);
    const nextRoute = { ...f.route, expectedVersion: 1, changeId: 'route-byte-boundary' };
    await f.call('task.routing.put', nextRoute);
    const nextBytes = (await fs.readFile(routeFile)).length;
    await fs.writeFile(routeFile, savedRoute);
    f.s.config.maxRetainedMetadataBytes = nextBytes - 1;
    await assert.rejects(f.call('task.routing.put', nextRoute), e => e.error.kind === 'limit');
    assert.deepEqual(await fs.readFile(routeFile), savedRoute);
    const legacy = await f.business.client.call('binding.activity', {});
    assert.ok(legacy.entries.every(x => x.principal === f.business.principal && x.method));
    assert.equal(f.s.bridge.owned.size, 0);
  } finally { await f.close(); }
});
test('artifact hints use existing owner validation, keep stable references and previous valid output', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.p.root, 'outputs'));
    const csv = 'record_no,student_id,score\n1,STU-008,80\n';
    const declaration = { path: 'outputs/candidate-v1.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'record_no', type: 'number', nullValues: [] }, { name: 'student_id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }], key: { column: 'student_id', namespace: 'class-A' } } };
    const hint = (seq, d, bytes) => ({ sourceSeq: seq, kind: 'artifact.ready', nativeToolUseId: 'tool-1', at: '2026-10-21T00:00:00Z', output: { declaration: d, expectedDigest: digest(bytes), role: 'candidate', policyRef } });
    await fs.writeFile(path.join(f.p.root, declaration.path), csv);
    const accepted = await f.append([tool(0), tool(1, 'tool.returned'), hint(2, declaration, csv)]);
    const id = accepted.accepted[2].eventId;
    const first = await f.s.observeNativeOutput(f.p.id, id);
    assert.equal(first.validation.state, 'typed-ready'); assert.equal(first.validation.totalRows, 1);
    assert.deepEqual(await f.s.observeNativeOutput(f.p.id, id), first);
    const fail = async (name, bytes, expected = bytes) => {
      const d = { ...declaration, path: 'outputs/' + name + '.csv' };
      await fs.writeFile(path.join(f.p.root, d.path), bytes);
      const read = await f.call('binding.activity', { source: 'native', taskId: 'grades', query });
      const r = await f.append([hint(read.cursor, d, expected)]);
      const result = await f.s.observeNativeOutput(f.p.id, r.accepted[0].eventId);
      assert.equal(result.resource, null); assert.equal(result.validation.state, 'rejected'); return result;
    };
    assert.equal((await fail('partial', 'record_no,student_id,score\n1,STU', csv)).validation.error.kind, 'stale');
    assert.equal((await fail('wrong-digest', csv, csv + '\n')).validation.error.kind, 'stale');
    assert.equal((await fail('bad-columns', 'record_no,student_id,score,extra\n1,STU-008,80,x\n')).validation.error.kind, 'condition');
    assert.equal((await fail('bad-type', 'record_no,student_id,score\n1,STU-008,abc\n')).validation.error.kind, 'condition');
    assert.equal((await fail('duplicate-keys', csv + '2,STU-008,90\n')).validation.error.kind, 'condition');
    assert.equal((await f.call('data.page', { resource: first.resource, offset: 0, limit: 1 })).rows[0].score, 80);
    assert.equal((await f.s.plugins.project(f.p.root, f.p.id).files.list()).filter(x => x.path === declaration.path).length, 1);
    assert.equal(await fs.readFile(path.join(f.p.root, declaration.path), 'utf8'), csv);
    await f.call('capability.configure', { expectedVersion: 0, changeId: 'without-agent', enabled: ['files', 'tables'] });
    await assert.rejects(f.s.observeNativeOutput(f.p.id, id), e => e.kind === 'unavailable');
    await assert.rejects(f.call('task.routing.put', { ...f.route, expectedVersion: 1, changeId: 'disabled-route' }), e => e.error.kind === 'unavailable');
    assert.equal((await f.call('data.page', { resource: first.resource, offset: 0, limit: 1 })).rows[0].score, 80);
  } finally { await f.close(); }
});
test('native pages expose eviction, stale cursors, loss and fail closed on corrupt/missing retained state', async () => {
  const f = await fixture({ agentNativeActivity: { maxRetainedEvents: 2, maxSourceEpochs: 1, maxRecordBytes: 1024 } });
  try {
    await f.append([tool(0), tool(1, 'tool.returned')]);
    const page = await f.call('binding.activity', { source: 'native', taskId: 'grades', query: { ...query, limit: 1 } });
    await f.append([tool(3, 'tool.requested', 'second')]);
    await assert.rejects(f.call('binding.activity', { source: 'native', taskId: 'grades', query: { ...query, limit: 1, cursor: page.next } }), e => e.error.kind === 'stale');
    const read = await f.call('binding.activity', { source: 'native', taskId: 'grades', query });
    assert.equal(read.gap, true); assert.equal(read.retainedFrom, 2);
    await assert.rejects(f.append([tool(0)]), e => e.error.kind === 'stale');
    const file = path.join(f.p.root, '.rho/plugins/agent/native.json');
    await fs.writeFile(file, '{broken');
    await assert.rejects(f.call('binding.activity', { source: 'native', taskId: 'grades', query }), e => e.error.kind === 'storage');
    await fs.rm(file);
    await assert.rejects(f.call('binding.activity', { source: 'native', taskId: 'grades', query }), e => e.error.kind === 'storage');
    assert.equal(await fs.stat(file).then(() => true, () => false), false);
  } finally { await f.close(); }
});
