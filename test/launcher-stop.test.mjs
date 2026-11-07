import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { CheckedClient } from './checked-client.mjs';
import { digest } from '@rho-workspace/plugin-contracts';

// Raises Ctrl+Break on the console of a process, as another program stops a console program on
// Windows: attach to that console, keep the event from ending this helper, raise it for all there.
const ctrlBreak = pid => new Promise(resolve => execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`Add-Type -Namespace Rho -Name Break -MemberDefinition @'
public delegate bool Handler(uint ctrl);
static readonly Handler Keep = ctrl => true;
[DllImport("kernel32.dll")] static extern bool FreeConsole();
[DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
[DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ctrl, uint group);
public static int Raise(uint pid) { FreeConsole(); if (!AttachConsole(pid)) return 1; SetConsoleCtrlHandler(Keep, true); bool raised = GenerateConsoleCtrlEvent(1, 0); System.Threading.Thread.Sleep(100); FreeConsole(); return raised ? 0 : 2; }
'@
exit [Rho.Break]::Raise(${pid})`, 'utf16le').toString('base64')], { windowsHide: true }, error => resolve(error?.code ?? 0)));

test('Ctrl+Break on its console stops the launcher in order, and the Host it started reports', { timeout: 60000, skip: process.platform !== 'win32' && 'Ctrl+Break is how another program stops Rho on Windows' }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-launcher-'));
  await fs.mkdir(path.join(root, 'projects'));
  const launcher = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--root', path.join(root, 'projects'), '--state-dir', path.join(root, 'state')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let printed = ''; launcher.stdout.on('data', b => { printed += b; });
  const exited = once(launcher, 'exit');
  let hostPid;
  try {
    for (let i = 0; i < 300 && !printed.includes('\n'); i++) await setTimeout(50);
    const ready = JSON.parse(printed.split('\n')[0]).ready;
    const c = new CheckedClient({ url: ready.url, token: JSON.parse(await fs.readFile(ready.connectionFile, 'utf8')).token });
    const p = await c.call('project.create', { name: 'p' });
    const script = 'cat("ran\\n")\n';
    await fs.writeFile(path.join(p.root, 'run.R'), script);
    await c.call('action.submit', { projectId: p.id, operationId: 'run', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'run.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null } });
    let run;
    for (let i = 0; i < 200; i++) { run = await c.call('action.observe', { projectId: p.id, operationId: 'run' }); if (run.execution === 'completed') break; await setTimeout(50); }
    assert.equal(run.execution, 'completed');
    hostPid = (await c.call('capability.list', { projectId: p.id })).host.reply.value.host.pid;
    assert.equal(await ctrlBreak(launcher.pid), 0);
    const [code] = await exited;
    assert.equal(code, 0);
    const { shutdown } = JSON.parse(printed.split('\n').find(line => line.includes('"shutdown"')));
    assert.equal(shutdown.length, 1); assert.equal(shutdown[0].confirmed, true);
    assert.throws(() => process.kill(hostPid, 0));
    hostPid = undefined;
  } finally {
    if (launcher.exitCode === null) launcher.kill();
    if (hostPid) { try { process.kill(hostPid); } catch {} }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

// An Agent that started Rho in the background has no console to raise Ctrl+Break on, and Windows has
// no signal it could send instead: rho --stop asks through the state folder, on every platform.
test('rho --stop stops the launcher for that state in order, and a request no service took does not stop the next start', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-stop-'));
  const state = path.join(root, 'state'), cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const rho = (...args) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { timeout: 60000, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  await fs.mkdir(path.join(root, 'projects')); await fs.mkdir(state);
  // Not a state folder: nothing to stop, and no lock file is left in it.
  const none = await rho('--stop', '--state-dir', path.join(root, 'projects'));
  assert.deepEqual([none.code, none.stderr.trim()], [1, `Rho is not running for ${path.join(root, 'projects')}.`]);
  assert.deepEqual(await fs.readdir(path.join(root, 'projects')), []);
  await fs.writeFile(path.join(state, 'service.stop'), '');
  const launcher = spawn(process.execPath, [cli, '--root', path.join(root, 'projects'), '--state-dir', state], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let printed = ''; launcher.stdout.on('data', b => { printed += b; });
  const exited = once(launcher, 'exit');
  let hostPid;
  try {
    for (let i = 0; i < 300 && !printed.includes('\n'); i++) await setTimeout(50);
    const ready = JSON.parse(printed.split('\n')[0]).ready;
    await setTimeout(1500);
    assert.equal(launcher.exitCode, null);
    await assert.rejects(fs.access(path.join(state, 'service.stop')));
    // With a Core selected, the Host a run started stops with it and reports.
    if (ready.startup.core) {
      const c = new CheckedClient({ url: ready.url, token: JSON.parse(await fs.readFile(ready.connectionFile, 'utf8')).token });
      const p = await c.call('project.create', { name: 'p' });
      const script = 'cat("ran\n")\n';
      await fs.writeFile(path.join(p.root, 'run.R'), script);
      await c.call('action.submit', { projectId: p.id, operationId: 'run', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'run.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null } });
      let run;
      for (let i = 0; i < 200; i++) { run = await c.call('action.observe', { projectId: p.id, operationId: 'run' }); if (run.execution === 'completed') break; await setTimeout(50); }
      assert.equal(run.execution, 'completed');
      hostPid = (await c.call('capability.list', { projectId: p.id })).host.reply.value.host.pid;
    }
    const stopped = await rho('--stop', '--state-dir', state);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), { stopped: { state } });
    // It reports once the launcher has ended, so its log is no longer held open.
    assert.throws(() => process.kill(launcher.pid, 0));
    const [code] = await exited;
    assert.equal(code, 0);
    const { shutdown } = JSON.parse(printed.split('\n').find(line => line.includes('"shutdown"')));
    if (hostPid) {
      assert.equal(shutdown.length, 1); assert.equal(shutdown[0].confirmed, true);
      assert.throws(() => process.kill(hostPid, 0));
      hostPid = undefined;
    } else assert.deepEqual(shutdown, []);
    const again = await rho('--stop', '--state-dir', state);
    assert.deepEqual([again.code, again.stderr.trim()], [1, `Rho is not running for ${state}.`]);
  } finally {
    if (launcher.exitCode === null) launcher.kill();
    if (hostPid) { try { process.kill(hostPid); } catch {} }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
