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
