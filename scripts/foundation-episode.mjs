#!/usr/bin/env node
// Reproduce the installation and ownership failures in a disposable HOME and npm prefix.
// The script never resolves a path from the operator's real HOME after the fixture starts.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.resolve(process.env.RHO_FOUNDATION_EPISODE ?? path.join(repo, 'work', 'foundation-episode'));
const cli = path.join(repo, 'dist', 'cli.js');
const preserve = process.env.RHO_FOUNDATION_KEEP === '1';
const now = () => new Date().toISOString();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function command(program, args, cwd, env, timeoutMs = 180000) {
  const startedAt = now();
  const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const code = await new Promise(resolve => {
    child.once('error', () => resolve(-1));
    child.once('close', value => resolve(value ?? 1));
  });
  clearTimeout(timer);
  return { program, args, cwd, startedAt, endedAt: now(), code, stdout: stdout.slice(-20000), stderr };
}

async function record(report, name, run, check = undefined) {
  const result = await run();
  const item = { name, result, ...(check ? check(result) : {}) };
  report.steps.push(item);
  return item;
}

async function tree(root, maximum = 2000) {
  const entries = [];
  async function visit(folder, relative = '') {
    if (entries.length >= maximum) return;
    for (const name of (await fs.readdir(folder, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= maximum) return;
      const file = path.join(folder, name.name), rel = path.join(relative, name.name);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat) continue;
      entries.push({ path: rel.split(path.sep).join('/'), kind: name.isDirectory() ? 'directory' : name.isSymbolicLink() ? 'symlink' : 'file', bytes: name.isFile() ? stat.size : undefined, mode: stat.mode & 0o777 });
      if (name.isDirectory()) await visit(file, rel);
    }
  }
  await visit(root);
  return { entries, truncated: entries.length >= maximum };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rho-foundation-'));
const fixtureHome = path.join(root, 'home');
const npmPrefix = path.join(root, 'npm-prefix');
const npmCache = path.join(root, 'npm-cache');
const tempRoot = path.join(root, 'tmp');
const projects = path.join(fixtureHome, 'Rho', 'projects');
const state = path.join(fixtureHome, 'Rho', 'state');
const hostRoot = path.join(fixtureHome, 'host-config');
await fs.mkdir(fixtureHome, { recursive: true });
await fs.mkdir(npmPrefix, { recursive: true });
await fs.mkdir(npmCache, { recursive: true });
await fs.mkdir(tempRoot, { recursive: true });

const env = {
  ...process.env,
  HOME: fixtureHome,
  USERPROFILE: fixtureHome,
  TMPDIR: tempRoot,
  TMP: tempRoot,
  TEMP: tempRoot,
  npm_config_cache: npmCache,
  npm_config_prefix: npmPrefix,
  RHO_RUNNING_DIR: path.join(fixtureHome, 'Rho', 'running'),
};
for (const key of ['RHO_DATA_ROOT', 'RHO_CONFIG_DIR', 'RHO_RUNTIME_DIR', 'RHO_CACHE_DIR', 'RHO_LOG_DIR', 'RHO_PROJECTS_DIR']) delete env[key];

const report = {
  schemaVersion: 1,
  episode: 'foundation-f0',
  startedAt: now(),
  platform: process.platform + '-' + process.arch,
  node: process.version,
  repository: repo,
  fixture: { root, home: fixtureHome, npmPrefix, npmCache, tempRoot, projects, state, hostRoot },
  steps: [],
  observations: [],
  status: 'running',
};

try {
  await fs.mkdir(projects, { recursive: true });
  const artifactDir = path.join(root, 'artifact');
  await fs.mkdir(artifactDir, { recursive: true });
  const packed = await record(report, 'pack-current-source', () => command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactDir], repo, env), result => ({ passed: result.code === 0 }));
  assert.equal(packed.result.code, 0, packed.result.stderr || packed.result.stdout);
  const packedFilename = (await fs.readdir(artifactDir)).find(name => name.endsWith('.tgz'));
  assert.ok(packedFilename, 'npm pack produced no tarball');
  const artifact = path.join(artifactDir, packedFilename);
  report.artifact = { path: artifact, sha256: sha256(await fs.readFile(artifact)), filename: packedFilename };

  const install = await record(report, 'npm-install-global-in-isolated-prefix', () => command('npm', ['install', '--global', '--prefix', npmPrefix, '--ignore-scripts', '--no-audit', '--no-fund', artifact], root, env), result => ({ passed: result.code === 0 }));
  assert.equal(install.result.code, 0, install.result.stderr || install.result.stdout);
  const packageRoot = path.join(npmPrefix, 'lib', 'node_modules', '@rho-workspace', 'rho');
  const binRoot = path.join(npmPrefix, 'bin');
  const installedPackage = await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8');
  const installedVersion = JSON.parse(installedPackage).version;
  report.installation = { packageRoot, binRoot, version: installedVersion, packageTree: await tree(packageRoot), binTree: await tree(binRoot) };

  const packageScope = path.dirname(packageRoot);
  const stagingCollision = path.join(packageScope, '.rho-R1eVz1mA');
  await fs.mkdir(stagingCollision, { recursive: true });
  await fs.writeFile(path.join(stagingCollision, 'occupied.txt'), 'fixture keeps npm rename target occupied\n');
  const renameProbe = await record(report, 'occupied-npm-rename-target', async () => {
    try {
      await fs.rename(packageRoot, stagingCollision);
      return { code: 0, stdout: 'rename unexpectedly succeeded', stderr: '' };
    } catch (error) {
      return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), errorCode: error?.code, syscall: error?.syscall };
    }
  }, result => ({ passed: result.code !== 0 && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(result.errorCode) }));
  assert.equal(renameProbe.passed, true, JSON.stringify(renameProbe));
  report.observations.push({ id: 'A1-A2', result: 'An occupied npm staging target blocks a package-directory rename and leaves the package tree and target as two independent objects.' });

  const halfPrefix = path.join(root, 'half-uninstall-prefix');
  const halfPackage = path.join(halfPrefix, 'lib', 'node_modules', '@rho-workspace', 'rho');
  const halfBin = path.join(halfPrefix, 'bin');
  await fs.mkdir(path.dirname(halfPackage), { recursive: true });
  await fs.cp(packageRoot, halfPackage, { recursive: true, dereference: true });
  await fs.mkdir(halfBin, { recursive: true });
  for (const name of ['rho', 'rho-ui', 'rho-screen-check']) {
    const target = path.relative(halfBin, name === 'rho' ? path.join(halfPackage, 'dist', 'cli.js') : name === 'rho-ui' ? path.join(halfPackage, 'scripts', 'ui-plugin.mjs') : path.join(halfPackage, 'scripts', 'screen-check.mjs'));
    await fs.symlink(target, path.join(halfBin, name));
  }
  await fs.rm(halfPackage, { recursive: true, force: true });
  report.halfUninstall = { packageRoot: halfPackage, binRoot: halfBin, packageExists: await fs.access(halfPackage).then(() => true, () => false), binTree: await tree(halfBin) };
  report.observations.push({ id: 'A3-A4', result: 'A synthetic interrupted removal leaves all three executable shims while the package directory is gone. The fixture records the split state for doctor and manifest checks.' });

  const legacyProject = path.join(projects, 'legacy-project');
  await fs.mkdir(path.join(legacyProject, '.rho', 'rho', 'operations'), { recursive: true });
  await writeJson(path.join(legacyProject, '.rho', 'rho', 'service.lock'), { legacy: true, pid: 999999, createdAt: now() });
  await writeJson(path.join(fixtureHome, 'Rho', 'state', 'projects.json'), [{ id: 'legacy-project', root: legacyProject, openedAt: now() }]);
  await writeJson(path.join(fixtureHome, 'Rho', 'state', 'principals.json'), [{ id: 'operator', tokenHash: 'legacy-token' }]);
  await writeJson(path.join(fixtureHome, 'Rho', 'state', 'connection.json'), { url: 'http://127.0.0.1:63081', pid: 999999 });
  await fs.writeFile(path.join(fixtureHome, 'Rho', 'state', 'rho-service.log'), 'legacy service\n');
  await fs.writeFile(path.join(fixtureHome, 'Rho', 'state', 'service.lock'), '');
  await fs.mkdir(path.join(fixtureHome, 'rho-local-play', 'state'), { recursive: true });
  await fs.writeFile(path.join(fixtureHome, 'rho-local-play', 'state', 'trial.json'), '{}\n');
  await writeJson(path.join(fixtureHome, '.rho-app', 'package.json'), { name: '@rho-workspace/rho', version: '0.5.10' });
  await fs.writeFile(path.join(fixtureHome, '.rho-app', 'package-lock.json'), '{}\n');
  await fs.mkdir(path.join(fixtureHome, '.rho-app', 'node_modules'), { recursive: true });
  await writeJson(path.join(fixtureHome, '.rho-state', 'principals.json'), [{ id: 'legacy' }]);
  await writeJson(path.join(fixtureHome, '.rho-state', 'projects.json'), []);
  await fs.writeFile(path.join(fixtureHome, 'Rho', 'tutorial-state-0.5.10-final'), 'legacy tutorial\n');
  report.legacy = await tree(fixtureHome);
  report.observations.push({ id: 'B10-B21', result: 'Legacy home roots, mixed service state, project-nested locks and copied tutorial state are present in one disposable tree for migration.' });

  await fs.mkdir(path.join(hostRoot, 'workbuddy'), { recursive: true });
  await writeJson(path.join(hostRoot, 'workbuddy', 'settings.json'), { settings: { theme: 'user', rho: { owner: 'rho', version: installedVersion } } });
  await writeJson(path.join(hostRoot, 'workbuddy', 'skills-installed-store.json'), { skills: [{ id: 'rho', owner: 'rho', source: packageRoot }, { id: 'user-skill', owner: 'user' }] });
  await writeJson(path.join(hostRoot, 'workbuddy', 'experts.json'), { experts: [{ id: 'rho', owner: 'rho' }, { id: 'user-expert', owner: 'user' }] });
  report.host = await tree(hostRoot);
  report.observations.push({ id: 'E38-E42', result: 'A fake WorkBuddy root contains Rho-owned and user-owned registrations, giving host cleanup a safe ownership fixture.' });

  const installedCli = path.join(binRoot, process.platform === 'win32' ? 'rho.cmd' : 'rho');
  const isolatedEnv = { ...env, RHO_HOST_ROOT: hostRoot };
  const paths = await record(report, 'rho-paths-in-isolated-home', () => command(installedCli, ['paths'], root, isolatedEnv), result => ({ passed: result.code === 0, parsed: result.code === 0 ? JSON.parse(result.stdout) : null }));
  assert.equal(paths.passed, true, paths.result.stderr);
  assert.ok(paths.parsed.home.startsWith(fixtureHome));
  const diagnosis = await record(report, 'rho-doctor-legacy-state', () => command(installedCli, ['doctor', '--json'], root, isolatedEnv), result => ({ passed: [0, 1].includes(result.code), parsed: result.stdout ? JSON.parse(result.stdout) : null }));
  assert.equal(diagnosis.passed, true, diagnosis.result.stderr);
  const migration = await record(report, 'rho-migrate-dry-run', () => command(installedCli, ['migrate', '--dry-run', '--json'], root, isolatedEnv), result => ({ passed: result.code === 0, parsed: result.code === 0 ? JSON.parse(result.stdout) : null }));
  assert.equal(migration.passed, true, migration.result.stderr);
  const migrationApply = await record(report, 'rho-migrate-apply', () => command(installedCli, ['migrate', '--apply', '--json'], root, isolatedEnv), result => ({ passed: result.code === 0, parsed: result.code === 0 ? JSON.parse(result.stdout) : null }));
  assert.equal(migrationApply.passed, true, migrationApply.result.stderr);
  assert.equal(await fs.access(path.join(fixtureHome, 'Library', 'Application Support', 'Rho', 'state', 'legacy-import', 'Rho')).then(() => true, () => false), true);
  const profile = await record(report, 'rho-profile-create', () => command(installedCli, ['profile', 'create', 'foundation', '--root', path.join(fixtureHome, 'Documents', 'Rho', 'projects'), '--state-dir', path.join(fixtureHome, 'Library', 'Application Support', 'Rho', 'state'), '--port', '0'], root, isolatedEnv), result => ({ passed: result.code === 0 }));
  assert.equal(profile.passed, true, profile.result.stderr);
  const start = await record(report, 'rho-profile-start', () => command(installedCli, ['start', '--profile', 'foundation', '--example', 'off', '--background'], root, isolatedEnv), result => ({ passed: result.code === 0 }));
  assert.equal(start.passed, true, start.result.stderr);
  const runningStatus = await record(report, 'rho-profile-status', () => command(installedCli, ['status', '--state-dir', path.join(fixtureHome, 'Library', 'Application Support', 'Rho', 'state')], root, isolatedEnv), result => ({ passed: result.code === 0, parsed: result.code === 0 ? JSON.parse(result.stdout) : null }));
  assert.equal(runningStatus.passed, true, runningStatus.result.stderr);
  assert.equal(runningStatus.parsed.status.running, true);
  const restart = await record(report, 'rho-profile-restart', () => command(installedCli, ['restart', '--profile', 'foundation', '--example', 'off'], root, isolatedEnv), result => ({ passed: result.code === 0 }));
  assert.equal(restart.passed, true, restart.result.stderr);
  for (const [name, args] of [['rho-versions', ['versions', '--json']], ['rho-logs', ['logs', '--json']], ['rho-cache', ['cache', 'list']], ['rho-service-install', ['service', 'install', 'foundation']], ['rho-service-status', ['service', 'status', 'foundation']], ['rho-service-uninstall', ['service', 'uninstall', 'foundation']]]) {
    const step = await record(report, name, () => command(installedCli, args, root, isolatedEnv), result => ({ passed: result.code === 0 }));
    assert.equal(step.passed, true, step.result.stderr);
  }
  const stop = await record(report, 'rho-profile-stop', () => command(installedCli, ['stop', '--state-dir', path.join(fixtureHome, 'Library', 'Application Support', 'Rho', 'state')], root, isolatedEnv), result => ({ passed: result.code === 0 }));
  assert.equal(stop.passed, true, stop.result.stderr);
  const hostDry = await record(report, 'rho-host-cleanup-dry-run', () => command(installedCli, ['host', 'cleanup', '--dry-run'], root, isolatedEnv), result => ({ passed: result.code === 0 }));
  assert.equal(hostDry.passed, true, hostDry.result.stderr);
  const hostClean = await record(report, 'rho-host-cleanup', () => command(installedCli, ['host', 'cleanup'], root, isolatedEnv), result => ({ passed: result.code === 0 }));
  assert.equal(hostClean.passed, true, hostClean.result.stderr);
  const hostAfter = JSON.parse(await fs.readFile(path.join(hostRoot, 'workbuddy', 'settings.json'), 'utf8'));
  assert.equal(hostAfter.settings?.theme, 'user');
  assert.equal(hostAfter.settings?.rho, undefined);
  const uninstall = await record(report, 'installed-uninstall-transaction', () => command(installedCli, ['uninstall', '--purge', '--json'], root, isolatedEnv), result => ({ passed: result.code === 0, parsed: result.stdout ? JSON.parse(result.stdout) : null }));
  assert.equal(uninstall.passed, true, uninstall.result.stderr);
  report.uninstall = uninstall.parsed;
  assert.equal(await fs.access(path.join(npmPrefix, 'lib', 'node_modules', '@rho-workspace', 'rho')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(npmPrefix, 'bin', process.platform === 'win32' ? 'rho.cmd' : 'rho')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(fixtureHome, 'Library', 'Application Support', 'Rho-uninstall-receipt.json')).then(() => true, () => false), true);

  const status = await record(report, 'legacy-status-read', () => command(process.execPath, [cli, '--status', '--state-dir', state], root, env), result => ({ passed: result.code === 0 }));
  assert.equal(status.result.code, 0, status.result.stderr);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = now();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'fixture.json'), JSON.stringify({ root, home: fixtureHome, npmPrefix, hostRoot, preserved: preserve }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, report: path.join(output, 'report.json'), fixture: root, preserved: preserve, failure: report.failure }) + '\n');
  if (!preserve) await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
