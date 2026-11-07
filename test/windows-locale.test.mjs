import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { runtime } from '../dist/runtime.js';
import { CheckedClient } from './checked-client.mjs';
import { digest } from '@rho-workspace/plugin-contracts';

const native = await runtime();
// An Agent's Git Bash gives Rho LC_CTYPE=C.UTF-8, which Windows does not have: a managed run's R
// warned at startup and printed "3 × 2" as "3 <U+00D7> 2".
test('on Windows a managed run started under a POSIX C.UTF-8 locale prints text as it was written', { timeout: 60000, skip: process.platform !== 'win32' ? 'only Windows has no C.UTF-8' : !native.coreBinary && 'a managed run needs Core' }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'rho-locale-')));
  const saved = process.env.LC_CTYPE;
  process.env.LC_CTYPE = 'C.UTF-8';
  await fs.mkdir(path.join(root, 'projects'));
  const service = await new RhoService({ root: path.join(root, 'projects'), stateDir: path.join(root, 'state'), ...native }).start();
  try {
    const c = new CheckedClient({ url: service.url, token: JSON.parse(await fs.readFile(path.join(root, 'state', 'connection.json'), 'utf8')).token });
    const p = await c.call('project.create', { name: 'p' });
    const script = 'cat("3 \\u00d7 2", l10n_info()$`UTF-8`, "\\n")\n';
    await fs.writeFile(path.join(p.root, 'run.R'), script);
    await c.call('action.submit', { projectId: p.id, operationId: 'run', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'run.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null } });
    let run;
    for (let i = 0; i < 400; i++) { run = await c.call('action.observe', { projectId: p.id, operationId: 'run' }); if (run.execution === 'completed') break; await setTimeout(50); }
    assert.equal(run.execution, 'completed');
    const read = async stream => (await c.call('action.output', { projectId: p.id, operationId: 'run', stream, offset: 0 })).reply.value.text;
    assert.equal(await read('stdout'), '3 × 2 TRUE \r\n');
    assert.equal(await read('stderr'), '', 'R starts without a locale warning');
  } finally {
    if (saved === undefined) delete process.env.LC_CTYPE; else process.env.LC_CTYPE = saved;
    await service.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
