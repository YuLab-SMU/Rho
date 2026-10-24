// Existing operator credentials stay in the child's environment, never evidence.
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
export async function runClaude(args, cwd, root, timeoutMs = 600000) {
  const settings = JSON.parse(await fs.readFile(path.join(homedir(), '.claude/settings.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e; }));
  const env = { ...process.env, ...settings.env, ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}) };
  const child = spawn('claude', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = createWriteStream(path.join(root, 'claude-result.json'), { mode: 0o600 });
  const stderr = createWriteStream(path.join(root, 'claude-stderr.txt'), { mode: 0o600 });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  const stop = signal => { try { process.kill(-child.pid, signal); } catch {} };
  let timedOut = false;
  const started = Date.now();
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); const kill = setTimeout(() => stop('SIGKILL'), 5000); kill.unref(); }, timeoutMs);
  const exitCode = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', resolve); });
  clearTimeout(timer); await Promise.all([finished(stdout), finished(stderr)]);
  return { exitCode, timedOut, elapsedMs: Date.now() - started, clientVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim() };
}
