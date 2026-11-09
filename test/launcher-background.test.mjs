import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

// An Agent starts Rho with one command that returns once Rho is ready and leaves it running, as the
// setup page asks, instead of writing a script of its own. execFile resolves only when the command
// has ended and its output is closed, so a start that kept the caller's output open would time out
// here, as `Start-Process` with redirection did on Windows.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('--background returns once Rho is ready, --status says how it runs and how it ended, and the last log is kept', { timeout: 180000 }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-background-'));
  const env = { ...process.env, RHO_RUNNING_DIR: path.join(root, 'running') };
  // A Linux machine with no display, as CI's: --open says it opened nothing.
  const headless = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME;
  const rho = (...args) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { timeout: 90000, windowsHide: true, env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr, killed: error?.killed })));
  const state = path.join(root, 'state'), projects = path.join(root, 'projects');
  const start = ['--root', projects, '--state-dir', state, '--example', 'off', '--port', '0'];
  const status = async () => JSON.parse((await rho('--status', '--state-dir', state)).stdout);
  await fs.mkdir(projects);
  let pid;
  try {
    assert.equal((await status()).status.note, 'No Rho has run with this state folder.');
    const began = Date.now();
    const first = await rho(...start, ...(headless ? ['--open'] : []), '--background');
    assert.equal(first.code, 0, first.stderr);
    assert.ok(Date.now() - began < 60000);
    const lines = first.stdout.trim().split('\n');
    const { ready } = JSON.parse(lines[0]);
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(lines[1], /^Rho runs in the background as process \d+, with its output in /);
    // The command has ended; Rho has not.
    let now = await status();
    assert.deepEqual([now.status.running, now.status.answers, now.status.url, now.status.log], [true, 200, ready.url, path.join(state, 'rho.log')]);
    pid = now.status.pid;
    const again = await rho(...start, '--background');
    assert.deepEqual([again.code, again.stderr.trim()], [1, `Rho is already running for ${state} at ${ready.url}. Open that url, or stop that service before starting it again.`]);
    if (headless) {
      let log = '';
      for (let i = 0; i < 40 && !log.includes('No browser was opened'); i++) { await setTimeout(100); log = await fs.readFile(path.join(state, 'rho.log'), 'utf8'); }
      assert.match(log, /No browser was opened: this machine has no display/);
    }
    const stopped = await rho('--stop', '--state-dir', state);
    assert.equal(stopped.code, 0, stopped.stderr);
    pid = undefined;
    now = await status();
    assert.equal(now.status.running, false);
    assert.match(now.status.note, /^Not running\. It stopped in order on rho --stop at \d{4}-/);
    const { shutdown, by } = JSON.parse((await fs.readFile(path.join(state, 'rho.log'), 'utf8')).trim().split('\n').at(-1));
    assert.deepEqual([shutdown, by], [[], 'rho --stop']);

    // A start keeps the last one's log; a service ended from outside writes no last line.
    const second = await rho(...start, '--background');
    assert.equal(second.code, 0, second.stderr);
    assert.match(await fs.readFile(path.join(state, 'rho.previous.log'), 'utf8'), /"by":"rho --stop"/);
    pid = (await status()).status.pid;
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && (await status()).status.running; i++) await setTimeout(100);
    pid = undefined;
    now = await status();
    assert.equal(now.status.running, false);
    assert.match(now.status.note, /^Not running\. Its log ends without a \{"shutdown":…\} line/);

    // A start that fails says why, from Rho's own output.
    const missing = await rho('--root', path.join(root, 'absent'), '--state-dir', path.join(root, 'state-2'), '--background');
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^Rho stopped before it was ready \(exit 1\)\. Its output, from .*rho\.log:\n.*absent/s);
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('--install-skill copies the Skill this version ships, and leaves another skill alone', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-skill-'));
  const rho = (...args) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  try {
    const target = path.join(root, 'skills', 'rho');
    const shipped = (await fs.readdir(fileURLToPath(new URL('../skills/rho/', import.meta.url)), { recursive: true })).map(f => f.split(path.sep).join('/')).filter(f => f.endsWith('.md')).sort();
    const done = await rho('--install-skill', target);
    assert.equal(done.code, 0, done.stderr);
    const { skill } = JSON.parse(done.stdout);
    const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.deepEqual(skill, { name: 'rho', version, dir: target, files: shipped });
    for (const file of shipped) assert.equal(await fs.readFile(path.join(target, file), 'utf8'), await fs.readFile(new URL('../skills/rho/' + file, import.meta.url), 'utf8'));
    // Again over an earlier copy: replaced.
    await fs.writeFile(path.join(target, 'references', 'install.md'), 'old');
    assert.equal((await rho('--install-skill', target)).code, 0);
    assert.notEqual(await fs.readFile(path.join(target, 'references', 'install.md'), 'utf8'), 'old');
    const other = path.join(root, 'other');
    await fs.mkdir(other); await fs.writeFile(path.join(other, 'SKILL.md'), '---\nname: other\n---\n');
    const refused = await rho('--install-skill', other);
    assert.deepEqual([refused.code, refused.stderr.trim()], [1, `${other} holds another skill, named other. Choose another folder, or ask the person what it is.`]);
    assert.deepEqual(await fs.readdir(other), ['SKILL.md']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
