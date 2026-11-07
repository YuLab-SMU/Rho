import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fault } from '@rho-workspace/plugin-contracts';

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
      append: ['- insert:', `    - id: ${yaml('mcp-' + name)}`, '      name: "@deepseek-ai/dsh-mcp-client"', '      config:', `        serverName: ${yaml(name)}`, '        transport: "stdio"',
        `        command: ${yaml(command[0])}`, '        args:', ...command.slice(1).map(arg => `          - ${yaml(arg)}`)].join('\n') + '\n' },
  };
}

// Paths are data in an argv array, never an interpolated shell command. Reading these
// instructions starts nothing, grants no access and includes no credential bytes.
export function connectionInstructions(project: { id: string; root: string }, stateDirectory: string) {
  const command = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url)), '--grant', path.join(stateDirectory, 'connection.json'), '--project-id', project.id];
  const request = `Connect yourself to my existing Rho project ${JSON.stringify(path.basename(project.root))} so we can work on it together.`;
  const prompt = [request, '',
    `Project folder: ${JSON.stringify(project.root)}. Project ID: ${project.id}. Rho is already running on this machine.`,
    'Configure your own client using its supported MCP setup mechanism; inspect your own help or documentation if needed. Keep unrelated configuration, models and credentials intact. Use private local configuration, scoped to this project where supported, and keep connection settings out of version-controlled files. If you cannot run a local stdio MCP server, explain that limitation.',
    'Run this program and argument array, appending --session and a stable name identifying your own Agent (1–128 characters from A–Z, a–z, 0–9, dot, underscore, colon, @ or hyphen). Reuse that name when retrying:',
    JSON.stringify(command),
    'Parse the JSON reply. Register a stdio MCP server using mcp.name, mcp.command and mcp.args exactly as returned. If the reply has a ready entry for your client, use it: claude or codex (a command to run in the project folder), opencode (merge into the named file) or dsh (append to the named DeepSeek Harness profile patch, which reloads by itself). The connection files contain credentials: do not print their contents or put them in the project. Do not start another Rho service.',
    'Reload your MCP tools if supported, or tell me to open a new session in the project folder. Then call rho_index through your configured client tools and verify scopeHint.projectId matches the project ID above. A direct protocol probe is useful diagnostics but does not prove your client loaded its tools. Report configuration and a successful tool call separately; do not claim connected before the call succeeds. If configuration or verification fails, report the actual error and continue from the same connection.',
  ].join('\n');
  return { request, prompt, command };
}

function run(binary: string, args: string[], cwd: string, limits: typeof connectLimits) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stopped = '';
    const keep = (chunk: Buffer) => { if (output.length < limits.outputBytes) output = (output + chunk.toString('utf8')).slice(0, limits.outputBytes); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { stopped = 'timeout'; child.kill('SIGKILL'); }, limits.timeoutMs);
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
