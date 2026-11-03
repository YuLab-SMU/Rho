import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RhoService } from '../dist/server.js';

// What a person or their Agent reads when a command cannot do its work: one line with the
// reason and what to do next, not a stack.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const rho = (...args) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

test('a second start on the same state names the running service, and --grant to a stopped one says it is not running', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rho-refusals-')));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(path.join(root, 'projects', 'p'), { recursive: true });
  const service = await new RhoService({ root: path.join(root, 'projects'), stateDir, rscript: 'Rscript', coreBinary: path.join(root, 'absent-core') }).start();
  try {
    const again = await rho('--root', path.join(root, 'projects'), '--state-dir', stateDir);
    assert.equal(again.code, 1);
    assert.equal(again.stderr.trim(), `Rho is already running for ${stateDir} at ${service.url}. Open that url, or stop that service before starting it again.`);
  } finally { await service.close(); }
  const stopped = await rho('--grant', path.join(stateDir, 'connection.json'), '--project', 'p', '--agent', 'codex');
  assert.equal(stopped.code, 1);
  assert.equal(stopped.stderr.trim(), `Rho is not running at ${service.url}. Start it with the same --state-dir, then run this again.`);
  const unknown = await rho('--grant', path.join(stateDir, 'connection.json'), '--project', 'p', '--agent', 'cursor');
  assert.deepEqual([unknown.code, unknown.stderr.trim()], [2, 'Choose --agent claude-code or codex.']);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
