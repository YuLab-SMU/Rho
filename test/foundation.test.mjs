import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  doctorFoundation,
  ensureFoundationPaths,
  foundationPaths,
  hostCleanup,
  hostScan,
  migrateLegacy,
  rollbackMigration,
  cacheReport,
  pruneTemporary,
  repairFoundation,
  temporaryDirectory,
  temporaryReport,
  writeFoundationJson,
} from '../dist/foundation.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-foundation-test-'));
  const env = {
    ...process.env,
    RHO_HOME: path.join(root, 'home'),
    RHO_CONFIG_DIR: path.join(root, 'config'),
    RHO_DATA_DIR: path.join(root, 'data'),
    RHO_STATE_DIR: path.join(root, 'state'),
    RHO_RUNTIME_DIR: path.join(root, 'runtime'),
    RHO_CACHE_DIR: path.join(root, 'cache'),
    RHO_LOG_DIR: path.join(root, 'logs'),
    RHO_PROJECTS_DIR: path.join(root, 'projects'),
    RHO_HOST_ROOT: path.join(root, 'host'),
  };
  return { root, paths: foundationPaths(env), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('foundation paths, temp registry and host cleanup stay inside explicit roots', async () => {
  const f = await fixture();
  const oldTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = path.join(f.root, 'tmp');
    await fs.mkdir(process.env.TMPDIR, { recursive: true });
    await ensureFoundationPaths(f.paths);
    assert.equal(f.paths.home.startsWith(f.root), true);
    const temporary = await temporaryDirectory(f.paths, 'test', 'foundation-test', -1);
    await fs.writeFile(path.join(temporary, 'output.txt'), 'retained output\n');
    const before = await temporaryReport(f.paths);
    assert.equal(before.entries, 1);
    const pruned = await pruneTemporary(f.paths);
    assert.deepEqual(pruned.removed.length, 1);
    const hostFile = path.join(f.paths.hosts, 'workbuddy', 'settings.json');
    await fs.mkdir(path.dirname(hostFile), { recursive: true });
    await fs.writeFile(hostFile, JSON.stringify({ rho: { owner: 'rho', path: '/owned' }, user: { owner: 'user' }, list: [{ id: 'rho', owner: 'rho' }, { id: 'user', owner: 'user' }] }));
    assert.equal((await hostScan(f.paths)).count, 2);
    const cleanup = await hostCleanup(f.paths);
    assert.equal(cleanup.removed, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(hostFile, 'utf8')), { user: { owner: 'user' }, list: [{ id: 'user', owner: 'user' }] });
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    await f.cleanup();
  }
});

test('legacy migration dry-run is read-only and apply preserves the source tree', async () => {
  const f = await fixture();
  try {
    const legacyState = path.join(f.paths.home, 'Rho', 'state');
    await fs.mkdir(legacyState, { recursive: true });
    await fs.writeFile(path.join(legacyState, 'projects.json'), '[{"id":"legacy"}]\n');
    await fs.mkdir(path.join(f.paths.home, '.rho-app'), { recursive: true });
    await fs.writeFile(path.join(f.paths.home, '.rho-app', 'package.json'), '{"version":"0.5.10"}\n');
    const dry = await migrateLegacy(f.paths, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(await fs.access(f.paths.state).then(() => true, () => false), false);
    const applied = await migrateLegacy(f.paths, {});
    assert.equal(applied.dryRun, false);
    assert.equal(await fs.readFile(path.join(f.paths.state, 'legacy-import', 'Rho', 'state', 'projects.json'), 'utf8'), '[{"id":"legacy"}]\n');
    assert.equal(await fs.readFile(path.join(legacyState, 'projects.json'), 'utf8'), '[{"id":"legacy"}]\n');
  } finally { await f.cleanup(); }
});

test('migration rollback removes only unchanged imported entries and keeps the legacy source', async () => {
  const f = await fixture();
  try {
    const legacyState = path.join(f.paths.home, 'Rho', 'state');
    await fs.mkdir(legacyState, { recursive: true });
    await fs.writeFile(path.join(legacyState, 'projects.json'), '[{"id":"legacy"}]\n');
    const applied = await migrateLegacy(f.paths, {});
    const imported = path.join(f.paths.state, 'legacy-import', 'Rho');
    assert.equal(await fs.access(imported).then(() => true, () => false), true);
    const rolled = await rollbackMigration(f.paths, applied.operationId);
    assert.deepEqual(rolled.skipped, []);
    assert.equal(await fs.access(imported).then(() => true, () => false), false);
    assert.equal(await fs.readFile(path.join(legacyState, 'projects.json'), 'utf8'), '[{"id":"legacy"}]\n');
    const changed = await migrateLegacy(f.paths, {});
    const importedFile = path.join(f.paths.state, 'legacy-import', 'Rho', 'state', 'projects.json');
    await fs.writeFile(importedFile, 'changed\n');
    const refused = await rollbackMigration(f.paths, changed.operationId);
    assert.ok(refused.skipped.some(file => file.endsWith('/legacy-import/Rho/state')));
    assert.equal(await fs.readFile(importedFile, 'utf8'), 'changed\n');
  } finally { await f.cleanup(); }
});

test('doctor reads a disposable root without creating it', async () => {
  const f = await fixture();
  try {
    const report = await doctorFoundation(f.paths);
    assert.equal(report.paths.paths.state.exists, false);
    assert.equal(await fs.access(f.paths.state).then(() => true, () => false), false);
    assert.ok(report.checks.some(check => check.id === 'manifest'));
  } finally { await f.cleanup(); }
});

test('path resolver follows platform data conventions', () => {
  const home = '/tmp/rho-platform-home';
  const darwin = foundationPaths({ RHO_PLATFORM: 'darwin', RHO_HOME: home });
  const linux = foundationPaths({ RHO_PLATFORM: 'linux', RHO_HOME: home, XDG_CONFIG_HOME: '/tmp/xdg-config', XDG_STATE_HOME: '/tmp/xdg-state', XDG_CACHE_HOME: '/tmp/xdg-cache', XDG_RUNTIME_DIR: '/tmp/xdg-runtime' });
  const windows = foundationPaths({ RHO_PLATFORM: 'win32', RHO_HOME: home, APPDATA: '/tmp/appdata', LOCALAPPDATA: '/tmp/localappdata' });
  assert.match(darwin.config, /Library\/Application Support\/Rho$/);
  assert.equal(linux.config, '/tmp/xdg-config/rho');
  assert.equal(linux.state, '/tmp/xdg-state/rho');
  assert.equal(windows.config, '/tmp/appdata/Rho');
  assert.equal(windows.state, '/tmp/localappdata/Rho/state');
});

test('cache reporting stays below the temporary registry and does not count temporary files', async () => {
  const f = await fixture();
  try {
    await ensureFoundationPaths(f.paths);
    await fs.writeFile(path.join(f.paths.cache, 'rebuildable.json'), '{}\n');
    await temporaryDirectory(f.paths, 'test', 'foundation-test', 60_000);
    const cache = await cacheReport(f.paths);
    assert.equal(cache.entries, 1);
    assert.equal(cache.files[0].path, 'rebuildable.json');
  } finally { await f.cleanup(); }
});

test('doctor repair reconciles a missing manifest-owned shim without touching an unrelated shim', async () => {
  const f = await fixture();
  try {
    await ensureFoundationPaths(f.paths, false);
    const packageRoot = path.join(f.root, 'package');
    const target = path.join(packageRoot, 'dist', 'cli.js');
    const shim = path.join(f.root, 'bin', 'rho');
    const unrelated = path.join(f.root, 'bin', 'other');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(path.dirname(shim), { recursive: true });
    await fs.writeFile(target, '#!/usr/bin/env node\n');
    await fs.symlink(target, unrelated);
    await writeFoundationJson(f.paths.manifest, { schemaVersion: 1, product: 'Rho', installationId: 'fixture', paths: {}, bins: [{ name: 'rho', path: shim, target }], profiles: {}, hosts: [], operations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const before = await repairFoundation(f.paths);
    assert.ok(before.repaired.includes('bin:rho'));
    const targetReal = await fs.realpath(target);
    assert.equal(await fs.realpath(shim), targetReal);
    assert.equal(await fs.realpath(unrelated), targetReal);
  } finally { await f.cleanup(); }
});
