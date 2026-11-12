#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { PluginId } from './plugins.js';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
// A widened link is optional: the fragment carries a one-time code, which no request or Referer
// sends and which the page redeems and removes. Opening the plain url needs no code at all.
const link = (url: string, code: string) => url + '/#pair=' + code;
// What Ctrl+C does, asked by another program: Windows has no signal one process can send to Rho
// there, so `rho --stop` leaves this file in the state folder and the running launcher looks for it,
// as Rho asks its Host to stop on Windows.
const stopRequest = (stateDirectory: string) => path.join(stateDirectory, 'service.stop');
function openBrowser(target: string) {
  void import('./background.js').then(({ openInBrowser }) => openInBrowser(target)).then(result => { if (!result.opened) process.stderr.write(result.note + '\n'); });
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
const usage = `Rho is a workspace in the web browser on this machine, where a person and their Agent work
on the same folder: files, figures, tables, a live R and Python Notebook and notes.

Open a folder in Rho, in the browser, starting Rho in the background when it is not running
(the current folder without FOLDER; rho open --help for its options):
  rho open [FOLDER]
Take a folder off Rho's list of projects; the folder and its files stay as they are (rho remove --help):
  rho remove [FOLDER]
Say whether Rho runs for a state folder (~/Rho/state without --state-dir), at which address, how
the last one ended, and which others run on this machine:
  rho --status [--state-dir SERVICE_STATE]
Stop it in order, as Ctrl+C in its window does:
  rho --stop [--state-dir SERVICE_STATE]
Print this version:
  rho --version

For an Agent:
  rho connect [PROJECT_FOLDER] --as NAME     add Rho's tools to your MCP client (rho connect --help)
  rho tool index --as NAME                   call the same tools from your shell now (rho tool --help)
  rho --install-skill SKILL_DIRECTORY        install the Rho Agent Skill this version ships

Start Rho on ~/Rho/projects and ~/Rho/state in this terminal, and say where it is and what is missing:
  rho
Start Rho with chosen folders and options:
  rho --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE [--core ABSOLUTE_CORE_BINARY] [--rscript ABSOLUTE_RSCRIPT] [--python PYTHON] [--ssh SSH] [--serverctl SERVERCTL] [--claude CLAUDE_CODE_BINARY] [--codex CODEX_BINARY] [--agent-backend claude-acp|codex-acp|claude-cli|acp] [--acp-command JSON_ARGV] [--port PORT] [--limits JSON_FILE] [--plugins documents,files,...] [--example on|off] [--open]
Add --background to either start to have it return once Rho is ready, with Rho's output in
SERVICE_STATE/rho.log and the last start's in rho.previous.log.

Less common:
  rho plugin --help                          develop, install and manage independent plugins
  rho --verify-evidence PATH                 verify a read-only evidence package
  rho --pair PRIVATE_CONNECTION_FILE [--root PROJECTS_RELATIVE_DIRECTORY] [--open]
                                             a narrower, expiring browser link (optional)
  rho --grant PRIVATE_CONNECTION_FILE --project PROJECTS_RELATIVE_DIRECTORY --agent claude-code|codex
                                             add Rho to your own Claude Code or Codex for one project
  rho --grant PRIVATE_CONNECTION_FILE --project PROJECTS_RELATIVE_DIRECTORY [--session NAME]
  rho --grant PRIVATE_CONNECTION_FILE --project-id EXISTING_PROJECT_ID --session NAME
                                             give any MCP Agent one project; prints its stdio MCP configuration
  rho --mcp AGENT_CONNECTION_FILE            serve that access to the Agent over MCP (stdio)
  rho --acp /absolute/project --acp-agent claude|codex
                                             observe an external ACP client (use as its agent command)
--example off starts Rho without the project it ships; a new state otherwise gets that project
once, copied into the projects directory. --open opens the printed url in the default browser.
Without --port a start takes the port this state's last start had, and a new one only when that
port is taken; --port 0 always takes a new one.
Opening that url on this machine needs no link, code or session credential; --pair makes a
narrower, expiring link for one folder.
PRIVATE_CONNECTION_FILE is the connectionFile the running service printed; it and every
connection file are credentials.
`;
// DeepSeek Harness speaks ACP through its `acp` profile (`dsh acp`). It is used only when both the
// launcher and that profile are on this computer; nothing is started to find them.
async function harnessAcp() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = await fs.stat(path.join(home, 'profiles', 'acp', 'package.json')).then(s => s.isFile(), () => false);
  if (!profile) return undefined;
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    for (const name of names) {
      const file = path.join(dir, name);
      if (await fs.access(file, fsConstants.X_OK).then(() => true, () => false)) return { file, args: ['acp'] };
    }
  return undefined;
}
const options = { example: { type: 'string' }, 'verify-evidence': { type: 'string' }, acp: { type: 'string' }, 'acp-agent': { type: 'string' }, root: { type: 'string' }, 'state-dir': { type: 'string' }, core: { type: 'string' }, rscript: { type: 'string' }, python: { type: 'string' }, ssh: { type: 'string' }, serverctl: { type: 'string' }, claude: { type: 'string' }, codex: { type: 'string' }, 'agent-backend': { type: 'string' }, 'acp-command': { type: 'string' }, port: { type: 'string' }, limits: { type: 'string' }, plugins: { type: 'string' }, pair: { type: 'string' }, open: { type: 'boolean' }, background: { type: 'boolean' }, status: { type: 'boolean' }, 'install-skill': { type: 'string' }, version: { type: 'boolean' },
  grant: { type: 'string' }, project: { type: 'string' }, 'project-id': { type: 'string' }, session: { type: 'string' }, agent: { type: 'string' }, mcp: { type: 'string' }, stop: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } as const;
// A command that is refused says why and what to do. A service that is not running is the
// common case for --grant and --pair; anything without a known reason keeps its stack.
function refuse(error: unknown, url?: string): never {
  const e = error as { cause?: { code?: string }; error?: { message?: string }; kind?: string; syscall?: string; message?: string };
  if (e?.cause?.code === 'ECONNREFUSED' && url) process.stderr.write(`Rho is not running at ${url}. Start it with the same --state-dir, then run this again.\n`);
  else if (e?.error?.message || e?.kind || e?.syscall) process.stderr.write((e.error?.message ?? e.message) + '\n');
  else throw error;
  process.exit(1);
}
if (process.argv[2] === 'plugin') {
  try { await (await import('./plugin-cli.js')).pluginCli(process.argv.slice(3)); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
} else if (process.argv[2] === 'connect') {
  process.exitCode = await (await import('./connect-cli.js')).connectCli(process.argv.slice(3));
} else if (process.argv[2] === 'open') {
  process.exitCode = await (await import('./open-cli.js')).openCli(process.argv.slice(3));
} else if (process.argv[2] === 'remove') {
  process.exitCode = await (await import('./open-cli.js')).removeCli(process.argv.slice(3));
} else if (process.argv[2] === 'tool') {
  process.exitCode = await (await import('./open-cli.js')).toolCli(process.argv.slice(3));
} else {
let parsed;
try { parsed = parseArgs({ options }); }
catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n\n' + usage); process.exit(2); }
const { values } = parsed;
if (values['verify-evidence']) {
  try { const { verifyEvidence } = await import('./evidence-export.js'); process.stdout.write(JSON.stringify(await verifyEvidence(path.resolve(values['verify-evidence']))) + '\n'); } catch (e) { process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n'); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
if (values.help) { process.stdout.write(usage); process.exit(0); }
const version = () => fs.readFile(new URL('../package.json', import.meta.url), 'utf8').then(text => String(JSON.parse(text).version));
if (values.version) { process.stdout.write(await version() + '\n'); process.exit(0); }
if (values.status) {
  const { serviceStatus } = await import('./background.js');
  process.stdout.write(JSON.stringify(await serviceStatus(values['state-dir'] ?? path.join(os.homedir(), 'Rho', 'state'))) + '\n');
  process.exit(0);
}
if (values['install-skill'] !== undefined) {
  const { installSkill } = await import('./background.js');
  if (!values['install-skill']) { process.stderr.write('Give --install-skill the skills folder to install into, such as ~/.claude/skills/rho.\n'); process.exit(2); }
  try { process.stdout.write(JSON.stringify(await installSkill(values['install-skill'], await version())) + '\n'); process.exit(0); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exit(1); }
}
if (values.stop) {
  const { lease } = await import('./state.js');
  const directory = path.resolve(values['state-dir'] ?? path.join(os.homedir(), 'Rho', 'state'));
  // The state's writer lock says whether a service runs there: a lock this command can take is free.
  // A folder without a connection file was never a Rho state, and gets no lock file of its own.
  const running = () => lease(directory).then(async release => { await release(); return false; }, (e: { kind?: string }) => { if (e?.kind === 'conflict') return true; throw e; });
  const asked = () => fs.access(stopRequest(directory)).then(() => true, () => false);
  const connection = await fs.readFile(path.join(directory, 'connection.json'), 'utf8').then(text => JSON.parse(text) as { pid?: unknown }).catch(() => null);
  if (!connection || !await running()) { process.stderr.write(`Rho is not running for ${directory}.\n`); process.exit(1); }
  await fs.writeFile(stopRequest(directory), '');
  // The launcher takes the request within a second and then stops as on Ctrl+C: its output ends
  // with the {"shutdown":…} line, and the lock is free once its state is written.
  const since = Date.now();
  while (await running()) {
    if (Date.now() - since > 10000 && await asked()) {
      await fs.rm(stopRequest(directory), { force: true });
      process.stderr.write(`The Rho running for ${directory} did not take the stop request: it is a version without --stop. Stop it with Ctrl+C in its own window (Ctrl+Break on Windows).\n`); process.exit(1);
    }
    if (Date.now() - since > 120000) { process.stderr.write(`Rho for ${directory} is still stopping after two minutes. Its output ends with a {"shutdown":…} line once it has stopped.\n`); process.exit(1); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // The lock is released before the launcher prints its report and ends, and on Windows the log
  // it writes stays open until then: a start right after would find that file in use.
  const pid = Number.isInteger(connection.pid) ? connection.pid as number : 0;
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
  for (let i = 0; pid && alive(); i++) {
    if (i === 40) { process.stderr.write(`Rho for ${directory} has closed its state, but its process ${pid} has not ended after 10 s.\n`); process.exit(1); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  process.stdout.write(JSON.stringify({ stopped: { state: directory } }) + '\n');
  process.exit(0);
}
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
    if (!!values.project === !!values['project-id']) { process.stderr.write('--grant needs exactly one of --project (a folder relative to the service root) or --project-id (an existing project).\n\n' + usage); process.exit(2); }
    if (values.agent !== undefined && !['claude-code', 'codex'].includes(values.agent)) { process.stderr.write('Choose --agent claude-code or codex.\n'); process.exit(2); }
    if (values.agent !== undefined && values.session !== undefined) { process.stderr.write('--agent names the session itself; leave out --session.\n'); process.exit(2); }
    const { RhoClient } = await import('./client.js');
    const client = await RhoClient.fromFile(path.resolve(values.grant)).catch(error => refuse(error));
    try {
      const project = values['project-id']
        ? (await client.call('project.list', {})).find(p => p.id === values['project-id'])
        : await client.call('project.open', { path: values.project! });
      if (!project) { process.stderr.write('Project is not registered or is outside this connection’s scope. Open the project in Rho and copy its setup prompt again.\n'); process.exit(1); }
      // The same as the project page's button: the grant that Agent keeps, then its own
      // `mcp add`, recorded so the page shows it under that Agent.
      if (values.agent) {
        const connected = await client.call('session.connect', { projectId: project.id, agent: values.agent as 'claude-code' | 'codex' });
        process.stdout.write(JSON.stringify({ projectId: project.id, root: project.root, agent: values.agent, methods: connected.methods, granted: connected.granted, added: connected.added }) + '\n');
        process.exit(0);
      }
      const { grantReply } = await import('./connect-cli.js');
      process.stdout.write(JSON.stringify(await grantReply(client, project, values.session ?? 'claude-code')) + '\n');
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
  if (values.background) {
    const { startInBackground } = await import('./background.js');
    process.exit(await startInBackground(process.argv.slice(2).filter(arg => arg !== '--background'), stateDirectory));
  }
  const limits = values.limits ? JSON.parse(await fs.readFile(values.limits, 'utf8')) : {};
  const allowed = new Set(['maxRequestBytes', 'maxEventBytes', 'eventRetention', 'maxSubscriptions', 'maxQueue', 'maxContexts', 'maxBindings', 'maxActivities', 'maxContextBytes', 'maxRetainedMetadataBytes', 'maxConcurrentActions', 'maxOperations', 'maxLogPageBytes', 'maxCodeBytes', 'maxReconciled', 'documents', 'resources', 'workspace', 'r', 'annotations', 'interactions', 'capabilityLimits', 'browser', 'nativeFolders', 'projectRemoval', 'conversations', 'evidence', 'console']);
  if (Object.keys(limits).some(k => !allowed.has(k))) throw new Error('Unknown service budget in --limits file.');
  const { RhoService } = await import('./server.js'), { runtime } = await import('./runtime.js');
  const agentBackend = values['agent-backend'] ?? process.env.RHO_AGENT_BACKEND ?? 'claude-acp';
  if (!['claude-acp', 'codex-acp', 'claude-cli', 'acp'].includes(agentBackend)) throw new Error('Choose --agent-backend claude-acp, codex-acp, claude-cli or acp.');
  // An ACP command named here, or else DeepSeek Harness's own ACP profile when it is installed, so
  // sessions started in Harness continue in Rho too. Naming one does not make it the default Agent.
  const named = values['acp-command'] ?? process.env.RHO_ACP_COMMAND;
  const acpCommand = agentBackend === 'acp' || named ? parseAcpCommand(named) : await harnessAcp();
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
  // A request left by a --stop that this state's earlier service never took is not for this start.
  await fs.rm(stopRequest(service.state.directory), { force: true });
  // Where `rho connect` finds this Rho without being given its state folder.
  const { announce, withdraw } = await import('./running.js');
  await announce({ stateDirectory: service.state.directory, url: service.url, pid: process.pid }).catch(() => {});
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
    if (acpCommand && agentBackend === 'acp') say('Agent: ' + acpCommand.file + ', named with --acp-command.');
    else {
      if (acpCommand) say('Also: ' + (acpCommand.args[0] === 'acp' && /dsh(\.[a-z]+)?$/i.test(acpCommand.file) ? 'DeepSeek Harness (' + acpCommand.file + ' acp)' : acpCommand.file) + ', so its sessions can continue here.');
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
  let closing = false, asked: NodeJS.Timeout | undefined;
  // The last line says what stopped Rho and when, so a log read later tells a stop in order from
  // one ended from outside, which writes nothing.
  const stop = async (by: string) => { if (closing) return; closing = true; clearInterval(asked); await withdraw(service.state.directory).catch(() => {}); const reports = await service.close(); process.stdout.write(JSON.stringify({ shutdown: reports, by, at: new Date().toISOString() }) + '\n'); };
  // Windows has no SIGTERM another process can send, and a console may pass on Ctrl+C turned off;
  // there Ctrl+Break on Rho's console (SIGBREAK) stops it in order too.
  for (const signal of ['SIGTERM', 'SIGINT', ...(process.platform === 'win32' ? ['SIGBREAK'] as const : [])] as const) process.on(signal, () => stop(signal));
  // A program with no console to share, such as an Agent that started Rho in the background on
  // Windows, asks with rho --stop. Removing the request is what takes it.
  asked = setInterval(() => { fs.rm(stopRequest(service.state.directory)).then(() => stop('rho --stop'), () => {}); }, 500);
  asked.unref();
}

}
