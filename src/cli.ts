#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { PluginId } from './plugins.js';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
// A widened link is optional: the fragment carries a one-time code, which no request or Referer
// sends and which the page redeems and removes. Opening the plain url needs no code at all.
const link = (url: string, code: string) => url + '/#pair=' + code;
function openBrowser(target: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => process.stderr.write('Could not open a browser. Open openUrl from the output instead.\n')).unref();
}
const usage = `Verify a read-only evidence package:
  rho --verify-evidence PATH
Start Rho:
  rho --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE [--core ABSOLUTE_CORE_BINARY] [--rscript ABSOLUTE_RSCRIPT] [--python PYTHON] [--ssh SSH] [--serverctl SERVERCTL] [--claude CLAUDE_CODE_BINARY] [--codex CODEX_BINARY] [--agent-backend claude-acp|codex-acp|claude-cli] [--port 0] [--limits JSON_FILE] [--plugins documents,files,...] [--open]
A narrower browser link (optional):
  rho --pair PRIVATE_CONNECTION_FILE [--root PROJECTS_RELATIVE_DIRECTORY] [--open]
Give an Agent access to one project, and the command that adds it to Claude Code:
  rho --grant PRIVATE_CONNECTION_FILE --project PROJECTS_RELATIVE_DIRECTORY [--session NAME]
Serve that access to the Agent over MCP (stdio):
  rho --mcp AGENT_CONNECTION_FILE
Observe an external ACP client (use this as its agent command):
  rho --acp /absolute/project --acp-agent claude|codex
--open opens the printed url in the default browser. Opening that url on this machine needs no
link, code or session credential; --pair makes a narrower, expiring link for one folder.
PRIVATE_CONNECTION_FILE is the connectionFile the running service printed; it and every
connection file are credentials.
`;
const options = { 'verify-evidence': { type: 'string' }, acp: { type: 'string' }, 'acp-agent': { type: 'string' }, root: { type: 'string' }, 'state-dir': { type: 'string' }, core: { type: 'string' }, rscript: { type: 'string' }, python: { type: 'string' }, ssh: { type: 'string' }, serverctl: { type: 'string' }, claude: { type: 'string' }, codex: { type: 'string' }, 'agent-backend': { type: 'string' }, port: { type: 'string' }, limits: { type: 'string' }, plugins: { type: 'string' }, pair: { type: 'string' }, open: { type: 'boolean' },
  grant: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' }, mcp: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const;
let parsed;
try { parsed = parseArgs({ options }); }
catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n\n' + usage); process.exit(2); }
const { values } = parsed;
if (values['verify-evidence']) {
  try { const { verifyEvidence } = await import('./evidence-export.js'); process.stdout.write(JSON.stringify(await verifyEvidence(path.resolve(values['verify-evidence']))) + '\n'); } catch (e) { process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n'); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
if (values.help) { process.stdout.write(usage); process.exit(0); }
// The Agent's side of a grant: its MCP server reads the connection file and speaks on stdio,
// so nothing else may write to stdout in this mode.
if (values.acp) {
  if (!['claude', 'codex'].includes(values['acp-agent'] ?? '')) { process.stderr.write('Select --acp-agent claude or codex.\n'); process.exit(2); }
  const { runExternalAcp } = await import('@rho-workspace/plugin-agent/acp-cli');
  runExternalAcp(path.resolve(values.acp), values['acp-agent'] as 'claude' | 'codex');
} else if (values.mcp) {
  process.env.RHO_AGENT_CONNECTION = path.resolve(values.mcp);
  await import('@rho-workspace/plugin-agent/mcp');
} else {
  // Access comes from whoever runs Rho: the operator's connection grants one project to one
  // Agent session, and the reply says how Claude Code starts that session's MCP server.
  if (values.grant) {
    if (!values.project) { process.stderr.write('--grant needs --project, the project folder relative to the service root.\n\n' + usage); process.exit(2); }
    const { RhoClient } = await import('./client.js');
    const client = await RhoClient.fromFile(path.resolve(values.grant));
    const project = await client.call('project.open', { path: values.project });
    const session = values.session ?? 'claude-code';
    const granted = await client.call('session.grant', { projectId: project.id, externalSessionId: session });
    const { mcpCommand, mcpName } = await import('./agent-connect.js');
    const command = mcpCommand(granted.connectionFile), name = mcpName(project.root);
    const quote = (value: string) => /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
    process.stdout.write(JSON.stringify({ projectId: project.id, session, connectionFile: granted.connectionFile, methods: granted.methods.length,
      mcp: { name, command: command[0], args: command.slice(1) }, claude: ['claude', 'mcp', 'add', name, '--', ...command].map(quote).join(' ') }) + '\n');
    process.exit(0);
  }
  if (values.pair) {
    const { RhoClient } = await import('./client.js');
    const client = await RhoClient.fromFile(path.resolve(values.pair));
    const pairing = await client.call('session.browser.pair', values.root ? { path: values.root } : {});
    const openUrl = link(client.connection.url, pairing.code);
    process.stdout.write(JSON.stringify({ url: client.connection.url, openUrl, pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt }) + '\n');
    if (values.open) openBrowser(openUrl);
    process.exit(0);
  }
  if (!values.root || !values['state-dir']) {
    process.stderr.write(usage); process.exit(2);
  }
  const limits = values.limits ? JSON.parse(await fs.readFile(values.limits, 'utf8')) : {};
  const allowed = new Set(['maxRequestBytes', 'maxEventBytes', 'eventRetention', 'maxSubscriptions', 'maxQueue', 'maxContexts', 'maxBindings', 'maxActivities', 'maxContextBytes', 'maxRetainedMetadataBytes', 'maxConcurrentActions', 'maxOperations', 'maxLogPageBytes', 'maxCodeBytes', 'maxReconciled', 'documents', 'resources', 'workspace', 'r', 'annotations', 'interactions', 'capabilityLimits', 'browser', 'nativeFolders', 'conversations', 'evidence', 'console']);
  if (Object.keys(limits).some(k => !allowed.has(k))) throw new Error('Unknown service budget in --limits file.');
  const { RhoService } = await import('./server.js'), { runtime } = await import('./runtime.js');
  const agentBackend = values['agent-backend'] ?? process.env.RHO_AGENT_BACKEND ?? 'claude-acp';
  if (!['claude-acp', 'codex-acp', 'claude-cli'].includes(agentBackend)) throw new Error('Choose --agent-backend claude-acp, codex-acp or claude-cli.');
  const service = await new RhoService({ ...limits, root: path.resolve(values.root), stateDir: path.resolve(values['state-dir']), ...await runtime(values.core, values.rscript), agentBackend: agentBackend as 'claude-acp' | 'codex-acp' | 'claude-cli', codex: values.codex ?? process.env.RHO_CODEX, claude: values.claude ?? process.env.RHO_CLAUDE ?? 'claude', python: values.python ?? process.env.RHO_PYTHON, ssh: values.ssh ?? process.env.RHO_SSH, serverctl: values.serverctl ?? process.env.RHO_SERVERCTL, port: Number(values.port ?? 0), ...(values.plugins !== undefined ? { plugins: values.plugins ? values.plugins.split(',') as PluginId[] : [] } : {}) }).start();
  // The narrow conclusion a person needs on one line: what was selected, where state
  // lives, and how to open it. It stays inside `ready` so a parser reading line one is
  // unaffected. Opening this url on this machine is the access; no link is minted.
  const rscript = values.rscript ?? process.env.RHO_RSCRIPT ?? 'Rscript';
  process.stdout.write(JSON.stringify({ ready: {
    url: service.url, connectionFile: path.join(service.state.directory, 'connection.json'), apiVersion: '2.0',
    openUrl: service.url,
    startup: {
      projects: path.resolve(values.root), state: path.resolve(values['state-dir']),
      core: service.bridge.binary, rscript: service.bridge.rscript,
      note: 'Open this url in a browser on this machine. Execution stays off until an Agent submits a run; project.doctor answers what is missing.'
    }
  } }) + '\n');
  if (values.open) openBrowser(service.url);
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => { if (closing) return; closing = true; const reports = await service.close(); process.stdout.write(JSON.stringify({ shutdown: reports }) + '\n'); });
}
