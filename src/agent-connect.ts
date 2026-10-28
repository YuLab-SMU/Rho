import { spawn } from 'node:child_process';
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
