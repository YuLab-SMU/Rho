import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';

// Each case here is a request that actually cost a round trip while an Agent was
// working by hand: a dependency between two fields, a value outside an enum, and a
// method name that is an event rather than an operation.
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-validate-'));
  await fs.mkdir(path.join(root, 'work'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  return { root, service, operator, p, cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('a body missing what another field depends on is told exactly what to add', async () => {
  const f = await fixture();
  try {
    const report = await f.operator.call('protocol.validate', {
      method: 'document.save',
      body: { projectId: f.p.id, documentId: '0'.repeat(64), expectedVersion: 1, expectedDiskDigest: '1'.repeat(64), changeId: 'save-1' }
    });
    assert.equal(report.valid, false);
    const fixes = report.problems.map(problem => problem.fix).join(' ');
    assert.match(fixes, /expectedRevision/);
    assert.ok(report.problems.every(problem => problem.fix && problem.fix.length > 10));
  } finally { await f.cleanup(); }
});

test('a method name that is an event, not an operation, is named as such', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.operator.call('protocol.validate', { method: 'artifact.ready', body: {} }),
      e => e.error.kind === 'not_found' && /protocol.describe/.test(e.error.details?.remedy ?? '')
    );
  } finally { await f.cleanup(); }
});

test('a value outside an allowed set lists the allowed values', async () => {
  const f = await fixture();
  try {
    const report = await f.operator.call('protocol.validate', {
      method: 'session.browser.pair',
      body: { path: 'work', state: 'open' }
    });
    // session.browser.pair takes an optional path only; an extra field is named.
    assert.equal(report.valid, false);
    assert.match(report.problems.map(problem => problem.fix).join(' '), /Remove "state"/);
  } finally { await f.cleanup(); }
});

test('a valid body reports valid and runs nothing', async () => {
  const f = await fixture();
  try {
    const before = await f.operator.call('project.list', {});
    const report = await f.operator.call('protocol.validate', {
      method: 'project.open', body: { path: 'work' }
    });
    assert.deepEqual(report, { method: 'project.open', valid: true, problems: [], requires: ['path'] });
    assert.deepEqual(await f.operator.call('project.list', {}), before, 'validation opens nothing');
  } finally { await f.cleanup(); }
});
