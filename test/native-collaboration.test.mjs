import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { runtime } from '../dist/runtime.js';
import { digest } from '@rho-workspace/plugin-contracts';

// Ends the retained native process this test owns: its process group, or on Windows its process
// tree, waiting there until it is gone, since Windows keeps a folder a process works in.
const end = async pid => {
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGTERM'); } catch {} return; }
  spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return; } await setTimeout(50); }
};
test('explicit r.execute retains one dispatch after close, lost acknowledgement and owned Host loss', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-nat-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime() }).start();
  let dispatches = 0, rPid;
  const native = service.bridge.call.bind(service.bridge);
  service.bridge.call = async (...args) => { if (args[1] === 'submit') dispatches++; return native(...args); };
  try {
    const c = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await c.call('project.create', { name: 'p' });
    const call = (m, b = {}) => c.call(m, { projectId: p.id, ...b });
    const script = 'cat("entry\\n",file="entries.txt",append=TRUE)\nSys.sleep(8)\n';
    await fs.writeFile(path.join(p.root, 'run.R'), script);
    // R on Windows ends the lines it writes to a file with \r\n.
    const entries = () => fs.readFile(path.join(p.root, 'entries.txt'), 'utf8').then(s => s.replace(/\r\n/g, '\n'));
    const d = await call('document.open', { path: 'run.R' });
    const composition = await call('composition.apply', { compositionId: 'work', expectedVersion: 0, changeId: 'create', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['code'] }, { id: 'code', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Code' }, bindings: { document: { documentId: d.id, version: d.version } } }] }] });
    const input = { operationId: 'explicit-once', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'run.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null } };
    const accepted = await call('action.submit', input);
    await call('view.close', { compositionId: 'work', viewId: 'code', expectedVersion: composition.version, changeId: 'close' });
    assert.equal((await call('action.lookup', { operationId: input.operationId })).cancellation, undefined);
    assert.deepEqual((await call('action.submit', input)).core, accepted.core); assert.equal(dispatches, 1);
    for (let i = 0; i < 100; i++) {
      if (await entries().then(s => s === 'entry\n', () => false)) break;
      await setTimeout(20);
    }
    assert.equal(await entries(), 'entry\n');
    const active = await call('action.observe', { operationId: input.operationId });
    rPid = active.native.status.Running?.pid ?? active.native.status.Stopping?.pid;
    assert.ok(rPid);
    // The Host itself is ended: on Windows the owned child is the cmd.exe that waits for it.
    const owned = service.bridge.owned.get(p.root), hostPid = (await call('capability.list')).host.reply.value.host.pid;
    assert.ok(owned); const exited = once(owned.child, 'exit'); process.kill(hostPid, 'SIGKILL'); await exited;
    const unknown = await call('action.observe', { operationId: input.operationId });
    assert.equal(unknown.execution, 'unknown'); assert.deepEqual(unknown.core, accepted.core);
    assert.equal((await call('action.submit', input)).execution, 'unknown'); assert.equal(dispatches, 1);
    assert.equal((await call('action.list')).length, 1);
    assert.equal(await entries(), 'entry\n');
    // This test owns both the Host and its process group; it does not touch a
    // user's Host/R session. Clean up only that retained native process.
    if (rPid) { await end(rPid); rPid = undefined; }
  } finally { if (rPid) await end(rPid); await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

// On Windows cmd.exe starts the Host, so a project path with characters cmd treats specially
// has to reach it unchanged, and the Host stops in order when the service closes.
test('a Host started through cmd.exe runs R in a path cmd treats specially and stops with its report', { timeout: 30000, skip: process.platform !== 'win32' && 'cmd.exe starts the Host only on Windows' }, async () => {
  const base = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-cmd-'));
  const root = path.join(base, 'a & b ^ %OS% !OS! (1) 中文 🧬'); await fs.mkdir(root);
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime() }).start();
  let closed;
  try {
    const c = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await c.call('project.create', { name: 'p' });
    const call = (m, b = {}) => c.call(m, { projectId: p.id, ...b });
    const script = 'writeLines(normalizePath(getwd()), "where.txt")\n';
    await fs.writeFile(path.join(p.root, 'where.R'), script);
    await call('action.submit', { operationId: 'where', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'where.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null } });
    let run;
    for (let i = 0; i < 200; i++) { run = await call('action.observe', { operationId: 'where' }); if (run.execution === 'completed') break; await setTimeout(50); }
    assert.equal(run.execution, 'completed');
    assert.equal((await fs.readFile(path.join(p.root, 'where.txt'), 'utf8')).trim(), p.root);
  } finally { closed = await service.close(); }
  assert.equal(closed.length, 1); assert.equal(closed[0].confirmed, true);
  await fs.rm(base, { recursive: true, force: true });
});
