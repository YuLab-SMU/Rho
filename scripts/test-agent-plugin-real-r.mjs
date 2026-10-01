// Frozen generic Host harness, independent ordinary Agent and R source packages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareAgentAcceptance} from './build-agent-plugin.mjs';
import {agentAcceptanceOptions, agentBuildMode, verifyAgentBuild} from './agent-plugin-artifact.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = agentAcceptanceOptions(process.argv.slice(2), {browser: true});
if (!options.build) verifyAgentBuild(options.packagePath);
assert.ok(options.build || process.env.RHO_R_PLUGIN_PACKAGE,
  'Reuse also requires RHO_R_PLUGIN_PACKAGE; use --build only when a new independent R package is due');
assert.ok(process.env.RHO_ARK && process.env.RHO_R_HOME, 'Set RHO_ARK and RHO_R_HOME for disposable R acceptance');
if (options.browser) {
  assert.ok(process.env.RHO_EDITOR_PLUGIN_PACKAGE && process.env.RHO_FILES_PLUGIN_PACKAGE, 'Browser context acceptance requires retained RHO_EDITOR_PLUGIN_PACKAGE and RHO_FILES_PLUGIN_PACKAGE; it does not build them implicitly');
  execFileSync('npm', ['run', 'test:browser', '--prefix', 'ui', '--', 'agent-workspace.spec.ts'], {
    cwd: root, stdio: 'inherit', env: {...process.env, RHO_AGENT_PLUGIN_PACKAGE: options.packagePath},
  });
  console.log(`Ordinary Agent browser / real R flow passed with a ${agentBuildMode(options.packagePath)}-built Agent package.`);
  process.exit(0);
}
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-science-')));
const env = {...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2'};
const nativeBin = path.join(directory, 'native-bin');
fs.mkdirSync(nativeBin);
fs.writeFileSync(path.join(nativeBin, 'rho-science-fixture'), 'disposable');
fs.copyFileSync(path.join(root, 'crates/host/tests/fixtures/agent-science.cjs'), path.join(nativeBin, 'kimi'));
fs.chmodSync(path.join(nativeBin, 'kimi'), 0o700);
env.PATH = `${nativeBin}${path.delimiter}${env.PATH}`;
env.KIMI_CODE_HOME = path.join(directory, 'native-home');
fs.mkdirSync(env.KIMI_CODE_HOME);
env.RHO_AGENT_NATIVE_SCIENCE_FIXTURE = '1';
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  const tests = ['agent_plugin', 'agent_plugin_real_r'];
  const output = execFileSync('cargo', ['test', '-p', 'rho-host', ...tests.flatMap(name => ['--test', name]), '--locked', '--offline', '--no-run', '--message-format=json'], {cwd:root, env, encoding:'utf8', stdio:['ignore','pipe','inherit'], maxBuffer:16*1024*1024});
  const artifacts = output.trim().split('\n').map(line=>JSON.parse(line));
  const harnesses = tests.map(name => {
    const executable = artifacts.find(item=>item.reason==='compiler-artifact' && item.target.name===name && item.executable)?.executable;
    assert.ok(executable, `Cargo did not identify ${name}`);
    return {name, executable, original: digest(executable)};
  });
  const agent = prepareAgentAcceptance(options);
  const r = process.env.RHO_R_PLUGIN_PACKAGE ? fs.realpathSync(process.env.RHO_R_PLUGIN_PACKAGE)
    : path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-r-build-'))), 'r');
  console.log(`Retained R package: ${r}`);
  if (!process.env.RHO_R_PLUGIN_PACKAGE) execFileSync(process.execPath,[path.join(root,'scripts/build-r-plugin.mjs'),r,'--independent'],{cwd:root,env,stdio:'inherit'});
  for (const {name, executable, original} of harnesses) {
    assert.equal(digest(executable),original);
    execFileSync(executable,['--ignored','--nocapture'],{cwd:root,env:{...env,RHO_AGENT_PLUGIN_PACKAGE:agent,RHO_R_PLUGIN_PACKAGE:r},stdio:'inherit'});
    assert.equal(digest(executable),original);
    console.log(`${name} passed against a ${agentBuildMode(agent)}-built Agent package and the selected R package. Host harness SHA256 ${original}`);
  }
} finally { fs.rmSync(directory,{recursive:true,force:true}); }
