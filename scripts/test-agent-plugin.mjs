// Milestone acceptance for the ordinary Agent package. Compile the generic Host
// harness first, build the external package once without changing those Host
// bytes, then run the package's own framed tests and the frozen Host cases.
// `--evidence <file>` records per-stage status, timings and hashes.
// `--skip-framed` reuses a framed result already covered by the current source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agentPluginBuildEnvironment, buildAgentPlugin} from './build-agent-plugin.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const evidenceIndex = argv.indexOf('--evidence');
const evidence = evidenceIndex >= 0 ? path.resolve(argv[evidenceIndex + 1]) : null;
const skipFramed = argv.includes('--skip-framed');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-native-')));
const env = {...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2'};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = {source: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), stages: [], completed: false};
const save = () => { if (evidence) fs.writeFileSync(evidence, JSON.stringify(record, null, 2) + '\n'); };
function stage(name, action) {
  const start = Date.now();
  console.log(`START ${name}`);
  try { const value = action(); record.stages.push({stage: name, status: 0, seconds: (Date.now() - start) / 1000}); save(); return value; }
  catch (error) { record.stages.push({stage: name, status: error.status ?? 1, seconds: (Date.now() - start) / 1000}); save(); throw error; }
}
try {
  const executable = stage('freeze-host', () => {
    const output = execFileSync('cargo', ['test', '-p', 'rho-host', '--test', 'agent_plugin', '--locked', '--offline', '--no-run', '--message-format=json'], {
      cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024,
    });
    return output.trim().split('\n').map(line => JSON.parse(line)).find(item => item.reason === 'compiler-artifact' && item.target.name === 'agent_plugin' && item.executable)?.executable;
  });
  assert.ok(executable, 'Cargo did not identify the generic Host harness');
  const original = digest(executable);
  record.host_sha256 = original;
  const source = process.env.RHO_AGENT_PLUGIN_PACKAGE
    ? fs.realpathSync(process.env.RHO_AGENT_PLUGIN_PACKAGE)
    : stage('independent-build', () => buildAgentPlugin(path.join(directory, 'package')));
  assert.ok(!source.startsWith(root + path.sep), 'Use an independent package');
  record.backend_sha256 = digest(path.join(source, 'dist/rho-agent-backend'));
  if (!skipFramed) {
    const external = agentPluginBuildEnvironment();
    stage('independent-framed', () => execFileSync(external.RHO_PLUGIN_CARGO, ['test', '-p', 'rho-agent-backend', '--lib', '--test', 'metadata', '--locked', '--offline'], {
      cwd: source, env: external, stdio: 'inherit',
    }));
  }
  assert.equal(digest(executable), original);
  stage('generic-host', () => execFileSync(executable, ['--ignored', '--nocapture'], {cwd: root, env: {...env, RHO_AGENT_PLUGIN_PACKAGE: source}, stdio: 'inherit'}));
  assert.equal(digest(executable), original);
  record.completed = true; save();
  console.log(`Independent Agent package passed${skipFramed ? '' : ' its framed tests and'} the frozen generic Host cases. Host harness SHA256 ${original}`);
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
