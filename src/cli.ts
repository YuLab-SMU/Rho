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
// A generic ACP agent is any program that speaks ACP v1 over stdio. Its command is either a
// JSON argv array (safest for paths with spaces) or a simple command line.
function parseAcpCommand(spec: string | undefined): { file: string; args: string[] } {
  const text = (spec ?? '').trim();
  if (!text) throw new Error('--agent-backend acp needs --acp-command: a JSON argv array such as \'["/usr/bin/node","/path/agent.js"]\', or a command line.');
  if (text.startsWith('[')) {
    let parts: unknown;
    try { parts = JSON.parse(text); } catch { throw new Error('--acp-command is not valid JSON.'); }
    if (!Array.isArray(parts) || !parts.length || parts.some(x => typeof x !== 'string')) throw new Error('--acp-command JSON must be a non-empty array of strings.');
    return { file: parts[0] as string, args: parts.slice(1) as string[] };
  }
  const parts = (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(p => p.replace(/^(["'])(.*)\1$/, '$2'));
  if (!parts.length) throw new Error('--acp-command is empty.');
  return { file: parts[0], args: parts.slice(1) };
}
const usage = `Verify a read-only evidence package:
  rho --verify-evidence PATH
Start Rho on ~/Rho/projects and ~/Rho/state, and say where it is and what is missing:
  rho
Start Rho:
  rho --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE [--core ABSOLUTE_CORE_BINARY] [--rscript ABSOLUTE_RSCRIPT] [--python PYTHON] [--ssh SSH] [--serverctl SERVERCTL] [--claude CLAUDE_CODE_BINARY] [--codex CODEX_BINARY] [--agent-backend claude-acp|codex-acp|claude-cli|acp] [--acp-command JSON_ARGV] [--port PORT] [--limits JSON_FILE] [--plugins documents,files,...] [--example on|off] [--open]
A narrower browser link (optional):
  rho --pair PRIVATE_CONNECTION_FILE [--root PROJECTS_RELATIVE_DIRECTORY] [--open]
Add Rho to your own Claude Code or Codex for one project, as the project page's button does:
  rho --grant PRIVATE_CONNECTION_FILE --project PROJECTS_RELATIVE_DIRECTORY --agent claude-code|codex
Give an Agent access to one project, and the command that adds it to Claude Code:
  rho --grant PRIVATE_CONNECTION_FILE --project PROJECTS_RELATIVE_DIRECTORY [--session NAME]
Serve that access to the Agent over MCP (stdio):
  rho --mcp AGENT_CONNECTION_FILE
Observe an external ACP client (use this as its agent command):
  rho --acp /absolute/project --acp-agent claude|codex
--example off starts Rho without the project it ships; a new state otherwise gets that project
once, copied into the projects directory. --open opens the printed url in the default browser.
Without --port a start takes the port this state's last start had, and a new one only when that
port is taken; --port 0 always takes a new one.
Opening that url on this machine needs no link, code or session credential; --pair makes a
narrower, expiring link for one folder.
PRIVATE_CONNECTION_FILE is the connectionFile the running service printed; it and every
connection file are credentials.
`;
const options = { example: { type: 'string' }, 'verify-evidence': { type: 'string' }, acp: { type: 'string' }, 'acp-agent': { type: 'string' }, root: { type: 'string' }, 'state-dir': { type: 'string' }, core: { type: 'string' }, rscript: { type: 'string' }, python: { type: 'string' }, ssh: { type: 'string' }, serverctl: { type: 'string' }, claude: { type: 'string' }, codex: { type: 'string' }, 'agent-backend': { type: 'string' }, 'acp-command': { type: 'string' }, port: { type: 'string' }, limits: { type: 'string' }, plugins: { type: 'string' }, pair: { type: 'string' }, open: { type: 'boolean' },
  grant: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' }, agent: { type: 'string' }, mcp: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const;
// A command that is refused says why and what to do. A service that is not running is the
// common case for --grant and --pair; anything without a known reason keeps its stack.
function refuse(error: unknown, url?: string): never {
  const e = error as { cause?: { code?: string }; error?: { message?: string }; kind?: string; syscall?: string; message?: string };
  if (e?.cause?.code === 'ECONNREFUSED' && url) process.stderr.write(`Rho is not running at ${url}. Start it with the same --state-dir, then run this again.\n`);
  else if (e?.error?.message || e?.kind || e?.syscall) process.stderr.write((e.error?.message ?? e.message) + '\n');
  else throw error;
  process.exit(1);
}
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
    if (values.agent !== undefined && !['claude-code', 'codex'].includes(values.agent)) { process.stderr.write('Choose --agent claude-code or codex.\n'); process.exit(2); }
    if (values.agent !== undefined && values.session !== undefined) { process.stderr.write('--agent names the session itself; leave out --session.\n'); process.exit(2); }
    const { RhoClient } = await import('./client.js');
    const client = await RhoClient.fromFile(path.resolve(values.grant)).catch(error => refuse(error));
    try {
      const project = await client.call('project.open', { path: values.project });
      // The same as the project page's button: the grant that Agent keeps, then its own
      // `mcp add`, recorded so the page shows it under that Agent.
      if (values.agent) {
        const connected = await client.call('session.connect', { projectId: project.id, agent: values.agent as 'claude-code' | 'codex' });
        process.stdout.write(JSON.stringify({ projectId: project.id, root: project.root, agent: values.agent, methods: connected.methods, granted: connected.granted, added: connected.added }) + '\n');
        process.exit(0);
      }
      const session = values.session ?? 'claude-code';
      const granted = await client.call('session.grant', { projectId: project.id, externalSessionId: session });
      const { mcpCommand, mcpName } = await import('./agent-connect.js');
      const command = mcpCommand(granted.connectionFile), name = mcpName(project.root);
      const quote = (value: string) => /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
      process.stdout.write(JSON.stringify({ projectId: project.id, session, connectionFile: granted.connectionFile, methods: granted.methods.length,
        mcp: { name, command: command[0], args: command.slice(1) }, claude: ['claude', 'mcp', 'add', name, '--', ...command].map(quote).join(' ') }) + '\n');
      process.exit(0);
    } catch (error) { refuse(error, client.connection.url); }
  }
  if (values.pair) {
    const { RhoClient } = await import('./client.js');
    const client = await RhoClient.fromFile(path.resolve(values.pair)).catch(error => refuse(error));
    try {
      const pairing = await client.call('session.browser.pair', values.root ? { path: values.root } : {});
      const openUrl = link(client.connection.url, pairing.code);
      process.stdout.write(JSON.stringify({ url: client.connection.url, openUrl, pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt }) + '\n');
      if (values.open) openBrowser(openUrl);
      process.exit(0);
    } catch (error) { refuse(error, client.connection.url); }
  }
  // A person who runs `npx @rho-workspace/rho` with no arguments wants the application, not a
  // usage page: start it on their own folders, say in plain words where it is, and open it when
  // this is an interactive terminal. Every flagged start is unchanged, so scripts and
  // acceptance runs keep the output they read.
  const quickStart = !values.root && !values['state-dir'];
  if (!quickStart && (!values.root || !values['state-dir'])) {
    process.stderr.write(usage); process.exit(2);
  }
  let quickRoot = '', quickState = '';
  if (quickStart) {
    const { homedir } = await import('node:os');
    quickRoot = path.join(homedir(), 'Rho', 'projects');
    quickState = path.join(homedir(), 'Rho', 'state');
    await fs.mkdir(quickRoot, { recursive: true });
    await fs.mkdir(quickState, { recursive: true });
  }
  const projectsRoot = values.root ?? quickRoot, stateDirectory = values['state-dir'] ?? quickState;
  const limits = values.limits ? JSON.parse(await fs.readFile(values.limits, 'utf8')) : {};
  const allowed = new Set(['maxRequestBytes', 'maxEventBytes', 'eventRetention', 'maxSubscriptions', 'maxQueue', 'maxContexts', 'maxBindings', 'maxActivities', 'maxContextBytes', 'maxRetainedMetadataBytes', 'maxConcurrentActions', 'maxOperations', 'maxLogPageBytes', 'maxCodeBytes', 'maxReconciled', 'documents', 'resources', 'workspace', 'r', 'annotations', 'interactions', 'capabilityLimits', 'browser', 'nativeFolders', 'conversations', 'evidence', 'console']);
  if (Object.keys(limits).some(k => !allowed.has(k))) throw new Error('Unknown service budget in --limits file.');
  const { RhoService } = await import('./server.js'), { runtime } = await import('./runtime.js');
  const agentBackend = values['agent-backend'] ?? process.env.RHO_AGENT_BACKEND ?? 'claude-acp';
  if (!['claude-acp', 'codex-acp', 'claude-cli', 'acp'].includes(agentBackend)) throw new Error('Choose --agent-backend claude-acp, codex-acp, claude-cli or acp.');
  const acpCommand = agentBackend === 'acp' ? parseAcpCommand(values['acp-command'] ?? process.env.RHO_ACP_COMMAND) : undefined;
  if (values.port !== undefined && !(/^\d+$/.test(values.port) && Number(values.port) <= 65535)) { process.stderr.write('Choose --port 0 to 65535, or leave it out.\n'); process.exit(2); }
  // A Core that cannot be used (none for this platform, a changed digest) is read by a person.
  const native = await runtime(values.core, values.rscript).catch(e => { process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n'); process.exit(1); });
  // A person starting Rho sees the project it ships with; a composition that starts a service
  // for its own work says so itself and is left alone.
  if (values.example !== undefined && !['on', 'off'].includes(values.example)) throw new Error('Choose --example on or off.');
  const example = values.example !== 'off';
  const service = await new RhoService({ example, ...limits, root: path.resolve(projectsRoot), stateDir: path.resolve(stateDirectory), ...native, agentBackend: agentBackend as 'claude-acp' | 'codex-acp' | 'claude-cli' | 'acp', acpCommand, codex: values.codex ?? process.env.RHO_CODEX ?? 'codex', claude: values.claude ?? process.env.RHO_CLAUDE ?? 'claude', python: values.python ?? process.env.RHO_PYTHON, ssh: values.ssh ?? process.env.RHO_SSH, serverctl: values.serverctl ?? process.env.RHO_SERVERCTL, port: values.port === undefined ? undefined : Number(values.port), ...(values.plugins !== undefined ? { plugins: values.plugins ? values.plugins.split(',') as PluginId[] : [] } : {}) }).start().catch(async error => {
    // Starting Rho again on a state it already runs on is the common refusal: say where it runs.
    const held = (error as { details?: { stateDirectory?: unknown } })?.details?.stateDirectory;
    const running = typeof held === 'string' ? await fs.readFile(path.join(held, 'connection.json'), 'utf8').then(text => String(JSON.parse(text).url), () => '') : '';
    return refuse(running ? Object.assign(error, { message: `Rho is already running for ${held} at ${running}. Open that url, or stop that service before starting it again.` }) : error);
  });
  // The narrow conclusion a person needs on one line: what was selected, where state
  // lives, and how to open it. It stays inside `ready` so a parser reading line one is
  // unaffected. Opening this url on this machine is the access; no link is minted.
  const rscript = values.rscript ?? process.env.RHO_RSCRIPT ?? 'Rscript';
  process.stdout.write(JSON.stringify({ ready: {
    url: service.url, connectionFile: path.join(service.state.directory, 'connection.json'), apiVersion: '2.0',
    openUrl: service.url,
    startup: {
      projects: path.resolve(projectsRoot), state: path.resolve(stateDirectory),
      core: service.bridge.binary, rscript: service.bridge.rscript,
      note: 'Open this url in a browser on this machine. Execution stays off until an Agent submits a run; project.doctor answers what is missing.'
    }
  } }) + '\n');
  // What a person needs, after the machine line: where it is, and what is missing to work in it.
  // A missing Agent or R does not stop the workspace; it decides what the person can do next.
  if (quickStart) {
    const say = (text: string) => process.stdout.write(text + '\n');
    say('');
    say('Rho is running. Open this address in a browser on this machine:');
    say('  ' + service.url);
    say('');
    say('Projects folder: ' + quickRoot);
    say('Service state:   ' + quickState);
    say('');
    const agentCommand = await import('@rho-workspace/plugin-agent/acp-command').catch(() => null);
    // The selection the service itself got: an explicit flag, then the environment, then the name
    // on PATH. Reporting "installed" for a client the person pointed at a missing path is worse
    // than saying nothing.
    const claudePath = values.claude ?? process.env.RHO_CLAUDE, codexPath = values.codex ?? process.env.RHO_CODEX;
    const env = { ...process.env, ...(claudePath ? { CLAUDE_CODE_EXECUTABLE: claudePath } : {}), ...(codexPath ? { CODEX_PATH: codexPath } : {}) };
    // An ACP agent named with --acp-command is the operator's own command; it is named, not checked.
    if (acpCommand) say('Agent: ' + acpCommand.file + ', named with --acp-command.');
    else {
      const missing = agentCommand ? agentCommand.missingClient(agentBackend === 'codex-acp' ? 'codex' : 'claude', env) : null;
      say(missing
        ? 'Agent: ' + missing + ' Until then folders can be opened and files read here; the Agent cannot run in them.'
        : 'Agent: ' + (agentBackend === 'codex-acp' ? 'Codex' : 'Claude Code') + ' is installed; a conversation can start in any project.');
    }
    const hasR = await fs.access(service.bridge.rscript).then(() => true, () => false);
    say(hasR
      ? 'R: ' + service.bridge.rscript
      : 'R: Rscript was not found. Reading, editing and viewing work; running R needs R installed (or --rscript).');
    say('');
    say('Stop it with Ctrl+C. Start it again with: npx @rho-workspace/rho');
    if (process.stdout.isTTY) openBrowser(service.url);
  }
  if (values.open) openBrowser(service.url);
  let closing = false;
  // Windows has no SIGTERM another process can send, and a console may pass on Ctrl+C turned off;
  // there Ctrl+Break on Rho's console (SIGBREAK) stops it in order too.
  for (const signal of ['SIGTERM', 'SIGINT', ...(process.platform === 'win32' ? ['SIGBREAK'] as const : [])] as const) process.on(signal, async () => { if (closing) return; closing = true; const reports = await service.close(); process.stdout.write(JSON.stringify({ shutdown: reports }) + '\n'); });
}
