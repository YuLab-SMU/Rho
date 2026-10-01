// Local artifact acceptance; explicit inputs, no build and no user catalog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {buildRhoBundle} from './build-rho-bundle.mjs';
import {installBundle, sha256} from './rho-bundle.mjs';
import {pluginCommand} from './plugin-set.mjs';

assert.ok(process.env.RHO_PLUGIN_SET_PACKAGE, 'Select a retained full set with RHO_PLUGIN_SET_PACKAGE; this check never builds prerequisites');
const rho = fs.realpathSync(process.env.RHO_TEST_BINARY ?? path.resolve('target/debug/rho'));
const plugins = fs.realpathSync(process.env.RHO_PLUGIN_SET_PACKAGE);
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-bundle-test-')));
const destination = path.join(directory, 'assembly');
const relocated = path.join(directory, '搬移后的 Rho');
const database = path.join(directory, 'state with spaces', 'host.sqlite');
const evidence = path.resolve(process.env.RHO_BUNDLE_EVIDENCE ?? path.join(directory, 'results.json'));
const report = {directory, completed: false, checks: [], core_sha256: sha256(fs.readFileSync(rho))};
const started = performance.now();
const command = (...args) => pluginCommand(path.join(relocated, 'rho'), database, ...args);
const utility = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(relocated, 'rho-bundle.mjs'), ...args],
  {cwd: os.tmpdir(), encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024}));
async function emptyHost() {
  const project = path.join(directory, 'empty project'); fs.mkdirSync(project);
  // Exercise the shipped default entry, with no source tree or installer on its path.
  const host = spawn(path.join(relocated, 'rho'), ['--database', database, '--project', project, 'workbench'],
    {cwd: project, stdio: ['ignore', 'pipe', 'pipe']});
  const exited = new Promise(resolve => host.once('exit', (code, signal) => resolve({code, signal})));
  const bounded = async (promise, ms) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Owned Host timed out')), ms);})]); }
    finally { clearTimeout(timer); }
  };
  let output = '';
  host.stderr.resume(); // Never retain private launch URLs/tokens in the report.
  try {
    await bounded(new Promise((resolve, reject) => {
      host.once('error', reject);
      host.stdout.on('data', bytes => { output += bytes; if (/http:\/\/127\.0\.0\.1:\d+\//.test(output)) resolve(); });
      exited.then(result => reject(Error(`Owned Host exited before startup: ${JSON.stringify(result)}`)));
    }), 60000);
    assert.equal(command('list').total, 0, 'Default startup must not reinstall removed plugins');
    host.kill('SIGINT'); assert.equal((await bounded(exited, 30000)).code, 0);
  } finally {
    if (host.exitCode === null && host.signalCode === null) {host.kill('SIGKILL'); await bounded(exited, 5000);}
  }
}
try {
  const assembly = buildRhoBundle({rho, plugins, destination});
  assert.throws(() => buildRhoBundle({rho, plugins, destination}), /already exists/);
  report.assembly = assembly;
  fs.renameSync(destination, relocated);
  assert.equal(fs.existsSync(destination), false);
  const manifestPath = path.join(relocated, 'rho-bundle.json'), originalManifest = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(originalManifest);
  const reject = () => {
    assert.throws(() => installBundle({directory: relocated, database}));
    assert.equal(fs.existsSync(database), false, 'Preflight failure must not create the destination catalog');
  };
  // Same-size corrupt core and script bytes must fail before executing the core.
  for (const file of ['rho', 'plugin-set.mjs']) {
    const location = path.join(relocated, file), fd = fs.openSync(location, 'r+'), byte = Buffer.alloc(1);
    fs.readSync(fd, byte, 0, 1, 0);
    try {fs.writeSync(fd, Buffer.from([byte[0] ^ 1]), 0, 1, 0); reject();}
    finally {fs.writeSync(fd, byte, 0, 1, 0); fs.closeSync(fd);}
  }
  const last = manifest.files.at(-1).file, original = path.join(relocated, last), saved = path.join(directory, 'saved-archive');
  fs.renameSync(original, saved);
  try {
    fs.symlinkSync(saved, original); reject(); fs.unlinkSync(original);
    fs.writeFileSync(original, 'damaged last archive'); reject(); fs.unlinkSync(original);
  } finally {fs.renameSync(saved, original);}
  const escaped = structuredClone(manifest); escaped.files.at(-1).file = '../escape.rho-plugin';
  fs.writeFileSync(manifestPath, JSON.stringify(escaped)); reject(); fs.writeFileSync(manifestPath, originalManifest);
  assert.throws(() => installBundle({directory: relocated, database: 'relative.sqlite'}), /absolute/);
  report.checks.push('refuses overwrite, corrupt executable/helper, late archive damage, symlink, path escape and relative database before destination writes');
  const verified = utility('verify'); assert.equal(verified.status, 'verified');
  assert.equal(fs.existsSync(database), false);
  assert.equal(utility('install', '--database', database).status, 'installed');
  assert.equal(command('list').total, 16); assert.equal(command('instances').recorded.total, 0);
  assert.equal(utility('install', '--database', database).status, 'installed');
  assert.equal(command('list').total, 16);
  report.checks.push('copied utility and core work from relocated Unicode/spaced directory outside checkout; verify creates no catalog; explicit import and retry retain exactly sixteen revisions without instances');
  const set = JSON.parse(fs.readFileSync(path.join(relocated, 'plugin-set.json')));
  for (const entry of set.packages) command('remove', entry.revision);
  await emptyHost();
  assert.equal(command('list').total, 0);
  assert.equal(utility('install', '--database', database).status, 'installed');
  assert.equal(command('list').total, 16);
  assert.equal(command('instances').recorded.total, 0);
  report.checks.push('relocated default Host starts after all sixteen removals; startup imports nothing; explicit restoration succeeds');
  assert.equal(sha256(fs.readFileSync(path.join(relocated, 'rho'))), report.core_sha256);
  assert.equal(sha256(fs.readFileSync(rho)), report.core_sha256);
  report.bundle = relocated;
  report.manifest_sha256 = sha256(originalManifest);
  report.total_bytes = manifest.files.reduce((sum, file) => sum + file.bytes, originalManifest.length);
  report.completed = true;
} catch (error) {report.error = error.stack; throw error;}
finally {
  report.elapsed_seconds = (performance.now() - started) / 1000;
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({completed: report.completed, evidence, elapsed_seconds: report.elapsed_seconds}));
}
