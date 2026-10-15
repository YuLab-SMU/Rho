// Real Claude Code consumer. Private raw transcripts/configuration stay in work/.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runClaude } from './claude-consumer.mjs';
import { randomUUID } from 'node:crypto';
import { RhoService, RhoClient, native, packageRoot } from './support.mjs';
const root = path.resolve(process.argv[2] ?? 'work/agent-' + Date.now());
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native }).start();
try {
  const client = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await client.call('project.create', { name: 'agent-project' });
  const doc = await client.call('document.open', { projectId: p.id, path: 'analysis.R' });
  const edited = await client.call('document.edit', { projectId: p.id, documentId: doc.id, expectedVersion: doc.version, edits: [{ from: 0, to: 0, insert: '# Shared unsaved script · 中文 🧬\nx <- 1\n' }], undoGroup: 'human-initial' });
  const context = await client.call('context.create', { projectId: p.id, document: { documentId: doc.id, version: edited.version } });
  const session = randomUUID(); const descriptor = path.join(root, 'agent-connection.json');
  const methods = ['capability.list', 'binding.open', 'binding.close', 'context.read', 'document.read', 'document.edit'];
  await service.agentConnection(p.id, session, descriptor, methods);
  const mcp = path.join(root, 'mcp.json');
  await fs.writeFile(mcp, JSON.stringify({ mcpServers: { rho: { command: process.execPath, args: [path.join(packageRoot, 'node_modules/@rho-workspace/headless/dist/mcp.js')], env: { RHO_AGENT_CONNECTION: descriptor } } } }), { mode: 0o600 });
  const prompt = `Test the real Rho project connection using ONLY the rho MCP tools. First call capability.list, bind externalSessionId ${session} using claude-code-mcp, read context ${context.contextId}, and read document ${doc.id}. Apply one conditional edit to the current shared buffer: replace x <- 1 with x <- 2, using the exact version and UTF-16 offsets from document.read, with undoGroup agent-handoff. Read the document again to confirm it. Close the external binding. Return a short factual report of tool receipts. Do not use filesystem or shell tools.`;
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', ...methods.map(m => 'mcp__rho__rho_' + m.replaceAll('.', '_')), '--permission-mode', 'dontAsk', '--setting-sources', '', '--max-turns', '12', prompt];
  const { exitCode, clientVersion } = await runClaude(args, p.root, root);
  const final = await client.call('document.read', { projectId: p.id, documentId: doc.id });
  const bindings = JSON.parse(await fs.readFile(path.join(p.root, '.rho/rho/bindings.json'), 'utf8').catch(() => '[]'));
  const report = { experiment: 'real-claude-code-mcp', clientVersion, sdkVersion: '1.29.0', exitCode, projectBound: bindings.some(b => b.principal.startsWith('agent:') && b.externalSessionId === session), contextFetched: false, bufferChangedByAgent: final.author.startsWith('agent:') && final.content.includes('x <- 2'), finalVersion: final.version, unsaved: final.dirty, nativeHostStarted: await fs.stat(path.join(p.root, '.rho/host.sock')).then(() => true, () => false), externalConversationOwner: 'Claude Code' };
  const storedContext = JSON.parse(await fs.readFile(path.join(p.root, '.rho/rho/contexts', context.contextId + '.json'), 'utf8'));
  report.contextFetched = storedContext.delivery === 'tool-fetched' && storedContext.fetchedBy.startsWith('agent:');
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.bufferChangedByAgent || !report.projectBound || !report.contextFetched || exitCode !== 0) process.exitCode = 1;
} finally { await service.close(); }
