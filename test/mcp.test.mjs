import { callOperation, mcpEnvelope, mcpToolNames } from '../scripts/mcp-consumer.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { runtime } from '../dist/runtime.js';
const pluginRequire = createRequire(import.meta.resolve('@rho-workspace/plugin-agent'));
const { Client } = await import(pathToFileURL(pluginRequire.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(pluginRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
test('real stdio MCP v2 tools share the unsaved buffer, scope and retained native identity', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-mcp-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime() }).start();
  const client = new Client({ name: 'rho-contract-consumer', version: '0.2.0' });
  try {
    const human = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await human.call('project.create', { name: 'project' });
    const other = await human.call('project.create', { name: 'other' });
    const d = await human.call('document.open', { projectId: p.id, path: 'unsaved.R' });
    const methods = ['capability.list', 'document.read', 'document.edit', 'action.submit', 'action.observe'];
    const grant = await human.call('session.grant', { projectId: p.id, externalSessionId: 'mcp-contract-consumer', methods });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/mcp'))], env: { PATH: process.env.PATH, RHO_AGENT_CONNECTION: grant.connectionFile }, stderr: 'pipe' });
    transport.stderr.resume(); await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), [...mcpToolNames].sort());
    assert.equal('projectId' in tools.tools[0].inputSchema.properties, false);
    async function call(method, args = {}) {
      const reply = await callOperation(client, method, args);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.apiVersion, '2.0'); return reply.value;
    }
    assert.deepEqual((await call('capability.list')).actions.map(a => a.id), ['r.execute']);
    assert.equal((await human.call('capability.list', { projectId: p.id })).host.exitCode, 3);
    const code = 'args <- commandArgs(TRUE)\ncat("entry\\n",file=paste0(args[[1]],".entries.jsonl"),append=TRUE)\ncat("shared 中文 🧬")\n';
    assert.equal((await callOperation(client, 'document.edit', { projectId: other.id })).error.kind, 'invalid');
    const edited = await call('document.edit', { documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: code }], undoGroup: 'external-agent' });
    assert.equal(edited.content, code); assert.equal(edited.dirty, true);
    assert.equal((await human.call('document.read', { projectId: p.id, documentId: d.id })).content, code);
    assert.equal((await human.call('observation.snapshot', { projectId: other.id })).documents.length, 0);
    const intent = { operationId: 'mcp-native-once', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'buffer', documentId: d.id, version: edited.version }, args: [], requirements: [], artifacts: [], completion: null } };
    const accepted = await call('action.submit', intent);
    assert.equal((await call('action.submit', intent)).native.run_id, accepted.native.run_id);
    const conflict = await callOperation(client, 'action.submit', { ...intent, input: { ...intent.input, args: ['changed'] } });
    assert.equal(conflict.ok, false); assert.equal(conflict.apiVersion, '2.0'); assert.equal(conflict.error.kind, 'conflict');
    let final;
    for (let n = 0; n < 100; n++) { final = await call('action.observe', { operationId: intent.operationId }); if (final.execution === 'completed') break; await setTimeout(50); }
    assert.equal(final.execution, 'completed'); assert.deepEqual(final.core, accepted.core);
    assert.equal((await fs.readFile(path.join(p.root, final.plan.output + '.entries.jsonl'), 'utf8')).trim(), 'entry');
    const directory = (await fs.readdir(path.dirname(grant.connectionFile))).find(n => n.startsWith('mcp-intents-'));
    assert.ok(directory); assert.equal((await fs.readdir(path.join(path.dirname(grant.connectionFile), directory))).filter(n => n.endsWith('.json')).length, 1);
  } finally { await client.close(); await service.close(); }
});

test('MCP plugin filter only narrows grants and cached tools cannot bypass project disablement', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-mcp-filter-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing' }).start();
  const client = new Client({ name: 'filtered-consumer', version: '1.0.0' });
  try {
    const human = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await human.call('project.create', { name: 'p' });
    const descriptor = path.join(root, 'agent.json');
    await service.agentConnection(p.id, 'filtered', descriptor, ['capability.list', 'document.read', 'data.page'], ['documents']);
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/mcp'))], env: { PATH: process.env.PATH, RHO_AGENT_CONNECTION: descriptor }, stderr: 'pipe' });
    transport.stderr.resume(); await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), mcpToolNames);
    assert.deepEqual((await mcpEnvelope(client, 'rho_index', { owner: 'documents' })).value.entries.map(e => e.id), ['document.read']);
    const denied = await callOperation(client, 'data.page', { resource: { id: 'absent', version: '0'.repeat(64) }, offset: 0, limit: 1 });
    assert.equal(denied.ok, false);
    await human.call('capability.configure', { projectId: p.id, expectedVersion: 0, changeId: 'disable', enabled: ['agent'] });
    assert.deepEqual((await mcpEnvelope(client, 'rho_index', { owner: 'documents' })).value.entries, []);
    assert.equal((await callOperation(client, 'document.read', { documentId: '0'.repeat(64) })).ok, false);
    await assert.rejects(human.call('document.read', { projectId: p.id, documentId: '0'.repeat(64) }), e => e.error.kind === 'unavailable');
  } finally { await client.close(); await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
