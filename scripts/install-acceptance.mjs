// Installs a selected tarball outside all three source checkouts. No registry publish.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const artifact = path.resolve(process.argv[2] ?? '');
assert.ok(artifact.endsWith('.tgz'), 'Select the assembled application tarball.');
const root = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'rho 中文 '));
const install = path.join(root, 'installation'); await fs.mkdir(install);
const env = { ...process.env }; delete env.RHO_CORE_BINARY; delete env.RHO_PACKAGE_ROOT;
const report = { schemaVersion: 1, status: 'running', platform: process.platform + '-' + process.arch, node: process.version, artifactSha256: createHash('sha256').update(await fs.readFile(artifact)).digest('hex'), checks: [] };
async function command(program, args, cwd, maxMs = 900000) {
  const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', b => { output += b; if (output.length > 2 * 1024 * 1024) child.kill('SIGTERM'); });
  child.stderr.on('data', b => { errors = (errors + b).slice(-4000); });
  const timer = setTimeout(() => child.kill('SIGTERM'), maxMs);
  const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', resolve); }); clearTimeout(timer);
  assert.equal(code, 0, 'Installed consumer failed: ' + errors + output.slice(-2000)); return output;
}
let cli;
try {
  await command('npm', ['install', '--prefix', install, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', artifact], root);
  const pkg = path.join(install, 'node_modules/@rho-workspace/local');
  const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'vendor/composition.json'), 'utf8'));
  assert.equal(manifest.platform, report.platform); report.composition = manifest;
  const selected = await (await import(pathToFileURL(path.join(pkg, 'dist/runtime.js')))).runtime();
  assert.equal(selected.coreBinary, await fs.realpath(path.join(pkg, 'vendor/rho-core')));
  assert.equal((await fs.lstat(path.join(pkg, 'node_modules/@rho-workspace/headless'))).isSymbolicLink(), false);
  const projects = path.join(root, 'projects'); await fs.mkdir(projects);
  const state = path.join(root, 'service');
  cli = spawn(path.join(install, 'node_modules/.bin/rho'), ['--root', projects, '--state-dir', state, '--rscript', path.join(root, 'missing-Rscript')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let lines = ''; cli.stdout.on('data', b => { lines += b; }); cli.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Installed CLI did not become ready.')), 10000);
    const ready = () => { if (lines.includes('"ready"')) { clearTimeout(timer); cli.stdout.off('data', ready); resolve(); } };
    cli.stdout.on('data', ready); cli.once('error', reject); cli.once('exit', () => reject(new Error('Installed CLI exited during startup.')));
  });
  const { RhoClient } = await import(pathToFileURL(path.join(pkg, 'dist/client.js')));
  const c = await RhoClient.fromFile(path.join(state, 'connection.json'));
  const p = await c.call('project.create', { name: 'installed-project' });
  assert.equal((await c.call('project.open', { path: 'installed-project' })).host.exitCode, 3);
  assert.equal((await c.call('requirements.check', { projectId: p.id, action: 'airway.analyze' })).status, 'unknown');
  assert.equal((await c.call('document.open', { projectId: p.id, path: 'draft.R' })).version, 1);
  assert.equal((await fs.stat(path.join(state, 'connection.json'))).mode & 0o077, 0);
  const exit = new Promise(resolve => cli.once('close', resolve)); cli.kill('SIGTERM'); assert.equal(await exit, 0); cli = undefined;
  report.checks.push('Actual npm install, bin launch without R, private credential, project/document open without Host, unknown action dependencies, bundled Core selected.');
  for (const [script, directory] of [['acceptance.mjs', 'science'], ['recovery-acceptance.mjs', 'recovery'], ['agent-experiment.mjs', 'agent'], ['agent-repair.mjs', 'repair']]) {
    const target = path.join(root, directory);
    const output = await command(process.execPath, [path.join(pkg, 'scripts', script), target], root);
    const result = JSON.parse(await fs.readFile(path.join(target, 'report.json'), 'utf8'));
    assert.ok(result.status === 'passed' || (result.experiment && result.bufferChangedByAgent && result.contextFetched && result.exitCode === 0));
    report[directory] = result;
    report.checks.push('Installed ' + script + ' passed.');
    process.stdout.write(output);
  }
  const fixtures = JSON.parse(await fs.readFile(path.join(pkg, 'fixtures/v1/states.json'), 'utf8'));
  assert.equal(fixtures.readOnly, true); assert.ok(fixtures.cases.length >= 9);
  report.checks.push('Versioned protocol and read-only state fixtures shipped.');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.failure = e.message; process.exitCode = 1; }
finally {
  cli?.kill('SIGTERM');
  await fs.writeFile(path.join(root, 'installation-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, report: path.join(root, 'installation-report.json'), failure: report.failure }) + '\n');
}
