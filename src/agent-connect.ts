import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fault } from '@rho-workspace/plugin-contracts';
import { announced } from './running.js';
import { endProgram, spawnProgram } from './programs.js';

// Adding Rho to an Agent that runs outside Rho: the project-scoped MCP server it starts, under
// a name that says which project, written by the Agent's own `mcp add` so its configuration
// stays its own. Claude Code keeps the entry for the project folder; Codex has one
// configuration for every folder.
export type OutsideAgent = 'claude-code' | 'codex';
export const outsideLabel: Record<OutsideAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
export type AddedTo = { agent: OutsideAgent; name: string; scope: 'folder' | 'user'; at: string };
// The Agent's CLI is the protected resource: each `mcp` command runs for at most timeoutMs and
// keeps at most outputBytes of what it printed; past either, it is stopped and the step fails
// with what it printed so far.
export const connectLimits = { timeoutMs: 20000, outputBytes: 8192 };

export function mcpName(root: string) {
  return 'rho-' + (path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project');
}
export function mcpCommand(connectionFile: string) {
  return [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url)), '--mcp', connectionFile];
}

// Ready entries for the clients whose own mechanism has been used with Rho, so an Agent need not
// search its documentation for it: Claude Code's and Codex's `mcp add`, OpenCode's project
// configuration and DeepSeek Harness's profile patch (no `dsh mcp` command exists). Each holds
// the same name, command and arguments as `mcp`; any other client registers those itself.
export function clientEntries(name: string, command: string[], root: string, env: NodeJS.ProcessEnv = process.env) {
  const quote = (value: string) => /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  const yaml = (value: string) => JSON.stringify(value);
  return {
    claude: ['claude', 'mcp', 'add', name, '--', ...command].map(quote).join(' '),
    codex: ['codex', 'mcp', 'add', name, '--', ...command].map(quote).join(' '),
    opencode: { file: path.join(root, '.opencode', 'opencode.json'), merge: { mcp: { [name]: { type: 'local', command, enabled: true } } } },
    dsh: { file: path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml'),
      workspace: { plugin: 'dsh-rho', minimumVersion: '0.1.6', guide: 'https://yulab-smu.top/Rho/docs/reference/deepseek-harness.html',
        mergeConfig: { command: command[0], args: command.slice(1, -2), connectionFiles: [command.at(-1)] },
        instructions: 'For conversations and process views, use the dsh-rho plugin. Merge this config into its existing entry, appending the connection file without removing other projects. The append entry below supplies MCP tools only; it does not observe Harness conversations.' },
      append: ['- insert:', `    - id: ${yaml('mcp-' + name)}`, '      name: "@deepseek-ai/dsh-mcp-client"', '      config:', `        serverName: ${yaml(name)}`, '        transport: "stdio"',
        `        command: ${yaml(command[0])}`, '        args:', ...command.slice(1).map(arg => `          - ${yaml(arg)}`)].join('\n') + '\n' },
  };
}

// The state folder of a Rho started without --state-dir, which `rho --stop` and `rho connect`
// also take without it.
export const defaultStateDirectory = () => path.join(os.homedir(), 'Rho', 'state');

// How a shell runs this Rho: `rho` when the first `rho` on PATH is this installation (npm's
// link, or its .cmd shim on Windows), otherwise this Node with this cli.js.
export async function launcher(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url)), real = await fs.realpath(cli).catch(() => cli);
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, platform === 'win32' ? 'rho.cmd' : 'rho');
    let target: string | null;
    try {
      if (platform === 'win32') {
        const shim = (await fs.readFile(candidate, 'utf8')).match(/"%dp0%\\([^"]*?cli\.js)"/i);
        target = shim ? await fs.realpath(path.resolve(dir, shim[1]!)).catch(() => null) : null;
      } else { target = await fs.realpath(candidate); await fs.access(candidate, fs.constants.X_OK).catch(() => { target = null; }); }
    } catch { continue; }
    return target === real ? ['rho'] : [process.execPath, cli];
  }
  return [process.execPath, cli];
}
// A command line to read and paste: plain words as they are, anything else in double quotes.
export function commandLine(argv: string[], platform: NodeJS.Platform = process.platform) {
  return argv.map(arg => /^[A-Za-z0-9_./:@=+,-]+$/.test(arg) ? arg : platform === 'win32' ? `"${arg}"` : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`).join(' ');
}

// The prompt names the project and one command; `rho connect` tells the Agent the rest. It names
// --state-dir only when `rho connect` would not find this Rho itself: a state folder other than
// ~/Rho/state that no running note points to (a service started without the CLI). Reading
// these instructions starts nothing, grants no access and includes no credential bytes.
export async function connectionInstructions(project: { id: string; root: string }, stateDirectory: string) {
  const found = path.resolve(stateDirectory) === path.resolve(defaultStateDirectory()) || await announced(stateDirectory);
  const state = found ? [] : ['--state-dir', stateDirectory];
  const command = [...await launcher(), 'connect', project.root, ...state];
  const request = `Connect yourself to my Rho project ${JSON.stringify(path.basename(project.root))} so we can work on it together.`;
  const prompt = [request, '',
    'Rho is already running on this machine. Run this command with a short, stable name for yourself in place of NAME, and follow its reply:',
    '', commandLine([...command, '--as', 'NAME']),
  ].join('\n');
  return { request, prompt, command };
}

function run(binary: string, args: string[], cwd: string, limits: typeof connectLimits) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawnProgram(binary, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stopped = '';
    const keep = (chunk: Buffer) => { if (output.length < limits.outputBytes) output = (output + chunk.toString('utf8')).slice(0, limits.outputBytes); };
    child.stdout!.on('data', keep); child.stderr!.on('data', keep);
    const timer = setTimeout(() => { stopped = 'timeout'; endProgram(child); }, limits.timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (stopped) reject(new Fault('limit', `It did not finish within ${limits.timeoutMs / 1000} s. ${output.trim()}`.trim())); else resolve({ code, output }); });
  });
}

// Replaces Rho's entry rather than failing on it, so adding again repairs a moved checkout.
export async function addToAgent(agent: OutsideAgent, binary: string, root: string, name: string, command: string[], limits = connectLimits) {
  const label = outsideLabel[agent], scope = agent === 'claude-code' ? ['-s', 'local'] : [];
  try {
    await run(binary, ['mcp', 'remove', ...scope, name], root, limits).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; });
    const added = await run(binary, ['mcp', 'add', ...scope, name, '--', ...command], root, limits);
    if (added.code !== 0) throw new Fault('unavailable', `${label} could not add Rho: ${added.output.trim().split('\n')[0] || 'it exited with ' + added.code}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Fault('unavailable', `${label} was not found on this machine. Rho looked for \`${binary}\`.`);
    if (error instanceof Fault && error.kind === 'limit') throw new Fault('limit', `${label} could not add Rho. ${error.message}`);
    throw error;
  }
  return { agent, name, scope: agent === 'claude-code' ? 'folder' : 'user', at: new Date().toISOString() } satisfies AddedTo;
}
