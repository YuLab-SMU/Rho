import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agentSourceCopies, excludedAgentSource, agentBuildInputDigest, recordAgentBuild, verifyAgentBuild} from './agent-plugin-artifact.mjs';
import {assembleAgentArtifact} from '../plugins/agent/build.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Resolve in the checkout before entering a temporary independent package, where
// rustup otherwise selects the user's unrelated default toolchain.
export function agentPluginBuildEnvironment() {
  const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], {cwd: root, encoding: 'utf8'}).trim());
  return {...process.env, RHO_PLUGIN_CARGO: installed('cargo'), RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'),
    RHO_PLUGIN_NODE_MODULES: path.join(root, 'ui/node_modules'),
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2', CARGO_TARGET_DIR: path.join(root, 'target')};
}
export function buildAgentPlugin(destination, {workspace = false} = {}) {
  assert.ok(destination, 'Specify a new package directory outside the checkout');
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(destination))), path.basename(destination));
  assert.ok(output !== root && !output.startsWith(root + path.sep), 'Use an independent source directory');
  const inputs = agentBuildInputDigest();
  fs.mkdirSync(output);
  for (const [from, to] of agentSourceCopies) {
    fs.cpSync(path.join(root, from), path.join(output, to), {recursive: true, filter: source => {
      assert.ok(!fs.lstatSync(source).isSymbolicLink(), 'Package source must not contain symlinks');
      return !excludedAgentSource(source);
    }});
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  for (const [file, from, to] of [
    ['api/Cargo.toml', '../../../crates/plugin-protocol', '../public/plugin-protocol'],
    ['api/Cargo.toml', '../../r/api', '../public/r-api'],
    ['backend/Cargo.toml', '../../../crates/plugin-sdk', '../public/plugin-sdk'],
    ['public/r-api/Cargo.toml', '../../../crates/plugin-protocol', '../plugin-protocol'],
  ]) {
    const location = path.join(output, file), source = fs.readFileSync(location, 'utf8');
    assert.ok(source.includes(from), `Dependency layout changed: ${file}`);
    fs.writeFileSync(location, source.replace(from, to));
  }
  fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["api", "backend", "backend/owner", "backend/store", "backend/engine", "backend/client", "backend/native", "public/r-api", "public/plugin-protocol", "public/plugin-sdk"]\n');
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
  const env = agentPluginBuildEnvironment();
  const target = execFileSync(env.RUSTC, ['-vV'], {encoding: 'utf8'}).match(/^host: (.+)$/m)?.[1];
  assert.ok(target);
  const metadata = JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], {cwd: output, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  assert.deepEqual(metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id)).map(pkg => pkg.name).sort(),
    ['rho-agent-api', 'rho-agent-backend', 'rho-agent-client', 'rho-agent-engine', 'rho-agent-native', 'rho-agent-owner', 'rho-agent-store', 'rho-plugin-protocol', 'rho-plugin-sdk', 'rho-r-api']);
  for (const pkg of metadata.packages) {
    if (!pkg.source) assert.ok(pkg.manifest_path.startsWith(output + path.sep), `${pkg.name}: source leaves the independent package`);
    for (const dependency of pkg.dependencies) if (dependency.path)
      assert.ok(dependency.path.startsWith(output + path.sep), `${pkg.name}: dependency leaves the independent package`);
  }
  if (workspace) {
    execFileSync(env.RHO_PLUGIN_CARGO, ['build', '--locked', '--offline', '-p', 'rho-agent-backend', '--bins'], {cwd: root, env, stdio: 'inherit'});
    assembleAgentArtifact(output, env.CARGO_TARGET_DIR, env);
  } else execFileSync(process.execPath, [path.join(output, 'build.mjs')], {cwd: output, env, stdio: 'inherit'});
  recordAgentBuild(output, inputs, root, workspace ? 'workspace' : 'independent');
  return output;
}
export function prepareAgentAcceptance(options) {
  if (!options.build) return verifyAgentBuild(options.packagePath);
  // Keep the package and receipt across harness success/failure. Other acceptance
  // stages reuse these exact bytes; their disposable project state stays separate.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-build-')));
  const output = path.join(directory, 'package');
  console.log(`Retained Agent package: ${output}`);
  return buildAgentPlugin(output);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(3).every(arg => arg === '--workspace') && process.argv.length <= 4,
    'Usage: node scripts/build-agent-plugin.mjs /new/package [--workspace]');
  const workspace = process.argv.includes('--workspace');
  console.log(`${workspace ? 'Workspace-built' : 'Independent'} Agent package: ${buildAgentPlugin(process.argv[2], {workspace})}`);
}
