import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from './dist/server.js';
import { RhoClient } from './dist/client.js';
import { runtime } from './dist/runtime.js';
const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-fixture-empty-'));
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime(), coreBinary: path.resolve('../Rho-core/target/debug/rho-core'),  }).start();
try {
  const c = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await c.call('project.create', { name: 'fixture-project' });
  const snapshot = await c.call('observation.snapshot', { projectId: p.id });
  const file = 'fixtures/states.json';
  const fixtures = JSON.parse(await fs.readFile(file, 'utf8'));
  const index = fixtures.cases.findIndex(c => c.state === 'empty');
  if (index < 0) throw new Error('empty case not found');
  const previous = fixtures.cases[index];
  // Keep the fixture's own identity stable; refresh only the captured response.
  snapshot.project.id = previous.envelope.value.project.id;
  snapshot.project.root = previous.envelope.value.project.root;
  snapshot.project.openedAt = previous.envelope.value.project.openedAt;
  fixtures.cases[index] = { ...previous, envelope: { apiVersion: '2.0', ok: true, value: snapshot }, provenance: 'Captured from a new project with no Host available; reading starts nothing. Recaptured 2026-10-24 after the observation response became explicit.' };
  await fs.writeFile(file, JSON.stringify(fixtures, null, 2) + '\n');
  console.log('recaptured empty case; keys:', Object.keys(snapshot).join(','));
} finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
