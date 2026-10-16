import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { RhoService, RhoClient, native, packageRoot } from './support.mjs';
import { runClaude } from './claude-consumer.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(process.argv[2] ?? 'work/collaboration-' + Date.now());
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const model = process.env.RHO_COLLAB_MODEL === '1';
const config = { root, stateDir: path.join(root, 'state'), ...native, eventRetention: 4, ...(process.env.RHO_COLLAB_PLUGINS ? { plugins: process.env.RHO_COLLAB_PLUGINS.split(',') } : {}) };
let service, mcp;
const counts = { hostStarts: 0, nativeDispatches: 0 };
const report = { scenario: 'headless-collaboration', agent: model ? 'real-claude-code' : 'deterministic-real-stdio-mcp', passed: false, node: process.version, counts, phases: [], modelRuns: [] };
async function start() {
  service = await new RhoService(config).start();
  const ensure = service.bridge.ensureOwnedHost.bind(service.bridge), call = service.bridge.call.bind(service.bridge);
  service.bridge.ensureOwnedHost = async (...args) => { counts.hostStarts++; return ensure(...args); };
  service.bridge.call = async (...args) => { if (args[1] === 'submit') counts.nativeDispatches++; return call(...args); };
  return new RhoClient({ url: service.url, token: service.adminToken });
}
try {
  let human = await start();
  const p = await human.call('project.create', { name: 'project' });
  const call = (method, input = {}) => human.call(method, { projectId: p.id, ...input });
  const csv = 'id,x,y\n001,1,2\n002,3,4\n';
  await fs.writeFile(path.join(p.root, 'samples.csv'), csv);
  await fs.writeFile(path.join(p.root, 'analysis.R'), '# ordinary code; do not execute\nx <- 1\n');
  await fs.writeFile(path.join(p.root, 'notes.md'), 'Shared notes 🧬\nExplain the sample trend.\n');
  const code = await call('document.open', { path: 'analysis.R' }), notes = await call('document.open', { path: 'notes.md' });
  const draft = await call('document.open', { path: 'feedback.md' }), response = await call('document.open', { path: 'response.md' });
  const table = await call('resource.register', { expectedDigest: sha(csv), declaration: { path: 'samples.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'x', type: 'number', nullValues: [] }, { name: 'y', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'samples' } } } });
  const ref = { id: table.id, version: table.version };
  const nodes = [
    { id: 'root', kind: 'group', children: ['code', 'table', 'plot', 'notes'] },
    { id: 'code', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Code' }, bindings: { document: { documentId: code.id, version: code.version } } },
    { id: 'table', kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: 'Samples' }, bindings: { data: ref } },
    { id: 'plot', kind: 'view', component: 'rho.scatter', version: '0.2.0', props: { title: 'Trend', x: 'x', y: 'y' }, bindings: { data: ref } },
    { id: 'notes', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Notes' }, bindings: { document: { documentId: notes.id, version: notes.version } } }
  ];
  const descriptor = path.join(root, 'agent-connection.json');
  const methods = ['capability.list', 'skill.list', 'skill.read', 'document.read', 'document.edit', 'composition.read', 'composition.apply', 'data.page', 'data.plot', 'context.read', 'annotation.read', 'annotation.reply'];
  await service.agentConnection(p.id, 'collaboration-agent', descriptor, methods);
  const require = createRequire(await fs.realpath(path.join(packageRoot, 'node_modules/@rho-workspace/plugin-agent/dist/mcp.js')));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  mcp = new Client({ name: 'collaboration-consumer', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, 'node_modules/@rho-workspace/plugin-agent/dist/mcp.js')], env: { PATH: process.env.PATH, RHO_AGENT_CONNECTION: descriptor }, stderr: 'pipe' });
  transport.stderr.resume(); await mcp.connect(transport);
  const agentCall = async (method, input = {}) => {
    const result = await mcp.callTool({ name: 'rho_' + method.replaceAll('.', '_'), arguments: input });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent)); return result.structuredContent.value;
  };
  const runModel = async (phase, prompt) => {
    const directory = path.join(root, phase); await fs.mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, 'mcp.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { rho: { command: process.execPath, args: [path.join(packageRoot, 'node_modules/@rho-workspace/plugin-agent/dist/mcp.js')], env: { RHO_AGENT_CONNECTION: descriptor } } } }), { mode: 0o600 });
    const result = await runClaude(['--print', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', file, '--tools', '', '--allowedTools', ...methods.map(m => 'mcp__rho__rho_' + m.replaceAll('.', '_')), '--permission-mode', 'dontAsk', '--setting-sources', '', '--max-turns', '24', prompt + '\nUse only rho MCP tools. No shell/filesystem/native execution. Report facts, not claims of completion.'], p.root, directory);
    report.modelRuns.push({ phase, ...result }); assert.equal(result.exitCode, 0, 'Real Agent failed or timed out; this is not replaced by deterministic output.');
  };
  const initial = { compositionId: 'workspace', expectedVersion: 0, changeId: 'initial-composition', operations: [{ op: 'replace', rootId: 'root', nodes }] };
  if (model) await runModel('compose', 'Discover capability.list and skill.list; read rho.workspace and the documents, tables, charts and annotations Skills with skill.read. Inspect the CSV using data.page and data.plot with x/y. Then create this complete structured composition using composition.apply: ' + JSON.stringify(initial));
  else {
    await agentCall('capability.list');
    for (const skill of await agentCall('skill.list')) await agentCall('skill.read', { skillId: skill.id, expectedDigest: skill.digest });
    await agentCall('data.page', { resource: ref, offset: 0, limit: 10 }); await agentCall('data.plot', { resource: ref, x: 'x', y: 'y' });
    await agentCall('composition.apply', initial);
  }
  let composition = await call('composition.read', { compositionId: 'workspace' });
  assert.equal(composition.nodes.length, 5); assert.ok(composition.author.startsWith('agent:'));
  const edited = await call('document.edit', { documentId: notes.id, expectedVersion: notes.version, edits: [{ from: 0, to: 0, insert: 'Human revision.\n' }], undoGroup: 'human' });
  composition = await call('composition.apply', { compositionId: 'workspace', expectedVersion: composition.version, changeId: 'human-arrange', operations: [{ op: 'move', id: 'notes', parentId: 'root', index: 0 }] });
  composition = await call('view.protection.set', { compositionId: 'workspace', viewId: 'table', expectedVersion: composition.version, changeId: 'protect-table', protected: true });
  await assert.rejects(call('composition.apply', { compositionId: 'workspace', expectedVersion: composition.version, changeId: 'blocked-close', operations: [{ op: 'remove', id: 'table' }] }), e => e.error.kind === 'condition');
  const feedbackDraft = await call('document.edit', { documentId: draft.id, expectedVersion: 1, edits: [{ from: 0, to: 0, insert: 'Explain selected sample 001 and update the shared notes.' }], undoGroup: 'feedback' });
  const feedback = await call('annotation.create', { annotationId: 'feedback', expectedVersion: 0, changeId: 'feedback', anchor: { kind: 'document', documentId: notes.id, version: edited.version, from: 0, to: 15 }, draft: { documentId: draft.id, version: feedbackDraft.version } });
  const tableFeedback = await call('annotation.create', { annotationId: 'sample', expectedVersion: 0, changeId: 'sample', anchor: { kind: 'table', resource: ref, entities: ['001'] }, draft: { documentId: draft.id, version: feedbackDraft.version } });
  const context = await call('context.create', { expectedVersion: 0, changeId: 'selected-feedback', annotations: [{ annotationId: 'feedback', version: 1 }, { annotationId: 'sample', version: 1 }] });
  // Original feedback must survive a source edit after submission/preparation.
  const later = await call('document.edit', { documentId: notes.id, expectedVersion: edited.version, edits: [{ from: 0, to: 15, insert: 'Source changed.\n' }], undoGroup: 'later-human' });
  if (model) await runModel('respond', `Read the delivered annotations Skill and context ${context.contextId}. Read current shared notes document ${notes.id}; append exactly "Agent explanation: sample 001 has x=1 and y=2.\\n" (a real newline) using its current version and exact UTF-16 offsets. Read the response draft ${response.id}; fill it with a factual explanation referencing the two feedback objects. Submit annotation.reply to feedback with replyTo ${feedback.messages[0].id}, expectedVersion 1, changeId reply-feedback; and to sample with replyTo ${tableFeedback.messages[0].id}, expectedVersion 1, changeId reply-sample; both using the exact updated response draft version. Read notes and annotations to verify. Do not move/close/rebind the protected table.`);
  else {
    const frozen = await agentCall('context.read', { contextId: context.contextId });
    assert.equal(frozen.annotations[0].source.text, 'Human revision.');
    const current = await agentCall('document.read', { documentId: notes.id });
    await agentCall('document.edit', { documentId: notes.id, expectedVersion: current.version, edits: [{ from: current.content.length, to: current.content.length, insert: 'Agent explanation: sample 001 has x=1 and y=2.\n' }], undoGroup: 'agent-response' });
    const replyDraft = await agentCall('document.edit', { documentId: response.id, expectedVersion: 1, edits: [{ from: 0, to: 0, insert: 'Updated shared notes: sample 001 has x=1 and y=2; original source snapshots retained.' }], undoGroup: 'response' });
    for (const thread of [feedback, tableFeedback]) await agentCall('annotation.reply', { annotationId: thread.annotationId, expectedVersion: 1, changeId: 'reply-' + thread.annotationId, replyTo: thread.messages[0].id, draft: { documentId: response.id, version: replyDraft.version } });
  }
  const final = await call('document.read', { documentId: notes.id });
  assert.ok(final.author.startsWith('agent:')); assert.ok(final.content.includes('sample 001 has x=1 and y=2'));
  const storedContext = JSON.parse(await fs.readFile(path.join(p.root, '.rho/rho/contexts', context.contextId + '.json'), 'utf8'));
  assert.equal(storedContext.delivery, 'tool-fetched'); assert.ok(storedContext.fetchedBy.startsWith('agent:'));
  const receipts = JSON.parse(await fs.readFile(path.join(p.root, '.rho/rho/activity.json'), 'utf8')).entries;
  report.skillsFetched = [...new Set(receipts.filter(r => r.method === 'skill.read' && r.outcome === 'returned').map(r => r.skillId).filter(Boolean))];
  for (const id of ['rho.workspace', 'documents.workspace', 'tables.workspace', 'charts.workspace', 'annotations.workspace']) assert.ok(report.skillsFetched.includes(id), 'Missing delivered Skill fetch: ' + id);
  const fetched = await call('context.read', { contextId: context.contextId });
  assert.ok(fetched.responses.every(r => r.state === 'explicit-linked-response'));
  const read = await call('annotation.read', { annotationId: 'feedback' });
  assert.equal(read.source.text, 'Human revision.'); assert.equal(read.sourceStatus.state, 'version-differs');
  assert.ok(read.messages[1].author.startsWith('agent:'));
  report.phases.push('http-human-and-stdio-agent', 'shared-documents-composition-protection', 'both-anchor-owners-and-explicit-replies');
  await mcp.close(); mcp = null;
  await call('workspace.export', { destination: 'export', format: 3 });
  const snapshot = await call('observation.snapshot');
  const gap = await fetch(service.url + '/api/v2/events?projectId=' + p.id + '&after=0', { headers: { authorization: 'Bearer ' + service.adminToken } });
  assert.equal((await gap.json()).error.kind, 'event_gap');
  assert.deepEqual(await service.close(), []); service = null;
  human = await start();
  assert.equal((await call('document.read', { documentId: notes.id })).content, final.content);
  assert.equal((await call('observation.snapshot')).cursor, snapshot.cursor);
  const { ObservationClient, httpObservation } = await import(pathToFileURL(path.join(packageRoot, 'dist/observation.js')));
  const observerA = new ObservationClient(httpObservation(service.url, service.adminToken, p.id));
  const observerB = new ObservationClient(httpObservation(service.url, service.adminToken, p.id));
  const a = observerA.observe(), b = observerB.observe();
  assert.deepEqual((await a.next()).value.compositions, (await b.next()).value.compositions);
  await a.return(); await b.return();
  const q = await human.call('project.create', { name: 'restored' });
  await fs.cp(path.join(p.root, 'export'), path.join(q.root, 'import'), { recursive: true });
  const restored = await human.call('workspace.restore', { projectId: q.id, source: 'import' });
  assert.equal(restored.execution, 'not-replayed'); assert.ok(restored.annotations.every(a => a.state === 'available'));
  const retained = await human.call('composition.read', { projectId: q.id, compositionId: 'workspace' });
  assert.equal(retained.nodes.find(n => n.id === 'table').protected, true);
  assert.equal((await human.call('document.read', { projectId: q.id, documentId: notes.id })).content, final.content);
  assert.deepEqual((await human.call('annotation.read', { projectId: q.id, annotationId: 'feedback' })).messages, read.messages);
  assert.equal(counts.hostStarts, 0); assert.equal(counts.nativeDispatches, 0);
  assert.equal((await call('observation.snapshot')).operations.length, 0);
  report.phases.push('restart-event-gap-double-observer', 'format3-installed-owner-restore');
  report.package = await fs.readFile(path.join(packageRoot, 'vendor/composition.json'), 'utf8').then(JSON.parse, () => ({ sourceDevelopment: true }));
  report.passed = true;
} catch (error) { report.failure = { name: error.name, message: error.message.slice(0, 2000) }; process.exitCode = 1; }
finally {
  await mcp?.close(); if (service) { report.shutdown = await service.close(); assert.deepEqual(report.shutdown, []); }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, agent: report.agent, counts, phases: report.phases, modelRuns: report.modelRuns, failure: report.failure }));
}
