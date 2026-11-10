import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The WorkBuddy connector (adapters/workbuddy-rho): its build passes its own checks, it carries the
// Skill with every reference of skills/rho, and the commands cli.json gives WorkBuddy work on this
// build of `rho` the way WorkBuddy reads them.
const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const rho = (...args) => run(process.execPath, [path.join(root, 'dist/cli.js'), ...args], { cwd: os.tmpdir(), timeout: 60000 });

test('the WorkBuddy connector builds, with the Skill and its references', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-wb-'));
  try {
    const { stdout } = await run(process.execPath, [path.join(root, 'adapters/workbuddy-rho/build.mjs'), out], { timeout: 60000 });
    const built = JSON.parse(stdout);
    assert.equal(built.connector.source, 'rho-workspace');
    const references = (await fs.readdir(path.join(root, 'skills/rho/references'))).filter(f => f.endsWith('.md')).sort();
    assert.deepEqual(built.files.filter(f => f.startsWith('skills/rho/references/')).map(f => path.basename(f)).sort(), references);
    for (const f of ['connector-meta.json', 'cli.json', 'icon.svg', 'skills/rho/SKILL.md']) assert.ok(built.files.includes(f), f);
  } finally { await fs.rm(out, { recursive: true, force: true }); }
});

test('cli.json commands answer as WorkBuddy expects on this build', async () => {
  const cli = JSON.parse(await fs.readFile(path.join(root, 'adapters/workbuddy-rho/connector/cli.json'), 'utf8'));
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  // WorkBuddy runs each command in a shell; here `rho` (or rho.cmd) is this checkout's dist/cli.js.
  for (const command of [cli.status[platform], cli.versionCheck.command[platform], cli.unAuth[platform]]) {
    assert.match(command, /^rho(\.cmd)? --version$/);
    const { stdout } = await rho('--version');
    assert.match(stdout, new RegExp(cli.statusMatch), 'statusMatch matches what the command prints');
    const [a, b] = [stdout.trim(), cli.versionCheck.minVersion].map(v => v.split('.').map(Number));
    assert.ok(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]))), `${stdout.trim()} is at least minVersion ${cli.versionCheck.minVersion}`);
  }
  // The Skill's two commands exist in this build.
  const skill = await fs.readFile(path.join(root, 'adapters/workbuddy-rho/connector/skills/rho/SKILL.md'), 'utf8');
  for (const sub of ['open', 'tool']) {
    assert.ok(skill.includes(`rho ${sub} `), `the Skill uses rho ${sub}`);
    assert.equal((await rho(sub, '--help')).stdout.length > 0, true);
  }
});
