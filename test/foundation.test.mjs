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
  jsonHostAdapter,
  migrateLegacy,
  migrateQuickStartProjects,
  rollbackMigration,
  cacheReport,
  createTemporaryHome,
  listFoundationProcesses,
  readSecretInput,
  registerFoundationProcess,
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

test('host adapter contract owns, verifies, repairs and removes only marked records', async () => {
  const f = await fixture();
  try {
    await ensureFoundationPaths(f.paths, false);
    const hostFile = path.join(f.paths.hosts, 'cursor', 'mcp.json');
    await fs.mkdir(path.dirname(hostFile), { recursive: true });
    await fs.writeFile(hostFile, JSON.stringify({ servers: [{ id: 'rho', owner: 'rho' }, { id: 'user', owner: 'user' }] }));
    const adapter = jsonHostAdapter('cursor-json-fixture');
    const entry = await adapter.install(f.paths, { host: 'cursor', kind: 'mcp', path: hostFile, owner: 'rho', reversible: true });
    assert.equal(entry.owner, 'rho');
    assert.equal(await adapter.detect(f.paths), true);
    assert.equal((await adapter.listOwned(f.paths)).length, 1);
    assert.equal((await adapter.verify(f.paths, entry)).ok, true);
    assert.deepEqual(await adapter.uninstall(f.paths, entry), { removed: true });
    assert.deepEqual(JSON.parse(await fs.readFile(hostFile, 'utf8')), { servers: [{ id: 'user', owner: 'user' }] });
    await fs.writeFile(hostFile, JSON.stringify({ servers: [{ id: 'rho-again', owner: 'rho' }, { id: 'user', owner: 'user' }] }));
    assert.deepEqual(await adapter.repair(f.paths, entry), { repaired: true, detail: 'Host cleanup removed 1 owned record(s).' });
  } finally { await f.cleanup(); }
});

test('doctor repair retries pending host cleanup and keeps unavailable files pending', async () => {
  const f = await fixture();
  try {
    await ensureFoundationPaths(f.paths, false);
    const good = path.join(f.paths.hosts, 'workbuddy', 'settings.json'), bad = path.join(f.paths.hosts, 'cursor', 'broken.json');
    await fs.mkdir(path.dirname(good), { recursive: true });
    await fs.mkdir(path.dirname(bad), { recursive: true });
    await fs.writeFile(good, JSON.stringify({ rho: { owner: 'rho' }, user: { owner: 'user' } }));
    await fs.writeFile(bad, '{broken\n');
    const first = await hostCleanup(f.paths);
    assert.equal(first.removed, 1);
    assert.equal(first.skipped, 1);
    assert.equal((await fs.readFile(path.join(f.paths.data, 'pending-host-cleanup.json'), 'utf8')).includes('broken.json'), true);
    const repaired = await repairFoundation(f.paths);
    assert.ok(repaired.repaired.includes('hosts-pending'));
    assert.equal(await fs.access(path.join(f.paths.data, 'pending-host-cleanup.json')).then(() => true, () => false), true);
    await fs.writeFile(bad, JSON.stringify({ rho: { owner: 'rho' }, user: { owner: 'user' } }));
    const recovered = await repairFoundation(f.paths);
    assert.ok(recovered.repaired.includes('hosts'));
    assert.equal(await fs.access(path.join(f.paths.data, 'pending-host-cleanup.json')).then(() => true, () => false), false);
  } finally { await f.cleanup(); }
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

test('quick start silently adopts projects from the legacy home root', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.paths.home, 'Rho', 'projects'), legacy = path.join(source, 'legacy-project');
    await fs.mkdir(path.join(legacy, '.rho', 'rho'), { recursive: true });
    await fs.writeFile(path.join(legacy, 'README.md'), 'legacy project\n');
    const result = await migrateQuickStartProjects({ ...f.paths, projects: path.join(f.paths.home, '.rho') });
    assert.deepEqual(result?.moved, ['legacy-project']);
    assert.deepEqual(result?.conflicts, []);
    assert.equal(await fs.readFile(path.join(f.paths.home, '.rho', 'legacy-project', 'README.md'), 'utf8'), 'legacy project\n');
    assert.equal(await fs.access(legacy).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(f.paths.state, 'quick-start-project-migration.json')).then(() => true, () => false), true);
    const again = await migrateQuickStartProjects({ ...f.paths, projects: path.join(f.paths.home, '.rho') });
    assert.equal(again?.moved.length, 0);
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
    assert.ok(refused.skipped.some(file => file.split(path.sep).join('/').endsWith('/legacy-import/Rho/state')));
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
  const home = path.resolve('rho-platform-home'), configHome = path.resolve('xdg-config'), stateHome = path.resolve('xdg-state'), cacheHome = path.resolve('xdg-cache'), runtimeHome = path.resolve('xdg-runtime'), appData = path.resolve('appdata'), localAppData = path.resolve('localappdata');
  const darwin = foundationPaths({ RHO_PLATFORM: 'darwin', RHO_HOME: home });
  const linux = foundationPaths({ RHO_PLATFORM: 'linux', RHO_HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, XDG_CACHE_HOME: cacheHome, XDG_RUNTIME_DIR: runtimeHome });
  const windows = foundationPaths({ RHO_PLATFORM: 'win32', RHO_HOME: home, APPDATA: appData, LOCALAPPDATA: localAppData });
  assert.equal(darwin.config, path.join(home, 'Library', 'Application Support', 'Rho'));
  assert.equal(linux.config, path.join(configHome, 'rho'));
  assert.equal(linux.state, path.join(stateHome, 'rho'));
  assert.equal(windows.config, path.join(appData, 'Rho'));
  assert.equal(windows.state, path.join(localAppData, 'Rho', 'state'));
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
    const shim = path.join(f.root, 'bin', process.platform === 'win32' ? 'rho.cmd' : 'rho');
    const unrelated = path.join(f.root, 'bin', 'other');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(path.dirname(shim), { recursive: true });
    await fs.writeFile(target, '#!/usr/bin/env node\n');
    await fs.symlink(target, unrelated);
    await writeFoundationJson(f.paths.manifest, { schemaVersion: 1, product: 'Rho', installationId: 'fixture', paths: {}, bins: [{ name: 'rho', path: shim, target }], profiles: {}, hosts: [], operations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const before = await repairFoundation(f.paths);
    assert.ok(before.repaired.includes('bin:rho'));
    const targetReal = await fs.realpath(target);
    if (process.platform === 'win32') assert.match(await fs.readFile(shim, 'utf8'), /cli\.js/);
    else assert.equal(await fs.realpath(shim), targetReal);
    assert.equal(await fs.realpath(unrelated), targetReal);
  } finally { await f.cleanup(); }
});

test('temporary fake HOME copies only an allowlist and process records are enumerable', async () => {
  const f = await fixture();
  try {
    await ensureFoundationPaths(f.paths, false);
    const source = path.join(f.root, 'source-home');
    await fs.mkdir(path.join(source, '.config'), { recursive: true });
    await fs.writeFile(path.join(source, '.config', 'settings.json'), '{"theme":"dark"}\n');
    await fs.writeFile(path.join(source, '.config', 'connection.json'), '{"token":"secret"}\n');
    const fake = await createTemporaryHome(f.paths, 'fake-home', 'foundation-test', source, ['.config/settings.json', '.config/connection.json'], 60_000);
    assert.deepEqual(fake.copied, ['.config/settings.json']);
    assert.deepEqual(fake.skipped, ['.config/connection.json']);
    assert.equal(await fs.access(path.join(fake.home, '.config', 'connection.json')).then(() => true, () => false), false);
    await registerFoundationProcess(f.paths, { pid: process.pid, kind: 'worker', command: process.execPath, workerDir: fake.home });
    assert.equal((await listFoundationProcesses(f.paths)).some(record => record.pid === process.pid && record.kind === 'worker'), true);
  } finally { await f.cleanup(); }
});

test('secret file input requires private mode and never returns a command-line value', async () => {
  const f = await fixture();
  try {
    const secret = path.join(f.root, 'secret');
    await fs.writeFile(secret, 'token\n', { mode: 0o600 });
    const value = await readSecretInput('RHO_API_KEY', { RHO_API_KEY_FILE: secret });
    assert.deepEqual(value, { value: 'token', source: 'RHO_API_KEY_FILE', path: secret });
    if (process.platform !== 'win32') {
      await fs.chmod(secret, 0o644);
      await assert.rejects(readSecretInput('RHO_API_KEY', { RHO_API_KEY_FILE: secret }), /private file/);
    }
  } finally { await f.cleanup(); }
});
