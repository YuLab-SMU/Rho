#!/usr/bin/env node
// Records a second Agent run for the interaction model (docs/INTERACTION-PLAN.md S4):
// real Claude Code, MCP limited to rho, a task of another kind than the first trace
// (make a failing check pass), and a prompt that states only the task. Rho's own
// guidance is the Agent's only hint about declaring its work. Usage, after npm run build:
//   RHO_CORE_BINARY=… node prototypes/replay/record-agent.mjs [work/agent-check-<time>]
// Everything raw stays in that directory; build-trace.mjs folds it from Rho's records.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runClaude } from '../../scripts/claude-consumer.mjs';
import { mcpToolNames } from '../../scripts/mcp-consumer.mjs';
import { RhoService, RhoClient, native, packageRoot } from '../../scripts/support.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
// The first trace's grant, so the two runs had the same operations to choose from.
const methods = ['capability.index', 'capability.resolve', 'skill.list', 'skill.read', 'document.open', 'document.read', 'document.edit', 'document.save', 'document.history', 'action.submit', 'action.lookup', 'action.observe', 'action.output', 'artifact.check', 'resource.read', 'data.page', 'data.plot', 'media.describe', 'object.read', 'composition.apply', 'composition.read', 'task.map.declare', 'task.map.read'];
const root = path.resolve(process.argv[2] ?? 'work/agent-check-' + Date.now());
const project = path.join(root, 'project');
await fs.mkdir(project, { recursive: true, mode: 0o700 });
for (const name of ['stats.R', 'check.R']) await fs.copyFile(path.join(here, 'tasks/check', name), path.join(project, name));

const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native, resources: { maxReadBytes: 65536 } }).start();
try {
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'project' });
  const session = 'check-' + Date.now(), connection = path.join(root, 'agent-connection.json');
  const grant = await service.agentConnection(p.id, session, connection, methods);
  const mcp = path.join(root, 'mcp.json');
  await fs.writeFile(mcp, JSON.stringify({ mcpServers: { rho: { command: process.execPath, args: [path.join(packageRoot, 'node_modules/@rho-workspace/plugin-agent/dist/mcp.js')], env: { RHO_AGENT_CONNECTION: connection } } } }), { mode: 0o600 });
  const prompt = 'The check in check.R fails. Fix stats.R so that check.R passes; do not change check.R. Use only the rho MCP tools, and end with a short report of what you changed and the run that passed.';
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', ...mcpToolNames.map(name => 'mcp__rho__' + name), '--permission-mode', 'dontAsk', '--setting-sources', '', '--max-turns', '80', prompt];
  const run = await runClaude(args, project, root, 1_200_000);
  const report = { experiment: path.basename(root), task: 'check', prompt, session, methods: grant.methods, ...run };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ...report, methods: report.methods.length }) + '\n');
} finally { await service.close(); }
