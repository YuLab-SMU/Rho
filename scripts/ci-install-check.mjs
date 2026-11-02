// The installed check CI runs on each platform. The candidate tarball is checked against the
// SHA256SUMS and composition packed beside it, installed offline with an empty npm cache outside
// every checkout, and started from its own launcher, which must select its vendored Core and copy
// in the project Rho ships. The packaged recovery and ordinary-project acceptances then run from
// the installation. No registry is involved.
//   node scripts/ci-install-check.mjs CANDIDATE_DIRECTORY ORDINARY_PROJECT [REPORT_FILE]
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [candidate, ordinary, reportFile] = process.argv.slice(2).map(p => p && path.resolve(p));
assert.ok(candidate && ordinary, 'Select the candidate directory and the ordinary project directory.');
const windows = process.platform === 'win32';
// On Windows npm and the launcher are .cmd shims; npm's CLI runs under this node instead.
const npmCli = /npm-cli\.js$/.test(process.env.npm_execpath ?? '') ? process.env.npm_execpath : windows ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null;
const env = { ...process.env }; delete env.RHO_CORE_BINARY; delete env.RHO_PACKAGE_ROOT;
const report = { schemaVersion: 1, passed: false, platform: process.platform + '-' + process.arch, node: process.version, checks: [] };
const check = (name, facts = {}) => { report.checks.push({ name, ...facts }); process.stdout.write(JSON.stringify({ passed: name, ...facts }) + '\n'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options = {}) {
  if (command === 'npm' && npmCli) [command, args] = [process.execPath, [npmCli, ...args]];
  const p = spawnSync(command, args, { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 900000, ...options });
  assert.equal(p.status, 0, [command, ...args].join(' ') + ' failed (' + (p.error?.message ?? p.status) + '): ' + (p.stderr ?? '').slice(-3000) + (p.stdout ?? '').slice(-3000));
  return p.stdout;
}
const passedLines = output => output.split('\n').filter(line => line.startsWith('{"passed"')).length;
// A Unix Host's socket lies under its project, within the system's socket path limit (104 bytes on
// macOS), which macOS's own temporary folder alone nearly fills. Windows Hosts use named pipes. On a
// Windows runner the system temporary folder is on C:, where npm took 30 ms per file against 4 ms in
// the runner's own on D: (Defender's real-time scanning is off on both), so the runner's is used.
const root = await fs.mkdtemp(path.join(await fs.realpath(windows ? process.env.RUNNER_TEMP ?? os.tmpdir() : '/tmp'), 'rho ci 中文 '));
let launcher;
try {
  const sums = (await fs.readFile(path.join(candidate, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(sums.length, 1, 'The candidate carries one tarball.');
  const [digest, filename] = sums[0].split(/\s+\*?/), tarball = path.join(candidate, filename);
  const composition = JSON.parse(await fs.readFile(path.join(candidate, 'composition.json'), 'utf8'));
  assert.equal(sha(await fs.readFile(tarball)), digest); assert.equal(composition.artifact.sha256, digest);
  report.artifact = { filename, sha256: digest, platforms: composition.platforms };
  check('Tarball matches SHA256SUMS and its composition', { filename, sha256: digest });

  const install = path.join(root, 'installation'), cache = path.join(root, 'empty npm cache');
  await fs.mkdir(install); await fs.mkdir(cache);
  let started = Date.now();
  run('npm', ['install', '--prefix', install, '--omit=dev', '--ignore-scripts', '--offline', '--cache', cache, '--no-audit', '--no-fund', tarball], { cwd: root });
  check('Installed offline with an empty npm cache', { ms: Date.now() - started, files: composition.artifact.files });

  const pkg = path.join(install, 'node_modules/@rho-workspace/rho');
  const packed = JSON.parse(await fs.readFile(path.join(pkg, 'vendor/composition.json'), 'utf8'));
  const core = packed.core.artifacts[report.platform];
  assert.ok(core, 'The package carries no Core for ' + report.platform);
  assert.equal(sha(await fs.readFile(path.join(pkg, core.path))), core.sha256);
  for (const item of packed.plugins.packages) assert.equal((await fs.lstat(path.join(pkg, 'node_modules', item.package))).isSymbolicLink(), false, item.package + ' is linked, not installed');
  check('This platform\'s Core and every plugin are installed', { core: core.path, plugins: packed.plugins.packages.length });

  const bin = path.join(install, 'node_modules/.bin', windows ? 'rho.cmd' : 'rho');
  const usage = windows ? run('"' + bin + '" --help', [], { cwd: root, shell: true }) : run(bin, ['--help'], { cwd: root });
  assert.match(usage, /--root PROJECTS_DIRECTORY/);
  check('The launcher shim prints its usage');

  // Started as the shim starts it on Windows, so the process ended below is Rho itself.
  const projects = path.join(root, 'projects'), state = path.join(root, 'state');
  await fs.mkdir(projects);
  started = Date.now();
  launcher = spawn(windows ? process.execPath : bin, [...(windows ? [path.join(pkg, 'dist/cli.js')] : []), '--root', projects, '--state-dir', state], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  launcher.stdout.on('data', b => { stdout += b; }); launcher.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  const exited = new Promise(resolve => launcher.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The launcher did not report ready: ' + stderr)), 60000);
    const look = () => { const line = stdout.split('\n').find(l => l.includes('"ready"')); if (line) { clearTimeout(timer); launcher.stdout.off('data', look); resolve(JSON.parse(line).ready); } };
    launcher.stdout.on('data', look);
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error('The launcher exited ' + code + ': ' + stderr)); });
  });
  assert.equal(await fs.realpath(ready.startup.core), await fs.realpath(path.join(pkg, core.path)));
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(ready.url).hostname), 'The service binds loopback only');
  const example = JSON.parse(await fs.readFile(path.join(pkg, 'example/example.json'), 'utf8'));
  const { RhoClient } = await import(pathToFileURL(path.join(pkg, 'dist/client.js')).href);
  const listed = await (await RhoClient.fromFile(ready.connectionFile)).call('project.list', {});
  assert.ok((await fs.stat(path.join(projects, example.name))).isDirectory(), 'The shipped project was not copied in');
  assert.equal(listed.length, 1);
  check('The launcher is ready with its own Core and the project Rho ships', { ms: Date.now() - started, project: example.name });
  if (windows) {
    // Another program can stop Rho in order only with Ctrl+Break on its console, which a CI step
    // cannot send. No project is open, so no Host runs; the process tree is ended instead.
    spawnSync('taskkill', ['/T', '/F', '/PID', String(launcher.pid)], { stdio: 'ignore' });
    await exited; launcher = null;
    check('The launcher was ended; an orderly Windows stop is not exercised here', { orderly: false });
  } else {
    launcher.kill('SIGTERM');
    const { code } = await exited; launcher = null;
    assert.equal(code, 0, 'The launcher did not stop in order: ' + stderr);
    assert.ok(stdout.includes('"shutdown"'), 'The launcher wrote no shutdown report');
    check('The launcher stopped in order on SIGTERM', { orderly: true });
  }

  // The packaged acceptances find R on PATH and the Core through the installation, as a person's would.
  const recovery = run(process.execPath, ['scripts/recovery-acceptance.mjs', path.join(root, 'recovery')], { cwd: pkg });
  check('Packaged recovery acceptance', { checks: passedLines(recovery) });
  const accepted = run(process.execPath, ['scripts/acceptance.mjs', path.join(root, 'acceptance'), ordinary], { cwd: pkg });
  check('Packaged acceptance of the ordinary R project', { checks: passedLines(accepted) });
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message }; process.exitCode = 1;
} finally {
  if (launcher) windows ? spawnSync('taskkill', ['/T', '/F', '/PID', String(launcher.pid)], { stdio: 'ignore' }) : launcher.kill('SIGKILL');
  if (reportFile) await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure }) + '\n');
}
