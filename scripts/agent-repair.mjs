import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { runClaude } from './claude-consumer.mjs';
import { RhoService, RhoClient, native, packageRoot } from './support.mjs';
const root = path.resolve(process.argv[2] ?? 'work/agent-repair-' + Date.now()); await fs.mkdir(root, { recursive: true, mode: 0o700 });
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native }).start();
const report = { status: 'running', experiment: 'actual-scientific-failure-to-agent-buffer-repair', checks: [] };
const check = name => { report.checks.push(name); process.stdout.write(JSON.stringify({ passed: name }) + '\n'); };
try {
  const human = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await human.call('project.create', { name: 'repair-project' });
  const h = (m, b = {}) => human.call(m, { projectId: p.id, ...b });
  const recipe = await fs.readFile(path.join(packageRoot, 'node_modules/@rho-workspace/headless/examples/real-r-analysis/analyze.R'), 'utf8');
  const safe = 'if (length(x) == 1L) 1L else "FD"'; assert.ok(recipe.includes(safe));
  const old = recipe.replace(safe, '"FD"');
  let doc = await h('document.open', { path: 'repair.R' });
  doc = await h('document.edit', { documentId: doc.id, expectedVersion: doc.version, edits: [{ from: 0, to: 0, insert: old }], undoGroup: 'retained-old-recipe' });
  const bad = await human.retainOperation(path.join(root, 'failed-intent.json'), { projectId: p.id, action: 'airway.analyze', actionVersion: '0.1.0', input: { bootstrapReplicates: 1, script: { kind: 'buffer', documentId: doc.id, version: doc.version } } });
  await human.call('action.submit', bad);
  async function terminal(client, operationId) {
    const end = Date.now() + 120000;
    while (Date.now() < end) { const r = await client.call('action.observe', { projectId: p.id, operationId }); if (['completed', 'failed'].includes(r.execution)) return r; await setTimeout(250); }
    throw new Error('Original scientific request did not reach an observed terminal fact within the test budget.');
  }
  const failure = await terminal(human, bad.operationId); assert.equal(failure.execution, 'failed');
  const partial = await h('resource.list', { operationId: bad.operationId });
  const error = partial.resources.find(r => r.path.endsWith('/failure.json')); assert.ok(error);
  const histogram = old.indexOf('hist(x, breaks = "FD"'); assert.ok(histogram >= 0);
  const context = await h('context.create', { document: { documentId: doc.id, version: doc.version, from: histogram, to: old.indexOf('\n', histogram) }, resource: { id: error.id, version: error.version } });
  assert.equal(context.resource.encoding, 'utf8'); assert.ok(context.resource.text.length > 0);
  check('actual failed native analysis supplies its failure resource and same unsaved buffer');
  const session = randomUUID(), operationId = randomUUID();
  const methods = ['binding.open', 'binding.close', 'context.read', 'document.edit', 'action.submit', 'action.lookup', 'action.observe'];
  const grant = await h('session.grant', { externalSessionId: session, methods });
  const descriptor = grant.connectionFile;
  const mcp = path.join(root, 'mcp.json');
  await fs.writeFile(mcp, JSON.stringify({ mcpServers: { rho: { command: process.execPath, args: [path.join(packageRoot, 'node_modules/@rho-workspace/headless/dist/mcp.js')], env: { RHO_AGENT_CONNECTION: descriptor } } } }), { mode: 0o600 });
  const prompt = `Use ONLY the rho MCP tools. Bind externalSessionId ${session} using adapter claude-code-mcp, then read context ${context.contextId}. It contains the real failure.json, the failing histogram line, its absolute UTF-16 from/to offsets, and source.documentId/source.version for the acknowledged unsaved buffer. Repair hist(x, breaks = "FD") so singleton x uses one bin and longer x retains FD. Make one conditional document.edit using that source version, absolute UTF-16 offsets, and undoGroup scientific-repair; preserve all other text. Then submit deliberately NEW work: operationId ${operationId}, action airway.analyze, actionVersion 0.1.0, input {bootstrapReplicates:1,script:{kind:"buffer",documentId:"${doc.id}",version:THE_VERSION_RETURNED_BY_EDIT}}. Reuse this operationId if an acknowledgement is lost; do not retry the failed run. Read action.lookup for this new operation, close the binding, return a short factual receipt. Do not wait for execution. The operator will verify the full buffer, result and native entry separately.`;
  const args = ['--print', '--effort', 'low', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', ...methods.map(m => 'mcp__rho__rho_' + m.replaceAll('.', '_')), '--permission-mode', 'dontAsk', '--setting-sources', '', '--max-turns', '12', prompt];
  const agentResult = await runClaude(args, p.root, root); report.client = agentResult;
  assert.equal(agentResult.timedOut, false, 'External Agent exceeded the 600-second experiment budget.');
  assert.equal(agentResult.exitCode, 0); report.clientVersion = agentResult.clientVersion;
  const agent = await RhoClient.fromFile(descriptor);
  const repaired = await terminal(agent, operationId); assert.equal(repaired.execution, 'completed');
  assert.notEqual(repaired.core.requestId, failure.core.requestId);
  const changed = await h('document.read', { documentId: doc.id }); assert.equal(changed.author.startsWith('agent:'), true); assert.equal(changed.dirty, true); assert.equal(changed.version, doc.version + 1);
  assert.equal((await h('action.lookup', { operationId: bad.operationId })).execution, 'failed');
  check('real Claude Code repairs the shared buffer and submits a deliberately new immutable request');
  const verified = await agent.call('artifact.check', { operationId }).catch(e => { if (e.error?.kind === 'unauthorized') return null; throw e; });
  // This test credential deliberately does not grant artifact.check. Verify via
  // a credential rotation for the same authenticated principal, not caller spoofing.
  const checker = await h('session.grant', { externalSessionId: session, methods: ['artifact.check', 'action.lookup', 'binding.activity'] });
  const observer = await RhoClient.fromFile(checker.connectionFile);
  const checked = verified ?? await observer.call('artifact.check', { operationId }); assert.equal(checked.domain.state, 'passed');
  const activity = await observer.call('binding.activity'); assert.ok(activity.entries.some(e => e.method === 'document.edit' && e.outcome === 'returned')); assert.ok(activity.entries.some(e => e.method === 'action.submit' && e.operationId === operationId));
  const intents = (await fs.readdir(path.dirname(descriptor))).filter(n => n.startsWith('mcp-intents-'));
  assert.equal(intents.length, 1); const files = await fs.readdir(path.join(path.dirname(descriptor), intents[0])); assert.equal(files.filter(n => n.endsWith('.json')).length, 1);
  const nativeEntries = (await fs.readFile(path.join(p.root, repaired.plan.output + '.entries.jsonl'), 'utf8')).trim().split('\n'); assert.equal(nativeEntries.length, 1);
  check('MCP caller intent, bounded tool receipts, one native entry and independent repaired-result checks agree');
  report.status = 'passed'; report.failed = { execution: failure.execution, operationId: bad.operationId }; report.repaired = { execution: repaired.execution, operationId, bufferVersion: changed.version, domain: checked.domain.state };
} catch (e) { report.status = 'failed'; report.failure = e.message; process.exitCode = 1; process.stdout.write(JSON.stringify({ failure: e.message }) + '\n'); }
finally { report.shutdown = await service.close(); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
