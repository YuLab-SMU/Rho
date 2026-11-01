import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Fault, confined, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
export interface CliResult { exitCode: number; reply: any }
// Results of a CLI that could not be started at all, which trying again does not change.
const unstarted = new WeakSet<CliResult>();
export async function command(binary: string, args: string[], stdin?: string, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = Buffer.alloc(0), overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', b => { if (output.length + b.length <= maxBytes) output = Buffer.concat([output, b]); else { overflow = true; child.kill('SIGKILL'); } });
    // Native diagnostics may contain private file names. Keep public structured
    // replies; the service does not log arguments, source, credentials or stderr.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); const result = { exitCode: 3, reply: { ok: false, error: { kind: 'host_unavailable', message: 'Selected executable is unavailable.' } } }; unstarted.add(result); resolve(result); });
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve({ exitCode: timedOut || overflow ? 4 : code ?? 4, reply: JSON.parse(output.toString('utf8')) }); }
      catch { resolve({ exitCode: timedOut || overflow ? 4 : code === 2 ? 2 : 4, reply: { ok: false, error: { kind: 'reply_unknown', message: 'No complete public CLI reply was obtained.' } } }); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
  });
}
// On Windows a Host serves a named pipe, not a socket file in its state folder. Its name hashes
// that folder's path, so it is known from the ready line of a Host this service started. A Host
// started before (by this service before a restart, or by the person) is found among the pipes
// Core Hosts serve, by the project its capability names; at most maxPipes are asked.
const windows = process.platform === 'win32', pipeName = /^rho-core\.[0-9a-f]{16}\.host\.sock$/, maxPipes = 64;
// A Windows Host serves one pipe instance at a time: until it makes the next one after taking a
// connection, another client finds the pipe busy, for longer when the machine is busy. Core then
// reports the call as not delivered (exit 3), with nothing done, and says to try again; a call
// on a pipe is tried up to five times, 20 to 80 ms apart, unless the CLI could not start.
async function delivered(run: () => Promise<CliResult>) {
  let result = await run();
  for (let attempt = 1; attempt < 5 && result.exitCode === 3 && !unstarted.has(result); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20 * attempt));
    result = await run();
  }
  return result;
}
// Windows has no signal for a process on another console, and a Host takes Ctrl+Break as an end
// without its report. A Host started here stops in order, as on SIGTERM, when this file appears.
const stopFile = (root: string) => path.join(root, '.rho', 'host.stop');
// On Windows Node puts the processes it starts in a job that ends them when it ends, and a Host is
// to outlive this service there too. What those processes start is outside the job, so cmd.exe
// starts the Host and waits for it. cmd's console has no window, and the Host's runs share it.
// Each argument reaches cmd as a variable inside quotes, where neither its expansion nor & ^ ( )
// apply, and a Windows path holds no quote; a backslash that would end up before the closing
// quote (a drive root) is doubled, so it does not escape it.
function startOnWindows(binary: string, args: string[], root: string) {
  const values = [binary, ...args].map(value => value.endsWith('\\') ? value + '\\' : value);
  const line = values.map((_, i) => `"%RHO_HOST_ARG${i}%"`).join(' ');
  const env = { ...process.env, RHO_CORE_STOP_FILE: stopFile(root), ...Object.fromEntries(values.map((value, i) => ['RHO_HOST_ARG' + i, value])) };
  return spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/v:off', '/s', '/c', `"${line}"`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true, env });
}
export class CoreBridge {
  private owned = new Map<string, { child: ChildProcess; lines: string[] }>();
  private pipes = new Map<string, string>();
  constructor(public binary: string | undefined, public rscript: string) {}
  async call(root: string, method: string, caller?: string, requestId?: string, args: string[] = [], code?: string) {
    if (!this.binary) return { exitCode: 3, reply: { ok: false, error: { kind: 'core_unavailable', message: 'Core is not installed or selected. Native Agent tools remain available; select Core for managed runs or Host activity.' } } };
    await confined(root, '.rho', true);
    const pipe = this.pipes.get(root) ?? (windows ? await this.findPipe(root) : undefined);
    const flags = [method, '--socket', pipe ?? path.join(root, '.rho/host.sock')];
    if (caller) flags.push('--caller', caller);
    if (requestId) flags.push('--id', requestId);
    const run = () => command(this.binary!, [...flags, ...args], code);
    return pipe ? delivered(run) : run();
  }
  private async findPipe(root: string) {
    const names = await fs.readdir('\\\\.\\pipe\\').then(all => all.filter(name => pipeName.test(name)).slice(0, maxPipes), () => []);
    const project = await fs.realpath(root);
    for (const name of names) {
      const pipe = '\\\\.\\pipe\\' + name, found = await delivered(() => command(this.binary!, ['capability', '--socket', pipe]));
      const named = found.exitCode === 0 ? found.reply.value?.project_root : undefined;
      if (typeof named === 'string' && await fs.realpath(named).catch(() => null) === project) { this.pipes.set(root, pipe); return pipe; }
    }
    return undefined;
  }
  async capability(root: string) {
    const result = await this.call(root, 'capability');
    if (result.exitCode === 0) {
      requireThat(result.reply.ok && await fs.realpath(result.reply.value.project_root) === await fs.realpath(root), 'scope', 'Existing Core Host belongs to a different project.');
    }
    return result;
  }
  async ensureOwnedHost(root: string) {
    requireThat(this.binary, 'unavailable', 'This managed operation needs Core. Select it with --core or RHO_CORE_BINARY. Native Agent work does not need a Host.');
    const before = await this.capability(root);
    if (before.exitCode === 0) {
      const r = before.reply.value.executors.find((x: any) => x.name === 'r');
      requireThat(r && r.program === this.rscript && JSON.stringify(r.args) === '["--vanilla"]', 'condition', 'Existing Host lacks the selected R executor. Its owner must configure it; it will not be replaced.');
      return { ownership: this.owned.has(root) ? 'service' : 'existing-owner', capability: before.reply.value };
    }
    requireThat(before.exitCode === 3 && before.reply.error.kind === 'host_unavailable', 'native', 'Host observation did not establish an available execution boundary.', { cli: before });
    // A stale socket is evidence of an earlier Host. Recovery is an explicit
    // operator lifecycle action, never a side effect of reading or resubmission.
    // A named pipe leaves nothing behind and has no such length limit.
    if (!windows) {
      try { await fs.lstat(path.join(root, '.rho/host.sock')); throw new Fault('condition', 'A prior Host socket remains. Inspect the original requests before explicit Host recovery.'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      const socketBytes = Buffer.byteLength(path.join(root, '.rho/host.sock'));
      const maximumBytes = process.platform === 'darwin' ? 103 : 107;
      requireThat(socketBytes <= maximumBytes, 'condition', 'Project path exceeds the selected Core Unix socket path limit. Select a shorter project location before native execution.', { nativeCondition: 'unix-socket-path-bytes', actualBytes: socketBytes, maximumBytes });
    }
    await stateDirectory(root, '.rho');
    const args = ['serve', '--project', root, '--state-dir', path.join(root, '.rho'), '--executor', 'r=' + this.rscript, '--executor-arg', 'r=--vanilla'];
    // A stop file left from an earlier Host would stop this one at once.
    if (windows) await fs.rm(stopFile(root), { force: true });
    const child = windows ? startOnWindows(this.binary, args, root) : spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const lines: string[] = []; let pending = '';
    child.stdout!.on('data', b => { pending += b.toString(); const chunks = pending.split('\n'); pending = chunks.pop()!; lines.push(...chunks); });
    child.stderr!.resume();
    this.owned.set(root, { child, lines });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Fault('native', 'Core Host startup timed out.')), 5000);
      const onData = () => {
        const ready = lines.map(s => { try { return JSON.parse(s).ready; } catch { return undefined; } }).find(Boolean);
        if (!ready) return;
        if (windows && typeof ready.socket === 'string') this.pipes.set(root, ready.socket);
        clearTimeout(timer); child.stdout!.off('data', onData); resolve();
      };
      child.stdout!.on('data', onData);
      child.once('error', () => { clearTimeout(timer); reject(new Fault('unavailable', 'Core binary could not start.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Fault('native', 'Core Host exited during startup. Existing Hosts were preserved.')); });
    });
    const after = await this.capability(root);
    requireThat(after.exitCode === 0, 'native', 'Core Host did not become available.');
    return { ownership: 'service', capability: after.reply.value };
  }
  // A Host stops in order on SIGTERM, or on Windows on its stop file, and reports how its runs
  // ended. There the child is cmd.exe, which ends when the Host does.
  async close() {
    const reports = [];
    for (const [root, { child, lines }] of this.owned) {
      if (child.exitCode === null && child.signalCode === null) {
        if (windows) await fs.writeFile(stopFile(root), '', { flag: 'wx' }).catch(() => {});
        else child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise<void>(resolve => { const t = setTimeout(resolve, 8000); t.unref(); })]);
      }
      if (windows) await fs.rm(stopFile(root), { force: true }).catch(() => {});
      const report = lines.flatMap(s => { try { const j = JSON.parse(s); return j.shutdown ? [j.shutdown] : []; } catch { return []; } }).at(-1);
      reports.push({ project: path.basename(root), ownership: 'service', shutdown: report ?? null, confirmed: report !== undefined });
    }
    this.owned.clear(); this.pipes.clear(); return reports;
  }
}
