import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { runtime } from '../dist/runtime.js';
import { digest } from '@rho-workspace/plugin-contracts';

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
    const d = await call('document.open', { path: 'run.R' });
    const composition = await call('composition.apply', { compositionId: 'work', expectedVersion: 0, changeId: 'create', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['code'] }, { id: 'code', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Code' }, bindings: { document: { documentId: d.id, version: d.version } } }] }] });
    const input = { operationId: 'explicit-once', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'run.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null } };
    const accepted = await call('action.submit', input);
    await call('view.close', { compositionId: 'work', viewId: 'code', expectedVersion: composition.version, changeId: 'close' });
    assert.equal((await call('action.lookup', { operationId: input.operationId })).cancellation, undefined);
    assert.deepEqual((await call('action.submit', input)).core, accepted.core); assert.equal(dispatches, 1);
    for (let i = 0; i < 100; i++) {
      if (await fs.readFile(path.join(p.root, 'entries.txt'), 'utf8').then(s => s === 'entry\n', () => false)) break;
      await setTimeout(20);
    }
    assert.equal(await fs.readFile(path.join(p.root, 'entries.txt'), 'utf8'), 'entry\n');
    const active = await call('action.observe', { operationId: input.operationId });
    rPid = active.native.status.Running?.pid ?? active.native.status.Stopping?.pid;
    assert.ok(rPid);
    const owned = service.bridge.owned.get(p.root);
    assert.ok(owned); const exited = once(owned.child, 'exit'); owned.child.kill('SIGKILL'); await exited;
    const unknown = await call('action.observe', { operationId: input.operationId });
    assert.equal(unknown.execution, 'unknown'); assert.deepEqual(unknown.core, accepted.core);
    assert.equal((await call('action.submit', input)).execution, 'unknown'); assert.equal(dispatches, 1);
    assert.equal((await call('action.list')).length, 1);
    assert.equal(await fs.readFile(path.join(p.root, 'entries.txt'), 'utf8'), 'entry\n');
    // This test owns both the Host and its process group; it does not touch a
    // user's Host/R session. Clean up only that retained native process.
    if (rPid) { try { process.kill(-rPid, 'SIGTERM'); } catch {} rPid = undefined; }
  } finally { if (rPid) { try { process.kill(-rPid, 'SIGTERM'); } catch {} } await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
