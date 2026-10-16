import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Fault, confined, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
export interface CliResult { exitCode: number; reply: any }
export async function command(binary: string, args: string[], stdin?: string, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0), overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', b => { if (output.length + b.length <= maxBytes) output = Buffer.concat([output, b]); else { overflow = true; child.kill('SIGKILL'); } });
    // Native diagnostics may contain private file names. Keep public structured
    // replies; the service does not log arguments, source, credentials or stderr.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); resolve({ exitCode: 3, reply: { ok: false, error: { kind: 'host_unavailable', message: 'Selected executable is unavailable.' } } }); });
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve({ exitCode: timedOut || overflow ? 4 : code ?? 4, reply: JSON.parse(output.toString('utf8')) }); }
      catch { resolve({ exitCode: timedOut || overflow ? 4 : code === 2 ? 2 : 4, reply: { ok: false, error: { kind: 'reply_unknown', message: 'No complete public CLI reply was obtained.' } } }); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
  });
}
export class CoreBridge {
  private owned = new Map<string, { child: ChildProcess; lines: string[] }>();
  constructor(public binary: string, public rscript: string) {}
  async call(root: string, method: string, caller?: string, requestId?: string, args: string[] = [], code?: string) {
    await confined(root, '.rho', true);
    const flags = [method, '--socket', path.join(root, '.rho/host.sock')];
    if (caller) flags.push('--caller', caller);
    if (requestId) flags.push('--id', requestId);
    return command(this.binary, [...flags, ...args], code);
  }
  async capability(root: string) {
    const result = await this.call(root, 'capability');
    if (result.exitCode === 0) {
      requireThat(result.reply.ok && await fs.realpath(result.reply.value.project_root) === await fs.realpath(root), 'scope', 'Existing Core Host belongs to a different project.');
    }
    return result;
  }
  async ensureOwnedHost(root: string) {
    const before = await this.capability(root);
    if (before.exitCode === 0) {
      const r = before.reply.value.executors.find((x: any) => x.name === 'r');
      requireThat(r && r.program === this.rscript && JSON.stringify(r.args) === '["--vanilla"]', 'condition', 'Existing Host lacks the selected R executor. Its owner must configure it; it will not be replaced.');
      return { ownership: this.owned.has(root) ? 'service' : 'existing-owner', capability: before.reply.value };
    }
    requireThat(before.exitCode === 3 && before.reply.error.kind === 'host_unavailable', 'native', 'Host observation did not establish an available execution boundary.', { cli: before });
    // A stale socket is evidence of an earlier Host. Recovery is an explicit
    // operator lifecycle action, never a side effect of reading or resubmission.
    try { await fs.lstat(path.join(root, '.rho/host.sock')); throw new Fault('condition', 'A prior Host socket remains. Inspect the original requests before explicit Host recovery.'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const socketBytes = Buffer.byteLength(path.join(root, '.rho/host.sock'));
    const maximumBytes = process.platform === 'darwin' ? 103 : 107;
    requireThat(socketBytes <= maximumBytes, 'condition', 'Project path exceeds the selected Core Unix socket path limit. Select a shorter project location before native execution.', { nativeCondition: 'unix-socket-path-bytes', actualBytes: socketBytes, maximumBytes });
    await stateDirectory(root, '.rho');
    const child = spawn(this.binary, ['serve', '--project', root, '--state-dir', path.join(root, '.rho'), '--executor', 'r=' + this.rscript, '--executor-arg', 'r=--vanilla'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const lines: string[] = []; let pending = '';
    child.stdout!.on('data', b => { pending += b.toString(); const chunks = pending.split('\n'); pending = chunks.pop()!; lines.push(...chunks); });
    child.stderr!.resume();
    this.owned.set(root, { child, lines });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Fault('native', 'Core Host startup timed out.')), 5000);
      const onData = () => { if (lines.some(s => { try { return JSON.parse(s).ready; } catch { return false; } })) { clearTimeout(timer); child.stdout!.off('data', onData); resolve(); } };
      child.stdout!.on('data', onData);
      child.once('error', () => { clearTimeout(timer); reject(new Fault('unavailable', 'Core binary could not start.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Fault('native', 'Core Host exited during startup. Existing Hosts were preserved.')); });
    });
    const after = await this.capability(root);
    requireThat(after.exitCode === 0, 'native', 'Core Host did not become available.');
    return { ownership: 'service', capability: after.reply.value };
  }
  async close() {
    const reports = [];
    for (const [root, { child, lines }] of this.owned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise<void>(resolve => { const t = setTimeout(resolve, 8000); t.unref(); })]);
      }
      const report = lines.flatMap(s => { try { const j = JSON.parse(s); return j.shutdown ? [j.shutdown] : []; } catch { return []; } }).at(-1);
      reports.push({ project: path.basename(root), ownership: 'service', shutdown: report ?? null, confirmed: report !== undefined });
    }
    this.owned.clear(); return reports;
  }
}
